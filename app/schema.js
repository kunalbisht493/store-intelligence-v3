// app/schema.js
// Zod schema for the full event model
// Used by both pipeline/emit.js (to validate before writing) and routes/ingest.js (to validate on receive)
require('dotenv').config();
const { z } = require('zod');

const EVENT_TYPES = [
  'ENTRY',
  'EXIT',
  'ZONE_ENTER',
  'ZONE_EXIT',
  'ZONE_DWELL',
  'BILLING_QUEUE_JOIN',
  'BILLING_QUEUE_ABANDON',
  'REENTRY'
];

const MetadataSchema = z.object({
  queue_depth: z.number().int().nonnegative().nullable().optional(),
  sku_zone:    z.string().nullable().optional(),
  session_seq: z.number().int().nonnegative().optional()
}).optional().default({});

const EventSchema = z.object({
  event_id:   z.string().uuid('event_id must be a valid UUID v4'),
  store_id:   z.string().min(1, 'store_id is required'),
  camera_id:  z.string().min(1, 'camera_id is required'),
  visitor_id: z.string().min(1, 'visitor_id is required'),

  event_type: z.enum(EVENT_TYPES, {
    errorMap: () => ({ message: `event_type must be one of: ${EVENT_TYPES.join(', ')}` })
  }),

  timestamp: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'timestamp must be ISO-8601 UTC format: YYYY-MM-DDTHH:MM:SSZ'
  ),

  zone_id:    z.string().nullable().optional(),
  dwell_ms:   z.number().int().nonnegative().default(0),

  is_staff:   z.boolean().default(false),

  confidence: z.number()
    .min(0, 'confidence must be between 0 and 1')
    .max(1, 'confidence must be between 0 and 1'),

  metadata: MetadataSchema
});

// Schema for batch ingest — max 500 events per request
const IngestBatchSchema = z.object({
  events: z.array(EventSchema).min(1, 'At least 1 event required').max(500, 'Maximum 500 events per batch')
});

// Validate a single event — returns { success, data, error }
function validateEvent(raw) {
  return EventSchema.safeParse(raw);
}

// Validate a batch
function validateBatch(raw) {
  return IngestBatchSchema.safeParse(raw);
}

module.exports = { EventSchema, IngestBatchSchema, validateEvent, validateBatch, EVENT_TYPES };
