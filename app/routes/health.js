// app/routes/health.js
// GET /health
// Service status, last event timestamp per store, STALE_FEED warning if >10 min lag

const { getDb } = require('../db');

async function healthRoutes(fastify) {
  fastify.get('/health', async (request, reply) => {
    const traceId = request.id;
    const startTime = Date.now();

    try {
      const db = getDb();

      // Check DB is responsive
      db.prepare('SELECT 1').get();

      // Get last event timestamp per store
      const storeFeeds = db.prepare(`
        SELECT store_id, MAX(timestamp) as last_event, COUNT(*) as total_events
        FROM events
        GROUP BY store_id
      `).all();

      const now = new Date();
      const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

      const feeds = storeFeeds.map(feed => {
        const lastEvent = feed.last_event ? new Date(feed.last_event) : null;
        const lagMs = lastEvent ? now - lastEvent : null;
        const isStale = lagMs !== null && lagMs > STALE_THRESHOLD_MS;

        return {
          store_id:     feed.store_id,
          last_event:   feed.last_event || null,
          total_events: feed.total_events,
          lag_ms:       lagMs ? Math.round(lagMs) : null,
          status:       isStale ? 'STALE_FEED' : 'OK'
        };
      });

      const hasStale = feeds.some(f => f.status === 'STALE_FEED');
      const latencyMs = Date.now() - startTime;

      request.log.info({
        trace_id: traceId,
        endpoint: 'GET /health',
        latency_ms: latencyMs,
        status_code: 200
      });

      return reply.code(200).send({
        status:      hasStale ? 'DEGRADED' : 'OK',
        db_status:   'OK',
        stores:      feeds,
        checked_at:  new Date().toISOString(),
        latency_ms:  latencyMs
      });

    } catch (err) {
      request.log.error({ trace_id: traceId, error: err.message });
      // Return 503 with structured body — never raw stack traces
      return reply.code(503).send({
        status:    'UNAVAILABLE',
        db_status: 'ERROR',
        message:   'Database unavailable',
        trace_id:  traceId,
        checked_at: new Date().toISOString()
      });
    }
  });
}

module.exports = healthRoutes;
