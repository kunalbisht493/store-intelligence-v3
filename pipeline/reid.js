// pipeline/reid.js
// Re-ID: assigns stable visitor_id tokens across tracks
// Handles re-entry detection using embedding similarity + time window

const { v4: uuidv4 } = require('uuid');

const REENTRY_WINDOW_MS = 5 * 60 * 1000; // 5 min — after this, treat as new visit
const SIMILARITY_THRESHOLD = 0.75;         // cosine similarity to match as same person

// In-memory session cache — cleared between clips if needed
// Key: visitorId, Value: { embedding, lastSeen, exitTime, zone_history }
const sessionCache = new Map();

// Generate a short readable visitor ID
function makeVisitorId() {
  return 'VIS_' + uuidv4().replace(/-/g, '').slice(0, 6);
}

/**
 * Assign a visitor_id to a new track
 * Checks against recent sessions to detect re-entry
 * @param {Float32Array} embedding - appearance embedding from bounding box crop
 * @param {number} nowMs - current timestamp in ms
 * @param {string} storeId
 * @returns {{ visitor_id: string, is_reentry: boolean }}
 */

function assignVisitorId(embedding, nowMs, storeId) {
  let bestMatch = null;
  let bestSim = -1;

  for (const [vid, session] of sessionCache.entries()) {
    // Only check sessions that had an EXIT recently (potential re-entry)
    if (!session.exitTime) continue;

    const timeSinceExit = nowMs - session.exitTime;
    if (timeSinceExit > REENTRY_WINDOW_MS) continue;

    if (!session.embedding) continue;

    const sim = cosineSimilarity(embedding, session.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = vid;
    }
  }

  if (bestMatch && bestSim >= SIMILARITY_THRESHOLD) {
    // Same person returning — update their session
    const session = sessionCache.get(bestMatch);
    session.exitTime = null;
    session.lastSeen = nowMs;
    session.embedding = embedding;
    return { visitor_id: bestMatch, is_reentry: true };
  }

  // New visitor
  const visitor_id = makeVisitorId();
  sessionCache.set(visitor_id, {
    embedding,
    lastSeen: nowMs,
    exitTime: null,
    store_id: storeId,
    zone_history: []
  });

  return { visitor_id, is_reentry: false };
}

/**
 * Mark a visitor as having exited (for re-entry detection)
 */
function markExit(visitorId, exitTimeMs) {
  const session = sessionCache.get(visitorId);
  if (session) {
    session.exitTime = exitTimeMs;
    session.lastSeen = exitTimeMs;
  }
}

/**
 * Update zone history for a visitor (used by staff classifier)
 */
function updateZoneHistory(visitorId, zoneId) {
  const session = sessionCache.get(visitorId);
  if (session) {
    session.zone_history.push(zoneId);
  }
}

/**
 * Get zone history for a visitor (for staff classification)
 */
function getZoneHistory(visitorId) {
  return sessionCache.get(visitorId)?.zone_history || [];
}

/**
 * Simple embedding from bounding box — used when no real model is available
 * Combines bbox dimensions + position as a weak appearance feature
 * Replace with real CNN embedding for production
 */
function simpleBboxEmbedding(bbox, frameWidth, frameHeight) {
  const cx = (bbox.x1 + bbox.x2) / 2 / frameWidth;
  const cy = (bbox.y1 + bbox.y2) / 2 / frameHeight;
  const w = (bbox.x2 - bbox.x1) / frameWidth;
  const h = (bbox.y2 - bbox.y1) / frameHeight;
  const area = w * h;

  // 8-dim feature vector
  return new Float32Array([cx, cy, w, h, area, w / h, cx * cy, Math.sqrt(area)]);
}

// Cosine similarity between two Float32Arrays
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function clearCache() {
  sessionCache.clear();
}

module.exports = {
  assignVisitorId,
  markExit,
  updateZoneHistory,
  getZoneHistory,
  simpleBboxEmbedding,
  cosineSimilarity,
  clearCache
};
