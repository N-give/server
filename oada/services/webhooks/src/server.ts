/* Copyright 2017 Open Ag Data Alliance
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

import { Agent } from 'https';

import debug from 'debug';
import Bluebird from 'bluebird';

import { KafkaBase, Responder } from '@oada/lib-kafka';
import { resources, changes } from '@oada/lib-arangodb';
import type { WriteResponse } from '@oada/write-handler';

import config from './config';

const trace = debug('webhooks:trace');
const error = debug('webhooks:error');

const axios = process.env.SSL_ALLOW_SELF_SIGNED
  ? require('axios').create({
      httpsAgent: new Agent({ rejectUnauthorized: false }),
    })
  : require('axios');

//---------------------------------------------------------
// Kafka intializations:
const responder = new Responder({
  consumeTopic: config.get('kafka.topics.httpResponse'),
  group: 'webhooks',
});

export function stopResp() {
  return responder.disconnect();
}

/**
 * check for successful write request
 */
function checkReq(req: KafkaBase): req is WriteResponse {
  return req?.msgtype === 'write-response' && req?.code === 'success';
}

export interface Sync {
  'url': string;
  'headers': Record<string, string>;
  'oada-put': boolean;
}
type Syncs = Record<string, Sync>;

responder.on<void>('request', async function handleReq(req) {
  if (!checkReq(req)) {
    return;
  }

  // TODO: Add AQL query for just syncs and newest change?
  const meta = (await resources.getResource(req.resource_id, '/_meta')) as {
    _syncs?: Syncs;
    _changes: Record<number, { _id: string }>;
  };
  if (meta?._syncs) {
    return Bluebird.map(Object.keys(meta._syncs), async (sync) => {
      let url = meta._syncs![sync]!.url;
      if (process.env.NODE_ENV !== 'production') {
        /*
         * If running in dev environment,
         * https://localhost webhooks should be directed to the proxy server.
         */
        url = url.replace('localhost', 'proxy');
      }
      if (meta._syncs![sync]!['oada-put']) {
        const change = await changes.getChange(req.resource_id, req._rev);
        if (!change) {
          error('Failed to get change %d for %s', req._rev, req.resource_id);
          return;
        }

        const {
          body: { _meta, _rev, _id, _type, ...body },
        } = change;
        //If change is only to _id, _rev, _meta, or _type, don't do put
        if (Object.keys(body).length == 0) {
          return;
        }
        if (change.type === 'delete') {
          //Handle delete _changes
          const deletePath = [];
          let toDelete = body;
          trace('Sending oada-put to: %s', url);
          while (
            toDelete &&
            typeof toDelete === 'object' &&
            Object.keys(toDelete).length > 0
          ) {
            const key = Object.keys(toDelete)[0]!;
            deletePath.push(key);
            toDelete = toDelete[key];
          }
          if (toDelete !== null) {
            return;
          }
          const deleteUrl = url + '/' + deletePath.join('/');
          trace('Deleting: oada-put url changed to: %s', deleteUrl);
          return await axios({
            method: 'delete',
            url: deleteUrl,
            headers: meta._syncs![sync]!.headers,
          });
        } else {
          //Handle merge _changes
          trace('Sending oada-put to: %s', url);
          trace('oada-put body: %O', body);
          return await axios({
            method: 'put',
            url: url,
            data: body,
            headers: meta._syncs![sync]!.headers,
          });
        }
      }
      trace('Sending to: %s', url);
      return await axios(meta._syncs![sync]);
    });
  }
});