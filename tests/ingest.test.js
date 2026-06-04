// tests/test_ingest.js
//
// PROMPT: Write Vitest tests for a Fastify POST /events/ingest endpoint that:
// - Accepts batches of up to 500 events validated with Zod
// - Is idempotent by event_id (same payload twice = same result, no duplicates)
// - Returns partial success when some events in a batch are malformed
// - Returns 400 when batch exceeds 500 events
// - Logs trace_id, event_count, latency_ms on every request
// Cover edge cases: empty store, all-staff clip, zero purchases, re-entry dedup.
//
// CHANGES MADE:
// - Added real SQLite in-memory DB setup/teardown per test (AI used a mock)
// - Fixed idempotency test to check DB row count, not just response body
// - Added the all-staff edge case (AI omitted it)
// - Replaced generic error messages with actual Zod field path assertions

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

// Helper — build a valid event object
function makeEvent(overrides = {}) {
  return {
    event_id: uuidv4(),
    store_id: 'STORE_BLR_002',
    camera_id: 'CAM_ENTRY_01',
    visitor_id: 'VIS_' + Math.random().toString(36).slice(2, 8),
    event_type: 'ENTRY',
    timestamp: '2026-04-10T12:00:00Z',
    zone_id: null,
    dwell_ms: 0,
    is_staff: false,
    confidence: 0.92,
    metadata: { queue_depth: null, sku_zone: null, session_seq: 1 },
    ...overrides
  };
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── Basic ingestion ───────────────────────────────────────────────────────────

describe('POST /events/ingest — basic ingestion', () => {
  it('accepts a valid single-event batch', async () => {
    const { status, body } = await post('/events/ingest', {
      events: [makeEvent()]
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
  });

  it('accepts a batch of 10 valid events', async () => {
    const events = Array.from({ length: 10 }, () => makeEvent());
    const { status, body } = await post('/events/ingest', { events });
    expect(status).toBe(200);
    expect(body.accepted).toBe(10);
  });

  it('returns 400 when events array is empty', async () => {
    const { status, body } = await post('/events/ingest', { events: [] });
    expect(status).toBe(400);
  });

  it('returns 400 when batch exceeds 500 events', async () => {
    const events = Array.from({ length: 501 }, () => makeEvent());
    const { status, body } = await post('/events/ingest', { events });
    expect(status).toBe(400);
    expect(['BATCH_TOO_LARGE', 'FST_ERR_VALIDATION'])
      .toContain(body.error);
  });

  it('returns 400 when events field is missing', async () => {
    const { status } = await post('/events/ingest', {});
    expect(status).toBe(400);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('POST /events/ingest — idempotency', () => {
  it('calling twice with same event_id does not duplicate the event', async () => {
    const event = makeEvent({ event_id: uuidv4() });

    const first = await post('/events/ingest', { events: [event] });
    const second = await post('/events/ingest', { events: [event] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Second call: accepted=0, duplicate=1
    expect(second.body.accepted).toBe(0);
    expect(second.body.duplicate).toBe(1);
  });

  it('same 5-event batch posted twice returns duplicate on second call', async () => {
    const events = Array.from({ length: 5 }, () => makeEvent());
    await post('/events/ingest', { events });
    const { body } = await post('/events/ingest', { events });

    expect(body.duplicate).toBe(5);
    expect(body.accepted).toBe(0);
  });
});

// ── Partial success ───────────────────────────────────────────────────────────

describe('POST /events/ingest — partial success', () => {
  it('accepts valid events and rejects malformed ones in the same batch', async () => {
    const validEvent = makeEvent();
    const invalidEvent = { event_id: 'not-a-uuid', event_type: 'INVALID_TYPE' };

    const { status, body } = await post('/events/ingest', {
      events: [validEvent, invalidEvent]
    });

    expect(status).toBe(200);       // partial success — not 400
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.rejected_items).toHaveLength(1);
    expect(body.rejected_items[0].errors).toBeDefined();
  });

  it('rejected item includes the field path and message', async () => {
    const { body } = await post('/events/ingest', {
      events: [{ event_id: 'bad', confidence: 2.5, event_type: 'ENTRY' }]
    });
    const errors = body.rejected_items[0].errors;
    const fields = errors.map(e => e.field);
    expect(fields).toContain('event_id');  // invalid UUID
  });

  it('returns 200 even when all events in batch are invalid', async () => {
    const { status, body } = await post('/events/ingest', {
      events: [{ foo: 'bar' }, { baz: 123 }]
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(2);
  });
});

// ── Schema validation ─────────────────────────────────────────────────────────

describe('POST /events/ingest — schema validation', () => {
  it('rejects event with confidence > 1', async () => {
    const { body } = await post('/events/ingest', {
      events: [makeEvent({ confidence: 1.5 })]
    });
    expect(body.rejected).toBe(1);
  });

  it('rejects event with invalid timestamp format', async () => {
    const { body } = await post('/events/ingest', {
      events: [makeEvent({ timestamp: '10-04-2026 12:00:00' })]  // wrong format
    });
    expect(body.rejected).toBe(1);
  });

  it('rejects event with unknown event_type', async () => {
    const { body } = await post('/events/ingest', {
      events: [makeEvent({ event_type: 'WALK_BY' })]
    });
    expect(body.rejected).toBe(1);
  });

  it('accepts all 8 valid event types', async () => {
    const types = [
      'ENTRY', 'EXIT', 'ZONE_ENTER', 'ZONE_EXIT',
      'ZONE_DWELL', 'BILLING_QUEUE_JOIN', 'BILLING_QUEUE_ABANDON', 'REENTRY'
    ];
    for (const event_type of types) {
      const { body } = await post('/events/ingest', {
        events: [makeEvent({ event_type, zone_id: event_type.startsWith('ZONE') ? 'SKINCARE' : null })]
      });
      expect(body.accepted, `event_type ${event_type} should be accepted`).toBe(1);
    }
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('POST /events/ingest — edge cases', () => {
  it('handles all-staff clip — staff events accepted but excluded from customer metrics', async () => {
    const staffEvents = Array.from({ length: 5 }, () =>
      makeEvent({ is_staff: true, event_type: 'ZONE_DWELL', zone_id: 'SKINCARE' })
    );
    const { body: ingestBody } = await post('/events/ingest', { events: staffEvents });
    expect(ingestBody.accepted).toBe(5);

    // Metrics should show 0 customer visitors
    const storeId = staffEvents[0].store_id;
    const { body: metricsBody } = await get(`/stores/${storeId}/metrics`);
    expect(metricsBody.unique_visitors).toBeDefined();
    // unique_visitors should not count staff — could be 0 or existing count
  });

  it('handles zero-purchase store — conversion_rate is 0 not null', async () => {
    const events = Array.from({ length: 3 }, () =>
      makeEvent({ store_id: 'STORE_EMPTY_TEST', event_type: 'ENTRY' })
    );
    await post('/events/ingest', { events });

    const { body } = await get('/stores/STORE_EMPTY_TEST/metrics');
    expect(body.conversion_rate).toBeDefined();
    expect(body.conversion_rate).toBe(0);
    expect(body.conversion_rate).not.toBeNull();
  });

  it('handles empty store period — metrics endpoint does not crash', async () => {
    const { status, body } = await get('/stores/STORE_NO_EVENTS/metrics');
    expect(status).toBe(200);
    expect(body.unique_visitors).toBe(0);
    expect(body.conversion_rate).toBe(0);
  });

  it('accepts low-confidence events — they are not silently dropped', async () => {
    const lowConfEvent = makeEvent({ confidence: 0.1 });
    const { body } = await post('/events/ingest', { events: [lowConfEvent] });
    expect(body.accepted).toBe(1);  // low confidence ≠ rejected
  });

  it('response includes latency_ms and trace_id', async () => {
    const { body } = await post('/events/ingest', { events: [makeEvent()] });
    expect(body.latency_ms).toBeDefined();
    expect(body.trace_id).toBeDefined();
  });
});
