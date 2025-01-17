/**
 * @license
 * Copyright 2017-2022 Open Ag Data Alliance
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/ban-types */

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

import URI from 'urijs';
import debug from 'debug';

import type { jwksUtils as jwku } from '@oada/certs';

import libConfig from '@oada/lib-config';

import { schema as arangoSchema } from '@oada/lib-arangodb/dist/config.js';

const trace = debug('auth#config:trace');
const error = debug('auth#config:error');

export const { config, schema } = await libConfig({
  ...arangoSchema,
  domainsDir: {
    format: String,
    default: '/oada/services/auth/domains',
  },
  auth: {
    server: {
      'jsonSpaces': {
        format: 'int',
        default: 2,
      },
      'sessionSecret': {
        format: String,
        sensitive: true,
        default: 'Xka*32F@*!15',
      },
      'passwordSalt': {
        format: String,
        sensitive: true,
        default: '',
      },
      'port-http': {
        format: 'port',
        default: 80,
      },
      'port-https': {
        format: 'port',
        default: 443,
      },
      'port': {
        format: 'port',
        nullable: true,
        default: null as null | number,
        env: 'PORT',
        arg: 'port',
      },
      'mode': {
        format: ['http', 'https'],
        default: 'https',
      },
      'domain': {
        format: String,
        default: 'localhost',
        env: 'DOMAIN',
        arg: 'domain',
      },
      'publicUri': {
        format: 'url',
        default: null as null | string,
      },
      'proxy': {
        description: 'Whether to trust reverse-proxy headers',
        formats: Boolean,
        default: false,
      },
    },
    wkj: {
      default: null,
    },
    endpointsPrefix: {
      doc: 'So you can place this under a sub-path in your domain',
      format: String,
      default: '',
    },
    endpoints: {
      register: {
        format: String,
        default: '/register',
      },
      authorize: {
        format: String,
        default: '/auth',
      },
      token: {
        format: String,
        default: '/token',
      },
      decision: {
        format: String,
        default: '/decision',
      },
      login: {
        format: String,
        default: '/login',
      },
      // POST URL for OpenIDConnect domain web form
      loginConnect: {
        format: String,
        default: '/id-login',
      },
      // Redirect URL for OpenIDConnect
      redirectConnect: {
        format: String,
        default: '/id-redirect',
      },
      logout: {
        format: String,
        default: '/logout',
      },
      certs: {
        format: String,
        default: '/certs',
      },
      userinfo: {
        format: String,
        default: '/userinfo',
      },
    },
    // Views controls what name is used for the EJS template in the views/ folder for
    // various pages. For now, there's just login. In the future can also add the allow
    // page. is allows other services to override the login page itself with their
    // own custom one via docker-compose.
    views: {
      basedir: {
        format: String,
        default: '/oada/services/auth/views',
      },
      loginPage: {
        format: String,
        default: 'login',
      },
      approvePage: {
        format: String,
        default: 'approve',
      },
    },
    oauth2: {
      enable: {
        format: Boolean,
        default: true,
      },
    },
    oidc: {
      enable: {
        format: Boolean,
        default: true,
      },
    },
    dynamicRegistration: {
      softwareStatement: {
        require: {
          description:
            'Whether to require all clients send a software_statement to register',
          format: Boolean,
          default: false,
        },
        mustTrust: {
          description:
            'Whether to outright reject clients with untrusted software_statement',
          format: Boolean,
          default: false,
        },
        mustInclude: {
          description: 'List of field that any software_statement must include',
          format: Array,
          default: ['software_id'],
        },
      },
      trustedListLookupTimeout: {
        format: 'duration',
        default: 5000,
      },
    },
    code: {
      length: {
        format: 'nat',
        default: 25,
      },
      expiresIn: {
        format: 'duration',
        default: 10,
      },
    },
    token: {
      length: {
        format: 'nat',
        default: 40,
      },
      expiresIn: {
        format: 'duration',
        default: 0,
      },
    },
    idToken: {
      expiresIn: {
        format: 'duration',
        default: 0,
      },
      signKid: {
        format: String,
        default: 'kjcScjc32dwJXXLJDs3r124sa1',
      },
    },
    certs: {
      // If you want to run in https mode you need certs here.
      key: {
        // Default: fs.readFileSync(path.join(__dirname, 'certs/ssl/server.key')),
        default: null,
      },
      cert: {
        // Default: fs.readFileSync(path.join(__dirname, 'certs/ssl/server.crt')),
        default: null,
      },
      ca: {
        // Default: fs.readFileSync(path.join(__dirname, 'certs/ssl/ca.crt')),
        default: null,
      },
      requestCrt: {
        format: Boolean,
        default: true,
      },
      rejectUnauthorized: {
        format: Boolean,
        default: true,
      },
    },
    keys: {
      signPems: {
        default: path.join(
          path.dirname(url.fileURLToPath(import.meta.url)),
          '..',
          'certs',
          'sign'
        ),
      },
    },
    datastoresDriver: {
      format: await fs.readdir(
        path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'db')
      ),
      default: 'flat',
    },
    hint: {
      username: {
        format: String,
        default: 'frank',
      },
      password: {
        format: String,
        sensitive: true,
        default: 'test',
      },
    },
    init: {
      format: String,
      default: '',
    },
  },
});

