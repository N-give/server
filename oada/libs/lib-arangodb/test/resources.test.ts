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

import test from 'ava';

import { init, resources } from '../';

test.before(async () => init.run());

test('should find parents based on resource id', async (t) => {
  const p = await resources.getParents('/resources:default:resources_rock_123');
  t.is(p?.[0]?.path, '/rocks-index/90j2klfdjss');
  t.is(p?.[0]?.resource_id, 'resources/default:resources_rocks_123');
  t.is(p?.[0]?.contentType, 'application/vnd.oada.rocks.1+json');
});

test.after(async () => init.cleanup());
