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
  if (text.includes('meetup') || text.includes('community') || text.includes('gathering') || text.includes('social') || text.includes('tournament') || text.includes('concert')) {
    return 'COMMUNITY MEETUP';
  }
  return 'TECH & DEVELOPER';
}

module.exports = { getEventCategory };
