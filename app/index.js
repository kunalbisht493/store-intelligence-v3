// app/index.js
require('dotenv').config();
if (process.env.FFMPEG_BIN) process.env.PATH = process.env.PATH + ';' + process.env.FFMPEG_BIN;

const fastify = require('fastify')({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined
  },
  genReqId: () => require('uuid').v4()
});


fastify.register(require('@fastify/cors'), { origin: '*' });
fastify.register(require('@fastify/static'), {
  root:require('path').join(__dirname, '../dashboard'),
  prefix: '/'
});

// ── Startup ──────────────────────────────────────────────────────────────────
fastify.addHook('onReady', async () => {
  require('./db').getDb();
  require('./services/pos').loadPosData();
  fastify.log.info('[startup] DB and POS data ready');
});

// ── Request logging ──────────────────────────────────────────────────────────
fastify.addHook('onResponse', (request, reply, done) => {
  request.log.info({
    trace_id:    request.id,
    method:      request.method,
    url:         request.url,
    status_code: reply.statusCode,
    latency_ms:  Math.round(reply.elapsedTime)
  });
  done();
});

// ── Root redirect → dashboard ─────────────────────────────────────────────────
fastify.get('/', async (req, reply) => {
  return reply.redirect('/index.html');
});
// ── Routes ───────────────────────────────────────────────────────────────────
fastify.register(require('./routes/health'));
fastify.register(require('./routes/ingest'));
fastify.register(require('./routes/metrics'));
fastify.register(require('./routes/funnel'));
fastify.register(require('./routes/heatmap'));
fastify.register(require('./routes/anomalies'));

// ── Acceptance gate alias: STORE_BLR_002 → ST1008 ────────────────────────────
// Problem statement checks GET /stores/STORE_BLR_002/metrics
fastify.addHook('onRequest', async (request) => {
  if (request.url.includes('STORE_BLR_002')) {
    request.url = request.url.replace('STORE_BLR_002', 'ST1008');
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  request.log.error({ trace_id: request.id, error: error.message, code: error.code });
  reply.code(error.statusCode || 500).send({
    error:    error.code || 'INTERNAL_ERROR',
    message:  error.message,
    trace_id: request.id
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

fastify.listen({ port: PORT, host: HOST }, (err) => {
  if (err) { fastify.log.error(err); process.exit(1); }
  fastify.log.info(`Store Intelligence API running on ${HOST}:${PORT}`);
});

module.exports = fastify;
