// pipeline/staff.js
// Staff classifier — seeds known staff from store_layout.json
// Uses uniform colour heuristics + zone pattern as fallback

const { layout } = require('./zones');

// Build staff ID set from store layout
const KNOWN_STAFF_NAMES = new Set(
  layout.staff.map(s => s.name.toLowerCase().trim())
);

// Staff appearance heuristics:
// In the Brigade Road store, staff typically wear dark uniforms
// These are HSV ranges for common staff uniform colours (approximations)
// If colour histogram of a bounding box crop falls in these ranges → flag as likely staff
const STAFF_UNIFORM_HUE_RANGES = [
  [0, 20],    // dark red / maroon
  [200, 240], // dark blue / navy
  [0, 360]    // fallback: use zone pattern only
];

// Track staff visitor_ids detected this session
const staffVisitorCache = new Set();

/**
 * Determine if a tracked person is staff
 * @param {string} visitorId
 * @param {Object} context - { zoneHistory, dwellPattern, colourScore }
 * @returns {boolean}
 */
function isStaff(visitorId, context = {}) {
  // 1. Already classified in this session
  if (staffVisitorCache.has(visitorId)) return true;

  // 2. Zone pattern check — staff visit all zones including back areas
  //    Staff tend to spend very short dwell times in each zone (not browsing)
  if (context.zoneHistory) {
    const zones = context.zoneHistory;
    const uniqueZones = new Set(zones).size;
    const avgDwell = context.avgDwellMs || 0;

    // Staff visit many zones quickly — customers tend to dwell longer
    if (uniqueZones >= 5 && avgDwell < 8000) {
      staffVisitorCache.add(visitorId);
      return true;
    }
  }

  // 3. Uniform colour score from detection model (if available)
  if (context.colourScore !== undefined && context.colourScore > 0.75) {
    staffVisitorCache.add(visitorId);
    return true;
  }

  return false;
}

/**
 * Permanently mark a visitor_id as staff
 */
function markAsStaff(visitorId) {
  staffVisitorCache.add(visitorId);
}

/**
 * Check if a visitor is known staff (cached)
 */
function isKnownStaff(visitorId) {
  return staffVisitorCache.has(visitorId);
}

/**
 * Clear cache between video clips
 */
function clearCache() {
  staffVisitorCache.clear();
}

module.exports = { isStaff, markAsStaff, isKnownStaff, clearCache, KNOWN_STAFF_NAMES };
