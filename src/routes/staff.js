'use strict';
const router = require('express').Router();
const db = require('../db/db');
const bcrypt = require('bcryptjs');
const { requireStaff } = require('../middleware/auth');

// GET login page
router.get('/login', (req, res) => {
  if (req.session.staff) return res.redirect('/staff/dashboard');
  res.render('staff/login.html', { error: null });
});

// POST login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('staff/login.html', { error: 'Username and password required.' });
  }
  const user = db.prepare('SELECT * FROM staff_users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('staff/login.html', { error: 'Invalid username or password.' });
  }
  req.session.staff = { id: user.id, name: user.name, username: user.username, role: user.role };
  req.session.save((err) => {
    if (err) console.error('Session save error:', err);
    res.redirect('/staff/dashboard');
  });
});

// POST logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/staff/login'));
});

// Staff home redirect
router.get('/', requireStaff, (req, res) => res.redirect('/staff/dashboard'));

module.exports = router;
