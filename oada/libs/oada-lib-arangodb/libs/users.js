'use strict';

const debug = require('debug');
const info = debug('arangodb#resources:info');
const config = require('../config');
const db = require('../db.js');
const aql = require('arangojs').aql;
const bcrypt = require('bcryptjs');
var Promise = require('bluebird');
const util = require('../util');
const users = db.collection(config.get('arangodb:collections:users:name'));
const flatten = require('flat');

/*
  user {
    "_id": "users/123frank",
    "username": "frank",
    "password": "test",
    "name": "Farmer Frank",
    "family_name": "Frank",
    "given_name": "Farmer",
    "middle_name": "",
    "nickname": "Frankie",
    "email": "frank@openag.io"
    "oidc": {
      "sub": "02kfj023ifkldf", // subject, i.e. unique ID for this user
      "iss": "https://localhost", // issuer: the domain that gave out this ID
      "username": "bob", // can be used to pre-link this account to openidconnect identity
    }
  }
*/

function findById(id) {
  return users
    .document(id)
    .then(util.sanitizeResult)
    .catch({ code: 404 }, () => null);
}

function exists(id) {
  return users.documentExists(id);
}

function findByUsername(username) {
  return db
    .query(
      aql`
      FOR u IN ${users}
      FILTER u.username == ${username}
      RETURN u`
    )
    .call('next')
    .then((user) => {
      if (!user) {
        return null;
      }

      return util.sanitizeResult(user);
    });
}

function findByOIDCUsername(oidcusername, oidcdomain) {
  return db
    .query(
      aql`
    FOR u IN ${users}
    FILTER u.oidc.username == ${oidcusername}
    FILTER u.oidc.iss == ${oidcdomain}
    RETURN u`
    )
    .call('next')
    .then((user) => {
      if (!user) {
        return null;
      }

      return util.sanitizeResult(user);
    });
}

// expects idtoken to be at least
// { sub: "fkj2o", iss: "https://localhost/example" }
function findByOIDCToken(idtoken) {
  return db
    .query(
      aql`
    FOR u IN ${users}
    FILTER u.oidc.sub == ${idtoken.sub}
    FILTER u.oidc.iss == ${idtoken.iss}
    RETURN u`
    )
    .call('next')
    .then((user) => {
      if (!user) {
        return null;
      }

      return util.sanitizeResult(user);
    });
}

function findByUsernamePassword(username, password) {
  return findByUsername(username).then((user) => {
    if (!user) return null;
    return bcrypt
      .compare(password, user.password)
      .then((valid) => (valid ? user : null));
  });
}

function create(u) {
  return Promise.try(() => {
    info('create user was called with data', u);
    if (u.password) u.password = hashPw(u.password);
    // Throws if username already exists
    return users.save(u, { returnNew: true }).then((r) => r.new || r);
  });
}

// Use this with care because it will completely remove that user document.
function remove(u) {
  return users.remove(u);
}

function update(u) {
  if (u.password) u.password = hashPw(u.password);
  return users.update(u._id, u, { returnNew: true });
}

function like(u) {
  return util.bluebirdCursor(users.byExample(flatten(u)));
}

function hashPw(pw) {
  return bcrypt.hashSync(pw, config.get('arangodb:init:passwordSalt'));
}

module.exports = {
  findById,
  exists,
  findByUsername,
  findByUsernamePassword,
  findByOIDCUsername,
  findByOIDCToken,
  create: create,
  update,
  remove,
  like,
  hashPw: hashPw,
  // TODO: Better way to handler errors?
  // ErrorNum from: https://docs.arangodb.com/2.8/ErrorCodes/
  NotFoundError: {
    name: 'ArangoError',
    errorNum: 1202,
  },
  UniqueConstraintError: {
    name: 'ArangoError',
    errorNum: 1210,
  },
};
