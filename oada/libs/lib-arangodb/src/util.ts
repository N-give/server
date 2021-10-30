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

/**
 * @todo clean up this mess
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export function sanitizeResult<T extends {}>(
  result: T
): Omit<T & { _rev?: number }, '_key' | '_oada_rev'> {
  if (!(result && typeof result === 'object')) {
    // @ts-expect-error
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { _key, _oada_rev, ...rest } = result as {
    _key?: string;
    _rev?: number;
    _oada_rev?: number;
  };

  return { ...rest, _rev: _oada_rev } as unknown as Omit<
    T & { _rev?: number },
    '_key' | '_oada_rev'
  >;
}
