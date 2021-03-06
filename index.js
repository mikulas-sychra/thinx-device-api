/*
 * This THiNX-RTM API module is responsible for responding to devices and build requests.
 */

var ThinxApp = function() {

  var typeOf = require("typeof");

  var Rollbar = require("rollbar");

  var rollbar = new Rollbar({
    accessToken: "5505bac5dc6c4542ba3bd947a150cb55",
    handleUncaughtExceptions: true,
    handleUnhandledRejections: true
  });

  require("ssl-root-cas").inject();

  //
  // Shared Configuration
  //

  require("console-stamp")(console, {
    metadata: function() {
      return ("");
    },
    colors: {
      stamp: "green",
      label: "white",
      metadata: "red"
    }
  });

  console.log(" ");
  console.log(" ");
  console.log(" ");
  console.log("--- " + new Date() + " ---");

  var session_config = require("./conf/node-session.json");
  var app_config = require("./conf/config.json"); // this file should be actually omitted from repository
  if (typeof(process.env.CIRCLE_USERNAME) !== "undefined") {
    console.log("» Starting on Circle CI...");
    app_config = require("./conf/config-test.json");
  }
  if (process.env.LOGNAME == "sychram") {
    console.log("» Starting on workstation...");
    app_config = require("./conf/config-local.json");
  }
  if (process.env.LOGNAME == "root") {
    console.log("» Starting in production mode...");
    app_config = require("./conf/config.json");
  }

  var client_user_agent = app_config.client_user_agent;
  var db = app_config.database_uri;
  var serverPort = app_config.port;
  var socketPort = app_config.socket;

  var url = require("url");
  var http = require("http");
  var https = require("https");
  var parser = require("body-parser");
  var nano = require("nano")(db);
  var sha256 = require("sha256");

  var fs = require("fs");

  var v = require("./lib/thinx/version");
  var alog = require("./lib/thinx/audit");
  var blog = require("./lib/thinx/buildlog");
  var builder = require("./lib/thinx/builder");
  var device = require("./lib/thinx/device");
  var devices = require("./lib/thinx/devices");
  var watcher = require("./lib/thinx/repository");
  var apienv = require("./lib/thinx/apienv");
  var apikey = require("./lib/thinx/apikey");
  var user = require("./lib/thinx/owner");
  var rsakey = require("./lib/thinx/rsakey");
  var stats = require("./lib/thinx/statistics");
  var sources = require("./lib/thinx/sources");
  var transfer = require("./lib/thinx/transfer");

  var WebSocket = require("ws");

  // list of previously discovered attackers
  var BLACKLIST = ["203.218.194.124", "179.128.55.14"];

  var getClientIp = function(req) {
    var ipAddress = req.connection.remoteAddress;
    if (!ipAddress) {
      return "";
    }
    // convert from "::ffff:192.0.0.1"  to "192.0.0.1"
    if (ipAddress.substr(0, 7) == "::ffff:") {
      ipAddress = ipAddress.substr(7);
    }
    return ipAddress;
  };

  // EXTRACT TO: db.js -->

  /*
   * Databases
   */

  var prefix = "";
  try {
    var pfx_path = app_config.project_root + '/conf/.thx_prefix';
    if (fs.existsSync(pfx_path)) {
      prefix = fs.readFileSync(pfx_path) + "_";
    }
  } catch (e) {
    //console.log(e);
  }

  function initDatabases() {

    nano.db.create(prefix + "managed_devices", function(err, body, header) {
      if (err) {
        handleDatabaseErrors(err, "managed_devices");
      } else {
        console.log("» Device database creation completed. Response: " +
          JSON.stringify(
            body) + "\n");
      }
    });

    nano.db.create(prefix + "managed_builds", function(err, body, header) {
      if (err) {
        handleDatabaseErrors(err, "managed_builds");
      } else {
        console.log("» Build database creation completed. Response: " +
          JSON
          .stringify(
            body) + "\n");
      }
    });

    nano.db.create(prefix + "managed_users", function(err, body, header) {
      if (err) {
        handleDatabaseErrors(err, "managed_users");
      } else {
        console.log("» User database creation completed. Response: " +
          JSON
          .stringify(
            body) + "\n");
      }
    });

    nano.db.create(prefix + "managed_sources", function(err, body, header) {
      if (err) {
        handleDatabaseErrors(err, "managed_sources");
      } else {
        console.log("» Source database creation completed. Response: " +
          JSON
          .stringify(
            body) + "\n");
      }
    });
  }

  function handleDatabaseErrors(err, name) {

    if (err.toString().indexOf("the file already exists") != -1) {
      // silently fail, this is ok

    } else if (err.toString().indexOf("error happened in your connection") !=
      -
      1) {
      console.log("🚫 Database connectivity issue. " + err);
      process.exit(1);

    } else {
      console.log("🚫 Database " + name + " creation failed. " + err);
      process.exit(2);
    }
  }

  /*
  // Database access
  // ./vault write secret/password value=13fd9bae19f4daffa17b34f05dbd9eb8281dce90 owner=test revoked=false
  // Vault init & unseal:

  var options = {
  	apiVersion: 'v1', // default
  	endpoint: 'http://127.0.0.1:8200', // default
  	token: 'b7fbc90b-6ae2-bbb8-ff0b-1a7e353b8641' // optional client token; can be fetched after valid initialization of the server
  };


  // get new instance of the client
  var vault = require("node-vault")(options);

  // init vault server
  vault.init({
  		secret_shares: 1,
  		secret_threshold: 1
  	})
  	.then((result) => {
  		var keys = result.keys;
  		// set token for all following requests
  		vault.token = result.root_token;
  		// unseal vault server
  		return vault.unseal({
  			secret_shares: 1,
  			key: keys[0]
  		})
  	})
  	.catch(console.error);

  */

  initDatabases();

  var devicelib = require("nano")(db).use(prefix + "managed_devices");
  var userlib = require("nano")(db).use(prefix + "managed_users");

  // <-- EXTRACT TO: db.js && databases must not be held by app class

  // Express App

  var express = require("express");
  var session = require("express-session");

  var app = express();

  console.log("» Starting Redis client...");
  var redis = require("redis");
  var redisStore = require("connect-redis")(session);
  var client = redis.createClient();

  app.set("trust proxy", 1);

  var hour = 3600000;
  var day = hour * 24;
  var fortnight = day * 14;

  app.use(session({
    secret: session_config.secret,
    store: new redisStore({
      host: "localhost",
      port: 6379,
      client: client
    }),
    name: "x-thx-session",
    resave: true,
    rolling: false,
    saveUninitialized: true,
  }));
  // rolling was true

  app.use(parser.json({
    limit: "10mb"
  }));

  app.use(parser.urlencoded({
    extended: true,
    parameterLimit: 10000,
    limit: "10mb"
  }));

  /*
  app.use(function(req, res, next) {
    var ipAddress = getClientIp(req);
    if (BLACKLIST.toString().indexOf(ipAddress) === -1) {
      next();
    } else {
      res.status(418).end();
    }
  });
  */

  app.all("/*", function(req, res, next) {

    // CORS must be enabled esp. for devices
    var allowedOrigin = "rtm.thinx.cloud";

    if (typeof(req.headers.origin) !== "undefined") {
      allowedOrigin = req.headers.origin;
    }

    var client = req.get("User-Agent");

    if (client.indexOf("Jorgee") !== -1) {
      BLACKLIST.push(getClientIp(req));
      res.status(418).end();
      console.log("Jorgee is blacklisted.");
      return;
    }

    if (req.originalUrl.indexOf("admin") !== -1) {
      BLACKLIST.push(getClientIp(req));
      res.status(418).end();
      console.log("admin is blacklisted.");
      return;
    }

    if (req.originalUrl.indexOf("php") !== -1) {
      BLACKLIST.push(getClientIp(req));
      res.status(418).end();
      console.log("php is blacklisted.");
      return;
    }

    if (req.originalUrl.indexOf("\\x04\\x01\\x00") !== -1) {
      BLACKLIST.push(getClientIp(req));
      res.status(418).end();
      console.log("hrrtbleed is blacklisted.");
      return;
    }

    if (req.headers.origin == "device") {
      next();
      return;
    }

    res.header("Access-Control-Allow-Origin", allowedOrigin); // rtm.thinx.cloud
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers",
      "Content-type,Accept,X-Access-Token,X-Key");

    if (req.method == "OPTIONS") {
      res.status(200).end();
    } else {
      next();
    }

    if (client == client_user_agent) {
      if (typeof(req.headers.origin) !== "undefined") {
        if (req.headers.origin == "device") {
          next();
          return;
        }
      }
    }

    // log owner ID and request method to application log only
    if ((typeof(req.session) !== "undefined") && (typeof(req.session
        .owner) !== "undefined")) {
      // console.log("[OID:" + req.session.owner + "] ", req.method + " : " + req.url);
    } else {
      // Skip logging for monitoring sites
      if (client.indexOf("uptimerobot")) {
        return;
      }
      if (req.method != "OPTIONS") {
        console.log("[OID:0] [" + req.method + "]:" + req.url + "(" +
          client + ")");
      }
    }
  });

  /*
   * Devices
   */

  /* List all devices for user. */
  app.get("/api/user/devices", function(req, res) {
    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;
    var owner = req.session.owner;
    devices.list(owner, function(success, response) {
      respond(res, response);
    });
  });

  /* Attach code source to a device. Expects unique device identifier and source alias. */
  app.post("/api/device/attach", function(req, res) {
    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;
    var owner = req.session.owner;
    var body = req.body;
    devices.attach(owner, body, function(success, status) {
      respond(res, {
        success: success,
        attached: status
      });
    });
  });

  /* Detach code source from a device. Expects unique device identifier. */
  app.post("/api/device/detach", function(req, res) {
    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;
    var owner = req.session.owner;
    devices.detach(owner, req.body, function(success, status) {
      respond(res, {
        success: success,
        status: status
      });
    });
  });

  /* Revokes a device. Expects unique device identifier. */
  app.post("/api/device/revoke", function(req, res) {
    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;
    var owner = req.session.owner;
    devices.revoke(owner, req.body, function(success, status) {
      respond(res, {
        success: success,
        status: status
      });
    });
  });

  /*
   * API Keys
   */

  /* Creates new api key. */
  app.post("/api/user/apikey", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    if (typeof(req.body.alias) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_alias"
      });
      return;
    }

    var new_api_key_alias = req.body.alias;

    apikey.create(owner, new_api_key_alias, function(success,
      object) {
      if (success) {
        console.log("Getting owner " + owner + " for api key... \n" +
          JSON.stringify(object));
        respond(res, {
          success: true,
          api_key: object.key,
          hash: object.hash
        });
        return;
      }
    });
  });

  /* Deletes API Key by its hash value */
  app.post("/api/user/apikey/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var api_key_hashes = [];

    if (typeof(req.body.fingerprint) !== "undefined") {
      api_key_hashes = [req.body.fingerprint];
    }

    if (typeof(req.body.fingerprints) !== "undefined") {
      api_key_hashes = req.body.fingerprints;
    }

    apikey.revoke(owner, api_key_hashes, function(success) {
      if (success) {
        respond(res, {
          revoked: api_key_hashes,
          success: true
        });
        return;
      } else {
        respond(res, {
          success: false,
          status: "revocation_failed"
        });
      }
    });
  });

  /* Lists all API keys for user. */
  app.get("/api/user/apikey/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    apikey.list(owner, function(success, keys) {
      if (success) {
        respond(res, {
          api_keys: keys
        });
        return;
      } else {
        respond(res, {
          success: false,
          status: "apikey_list_failed"
        });
      }
    });
  });

  /*
   * Environment Variables
   */

  /* Creates new env var. */
  app.post("/api/user/env/add", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    if (typeof(req.body.key) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_key"
      });
      return;
    }

    if (typeof(req.body.value) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_value"
      });
      return;
    }

    var key = req.body.key;
    var value = req.body.value;

    apienv.create(owner, key, value,
      function(success, object) {
        if (success) {
          respond(res, {
            success: true,
            key: key,
            value: value,
            object: object
          });
        } else {
          respond(res, {
            success: success,
            message: object
          });
        }
      });
  });

  /* Deletes env var by its name */
  app.post("/api/user/env/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var env_var_names;

    if (typeof(req.body.name) !== "undefined") {
      env_var_names = [req.body.name];
    }

    if (typeof(req.body.names) !== "undefined") {
      env_var_names = req.body.names;
    }

    if (typeof(env_var_names) === "undefined") {
      respond(res, {
        success: false,
        status: "no_names_given"
      });
      return;
    }

    apienv.revoke(owner, env_var_names, function(success, response) {
      if (success) {
        respond(res, {
          revoked: env_var_names,
          success: true
        });
      } else {
        respond(res, {
          success: success,
          status: response
        });
      }
    });
  });

  /* Lists all env vars for user. */
  app.get("/api/user/env/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    apienv.list(owner, function(success, response) {
      if (success) {
        respond(res, {
          env_vars: response
        });
        return;
      } else {
        respond(res, {
          success: false,
          status: "env_list_failed"
        });
      }
    });
  });

  /*
   * Sources (GIT Repositories)
   */

  /* List available sources */
  app.get("/api/user/sources/list", function(req, res) {
    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;
    sources.list(req.session.owner, function(success, response) {
      if (success === true) {
        respond(res, {
          success: true,
          sources: response
        });
      } else {
        respond(res, response);
      }
    });
  });

  /* Adds a GIT repository. Expects URL, alias and a optional branch (origin/master is default). */
  app.post("/api/user/source", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.alias) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_source_alias"
      });
      return;
    }

    if (typeof(req.body.url) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_source_url"
      });
      return;
    }

    var branch = "origin/master";
    if ((typeof(req.body.branch) !== "undefined") &&
      (req.body.branch !== null)) {
      branch = req.body.branch;
    }

    var url = req.body.url;
    var alias = req.body.alias;

    sources.add(req.session.owner, alias, url, branch,
      function(success, response) {
        respond(res, response);
      });
  });

  /* Removes a GIT repository. Expects alias. */
  app.post("/api/user/source/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    if (typeof(req.body.source_ids) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_source_ids"
      });
      return;
    }

    var source_ids = req.body.source_ids;
    sources.remove(owner, source_ids, function(success, message) {
      respond(res, message);
    });
  });

  /*
   * RSA Keys
   */

  app.post("/api/user/rsakey/add", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    // Validate those inputs from body... so far must be set
    if (typeof(req.body.alias) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_ssh_alias"
      });
      return;
    }

    if (typeof(req.body.key) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_ssh_key"
      });
      return;
    }

    var new_key_alias = req.body.alias;
    var new_key_body = req.body.key;

    rsakey.add(owner, new_key_alias, new_key_body, function(success,
      response) {
      if (success === false) {
        respond(res, {
          success: success,
          status: response
        });
      } else {
        respond(res, {
          success: success,
          fingerprint: response
        });
      }
    });
  });

  /* Lists all RSA keys for user. */
  app.get("/api/user/rsakey/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    rsakey.list(owner, function(success, response) {
      if (success === false) {
        respond(res, {
          success: success,
          status: response
        });
      } else {
        respond(res, {
          success: success,
          rsa_keys: response
        });
      }
    });

  });

  /* Deletes RSA Key by its fingerprint */
  app.post("/api/user/rsakey/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner;

    if (typeof(req.session.owner) !== "undefined") {
      owner = req.session.owner;
    } else {
      respond(res, {
        success: false,
        status: "missing_attribute:owner"
      });
      return;
    }

    // Support bulk updates
    if (typeof(req.body.fingerprints) !== "undefined") {
      var fingerprints = req.body.fingerprints;
      console.log("Fingerprints: " + JSON.stringify(fingerprints));
      rsakey.revoke(owner, fingerprints,
        function(success, response) {
          respond(res, {
            success: success,
            status: response
          });
        });
      return;
    }

    // Will deprecate
    if (typeof(req.body.fingerprint) !== "undefined") {
      rsakey.revoke(owner, [fingerprint],
        function(success, message) {
          respond(res, {
            success: success,
            status: message
          });
        });
      return;
    }

    respond(res, {
      success: false,
      status: "invalid_query"
    });

  });

  /*
   * Password Reset
   */

  // /user/create GET
  /* Create username based on e-mail. Owner must be unique (email hash). */
  app.post("/api/user/create", function(req, res) {
    user.create(req.body, function(success, status) {
      respond(res, {
        success: success,
        status: status
      });
    });
  });

  // /user/delete POST
  /* Delete user document */
  app.post("/api/user/delete", function(req, res) {
    user.delete(req.body, function(success, status) {
      respond(res, {
        success: success,
        status: status
      });
    });
  });

  /* Endpoint for the password reset e-mail. */
  app.get("/api/user/password/reset", function(req, res) {
    var owner = req.query.owner; // for faster search
    var reset_key = req.query.reset_key; // for faster search
    user.password_reset(owner, reset_key, function(success, message) {
      if (!success) {
        req.session.destroy(function(err) {
          respond(res, {
            success: success,
            status: message
          });
        });
      } else {
        res.redirect(message.redirectURL);
      }
    });
  });

  /* Endpoint for the user activation e-mail, should proceed to password set. */
  app.get("/api/user/activate", function(req, res) {
    console.log(JSON.stringify(req.query));
    var ac_key = req.query.activation;
    var ac_owner = req.query.owner;
    user.activate(ac_owner, ac_key, function(success, message) {

      if (!success) {
        req.session.destroy(function(err) {
          console.log(err);
        });
        respond(res, {
          success: success,
          status: message
        });
      } else {
        res.redirect(message.redirectURL);
      }
    });
  });

  /* Used by the password.html page to perform the change in database. Should revoke reset_key when done. */
  app.post("/api/user/password/set", function(req, res) {
    user.set_password(req.body, function(success, message) {
      if (!success) {
        req.session.destroy();
        respond(res, {
          success: success,
          status: message
        });
      } else {
        console.log(
          "Returning message on app.post /api/user/password/set :" +
          JSON.stringify(message));
        respond(res, message);
      }
    });
  });

  // /user/password/reset POST
  /* Used to initiate password-reset session, creates reset key with expiraation and sends password-reset e-mail. */
  app.post("/api/user/password/reset", function(req, res) {
    user.password_reset_init(req.body.email, function(success, message) {
      if (!success) {
        req.session.destroy();
        respond(res, {
          success: success,
          status: message
        });
      } else {
        respond(res, message);
      }
    });
  });

  /*
   * User Profile
   */

  /* Updates user profile allowing following types of bulked changes:
   * { avatar: "base64hexdata..." }
   * { info: { "arbitrary" : "user info data "} } }
   */

  app.post("/api/user/profile", function(req, res) {
    console.log("/api/user/profile");
    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;
    var owner = req.session.owner;
    user.update(owner, req.body, function(success, status) {
      console.log("Updating user profile...");
      respond(res, {
        success: success,
        status: status
      });
    });
  });

  // /user/profile GET
  app.get("/api/user/profile", function(req, res) {

    // reject on invalid headers
    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    user.profile(owner, function(success, response) {
      if (success === false) {
        respond(res, {
          success: success,
          status: response
        });
      } else {
        respond(res, {
          success: success,
          profile: response
        });
      }
    });

  });

  //
  // Main Device API
  //

  // Firmware update retrieval for OTT requests
  app.get("/device/firmware", function(req, res) {
    var ott = req.query.ott;
    if (typeof(ott) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_ott"
      });
    }
    console.log("Update with OTT: " + ott);
    device.ott_update(ott, function(success, response) {
      respond(res, response);
    });
  });

  // Firmware update retrieval. Serves binary [by owner (?) - should not be required] and device MAC.
  app.post("/device/firmware", function(req, res) {

    validateRequest(req, res);
    res.set("Connection", "close");

    // Device will create OTT request and fetch firmware from given OTT-URL
    if ((typeof(req.body.use) !== "undefined") && (req.body.use == "ott")) {
      device.ott_request(req.owner, req.body, req.headers.authentication,
        function(success, response) {
          respond(res, response);
        });

      // Device will fetch firmware/files now (wrapped as JSON or in binary, depending on type (firmware/file))
    } else {
      device.firmware(req.body, req.headers.authentication,
        function(success, response) {
          respond(res, response);
        });
    }
  });

  // Device login/registration
  // MAC is be allowed for initial regitration where device is given new UDID

  app.post("/device/register", function(req, res) {

    validateRequest(req, res);
    res.set("Connection", "close");

    if (typeof(req.body) === "undefined") {
      respond(res, {
        success: false,
        status: "no_body"
      });
    } else if (typeof(req.body.registration) === "undefined") {
      respond(res, {
        success: false,
        status: "no_registration"
      });
    } else {
      var registration = req.body.registration;
      device.register(registration, req.headers.authentication, function(
        success, response) {
        respond(res, response);
      });
    }
  });

  // Device editing (alias only so far)
  app.post("/api/device/edit", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.changes) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_changes"
      });
      return;
    }

    var owner = req.session.owner;
    var changes = req.body.changes;

    device.edit(owner, changes, function(success, message) {
      respond(res, {
        success: success,
        message: message
      });
    });
  });

  function failureResponse(res, code, reason) {
    res.writeHead(code, {
      "Content-Type": "application/json"
    });
    respond(res, {
      success: false,
      "reason": reason
    });
  }

  function validateRequest(req, res) {
    // Check device user-agent
    var ua = req.headers["user-agent"];
    var validity = ua.indexOf(client_user_agent);

    if (validity === 0) {
      return true;
    } else {
      console.log("User-Agent: " + ua + " invalid!");
      res.writeHead(401, {
        "Content-Type": "text/plain"
      });
      res.end("validate: Client request has invalid User-Agent.");
      return false;
    }
  }

  function validateSecureGETRequest(req, res) {
    if (req.method != "GET") {
      console.log("validateSecure: Not a get request." + JSON.stringify(req.query
        .params));
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 500, "protocol");
        }
      });
      return false;
    }
    return true;
  }

  function validateSecurePOSTRequest(req, res) {
    if (req.method != "POST") {
      console.log("validateSecure: Not a post request.");
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 500, "protocol");
        }
      });
      return false;
    }
    return true;
  }

  // Terminates session in case it has no valid owner.
  function validateSession(req, res) {
    if (typeof(req.session.owner) !== "undefined") {
      return true;
    } else {
      if (typeof(req.session) !== "undefined") {
        req.session.destroy(function(err) {
          if (err) {
            console.log("Session destroy error: " + JSON.stringify(err));
          }
          res.status(401).end(); // return 401 unauthorized to XHR/API calls
        });
      }
      return false;
    }
  }

  /*
   * Builder
   */

  // Build respective firmware and notify target device(s
  app.post("/api/build", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var wrapper = req.body.build;

    builder.build(owner, wrapper, function(success, response) {
      respond(res, response);
    });
  });

  /*
   * Build and Audit Logs
   */

  /* Returns all audit logs per owner */
  app.get("/api/user/logs/audit", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    alog.fetch(owner, function(err, body) {

      if (err !== false) {
        console.log(err);
        respond(res, {
          success: false,
          status: "log_fetch_failed",
          error: err
        });
      } else {
        if (!body) {
          console.log("Log for owner " + owner + " not found.");
          respond(res, {
            success: false,
            status: "log_fetch_failed",
            error: err
          });
        } else {
          respond(res, {
            success: true,
            logs: body
          });
        }
      }
    });
  });

  /* Returns list of build logs for owner */
  app.get("/api/user/logs/build/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    if (typeof(owner) === "undefined") {
      respond(res, {
        success: false,
        status: "session_failed"
      });
      return;
    }



    blog.list(owner, function(err, body) {

      var builds = [];

      if (err) {
        console.log("err: " + err);
        respond(res, {
          success: false,
          status: "build_list_failed",
          error: err
        });
        return;
      }

      if (!body) {
        console.log("Log for owner " + owner + " not found.");
        respond(res, {
          success: false,
          status: "build_list_empty",
          error: err
        });
        return;
      }

      for (var bindex in body.rows) {

        var row = body.rows[bindex];
        //console.log("Build log row: " + JSON.stringify(row));

        if (typeof(row.value.log) === "undefined") {
          var build = {
            date: body.value.timestamp,
            udid: body.value.udid
          };
          builds.push(build);
        } else {

          for (var dindex in row.value.log) {
            var lastIndex = row.value.log[dindex];
            var buildlog = {
              message: lastIndex.message,
              date: lastIndex.timestamp,
              udid: lastIndex.udid,
              build_id: lastIndex.build
            };
            builds.push(buildlog);
          }

        }
      }

      respond(res, {
        success: true,
        builds: builds
      });

    });
  });

  /* Returns specific build log for owner */
  app.post("/api/user/logs/build", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    if (typeof(req.body.build_id) == "undefined") {
      respond(res, {
        success: false,
        status: "missing_build_id"
      });
      return;
    }

    var build_id = req.body.build_id;

    blog.fetch(req.body.build_id, function(err, body) {
      if (err) {
        console.log(err);
        respond(res, {
          success: false,
          status: "build_fetch_failed",
          error: err
        });
        return;
      }

      if (!body) {
        console.log("Log for owner " + owner + " not found.");
        respond(res, {
          success: false,
          status: "build_fetch_empty",
          error: err
        });
        return;
      }

      var logs = [];
      for (var lindex in body.rows) {
        if (!body.rows[lindex].hasOwnProperty("value")) continue;
        if (!body.rows[lindex].value.hasOwnProperty("log")) continue;
        var lrec = body.rows[lindex].value.log;
        logs.push(lrec);
      }

      console.log("Build-logs for build_id " + build_id + ": " +
        JSON
        .stringify(
          logs));

      var response = body;
      response.success = true;
      respond(res, response);
    });
  });

  // WARNING! New, untested!

  /* Returns specific build log for owner */
  app.post("/api/user/logs/tail", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    if (typeof(req.body.build_id) == "undefined") {
      respond(res, {
        success: false,
        status: "missing_build_id"
      });
      return;
    }

    var build_id = req.body.build_id;

    console.log("Tailing build log for " + build_id);

    var error_callback = function(err) {
      console.log(err);
      res.set("Connection", "close");
      respond(res, err);
    };

    blog.logtail(req.body.build_id, owner, _ws, error_callback);

  });

  /*
   * Device Transfer
   */

  /* Request device transfer */
  app.post("/api/transfer/request", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    transfer.request(owner, req.body, function(success, response) {
      if (success === false) {
        console.log(response);
        respond(res, {
          success: false,
          status: "transfer_request_failed",
          error: response
        });
      } else {
        respond(res, {
          success: true,
          status: response
        });
      }
    });
  });

  /* Decline device transfer (all by e-mail, selective will be POST) */
  app.get("/api/transfer/decline", function(req, res) {

    var owner = req.session.owner;

    if (typeof(req.query.transfer_id) !== "undefined") {
      respond(res, {
        success: false,
        status: "transfer_id missing"
      });
      return;
    }

    var body = {
      transfer_id: req.query.transfer_id,
      udids: []
    };

    transfer.decline(body, function(success, response) {
      if (success === false) {
        console.log(response);
        respond(res, {
          success: false,
          status: "transfer_decline_failed",
          error: response
        });
      } else {
        respond(res, {
          success: true,
          status: response
        });
      }
    });
  });

  /* Decline selective device transfer */
  app.post("/api/transfer/decline", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.owner) !== "undefined") {
      respond(res, {
        success: false,
        status: "owner_missing"
      });
      return;
    }

    if (typeof(req.body.transfer_id) !== "undefined") {
      respond(res, {
        success: false,
        status: "transfer_id_missing"
      });
      return;
    }

    if (typeof(req.body.udids) !== "undefined") {
      respond(res, {
        success: false,
        status: "udids_missing"
      });
      return;
    }

    transfer.decline(body, function(success, response) {
      if (success === false) {
        console.log(response);
        respond(res, {
          success: false,
          status: "selective_transfer_decline_failed",
          error: response
        });
      } else {
        respond(res, {
          success: true,
          status: response
        });
      }
    });
  });

  /* Accept device transfer (all by e-mail, selective will be POST) */
  app.get("/api/transfer/accept", function(req, res) {

    var owner = req.session.owner;

    if (typeof(req.query.transfer_id) === "undefined") {
      respond(res, {
        success: false,
        status: "transfer_id_missing"
      });
      return;
    }

    var body = {
      transfer_id: req.query.transfer_id,
      udids: []
    };

    transfer.accept(body, function(success, response) {
      if (success === false) {
        console.log(response);
        respond(res, {
          success: false,
          status: "transfer_accept_failed",
          error: response
        });
      } else {
        respond(res, {
          success: true,
          status: response
        });
      }
    });
  });

  /* Accept selective device transfer */
  app.post("/api/transfer/accept", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.owner) !== "undefined") {
      respond(res, {
        success: false,
        status: "owner_missing"
      });
      return;
    }

    if (typeof(req.body.transfer_id) !== "undefined") {
      respond(res, {
        success: false,
        status: "transfer_id_missing"
      });
      return;
    }

    if (typeof(req.body.udids) !== "undefined") {
      respond(res, {
        success: false,
        status: "udids_missing"
      });
      return;
    }

    transfer.accept(req.body, function(success, response) {
      if (success === false) {
        console.log(response);
        respond(res, {
          success: false,
          status: "selective_transfer_accept_failed",
          error: response
        });
      } else {
        respond(res, {
          success: true,
          status: response
        });
      }
    });
  });

  /*
   * Authentication
   */

  // Front-end authentication, returns session on valid authentication
  app.post("/api/login", function(req, res) {

    var client_type = "webapp";
    var ua = req.headers["user-agent"];
    var validity = ua.indexOf(client_user_agent);

    if (validity === 0) {
      console.log(ua);
      client_type = "device";
    }

    // Request must be post
    if (req.method != "POST") {
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 500, "protocol");
          console.log("Not a post request.");
          return;
        }
      });
    }
    var username = req.body.username;
    var password = sha256(req.body.password);

    if (typeof(username) == "undefined" || typeof(password) ==
      "undefined") {
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 403, "unauthorized");
          console.log("User unknown.");
          return;
        }
      });
    }

    if (typeof(req.body.remember === "undefined") || (req.body.remember ===
        0)) {
      var hour = 3600000;
      req.session.cookie.expires = new Date(Date.now() + hour);
      req.session.cookie.maxAge = hour;
    } else {
      req.session.cookie.expires = new Date(Date.now() + fortnight);
      req.session.cookie.maxAge = fortnight;
    }

    var updateLastSeen = function(doc) {

      userlib.atomic("users", "checkin", doc._id, {
        last_seen: new Date()
      }, function(error, response) {
        if (err) {
          console.log("Last-seen update failed: " + err);
        } else {
          alog.log(owner, "Last seen updated.");
        }
      });
    };


    if (typeof(username) === "undefined") {
      if (typeof(callback) === "undefined") {
        return;
      } else {
        callback(false, "login_failed");
      }
    }

    userlib.view("users", "owners_by_username", {
      "key": username,
      "include_docs": false // might be useless
    }, function(err, body) {

      if (err) {
        console.log("Error: " + err.toString());
        req.session.destroy(function(err) {
          if (err) {
            console.log(err);
          } else {
            failureResponse(res, 403, "unauthorized");
            console.log("Owner not found: " + username);
            return;
          }
        });
        return;
      }

      // Find user and match password
      var all_users = body.rows;

      var user_data = null;
      for (var index in all_users) {
        var all_user_data = all_users[index];
        if (username != all_user_data.key) {
          continue;
        } else {
          user_data = all_user_data.value;
          break;
        }
      }

      if (user_data === null) {
        console.log("No user data, not authorized.");
        failureResponse(res, 403, "unauthorized");
        return;
      }

      // TODO: Second option (direct compare) will deprecate soon.
      if (password.indexOf(user_data.password) !== -1) {

        // what if there's no session?
        if (typeof(req.session) !== "undefined") {
          req.session.owner = user_data.owner;
          console.log("[OID:" + req.session.owner +
            "] [NEW_SESSION]");
          req.session.username = user_data.username;

          var minute = 60 * 1000;
          //req.session.cookie.httpOnly = true;

          if (typeof(req.body.remember === "undefined") || (req.body.remember ===
              0)) {
            var hour = 3600000;
            req.session.cookie.expires = new Date(Date.now() + hour);
            req.session.cookie.maxAge = hour;
          } else {
            req.session.cookie.expires = new Date(Date.now() +
              fortnight);
            req.session.cookie.maxAge = fortnight;
          }

          req.session.cookie.secure = true;

          alog.log(req.session.owner, "User logged in: " +
            username);
        }

        // console.log("client_type: " + client_type);
        if (client_type == "device") {
          respond(res, {
            status: "WELCOME",
            success: true
          });
          return;

        } else if (client_type == "webapp") {

          //console.log("Allow-Origin REQH: " + JSON.stringify(req.headers));
          //console.log("Allow-Origin REQS: " + JSON.stringify(req.session)); // should have owner.
          //console.log("Allow-Origin REQUEST host: " + req.headers.host);

          respond(res, {
            "redirectURL": "/app"
          });

          // Make note on user login
          userlib.get(req.session.owner, function(error, udoc) {

            if (error) {
              console.log("owner get error: " + err);
            } else {

              userlib.atomic("users", "checkin", udoc._id, {
                last_seen: new Date()
              }, function(error, response) {
                if (err) {
                  console.log("Last-seen update failed: " +
                    err);
                } else {
                  alog.log(req.session.owner,
                    "Last seen updated.");
                }
              });

            }
          });

          return;

        } else { // other client whan webapp or device
          respond(res, {
            status: "OK",
            success: true
          });
        }

        return;

      } else { // password invalid
        console.log("[LOGIN_INVALID] for " + username);
        alog.log(req.session.owner, "Password mismatch for: " +
          username);
        respond(res, {
          status: "password_mismatch",
          success: false
        });
        return;
      }

      if (typeof(req.session.owner) == "undefined") {
        if (client_type == "device") {
          return;
        } else if (client_type == "webapp") {
          // res.redirect("http://rtm.thinx.cloud:80/"); // redirects browser, not in XHR?
          respond(res, {
            "redirectURL": "http://rtm.thinx.cloud:80/app/#/dashboard.html"
          });
          return;
        }

        console.log("login: Flushing session: " + JSON.stringify(
          req.session));
        req.session.destroy(function(err) {
          if (err) {
            console.log(err);
          } else {
            respond(res, {
              success: false,
              status: "no session (owner)"
            });
            console.log("Not a post request.");
            return;
          }
        });
      } else {
        failureResponse(res, 403, "unauthorized");
      }
    });
  });

  // Front-end authentication, destroys session on valid authentication
  app.get("/api/logout", function(req, res) {
    if (typeof(req.session) !== "undefined") {
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        }
      });
    }
    console.log(JSON.stringify(req.params));
    //res.status(401).end();
    res.redirect("https://rtm.thinx.cloud/");
  });

  /*
   * Statistics
   */

  /* Returns all audit logs per owner */
  app.get("/api/user/stats", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    stats.week(owner, function(success, body) {

      if (!body) {
        console.log("Statistics for owner " + owner +
          " not found.");
        respond(res, {
          success: false,
          status: "no_results"
        });
        return;
      }

      if (!success) {
        respond(res, {
          success: false,
          status: body
        });
        return;
      }

      if (validateJSON(body)) {
        body = JSON.parse(body);
      }

      respond(res, {
        success: true,
        stats: body
      });
    });
  });

  /*
   * Chat
   */

  /* Websocket to Slack chat */
  app.post("/api/user/chat", function(req, res) {
    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;
    var owner = req.session.owner;
    var message = req.body.message;
    messenger.slack(owner, message, function(err, response) {
      if (err) {
        console.log("[OID:" + owner + "] Chat message failed with error " + err.toString());
      } else {
        console.log("[OID:" + owner + "] Chat message sent.");
      }
      respond(res, {
        success: !err,
        status: response
      });
    });
  });

  app.post("/api/user/message", function(req, res) {
    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;
    var owner = req.session.owner;
    var message = req.body.message;
    messenger.slack(owner, message, function(err, response) {
      console.log("Message: '" + message + "' with error " + err);
      respond(res, {
        success: !err,
        status: response
      });
    });
  });

  /*
   * Device Configuration
   */

  /* Respond to actionable notification */
  app.post("/api/device/push", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;


    var owner = req.session.owner;

    /*
    var device = req.body.udid;
    var nid = "nid:" + device;
    var reply = req.body.reply;

    if (typeof(device) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_udid"
      });
      return;
    }

    if (typeof(nid) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_nid"
      });
      return;
    }

    if (typeof(nid) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_reply"
      });
      return;
    }
    */

    devices.push(owner, req.body, function(error, response) {
      respond(res, {
        success: error,
        status: response
      });
    });


  });

  /*
   * Actionable Notifications
   */

  /* Respond to actionable notification */
  app.post("/api/device/notification", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var device = req.body.udid;
    var nid = "nid:" + device;
    var reply = req.body.reply;

    if (typeof(device) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_udid"
      });
      return;
    }

    if (typeof(nid) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_nid"
      });
      return;
    }

    if (typeof(nid) === "undefined") {
      respond(res, {
        success: false,
        status: "missing_reply"
      });
      return;
    }

    messenger.publish(owner, device, {
      nid: nid,
      reply: reply
    });


  });

  /*
   * Root
   */

  /** Tested with: !device_register.spec.js` */
  app.get("/", function(req, res) {
    var protocol = req.protocol;
    var host = req.get("host");
    if (req.session.owner) {
      console.log("/ called with owner: " + req.session.owner);
      res.redirect("/");
    } else {
      res.redirect(protocol + "://" + host);
    }
  });

  /*
   * HTTP/HTTPS API Server
   */

  app.version = function() {
    return v.revision();
  };

  /*
   * HTTP/S Server
   */

  var ssl_options = null;

  // disable HTTPS on CIRCLE CI
  if (typeof(process.env.CIRCLE_USERNAME) === "undefined") {

    if ((fs.existsSync(app_config.ssl_key)) &&
      (fs.existsSync(app_config.ssl_cert))) {
      ssl_options = {
        key: fs.readFileSync(app_config.ssl_key),
        cert: fs.readFileSync(app_config.ssl_cert),
        NPNProtocols: ['http/2.0', 'spdy', 'http/1.1', 'http/1.0']
      };
      console.log("» Starting HTTPS server on " + (serverPort + 1) +
        "...");
      https.createServer(ssl_options, app).listen(serverPort + 1);
    } else {
      console.log(
        "Skipping HTTPS server, SSL key or certificate not found.");
    }
  }

  // Legacy HTTP support for old devices without HTTPS proxy
  http.createServer(app).listen(serverPort);

  /*
   * WebSocket Server
   */

  var wsapp = express();

  wsapp.use(session({
    secret: session_config.secret,
    store: new redisStore({
      host: "localhost",
      port: 6379,
      client: client
    }),
    cookie: {
      expires: hour
    },
    name: "x-thx-session",
    resave: false,
    rolling: true,
    saveUninitialized: true,
  }));

  var wserver = null;
  if (typeof(process.env.CIRCLE_USERNAME) === "undefined") {
    wserver = https.createServer(ssl_options, wsapp);
  } else {
    wserver = http.createServer(wsapp);
  }

  var wss = new WebSocket.Server({
    port: socketPort,
    server: wserver
  });


  var _ws = null;

  wss.on("connection", function connection(ws, req) {

    req.on("error", function(err) {
      console.log("WSS REQ ERROR: " + err);
      return;
    });

    _ws = ws;

    var cookies = req.headers.cookie;

    if (typeof(req.headers.cookie) !== "undefined") {
      if (cookies.indexOf("x-thx-session") === -1) {
        console.log("» WSS cookies: " + cookies);
        console.log("» Not authorized using x-thx-session");
        //wss.close();
        //return;
      }
      if (typeof(req.session) !== "undefined") {
        console.log("Session: " + JSON.stringify(req.session));
      }
    }

    var logtail_callback = function(err) {
      console.log("[index.js] logtail_callback:" + err);
    };

    ws.on("message", function incoming(message) {

      var object = JSON.parse(message);
      console.log("WS Message: " + message);

      if (typeof(object.logtail) !== "undefined") {

        var build_id = object.logtail.build_id;
        var owner_id = object.logtail.owner_id;
        blog.logtail(build_id, owner_id, _ws, logtail_callback);

      } else if (typeof(object.init) !== "undefined") {

        messenger.initWithOwner(object.init, _ws, function(success,
          message) {
          if (!success) {
            console.log("Messenger init on message with success " +
              error +
              "message: " +
              JSON.stringify(message));
          }
        });

      } else {
        console.log("» Websocketparser said: unknown message: " +
          JSON.stringify(message));
      }
    });

  }).on("error", function(err) {
    console.log("WSS ERROR: " + err);
    return;
  });

  wserver.listen(7444, function listening() {
    console.log("» WebSocket listening on port %d", wserver.address()
      .port);
  });


  /*
   * Bootstrap banner section
   */

  var package_info = require("./package.json");
  var product = package_info.description;
  var version = package_info.version;

  console.log("");
  console.log("-=[ ☢ " + product + " v" + version +
    " rev. " +
    app.version() +
    " ☢ ]=-");
  console.log("");
  console.log("» Started on port " +
    serverPort +
    " (HTTP) and " + (serverPort +
      1) +
    " (HTTPS)");

  /* Should load all devices with attached repositories and watch those repositories.
   * Maintains list of watched repositories for runtime handling purposes.
   * TODO: Re-build on change.
   */

  var watcher_callback = function(result) {
    if (typeof(result) !== "undefined") {
      console.log("watcher_callback result: " + JSON.stringify(result));
      if (result === false) {
        console.log(
          "No change detected on repository so far."
        );
      } else {
        console.log(
          "CHANGE DETECTED! - TODO: Commence re-build (will notify user but needs to get all required user data first (owner/device is in path)"
        );
      }
    } else {
      console.log("watcher_callback: no result");
    }
  };

  var getNewestFolder = function(dir, regexp) {
    newest = null;
    files = fs.readdirSync(dir);
    one_matched = 0;

    for (i = 0; i < files.length; i++) {

      if (regexp.test(files[i]) === false) {
        continue;
      } else if (one_matched === 0) {
        newest = dir + "/" + files[i];
        one_matched = 1;
        continue;
      }

      var filepath = dir + "/" + files[i];
      //console.log("STAT> " + filepath);
      f1_time = fs.statSync(filepath).mtime.getTime();
      f2_time = fs.statSync(newest).mtime.getTime();
      if (f1_time > f2_time)
        newest[i] = files[i];
    }

    if (newest !== null)
      return (newest);
    return null;
  };

  //
  // Database compactor
  //

  function database_compactor() {
    console.log("» Running database compact jobs...");
    nano.db.compact("logs");
    nano.db.compact("builds");
    nano.db.compact("devicelib");
    nano.db.compact("users", "owners_by_username", function(err) {
      console.log("» Database compact jobs completed.");
    });
  }
  setTimeout(database_compactor, 300);

  //
  // Log aggregator
  //

  function log_aggregator() {
    console.log("» Running log aggregation jobs...");
    rollbar.info("Running aggregator.");
    stats.aggregate();
    console.log("» Aggregation jobs completed.");
  }
  setTimeout(log_aggregator, 360000);

  //
  // MQTT Messenger/listener (experimental)
  //

  var messenger = require("./lib/thinx/messenger");

  //
  // HTTP/S Request Tools
  //

  function respond(res, object) {

    if (typeOf(object) == "buffer") {
      res.end(object);

    } else if (typeOf(object) == "string") {
      res.end(object);

    } else {
      res.end(JSON.stringify(object));
    }
  }

  function validateJSON(str) {
    try {
      JSON.parse(str);
    } catch (e) {
      return false;
    }
    return true;
  }

};

var thx = new ThinxApp();
