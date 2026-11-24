'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const nunjucks = require('nunjucks');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Session store (SQLite) ───────────────────────────────────────────────────
const sessionStore = require('./utils/sessionStore');
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 h
}));

// ── View engine (Nunjucks) ───────────────────────────────────────────────────
const env = nunjucks.configure(path.join(__dirname, 'views'), {
  autoescape: true,
  express: app,
  noCache: true
});

// Add a date/time filter for Cebu time
const { formatCebu, formatCebu12 } = require('./utils/time');
env.addFilter('cebuDate', (dt) => formatCebu(dt));
env.addFilter('cebuTime', (dt) => formatCebu12(dt));
env.addFilter('json', (val) => JSON.stringify(val));

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Global rate limiters ─────────────────────────────────────────────────────
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: 'Too many requests, please try again later.'
});
const checkinLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 60,
  message: 'Too many check-in attempts.'
});

// ── Middleware: inject user into every template ──────────────────────────────
app.use((req, res, next) => {
  res.locals.staffUser = req.session.staff || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/', require('./routes/attendee'));
app.use('/ticket', lookupLimiter, require('./routes/ticket_view'));
app.use('/staff', require('./routes/staff'));
app.use('/staff/checkin', checkinLimiter, require('./routes/checkin'));
app.use('/staff/events', require('./routes/events'));
app.use('/staff/attendees', require('./routes/attendees'));
app.use('/staff/dashboard', require('./routes/dashboard'));

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).render('404.html'));

// ── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error.html', { message: err.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`EventReg running at http://localhost:${PORT}`);
  });
}

module.exports = app;
