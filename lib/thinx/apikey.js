/** This THiNX-RTM API module is responsible for managing API Keys.
    This is the new version that will use Redis only. */

var APIKey = (function() {

	var redis = require("redis");
	var client = redis.createClient();
	var sha256 = require("sha256");

	var Rollbar = require("rollbar");

	var rollbar = new Rollbar({
		accessToken: "5505bac5dc6c4542ba3bd947a150cb55",
		handleUncaughtExceptions: true,
		handleUnhandledRejections: true
	});

	var alog = require("./audit");

	var _private = {

		/**
		 * No magic. Anyone can invent API Key, but it must be assigned to valid owner.
		 * @return {string} full-blown API Key (no hashing so far)
		 */

		new: function() {
			var string_from_date = new Date().toString();
			return sha256(string_from_date);
		}

	};

	// public
	var _public = {

		/**
		 * Create new API Key for owner
		 * @param {string} owner - owner._id
		 * @param {string} apikey_alias - requested API key alias
		 * @param {function} callback (err, apikey) - async return callback, returns new api key...
		 * @return {string} api_key - full blown API Key once, no hashes...
		 */

		create: function(owner, apikey_alias, callback) {

			var new_api_key = _private.new();

			var api_key_object = {
				"key": new_api_key,
				"hash": sha256(new_api_key),
				"alias": apikey_alias
			};

			// Fetch owner keys from redis
			client.get("ak:" + owner, function(err, json_keys) {

				// Create new owner object if nothing found
				if (err) {
					client.set("ak:" + owner, JSON.stringify([api_key_object]), function(
						err) {
						if (err) {
							console.log("[apikey] first key NOT created.");
							if (typeof(callback) !== "undefined") {
								callback(false);
							}
						} else {
							console.log("[apikey] first key created.");
							if (typeof(callback) !== "undefined") {
								callback(true, api_key_object);
							}
						}
					});
					return;
				}

				// Update existing key with new data
				var api_keys = JSON.parse(json_keys);
				if (api_keys === null) {
					api_keys = [];
				}
				api_keys.push(api_key_object);
				client.set("ak:" + owner, JSON.stringify(api_keys), function(
					err) {
					if (typeof(callback) !== "undefined") {
						if (err) {
							callback(false, err);
						} else {
							callback(true, api_key_object);
						}
					}
				});

			});

		},

		/**
		 * Verify API Key (should return at least owner_id if valid)
		 * @param {string} owner - owner_id (may be optional but speeds things up... will be owner id!)
		 * @param {function} callback (result, apikey) - async return callback, returns true or false and error
		 */

		verify: function(owner, apikey, callback) {

			// Fetch owner keys from redis
			client.get("ak:" + owner, function(err, json_keys) {

				// Return false if not found
				if (err) {
					if (typeof(callback) !== "undefined") {
						callback(false);
					}
					return;
				}

				// Check API Key against stored objects
				if ((typeof(json_keys) !== "undefined") && (json_keys !== null)) {
					var keys = JSON.parse(json_keys);
					for (var ki in keys) {
						if (keys[ki].key.indexOf(apikey) !== -1) {
							if (typeof(callback) !== "undefined") {
								callback(true);
							}
							return; // valid key found, early exit
						}
					}
					alog.log(owner, "Attempt to use invalid API Key: " + apikey);
					console.log("Valid API key not found for this owner in " + json_keys);
					if (typeof(callback) !== "undefined") {
						callback(false, "owner_found_but_no_key"); // no key found
					}
				} else {
					console.log("API keys owner not found");
					if (typeof(callback) !== "undefined") {
						callback(false, "apikey_not_found: " + "ak:" + owner);
					}
				}
			});

		},

		/**
		 * Revoke API Key
		 * @param {string} owner - owner_id (may be optional but speeds things up... will be owner id!)
		 * @param {string} api_key - has from the UI... will not search by api_key!
		 * @param {function} callback - async return callback, returns true or false and error
		 */

		revoke: function(owner, apikey_hashes, callback) {

			// Fetch owner keys from redis
			client.get("ak:" + owner, function(err, json_keys) {

				// Return false if not found
				if (err) {
					console.log("[APIKey:revoke:error]:" + err);
					callback(false);
					return;
				}

				var new_keys = [];
				var deleted_keys = [];

				// Check API Key against stored objects
				if ((typeof(json_keys) !== "undefined") && (json_keys !== null)) {
					var keys = JSON.parse(json_keys);

					for (var ki in keys) {
						var key_hash = "" + keys[ki].hash;

						// Evaluate existing key_hash in deletes and remove...
						// First successful result should be sufficient.
						var deleted = false;
						for (var apikey_hash_index in apikey_hashes) {
							// Skip revoked key(s)
							if (key_hash == apikey_hashes[apikey_hash_index]) {
								deleted = true;
								deleted_keys.push(key_hash);
								break;
							}
						}
						// In case none of the deletes is valid, keep this key.
						if (deleted === false) {
							new_keys.push(keys[ki]);
						}
					}

					client.set("ak:" + owner, JSON.stringify(new_keys), function(err,
						reply) {
						if (err) {
							callback(false);
							console.log(reply);
						} else {
							callback(true, deleted_keys);
						}
					});

				} else {
					// when json_keys is invalid
					callback(false, "owner_not_found");
				}
			});
		},

		/**
		 * List API Keys for owner
		 * @param {string} owner - 'owner' id
		 * @param {function} callback (err, body) - async return callback
		 */

		list: function(owner, callback) {
			// Fetch owner keys from redis
			client.get("ak:" + owner, function(err, json_keys) {

				// Return false if not found
				if (err) {
					rollbar.warning("API Key list owner not found: " + owner);
					callback(false, "owner_not_found");
					return;
				}

				if ((typeof(json_keys) !== "undefined") && (json_keys !== null)) {
					var api_keys = JSON.parse(json_keys);
					if (api_keys === null) {
						api_keys = [];
					}
					var keys = Object.keys(api_keys);
					var exportedKeys = [];
					for (var index in keys) {
						var keyname = keys[index];
						var keydata = api_keys[keyname];

						var key = "**************************************";
						if (typeof(keydata.key) !== "undefined") {
							key = "******************************" + keydata.key
								.substring(
									30);
						}
						var info = {
							name: key,
							hash: keydata.hash,
							alias: keydata.alias
						};
						exportedKeys.push(info);
					}
					callback(true, exportedKeys);
				} else {
					callback(false, "owner_found_but_no_key"); // no key found
				}
			});
		}
	};

	return _public;

})();

exports.create = APIKey.create;
exports.verify = APIKey.verify;
exports.revoke = APIKey.revoke;
exports.list = APIKey.list;
