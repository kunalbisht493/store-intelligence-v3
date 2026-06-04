// pipeline/zones.js
// Maps (x, y) pixel coordinates to zone_id using polygon point-in-polygon checks
// Coordinates are normalised 0-1 relative to frame resolution

const path = require('path');
const layout = require('../data/store_layout.json');

// Build zone map indexed by camera_id for fast lookup
const zoneByCameraMap = {};
for (const zone of layout.zones) {
  const cam = zone.camera_id;
  if (!zoneByCameraMap[cam]) zoneByCameraMap[cam] = [];
  zoneByCameraMap[cam].push(zone);
}

// Point-in-polygon using ray casting algorithm
function pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Get zone_id for a bounding box centroid on a given camera
 * @param {string} cameraId - e.g. "CAM_FLOOR_01"
 * @param {number} cx - normalised centroid x (0-1)
 * @param {number} cy - normalised centroid y (0-1)
 * @returns {string|null} zone_id or null if not in any zone
 */


function getZoneId(cameraId, cx, cy) {
  const zones = zoneByCameraMap[cameraId];
  if (!zones) return null;

  for (const zone of zones) {
    if (pointInPolygon(cx, cy, zone.polygon)) {
      return zone.zone_id;
    }
  }
  return null;
}

/**
 * Get zone info object
 */
function getZone(zoneId) {
  return layout.zones.find(z => z.zone_id === zoneId) || null;
}

/**
 * Detect entry/exit direction on entry camera
 * Uses the entry_line_y from store_layout.json
 * Direction: above line = outside, below line = inside
 * @param {string} cameraId
 * @param {number} prevCy - previous centroid y (normalised)
 * @param {number} currCy - current centroid y (normalised)
 * @returns {'ENTRY'|'EXIT'|null}
 */
function detectEntryExit(cameraId, prevCy, currCy) {
  const cam = layout.cameras.find(c => c.camera_id === cameraId);
  if (!cam || cam.type !== 'entry_exit') return null;

  const line = cam.entry_line_y || 0.5;

  // CAM_ENTRY_01 looks DOWN toward the door.
  // Inside store = top of frame (y < line, wooden floor).
  // Outside = bottom of frame (y > line, dark marble threshold).
  // ENTRY = person moves from outside (high y) → inside (low y) i.e. y decreases past line.
  // EXIT  = person moves from inside (low y) → outside (high y) i.e. y increases past line.
  if (prevCy > line && currCy <= line) return 'ENTRY';  // moving UP into store
  if (prevCy <= line && currCy > line) return 'EXIT';   // moving DOWN out of store
  return null;
}

/**
 * Check if camera covers billing zone (for queue detection)
 */
function isBillingCamera(cameraId) {
  const cam = layout.cameras.find(c => c.camera_id === cameraId);
  return cam?.coverage_zones?.includes('BILLING') ?? false;
}

module.exports = { getZoneId, getZone, detectEntryExit, isBillingCamera, layout };
