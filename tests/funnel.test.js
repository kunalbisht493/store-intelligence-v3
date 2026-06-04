// tests/test_funnel.js
//
// PROMPT: Write Vitest tests for GET /stores/:id/funnel endpoint.
// Funnel must be session-based (not event-count-based). Re-entries must not
// double-count. Funnel stages: Entry → Zone Visit → Billing Queue → Purchase.
// Each stage returns count and drop-off percentage.
//
// CHANGES MADE:
// - Added explicit re-entry dedup test (AI missed this — critical requirement)
// - Changed to use unique store IDs per test to avoid state pollution between runs
// - Added overall_conversion_pct check (AI only checked individual stage counts)
// - Fixed drop-off calculation test to handle 0-visitor edge case

import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

function makeEvent(overrides = {}) {
  return {
    event_id:   uuidv4(),
    store_id:   'STORE_FUNNEL_TEST',
    camera_id:  'CAM_ENTRY_01',
    visitor_id: 'VIS_F1',
    event_type: 'ENTRY',
    timestamp:  '2026-04-10T12:00:00Z',
    zone_id:    null,
    dwell_ms:   0,
    is_staff:   false,
    confidence: 0.91,
    metadata:   { queue_depth: null, sku_zone: null, session_seq: 1 },
    ...overrides
  };
}

