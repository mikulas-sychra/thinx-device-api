/** This THiNX-RTM API module is responsible for build logging. */

// #esversion: 6

var Buildlog = (function() {

	var app_config = require("../../conf/config.json");
	if (typeof(process.env.CIRCLE_USERNAME) !== "undefined") {
		console.log("» Configuring for Circle CI...");
		app_config = require("../../conf/config-test.json");
	}
	var db = app_config.database_uri;
	var nano = require("nano")(db);

	var fs = require("fs");
	var readline = require("readline");
	var exec = require("child_process");
	var mkdirp = require("mkdirp");

	var tail = null;
	var err_callback = null;
	var parser = null;
	var websocket = null;

	Tail = require("tail").Tail;

	var prefix = "";
	try {
		var pfx_path = app_config.project_root + '/conf/.thx_prefix';
		if (fs.existsSync(pfx_path)) {
			prefix = fs.readFileSync(pfx_path) + "_";
		}
	} catch (e) {
		//console.log(e);
	}

	nano.db.create(prefix + "managed_builds", function(err, body, header) {
		if (err.statusCode != 412) {
			console.log("[buildlog] db error " + err);
		}
	});

	var buildlib = require("nano")(db).use(prefix + "managed_builds");

	function ab2str(buf) {
		return String.fromCharCode.apply(null, new Uint16Array(buf));
	}

	function str2ab(str) {
		var buf = new ArrayBuffer(str.length * 2); // 2 bytes for each char
		var bufView = new Uint16Array(buf);
		for (var i = 0, strLen = str.length; i < strLen; i++) {
			bufView[i] = str.charCodeAt(i);
		}
		return buf;
	}

	var _private = {

		// real-life log path example:
		// /root/thinx-device-api/data/cedc16bb6bb06daaa3ff6d30666d91aacd6e3efbf9abbc151b4dcade59af7c12/f8e88e40-43c8-11e7-9ad3-b7281c2b9610/08880d80-5db4-11e7-bc78-f76a3906007e/08880d80-5db4-11e7-bc78-f76a3906007e.log

		pathForOwner: function(owner) {
			var user_path = app_config.project_root + app_config.deploy_root + "/" +
				owner;
			return user_path;
		}
	};

	// public
	var _public = {

		/**
		 * Store new record in build log
		 * @param {string} build_id - UUID of the build
		 * @param {string} owner - 'owner' id of the build owner
		 * @param {string} udid - UDID of the target device
		 * @param {string} message - build log status message
		 */

		log: function(build_id, owner, udid, message, contents) {

			if (typeof(owner) === "undefined") {
				throw ("Invalid Log owner: " + owner);
			}

			var mtime = new Date();

			// TODO: should be simplified, investigate impact.
			var record = {
				"message": message,
				"udid": udid,
				"timestamp": mtime,
				"build": build_id
			};

			if (typeof(contents) !== "undefined") {
				record.contents = contents;
			}

			buildlib.get(build_id, function(err, existing) {

				// initial log record
				if (err || (typeof(existing) === "undefined")) {
					var now = new Date();
					var initial_record = {
						timestamp: mtime,
						last_update: now,
						start_time: now,
						owner: owner,
						build_id: build_id,
						udid: udid,
						log: [record]
					};

					if (err.toString().indexOf("Document update conflict") !== -1) {
						// log/last_update from timestamp update
						buildlib.atomic("logs", "log", build_id, record, function(error,
							body) {
							if (err) {
								console.log("Log update (existing) error: " + err, body);
							} else {
								console.log("BuildLog updated atomically.");
							}
						});
					} else {
						buildlib.insert(initial_record, build_id, function(err,
							body, header) {
							if (err) {

								// log/last_update from timestamp update
								buildlib.atomic("logs", "log", build_id, record, function(error,
									body) {
									if (err) {
										console.log("Log update (new) error: " + err, body);
									}
								});
							}
						});
					}

				} else {

					// log/last_update from timestamp update
					buildlib.atomic("logs", "log", build_id, record, function(error,
						body) {
						if (err) {
							console.log("Log update (existing) error: " + err, body);
						}
					});
				}
			});
		},

		/**
		 * Fetch record from build log
		 * @param {string} build_id - UUID of the build
		 * @param {function} callback (err, body) - async return callback
		 */

		fetch: function(build_id, callback) {

			buildlib.get(build_id, function(err, body) {

				if (err) {
					console.log("[buildlog] Error fetching build log " + build_id);
					if (err.toString().indexOf("Error: missing") !== -1) {
						callback(false, "error_missing:" + build_id); // FIXME: this is not a standard response, change to JSON
					} else {
						callback(false, err);
					}
					return;
				}

				if ((typeof(body.log) === "undefined") || (body.log.count === 0)) {
					console.log("[buildlog] body has no log...");
					callback(false, {});
					return;
				}

				var bodykeys = Object.keys(body.log);
				var blog = body.log[bodykeys[0]];
				var path = _public.pathForDevice(blog.owner, blog.udid);
				var build_log_path = path + "/" + build_id + "/build.log";

				var log_info = {};
				if (typeof(body.log) !== "undefined") {
					log_info = body.log;
				}
				if (fs.existsSync(build_log_path)) {
					var log_contents = fs.readFileSync(build_log_path);
					var response = {
						log: log_info,
						contents: log_contents
					};
					callback(false, response);
				} else {
					var short_response = {
						log: log_info
					};
					callback(false, short_response);
				}
			});
		},

		/**
		 * List build logs
		 * @param {string} owner - 'owner' id
		 * @param {function} callback (err, body) - async return callback
		 */

		list: function(owner, callback) {
			buildlib.view("builds", "latest_builds", {
				"limit": 100,
				"descending": true
			}, function(err, body) {
				if (err) {
					console.log("[buildlog] Error listing builds for owner...");
					callback(err, {});
				} else {
					callback(false, body);
				}
			});
		},

		/**
		 * Watch build log
		 * @param {string} build_id - UUID of the build
		 * @param {string} owner - owner of the request/socket
		 * @param {Websocket} socket - socket that will be used as output
		 * @param {function} err_callback (data) - async return callback for line events
		 */

		logtail: function(build_id, owner, socket, error_callback) {

			websocket = socket;

			if (typeof(error_callback) !== "undefined") {
				err_callback = error_callback;
			}

			_public.fetch(build_id, function(err, body) {

					if (err.toString().indexOf("error") !== -1) {
						console.log("_public.fetch:build_id err: " + JSON.stringify(err));
						return;
					}

					//var message = body.message.toString('utf8');
					//console.log("Extracted message: " + message);

					if (typeof(body) === "undefined") {
						if (typeof(websocket) !== "undefined" && websocket !== null) {
							try {
								websocket.send(JSON.stringify({
									log: "Sorry, no log records fetched."
								}));
							} catch (e) { /* handle error */ }
						} else {
							console.log("[logtail] no websocket.");
							err_callback("[logtail] no websocket");
						}
						return;
					}

					if (body.length === 0) {
						err_callback("[logtail] body not found");
						console.log("[logtail] body not found");
						return;
					}


					if (typeof(body.log) === "undefined") {
						console.log("[logtail] log not found in " + JSON.stringify(body));
						//err_callback("[logtail] body not found");
						//return;
						body.log = [];
					}

					body.log.push({
						message: "Waiting for build log...",
						udid: body.udid,
						date: body.timestamp,
						build: body.build_id
					});

					var build = body.log[0];

					if (typeof(build.owner) === "undefined") {
						build.owner = owner;
						console.log(
							"[logtail] build has no owner - FIXME: hacking, injecting body owner: " + build.owner
						);
					}

					if (err) {
						console.log("[logtail] error: " + err);
					} else {

						var message = ab2str(build.message);

						if (message === "") {
							message = build.message;
						}

						console.log("[logtail] fetched build message: " + message);

						if (typeof(websocket) !== "undefined" && websocket !== null) {
							try {
								websocket.send(message);
							} catch (e) { /* handle error */
								console.log(e);
							}
						} else {
							console.log("[logtail][head] no websocket.");
						}

						var build_udid = build.udid;
						var path = _public.pathForDevice(build.owner, build.udid);
						var build_path = path + "/" + build_id;

						// Whole build path is created here, because build log is the first thing being written here if nothing else.
						if (!fs.existsSync(build_path)) {
							mkdirp.sync(build_path);
							console.log("Created build_path: " + build_path);
						} else {
							console.log("build_path: " + build_path + " already exists.");
						}

						var build_log_path = build_path + "/build.log";

						console.log("Searching for build-log " + build_log_path);

						// Create file before trying to tail, do not wait for builder to do it...
						var PRE = "LOG_DIR=`dirname " + build_log_path +
							"`; [ ! -d $LOG_DIR ] && mkdir -p $LOG_DIR; touch " +
							build_log_path;
						console.log(PRE);
						var presult = exec.execSync(PRE);

						if (fs.existsSync(build_log_path)) {

							console.log("File " + build_log_path + " found, starting tail...");

							var options = {
								fromBeginning: true,
								fsWatchOptions: {},
								follow: true
							};

							if (tail !== null) {
								console.log("Unwatching existing tail...");
								tail.unwatch();
								tail = null;
							}

							console.log("Initializing new tail...");
							tail = new Tail(build_log_path, options);

							tail.on("line", function(data) {
								var logline = data.toString();
								if (logline.indexOf("[logtail]") !== -1) return;
								if ((logline === "") || (logline === "\n")) return;
								if (typeof(websocket) !== "undefined" && websocket !== null) {
									try {
										websocket.send(logline);
									} catch (e) {
										console.log(e);
									}
								} else {
									console.log("[logtail][line] no websocket.");
								}
							});

							tail.on("error", function(error) {
								console.log("ERROR: ", error);
								if (typeof(err_callback) !== "undefined") {
									err_callback("fake build log error");
								}
							});

							// hack to start on non-changing files
							tail.watchEvent.call(tail, "change");

							/*

							parser = readline.createInterface({
								input: fs.createReadStream(build_log_path),
								output: null,
								console: false,
								terminal: false
							});

							parser.on('line', function(data) {
								var logline = data.toString();

								// skip own logs to prevent loops
								if (logline.indexOf("[logtail]") !== -1) return;

								if ((logline === "") || (logline === "\n")) return;
								if (typeof(websocket) !== "undefined" && websocket !== null) {
									try {
										websocket.send(logline);
									} catch (e) {
										console.log(e);
									}
								} else {
									console.log("[logtail][line] no websocket.");
								}
							});

							parser.on("error", function(error) {
								console.log('ERROR: ', error);
								if (typeof(err_callback) !== "undefined") {
									err_callback("fake build log error");
								}
							});

							parser.on('close', function(line) {
								if (typeof(websocket) !== "undefined" && websocket !== null) {
									try {

										console.log("Parser closed, restarting...");

										// This implements the tailing...
										// log file closes often in progress.
										parser = readline.createInterface({
											input: fs.createReadStream(build_log_path),
											output: null,
											console: false,
											terminal: false
										});

									} catch (e) {
										console.log(e);
									}
								} else {
									console.log("[logtail] no websocket on close.");
								}
							});
							*/

						} else {

							if (typeof(websocket) !== "undefined" && websocket !== null) {
								try {
									var logline = "Log not found at: " + build_log_path;
									websocket.send(logline);
								} catch (e) {
									/* handle error */
									console.log(e);
								}
							} else {
								console.log("[logtail][line] no websocket.");
							}
						}
					}

				} // no error

			); // build fetch
		},

		pathForDevice: function(owner, udid) {
			this.owner = owner;
			this.udid = udid;
			var user_path = _private.pathForOwner(owner);
			var device_path = user_path + "/" + udid;
			return device_path;
		}

	};

	return _public;

})();

exports.log = Buildlog.log;
exports.fetch = Buildlog.fetch;
exports.list =
	Buildlog.list;
exports.tail = Buildlog.tail;
exports.logtail = Buildlog.logtail;

exports.pathForDevice = Buildlog.pathForDevice;
