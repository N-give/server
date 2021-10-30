/**
 * @license
 * Copyright 2017-2021 Open Ag Data Alliance
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

'use strict';

const cloneDeep = require('clone-deep');
const codes = require('./codes.json');

function findByCode(code, callback) {
  callback(null, cloneDeep(codes[code]));
}

function save(code, callback) {
  codes[code.code] = JSON.parse(JSON.stringify(code));

  findByCode(code.code, callback);
}

module.exports = {
  findByCode,
  save,
};
