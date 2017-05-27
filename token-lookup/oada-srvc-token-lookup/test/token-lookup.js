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

'use strict';

const _ = require('lodash');
const expect = require('chai').expect;
const Promise = require('bluebird');
const bcrypt = require('bcryptjs');
const randomstring = require("randomstring");
const kf = require('kafka-node');
const oadaLib = require('../../../libs/oada-lib-arangodb');
const config = require('../config');
const debug = require('debug');
const trace = debug('trace:token-lookup#test');

// To test the token lookup, have to make a test database and populate it
// with token and user
let db = oadaLib.arango;
let cols = config.get('arango:collections');
let frankid = oadaLib.examples('users')[0]._id;

// kafka topics
const	consTopic = config.get('kafka:topics:httpResponse');
const prodTopic = config.get('kafka:topics:tokenRequest');
let client;
let consumer;
let producer;
let groupid;

describe('token lookup service', () => {
  before((done) => {
		client = new kf.Client("zookeeper:2181", "test-token_lookup");

		producer = new kf.Producer(client, {
			partitionerType: 0
    });

    const consumer = new kf.Consumer(client, [ {topic: consTopic} ], {
      autoCommit: true
    });

    producer.on('ready', done);
  });

  before(oadaLib.init.run);

  //--------------------------------------------------
  // The tests!
  //--------------------------------------------------
	describe('.token-lookup', () => {
		it('should be able to perform a token-lookup', (done) => {
			// make token_request message
			let t = {
        resp_partition: 0,
        connection_id: '123abc' + randomstring.generate(7),
        token: 'xyz'
      };

      const consumer = new kf.Consumer(client, [ {topic: consTopic} ], {
        autoCommit: true
      });

      consumer.on('error', err => { throw err } );
      // create the listener:
      consumer.on('message', msg => {
        const httpMsg = JSON.parse(msg.value);

        trace('received message: ', httpMsg);
        expect(httpMsg.type).to.equal('http_response')
        expect(httpMsg.token).to.equal('xyz');
        expect(httpMsg.token_exists).is.ok;
        expect(httpMsg.partition).to.equal(0);
        expect(httpMsg.connection_id).to.equal('123abc');
        expect(httpMsg.doc.authorizationid).to.equal(oadaLib.examples('authorizations')[0]._id);
        expect(httpMsg.doc.user_id).to.equal(frankid);
        expect(httpMsg.doc.scope).to.be.instanceof(Array);
        expect(httpMsg.doc.scope).to.be.empty;
        expect(httpMsg.doc.bookmarksid).to.equal('resources/default:resources_bookmarks_123');
        expect(httpMsg.doc.clientid).to.equal('jf93caauf3uzud7f308faesf3@provider.oada-dev.com');
       
        // the "true" forces commit before close
        consumer.close(true, () => {
          done()
        });
      });

      // now produce the message:
      producer.send([{topic: prodTopic, messages: JSON.stringify(t)}], (a) => {
        console.log('message produced, awaiting response')
      });
    });

		it('should error when token does not exist', (done) => {
			let t = {
        resp_partition: 0,
        connection_id: 'abc123',
        token: 'not-valid'
      };


      const consumer = new kf.Consumer(client, [ {topic: consTopic} ], {
        autoCommit: true
      });
      consumer.on('error', err => { throw err } );
      // create the listener:
      consumer.on('message', msg => {
        const httpMsg = JSON.parse(msg.value);

        expect(httpMsg.type).to.equal('http_response')
        expect(httpMsg.token).to.equal('not-valid');
        expect(httpMsg.token_exists).is.not.ok;
        expect(httpMsg.partition).to.equal(0);
        expect(httpMsg.connection_id).to.equal('abc123')
        expect(httpMsg.doc.authorizationid).to.equal(null);
        expect(httpMsg.doc.user_id).to.equal(null);
        expect(httpMsg.doc.scope).to.be.instanceof(Array);
        expect(httpMsg.doc.scope).to.be.empty;
        expect(httpMsg.doc.bookmarksid).to.equal(null);
        expect(httpMsg.doc.clientid).to.equal(null);

        consumer.close(() => {
          done();
        });
      });

      producer.send([{topic: prodTopic, messages: JSON.stringify(t)}], (a) => { console.log('2nd message produced, awaiting response'); });
    });
	});

  //-------------------------------------------------------
  // After tests are done, get rid of our temp database
  //-------------------------------------------------------
  //after(oadaLib.init.cleanup);
});
