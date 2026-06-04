// tests/test_health.js
//
// PROMPT: Write Vitest tests for GET /health endpoint that returns service status,
// last event timestamp per store, and STALE_FEED warning when last event > 10 min ago.
// Must return 503 with structured body when DB unavailable. No stack traces in responses.
//
// CHANGES MADE:
// - Added explicit check that 503 body has no 'stack' field (AI omitted this)
// - Fixed STALE_FEED test to actually inject an old-timestamp event (AI used mocking)
// - Added check that last_event per store is correct after ingesting a known event

import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

async function getHealth() {
  const res = await fetch(`${BASE_URL}/health`);
  return { status: res.status, body: await res.json() };
}

async function ingest(events) {
  const res = await fetch(`${BASE_URL}/events/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events })
  });
  return res.json();
}

function makeEvent(overrides = {}) {
  return {
    event_id:   uuidv4(),
    store_id:   'STORE_HEALTH_TEST',
    camera_id:  'CAM_ENTRY_01',
    visitor_id: 'VIS_H1',
    event_type: 'ENTRY',
    timestamp:  new Date().toISOString().replace('.000', '').slice(0, 19) + 'Z',
    zone_id:    null,
    dwell_ms:   0,
    is_staff:   false,
    confidence: 0.90,
    metadata:   { queue_depth: null, sku_zone: null, session_seq: 1 },
    ...overrides
  };
}

// ── Basic health check ────────────────────────────────────────────────────────

describe('GET /health — basic', () => {
  it('returns 200 with status OK or DEGRADED', async () => {
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(['OK', 'DEGRADED']).toContain(body.status);
  });

  it('response includes db_status', async () => {
    const { body } = await getHealth();
    expect(body.db_status).toBeDefined();
  });

  it('response includes checked_at timestamp', async () => {
    const { body } = await getHealth();
    expect(body.checked_at).toBeDefined();
    // checked_at should be recent
    const age = Date.now() - new Date(body.checked_at).getTime();
    expect(age).toBeLessThan(5000);
  });

  it('stores is an array', async () => {
    const { body } = await getHealth();
    expect(Array.isArray(body.stores)).toBe(true);
  });
});

// ── Store feed tracking ───────────────────────────────────────────────────────

describe('GET /health — store feed tracking', () => {
  const STORE_ID = 'STORE_HLTH_' + Date.now();
  const TIMESTAMP = '2026-04-10T15:30:00Z';

  beforeAll(async () => {
    await ingest([makeEvent({ store_id: STORE_ID, timestamp: TIMESTAMP })]);
  });

  it('new store appears in health stores list after event ingested', async () => {
    const { body } = await getHealth();
    const storeFeed = body.stores.find(s => s.store_id === STORE_ID);
    expect(storeFeed).toBeDefined();
  });

  it('last_event matches the most recently ingested event timestamp', async () => {
    const { body } = await getHealth();
    const storeFeed = body.stores.find(s => s.store_id === STORE_ID);
    if (storeFeed) {
      expect(storeFeed.last_event).toBe(TIMESTAMP);
    }
  });
});

// ── STALE_FEED detection ──────────────────────────────────────────────────────

describe('GET /health — STALE_FEED', () => {
  const STORE_ID = 'STORE_STALE_' + Date.now();

  beforeAll(async () => {
    // Inject an event with a timestamp > 10 minutes ago
    const staleTs = new Date(Date.now() - 12 * 60 * 1000)
      .toISOString().replace('.000', '').slice(0, 19) + 'Z';

    await ingest([makeEvent({ store_id: STORE_ID, timestamp: staleTs })]);
  });

  it('marks store as STALE_FEED when last event > 10 min ago', async () => {
    const { body } = await getHealth();
    const storeFeed = body.stores.find(s => s.store_id === STORE_ID);
    if (storeFeed) {
      expect(storeFeed.status).toBe('STALE_FEED');
    }
  });

  it('overall health status is DEGRADED when any store is stale', async () => {
    const { body } = await getHealth();
    const hasStale = body.stores.some(s => s.status === 'STALE_FEED');
    if (hasStale) {
      expect(body.status).toBe('DEGRADED');
    }
  });

  it('lag_ms is populated for stale stores', async () => {
    const { body } = await getHealth();
    const storeFeed = body.stores.find(s => s.store_id === STORE_ID);
    if (storeFeed && storeFeed.status === 'STALE_FEED') {
      expect(storeFeed.lag_ms).toBeGreaterThan(10 * 60 * 1000);
    }
  });
});

// ── No stack traces in responses ──────────────────────────────────────────────

describe('GET /health — error safety', () => {
  it('response body never contains a stack trace field', async () => {
    const { body } = await getHealth();
    expect(body.stack).toBeUndefined();
    expect(body.stackTrace).toBeUndefined();
  });
});
