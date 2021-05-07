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

import Bluebird from 'bluebird';
import { aql } from 'arangojs';
import debug from 'debug';
import cloneDeep from 'clone-deep';
import pointer from 'json-pointer';

import type { Link } from '@oada/types/oada/link/v1';
import type { Resource } from '@oada/types/oada/resource';

import { db } from '../db';
import * as util from '../util';
import * as users from './users';

import config from '../config';

const info = debug('arangodb#resources:info');
const trace = debug('arangodb#resources:trace');

const resources = db.collection(
  config.get('arangodb:collections:resources:name')
);
const graphNodes = db.collection(
  config.get('arangodb:collections:graphNodes:name')
);
const edges = db.collection(config.get('arangodb:collections:edges:name'));

const MAX_DEPTH = 100; // TODO: Is this good?

export interface Permission {
  type: string;
  owner: boolean;
  read: boolean;
  write: boolean;
}

export async function lookupFromUrl(url: string, userId: string) {
  const user = await users.findById(userId);
  if (!user) {
    throw 'No User Found for given userId';
  }
  if (/^\/bookmarks/.test(url)) {
    url = url.replace(/^\/bookmarks/, '/' + user.bookmarks._id);
  }
  if (/^\/shares/.test(url)) {
    url = url.replace(/^\/shares/, '/' + user.shares._id);
  }

  //    trace(userId);
  const pieces = pointer.parse(url);
  // resources/123 => graphNodes/resources:123
  const startNode = graphNodes.name + '/' + pieces[0] + ':' + pieces[1];
  const id = pieces.splice(0, 2);
  // Create a filter for each segment of the url
  let filters = aql``;
  for (const [i, urlPiece] of Object.entries(pieces)) {
    filters = aql`
      ${filters}
      FILTER p.edges[${i}].name == ${urlPiece} || p.edges[${i}].name == null`;
  }
  const query = aql`
    WITH ${edges}, ${graphNodes}
    LET path = LAST(
      FOR v, e, p IN 0..${pieces.length} OUTBOUND ${startNode} ${edges}
        ${filters}
        RETURN p
    )
    LET resources = DOCUMENT(path.vertices[*].resource_id)
    LET type = null
    LET permissions = (
      FOR r IN resources
      RETURN {
        type: r._type || type,
        owner: r._meta._owner == ${userId} || r._meta._permissions[${userId}].owner,
        read: r._meta._owner == ${userId} || r._meta._permissions[${userId}].read,
        write: r._meta._owner == ${userId} || r._meta._permissions[${userId}].write
      }
    )
    LET rev = DOCUMENT(LAST(path.vertices).resource_id)._oada_rev
    RETURN MERGE(path, {permissions, rev, type})`;

  trace('Query: %s', query);
  const result: {
    rev: number;
    type: string | null;
    permissions: Permission[];
    vertices:
      | Array<{ resource_id: string; is_resource: boolean; path?: string }>
      | [null];
    edges:
      | Array<{ _to: string; _from: string; name: string; versioned: boolean }>
      | [null];
  } = await (await db.query(query)).next();

  // Get rid of leading slash from json pointer
  let resource_id = pointer.compile(id.concat(pieces)).replace(/^\//, '');

  let { rev, type } = result;
  let resourceExists = true;

  let path_leftover = '';
  let from = { resource_id: '', path_leftover: '' };

  if (!result) {
    trace('1 return resource id %s', resource_id);
    return {
      resource_id,
      path_leftover,
      from,
      permissions: {},
      rev,
      type,
    };
  }

  // Walk up and find the graph and return furthest known permissions (and
  // type)
  let permissions: {
    owner: boolean | null;
    read: boolean | null;
    write: boolean | null;
    type: string | null;
  } = {
    owner: null,
    read: null,
    write: null,
    type: null,
  };
  result.permissions.reverse().some((p) => {
    if (p) {
      if (permissions.read === null) {
        permissions.read = p.read;
      }
      if (permissions.write === null) {
        permissions.write = p.write;
      }
      if (permissions.owner === null) {
        permissions.owner = p.owner;
      }
      if (permissions.type === null) {
        permissions.type = p.type;
      }
      if (
        permissions.read !== null &&
        permissions.write !== null &&
        permissions.owner !== null &&
        permissions.type !== null
      ) {
        return true;
      }
    }
  });
  type = permissions.type;

  // Check for a traversal that did not finish (aka not found)
  if (result.vertices[0] === null) {
    trace('graph-lookup traversal did not finish');
    trace('2 return resource id %s', resource_id);

    return {
      resource_id,
      path_leftover,
      from,
      permissions,
      rev,
      type,
      resourceExists: false,
    };
    // A dangling edge indicates uncreated resource; return graph lookup
    // starting at this uncreated resource
  } else if (!result.vertices[result.vertices.length - 1]) {
    const lastEdge = result.edges[result.edges.length - 1]!._to;
    path_leftover = '';
    resource_id = 'resources/' + lastEdge.split('graphNodes/resources:')[1];
    trace('graph-lookup traversal uncreated resource %s', resource_id);
    rev = 0;
    const fromv = result.vertices[result.vertices.length - 2]!;
    const edge = result.edges[result.edges.length - 1];
    from = {
      resource_id: from ? from['resource_id'] : '',
      path_leftover:
        ((fromv && fromv['path']) || '') + (edge ? '/' + edge.name : ''),
    };
    resourceExists = false;
  } else {
    resource_id = result.vertices[result.vertices.length - 1]!['resource_id'];
    trace('graph-lookup traversal found resource %s', resource_id);
    const fromv = result.vertices[result.vertices.length - 2]!;
    let edge = result.edges[result.edges.length - 1];
    // If the desired url has more pieces than the longest path, the
    // pathLeftover is the extra pieces
    if (result.vertices.length - 1 < pieces.length) {
      let revVertices = cloneDeep(result.vertices).reverse();
      let lastResource =
        result.vertices.length -
        1 -
        // @ts-ignore
        revVertices.findIndex((v) => v.is_resource);
      // Slice a negative value to take the last n pieces of the array
      path_leftover = pointer.compile(
        pieces.slice(lastResource - pieces.length)
      );
    } else {
      path_leftover = result.vertices[result.vertices.length - 1]!.path || '';
    }
    from = {
      resource_id: fromv ? fromv['resource_id'] : '',
      path_leftover:
        ((fromv && fromv['path']) || '') + (edge ? '/' + edge.name : ''),
    };
  }

  return {
    type,
    rev,
    resource_id,
    path_leftover,
    permissions,
    from,
    resourceExists,
  };
}

export function getResource(
  id: string,
  path: string = ''
): Promise<Partial<Resource>> {
  // TODO: Escaping stuff?
  const parts = path.split('/').filter((x) => !!x);

  if (parts[0] === '_rev') {
    // Get OADA rev, not arango one
    parts[0] = '_oada_rev';
  }

  const bindVars = parts.reduce<Record<string, string>>((b, part, i) => {
    b[`v${i}`] = part;
    return b;
  }, {});
  bindVars.id = id;
  bindVars['@collection'] = resources.name;

  const returnPath = parts.reduce((p, _, i) => p.concat(`[@v${i}]`), '');

  return Bluebird.resolve(
    db.query({
      // TODO: Fix this thing to use aql...
      query: `
        WITH ${resources.name}
        FOR r IN @@collection
          FILTER r._id == @id
          RETURN r${returnPath}`,
      bindVars,
    })
  )
    .then((result) => result.next())
    .then(util.sanitizeResult)
    .catch(
      {
        isArangoError: true,
        errorMessage: 'invalid traversal depth (while instantiating plan)',
      },
      () => null
    ); // Treat non-existing path has not-found
}

export async function getResourceOwnerIdRev(
  id: string
): Promise<{ _rev: number; _id: string; _meta: { _owner: string } }> {
  return Bluebird.resolve(
    db.query(aql`
      WITH ${resources}
      FOR r IN ${resources}
        FILTER r._id == ${id}
        RETURN {
          _rev: r._oada_rev,
          _id: r._id,
          _meta: { _owner: r._meta._owner }
        }`)
  )
    .then((result) => result.next())
    .then((obj) => {
      trace('getResourceOwnerIdRev(%s): result = %O', id, obj);
      return obj;
    })
    .catch(
      {
        isArangoError: true,
        errorMessage: 'invalid traversal depth (while instantiating plan)',
      },
      () => null
    ); // Treat non-existing path has not-found
}

export async function getParents(
  id: string
): Promise<Array<{
  resource_id: string;
  path: string;
  contentType: string;
}> | null> {
  return await Bluebird.resolve(
    db.query(
      aql`
        WITH ${edges}, ${graphNodes}, ${resources}
        FOR v, e IN 0..1
          INBOUND ${'graphNodes/' + id.replace(/\//, ':')}
          ${edges}
          FILTER e.versioned == true
          LET res = DOCUMENT(v.resource_id)
          RETURN {
            resource_id: v.resource_id,
            path: CONCAT(v.path || '', '/', e.name),
            contentType: res._type
          }`
    )
  )
    .call('all')
    .catch(
      {
        isArangoError: true,
        errorMessage: 'invalid traversal depth (while instantiating plan)',
      },
      () => null
    ); // Treat non-existing path has not-found
}

export async function getNewDescendants(id: string, rev: string | number) {
  // TODO: Better way to compare the revs?
  return (await (
    await db.query(
      aql`
        WITH ${graphNodes}, ${edges}, ${resources}
        LET node = FIRST(
          FOR node in ${graphNodes}
            FILTER node.resource_id == ${id}
            RETURN node
        )

        FOR v, e, p IN 0..${MAX_DEPTH} OUTBOUND node ${edges}
          FILTER p.edges[*].versioned ALL == true
          FILTER v.is_resource
          LET ver = SPLIT(DOCUMENT(LAST(p.vertices).resource_id)._oada_rev, '-', 1)
          // FILTER TO_NUMBER(ver) >= ${parseInt(rev as string, 10)}
          RETURN DISTINCT {
            id: v.resource_id,
            changed: TO_NUMBER(ver) >= ${parseInt(rev as string, 10)}
          }`
    )
  ).all()) as Array<{ id: string; changed: boolean }>;
}

export async function getChanges(id: string, rev: string | number) {
  // Currently utilizes fixed depth search "7..7" to get data points down
  return (await (
    await db.query(
      aql`
        WITH ${graphNodes}, ${edges}, ${resources}
        LET node = FIRST(
          FOR node in ${graphNodes}
            FILTER node.resource_id == ${id}
            RETURN node
        )

        LET objs = (FOR v, e, p IN 7..7 OUTBOUND node ${edges}
          FILTER v.is_resource
          LET ver = SPLIT(DOCUMENT(v.resource_id)._oada_rev, '-', 1)
          FILTER TO_NUMBER(ver) >= ${parseInt(rev as string, 10)}
          RETURN DISTINCT {
            id: v.resource_id,
            rev: DOCUMENT(v.resource_id)._oada_rev
          }
        )
        FOR obj in objs
          LET doc = DOCUMENT(obj.id)
          RETURN {id: obj.id, changes: doc._meta._changes[obj.rev]}`
    )
  ).all()) as Array<{ id: string; changes: string }>;
}

export async function putResource(
  id: string,
  obj: any,
  checkLinks: boolean = true
) {
  // Fix rev
  obj['_oada_rev'] = obj['_rev'];
  obj['_rev'] = undefined;

  // TODO: Sanitize OADA keys?
  // _key is now an illegal document key
  obj['_key'] = id.replace(/^\/?resources\//, '');
  trace(`Adding links for resource ${id}...`);

  const links = checkLinks ? await addLinks(obj) : [];
  info(`Upserting resource ${obj._key}`);
  trace('Upserting links: %O', links);

  // TODO: Should it check that graphNodes exist but are wrong?
  var q;
  if (links.length > 0) {
    let thingy = aql`
      LET reskey = ${obj['_key']}
      LET resup = FIRST(
        LET res = ${obj}
        UPSERT { '_key': reskey }
        INSERT res
        UPDATE res
        IN ${resources}
        RETURN { res: NEW, orev: OLD._oada_rev }
      )
      LET res = resup.res
      FOR l IN ${links}
        LET lkey = SUBSTRING(l._id, LENGTH('resources/'))
        LET nodeids = FIRST(
          LET nodeids = (
            LET nodeids = APPEND([reskey], SLICE(l.path, 0, -1))
            FOR i IN 1..LENGTH(nodeids)
              LET path = CONCAT_SEPARATOR(':', SLICE(nodeids, 0, i))
              RETURN CONCAT('resources:', path)
          )
          LET end = CONCAT('resources:', lkey)
          RETURN APPEND(nodeids, [end])
        )
        LET nodes = APPEND((
          FOR i IN 0..(LENGTH(l.path)-1)
            LET isresource = i IN [0, LENGTH(l.path)]
            LET ppath = SLICE(l.path, 0, i)
            LET resid = i == LENGTH(l.path) ? lkey : reskey
            LET path = isresource ? null
                : CONCAT_SEPARATOR('/', APPEND([''], ppath))
            UPSERT { '_key': nodeids[i] }
            INSERT {
              '_key': nodeids[i],
              'is_resource': isresource,
              'path': path,
              'resource_id': res._id
            }
            UPDATE {}
            IN ${graphNodes}
            OPTIONS { ignoreErrors: true }
            RETURN NEW
        ), { _id: CONCAT('graphNodes/', LAST(nodeids)), is_resource: true })
        LET edges = (
          FOR i IN 0..(LENGTH(l.path)-1)
            UPSERT {
              '_from': nodes[i]._id,
              'name': l.path[i]
            }
            INSERT {
              '_from': nodes[i]._id,
              '_to': nodes[i+1]._id,
              'name': l.path[i],
              'versioned': nodes[i+1].is_resource && HAS(l, '_rev')
            }
            UPDATE {
              '_to': nodes[i+1]._id,
              'versioned': nodes[i+1].is_resource && HAS(l, '_rev')
            }
            IN ${edges}
            RETURN NEW
        )
        RETURN resup.orev`;

    q = await db.query(thingy);
  } else {
    q = await db.query(aql`
      LET resup = FIRST(
        LET res = ${obj}
        UPSERT { '_key': res._key }
        INSERT res
        UPDATE res
        IN ${resources}
        return { res: NEW, orev: OLD._oada_rev }
      )
      LET res = resup.res
      LET nodekey = CONCAT('resources:', res._key)
      UPSERT { '_key': nodekey }
      INSERT {
        '_key': nodekey,
        'is_resource': true,
        'resource_id': res._id
      }
      UPDATE {}
      IN ${graphNodes}
      OPTIONS {exclusive: true, ignoreErrors: true }
      RETURN resup.orev`);
  }

  return (await q.next()) as number;
}

async function forLinks(
  res: any,
  cb: (link: Link, path: readonly string[]) => void | Promise<void>,
  path: string[] = []
): Promise<void> {
  await Bluebird.map(Object.keys(res), async (key) => {
    if (res[key] && res[key].hasOwnProperty('_id') && key !== '_meta') {
      // If it has _id and is not _meta, treat as a link
      return await cb(res[key], path.concat(key));
    } else if (typeof res[key] === 'object' && res[key] !== null) {
      return await forLinks(res[key], cb, path.concat(key));
    }
  });
}

// TODO: Remove links as well
async function addLinks(res: {}) {
  // TODO: Use fewer queries or something?
  const links: Link[] = [];

  await forLinks(res, async function processLinks(link, path) {
    // Ignore _changes "link"?
    if (path[0] === '_meta' && path[1] === '_changes') {
      return;
    }

    if (link.hasOwnProperty('_rev')) {
      const rev = await getResource(link['_id'], '_oada_rev');
      link['_rev'] = typeof rev === 'number' ? rev : 0;
    }

    links.push(Object.assign({ path }, link));
  });

  return links;
}

export async function makeRemote<T>(res: T, domain: string): Promise<T> {
  await forLinks(res, (link) => {
    // Change all links to remote links
    link['_rid'] = link['_id'];
    link['_rrev'] = link['_rev'];
    // @ts-ignore
    delete link['_id'];
    delete link['_rev'];
    link['_rdomain'] = domain;
  });

  return res;
}

export async function deleteResource(id: string) {
  //TODO: fix this: for some reason, the id that came in started with
  ///resources, unlike everywhere else in this file
  const key = id.replace(/^\/?resources\//, '');

  // Query deletes resouce, its nodes, and outgoing edges (but not incoming)
  return (await (
    await db.query(
      aql`
        LET res = FIRST(
          REMOVE { '_key': ${key} } IN ${resources}
          RETURN OLD
        )
        LET nodes = (
          FOR node in ${graphNodes}
            FILTER node['resource_id'] == res._id
            REMOVE node IN ${graphNodes}
            RETURN OLD
        )
        LET edges = (
          FOR node IN nodes
            FOR edge IN ${edges}
              FILTER edge['_from'] == node._id
              REMOVE edge IN ${edges}
        )
        RETURN res._oada_rev`
    )
  ).next()) as number;
}

/**
 * "Delete" a part of a resource
 */
export async function deletePartialResource(
  id: string,
  path: string | string[],
  doc: Partial<Resource> = {}
) {
  const key = id.replace(/^resources\//, '');
  const apath = Array.isArray(path) ? path : pointer.parse(path);

  // TODO: Less gross way to check existence of JSON pointer in AQL??
  let pathA = apath.slice(0, apath.length - 1).join("']['");
  pathA = pathA ? "['" + pathA + "']" : pathA;
  const pathB = apath[apath.length - 1];
  const stringA = `(res${pathA}, '${pathB}')`;
  const hasStr = `HAS${stringA}`;

  const rev = doc['_rev'];
  pointer.set(doc, path as string, null);

  const name = apath.pop();
  const spath = pointer.compile(apath) || null;
  const hasObj = (await (
    await db.query({
      query: `
        LET res = DOCUMENT(${resources.name}, '${key}')
        LET has = ${hasStr}

        RETURN {has, rev: res._oada_rev}`,
      bindVars: {},
    })
  ).next()) as { has: boolean; rev: number };
  if (hasObj.has) {
    // TODO: Why the heck does arango error if I update resource before graph?
    return (await (
      await db.query(
        aql`
          LET start = FIRST(
            FOR node IN ${graphNodes}
              LET path = node.path || null
              FILTER node['resource_id'] == ${id} AND path == ${spath || null}
              RETURN node
          )

          LET v = (
            FOR v, e, p IN 1..${MAX_DEPTH} OUTBOUND start ${edges}
              OPTIONS { bfs: true, uniqueVertices: 'global' }
              FILTER p.edges[0].name == ${name}
              FILTER p.vertices[*].resource_id ALL == ${id}
              REMOVE v IN ${graphNodes}
              RETURN OLD
          )

          LET e = (
            FOR edge IN ${edges}
              FILTER (v[*]._id ANY == edge._to) || (v[*]._id ANY == edge._from) || (edge._from == start._id && edge.name == ${name})
              REMOVE edge IN ${edges}
              RETURN OLD
          )

          LET newres = MERGE_RECURSIVE(
            ${doc},
            {
              _oada_rev: ${rev},
              _meta: {_rev: ${rev}}
            }
          )

          UPDATE ${key} WITH newres IN ${resources} OPTIONS {keepNull: false}
          RETURN OLD._oada_rev`
      )
    ).next()) as number;
  } else {
    return hasObj.rev;
  }
}

// TODO: Better way to handler errors?
// ErrorNum from: https://docs.arangodb.com/2.8/ErrorCodes/
export const NotFoundError = {
  name: 'ArangoError',
  errorNum: 1202,
};
export const UniqueConstraintError = {
  name: 'ArangoError',
  errorNum: 1210,
};
