# DESIGN.md — Store Intelligence System

## Overview

This system converts raw CCTV footage from the Brigade Road Bangalore Purplle store (ST1008) into a live business intelligence API. The north star metric is **offline store conversion rate**: unique visitors who completed a purchase divided by total unique visitors.

## Architecture

```
CCTV Clips (3 cameras)
       │
       ▼
pipeline/detect.js          ← YOLOv8 ONNX via onnxruntime-node, ffmpeg frame extraction
       │
pipeline/tracker.js         ← ByteTrack IoU matching, stable track_id per person per camera
       │
pipeline/reid.js            ← visitor_id assignment, cosine similarity re-entry detection
       │
pipeline/staff.js           ← staff classifier (zone pattern + known names from POS CSV)
       │
pipeline/zones.js           ← pixel (x,y) → zone_id via polygon point-in-polygon
       │
pipeline/emit.js            ← validates + writes events.jsonl (one JSON per line)
       │
pipeline/feed.js            ← HTTP POST to /events/ingest (batch or real-time mode)
       │
       ▼
POST /events/ingest         ← Zod validation, idempotent by event_id, SQLite insert
       │
better-sqlite3 (store.db)
       │
 ┌─────┼──────────────────────────────────┐
 │     │                                  │
GET /stores/:id/metrics    GET /stores/:id/funnel
GET /stores/:id/heatmap    GET /stores/:id/anomalies
GET /health
       │
       ▼
dashboard/index.html        ← polls /metrics every 2s, live charts
```

## Technology Choices

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 | Team familiarity; Fastify is the fastest Node HTTP framework |
| Framework | Fastify | Built-in schema validation, pino logging, 2x faster than Express |
| Detection | YOLOv8n ONNX | onnxruntime-node runs it without Python; nano model fast enough for offline batch |
| Tracking | ByteTrack (custom JS) | No Python dependency; IoU matching sufficient for fixed-camera retail footage |
| Re-ID | Cosine similarity on bbox embeddings | OSNet requires Python; trajectory embedding sufficient for same-camera dedup |
| Storage | better-sqlite3 | Zero config, synchronous API, WAL mode handles concurrent reads |
| Validation | Zod | Schema shared between pipeline (emit.js) and API (ingest.js) — single source of truth |
| Logging | pino | Structured JSON, trace_id on every request, sub-millisecond overhead |

## Data Flow: POS Correlation

The Brigade Bangalore CSV has real transaction data (not the generic format in the spec). Correlation logic:

1. On startup, `services/pos.js` loads the CSV and inserts all 24 unique orders indexed by `order_datetime`
2. On `/metrics` and `/funnel` queries, any visitor whose last `BILLING` zone event timestamp falls within 5 minutes before a transaction's `order_datetime` is counted as converted
3. Staff are excluded via `is_staff = 0` filter at the SQL level — not post-processing

## Edge Case Handling

| Edge Case | How Handled |
|---|---|
| Group entry | ByteTrack runs per-frame; 3 people = 3 bounding boxes = 3 track_ids = 3 ENTRY events |
| Staff movement | Zone pattern classifier: visits 5+ zones with avg dwell <8s → flagged as staff |
| Re-entry | Reid.js compares embedding of new ENTRY against session cache; cosine sim >0.75 = REENTRY |
| Partial occlusion | Low-confidence detections are included with their real confidence — not dropped |
| Empty periods | API returns 0 for all numeric metrics — never null, never crashes |
| Cross-camera dedup | Entry camera events and floor camera events use the same visitor_id (Re-ID) |
| Camera overlap | Suppressed: ENTRY events only emitted from CAM_ENTRY_01, not CAM_FLOOR_01 overlap zone |

## AI-Assisted Decisions

**Decision 1 — Re-ID approach**

Claude suggested using a proper OSNet torchreid model for appearance embedding, which would give stronger re-entry detection across longer time windows. I evaluated this but chose the trajectory-based cosine similarity approach instead because: (a) OSNet requires Python and PyTorch which defeats the all-Node architecture, (b) for a fixed retail camera with a 20-minute clip window, the 5-minute re-entry window with a weak embedding is sufficient for the specific edge case the problem describes. I noted in CHOICES.md that OSNet would be the right upgrade for a production deployment.

**Decision 2 — SQLite vs Redis for session state**

Claude initially suggested Redis for session management (active tracks, dwell timers) arguing that in-memory stores are faster and Redis has pub/sub for the dashboard. I overrode this because: (a) the problem says SQLite is fine, (b) adding Redis requires a second Docker service which complicates the acceptance gate, (c) better-sqlite3 in WAL mode is fast enough for single-store batch processing, (d) persisting sessions in SQLite means the funnel survives API restarts. The dashboard uses polling instead of pub/sub — sufficient for a 2-second refresh interval.

**Decision 3 — Frame rate for detection**

Claude suggested processing at full 15fps. I reduced to 5fps for the batch pipeline because: (a) person positions don't change significantly in 200ms at retail walking speed, (b) ByteTrack handles 3-frame gaps with its lost track TTL, (c) 5fps processes a 20-minute clip 3x faster. For the real-time dashboard bonus, this means 5fps input → events emitted → dashboard updates every 2s, which is sufficient visual feedback.
