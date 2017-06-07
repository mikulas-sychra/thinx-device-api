/** This THiNX-RTM API module is responsible for managing devices. */

var Device = (function() {

	var app_config = require("../../conf/config.json");
	var db = app_config.database_uri;
	var devicelib = require("nano")(db).use("managed_devices");

	var sha256 = require("sha256");

	// public
	var _public = {

		register: function(registration, callback) {

			var api_key = null;

			var rdict = {};

			rdict.registration = {};

			var mac = reg.mac;
			var fw = "unknown";
			if (!reg.hasOwnProperty("firmware")) {
				fw = "undefined";
			} else {
				fw = reg.firmware;
				console.log("Setting firmware " + fw);
			}

			var push = reg.push;
			var alias = reg.alias;
			var username = reg.owner; // TODO: Search devices by username

			// Headers must contain Authentication header
			if (typeof(req.headers.authentication) !== "undefined") {
				api_key = req.headers.authentication;
			} else {
				console.log("ERROR: Registration requests now require API key!");
				alog.log(username, "Attempt to register witout API Key!");
				callback(false, "authentication");
				return;
			}

			// TODO: If device gives udid, get by udid (existing)
			// TODO: If device gives owner, search by owner_id
			// TODO: If device gives username, search by username

			userlib.view("users", "owners_by_username", {
				//"key": username,
				"include_docs": true // might be useless
			}, function(err, body) {

				if (err) {
					console.log("Error: " + err.toString());
					req.session.destroy(function(err) {
						if (err) {
							console.log(err);
						} else {
							failureResponse(res, 501, "protocol");
							console.log("Not a valid request.");
						}
					});
					return;
				}

				if (body.rows.length === 0) {
					callback(false, "owner_not_found");
					return;
				}

				var owner;
				var api_key_valid = false;

				// search API Key in owners, this will take a while...
				for (var oindex in body.rows) {
					var anowner = body.rows[oindex];
					for (var kindex in anowner.doc.api_keys) {
						var k = anowner.doc.api_keys[kindex].key;
						if (k.indexOf(api_key) != -1) {
							owner = anowner.doc.owner;
							console.log("Valid key found.");
							api_key_valid = true;
							break;
						}
					}
				}

				alog.log(owner, "Attempt to register device: " + hash +
					" alias: " +
					alias);

				var deploy = require("./lib/thinx/deployment");
				deploy.initWithOwner(owner); // creates user path if does not exist

				if (api_key_valid === false) {
					console.log("[APIKEY_INVALID] on registration.");
					alog.log(owner, "Attempt to use invalid API Key: " +
						api_key +
						" on device registration.");
					callback(false, "authentication");
					return;
				} else {
					alog.log(owner, "Using API Key: " + api_key);
				}

				var success = false;
				var status = "OK";

				var device_version = "1.0.0"; // default



				if (typeof(reg.version) !== "undefined" && reg.version !==
					null) {
					console.log("Updating device version to " + reg.version);
					device_version = reg.version;
				}

				var known_owner = "";

				var hash = null;
				if (typeof(reg.hash) !== "undefined") {
					hash = reg.hash;
				}

				var checksum = hash;
				if (typeof(reg.checksum) !== "undefined") {
					checksum = reg.checksum;
				}

				var udid = uuidV1(); // is returned to device which should immediately take over this value instead of mac for new registration
				if (typeof(reg.udid) !== "undefined") {
					udid = reg.udid; // overridden
				}

				//
				// Construct response
				//

				var reg = {};

				if (
					(typeof(rdict.registration) !== "undefined") &&
					(rdict.registration !== null)
				) {
					reg = rdict.registration;
				}

				reg.success = success;
				reg.status = status;

				if (known_owner === "") {
					known_owner = owner;
				}

				if (owner != known_owner) {
					// TODO: Fail from device side, notify admin.
					console.log("owner is not known_owner (" + owner + ", " +
						known_owner +
						")");
					reg.owner = known_owner;
					owner = known_owner; // should force update in device library
				}

				console.log("Device firmware: " + fw);

				var mqtt = "/devices/" + udid;

				var device = {
					mac: mac,
					firmware: fw,
					hash: hash,
					checksum: checksum,
					push: push,
					alias: alias,
					owner: owner,
					source: null,
					version: device_version,
					udid: udid,
					mqtt: mqtt,
					lastupdate: new Date(),
					lastkey: sha256(api_key)
				};

				console.log("Seaching for possible firmware update...");

				console.log("Checking update for device descriptor:\n" + JSON
					.stringify(
						device));

				//var deploy = require("./lib/thinx/deployment");
				var update = deploy.hasUpdateAvailable(device);
				if (update === true) {
					console.log("Firmware update available.");
					var firmwareUpdateDescriptor = deploy.latestFirmwareEnvelope(
						device);
					reg.status = "FIRMWARE_UPDATE";
					reg.success = true;
					reg.url = firmwareUpdateDescriptor.url;
					reg.mac = firmwareUpdateDescriptor.mac;
					reg.commit = firmwareUpdateDescriptor.commit;
					reg.version = firmwareUpdateDescriptor.version;
					reg.checksum = firmwareUpdateDescriptor.checksum;
				} else if (update === false) {
					reg.success = true;
					console.log("No firmware update available.");
				} else {
					console.log("Update semver response: " + update);
				}

				// KNOWN DEVICES:
				// - see if new firmware is available and reply FIRMWARE_UPDATE with url
				// - see if alias or owner changed
				// - otherwise reply just OK

				devicelib.get(mac, function(error, existing) {

					if (!error && existing) {

						console.log("[OID:" + owner +
							"] [DEVICE_CHECKIN] Known device: " + JSON.stringify(
								reg));

						existing.lastupdate = new Date();
						if (typeof(fw) !== "undefined" && fw !== null) {
							existing.firmware = fw;
						}
						if (typeof(hash) !== "undefined" && hash !== null) {
							existing.hash = hash;
						}
						if (typeof(push) !== "undefined" && push !== null) {
							existing.push = push;
						}
						if (typeof(alias) !== "undefined" && alias !== null) {
							existing.alias = alias;
						}
						// device notifies on owner change
						if (typeof(owner) !== "undefined" && owner !== null) {
							existing.owner = owner;
						}

						devicelib.destroy(existing._id, existing._rev,
							function(err) {

								delete existing._rev;

								devicelib.insert(existing, udid, function(err,
									body, header) {
									if (!err) {
										res.set("Connection", "close");
										callback(true, {
											registration: {
												success: true,
												owner: owner,
												alias: alias,
												udid: existing.udid,
												status: "OK"
											}
										});
										return;
									} else {
										res.set("Connection", "close");
										callback(false, {
											registration: {
												success: false,
												status: "insert_failed"
											}
										});
									}
								});

							});

					} else {

						console.log("[OID:" + owner +
							"] [DEVICE_NEW] New device: " + JSON.stringify(
								reg));

						device.udid = udid;

						// MQTT
						var CMD = "mosquitto_passwd -b mqtt_passwords " + udid +
							" " +
							api_key;
						var temp = exec.execSync(CMD);
						console.log("[REGISTER] Creating mqtt account...");
						if (temp) {
							console.log("[REGISTER_ERROR] MQTT: " + temp);
						}


						device.source = null;

						device.lastupdate = new Date();
						if (typeof(fw) !== "undefined" && fw !== null) {
							device.firmware = fw;
						}
						if (typeof(hash) !== "undefined" && hash !== null) {
							device.hash = hash;
						}
						if (typeof(push) !== "undefined" && push !== null) {
							device.push = push;
						}
						if (typeof(alias) !== "undefined" && alias !== null) {
							device.alias = alias;
						}

						console.log("Inserting device..." + JSON.stringify(
							device));

						devicelib.insert(device, udid, function(err, body,
							header) {
							if (!err) {
								console.log("Device info created.");
								res.set("Connection", "close");
								callback(true, {
									registration: {
										success: true,
										owner: owner,
										alias: device.alias,
										udid: device.udid,
										status: "OK"
									}
								});
								return;
							} else {
								reg.success = false;
								reg.this.status = "Insert failed";
								console.log("Device record update failed." +
									err);
								console.log("CHECK6:");
								console.log(reg);
								console.log("CHECK6.1:");
								console.log(rdict);
								var json = JSON.stringify(dict);
								res.set("Connection", "close");
								res.end(json);
							}
						});
					}
				});
			});
		},

		firmware: function(body, callback) {
			var api_key = null;

			if (typeof(req.body.mac) === "undefined") {
				callback(false, {
					success: false,
					status: "missing_mac"
				});
				return;
			}

			if (typeof(req.body.hash) === "undefined") {
				/* optional, we'll find latest checksum if not available
				callback(false, {
					success: false,
					status: "missing_udid"
				}));
				return;
				*/
			}

			if (typeof(req.body.checksum) === "undefined") {
				/* optional, we'll find latest checksum if not available
				callback(false, {
					success: false,
					status: "missing_checksum"
				}));
				return;
				*/
			}

			if (typeof(req.body.commit) === "undefined") {
				/* optional, we'll find latest commit_id if not available
				callback(false, {
					success: false,
					status: "missing_commit"
				}));
				return;
				*/
			}

			var mac = req.body.mac; // will deprecate
			var udid = req.body.udid;
			var checksum = req.body.checksum;
			var commit = req.body.commit;
			var alias = req.body.alias;
			var owner = req.body.owner;

			console.log("TODO: Validate if SHOULD update device " + mac +
				" using commit " + commit + " with checksum " + checksum +
				" and owner: " +
				owner);

			// Headers must contain Authentication header
			if (typeof(req.headers.authentication) !== "undefined") {
				api_key = req.headers.authentication;
			} else {
				console.log("ERROR: Update requests must contain API key!");
				callback(false, {
					success: false,
					status: "authentication"
				});
				return;
			}

			// fetches all users! to provide a current device firmware? why?
			userlib.view("users", "owners_by_username", {
				"include_docs": true // might be useless
			}, function(err, all_users) {

				if (err) {
					console.log("Error: " + err.toString());
					req.session.destroy(function(err) {
						if (err) {
							console.log(err);
						} else {
							failureResponse(res, 501, "protocol");
							console.log("Not a valid request.");
						}
					});
					return;
				}

				// Find user and match api_key
				var api_key_valid = false;

				// search API Key in owners, this will take a while...
				for (var oindex in all_users.rows) {
					if (!all_users.hasOwnProperty("rows")) continue;
					if (!all_users.rows.hasOwnProperty(oindex)) continue;
					var anowner = all_users.rows[oindex];
					if (!anowner.hasOwnProperty("doc")) continue;
					if (!anowner.doc.hasOwnProperty("api_keys")) continue;
					for (var kindex in anowner.doc.api_keys) {
						if (!anowner.doc.api_keys.hasOwnProperty(kindex)) continue;
						if (!anowner.doc.api_keys[kindex].hasOwnProperty("key"))
							continue;
						var k = anowner.doc.api_keys[kindex].key;
						if (k.indexOf(api_key) != -1) {
							owner = anowner.doc.owner;
							console.log("API Key valid.");
							api_key_valid = true;
							break;
						}
					}
				}

				alog.log(owner, "Attempt to register device: " + udid +
					" alias: " +
					alias);

				if (api_key_valid === false) {
					console.log("[APIKEY_INVALID] on firmware update.");
					alog.log(owner, "Attempt to use invalid API Key: " +
						api_key +
						"  on firmware update.");
					callback(false, {
						success: false,
						status: "api_key_invalid"
					});
					return;
				} else {
					alog.log(owner, "Firmware request with API Key: " + api_key);
				}

				// See if we know this MAC which is a primary key in db

				if (err !== null) {
					console.log("Querying devices failed. " + err + "\n");
				}

				devicelib.view("devicelib", "devices_by_id", {
					"key": udid,
					"include_docs": true
				}, function(err, existing) {

					if (err) {
						console.log(err);
						return;
					}

					var device = {
						mac: existing.mac,
						owner: existing.owner,
						version: existing.version
					};

					var firmwareUpdateDescriptor = deploy.latestFirmwareEnvelope(
						device);
					var mac = firmwareUpdateDescriptor.mac;

					console.log(
						"Seaching for possible firmware update... (owneer:" +
						device.owner + ")");

					deploy.initWithDevice(device);

					var update = deploy.hasUpdateAvailable(device);
					if (update === true) {
						var path = deploy.latestFirmwarePath(owner, udid);
						fs.open(path, 'r', function(err, fd) {
							if (err) {
								callback(false, {
									success: false,
									status: "not_found"
								});
								return console.log(err);
							} else {
								var buffer = fs.readFileSync(path);
								res.end(buffer);
								fs.close(fd, function() {
									console.log(
										'Sending firmware update from ' +
										path + '...');
								});

								devicelib.insert(existing, mac, function(err,
									body, header) {
									if (!err) {
										console.log("Device updated.");
										return;
									} else {
										console.log(
											"Device record update failed." +
											err);
									}
								}); // insert

							}
						}); // fs.open

					} else {
						callback(true, {
							success: true,
							status: "no_update_available"
						});
						console.log("No firmware update available for " +
							JSON.stringify(
								device));
					}
				}); // device get
			}); // user view
		},

		edit: function(owner, changes, callback) {

			console.log("CHANGES: " + JSON.stringify(changes));

			var change = changes; // TODO: support bulk operations

			var udid;
			for (var changeindex in changes) {
				if (!changes[changeindex].hasOwnProperty(udid)) continue;
				udid = changes[changeindex].udid;
				console.log("Processing change " + changeindex + "for udid " + udid);
				if (udid !== null) {
					update_device(owner, udid, changes[changeindex]);
				}
			}

			function update_device(owner, udid, changes) {

				devicelib.view("devicelib", "devices_by_owner", {
						key: owner,
						include_docs: true
					},

					function(err, body) {

						if (err) {
							console.log(err);
							callback(false, {
								success: false,
								status: "device_not_found"
							});
							return;
						}

						if (body.rows.length === 0) {
							console.log(JSON.stringify(body));
							callback(false, {
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
								callback(false, {
									success: false,
									status: "destroy_failed"
								});
								return;
							}

							if (typeof(change.alias) !== "undefined") {
								doc.alias = change.alias;

							}

							if (typeof(change.avatar) !== "undefined") {
								doc.avatar = change.avatar;

							}

							devicelib.destroy(doc._id, doc._rev, function(err) {

								delete doc._rev;

								// Create device document with new alias
								devicelib.insert(doc, doc._id, function(err, body,
									header) {
									if (err) {
										console.log("/api/device/edit ERROR:" +
											err);
										callback(false, {
											success: false,
											status: "device_not_changed"
										});
										return;
									} else {
										callback(true, {
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
exports.firmware = Device.firmware;
exports
	.edit = Device.edit;