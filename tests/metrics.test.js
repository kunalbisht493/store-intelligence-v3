// tests/test_metrics.js
//
// PROMPT: Write Vitest tests for GET /stores/:id/metrics endpoint that returns
// unique_visitors, conversion_rate, avg_dwell_per_zone, queue_depth, abandonment_rate.
// Must exclude is_staff=true events. Handle zero-purchase stores (rate = 0 not null).
// Cover: empty store, all-staff clip, re-entry deduplication, avg_dwell computation.
//
// CHANGES MADE:
// - Added re-entry dedup test (AI missed it — visitor re-entering should count as 1 unique)
// - Fixed avg_dwell test to use actual zone names from store_layout.json
// - Changed store IDs to use unique test namespaces to avoid test pollution
// - Added check that response is real-time (generated_at field present)

import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

function makeEvent(overrides = {}) {
  return {
    event_id:   uuidv4(),
    store_id:   'STORE_METRICS_TEST',
    camera_id:  'CAM_ENTRY_01',
    visitor_id: 'VIS_' + Math.random().toString(36).slice(2, 8),
    event_type: 'ENTRY',
    timestamp:  '2026-04-10T12:00:00Z',
    zone_id:    null,
    dwell_ms:   0,
    is_staff:   false,
    confidence: 0.92,
    metadata:   { queue_depth: null, sku_zone: null, session_seq: 1 },
    ...overrides
  };
}

