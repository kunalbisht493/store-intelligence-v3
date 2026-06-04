// pipeline/emit.js
// Converts detection + tracking output into structured events
// Writes to events.jsonl (one JSON object per line)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { validateEvent } = require('../app/schema');

const OUTPUT_PATH = process.env.EVENTS_OUTPUT ||
  path.join(__dirname, '../data/events.jsonl');

// Ensure output directory exists
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

// Append stream — kept open for performance
let writeStream = null;

function getStream() {
  if (!writeStream) {
    writeStream = fs.createWriteStream(OUTPUT_PATH, { flags: 'a' });
  }
  return writeStream;
}

/**
 * Build a base event object
 */
function buildEvent({
  storeId, cameraId, visitorId, eventType,
  timestamp, zoneId = null, dwellMs = 0,
  isStaff = false, confidence, metadata = {}
}) {
  return {
    event_id: uuidv4(),
    store_id: storeId,
    camera_id: cameraId,
    visitor_id: visitorId,
    event_type: eventType,
    timestamp: toIso(timestamp),
    zone_id: zoneId,
    dwell_ms: dwellMs,
    is_staff: isStaff,
    confidence: parseFloat(confidence.toFixed(4)),
    metadata: {
      queue_depth: metadata.queue_depth ?? null,
      sku_zone: metadata.sku_zone ?? null,
      session_seq: metadata.session_seq ?? null
    }
  };
}

/**
 * Validate and write a single event to the JSONL file
 * Low-confidence events are written with the actual confidence — NOT dropped
 */
function emitEvent(eventData) {
  const result = validateEvent(eventData);

  if (!result.success) {
    console.error('[emit] Schema validation failed:', result.error.errors);
    console.error('[emit] Event:', JSON.stringify(eventData));
    return null; // Don't write invalid events
  }

  const line = JSON.stringify(result.data) + '\n';
  getStream().write(line);
  return result.data;
}

// ── Convenience emitters for each event type ─────────────────────────────────

function emitEntry({ storeId, cameraId, visitorId, timestamp, confidence, isStaff = false, sessionSeq = 1 }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'ENTRY',
    timestamp,
    confidence,
    isStaff,
    metadata: { session_seq: sessionSeq }
  }));
}

function emitExit({ storeId, cameraId, visitorId, timestamp, confidence, isStaff = false, sessionSeq }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'EXIT',
    timestamp, confidence, isStaff,
    metadata: { session_seq: sessionSeq }
  }));
}

function emitZoneEnter({ storeId, cameraId, visitorId, timestamp, zoneId, confidence, isStaff = false, sessionSeq, skuZone }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'ZONE_ENTER',
    timestamp, zoneId, confidence, isStaff,
    metadata: { session_seq: sessionSeq, sku_zone: skuZone }
  }));
}

function emitZoneExit({ storeId, cameraId, visitorId, timestamp, zoneId, dwellMs, confidence, isStaff = false, sessionSeq }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'ZONE_EXIT',
    timestamp, zoneId, dwellMs, confidence, isStaff,
    metadata: { session_seq: sessionSeq }
  }));
}

function emitZoneDwell({ storeId, cameraId, visitorId, timestamp, zoneId, dwellMs, confidence, isStaff = false, sessionSeq }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'ZONE_DWELL',
    timestamp, zoneId, dwellMs, confidence, isStaff,
    metadata: { session_seq: sessionSeq }
  }));
}

function emitBillingQueueJoin({ storeId, cameraId, visitorId, timestamp, queueDepth, confidence, isStaff = false, sessionSeq }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'BILLING_QUEUE_JOIN',
    timestamp, zoneId: 'BILLING', confidence, isStaff,
    metadata: { queue_depth: queueDepth, session_seq: sessionSeq }
  }));
}

function emitBillingQueueAbandon({ storeId, cameraId, visitorId, timestamp, confidence, sessionSeq }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'BILLING_QUEUE_ABANDON',
    timestamp, zoneId: 'BILLING', confidence,
    metadata: { session_seq: sessionSeq }
  }));
}

function emitReentry({ storeId, cameraId, visitorId, timestamp, confidence, sessionSeq }) {
  return emitEvent(buildEvent({
    storeId, cameraId, visitorId,
    eventType: 'REENTRY',
    timestamp, confidence,
    metadata: { session_seq: sessionSeq }
  }));
}

// Convert a frame offset + clip start time to ISO-8601
function toIso(tsMs) {
  if (typeof tsMs === 'string') return tsMs;
  return new Date(tsMs).toISOString().replace('.000', '').slice(0, 19) + 'Z';
}

function closeStream() {
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
}

module.exports = {
  emitEntry, emitExit, emitZoneEnter, emitZoneExit,
  emitZoneDwell, emitBillingQueueJoin, emitBillingQueueAbandon, emitReentry,
  closeStream, OUTPUT_PATH
};
