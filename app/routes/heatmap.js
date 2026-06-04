// app/routes/heatmap.js
// GET /stores/:id/heatmap
// Zone visit frequency + avg dwell, normalised 0-100

const { getDb } = require('../db');

async function heatmapRoutes(fastify) {
  fastify.get('/stores/:id/heatmap', async (request, reply) => {
    const traceId = request.id;
    const startTime = Date.now();
    const storeId = request.params.id;
    const date = request.query.date || getTodayDate(storeId);

    try {
      const db = getDb();

      const rows = db.prepare(`
        SELECT
          zone_id,
          COUNT(DISTINCT visitor_id) as unique_visitors,
          COUNT(*) as total_events,
          AVG(dwell_ms) as avg_dwell_ms,
          SUM(dwell_ms) as total_dwell_ms
        FROM events
        WHERE store_id = ?
          AND zone_id IS NOT NULL
          AND zone_id != 'ENTRY'
          AND event_type IN ('ZONE_ENTER', 'ZONE_DWELL')
          AND timestamp LIKE ?
          AND is_staff = 0
        GROUP BY zone_id
        ORDER BY unique_visitors DESC
      `).all(storeId, `${date}%`);

      // Count total unique sessions for confidence flag
      const sessionCount = db.prepare(`
        SELECT COUNT(DISTINCT visitor_id) as c FROM sessions
        WHERE store_id = ? AND entry_time LIKE ? AND is_staff = 0
      `).get(storeId, `${date}%`).c;

      const dataConfidence = sessionCount < 20 ? 'LOW' : 'OK';

      // Normalise unique_visitors to 0-100
      const maxVisitors = rows.length > 0
        ? Math.max(...rows.map(r => r.unique_visitors))
        : 1;

      const zones = rows.map(row => ({
        zone_id:          row.zone_id,
        unique_visitors:  row.unique_visitors,
        total_events:     row.total_events,
        avg_dwell_ms:     Math.round(row.avg_dwell_ms || 0),
        total_dwell_ms:   row.total_dwell_ms || 0,
        normalised_score: maxVisitors > 0
          ? Math.round((row.unique_visitors / maxVisitors) * 100)
          : 0
      }));

      const latencyMs = Date.now() - startTime;

      request.log.info({
        trace_id: traceId, store_id: storeId,
        endpoint: 'GET /stores/:id/heatmap',
        latency_ms: latencyMs, status_code: 200
      });

      return reply.code(200).send({
        store_id:        storeId,
        date,
        data_confidence: dataConfidence,
        session_count:   sessionCount,
        zones,
        generated_at:    new Date().toISOString()
      });

    } catch (err) {
      request.log.error({ trace_id: traceId, error: err.message });
      return reply.code(503).send({
        error: 'SERVICE_UNAVAILABLE', message: 'Could not compute heatmap', trace_id: traceId
      });
    }
  });
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

module.exports = heatmapRoutes;
