# Store Intelligence — Brigade Road Bangalore

End-to-end store analytics: CCTV footage → structured events → live metrics API.

**Store:** Brigade_Bangalore (ST1008) · **Date:** 10 April 2026

---

## 5-Command Setup

```bash
# 1. Clone the repo
git clone <your-repo-url> && cd store-intelligence

# 2. Copy your data files into place
cp /path/to/Brigade_Bangalore_10_April_26_1.csv data/
cp /path/to/clips ./clips        # folder containing entry.mp4, floor.mp4, billing.mp4

# 3. Start the API
docker compose up --build

# 4. Run the detection pipeline against the clips
node pipeline/run.js ./clips/ST1008

# 5. Feed events into the API
node pipeline/feed.js
```

API is now live at **http://localhost:3000**
Dashboard at **http://localhost:3000/dashboard**

---

## Detection Pipeline

The pipeline processes 3 CCTV clips per store and emits structured events to `data/events.jsonl`.

### How It Works

```
entry.mp4 + floor.mp4 + billing.mp4
         ↓
  node pipeline/run.js ./clips/ST1008
         ↓
  data/events.jsonl  (sorted by timestamp)
         ↓
  node pipeline/feed.js
         ↓
  POST /events/ingest  (batches of 100)
```

### Clip Naming Convention

The pipeline matches clips by filename pattern:

| Camera | Expected filename contains |
|---|---|
| `CAM_ENTRY_01` | `entry` |
| `CAM_FLOOR_01` | `floor` |
| `CAM_BILLING_01` | `billing` |

Example: `ST1008_entry.mp4`, `ST1008_floor.mp4`, `ST1008_billing.mp4`

### Real-time Simulation (Part E)

To replay events at original speed (for the live dashboard):

```bash
node pipeline/feed.js --realtime
```

This replays events in the same time proportions as the original recording while the dashboard updates live at http://localhost:3000/dashboard.

---

## API Endpoints

### Health

```bash
curl http://localhost:3000/health
```

### Metrics

```bash
curl http://localhost:3000/stores/ST1008/metrics
# Returns: unique_visitors, conversion_rate, avg_dwell_per_zone, queue_depth, abandonment_rate
```

### Funnel

```bash
curl http://localhost:3000/stores/ST1008/funnel
# Returns: Entry → Zone Visit → Billing → Purchase with counts and drop-off %
```

### Heatmap

```bash
curl http://localhost:3000/stores/ST1008/heatmap
# Returns: zone visit frequency + avg dwell, normalised 0-100
```

### Anomalies

```bash
curl http://localhost:3000/stores/ST1008/anomalies
# Returns: active anomalies with severity (INFO/WARN/CRITICAL) and suggested_action
```

### Ingest (manual test)

```bash
curl -X POST http://localhost:3000/events/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "event_id": "550e8400-e29b-41d4-a716-446655440000",
      "store_id": "ST1008",
      "camera_id": "CAM_ENTRY_01",
      "visitor_id": "VIS_abc123",
      "event_type": "ENTRY",
      "timestamp": "2026-04-10T12:00:00Z",
      "zone_id": null,
      "dwell_ms": 0,
      "is_staff": false,
      "confidence": 0.92,
      "metadata": { "queue_depth": null, "sku_zone": null, "session_seq": 1 }
    }]
  }'
```

---

## Running Tests

```bash
# Install dev dependencies first (outside Docker)
npm install

# Run tests (requires API running on localhost:3000)
npm test

# With coverage report
npm run test:coverage
```

---

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for full architecture with AI-assisted decisions.
See [docs/CHOICES.md](docs/CHOICES.md) for the 3 key engineering decisions with trade-off reasoning.

---

## Stack

| Layer | Tech |
|---|---|
| API | Fastify + Node.js 20 |
| Validation | Zod |
| Storage | better-sqlite3 (SQLite WAL) |
| Detection | YOLOv8n ONNX via onnxruntime-node |
| Tracking | ByteTrack (custom JS implementation) |
| Logging | pino (structured JSON, trace_id per request) |
| Tests | Vitest |
| Container | Docker + Compose |
| Dashboard | Vanilla HTML/JS polling `/metrics` every 2s |
