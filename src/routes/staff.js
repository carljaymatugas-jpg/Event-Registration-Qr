'use strict';
const router = require('express').Router();
const db = require('../db/db');
const bcrypt = require('bcryptjs');
const { requireStaff } = require('../middleware/auth');

// GET login page
router.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  if (req.session.staff) return res.redirect('/staff/dashboard');
  res.render('staff/login.html', { error: null });
});

// POST login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.render('staff/login.html', { error: 'Username and password required.' });
    }
    const user = await db.prepare('SELECT * FROM staff_users WHERE username = ?').get(username.trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render('staff/login.html', { error: 'Invalid username or password.' });
    }
    req.session.staff = { id: user.id, name: user.name, username: user.username, role: user.role };
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/staff/dashboard');
    });
  } catch (err) {
    next(err);
  }
});

// POST logout
router.post('/logout', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/staff/login');
  });
});

// Staff home redirect
router.get('/', requireStaff, (req, res) => res.redirect('/staff/dashboard'));

module.exports = router;
