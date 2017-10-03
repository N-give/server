'use strict';

const db = require('../db');
const debug = require('debug');
const info = debug('arangodb#resources:info');
const trace = debug('arangodb#resources:trace');
const _ = require('lodash');
var Promise = require('bluebird');
const aql = require('arangojs').aqlQuery;
const pointer = require('json-pointer');
const config = require('../config');
const util = require('../util');
config.set('isTest', true);
const resources =
    db.collection(config.get('arangodb:collections:resources:name'));
const graphNodes =
    db.collection(config.get('arangodb:collections:graphNodes:name'));
const edges =
    db.collection(config.get('arangodb:collections:edges:name'));

const MAX_DEPTH = 100; // TODO: Is this good?

function lookupFromUrl(url, userId) {
  return Promise.try(() => {
    trace(userId);
    let pieces = pointer.parse(url);
    // resources/123 => graphNodes/resources:123
    var startNode = graphNodes.name + '/' + pieces[0] + ':' + pieces[1];
    let id = pieces.splice(0, 2);
    // Create a filter for each segment of the url
    const filters = pieces.map((urlPiece, i) => {
      return `FILTER p.edges[${i}].name == '${urlPiece}' || p.edges[${i}].name == null`;
    }).join(' ');
    let query = `
      LET path = LAST(
        FOR v, e, p IN 0..${pieces.length}
          OUTBOUND '${startNode}'
          ${edges.name}
          ${filters}
          RETURN p
      )
      LET resources = DOCUMENT(path.vertices[*].resource_id)
      RETURN MERGE(path, {permissions:
      resources[*]._meta._permissions['${userId}']})
    `;
    trace(`lookupFromUrl(${url})`, `running query: ${query}`);
    return db.query({query}).call('next').then((result) => {

      trace('query result = ', JSON.stringify(result, false, '  '));
      let resourceId = '';
      let pathLeftover = pointer.compile(id.concat(pieces));
      // Also return info about parent?
      let from = {'resource_id': '', 'path_leftover': ''};

      if (!result) {
        trace('lookupFromUrl(' + url + '): result path length < 1');
        return {'resource_id': resourceId, 'path_leftover': pathLeftover,
          from, permissions: {}};
      }

      let permissions = {};
      result.permissions.reverse().some(p => {
        if (p) {
          if (permissions.read === undefined) {
            permissions.read = p.read;
          }
          if (permissions.write === undefined) {
            permissions.write = p.write;
          }
          if (permissions.owner === undefined) {
            permissions.owner = p.owner;
          }
          if (permissions.read !== undefined &&
              permissions.write !== undefined &&
              permissions.owner !== undefined) {
            return true;
          }
        }
      });

      // Check for a traversal that did not finish (aka not found)
      if (result.vertices[0] === null) {
        trace('lookupFromUrl(' + url + '):', 'result.vertices[0] === null');
        return {'resource_id': resourceId, 'path_leftover': pathLeftover,
          from, permissions};
      }

      trace('longest path has ' + result.vertices.length + ' vertices');
      if (!result.vertices[result.vertices.length - 1]) {
        //TODO: fix this wierd edge case...I'm not quite sure why it occurs
        trace('THIS WIERD EDGE CASE')
        resourceId = result.vertices[result.vertices.length -2]['resource_id']
          /*
        pathLeftover = result.edges[result.edges.length - 1]._to
            .replace(/^graphNodes\//, '/')
            .replace(/resources:/, 'resources/');
            */
        let lastResource = (result.vertices.length - 1) -
            (_.findIndex(_.reverse(result.vertices), 'is_resource'));
        // Slice a negative value to take the last n pieces of the array
        pathLeftover =
            pointer.compile(pieces.slice(lastResource - pieces.length));

        return {'resource_id': resourceId, 'path_leftover': pathLeftover,
          from, permissions};
      }
      resourceId = result.vertices[result.vertices.length - 1]['resource_id'];
      from = result.vertices[result.vertices.length - 2];
      let edge = result.edges[result.edges.length - 1];
      // If the desired url has more pieces than the longest path, the
      // pathLeftover is the extra pieces
      if (result.vertices.length - 1 < pieces.length) {
        trace('lookupFromUrl(' + url + '):',
            'more URL pieces than vertices, computing path');
        let lastResource = (result.vertices.length - 1) -
            (_.findIndex(_.reverse(result.vertices), 'is_resource'));
        // Slice a negative value to take the last n pieces of the array
        pathLeftover =
            pointer.compile(pieces.slice(lastResource - pieces.length));
      } else {
        trace('lookupFromUrl(' + url + '):',
            'same number URL pieces as vertices, path is on graphNode');
        pathLeftover = result.vertices[result.vertices.length - 1].path || '';
      }

      return {
        'resource_id': resourceId,
        'path_leftover': pathLeftover,
        permissions,
        'from': {
          'resource_id': from ? from['resource_id'] : '',
          'path_leftover': (from && from['path'] || '') + (edge ? '/' + edge.name : '')
        }
      };
    });
  });
}

