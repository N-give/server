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

'use strict';

module.exports = {
    kafka: {
        healthInterval: 5 * 60 * 1000, // ms
        producer: {
            pollInterval: 500, // ms
        },
        broker: 'kafka',
        // https://github.com/edenhill/librdkafka/blob/master/CONFIGURATION.md
        librdkafka: {
            'enable.auto.commit': false,
            'auto.offset.reset': 'latest',
            // Needed to lower latency
            'fetch.wait.max.ms': 10,
            'fetch.error.backoff.ms': 10,
            //'fetch.min.bytes': 1,
            'request.required.acks': 0,
            'socket.blocking.max.ms': 10,
            'queue.buffering.max.ms': 5,
        },
        timeouts: {
            default: 5000,
            writeRequest: 45000,
            websocketsRequest: Infinity,
        },
        topics: {
            tokenRequest: 'token_request',
            graphRequest: 'graph_request',
            writeRequest: 'write_request',
            websocketsRequest: 'websockets_request',
            permissionsRequest: 'permissions_request',
            permissionsResponse: 'permissions_response',
            httpResponse: 'http_response',
        },
    },
};
