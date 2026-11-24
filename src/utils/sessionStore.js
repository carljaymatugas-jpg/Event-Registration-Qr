'use strict';
const session = require('express-session');
const db = require('../db/db');

if (db.isPostgres) {
  const pgSession = require('connect-pg-simple')(session);
  module.exports = new pgSession({
    pool: db.pool,
    tableName: 'session',
    createTableIfMissing: true
  });
} else {
  class SqliteSessionStore extends session.Store {
    constructor(database) {
      super();
      this.db = database;
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expired INTEGER NOT NULL
        );
      `);
    }

    get(sid, cb) {
      try {
        const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, Date.now());
        if (!row) return cb(null, null);
        return cb(null, JSON.parse(row.sess));
      } catch (e) {
        return cb(e);
      }
    }

    set(sid, sess, cb) {
      try {
        const maxAge = (sess.cookie && sess.cookie.maxAge) || 8 * 60 * 60 * 1000;
        const expired = Date.now() + maxAge;
        this.db.prepare(`
          INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
        `).run(sid, JSON.stringify(sess), expired);
        if (cb) cb(null);
      } catch (e) {
        if (cb) cb(e);
      }
    }

    destroy(sid, cb) {
      try {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        if (cb) cb(null);
      } catch (e) {
        if (cb) cb(e);
      }
    }
  }

  module.exports = new SqliteSessionStore(db);
}