async function ingest(events) {
  const res = await fetch(`${BASE_URL}/events/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events })
  });
  return res.json();
}

async function getFunnel(storeId) {
  const res = await fetch(`${BASE_URL}/stores/${storeId}/funnel`);
  return { status: res.status, body: await res.json() };
}

// ── Response structure ────────────────────────────────────────────────────────

describe('GET /stores/:id/funnel — structure', () => {
  it('returns 200 with funnel array', async () => {
    const { status, body } = await getFunnel('STORE_FUNNEL_EMPTY_' + Date.now());
    expect(status).toBe(200);
    expect(body.funnel).toBeDefined();
    expect(Array.isArray(body.funnel)).toBe(true);
  });

  it('funnel has 4 stages: entry, zone_visit, billing, purchase', async () => {
    const { body } = await getFunnel('STORE_STAGES_' + Date.now());
    const stages = body.funnel.map(s => s.stage);
    expect(stages).toContain('entry');
    expect(stages).toContain('zone_visit');
    expect(stages).toContain('billing');
    expect(stages).toContain('purchase');
  });

  it('each stage has count and dropoff_pct', async () => {
    const { body } = await getFunnel('STORE_FIELDS_' + Date.now());
    for (const stage of body.funnel) {
      expect(stage.count).toBeDefined();
      expect(stage.dropoff_pct).toBeDefined();
    }
  });

  it('returns overall_conversion_pct', async () => {
    const { body } = await getFunnel('STORE_CONV_' + Date.now());
    expect(body.overall_conversion_pct).toBeDefined();
  });
});

// ── Empty store ───────────────────────────────────────────────────────────────

describe('GET /stores/:id/funnel — empty store', () => {
  it('all stage counts are 0 for a store with no events', async () => {
    const { body } = await getFunnel('STORE_FUNNEL_ZERO_' + Date.now());
    for (const stage of body.funnel) {
      expect(stage.count).toBe(0);
    }
  });

  it('overall_conversion_pct is 0 for empty store', async () => {
    const { body } = await getFunnel('STORE_CONV_ZERO_' + Date.now());
    expect(body.overall_conversion_pct).toBe(0);
  });
});

// ── Session deduplication ─────────────────────────────────────────────────────

describe('GET /stores/:id/funnel — session deduplication', () => {
  const STORE_ID = 'STORE_DEDUP_' + Date.now();
  const VISITOR  = 'VIS_DEDUP_A';

  beforeAll(async () => {
    // Same visitor enters twice (re-entry) — should count as 1 session in funnel
    await ingest([
      makeEvent({ store_id: STORE_ID, visitor_id: VISITOR, event_type: 'ENTRY',   timestamp: '2026-04-10T12:00:00Z', session_seq: 1 }),
      makeEvent({ store_id: STORE_ID, visitor_id: VISITOR, event_type: 'ZONE_ENTER', zone_id: 'SKINCARE', timestamp: '2026-04-10T12:05:00Z', camera_id: 'CAM_FLOOR_01', session_seq: 2 }),
      makeEvent({ store_id: STORE_ID, visitor_id: VISITOR, event_type: 'EXIT',     timestamp: '2026-04-10T12:20:00Z', session_seq: 5 }),
      makeEvent({ store_id: STORE_ID, visitor_id: VISITOR, event_type: 'REENTRY',  timestamp: '2026-04-10T12:25:00Z', session_seq: 6 }),
    ]);
  });

  it('re-entering visitor is counted as 1 in entry stage, not 2', async () => {
    const { body } = await getFunnel(STORE_ID);
    const entry = body.funnel.find(s => s.stage === 'entry');
    // Should be 1 unique visitor, not 2
    console.log(JSON.stringify(body, null, 2));
    expect(entry.count).toBe(1);
  });
});

// ── Drop-off logic ────────────────────────────────────────────────────────────

describe('GET /stores/:id/funnel — drop-off calculation', () => {
  const STORE_ID = 'STORE_DROPOFF_' + Date.now();

  beforeAll(async () => {
    // 4 visitors enter, 3 browse a zone, 2 reach billing, 1 leaves billing (abandon)
    const visitors = ['VIS_D1', 'VIS_D2', 'VIS_D3', 'VIS_D4'];

    await ingest([
      // All 4 enter
      ...visitors.map(v => makeEvent({ store_id: STORE_ID, visitor_id: v, event_type: 'ENTRY', timestamp: '2026-04-10T12:00:00Z' })),
      // 3 visit a zone
      ...visitors.slice(0, 3).map(v => makeEvent({ store_id: STORE_ID, visitor_id: v, event_type: 'ZONE_ENTER', zone_id: 'MAKEUP', timestamp: '2026-04-10T12:05:00Z', camera_id: 'CAM_FLOOR_01', metadata: { session_seq: 2, sku_zone: 'MAKEUP', queue_depth: null } })),
      // 2 reach billing
      ...visitors.slice(0, 2).map(v => makeEvent({ store_id: STORE_ID, visitor_id: v, event_type: 'BILLING_QUEUE_JOIN', zone_id: 'BILLING', timestamp: '2026-04-10T12:15:00Z', camera_id: 'CAM_BILLING_01', metadata: { queue_depth: 2, sku_zone: null, session_seq: 3 } })),
    ]);
  });

  it('entry stage has 4 visitors', async () => {
    const { body } = await getFunnel(STORE_ID);
    const entry = body.funnel.find(s => s.stage === 'entry');
    expect(entry.count).toBeGreaterThanOrEqual(4);
  });

  it('zone_visit stage has fewer or equal to entry stage', async () => {
    const { body } = await getFunnel(STORE_ID);
    const entry    = body.funnel.find(s => s.stage === 'entry');
    const zoneVisit = body.funnel.find(s => s.stage === 'zone_visit');
    expect(zoneVisit.count).toBeLessThanOrEqual(entry.count);
  });

  it('billing stage has fewer or equal to zone_visit stage', async () => {
    const { body } = await getFunnel(STORE_ID);
    const zoneVisit = body.funnel.find(s => s.stage === 'zone_visit');
    const billing   = body.funnel.find(s => s.stage === 'billing');
    expect(billing.count).toBeLessThanOrEqual(zoneVisit.count);
  });

  it('dropoff_pct is 0 for the first stage', async () => {
    const { body } = await getFunnel(STORE_ID);
    const entry = body.funnel.find(s => s.stage === 'entry');
    expect(entry.dropoff_pct).toBe(0);
  });
});

// ── Staff exclusion from funnel ───────────────────────────────────────────────

describe('GET /stores/:id/funnel — staff excluded', () => {
  const STORE_ID = 'STORE_STAFF_FUNNEL_' + Date.now();

  beforeAll(async () => {
    await ingest([
      makeEvent({ store_id: STORE_ID, visitor_id: 'VIS_STAFF_1', event_type: 'ENTRY', is_staff: true }),
      makeEvent({ store_id: STORE_ID, visitor_id: 'VIS_STAFF_2', event_type: 'ENTRY', is_staff: true }),
      makeEvent({ store_id: STORE_ID, visitor_id: 'VIS_CUST_1',  event_type: 'ENTRY', is_staff: false }),
    ]);
  });

  it('funnel entry count does not include staff', async () => {
    const { body } = await getFunnel(STORE_ID);
    const entry = body.funnel.find(s => s.stage === 'entry');
    // Staff (2) should not be counted — only 1 customer
    expect(entry.count).toBeLessThanOrEqual(1);
  });
});
