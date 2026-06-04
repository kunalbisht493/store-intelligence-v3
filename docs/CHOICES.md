# CHOICES.md — Three Key Decisions

## Decision 1: Detection Model — YOLOv8n ONNX via onnxruntime-node

### Options Considered

| Option | Pros | Cons |
|---|---|---|
| YOLOv8n ONNX (chosen) | No Python, runs in Node via onnxruntime-node, fast enough for 5fps offline | Weaker than YOLOv8m on occlusion |
| YOLOv8m/l Python subprocess | Better accuracy, torchreid available | Breaks all-Node architecture, subprocess complicates Docker |
| MediaPipe Person Detection | Lightest weight, JS-native | Designed for selfies/poses, not overhead retail CCTV |
| RT-DETR | Best accuracy on crowded scenes | No ONNX export for onnxruntime-node at the time of writing |

### What AI Suggested

Claude recommended using a Python subprocess to call YOLOv8 + ByteTrack, noting that the Python CV ecosystem is significantly more mature. It specifically pointed out that torchreid's OSNet would give much stronger Re-ID than my trajectory approach.

### What I Chose and Why

I chose YOLOv8n ONNX running directly in Node via `onnxruntime-node`. My reasoning:

1. **Architecture consistency**: One runtime, one Dockerfile, one `npm install`. No Python venv to manage inside the container. The acceptance gate is `docker compose up` — every extra dependency is a risk.
2. **The problem doesn't require perfect detection**: The evaluation framework explicitly states "functional correctness over theoretical completeness." YOLOv8n at 5fps with ByteTrack is sufficient for counting people in a fixed retail camera.
3. **Fallback**: I implemented a mock mode that generates synthetic events if the ONNX model isn't available. This means the API and all endpoints work for testing regardless of whether ONNX inference succeeds.

**Where AI was right that I disagreed with**: For a production deployment at 40 stores, I would switch to the Python subprocess approach with YOLOv8l + OSNet Re-ID. The accuracy gain on partial occlusion and cross-camera Re-ID justifies the extra complexity at scale. I'm choosing simplicity for this submission window.

---

## Decision 2: Event Schema Design

### What the Spec Required

8 event types: ENTRY, EXIT, ZONE_ENTER, ZONE_EXIT, ZONE_DWELL, BILLING_QUEUE_JOIN, BILLING_QUEUE_ABANDON, REENTRY. Fixed fields: event_id (UUID), store_id, camera_id, visitor_id, timestamp (ISO-8601 UTC), zone_id (nullable), dwell_ms, is_staff, confidence, metadata.

### Options I Considered

**Option A** — Flat schema with all fields at top level (no metadata nesting). Simpler to query in SQLite. Harder to extend without schema migration.

**Option B** — Fully nested schema where each event_type has its own field structure. Clean per-type but the ingest endpoint becomes a routing problem.

**Option C (chosen)** — Spec schema with metadata nesting for optional fields (queue_depth, sku_zone, session_seq). Matches the provided sample_events.jsonl exactly.

### What AI Suggested

Claude suggested adding a `raw_bbox` field to metadata to preserve the original detection coordinates for debugging. It also suggested a `clip_offset_ms` field to distinguish wall-clock timestamp from clip-relative offset.

### What I Chose and Why

I followed the spec schema exactly with two additions I agreed with from Claude:
- Kept `confidence` as a required float (not optional) — low-confidence events must be emitted with their real score, not suppressed. This is explicitly stated in the scoring criteria.
- Used the `metadata` wrapper for optional fields rather than nullable top-level fields — it keeps the core schema clean and the metadata envelope is the extension point.

I **rejected** the `raw_bbox` suggestion because: (a) it's not in the spec, (b) the scoring harness validates against the specified schema — extra fields are harmless but add noise, (c) bbox coordinates aren't useful for the business queries the API answers.

**Validation is shared**: `app/schema.js` (Zod) is imported by both `pipeline/emit.js` and `routes/ingest.js`. This means the pipeline can only emit events the API will accept — no silent schema drift.

---

## Decision 3: API Architecture — SQLite + session-level queries vs event-level aggregation

### The Problem

The `/funnel` endpoint must deduplicate re-entries. The spec says "session is the unit, not raw events." This means I needed to either:

**Option A** — Maintain a `sessions` table and update it on every ingest. Queries are fast (single table scan). Write-path is heavier.

**Option B** — No sessions table. At query time, compute sessions on the fly by grouping events by visitor_id + date. Simple write-path, slower queries.

**Option C** — Use Redis with a `SETEX` per visitor_id for active sessions, query from there. Fastest reads, but requires a second service.

### What AI Suggested

Claude recommended Option C (Redis) for production-readiness, arguing that session state is naturally ephemeral and Redis's TTL feature maps perfectly to the re-entry window. It also noted that Redis pub/sub would enable the live dashboard without polling.

### What I Chose and Why

I chose **Option A** — a `sessions` table in SQLite, updated at ingest time via the `upsertSession()` function in `db.js`.

Reasoning:
1. **Single service**: SQLite is already running. Adding Redis adds a second service to `docker-compose.yml`, another port to expose, and another potential failure point at the acceptance gate.
2. **Persistence**: Sessions survive API restarts. A Redis instance without persistence would lose active session state if the container restarts during a 20-minute clip.
3. **Query simplicity**: `SELECT COUNT(DISTINCT visitor_id) FROM sessions WHERE store_id = ?` is a single fast indexed query. The `visitor_id` index makes this O(log n).
4. **The evaluation window is a single day**: The 7-day rolling average in `/anomalies` uses events data directly. Sessions only need to track today's state.

**Where I agreed with Claude**: The Redis pub/sub argument for the dashboard is valid. Instead, I implemented polling at 2-second intervals which is sufficient for the dashboard's purpose. If this were a production system with 40 concurrent stores, I'd add Redis pub/sub as the event bus between the pipeline feed and the dashboard.
