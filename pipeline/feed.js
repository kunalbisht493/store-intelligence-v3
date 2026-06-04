// pipeline/feed.js
// Reads events.jsonl and POSTs them to POST /events/ingest in batches
// Supports real-time simulation mode: --realtime flag replays events at original speed
// Usage:
//   node pipeline/feed.js                     # batch mode (fast)
//   node pipeline/feed.js --realtime          # simulated real-time

const fs   = require('fs');
const path = require('path');
const http = require('http');

const EVENTS_PATH  = process.env.EVENTS_OUTPUT || path.join(__dirname, '../data/events.jsonl');
const API_URL      = process.env.API_URL || 'http://localhost:3000';
const BATCH_SIZE   = 100;
const REALTIME     = process.argv.includes('--realtime');

async function main() {
  if (!fs.existsSync(EVENTS_PATH)) {
    console.error(`[feed] events.jsonl not found at ${EVENTS_PATH}`);
    console.error('[feed] Run the detection pipeline first: node pipeline/run.js <clips_dir>');
    process.exit(1);
  }

  const lines = fs.readFileSync(EVENTS_PATH, 'utf8')
    .split('\n').filter(Boolean);

  const events = lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  console.log(`[feed] Loaded ${events.length} events from ${EVENTS_PATH}`);
  console.log(`[feed] Mode: ${REALTIME ? 'real-time simulation' : 'batch'}`);
  console.log(`[feed] Target API: ${API_URL}`);

  if (REALTIME) {
    await feedRealtime(events);
  } else {
    await feedBatch(events);
  }
}

// Batch mode — send all events as fast as possible in batches of BATCH_SIZE
async function feedBatch(events) {
  let sent = 0;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const result = await postEvents(batch);
    sent += result.accepted || 0;
    process.stdout.write(`\r[feed] Sent ${sent}/${events.length} events...`);
  }
  console.log(`\n[feed] ✓ Done. ${sent} events accepted.`);
}

// Real-time mode — replay events at original speed using timestamp gaps
async function feedRealtime(events) {
  if (events.length === 0) return;

  const firstTs = new Date(events[0].timestamp).getTime();
  const startedAt = Date.now();
  let batch = [];
  let sent = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const eventOffsetMs = new Date(event.timestamp).getTime() - firstTs;
    const targetMs = startedAt + eventOffsetMs;
    const now = Date.now();

    // Wait until the event's relative time has passed
    if (targetMs > now) {
      if (batch.length > 0) {
        await postEvents(batch);
        sent += batch.length;
        process.stdout.write(`\r[feed] Real-time: ${sent}/${events.length} events...`);
        batch = [];
      }
      await sleep(targetMs - now);
    }

    batch.push(event);

    // Flush batch at BATCH_SIZE or end
    if (batch.length >= BATCH_SIZE || i === events.length - 1) {
      await postEvents(batch);
      sent += batch.length;
      process.stdout.write(`\r[feed] Real-time: ${sent}/${events.length} events...`);
      batch = [];
    }
  }

  console.log(`\n[feed] ✓ Real-time feed complete. ${sent} events sent.`);
}

function postEvents(events) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ events });
    const url = new URL('/events/ingest', API_URL);

    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 3000,
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
    });

    req.on('error', err => {
      console.error('\n[feed] API request failed:', err.message);
      resolve({ accepted: 0, error: err.message });
    });

    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('[feed] Fatal:', err);
  process.exit(1);
});
