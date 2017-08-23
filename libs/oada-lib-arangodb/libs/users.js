'use strict';

const config = require('../config');
const db = require('../db.js');
const aql = require('arangojs').aql;
const bcrypt = require('bcryptjs');
var Promise = require('bluebird');
const util = require('../util');
const users = db.collection(config.get('arangodb:collections:users:name'))

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
  }
*/

function findById(id) {
  return users.document(id)
    .then(util.sanitizeResult)
    .catch({code: 404}, () => null);
}

function findByUsername(username) {
  return db.query(aql`
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

function findByUsernamePassword(username, password) {
  return findByUsername(username)
    .then((user) => {
      return bcrypt.compare(password, user.password)
        .then((valid) => valid ? user : null);
    });
}

function create(u) {
  return Promise.try(() => {
    console.log('create user was called');
  });
  /*
  u = _.cloneDeep(u);
  // Hash the plaintext password:
  u.password = bcrypt.hashSync(u.password, config.get('init:passwordSalt'));

  // 1. Create meta document for bookmarks resource
  resources
  // 2. Create bookmarks resource
  // 3. Create graph node for meta document and bookmarks resource
  // 4. Create _meta edge for bookmarks -> meta
  // 5. Create user with proper bookmarksid
*/
}

function hashPw(pw) {
  return bcrypt.hashSync(pw, config.get('arangodb:init:passwordSalt'));
}

module.exports = {
  findById,
  findByUsername,
  findByUsernamePassword,
  create: create,
  hashPw: hashPw,
};