// Set port default based on mode?
// eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
// @ts-ignore
if (config.get('auth.server.port') === null) {
  switch (config.get('auth.server.mode')) {
    case 'https':
      config.set('auth.server.port', 443);
      break;
    case 'http':
      config.set('auth.server.port', 80);
      break;
    default:
      throw new TypeError(`Unknown mode: ${config.get('auth.server.mode')}`);
  }
}

// If there is an endpointsPrefix, update all the endpoints to include the
// prefix before doing anything else
const pfx = config.get('auth.endpointsPrefix');
if (typeof pfx === 'string') {
  trace('Adding supplied prefix %s to all endpoints', pfx);
  const endpoints = config.get('auth.endpoints');
  for (const [k, v] of Object.entries(endpoints)) {
    config.set(`auth.endpoints.${k}`, path.join(pfx, v));
  }
}

// -----------------------------------------------------------------------
// Load all the domain configs at startup
const domainsDirectory = config.get('domainsDir');
trace('using domainsDir = %s', domainsDirectory);
export const domainConfigs: Map<string, DomainConfig> = new Map();
export interface DomainConfig {
  domain: string;
  baseuri: string;
  name?: string;
  logo?: string;
  tagline?: string;
  color?: string;
  hint?: unknown;
  idService?: {
    shortname: string;
    longname: string;
  };
  software_statement?: string;
  keys: {
    private: jwku.JWK;
  };
}
for await (const dirname of await fs.readdir(domainsDirectory)) {
  if (dirname.startsWith('.')) {
    continue;
  }

  const fname = path.join(domainsDirectory, dirname, 'config');
  for await (const extensions of ['js', 'mjs', 'cjs'] as const) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { default: dConfig } = await import(`${fname}.${extensions}`); // Nosemgrep: javascript.lang.security.detect-non-literal-require.detect-non-literal-require
      domainConfigs.set(dConfig.domain, dConfig);
      break;
    } catch (cError: unknown) {
      error(
        { error: cError },
        `Could not read config for domain ${dirname}, skipping`
      );
    }
  }
}

const publicUri = config.get('auth.server.publicUri')
  ? // eslint-disable-next-line @typescript-eslint/no-base-to-string
    new URI(config.get('auth.server.publicUri')).normalize().toString()
  : // eslint-disable-next-line @typescript-eslint/no-base-to-string
    new URI()
      .hostname(config.get('auth.server.domain'))
      .port(`${config.get('auth.server.port')}`)
      .protocol(config.get('auth.server.mode'))
      .normalize()
      .toString();
config.set('auth.server.publicUri', publicUri);
