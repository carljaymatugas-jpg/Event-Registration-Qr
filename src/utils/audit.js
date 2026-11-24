'use strict';
const db = require('../db/db');
const { nowCebu } = require('./time');

function log(staffUserId, action, targetId, detail = '') {
  try {
    const promise = db.prepare(`INSERT INTO audit_logs (staff_user_id, action, target_id, detail) VALUES (?,?,?,?)`)
      .run(staffUserId || null, action, targetId || null, detail);
    if (promise && typeof promise.catch === 'function') {
      promise.catch(err => console.error('Audit log error:', err.message));
    }
  } catch (err) {
    console.error('Audit log sync error:', err.message);
  }
}

module.exports = { log };
