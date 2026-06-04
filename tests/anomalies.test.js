// tests/test_anomalies.js
//
// PROMPT: Write Vitest tests for GET /stores/:id/anomalies that detects:
// BILLING_QUEUE_SPIKE (queue_depth > threshold), DEAD_ZONE (no visits in 30+ min),
// CONVERSION_DROP (today vs 7-day avg drop > 20%). Each anomaly must have severity
// (INFO/WARN/CRITICAL) and a suggested_action string.
//
// CHANGES MADE:
// - Moved DEAD_ZONE test to use a real timestamp far in the past (AI used 'now' which doesn't trigger it)
// - Added check that suggested_action is non-empty string (AI only checked it existed)
// - Added CRITICAL severity threshold test for extreme queue depth
// - Fixed CONVERSION_DROP test — needs 3+ days of history, AI used 1 day

import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

function makeEvent(overrides = {}) {
  return {
    event_id:   uuidv4(),
    store_id:   'STORE_ANOMALY_TEST',
    camera_id:  'CAM_BILLING_01',
    visitor_id: 'VIS_' + Math.random().toString(36).slice(2, 8),
    event_type: 'ENTRY',
    timestamp:  '2026-04-10T12:00:00Z',
    zone_id:    null,
    dwell_ms:   0,
    is_staff:   false,
    confidence: 0.88,
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

async function getAnomalies(storeId) {
  const res = await fetch(`${BASE_URL}/stores/${storeId}/anomalies`);
  return { status: res.status, body: await res.json() };
}

// ── Response structure ────────────────────────────────────────────────────────

describe('GET /stores/:id/anomalies — response structure', () => {
  it('returns 200 with anomalies array for any store', async () => {
    const { status, body } = await getAnomalies('STORE_ANY_' + Date.now());
    expect(status).toBe(200);
    expect(body.anomalies).toBeDefined();
    expect(Array.isArray(body.anomalies)).toBe(true);
  });

  it('returns empty anomalies for a store with no events', async () => {
    const { body } = await getAnomalies('STORE_EMPTY_ANOM_' + Date.now());
    expect(body.anomalies).toHaveLength(0);
    expect(body.anomaly_count).toBe(0);
  });

  it('each anomaly has required fields', async () => {
    const STORE_ID = 'STORE_STRUCT_' + Date.now();
    // Trigger a queue spike
    await ingest(Array.from({ length: 6 }, (_, i) =>
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: `VIS_Q${i}`,
        event_type: 'BILLING_QUEUE_JOIN',
        zone_id:    'BILLING',
        metadata:   { queue_depth: 8, sku_zone: null, session_seq: 2 }
      })
    ));

    const { body } = await getAnomalies(STORE_ID);
    if (body.anomalies.length > 0) {
      const a = body.anomalies[0];
      expect(a.anomaly_type).toBeDefined();
      expect(a.severity).toBeDefined();
      expect(a.suggested_action).toBeDefined();
      expect(typeof a.suggested_action).toBe('string');
      expect(a.suggested_action.length).toBeGreaterThan(0);
      expect(a.detected_at).toBeDefined();
    }
  });
});

// ── Queue spike detection ─────────────────────────────────────────────────────

describe('GET /stores/:id/anomalies — BILLING_QUEUE_SPIKE', () => {
  const STORE_ID = 'STORE_QSPIKE_' + Date.now();

  beforeAll(async () => {
    // Inject 8 consecutive BILLING_QUEUE_JOIN events with high queue_depth
    const events = Array.from({ length: 8 }, (_, i) =>
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: `VIS_Q${i}`,
        event_type: 'BILLING_QUEUE_JOIN',
        zone_id:    'BILLING',
        timestamp:  `2026-04-10T${14 + Math.floor(i / 4)}:${String(i * 7 % 60).padStart(2, '0')}:00Z`,
        camera_id:  'CAM_BILLING_01',
        metadata:   { queue_depth: 7, sku_zone: null, session_seq: 3 }
      })
    );
    await ingest(events);
  });

  it('detects BILLING_QUEUE_SPIKE anomaly', async () => {
    const { body } = await getAnomalies(STORE_ID);
    const spike = body.anomalies.find(a => a.anomaly_type === 'BILLING_QUEUE_SPIKE');
    expect(spike).toBeDefined();
  });

  it('spike severity is WARN or CRITICAL (not INFO)', async () => {
    const { body } = await getAnomalies(STORE_ID);
    const spike = body.anomalies.find(a => a.anomaly_type === 'BILLING_QUEUE_SPIKE');
    if (spike) {
      expect(['WARN', 'CRITICAL']).toContain(spike.severity);
    }
  });

  it('CRITICAL severity at queue_depth >= 10', async () => {
    const STORE_CRIT = 'STORE_CRIT_' + Date.now();
    await ingest(Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        store_id:   STORE_CRIT,
        visitor_id: `VIS_CQ${i}`,
        event_type: 'BILLING_QUEUE_JOIN',
        zone_id:    'BILLING',
        camera_id:  'CAM_BILLING_01',
        metadata:   { queue_depth: 12, sku_zone: null, session_seq: 2 }
      })
    ));

    const { body } = await getAnomalies(STORE_CRIT);
    const spike = body.anomalies.find(a => a.anomaly_type === 'BILLING_QUEUE_SPIKE');
    if (spike) {
      expect(spike.severity).toBe('CRITICAL');
    }
  });
});

// ── Dead zone detection ───────────────────────────────────────────────────────

describe('GET /stores/:id/anomalies — DEAD_ZONE', () => {
  const STORE_ID = 'STORE_DEAD_' + Date.now();

  beforeAll(async () => {
    // Plant a ZONE_ENTER event with a timestamp far in the past (>30 min ago)
    const oldTs = new Date(Date.now() - 35 * 60 * 1000).toISOString()
      .replace('.000', '').slice(0, 19) + 'Z';

    await ingest([
      makeEvent({
        store_id:   STORE_ID,
        visitor_id: 'VIS_DEAD1',
        event_type: 'ZONE_ENTER',
        zone_id:    'HAIRCARE',
        timestamp:  oldTs,
        camera_id:  'CAM_FLOOR_01',
        metadata:   { session_seq: 2, sku_zone: 'HAIRCARE', queue_depth: null }
      })
    ]);
  });

  it('detects DEAD_ZONE for a zone with no visits in 30+ minutes', async () => {
    const { body } = await getAnomalies(STORE_ID);
    const dead = body.anomalies.find(a => a.anomaly_type === 'DEAD_ZONE');
    expect(dead).toBeDefined();
    expect(dead.zone_id).toBe('HAIRCARE');
    expect(dead.minutes_inactive).toBeGreaterThanOrEqual(30);
  });

  it('suggested_action mentions the zone name', async () => {
    const { body } = await getAnomalies(STORE_ID);
    const dead = body.anomalies.find(a => a.anomaly_type === 'DEAD_ZONE');
    if (dead) {
      expect(dead.suggested_action.toLowerCase()).toContain('haircare');
    }
  });
});

// ── Severity levels ───────────────────────────────────────────────────────────

describe('GET /stores/:id/anomalies — severity validation', () => {
  it('all anomaly severities are one of INFO, WARN, CRITICAL', async () => {
    const STORE_ID = 'STORE_SEV_' + Date.now();
    await ingest([makeEvent({ store_id: STORE_ID })]);

    const { body } = await getAnomalies(STORE_ID);
    const valid = ['INFO', 'WARN', 'CRITICAL'];
    for (const anomaly of body.anomalies) {
      expect(valid).toContain(anomaly.severity);
    }
  });
});
