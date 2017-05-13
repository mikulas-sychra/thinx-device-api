/**
 * This THiNX-RTM API module is responsible for aggregating daily statistics.
 */

var Statistics = (function() {

	var POLLING_TIMEOUT = 86400 * 1000;
	var LOG_PATH = "/var/logs/things.log";
	var STATS_PATH = "statistics/"; // ./statistics/date/owner

	// FIXME: Create STATS_PATH if not exists

	var fs = require('fs');
	var readline = require('readline');
	var exec = require("sync-exec");

	var owner = null;
	var timer = null;

	var _private = {

		globalPath: function() {
			return STATS_PATH;
		},

		ownerPath: function(owner) {
			return STATS_PATH + "/" + owner;
		},

		todayPathElement: function() {
			var today = new Date();
			return today.toString("yyyy-MM-dd") + "/";
		}

	};

	// public
	var _public = {

		/**
		 * Performs ETL transaction from current log
		 */

		aggregate: function() {

			fs.readFile(LOG_PATH, 'utf8', function(err, data) {

				if (err) {
					return console.log(err);
				}

				var parser = readline.createInterface({
					input: fs.createReadStream(LOG_PATH),
					output: process.stdout,
					console: false
				});

				parser.on('line', function(line) {

					var owners = {}; // key, stats...

					// WARNING! Defines data model

					var owner_stats_template = {
						oid: null,
						apikey_invalid: 0,
						password_invalid: 0,
						apikey_misuse: 0,
						device_new: 0,
						device_checkin: 0,
						device_update_ok: 0,
						device_update_fail: 0,
						build_success: 0,
						build_fail: 0
					};

					console.log(line);

					// Required format:

					// [API][SUBJECT:STATE]
					// [<OWNER_ID>][SUBJECT:STATE]


					// Count all events per OID per day..

					if (line.indexOf("[OID:") != 1) {

						// PHEW! Parse like this?
						var start_key = "[OID:"; // start with this string
						var oid_start = line.indexOf(start_key) + start_key.length;
						var rest1 = line.substr(oid_start); // take all the rest of line
						var oid_end = rest1.indexOf("]"); // find next bracket
						var oid = line.substr(oid_start, oid_start + oid_end); // get oid

						if ((oid.length < 1) || (oid.length > 255)) {
							console.log("OID out of range:" + oid);
							return;
						}

						owners[oid] = owner_stats_template; // init stat object per owner

						if (line.indexOf("[INVALID:APIKEY]") != -1) {
							owners[oid].api_key_invalid++;
						}

						if (line.indexOf("[INVALID:PASSWORD]") != -1) {
							owners[oid].password_invalid++;
						}

						if (line.indexOf("[MISUSED:APIKEY]") != -1) {
							owners[oid].apikey_misuse++;
						}

						if (line.indexOf("[DEVICE:NEW]") != -1) {
							owners[oid].device_new++;
						}

						if (line.indexOf("[DEVICE:CHECKIN]") != -1) {
							owners[oid].device_checkin++;
						}

						if (line.indexOf("[DEVICE:UPDATE:SUCCESS]") != -1) {
							owners[oid].device_update_ok++;
						}

						if (line.indexOf("[DEVICE:UPDATE:FAIL]") != -1) {
							owners[oid].device_update_ok++;
						}

						if (line.indexOf("[BUILD:SUCCESS]") != -1) {
							owners[oid].build_success++;
						}

						if (line.indexOf("[BUILD:FAIL]") != -1) {
							owners[oid].build_fail++;
						}

					} else {
						// line not parseable
					}

					// TODO: Save all owners to their files respectively...
					// Parse all owners in array and save to todayPathElement/"stats.json"

					for (var owner_id in owners) {
						var owner_stats = owners[owner_id];
						// TODO: Should create at least paths
						var res = fs.writeFileSync(_private.ownerPath(owner_id) +
							_private.todayPathElement() + "stats.json", owner_stats);
						console.log(res);
					}

				});

				// TODO: Add refresh timer like in Watcher...

			});


		},

		/**
		 * Returns today data created by ETL if available
		 * @param {string} owner - restrict to owner (EUREKA)
		 * @param {function} callback (err, statistics) - async return callback, returns statistics or error
		 */

		today: function(owner, callback) {

			// TODO: Fetch attributes from file by date if any

			callback(false, "error");
			callback(true, statistics);
		}

	};

	return _public;

})();

exports.aggregate = Statistics.aggregate;
exports.today = Statistics.today;