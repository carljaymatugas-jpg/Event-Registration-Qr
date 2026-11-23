'use strict';
// All times stored and displayed in Asia/Manila (UTC+8)

function formatCebu(isoOrStr) {
  if (!isoOrStr) return '';
  const d = new Date(isoOrStr.replace(' ', 'T') + (isoOrStr.includes('T') ? '' : '+08:00'));
  return d.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function formatCebu12(isoOrStr) {
  if (!isoOrStr) return '';
  const d = new Date(isoOrStr.replace(' ', 'T') + (isoOrStr.includes('T') ? '' : '+08:00'));
  return d.toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function nowCebu() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).replace('T', ' ');
}

function isSameDay(isoA, isoB) {
  const a = new Date(isoA.replace(' ', 'T') + '+08:00');
  const b = new Date(isoB.replace(' ', 'T') + '+08:00');
  return a.toDateString() === b.toDateString();
}

function isEventDay(startsAt) {
  return isSameDay(startsAt, nowCebu());
}

module.exports = { formatCebu, formatCebu12, nowCebu, isSameDay, isEventDay };
