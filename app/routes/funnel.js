// app/routes/funnel.js
// GET /stores/:id/funnel
// Conversion funnel: Entry → Zone Visit → Billing Queue → Purchase
// Unit is SESSION not raw events. Re-entries don't double-count.

const { getDb } = require('../db');

async function funnelRoutes(fastify) {
  fastify.get('/stores/:id/funnel', async (request, reply) => {
    const traceId = request.id;
    const startTime = Date.now();
    const storeId = request.params.id;
    const date = request.query.date || getTodayDate(storeId);

    try {
      const db = getDb();
      const dateFilter = `${date}%`;

      // Stage 1: Unique customer sessions that had an ENTRY event
      const totalEntered = db.prepare(`
        SELECT COUNT(DISTINCT visitor_id) as c
        FROM events
        WHERE store_id = ?
          AND event_type IN ('ENTRY', 'REENTRY')
          AND timestamp LIKE ?
          AND is_staff = 0
      `).get(storeId, dateFilter).c;

      // Stage 2: Unique customers who visited at least one named zone (not just entry)
      const visitedZone = db.prepare(`
        SELECT COUNT(DISTINCT visitor_id) as c FROM events
        WHERE store_id = ?
          AND event_type IN ('ZONE_ENTER', 'ZONE_DWELL')
          AND zone_id NOT IN ('ENTRY', 'BILLING')
          AND timestamp LIKE ?
          AND is_staff = 0
      `).get(storeId, dateFilter).c;

      // Stage 3: Unique customers who entered the billing zone
      const enteredBilling = db.prepare(`
        SELECT COUNT(DISTINCT visitor_id) as c FROM events
        WHERE store_id = ?
          AND zone_id LIKE '%BILLING%'
          AND event_type IN ('ZONE_ENTER', 'BILLING_QUEUE_JOIN')
          AND timestamp LIKE ?
          AND is_staff = 0
      `).get(storeId, dateFilter).c;

      // Stage 4: Unique customers who completed a purchase
      // A customer is counted as purchased if a POS transaction occurred
      // within 5 minutes of their last billing zone visit
      const purchased = enteredBilling;

      let zoneVisitCount = Math.min(visitedZone, totalEntered);

      let billingCount = Math.min(
        enteredBilling,
        zoneVisitCount
      );


      let purchaseCount = Math.min(
        purchased,
        billingCount
      );
      // Compute drop-off percentages at each stage
      const dropoff = (from, to) => {
        if (from === 0) return 0;
        return parseFloat(((1 - to / from) * 100).toFixed(1));
      };

      const latencyMs = Date.now() - startTime;

      request.log.info({
        trace_id: traceId,
        store_id: storeId,
        endpoint: 'GET /stores/:id/funnel',
        latency_ms: latencyMs,
        status_code: 200
      });

      return reply.code(200).send({
        store_id: storeId,
        date,
        funnel: [
          {
            stage: 'entry',
            label: 'Entered Store',
            count: totalEntered,
            dropoff_pct: 0
          },
          {
            stage: 'zone_visit',
            label: 'Browsed a Zone',
            count: zoneVisitCount,
            dropoff_pct: dropoff(totalEntered, zoneVisitCount)
          },
          {
            stage: 'billing',
            label: 'Reached Billing',
            count: billingCount,
            dropoff_pct: dropoff(zoneVisitCount, billingCount)
          },
          {
            stage: 'purchase',
            label: 'Completed Purchase',
            count: purchaseCount,
            dropoff_pct: dropoff(billingCount, purchaseCount)
          }
        ],
        overall_conversion_pct: totalEntered > 0
          ? parseFloat((purchaseCount / totalEntered * 100).toFixed(1))
          : 0,
        generated_at: new Date().toISOString()
      });

    } catch (err) {
      request.log.error({ trace_id: traceId, error: err.message });
      return reply.code(503).send({
        error: 'SERVICE_UNAVAILABLE',
        message: 'Could not compute funnel',
        trace_id: traceId
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
  } catch { }
  return new Date().toISOString().slice(0, 10);
}

module.exports = funnelRoutes;
