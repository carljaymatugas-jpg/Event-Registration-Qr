'use strict';
// Middleware: require staff session
function requireStaff(req, res, next) {
  if (!req.session.staff) {
    req.session.flash = { type: 'warning', msg: 'Please sign in to access staff pages.' };
    return res.redirect('/staff/login');
  }
  next();
}

// Middleware: require organizer role
function requireOrganizer(req, res, next) {
  if (!req.session.staff || req.session.staff.role !== 'organizer') {
    return res.status(403).render('error.html', { message: 'Access denied. Organizer role required.' });
  }
  next();
}

module.exports = { requireStaff, requireOrganizer };
