/* Copyright 2021 Open Ag Data Alliance
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

export { db as arango } from './db';

export * as init from './init';
export * as users from './libs/users';
export * as resources from './libs/resources';
export * as changes from './libs/changes';
export * as remoteResources from './libs/remoteResources';
export * as clients from './libs/clients';
export * as codes from './libs/codes';
export * as authorizations from './libs/authorizations';
export * as putBodies from './libs/putBodies';

// call examples('resources') to get the list of example resources, etc.
export function examples(collectionName: string) {
  return require('./libs/exampledocs/' + collectionName);
}
