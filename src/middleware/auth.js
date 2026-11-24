'use strict';

// Middleware: require staff session
function requireStaff(req, res, next) {
  // Prevent browser caching of protected pages (so Back button after logout doesn't show sensitive pages)
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  if (!req.session || !req.session.staff) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.session.flash = { type: 'warning', msg: 'Please sign in to access staff pages.' };
    return res.redirect('/staff/login');
  }
  next();
}

// Middleware: require organizer role
function requireOrganizer(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  if (!req.session || !req.session.staff) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/staff/login');
  }
  if (req.session.staff.role !== 'organizer') {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(403).json({ error: 'Forbidden: Organizer role required' });
    }
    return res.status(403).render('error.html', { message: 'Access denied. Organizer role required.' });
  }
  next();
}

module.exports = { requireStaff, requireOrganizer };