function getResource(id, path) {
  // TODO: Escaping stuff?
  const parts = (path || '')
    .split('/')
    .filter(x => !!x);

  let bindVars = parts.reduce((b, part, i) => {
    b[`v${i}`] = part;
    return b;
  }, {});
  bindVars.id = id;
  bindVars['@collection'] = resources.name;

  const returnPath = parts.reduce((p, part, i) => p.concat(`[@v${i}]`), '');

  return db.query({
    query: `FOR r IN @@collection
        FILTER r._id == @id
        RETURN r${returnPath}`,
    bindVars
  }).then(result => result.next())
  .then(util.sanitizeResult)
  .catch({
      isArangoError: true,
      errorMessage: 'invalid traversal depth (while instantiating plan)'
    },
    () => null); // Treat non-existing path has not-found
}

function getResourceOwnerIdRev(id) {
  return db.query({
    query: `
      FOR r IN @@collection
        FILTER r._id == @id
        RETURN {
          _rev: r._oada_rev,
          _id: r._id,
          _meta: { _owner: r._meta._owner }
        }
    `,
    bindVars: {
      id,
      '@collection': resources.name
    } // bind id to @id
  }).then(result => result.next())
  .then(obj => {
    trace('getResourceOwnerIdRev(' + id + '): result = ', obj);
    return obj;
  }).catch({
      isArangoError: true,
      errorMessage: 'invalid traversal depth (while instantiating plan)'
    },
    () => null
  ); // Treat non-existing path has not-found
}

