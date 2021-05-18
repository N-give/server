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

import { join } from 'path';
// @ts-ignore added in node 15/16
import { pipeline } from 'stream/promises';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import ksuid from 'ksuid';
import cacache from 'cacache';
import typeis from 'type-is';

import { plugin as formats } from '@oada/formats-server';

import { resources, changes, putBodies } from '@oada/lib-arangodb';
import {
  handleReq as permissionsRequest,
  Scope,
} from '@oada/permissions-handler';
import type { WriteRequest, WriteResponse } from '@oada/write-handler';

import type {} from './server';
import requester from './requester';
import type { TokenResponse } from './tokenLookup';
import config from './config';

const CACHE_PATH = config.get('storage.binary.cacache');

export interface Options {
  prefix: string;
  prefixPath(request: FastifyRequest): string;
}

/**
 * Fastify plugin for OADA /resources
 */
const plugin: FastifyPluginAsync<Options> = async function (fastify, opts) {
  /**
   * Compute "OADA path" from URL
   *
   * @todo Better way to handle oada path with fastify?
   */
  fastify.addHook('preParsing', async (request) => {
    const url = request.url.replace(opts.prefix, opts.prefixPath(request));
    const path =
      request.method === 'POST'
        ? // Treat POST as PUT put append random id
          join(url, (await ksuid.random()).string)
        : url.replace(/\/$/, '');
    request.requestContext.set('oadaPath', path);
  });

  /**
   * Perform the OADA "graph lookup"
   */
  fastify.addHook('preHandler', async function graphHandler(request, reply) {
    const path = request.requestContext.get<string>('oadaPath');

    const resp = await resources.lookupFromUrl(
      '/' + path,
      request.requestContext.get<TokenResponse['doc']>('user')!.user_id
    );
    request.log.trace('GRAPH LOOKUP RESULT %O', resp);
    if (resp['resource_id']) {
      // Rewire URL to resource found by graph
      const url = `${resp['resource_id']}${resp['path_leftover']}`;
      // log
      request.log.info('Graph lookup: %s => %s', path, url);
      // Remove "/resources" from id
      request.requestContext.set(
        'oadaPath',
        url.replace(/^\/?resources\//, '/')
      );
    }
    reply.header('Content-Location', '/' + path);
    request.requestContext.set('oadaGraph', resp);
    request.requestContext.set('resourceExists', resp.resourceExists);
  });

  /**
   * Perform scope checks for token.
   *
   * Has to run after graph lookup.
   * @todo Should this just be in each methods implenting function?
   */
  fastify.addHook('preHandler', async function checkScope(request, reply) {
    const oadaGraph = request.requestContext.get<resources.GraphLookup>(
      'oadaGraph'
    )!;
    const user = request.requestContext.get<TokenResponse['doc']>('user')!;

    const response = permissionsRequest({
      //connection_id: request.id,
      //domain: request.headers.host,
      oadaGraph,
      user_id: user['user_id'],
      scope: user.scope as Scope[],
      contentType: request.headers['content-type'],
      //requestType: request.method.toLowerCase(),
    });

    request.log.trace('permissions response: %o', response);
    switch (request.method) {
      case 'PUT':
      case 'POST':
      case 'DELETE':
        if (!oadaGraph['resource_id']) {
          // PUTing non-existant resource
          break;
        } else if (!response.permissions.owner && !response.permissions.write) {
          request.log.warn(
            '%s tried to PUT resource without proper permissions',
            user.user_id
          );
          return reply.forbidden(
            'User does not have write permission for this resource'
          );
        }

        if (!response.scopes.write) {
          return reply.forbidden('Token does not have required scope');
        }

        break;

      case 'HEAD':
      case 'GET':
        if (!response.permissions.owner && !response.permissions.read) {
          request.log.warn(
            '%s tried to GET resource without proper permissions',
            user.user_id
          );
          return reply.forbidden(
            'User does not have read permission for this resource'
          );
        }

        if (!response.scopes.read) {
          return reply.forbidden('Token does not have required scope');
        }

        break;
    }
  });

  /**
   * Return "path leftover" in a header if token/scope passes
   */
  fastify.addHook('preHandler', async function pathLeftover(request, reply) {
    const oadaGraph = request.requestContext.get<resources.GraphLookup>(
      'oadaGraph'
    )!;
    // TODO: Better header name?
    reply.header('X-OADA-Path-Leftover', oadaGraph['path_leftover']);
  });

  await fastify.register(formats);

  fastify.get('', getResource); // Fix for GET /bookmarks ?
  fastify.get('/*', getResource);
  async function getResource(request: FastifyRequest, reply: FastifyReply) {
    const oadaGraph = request.requestContext.get<resources.GraphLookup>(
      'oadaGraph'
    )!;

    reply.header('Content-Type', oadaGraph.type);
    reply.header('X-OADA-Rev', oadaGraph.rev);
    reply.header('ETag', `"${oadaGraph.rev}"`);

    /**
     * Check preconditions before actually getting the body
     */

    const ifmatch = request.headers['if-match'];
    if (ifmatch) {
      const rev = parseETag(ifmatch);
      if (rev !== oadaGraph.rev) {
        return reply.preconditionFailed(
          'If-Match header does not match current resource _rev'
        );
      }
    }

    const ifnonematch = request.headers['if-none-match'];
    if (ifnonematch) {
      const revs = ifnonematch.split(',').map(parseETag);
      if (revs.includes(oadaGraph.rev)) {
        return reply.preconditionFailed(
          'If-None-Match header contains current resource _rev'
        );
      }
    }

    /**
     * Handle requests for /_meta/_changes?
     */
    if (oadaGraph.path_leftover === '/_meta/_changes') {
      const ch = await changes.getChanges(oadaGraph.resource_id);
      return ch
        .map((item) => {
          return {
            [item]: {
              _id: oadaGraph.resource_id + '/_meta/_changes/' + item,
              _rev: item,
            },
          };
        })
        .reduce((a, b) => {
          return { ...a, ...b };
        });
    } else if (/^\/_meta\/_changes\/.*?/.test(oadaGraph.path_leftover)) {
      const rev = +oadaGraph.path_leftover.split('/')[3]!;
      const ch = await changes.getChangeArray(oadaGraph.resource_id, rev);
      request.log.trace('CHANGE %O', ch);
      return ch;
    }

    // TODO: Should it not get the whole meta document?
    // TODO: Make getResource accept an array of paths and return an array of
    //       results. I think we can do that in one arango query

    if (
      typeis.is(oadaGraph.type!, ['json', '+json']) ||
      oadaGraph['path_leftover'].match(/\/_meta$/)
    ) {
      const doc = await resources.getResource(
        oadaGraph['resource_id'],
        oadaGraph['path_leftover']
      );
      request.log.trace('DOC IS %O', doc);

      // TODO: Allow null values in OADA?
      if (doc === undefined || doc === null) {
        request.log.error('Resource not found');
        return reply.notFound();
      } else {
        request.log.info(
          'Resource: %s, Rev: %d',
          oadaGraph.resource_id,
          oadaGraph.rev
        );
      }

      return reply.send(unflattenMeta(doc));
    } else {
      // get binary
      if (oadaGraph['path_leftover']) {
        request.log.trace(oadaGraph['path_leftover']);
        // TODO: What error code to use here?
        return reply.notImplemented('Path Leftover on Binary GET');
      }

      // Look up file size before streaming
      const {
        integrity,
        // @ts-ignore
        size,
      } = await cacache.get.info(CACHE_PATH, oadaGraph['resource_id']);

      // Stream file to client
      reply.header('Content-Length', size);
      return reply.send(cacache.get.stream.byDigest(CACHE_PATH, integrity));
    }
  }

  // TODO: This was a quick make it work. Do what you want with it.
  function unflattenMeta(doc: any) {
    if (doc === null) {
      // Object.keys does not like null
      return null;
    }
    if (doc._meta) {
      doc._meta = {
        _id: doc._meta._id,
        _rev: doc._meta._rev,
      };
    }
    return doc;
  }

  // Don't let users modify their shares?
  function noModifyShares(request: FastifyRequest, reply: FastifyReply) {
    const path = request.requestContext.get<string>('oadaPath')!;
    const user = request.requestContext.get<TokenResponse['doc']>('user')!;
    if (path.match(`^/${user['shares_id']}`)) {
      return reply.forbidden('User cannot modify their shares document');
    }
  }

  // Parse JSON content types as text (but do not parse JSON yet)
  fastify.addContentTypeParser(
    ['json', '+json'],
    {
      // TODO: Stream process the body instead
      parseAs: 'string',
      // 20 MB
      bodyLimit: 20 * 1048576,
    },
    (_, body, done) => done(null, body)
  );

  /**
   * Parse the rev out of a resource's ETag
   *
   * @param {string} etag
   * @returns {number} rev
   */
  function parseETag(etag: string): number {
    // Parse strong or weak ETags?
    // e.g., `W/"123"` or `"123"`
    const r = /(W\/)?"(?<rev>\d*)"/;

    const { rev } = etag.match(r)?.groups ?? {};

    // If parse fails, assume `123` format (for legacy code)
    return rev ? +rev : +etag;
  }

  fastify.route({
    url: '*',
    method: ['PUT', 'POST'],
    handler: putResource,
  });
  fastify.route({
    url: '/*',
    method: ['PUT', 'POST'],
    handler: putResource,
  });
  /**
   * Handle PUT/POST
   */
  async function putResource(request: FastifyRequest, reply: FastifyReply) {
    // Don't let users modify their shares?
    noModifyShares(request, reply);

    const oadaGraph = request.requestContext.get<resources.GraphLookup>(
      'oadaGraph'
    )!;
    const resourceExists = request.requestContext.get<boolean>(
      'resourceExists'
    )!;
    const user = request.requestContext.get<TokenResponse['doc']>('user')!;
    let path = request.requestContext.get<string>('oadaPath')!;
    request.log.trace('Saving PUT body for request');

    /**
     * Use binary stuff if not a JSON request
     */
    if (!request.is(['json', '+json'])) {
      await pipeline(
        request.raw,
        cacache.put.stream(CACHE_PATH, oadaGraph.resource_id)
      );
      request.body = '{}';
    }

    const { _id: bodyid } = await putBodies.savePutBody(request.body as string);
    request.log.trace('PUT body saved');

    request.log.trace('RESOURCE EXISTS %O', oadaGraph);
    request.log.trace('RESOURCE EXISTS %O', resourceExists);
    const ignoreLinks =
      ((request.headers['x-oada-ignore-links'] ??
        '') as string).toLowerCase() == 'true';
    const ifmatch = request.headers['if-match'];
    const ifnonematch = request.headers['if-none-match'];
    const resp = (await requester.send(
      {
        'connection_id': request.id,
        resourceExists,
        'domain': request.hostname,
        'url': path,
        'resource_id': oadaGraph['resource_id'],
        'path_leftover': oadaGraph['path_leftover'],
        //'meta_id': oadaGraph['meta_id'],
        'user_id': user['user_id'],
        'authorizationid': user['authorizationid'],
        'client_id': user['client_id'],
        'contentType': request.headers['content-type'],
        'bodyid': bodyid,
        'if-match': ifmatch && parseETag(ifmatch),
        'if-none-match': ifnonematch?.split(',').map(parseETag),
        ignoreLinks,
      } as WriteRequest,
      config.get('kafka.topics.writeRequest')
    )) as WriteResponse;

    request.log.trace('Recieved write response');
    switch (resp.code) {
      case 'success':
        break;
      case 'permission':
        return reply.forbidden('User does not own this resource');
      case 'if-match failed':
        return reply.preconditionFailed(
          'If-Match header does not match current resource _rev'
        );
      case 'if-none-match failed':
        return reply.preconditionFailed(
          'If-None-Match header contains current resource _rev'
        );
      default:
        throw new Error('write failed with code ' + resp.code);
    }
    return (
      reply
        .header('X-OADA-Rev', resp['_rev'])
        .header('ETag', `"${resp['_rev']}"`)
        // TODO: What is the right thing to return here?
        //.redirect(204, req.baseUrl + req.url)
        .send()
    );
  }

  /**
   * Handle DELETE
   */
  fastify.delete('/*', async function deleteResource(request, reply) {
    let path = request.requestContext.get<string>('oadaPath')!;
    const user = request.requestContext.get<TokenResponse['doc']>('user')!;
    let {
      rev,
      ...oadaGraph
    } = request.requestContext.get<resources.GraphLookup>('oadaGraph')!;
    let resourceExists = request.requestContext.get<boolean>('resourceExists')!;

    // Don't let users delete their shares?
    noModifyShares(request, reply);
    // Don't let users DELETE their bookmarks?
    if (path === '/' + user['bookmarks_id']) {
      return reply.forbidden('User cannot delete their bookmarks');
    }

    /**
     * Check if followed a link and are at the root of the linked resource
     */
    if (oadaGraph.from?.['path_leftover'] && !oadaGraph['path_leftover']) {
      // Switch to DELETE on parent resource
      const id = oadaGraph.from['resource_id'];
      const pathlo = oadaGraph.from['path_leftover'];
      path = '/' + id.replace(/^\/?resources\//, '') + pathlo;
      oadaGraph = oadaGraph.from;
      // parent resource DOES exist,
      // but linked resource may or may not have existed
      resourceExists = true;
    }

    request.log.trace('Sending DELETE request');
    const ifmatch = request.headers['if-match'];
    const ifnonematch = request.headers['if-none-match'];
    const resp = (await requester.send(
      {
        resourceExists,
        'connection_id': request.id,
        'domain': request.hostname,
        'url': path,
        'resource_id': oadaGraph['resource_id'],
        'path_leftover': oadaGraph['path_leftover'],
        //'meta_id': oadaGraph['meta_id'],
        'user_id': user['user_id'],
        'authorizationid': user['authorizationid'],
        'client_id': user['client_id'],
        'if-match': ifmatch && parseETag(ifmatch),
        'if-none-match': ifnonematch?.split(',').map(parseETag),
        //'bodyid': bodyid, // No body means delete?
        //body: req.body
        'contentType': '',
      } as WriteRequest,
      config.get('kafka.topics.writeRequest')
    )) as WriteResponse;

    request.log.trace('Recieved delete response');
    switch (resp.code) {
      case 'success':
        break;
      case 'not_found':
      // fall-through
      // TODO: Is 403 a good response for DELETE on non-existent?
      case 'permission':
        return reply.forbidden('User does not own this resource');
      case 'if-match failed':
        return reply.preconditionFailed(
          'If-Match header does not match current resource _rev'
        );
      case 'if-none-match failed':
        return reply.preconditionFailed(
          'If-None-Match header contains current resource _rev'
        );
      default:
        throw new Error('delete failed with code ' + resp.code);
    }

    return reply
      .header('X-OADA-Rev', resp['_rev'])
      .header('ETag', `"${resp['_rev']}"`)
      .code(204)
      .send();
  });
};

export default plugin;