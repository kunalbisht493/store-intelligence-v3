// app/routes/anomalies.js
// GET /stores/:id/anomalies
// Detects: BILLING_QUEUE_SPIKE, CONVERSION_DROP, DEAD_ZONE
// Severity: INFO / WARN / CRITICAL

const { getDb } = require('../db');

async function anomalyRoutes(fastify) {
  fastify.get('/stores/:id/anomalies', async (request, reply) => {
    const traceId = request.id;
    const startTime = Date.now();
    const storeId = request.params.id;

    try {
      const anomalies = [];

      anomalies.push(...detectQueueSpike(storeId));
      anomalies.push(...detectDeadZones(storeId));
      anomalies.push(...detectConversionDrop(storeId));

      const latencyMs = Date.now() - startTime;

      request.log.info({
        trace_id: traceId, store_id: storeId,
        endpoint: 'GET /stores/:id/anomalies',
        latency_ms: latencyMs, status_code: 200,
        anomaly_count: anomalies.length
      });

      return reply.code(200).send({
        store_id:    storeId,
        anomaly_count: anomalies.length,
        anomalies,
        generated_at: new Date().toISOString()
      });

    } catch (err) {
      request.log.error({ trace_id: traceId, error: err.message });
      return reply.code(503).send({
        error: 'SERVICE_UNAVAILABLE', message: 'Could not compute anomalies', trace_id: traceId
      });
    }
  });
}

// ── Detector 1: Queue Spike ────────────────────────────────────────────────────
function detectQueueSpike(storeId) {
  const db = getDb();
  const SPIKE_THRESHOLD = 5;
  const CRITICAL_THRESHOLD = 10;

  const recent = db.prepare(`
    SELECT queue_depth, timestamp FROM events
    WHERE store_id = ?
      AND event_type = 'BILLING_QUEUE_JOIN'
      AND queue_depth IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT 10
  `).all(storeId);

  if (recent.length === 0) return [];

  const maxDepth = Math.max(...recent.map(r => r.queue_depth));
  if (maxDepth < SPIKE_THRESHOLD) return [];

  const severity = maxDepth >= CRITICAL_THRESHOLD ? 'CRITICAL' : 'WARN';

  return [{
    anomaly_type:     'BILLING_QUEUE_SPIKE',
    severity,
    title:            'Billing queue depth spike detected',
    description:      `Queue depth reached ${maxDepth} in the last 10 events`,
    queue_depth:      maxDepth,
    detected_at:      recent[0]?.timestamp,
    suggested_action: severity === 'CRITICAL'
      ? 'Open additional billing counter immediately. Consider redirecting staff.'
      : 'Monitor queue — consider moving a staff member to billing.'
  }];
}

// ── Detector 2: Dead Zones ─────────────────────────────────────────────────────
function detectDeadZones(storeId) {
  const db = getDb();
  const DEAD_THRESHOLD_MINUTES = 30;

  const zones = db.prepare(`
    SELECT zone_id, MAX(timestamp) as last_visit
    FROM events
    WHERE store_id = ?
      AND event_type IN ('ZONE_ENTER', 'ZONE_DWELL')
      AND zone_id NOT IN ('ENTRY', 'BILLING')
      AND is_staff = 0
    GROUP BY zone_id
  `).all(storeId);

  const anomalies = [];
  const now = new Date();

  for (const zone of zones) {
    if (!zone.last_visit) continue;
    const lastVisit = new Date(zone.last_visit);
    const minutesSince = (now - lastVisit) / 60000;

    if (minutesSince >= DEAD_THRESHOLD_MINUTES) {
      const severity = minutesSince >= 60 ? 'WARN' : 'INFO';
      anomalies.push({
        anomaly_type:     'DEAD_ZONE',
        severity,
        title:            `No visits to ${zone.zone_id} in ${Math.round(minutesSince)} minutes`,
        description:      `Zone ${zone.zone_id} has had no customer visits since ${zone.last_visit}`,
        zone_id:          zone.zone_id,
        minutes_inactive: Math.round(minutesSince),
        detected_at:      new Date().toISOString(),
        suggested_action: `Check if ${zone.zone_id} zone display or signage needs attention. Confirm camera feed is active.`
      });
    }
  }

  return anomalies;
}

// ── Detector 3: Conversion Drop ────────────────────────────────────────────────
function detectConversionDrop(storeId) {
  const db = getDb();

  // Get today's conversion rate
  const todayDate = getTodayDate(storeId);
  const todayVisitors = db.prepare(`
    SELECT COUNT(DISTINCT visitor_id) as c FROM sessions
    WHERE store_id = ? AND entry_time LIKE ? AND is_staff = 0
  `).get(storeId, `${todayDate}%`).c;

  const todayPurchased = db.prepare(`
    SELECT COUNT(DISTINCT e.visitor_id) as c
    FROM events e
    INNER JOIN pos_transactions p
      ON p.store_id = e.store_id
      AND p.order_datetime >= e.timestamp
      AND p.order_datetime <= datetime(e.timestamp, '+5 minutes')
    WHERE e.store_id = ?
      AND e.zone_id = 'BILLING'
      AND e.timestamp LIKE ?
      AND e.is_staff = 0
  `).get(storeId, `${todayDate}%`).c;

  if (todayVisitors === 0) return [];

  const todayRate = todayPurchased / todayVisitors;

  // Get 7-day rolling average (from events data)
  const historicRows = db.prepare(`
    SELECT DATE(timestamp) as day,
           COUNT(DISTINCT visitor_id) as visitors
    FROM events
    WHERE store_id = ?
      AND event_type = 'ENTRY'
      AND is_staff = 0
      AND timestamp < ?
    GROUP BY day
    ORDER BY day DESC
    LIMIT 7
  `).all(storeId, `${todayDate}T00:00:00Z`);

  // If we don't have enough history, skip
  if (historicRows.length < 3) return [];

  const avgHistoricRate = historicRows.reduce((sum, r) => {
    return sum + (r.visitors > 0 ? 1 / r.visitors : 0); // rough proxy
  }, 0) / historicRows.length;

  const DROP_THRESHOLD = 0.20; // 20% drop
  if (avgHistoricRate > 0 && (avgHistoricRate - todayRate) / avgHistoricRate >= DROP_THRESHOLD) {
    const dropPct = Math.round(((avgHistoricRate - todayRate) / avgHistoricRate) * 100);
    return [{
      anomaly_type:     'CONVERSION_DROP',
      severity:         dropPct >= 40 ? 'CRITICAL' : 'WARN',
      title:            `Conversion rate ${dropPct}% below 7-day average`,
      description:      `Today's rate ${(todayRate * 100).toFixed(1)}% vs ${(avgHistoricRate * 100).toFixed(1)}% average`,
      today_rate:       parseFloat(todayRate.toFixed(4)),
      avg_7day_rate:    parseFloat(avgHistoricRate.toFixed(4)),
      drop_pct:         dropPct,
      detected_at:      new Date().toISOString(),
      suggested_action: 'Review staff levels, check for product stock issues, verify POS system is working correctly.'
    }];
  }

  return [];
}

function getTodayDate(storeId) {
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const row = db.prepare(
      `SELECT timestamp FROM events WHERE store_id = ? ORDER BY timestamp DESC LIMIT 1`
    ).get(storeId);
    if (row?.timestamp) return row.timestamp.slice(0, 10);
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

module.exports = anomalyRoutes;
