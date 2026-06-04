// app/routes/ingest.js
// POST /events/ingest
// Accepts batches of up to 500 events. Validates each with Zod.
// Idempotent by event_id. Returns partial success on malformed events.

const { validateEvent } = require('../schema');
const { getDb, insertEvent, upsertSession } = require('../db');

async function ingestRoutes(fastify) {
  fastify.post('/events/ingest', {
    schema: {
      body: {
        type: 'object',
        required: ['events'],
        properties: {
          events: { type: 'array', maxItems: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const traceId = request.id;
    const startTime = Date.now();

    const { events } = request.body;

    if (!Array.isArray(events) || events.length === 0) {
      return reply.code(400).send({
        error: 'INVALID_PAYLOAD',
        message: 'events must be a non-empty array',
        trace_id: traceId
      });
    }

    if (events.length > 500) {
      return reply.code(400).send({
        error: 'BATCH_TOO_LARGE',
        message: 'Maximum 500 events per batch',
        trace_id: traceId
      });
    }

    const db = getDb();
    const results = {
      accepted: [],
      rejected: [],
      duplicate: []
    };

    // Use a transaction for performance
    const insertBatch = db.transaction((validEvents) => {
      for (const event of validEvents) {
        const result = insertEvent(db, event);
        if (result.changes === 0) {
          // event_id already existed — idempotent, not an error
          results.duplicate.push(event.event_id);
        } else {
          results.accepted.push(event.event_id);
          upsertSession(db, event);
        }
      }
    });

    const validEvents = [];

    for (const raw of events) {
      const parsed = validateEvent(raw);
      if (!parsed.success) {
        results.rejected.push({
          event_id: raw.event_id || null,
          errors: parsed.error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      } else {
        validEvents.push(parsed.data);
      }
    }

    insertBatch(validEvents);

    const latencyMs = Date.now() - startTime;

    request.log.info({
      trace_id:    traceId,
      endpoint:    'POST /events/ingest',
      store_id:    validEvents[0]?.store_id ?? 'unknown',
      event_count: events.length,
      accepted:    results.accepted.length,
      rejected:    results.rejected.length,
      duplicate:   results.duplicate.length,
      latency_ms:  latencyMs,
      status_code: 200
    });

    return reply.code(200).send({
      trace_id:      traceId,
      accepted:      results.accepted.length,
      rejected:      results.rejected.length,
      duplicate:     results.duplicate.length,
      rejected_items: results.rejected,
      latency_ms:    latencyMs
    });
  });
}

module.exports = ingestRoutes;
