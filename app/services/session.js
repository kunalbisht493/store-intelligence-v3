// app/services/session.js
const { getDb } = require('../db');

function getUniqueVisitors(storeId, date) {
  const db = getDb();
  return db.prepare(`
    SELECT COUNT(DISTINCT visitor_id) as count FROM events
    WHERE store_id = ? AND event_type = 'ENTRY'
      AND timestamp LIKE ? AND is_staff = 0
  `).get(storeId, `${date}%`).count;
}

function getCurrentQueueDepth(storeId) {
  const db = getDb();
  const result = db.prepare(`
    SELECT queue_depth FROM events
    WHERE store_id = ? AND event_type = 'BILLING_QUEUE_JOIN'
      AND queue_depth IS NOT NULL
    ORDER BY timestamp DESC LIMIT 1
  `).get(storeId);
  return result?.queue_depth ?? 0;
}

function getAbandonmentRate(storeId, date) {
  const db = getDb();
  const joined = db.prepare(`
    SELECT COUNT(DISTINCT visitor_id) as c FROM events
    WHERE store_id = ? AND event_type = 'BILLING_QUEUE_JOIN' AND timestamp LIKE ?
  `).get(storeId, `${date}%`).c;
  const abandoned = db.prepare(`
    SELECT COUNT(DISTINCT visitor_id) as c FROM events
    WHERE store_id = ? AND event_type = 'BILLING_QUEUE_ABANDON' AND timestamp LIKE ?
  `).get(storeId, `${date}%`).c;
  if (joined === 0) return 0;
  return Math.round((abandoned / joined) * 100);
}

function getAvgDwellPerZone(storeId, date) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT zone_id, AVG(dwell_ms) as avg_dwell, COUNT(*) as visits
    FROM events
    WHERE store_id = ? AND event_type = 'ZONE_DWELL'
      AND zone_id IS NOT NULL AND timestamp LIKE ? AND is_staff = 0
    GROUP BY zone_id
  `).all(storeId, `${date}%`);
  const result = {};
  for (const row of rows) {
    result[row.zone_id] = {
      avg_dwell_ms: Math.round(row.avg_dwell),
      visit_count: row.visits
    };
  }
  return result;
}

function getConversionRate(storeId, date) {
  const db = getDb();

  const total = db.prepare(`
    SELECT COUNT(DISTINCT visitor_id) as c
    FROM events
    WHERE store_id = ?
      AND event_type = 'ENTRY'
      AND timestamp LIKE ?
      AND is_staff = 0
  `).get(storeId, `${date}%`).c;

  if (total === 0) {
    return { rate: 0, converted: 0, total: 0 };
  }

  const converted = db.prepare(`
    SELECT COUNT(DISTINCT visitor_id) as c
    FROM events
    WHERE store_id = ?
      AND zone_id LIKE '%BILLING%'
      AND timestamp LIKE ?
      AND is_staff = 0
  `).get(storeId, `${date}%`).c;

  const finalConverted = Math.min(converted, total);

  return {
    rate: Number((finalConverted / total).toFixed(4)),
    converted: finalConverted,
    total
  };
}

function markPurchased(sessionId) {
  getDb().prepare(`UPDATE sessions SET purchased = 1, updated_at = datetime('now') WHERE session_id = ?`).run(sessionId);
}

module.exports = {
  getUniqueVisitors, getCurrentQueueDepth, getAbandonmentRate,
  getAvgDwellPerZone, getConversionRate, markPurchased
};