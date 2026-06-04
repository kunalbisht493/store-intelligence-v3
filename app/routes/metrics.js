// app/routes/metrics.js
// GET /stores/:id/metrics
// Returns: unique_visitors, conversion_rate, avg_dwell_per_zone, queue_depth, abandonment_rate

const {
  getUniqueVisitors,
  getCurrentQueueDepth,
  getAbandonmentRate,
  getAvgDwellPerZone,
  getConversionRate
} = require('../services/session');

async function metricsRoutes(fastify) {
  fastify.get('/stores/:id/metrics', async (request, reply) => {
    const traceId = request.id;
    const startTime = Date.now();
    const storeId = request.params.id;

    // Default to today based on most recent event, or current date
    const date = request.query.date || getTodayDate(storeId);

    try {
      const [
        unique_visitors,
        queue_depth,
        abandonment_rate,
        avg_dwell_per_zone,
        conversion
      ] = await Promise.all([
        Promise.resolve(getUniqueVisitors(storeId, date)),
        Promise.resolve(getCurrentQueueDepth(storeId)),
        Promise.resolve(getAbandonmentRate(storeId, date)),
        Promise.resolve(getAvgDwellPerZone(storeId, date)),
        Promise.resolve(getConversionRate(storeId, date))
      ]);

      const latencyMs = Date.now() - startTime;

      request.log.info({
        trace_id:   traceId,
        store_id:   storeId,
        endpoint:   'GET /stores/:id/metrics',
        latency_ms: latencyMs,
        status_code: 200
      });

      return reply.code(200).send({
        store_id:          storeId,
        date,
        unique_visitors,
        conversion_rate:   conversion.rate,
        converted_visitors: conversion.converted,
        total_visitors:    conversion.total,
        queue_depth,
        abandonment_rate,
        avg_dwell_per_zone,
        generated_at:      new Date().toISOString()
      });

    } catch (err) {
      request.log.error({ trace_id: traceId, error: err.message });
      return reply.code(503).send({
        error:    'SERVICE_UNAVAILABLE',
        message:  'Could not compute metrics',
        trace_id: traceId
      });
    }
  });
}

// Get today's date in YYYY-MM-DD using last event timestamp if available
function getTodayDate(storeId) {
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const row = db.prepare(`
      SELECT timestamp FROM events WHERE store_id = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(storeId);
    if (row?.timestamp) return row.timestamp.slice(0, 10);
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

module.exports = metricsRoutes;
