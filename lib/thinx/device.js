/** This THiNX-RTM API module is responsible for managing devices. */

var Device = (function() {

	var app_config = require("../../conf/config.json");
	if (typeof(process.env.CIRCLE_USERNAME) !== "undefined") {
		console.log("» Configuring for Circle CI...");
		app_config = require("../../conf/config-test.json");
	}
	var fs = require("fs");
	var db = app_config.database_uri;

	var prefix = "";
	try {
		var pfx_path = app_config.project_root + '/conf/.thx_prefix';
		if (fs.existsSync(pfx_path)) {
			prefix = fs.readFileSync(pfx_path) + "_";
		}
	} catch (e) {
		//console.log(e);
	}

	var devicelib = require("nano")(db).use(prefix + "managed_devices");

	var sha256 = require("sha256");
	var uuidV1 = require("uuid/v1");
	var alog = require("./audit");
	var deploy = require("./deployment");
	var apikey = require("./apikey");

	var redis = require("redis");
	var client = redis.createClient();
	var exec = require("child_process");

	var _private = {

		updateFromPath: function(path, ott, callback) {

			// Arduino: single *.bin file only
			// Platformio: single *.bin file only
			// LUA: init.lua, config.lua (will deprecate in favor of thinx.json), thinx.lua
			// Micropython: boot.py, thinx.py, thinx.json, optionally other *.pys and data within the directory structure
			// MongooseOS: to be evaluated, should support both

			if (path.indexOf("/") === path.length) {
				console.log(
					"Trailing slash detected. This should be a multi-file update.");

			} else {

				console.log(
					"Trailing slash not detected. This is a single-file update.");

				// Detect contents of this folder first, then use specific platform method
				repository.getPlatform(path, function(success, platform) {

					if (!success) {
						console.log("[device] getPlatform error", platform);
						return;
					}

					if (platform === "arduino" || platform === "platformio") {
						_private.update_binary(path, ott, callback);

					} else if (platform === "nodemcu") {
						console.log(
							"Multi-file update for NodeMCU not yet fully supported.");
						_private.update_multiple(path, ott, callback);

					} else if (platform === "micropython") {
						console.log(
							"Multi-file update for Micropython not yet fully supported.");
						_private.update_multiple(path, ott, callback);

					} else if (platform === "mongoose") {
						console.log("Firmware update for MongooseOS not yet supported.");
						_private.update_multiple(path, ott, callback);

					} else if (platform === "nodejs") {
						console.log("Firmware update for node.js not yet supported.");
					}

				}); // repository.getPlatform
			}
		},

		update_multiple: function(path, ott, callback) {

			var directories = fs.readdirSync(path).filter(
				file => fs.lstatSync(path.join(path, file)).isDirectory()
			);

			var artefact_filenames = [];

			// Fetch header name and language type
			var platform_descriptor = require(platforms_path + "/descriptor.json");
			var header_file_name = platform_descriptor.header;
			var platform_language = platform_descriptor.language;
			var header_path = path + "/" + header_file_name;
			if (typeof(header_file_name) !== "undefined") {
				// TODO: Check file existence
				artefact_filenames.push(header_file_name);
			}

			var language_extensions = project_root + "/languages/" + language +
				"/descriptor.json";

			// Match all files with those extensions + header
			var all_files = fs.readdirSync(path);
			var artifact_filenames = [];
			for (var findex in artifact_filenames) {
				var file = all_files[findex];
				for (var xindex in extensions) {
					if (file.indexOf(extensions[xindex]) !== -1) {
						selected_files.push(file);
					} else if (file.indexOf(header_file_name) !== -1) {
						selected_files.push(file);
					}
				}
			}

			var buffer = {};
			buffer.type = "file";
			buffer.files = [];

			for (var aindex in selected_files) {
				var apath = path + "/" + selected_files[aindex];
				var descriptor = {
					name: selected_files[aindex],
					data: fs.readFileSync(apath)
				};
				buffer.files.push(descriptor);
			}

			// Respond with json containing all the files...
			callback(true, buffer);
		},

		// Simple Single-File/OTT Update
		update_binary: function(path, ott, callback) {
			fs.open(path, "r", function(err, fd) {
				if (err) {
					callback(false, {
						success: false,
						status: "not_found"
					});
					return console.log(err);
				} else {
					var buffer = fs.readFileSync(path);
					fs.close(fd, function() {
						console.log(
							"Sending firmware update from " + path + "...");
					});
					if (typeof(ott) !== "undefined") {
						client.expire("ott:" + ott, 3600); // TODO: FIXME: Should be 0, like this the OTT is valid for 60 minutes after first use
					}
					callback(true, buffer);
				}
			}); // fs.open (single-file)
		},

		checkinExistingDevice: function(device, reg, callback) {

				console.log("[OID:" + reg.owner +
					"] [DEVICE_CHECKIN] Checkin Existing device: " +
					JSON.stringify(reg));

				// Store last checkin timestamp
				device.lastupdate = new Date();

				if (typeof(reg.firmware) !== "undefined" && reg.firmware !== null) {
					device.firmware = reg.firmware;
				}
				if (typeof(reg.push) !== "undefined" && reg.push !== null) {
					device.push = reg.push;
				}
				if (typeof(reg.alias) !== "undefined" && reg.alias !== null) {
					device.alias = reg.alias;
				}
				// device notifies on owner change
				if (typeof(reg.owner) !== "undefined" && reg.owner !== null) {
					device.owner = reg.owner;
				}

				var udid;

				if (typeof(device._id) === "undefined") {
					console.log("Existing device should have in ID!");
				}

				if (typeof(reg.udid) !== "undefined") {
					udid = reg.udid;
				}

				if (typeof(device._id) !== "undefined") {
					udid = device._id;
				}

				console.log("Atomic update for device " + udid + " with data " + JSON.stringify(device));

				devicelib.atomic("devicelib", "modify", udid, device, function(error, body) {
					if (!error) {
						var registration_response = {
							registration: {
								success: true,
								status: "OK",
								owner: device.owner,
								alias: device.alias,
								udid: udid,
								auto_update: device.auto_update
							}
						};
						callback(true, registration_response);
						console.log("Device checkin complete with response: " + JSON.stringify(
							registration_response));
					} else {
						console.log(error, body);
						callback(false, {
							registration: {
								success: false,
								status: "insert_failed"
							}
						});
					}
				});
			} // checkin function
	};

	// public
	var _public = {

		normalizedMAC: function(_mac) {

			if ((typeof(_mac) === "undefined") || (_mac === null)) {
				//throw Error("Undefined MAC!");
				return "UN:DE:FI:NE:D_";
			}

			if (_mac === "") {
				//throw Error("Empty MAC!");
				return "EM:PT:YM:AC:__";
			}

			var mac = _mac.toString();
			// console.log("[device.js] Normalizing MAC: '" + mac + "'");

			if (mac.length == 17) {
				return mac.toUpperCase();
			} else {
				var retval = "";

				var ms = mac.toUpperCase();
				if (ms.indexOf(":") !== -1) {
					ms = ms.replace(/:/g, "");
				}
				var m = ms.split("");
				for (var step = 0; step <= m.length - 2; step += 2) {
					retval += m[step].toString();
					if (typeof(m[step + 1]) !== "undefined") {
						retval += m[step + 1].toString();
					}
					// add ":" of this is not last step
					if (step < m.length - 2) {
						retval += ":";
					}
				}
				return retval;
			}
		},

		storeOTT: function(body, callback) {
			var new_ott = sha256(Date());
			client.set("ott:" + new_ott, JSON.stringify(body), function(err) {
				if (err) {
					callback(false, err);
				} else {
					callback(true, {
						ott: new_ott
					});
					client.expire("ott:" + new_ott, 86400);
				}
			});
		},

		fetchOTT: function(ott, callback) {
			client.get("ott:" + ott, function(err, json_keys) {
				callback(err, json_keys);
			});
		},

		register: function(body, api_key, callback) {

			var reg = body;

			//
			// Validate input parameters
			//

			console.log("Registration with API Key: " + api_key + " and body " +
				JSON.stringify(body));

			if (typeof(reg) === "undefined") {
				callback(false, "no_registration_info");
				return;
			}

			var rdict = {};

			rdict.registration = {};

			var mac = _public.normalizedMAC(reg.mac);
			if (typeof(mac) === "undefined") {
				throw Error("Missing MAC in device.js:354");
			}
			var fw = "unknown";
			if (!reg.hasOwnProperty("firmware")) {
				fw = "undefined";
			} else {
				fw = reg.firmware;
				//console.log("Setting firmware " + fw);
			}

			// Headers must contain Authentication header
			if (typeof(api_key) === "undefined") {
				console.log("ERROR: Registration requests now require API key!");
				alog.log(owner, "Attempt to register witout API Key!");
				callback(false, "authentication");
				return;
			}

			// Until 2.0.0
			if (typeof(reg.owner) === "undefined") {
				console.log("searching for owner in: " + JSON.stringify(reg));
				callback(false, "old_protocol_owner:-" + owner + "-");
				return;
			}

			// Since 2.0.0a
			var platform = "unknown";
			if (typeof(reg.platform) !== "undefined") {
				platform = reg.platform;
			}

			var push = reg.push;
			var alias = reg.alias;
			var owner = reg.owner;
			var version = reg.version;
			var udid;

			apikey.verify(owner, api_key, function(success, message) {

				if (success === false) {
					alog.log(owner, "Attempt to use invalid API Key: " +
						api_key +
						" on device registration.");
					callback(false, message);
					return;
				}

				alog.log(owner,
					"Attempt to register device: " + reg.udid + " alias: " + alias);

				deploy.initWithOwner(owner); // creates user path if does not exist

				alog.log(owner, "Using API Key: " + api_key);

				// TODO: If device gives udid, get by udid (existing), otherwise use new.

				success = false;
				var status = "OK";
				var device_version = "1.0.0"; // default

				if (typeof(version) !== "undefined") {
					//console.log("Device declares version: " + version);
					device_version = version;
				}

				var known_owner = "";

				var checksum = null;
				if (typeof(reg.checksum) !== "undefined") {
					checksum = reg.checksum;
				}

				var udid = uuidV1(); // is returned to device which should immediately take over this value instead of mac for new registration
				if (typeof(reg.udid) !== "undefined") {
					if (reg.udid.length > 4) {
						udid = reg.udid;
					}
				}

				//
				// Construct response
				//

				var response = {};

				if (
					(typeof(rdict.registration) !== "undefined") &&
					(rdict.registration !== null)
				) {
					response = rdict.registration;
				}

				response.success = success;
				response.status = status;

				if (known_owner === "") {
					known_owner = owner;
				}

				if (owner != known_owner) {
					// TODO: Fail from device side, notify admin.
					console.log("owner is not known_owner (" + owner + ", " +
						known_owner +
						")");
					response.owner = known_owner;
					owner = known_owner; // should force update in device library
				}

				//
				// Construct device descriptor and check for firmware
				//

				console.log("Device firmware: " + fw);

				var mqtt = "/" + owner + "/" + udid;

				var device = {
					mac: mac,
					firmware: fw,
					checksum: checksum,
					push: push,
					alias: alias,
					owner: owner,
					source: null,
					version: device_version,
					udid: udid,
					mqtt: mqtt,
					platform: platform,
					lastupdate: new Date(),
					lastkey: sha256(api_key),
					auto_update: false,
					description: "new device"
				};

				var update = deploy.hasUpdateAvailable(device);
				if (update === true) {
					console.log("Firmware update available.");
					var firmwareUpdateDescriptor = deploy.latestFirmwareEnvelope(
						device);

					var rmac = firmwareUpdateDescriptor.mac || mac;
					if (typeof(rmac) === "undefined") {
						throw Error("Missing MAC in device.js:491");
					}
					response.status = "FIRMWARE_UPDATE";
					response.success = true;
					response.url = firmwareUpdateDescriptor.url;
					response.mac = _public.normalizedMAC(rmac);
					response.commit = firmwareUpdateDescriptor.commit;
					response.version = firmwareUpdateDescriptor.version;
					response.checksum = firmwareUpdateDescriptor.checksum;
				} else if (update === false) {
					response.success = true;
					console.log("No firmware update available.");
				} else {
					console.log("Update semver response: " + update);
				}

				// KNOWN DEVICES:
				// - see if new firmware is available and reply FIRMWARE_UPDATE with url
				// - see if alias or owner changed
				// - otherwise reply just OK

				//
				// Fiund out, whether device with presented udid exists (owner MUST match to verified API key owner)
				//

				devicelib.get(udid, function(error, existing) {

					if (!error && (typeof(existing) !== "undefined") && (existing.owner == owner)) {

						// If exists, checkin as existing device...
						_private.checkinExistingDevice(existing, reg, callback);
						return;

					} else {

						// If does not exist, search by MAC address first and if not found, create new...
						devicelib.view("devicelib", "devices_by_mac", {
								key: reg.mac,
								include_docs: true
							},

							function(err, body) {

								if (err) {
									console.log(
										"Device with this UUID/MAC not found. Seems like new one..."
									);
								} else {
									console.log("Device with this MAC already exists.");

									if (typeof(body.rows) === "undefined") {

										console.log("ERROR: THE BODY IS:" + JSON.stringify(body));

									} else {

										console.log("ROWS:" + JSON.stringify(body.rows));

										var xisting = body.rows[0];

										if (typeof(xisting) !== "undefined") {
											console.log("Checking-in existing device by known MAC...");
											_private.checkinExistingDevice(xisting, reg, callback);
											return;
										} else {
											console.log("No existing device...");
										}
									}
								}

								//
								// New device
								//

								console.log("[OID:" + owner +
									"] [DEVICE_NEW] New device: " + JSON.stringify(
										reg));

								var TOOL = exec.execSync("which mosquitto_passwd").toString()
									.replace(
										"\n", "");

								console.log("mosquitto_passwd detection result: " + TOOL);

								if (TOOL.length > 1) {

									var CMD = TOOL + " -b " + app_config.project_root +
										"/mqtt_passwords " + udid +
										" " +
										api_key;
									var temp = exec.execSync(CMD);
									console.log("[REGISTER] Creating mqtt account..." + CMD);
									if (typeof(temp.data) !== "undefined" && temp.data.toString() !==
										"") {
										console.log("[REGISTER_ERROR] MQTT: " + JSON.stringify(temp));
									}
								}

								device.source = null;

								device.lastupdate = new Date();
								if (typeof(fw) !== "undefined" && fw !== null) {
									device.firmware = fw;
								}
								if (typeof(push) !== "undefined" && push !== null) {
									device.push = push;
								}
								if (typeof(alias) !== "undefined" && alias !== null) {
									device.alias = alias;
								}
								if (typeof(platform) !== "undefined" && platform !== null) {
									device.platform = platform;
								}

								console.log("Inserting known device..." + JSON.stringify(
									device));

								devicelib.insert(device, udid, function(err, body,
									header) {
									if (!err) {
										console.log("Device info created.");
										callback(true, {
											registration: {
												success: true,
												owner: owner,
												alias: device.alias,
												udid: udid,
												status: "OK"
											}
										});
										return;
									} else {
										reg.success = false;
										reg.status = "Insert failed";
										console.log("Device record update failed." +
											err);
										console.log("CHECK6:");
										console.log(reg);
										console.log("CHECK6.1:");
										console.log(rdict);
										var json = JSON.stringify(rdict);
										callback(false, json);
									}
								}); // insert
							}); // view
					}
				}); // get

			}); // verify

		},

		ott_request: function(owner, body, api_key, callback) {
			//apikey.verify(owner, api_key, function(success, message) {
			//console.log("OTTR: " + success.toString(), message);
			//if (success) {
			console.log("Requesting OTT...");
			_public.storeOTT(body, callback);
			//} else {
			//	callback(false, "OTT_API_KEY_NOT_VALID");
			//}
			//});
		},

		ott_update: function(ott, callback) {

			console.log("Fetching OTT...");

			client.get("ott:" + ott, function(err, info) {

				if (err) {
					callback(false, {
						success: false,
						status: "OTT_UPDATE_NOT_FOUND",
						ott: ott
					});
					console.log(err);
					return;
				}

				var ott_info = JSON.parse(info);
				console.log("ott_info: " + JSON.stringify(ott_info));

				deploy.initWithDevice(ott_info);
				console.log("LFP for ott_info");

				var path = deploy.latestFirmwarePath(ott_info.owner, ott_info.udid);
				if ((path !== "undefined") && path !== null) {
					_private.updateFromPath(path, ott, callback);
				} else {
					callback(false, {
						success: false,
						status: "OTT_UPDATE_NOT_AVAILABLE"
					});
				}

			});

		},

		firmware: function(body, api_key, callback) {

			if (typeof(body.registration) !== "undefined") {
				body = body.registration;
			}

			var mac = null; // will deprecate
			var udid = body.udid;
			var checksum = body.checksum;
			var commit = body.commit;
			var alias = body.alias;
			var owner = body.owner;

			var forced;
			var ott = null;

			// allow custom overrides

			// Currently supported overrides:
			// force = force update (re-install current firmware)
			// ott = return one-time URL instead of data

			if (typeof(body !== "undefined")) {
				if (typeof(body.forced) !== "undefined") {
					forced = body.forced;
					console.log("forced: " + forced);
				} else {
					forced = false;
				}
				if (typeof(body.ott) !== "undefined") {
					ott = body.ott;
					console.log("ott: " + ott);
				} else {
					ott = null;
				}
			}


			//
			// Standard / Forced Update
			//

			if (typeof(body.mac) === "undefined") {
				console.log("missing_mac in " + JSON.stringify(body));
				callback(false, {
					success: false,
					status: "missing_mac"
				});

				return;
			}

			// Headers must contain Authentication header
			if (typeof(api_key) !== "undefined") {
				// OK
			} else {
				console.log("ERROR: Update requests must contain API key!");
				callback(false, {
					success: false,
					status: "authentication"
				});
				return;
			}

			apikey.verify(owner, api_key, function(success, message) {

				if ((success === false) && (ott === null)) {
					alog.log(owner, "Attempt to use invalid API Key: " +
						api_key +
						" on device registration.");
					callback(false, message);
					return;
				}

				alog.log(owner, "Attempt to register device: " + udid +
					" alias: " +
					alias);

				devicelib.get(udid, function(err, device) {

					if (err) {
						console.log(err);
						return;
					}

					console.log(
						"Getting latest firmware update descriptor from envelope for: " +
						JSON.stringify(device));
					deploy.initWithDevice(device);
					var firmwareUpdateDescriptor = deploy.latestFirmwareEnvelope(
						device);
					var rmac = firmwareUpdateDescriptor.mac || mac;
					if (typeof(rmac) === "undefined") {
						throw Error("Missing MAC in device.js:778");
					}
					var mac = _public.normalizedMAC(rmac);

					console.log(
						"Seaching for possible firmware update... (owner:" +
						device.owner + ")");

					// Check update availability
					//console.log("UA check for device");
					var updateAvailable = deploy.hasUpdateAvailable(device);

					if (updateAvailable === false) {
						// Find-out whether user has responded to any actionable notification regarding this device
						client.get("nid:" + udid, function(err, json_keys) {
							if (!err) {
								console.log(json_keys);
								if (json_keys === null) return;
								if (typeof(json_keys) === "undefined") return;
								var not = JSON.parse(json_keys);
								if ((typeof(not) !== "undefined") && not.done === true) {
									console.log(
										"Device firmware current, deleting NID notification...");
									client.expire("nid:" + udid, 0);
								} else {
									console.log("Keeping nid:" + udid + ", not done yet...");
								}
							}
						});
					}

					// Find-out whether user has responded to any actionable notification regarding this device
					client.get("nid:" + udid, function(err, json_keys) {
						if (err) {
							console.log("Device has no NID for actionable notification.");
							// no NID, that's OK...
							// nid will be deleted on successful download/update (e.g. when device is current)
						} else {
							if (json_keys !== null) {
								var not = JSON.parse(json_keys);
								console.log("Device has NID:" + json_keys);
								if (not.done === true) {
									console.log("User sent reply.");
									// update allowed by user
								} else {
									console.log("Device is still waiting for reply.");
									// update not allowed by user
								}
							}
						}

						// Check path validity
						//console.log("Fetching latest firmware path for device...");
						var path = deploy.latestFirmwarePath(device.owner, device.udid);
						if (path === null) {
							console.log("No update available.");
							callback(false, {
								success: false,
								status: "UPDATE_NOT_FOUND"
							});
							return;
						}

						// Forced update is implemented through enforcing update availability,
						// BUT! TODO FIMXE what if no firmware is built yet? Pat must not be valid.
						if ((forced === true) && (path !== null)) {
							console.log("Using force, path is not null...");
							updateAvailable = true;
						}

						if (updateAvailable) {

							// Forced update
							if (forced === true) {
								_public.updateFromPath(path, ott, callback);
								return;
							}

							// Start OTT Update
							if (ott !== null) {
								console.log("Requesting OTT update...");
								_public.ott_request(owner, body, api_key, callback);
								// Perform OTT Update
							} else if (ott === null) {
								console.log("Requesting normal update...");
								_public.updateFromPath(path, ott, callback);
							}

						} else {
							console.log("No firmware update available for " +
								JSON.stringify(device));
							callback(false, {
								success: false,
								status: "OK"
							});
						}
					});
				}); // device
			}); // apikey
		},

		edit: function(owner, changes, callback) {

			if (typeof(changes) === "undefined") {
				callback(false, "changes_undefined");
				return;
			}

			var change = changes; // bulk operations are not required so far
			var udid;

			udid = change.udid;
			console.log("Processing change " + JSON.stringify(change) +
				" for udid " +
				udid);

			if (udid !== null) {

				if (typeof(owner) === "undefined") {
					callback(false, "owner_undefined");
					return;
				}

				if (typeof(udid) === "undefined") {
					callback(false, "udid_undefined");
					return;
				}

				update_device(owner, udid, change, callback);
			}

			function update_device(owner, udid, changes, update_callback) {

				devicelib.view("devicelib", "devices_by_owner", {
						key: owner,
						include_docs: true
					},

					function(err, body) {

						if (err) {
							console.log(err);
							update_callback(false, {
								success: false,
								status: "device_not_found"
							});
							return;
						}

						if (body.rows.length === 0) {
							//console.log(JSON.stringify(body));
							update_callback(false, {
								success: false,
								status: "no_such_device"
							});
							return;
						}
						var doc;
						for (var dindex in body.rows) {
							if (body.rows[dindex].hasOwnProperty("value")) {
								var dev = body.rows[dindex].value;
								if (udid.indexOf(dev.udid) != -1) {
									doc = dev;
									break;
								}
							}
						}

						if (typeof(doc) === "undefined") return;

						// Delete device document with old alias
						devicelib.destroy(doc._id, doc._rev, function(err) {

							delete doc._rev;

							if (err) {
								console.log("/api/device/edit ERROR:" + err);
								update_callback(false, {
									success: false,
									status: "destroy_failed"
								});
								return;
							}

							if (typeof(change.alias) !== "undefined") {
								doc.alias = change.alias;
							}

							if (typeof(change.owner) !== "undefined") {
								doc.owner = change.owner;
							}

							if (typeof(change.keyhash) !== "undefined") {
								doc.keyhash = change.keyhash;
							}

							if (typeof(change.auto_update) !== "undefined") {
								doc.auto_update = change.auto_update;
							}

							if (typeof(change.description) !== "undefined") {
								doc.description = change.description;
							}

							if (typeof(change.category) !== "undefined") {
								doc.category = change.category;
							}

							if (typeof(change.tags) !== "undefined") {
								doc.tags = change.tags;
							}

							devicelib.destroy(doc._id, doc._rev, function(err) {
								delete doc._rev;
								// Create device document with new alias
								devicelib.insert(doc, doc.udid,
									function(err, body, header) {
										if (err) {
											console.log("/api/device/edit ERROR:" + err);
											update_callback(false, {
												success: false,
												status: "device_not_changed"
											});
										} else {
											update_callback(true, {
												success: true,
												change: change
											});
										}
									});
							});
						});
					});
			}
		}

	};

	return _public;

})();

exports.register = Device.register;
exports.ott_request = Device.ott_request;
exports.ott_update = Device.ott_update;
exports.firmware = Device.firmware;
exports.edit = Device.edit;
exports.normalizedMAC = Device.normalizedMAC;

// Internals requiring <testability

exports.storeOTT = Device.storeOTT;
exports.fetchOTT = Device.fetchOTT;

// Private

//exports.updateFromPath = Device.updateFromPath;
