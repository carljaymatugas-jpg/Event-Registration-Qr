'use strict';

/**
 * Standardized categories across EventReg:
 * - TECH & DEVELOPER
 * - DESIGN & CREATIVE
 * - HANDS-ON WORKSHOP
 * - COMMUNITY MEETUP
 */
function getEventCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();

  if (text.includes('design') || text.includes('ux') || text.includes('ui') || text.includes('figma') || text.includes('creative')) {
    return 'DESIGN & CREATIVE';
  }
  if (text.includes('workshop') || text.includes('hands-on') || text.includes('bootcamp') || text.includes('lab') || text.includes('training')) {
    return 'HANDS-ON WORKSHOP';
  }
  // Check developer/tech keywords before generic meetup/community words
  // so "Cebu Dev Meetup 2026" is tagged TECH & DEVELOPER.
  if (
    text.includes('dev meetup') ||
    text.includes('developer') ||
    text.includes('tech community') ||
    text.includes('programming') ||
    text.includes('software') ||
    text.includes('hackathon') ||
    text.includes('mobile development') ||
    /\b(dev|tech|ai|web)\b/.test(text)
  ) {
    return 'TECH & DEVELOPER';
  }
  if (text.includes('meetup') || text.includes('community') || text.includes('gathering') || text.includes('social') || text.includes('tournament') || text.includes('concert')) {
    return 'COMMUNITY MEETUP';
  }
  return 'TECH & DEVELOPER';
}

module.exports = { getEventCategory };