function getParents(id) {
  let collection = graphNodes.name;
  if (!id.match(/^\//)) {
    // if no leading slash on resourceid, add it to graphNodes
    collection += '/';
  }

  let bindVars = {
    // have to take out the slash on resources/ for arango to allow as key
    'id': collection + id.replace(/resources\//, 'resources:'),
    '@edges': edges.name
  };

  let parents = [];
  let parent = {
    'resource_id': null,
    'path': null,
    'contentType': null
  };

  let parentQuery = `FOR v, e IN 0..1
      INBOUND @id
      @@edges
      FILTER e.versioned == true
      RETURN {v:v, e:e}`;

  return db.query({
    query: parentQuery,
    bindVars
  })
  .then((cursor) => {
    let i = 0;

    // console.log(cursor._result);
    let length = cursor._result.length;
    trace('getParents' + '(' + id + ')' + ' parents length is ' + length);

    for (i = 0; i < length; i++) {
      parent['resource_id'] = cursor._result[i].v['resource_id'];
      let path = cursor._result[i].v.path;
      if (!path) {
        path = '';
      }
      parent.path = path + '/' + cursor._result[i].e.name;
      parents.splice(i, 0, parent);
    }

    return Promise.map(parents, parent => {
      return db.query(aql`
        FOR r in resources
        FILTER r._id == ${parent['resource_id']}
        RETURN r._type`)
        .then(cursor => cursor.next())
        .then(result => {
          // console.log(parent);
          parent.contentType = result;
        });
    })
    .then(() => {
      // all done
      return parents;
    });
  })
  .catch({
      isArangoError: true,
      errorMessage: 'invalid traversal depth (while instantiating plan)'
    },
    () => null); // Treat non-existing path has not-found
}

function getNewDescendants(id, rev) {
  // TODO: Better way to compare the revs?
  return db.query(aql`
    LET node = FIRST(
      FOR node in ${graphNodes}
        FILTER node.resource_id == ${id}
        RETURN node
    )

    FOR v, e, p IN 0..${MAX_DEPTH} OUTBOUND node ${edges}
      FILTER p.edges[*].versioned ALL == true
      FILTER v.is_resource
      LET ver = SPLIT(DOCUMENT(LAST(p.vertices).resource_id)._oada_rev, '-', 1)
      FILTER TO_NUMBER(ver) >= ${+rev.split('-', 1)}
      RETURN DISTINCT v.resource_id
  `).call('all');
}

function putResource(id, obj) {
  // Fix rev
  obj['_oada_rev'] = obj['_rev'];
  obj['_rev'] = undefined;

  // TODO: Sanitize OADA keys?

  obj['_key'] = id.replace(/^resources\//, '');
  var start = new Date().getTime();
  trace(`Adding links for resource ${id}...`);
  return addLinks(obj).then(function docUpsert(links) {
    var end = new Date().getTime();
    trace(`Links added for resource ${id}. Upserting. +${end - start}ms`);
    info(`Upserting resource ${obj['_key']}`);
    trace(`Upserting links: ${JSON.stringify(links, null, 2)}`);

    // TODO: Should it check that graphNodes exist but are wrong?
    var q;
    if (links.length > 0) {
      q = db.query(aql`
        LET reskey = ${obj['_key']}
        LET res = FIRST(
          LET res = ${obj}
          UPSERT { '_key': reskey }
          INSERT res
          UPDATE res
          IN resources
          RETURN NEW
        )
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
              IN graphNodes
              RETURN NEW
          ), { _id: CONCAT('graphNodes/', LAST(nodeids)), is_resource: true })
          LET edges = (
            FOR i IN 0..(LENGTH(l.path)-1)
              UPSERT {
                '_key': MD5(nodes[i]._id+nodes[i+1]._id),
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
              IN edges
              RETURN NEW
          )
          FOR edge IN edges
            RETURN edge._key
      `);
    } else {
      q = db.query(aql`
        LET res = FIRST(
          LET res = ${obj}
          UPSERT { '_key': res._key }
          INSERT res
          UPDATE res
          IN resources
          return NEW
        )
        LET nodekey = CONCAT('resources:', res._key)
        UPSERT { '_key': nodekey }
        INSERT {
          '_key': nodekey,
          'is_resource': true,
          'resource_id': res._id
        }
        UPDATE {}
        IN graphNodes
      `);
    }

    return q;
  });
}

function forLinks(res, cb, path) {
  path = path || [];

  return Promise.map(Object.keys(res), key => {
    if (res[key] && res[key].hasOwnProperty('_id')) {
      return cb(res[key], path.concat(key));
    } else if (typeof res[key] === 'object' && res[key] !== null) {
      return forLinks(res[key], cb, path.concat(key));
    }
  });
}

// TODO: Remove links as well
function addLinks(res) {
  // TODO: Use fewer queries or something?
  var links = [];
  return forLinks(res, function processLinks(link, path) {
    // Just ignore _meta for now
    // TODO: Allow links in _meta?
    if (path[0] === '_meta') {
      return;
    }

    var rev;
    if (link.hasOwnProperty('_rev')) {
      rev = getResource(link['_id'], '_oada_rev')
        .then(function updateRev(rev) {
          link['_rev'] = rev || '0-0';
        });
    }

    return Promise.resolve(rev).then(function() {
      links.push(Object.assign({path}, link));
    });
  }).then(() => links);
}

function makeRemote(res, domain) {
  return forLinks(res, link => {
    // Change all links to remote links
    link['_rid'] = link['_id'];
    link['_rrev'] = link['_rev'];
    delete link['_id'];
    delete link['_rev'];
    link['_rdomain'] = domain;
  }).then(() => res);
}

function deleteResource(id) {
  let key = id.replace(/^resources\//, '');

  // Query deletes resouce, its nodes, and outgoing edges (but not incoming)
  return db.query(aql`
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
    FOR node IN nodes
      FOR edge IN ${edges}
        FILTER edge['_from'] == node._id
        REMOVE edge IN ${edges}
  `);
}

// "Delete" a part of a resource
// TODO: Not too sure I like how this function works or its name...
function deletePartialResource(id, path, doc) {
  let key = id.replace(/^resources\//, '');
  doc = doc || {};
  path = Array.isArray(path) ? path : pointer.parse(path);

  // Fix rev
  doc['_oada_rev'] = doc['_rev'];
  doc['_rev'] = undefined;

  pointer.set(doc, path, null);

  let name = path.pop();
  path = pointer.compile(path);

  let query = aql`
    LET res = DOCUMENT(${resources}, ${key})

    LET start = FIRST(
      FOR node IN ${graphNodes}
        LET path = node.path || null
        FILTER node['resource_id'] == res._id AND path == ${path || null}
        RETURN node
    )

    LET v = (
      FOR v, e, p IN 1..${MAX_DEPTH} OUTBOUND start._id ${edges}
        OPTIONS { bfs: true, uniqueVertices: 'global' }
        FILTER p.edges[0].name == ${name}
        FILTER p.vertices[*].resource_id ALL == res._id
        REMOVE v IN ${graphNodes}
        RETURN OLD
    )

    LET e = (
      FOR edge IN ${edges}
        FILTER (v[*]._id ANY == edge._to) || (v[*]._id ANY == edge._from)
        REMOVE edge IN ${edges}
        RETURN OLD
    )

    UPDATE { _key: ${key} }
    WITH ${doc}
    IN ${resources}
    OPTIONS { keepNull: false }
  `; // TODO: Why the heck does arango error if I update resource before graph?

  trace('Sending partial delete query:', query);

  return db.query(query);
}

module.exports = {
  lookupFromUrl,
  getResource,
  getResourceOwnerIdRev,
  putResource,
  deleteResource,
  deletePartialResource,
  getParents,
  getNewDescendants,
  makeRemote,
  // TODO: Better way to handler errors?
  // ErrorNum from: https://docs.arangodb.com/2.8/ErrorCodes/
  NotFoundError: {
    name: 'ArangoError',
    errorNum: 1202
  },
  UniqueConstraintError: {
    name: 'ArangoError',
    errorNum: 1210
  },
};