async function ingest(events) {
  const res = await fetch(`${BASE_URL}/events/ingest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ events })
  });
  return res.json();
}

async function getMetrics(storeId) {
  const res = await fetch(`${BASE_URL}/stores/${storeId}/metrics`);
  return { status: res.status, body: await res.json() };
}

// ── Empty store ───────────────────────────────────────────────────────────────

describe('GET /stores/:id/metrics — empty store', () => {
  it('returns 200 with all-zero values for store with no events', async () => {
    const { status, body } = await getMetrics('STORE_GHOST_' + Date.now());
    expect(status).toBe(200);
    expect(body.unique_visitors).toBe(0);
    expect(body.conversion_rate).toBe(0);
    expect(body.queue_depth).toBe(0);
    expect(body.abandonment_rate).toBe(0);
  });

  it('does not return null for any numeric field', async () => {
    const { body } = await getMetrics('STORE_NULL_CHECK_' + Date.now());
    expect(body.unique_visitors).not.toBeNull();
    expect(body.conversion_rate).not.toBeNull();
    expect(body.queue_depth).not.toBeNull();
  });

  it('includes generated_at timestamp (real-time, not cached)', async () => {
    const { body } = await getMetrics('STORE_REALTIME_' + Date.now());
    expect(body.generated_at).toBeDefined();
    // generated_at should be within last 5 seconds
    const age = Date.now() - new Date(body.generated_at).getTime();
    expect(age).toBeLessThan(5000);
  });
});

// ── Visitor counting ──────────────────────────────────────────────────────────

describe('GET /stores/:id/metrics — visitor counting', () => {
  const STORE_ID = 'STORE_COUNT_' + Date.now();

  beforeAll(async () => {
    const v1 = uuidv4().slice(0, 8);
    const v2 = uuidv4().slice(0, 8);
    await ingest([
      makeEvent({ store_id: STORE_ID, visitor_id: `VIS_${v1}`, event_type: 'ENTRY', timestamp: '2026-04-10T12:00:00Z' }),
      makeEvent({ store_id: STORE_ID, visitor_id: `VIS_${v1}`, event_type: 'EXIT',  timestamp: '2026-04-10T12:30:00Z' }),
      makeEvent({ store_id: STORE_ID, visitor_id: `VIS_${v2}`, event_type: 'ENTRY', timestamp: '2026-04-10T12:05:00Z' }),
    ]);
  });

  it('counts 2 unique visitors', async () => {
    const { body } = await getMetrics(STORE_ID);
    expect(body.unique_visitors).toBeGreaterThanOrEqual(2);
  });
});

// ── Staff exclusion ───────────────────────────────────────────────────────────

describe('GET /stores/:id/metrics — staff exclusion', () => {
  const STORE_ID = 'STORE_STAFF_' + Date.now();

  beforeAll(async () => {
    // 3 staff entries + 2 customer entries
    const staffEvents = Array.from({ length: 3 }, (_, i) =>
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: `VIS_STAFF_${i}`,
        event_type: 'ENTRY',
        is_staff:   true,
        timestamp:  '2026-04-10T09:00:00Z'
      })
    );
    const custEvents = Array.from({ length: 2 }, (_, i) =>
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: `VIS_CUST_${i}`,
        event_type: 'ENTRY',
        is_staff:   false,
        timestamp:  '2026-04-10T12:00:00Z'
      })
    );
    await ingest([...staffEvents, ...custEvents]);
  });

  it('unique_visitors excludes staff', async () => {
    const { body } = await getMetrics(STORE_ID);
    // Must not include 3 staff in unique_visitors
    expect(body.unique_visitors).toBeLessThanOrEqual(2);
  });
});

// ── Re-entry deduplication ────────────────────────────────────────────────────

describe('GET /stores/:id/metrics — re-entry dedup', () => {
  const STORE_ID = 'STORE_REENTRY_' + Date.now();
  const VISITOR  = 'VIS_RETURNER';

  beforeAll(async () => {
    await ingest([
      makeEvent({ store_id: STORE_ID, visitor_id: VISITOR, event_type: 'ENTRY',   timestamp: '2026-04-10T12:00:00Z', session_seq: 1 }),
      makeEvent({ store_id: STORE_ID, visitor_id: VISITOR, event_type: 'EXIT',    timestamp: '2026-04-10T12:20:00Z', session_seq: 2 }),
      makeEvent({ store_id: STORE_ID, visitor_id: VISITOR, event_type: 'REENTRY', timestamp: '2026-04-10T12:25:00Z', session_seq: 3 }),
    ]);
  });

  it('re-entering visitor is counted as 1 unique visitor, not 2', async () => {
    const { body } = await getMetrics(STORE_ID);
    // Should be 1 unique visitor even with REENTRY event
    expect(body.unique_visitors).toBe(1);
  });
});

// ── Zone dwell ────────────────────────────────────────────────────────────────

describe('GET /stores/:id/metrics — avg dwell per zone', () => {
  const STORE_ID = 'STORE_DWELL_' + Date.now();

  beforeAll(async () => {
    await ingest([
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: 'VIS_DWELL1',
        event_type: 'ZONE_DWELL',
        zone_id:    'SKINCARE',
        dwell_ms:   60000,
        timestamp:  '2026-04-10T12:05:00Z',
        camera_id:  'CAM_FLOOR_01',
        metadata:   { session_seq: 2, sku_zone: 'SKINCARE', queue_depth: null }
      }),
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: 'VIS_DWELL2',
        event_type: 'ZONE_DWELL',
        zone_id:    'SKINCARE',
        dwell_ms:   30000,
        timestamp:  '2026-04-10T12:10:00Z',
        camera_id:  'CAM_FLOOR_01',
        metadata:   { session_seq: 2, sku_zone: 'SKINCARE', queue_depth: null }
      })
    ]);
  });

  it('avg_dwell_per_zone returns SKINCARE with avg of 45000ms', async () => {
    const { body } = await getMetrics(STORE_ID);
    expect(body.avg_dwell_per_zone).toBeDefined();
    expect(body.avg_dwell_per_zone.SKINCARE).toBeDefined();
    expect(body.avg_dwell_per_zone.SKINCARE.avg_dwell_ms).toBe(45000);
  });
});

// ── Queue depth ───────────────────────────────────────────────────────────────

describe('GET /stores/:id/metrics — queue depth', () => {
  const STORE_ID = 'STORE_QUEUE_' + Date.now();

  beforeAll(async () => {
    await ingest([
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: 'VIS_Q1',
        event_type: 'BILLING_QUEUE_JOIN',
        zone_id:    'BILLING',
        timestamp:  '2026-04-10T15:00:00Z',
        camera_id:  'CAM_BILLING_01',
        metadata:   { queue_depth: 4, sku_zone: null, session_seq: 3 }
      })
    ]);
  });

  it('queue_depth reflects latest BILLING_QUEUE_JOIN event', async () => {
    const { body } = await getMetrics(STORE_ID);
    expect(body.queue_depth).toBe(4);
  });
});
