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
 )* limitations under the License.
 */

import debug from 'debug';
import { expect } from 'chai';
import randomstring from 'randomstring';

import { Requester } from '@oada/lib-kafka';
import { init } from '@oada/lib-arangodb';
import type { WriteRequest } from '@oada/write-handler';

import revGraphUpdate from '../';
import config from '../src/config';

const trace = debug('trace:rev-graph-update#test');

const requester = new Requester({
  consumeTopic: config.get('kafka.topics.httpResponse'),
  produceTopic: config.get('kafka.topics.writeRequest'),
  group: 'rev-graph-update-test',
});

describe('rev graph update service', () => {
  before(init.run);
  before(function waitKafka(done) {
    requester.on('ready', () => {
      done();
    });
  });

  // --------------------------------------------------
  // The tests!
  // --------------------------------------------------
  describe('.rev-graph-update', () => {
    it('should be able to produce a correct write_request message', async (done) => {
      // Make http_response message
      const r = {
        msgtype: 'write-response',
        code: 'success',
        resource_id: '/resources:default:resources_rock_123',
        connection_id: `123abc${randomstring.generate(7)}`,
        _rev: randomstring.generate(7),
        doc: {
          user_id: `franko123${randomstring.generate(7)}`,
        },
        authorizationid: `tuco123${randomstring.generate(7)}`,
      };

      console.log('http_response message is:', r);

      // Now produce the message:
      // create the listener:

      const message = (await requester.send(r)) as WriteRequest;
      trace('received message: ', message);
      // @ts-expect-error
      expect(message.type).to.equal('write_request');
      expect(message.path_leftover).to.equal('/rocks-index/90j2klfdjss/_rev');
      expect(message.resource_id).to.equal(
        'resources/default:resources_rocks_123'
      );
      expect(message.contentType).to.equal('application/vnd.oada.rocks.1+json');
      expect(message.user_id).to.equal(r.doc.user_id);
      expect(message.authorizationid).to.equal(r.authorizationid);
      expect(message.body).to.equal(r._rev);
      // @ts-expect-error
      expect(message.connection_id).to.equal(r.connection_id);
      // @ts-expect-error
      expect(message.url).to.equal('');

      done();
    }).timeout(10_000);
  });

  // -------------------------------------------------------
  // After tests are done, get rid of our temp database
  // -------------------------------------------------------
  after(init.cleanup);
  after(function rdis() {
    this.timeout(10_000);
    requester.disconnect();
  });
  after(function revDis() {
    this.timeout(10_000);
    revGraphUpdate.stopResp();
  });
});
