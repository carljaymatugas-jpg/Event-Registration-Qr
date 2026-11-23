'use strict';
const db = require('../db/db');
const { nowCebu } = require('./time');

function log(staffUserId, action, targetId, detail = '') {
  db.prepare(`INSERT INTO audit_logs (staff_user_id, action, target_id, detail) VALUES (?,?,?,?)`)
    .run(staffUserId || null, action, targetId || null, detail);
}

module.exports = { log };
