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

import cloneDeep from 'clone-deep';

import type { Client, DBClient } from '../models/client';
// @ts-expect-error IDEK
import clients from './clients.json';

export function findById(id: string) {
  return id in clients ? cloneDeep<DBClient>(clients[id]) : null;
}

export async function save(client: Client) {
  clients[client.clientId] = cloneDeep(client);
  return findById(client.clientId);
}
