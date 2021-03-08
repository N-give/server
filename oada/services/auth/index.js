/* Copyright 2014 Open Ag Data Alliance
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// The config needs to know whether to look for command-line arguments or not,
// so set isLibrary in global scope before requiring.
global.isLibrary = !(require.main === module);

const util = require('util');
const fs = require('fs');

const debug = require('debug');

const config = require('./config');

const info = debug('auth#index:info');
const error = debug('auth#index:error');
const trace = debug('auth#index:trace');

// If there is an endpointsPrefix, update all the endpoints to include the
// prefix before doing anything else
const pfx = config.get('auth:endpointsPrefix');
if (typeof pfx === 'string') {
  trace('Adding supplied prefix %s to all endpoints', pfx);
  const endpoints = config.get('auth:endpoints');
  for (const [k, v] of Object.entries(endpoints)) {
    config.set('auth:endpoints:' + k, pfx + v);
  }
}
trace('Using config = %O', config.get('auth'));

const path = require('path');
const https = require('https');
const express = require('express');
const session = require('express-session');
const ArangoSessionStore = require('connect-arango')(session);
const bodyParser = require('body-parser');
const passport = require('passport');
const morgan = require('morgan');
const oauth2orize = require('oauth2orize');
const URI = require('urijs');
const axios = require('axios');

const { middleware: oadaError } = require('oada-error');

// Use the oada-id-client for the openidconnect code flow:
const { middleware: oadaidclient } = require('@oada/oada-id-client');

//-----------------------------------------------------------------------
// Load all the domain configs at startup
const ddir = config.get('domainsDir');
trace('using domainsDir = %s', ddir);
const domainConfigs = fs.readdirSync(ddir).reduce((acc, dirname) => {
  if (dirname.startsWith('.') == false) {
    try {
      const config = require(ddir + '/' + dirname + '/config');
      acc[config.domain] = config;
    } catch (e) {
      error('ERROR: could not read config for domain %s, skipping', dirname);
    }
  }
  return acc;
}, {});

module.exports = function (conf) {
  // TODO: This require config is very hacky. Reconsider.
  if (conf) {
    config.setObject(conf);
  }

  config.set(
    'auth:server:port',
    process.env.PORT || config.get('auth:server:port')
  );

  var publicUri;
  if (!config.get('auth:server:publicUri')) {
    publicUri = URI()
      .hostname(config.get('auth:server:domain'))
      .port(config.get('auth:server:port'))
      .protocol(config.get('auth:server:mode'))
      .normalize()
      .toString();
  } else {
    publicUri = URI(config.get('auth:server:publicUri')).normalize().toString();
  }

  config.set('auth:server:publicUri', publicUri);

  // Require these late because they depend on the config
  const dynReg = require('./dynReg');
  const clients = require('./db/models/client');
  const users = require('./db/models/user');
  const keys = require('./keys');
  const utils = require('./utils');
  require('./auth');
  var app = express();

  var wkj = config.get('auth:wkj')
    ? config.get('auth:wkj')
    : require('@oada/well-known-json')();

  app.set('view engine', 'ejs');
  app.set('json spaces', config.get('auth:server:jsonSpaces'));
  app.set('views', config.get('auth:views:basedir'));
  app.set('trust proxy', config.get('auth:server:proxy'));

  app.use(morgan('combined'));
  app.use(bodyParser.urlencoded({ extended: true }));
  const arangourl = new URL(config.get('arangodb:connectionString'));
  app.use(
    session({
      secret: config.get('auth:server:sessionSecret'),
      resave: false,
      saveUninitialized: false,
      store: new ArangoSessionStore({
        db: {
          host: arangourl.hostname,
          schema: arangourl.protocol.replace(':', ''),
          port: arangourl.port,
          collection: config.get('arangodb:collections:sessions:name'),
          database: config.get('arangodb:database'),
        },
      }),
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());

  var server = oauth2orize.createServer();
  server.serializeClient(function (client, done) {
    return done(null, client.clientId);
  });
  server.deserializeClient(function (id, done) {
    clients.findById(id, done);
  });

  //////
  // UI
  //////
  if (config.get('auth:oauth2:enable') || config.get('auth:oidc:enable')) {
    var oauth2 = require('./oauth2')(server, config);

    //----------------------------------------------------------------
    // Client registration endpoint:
    app.options(config.get('auth:endpoints:register'), require('cors')());
    app.post(
      config.get('auth:endpoints:register'),
      require('cors')(),
      bodyParser.json(),
      dynReg
    );

    //----------------------------------------------------------------
    // OAuth2 authorization request (serve the authorization screen)
    app.get(
      config.get('auth:endpoints:authorize'),
      function (_req, res, done) {
        trace(
          'GET ' +
            config.get('auth:endpoints:authorize') +
            ': setting X-Frame-Options=SAMEORIGIN before oauth2.authorize'
        );
        res.header('X-Frame-Options', 'SAMEORIGIN');
        return done();
      },
      oauth2.authorize
    );
    app.post(config.get('auth:endpoints:decision'), oauth2.decision);
    app.post(
      config.get('auth:endpoints:token'),
      function (req, _res, next) {
        trace(
          req.hostname +
            ': token POST ' +
            config.get('auth:endpoints:token') +
            ', storing reqdomain in req.user'
        );
        next();
      },
      oauth2.token
    );

    //--------------------------------------------------------------------------
    // Login page: someone has navigated or been redirected to the login page.
    // Populate based on the domain.
    // If session already has a userid, then just use that.
    app.get(config.get('auth:endpoints:login'), function (req, res) {
      trace(
        'GET ' +
          config.get('auth:endpoints:login') +
          ': setting X-Frame-Options=SAMEORIGIN before rendering login'
      );
      trace('login endpoint: Session = %O', req.session);
      res.header('X-Frame-Options', 'SAMEORIGIN');
      const iserror = !!req.query.error || req.session.errormsg;
      let errormsg = req.session.errormsg || 'Login failed.';
      if (req.session.errormsg) {
        // reset for next time
        req.session.errormsg = false; // reset for next time
      }

      // Load the login info for this domain from the public directory:
      const domain_config =
        domainConfigs[req.hostname] || domainConfigs.localhost;
      res.render(config.get('auth:views:loginPage'), {
        // Where should the local login form post:
        login_url: config.get('auth:endpoints:login'),
        // Where should the openidconnect form post:
        loginconnect_url: config.get('auth:endpoints:loginConnect'),

        // domain-specific configs:
        // has .username, .password
        hint: domain_config.hint || { username: '', password: '' },
        logo_url:
          config.get('auth:endpointsPrefix') +
          '/domains/' +
          domain_config.domain +
          '/' +
          domain_config.logo,
        name: domain_config.name,
        tagline: domain_config.tagline,
        color: domain_config.color || '#FFFFFF',
        idService: domain_config.idService, // has .shortname, .longname
        iserror: iserror,
        errormsg: errormsg,

        // domain_hint can be set when authorization server redirects to login
        domain_hint: 'growersync.trellisfw.io', //req.session.domain_hint || '',
      });
    });

    //---------------------------------------------------
    // Handle post of local form from login page:
    const pfx = config.get('auth:endpointsPrefix') || '';
    app.post(
      config.get('auth:endpoints:login'),
      passport.authenticate('local', {
        successReturnToOrRedirect: '/' + pfx,
        failureRedirect: config.get('auth:endpoints:login') + '?error=1',
      })
    );

    //-----------------------------------------------------------------
    // Handle the POST from clicking the "login with OADA/trellisfw" button
    app.post(
      config.get('auth:endpoints:loginConnect'),
      function (req, res, next) {
        // First, get domain entered in the posted form
        // and strip protocol if they used it
        let dest_domain = req.body && req.body.dest_domain;
        if (dest_domain) dest_domain = dest_domain.replace(/^https?:\/\//);
        req.body.dest_domain = dest_domain;
        info(
          config.get('auth:endpoints:loginConnect') +
            ': OpenIDConnect request to redirect from domain ' +
            req.hostname +
            ' to domain ' +
            dest_domain
        );

        // Next, get the info for the id client middleware based on main domain:
        const domain_config =
          domainConfigs[req.hostname] || domainConfigs.localhost;
        const options = {
          metadata: domain_config.software_statement,
          redirect:
            'https://' +
            req.hostname +
            // the config already has the pfx added
            config.get('auth:endpoints:redirectConnect'),
          scope: 'openid profile',
          prompt: 'consent',
          privateKey: domain_config.keys.private,
        };

        // And call the middleware directly so we can use closure variables:
        trace(
          config.get('auth:endpoints:loginConnect') +
            ': calling getIDToken for dest_domain = %s',
          dest_domain
        );
        return oadaidclient.getIDToken(dest_domain, options)(req, res, next);
      }
    );

    //-----------------------------------------------------
    // Handle the redirect for openid connect login:
    app.use(
      config.get('auth:endpoints:redirectConnect'),
      (req, _res, next) => {
        info(
          '+++++++++++++++++++=====================++++++++++++++++++++++++',
          config.get('auth:endpoints:redirectConnect') +
            ', req.user.reqdomain = ' +
            req.hostname +
            ': OpenIDConnect request returned'
        );
        next();
        // Get the token for the user
      },
      oadaidclient.handleRedirect(),
      async (req, res, next) => {
        // "Token" is both an id token and an access token
        let { id_token: idToken, access_token: token } = req.token;

        // should have req.token after this point
        // Actually log the user in here, maybe get user info as well
        // Get the user info:
        //  proper method is to ask again for profile permission
        //  after getting the idtoken
        //  and determining we don't know this ID token.
        //  If we do know it, don't worry about it
        info(
          '*+*+*+*+*+*+*+*+*+*+*+*+*+*+*+*+*+**+*+*+*+*+*+*+*======',
          config.get('auth:endpoints:redirectConnect') +
            ', req.hostname = ' +
            req.hostname +
            ': token is: %O',
          idToken
        );
        try {
          let user = await users.findByOIDCToken(idToken);
          if (!user) {
            let uri = new URI(idToken.iss);
            uri.path('/.well-known/openid-configuration');
            let cfg = (await axios.get(uri.toString())).data;

            let userinfo = (
              await axios.get(cfg['userinfo_endpoint'], {
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              })
            ).data;

            user = await users.findByOIDCUsername(
              userinfo['preferred_username'],
              idToken.iss
            );

            if (!user) {
              // we don't have a user with this sub or username,
              // so they don't have an account
              req.session.errormsg =
                'There is no user ' +
                userinfo['preferred_username'] +
                ' from ' +
                idToken.iss;
              info(
                'Failed OIDC login: user not found.  Redirecting to %s',
                req.session.returnTo
              );
              return res.redirect(req.session.returnTo);
            }
            // Add sub to existing user
            // TODO: Make a link function or something
            //       instead of shoving sub where it goes?
            user.oidc.sub = idToken.sub;
            await users.update(user);
          }

          // Put user into session
          let login = util.promisify(req.login.bind(req));
          await login(user);

          // Send user back where they started
          return res.redirect(req.session.returnTo);
        } catch (err) {
          return next(err);
        }
        // look them up by oidc.sub and oidc.iss,
        // get their profile data to get username if not found?
        // save user in the session somehow
        // to indicate to passport that we are logged in.
        // redirect to req.session.returnTo from passport
        // and/or connect-ensure-login
        // since this will redirect them
        // back to where they originally wanted to go
        // which was likely an oauth request.
      }
    );

    app.get(config.get('auth:endpoints:logout'), function (req, res) {
      req.logout();
      res.redirect(req.get('Referrer'));
    });

    if (config.get('auth:endpointsPrefix'))
      app.use(
        config.get('auth:endpointsPrefix'),
        express.static(path.join(__dirname, 'public'))
      );
    else app.use(express.static(path.join(__dirname, 'public')));

    // Statically serve all the domains-enabled/*/auth-www folders:
    Object.keys(domainConfigs).forEach((domain) => {
      const ondisk = config.get('domainsDir') + '/' + domain + '/auth-www';
      const webpath = config.get('auth:endpointsPrefix') + '/domains/' + domain;
      trace(
        'Serving domain ' +
          domain +
          '/auth-www statically, on disk = ' +
          ondisk +
          ', webpath = ' +
          webpath
      );
      app.use(webpath, express.static(ondisk));
    });
  }

  //////
  // OAuth 2.0
  //////
  if (config.get('auth:oauth2:enable')) {
    wkj.addResource('oada-configuration', {
      authorization_endpoint: './' + config.get('auth:endpoints:authorize'),
      token_endpoint: './' + config.get('auth:endpoints:token'),
      registration_endpoint: './' + config.get('auth:endpoints:register'),
      token_endpoint_auth_signing_alg_values_supported: ['RS256'],
    });
  }

  //////
  // OIDC
  //////
  if (config.get('auth:oidc:enable')) {
    require('./oidc')(server);

    app.options(config.get('auth:endpoints:certs'), require('cors')());
    app.get(
      config.get('auth:endpoints:certs'),
      require('cors')(),
      function (_req, res) {
        res.json(keys.jwks);
      }
    );

    app.options(config.get('auth:endpoints:userinfo'), require('cors')());
    app.get(
      config.get('auth:endpoints:userinfo'),
      require('cors')(),
      passport.authenticate('bearer', { session: false }),
      function (req, res) {
        var userinfo = utils.createUserinfo(req.user, req.authInfo.scope);

        if (userinfo && userinfo.sub !== undefined) {
          res.json(userinfo);
        } else {
          res.status(401).end('Unauthorized');
        }
      }
    );

    wkj.addResource('openid-configuration', {
      issuer: './', //config.get('auth:server:publicUri'),
      registration_endpoint: './' + config.get('auth:endpoints:register'),
      authorization_endpoint: './' + config.get('auth:endpoints:authorize'),
      token_endpoint: './' + config.get('auth:endpoints:token'),
      userinfo_endpoint: './' + config.get('auth:endpoints:userinfo'),
      jwks_uri: './' + config.get('auth:endpoints:certs'),
      response_types_supported: [
        'code',
        'token',
        'id_token',
        'code token',
        'code id_token',
        'id_token token',
        'code id_token token',
      ],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
  }

  /////
  // .well-known
  /////
  if (!config.get('auth:wkj')) {
    app.use(wkj);
  }

  /////
  // Standard OADA Error
  /////
  app.use(oadaError());

  return app;
};

if (require.main === module) {
  var app = module.exports();
  var server1, server2;
  // Note: now we listen on both http and https by default.  https is only
  // for debugging trying to use localhost or 127.0.0.1, since that will resolve
  // inside the container itself instead of as the overall host.
  //  if (config.get('auth:server:mode') === 'http') {
  var server1 = app.listen(config.get('auth:server:port-http'), function () {
    info('Listening HTTP on port %d', server1.address().port);
  });
  //  } else {
  var server2 = https.createServer(config.get('auth:certs'), app);
  server2.listen(config.get('auth:server:port-https'), function () {
    info('Listening HTTPS on port %d', server2.address().port);
  });
  //  }
}
