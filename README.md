# Store Intelligence Platform

End-to-end retail analytics pipeline: CCTV footage → structured events → Intelligence API → Live Dashboard.

---

# Overview

This project processes retail CCTV footage, generates structured customer behavior events, ingests them into a production-ready analytics API, and exposes real-time store intelligence metrics through REST endpoints and a live dashboard.

Features:

- Visitor counting
- Session deduplication
- Re-entry handling
- Zone dwell analytics
- Billing funnel analytics
- Conversion tracking using POS data
- Queue depth monitoring
- Anomaly detection
- Live dashboard
- Dockerized deployment
- Automated tests

---

# Repository Structure

The repository intentionally excludes:

- CCTV clips
- POS datasets
- Generated databases
- Model weights
- Environment secrets

Place the challenge files in the following locations:

data/
├── store_layout_ST1008.json
├── store_layout_ST1076.json
├── events.jsonl                (generated automatically)
├── store1/
│   └── pos_transactions.csv
└── store2/
    └── pos_transactions.csv

clips/
├── store1/
│   ├── CAM 1 - zone.mp4
│   ├── CAM 2 - zone.mp4
│   └── CAM 3 - entry.mp4
│   └── CAM 5 - billing.mp4
└── store2/
    ├── billing_area.mp4
    ├── entry 1.mp4
    └── entry 2.mp4
    └── zone.mp4

models/
└── yolov8n.onnx
```

---

## Model Setup

If `models/yolov8n.onnx` is not already available, export it using:

```bash
pip install ultralytics 

python export.py
```
copy the yolov8n.onnx inside models


# Quick Start 


## 1. Clone Repository

```bash
git clone <repository-url>
cd store-intelligence-v3
```

---

## 2. Place Challenge Files

Copy files into the folders shown above.

Required:

### Store 1

```text
data/store1/pos_transactions.csv
clips/store1/CAM 1 - zone.mp4
clips/store1/CAM 2 - zone.mp4
clips/store1/CAM 3 - entry.mp4
clips/store1/CAM 5 - billing.mp4
```

### Store 2

```text
data/store2/pos_transactions.csv
clips/store2/billing_area.mp4
clips/store2/entry 1.mp4
clips/store2/entry 2.mp4
clips/store2/zone.mp4
```

### Model

```text
models/yolov8n.onnx
```

---

## 3. Start API

```bash
docker compose up --build
```

API:

```text
http://localhost:3000
```

Dashboard:

```text
http://localhost:3000
```

---

## 4. Run Detection Pipeline

Store 1:

```bash
node pipeline/run.js ./clips/store1
```

Store 2:

```bash
node pipeline/run.js ./clips/store2
```

Generated output:

```text
data/events.jsonl
```

---

## 5. Feed Events Into API

```bash
node pipeline/feed.js
```

Events are ingested through:

```text
POST /events/ingest
```

---

# Real-Time Dashboard (Part E)

Replay generated events in simulated real time:

```bash
node pipeline/feed.js --realtime
```

Open:

```text
http://localhost:3000/dashboard
```

The dashboard updates automatically every 2 seconds.

Displayed metrics:

- Unique Visitors
- Conversion Rate
- Queue Depth
- Abandonment Rate
- Conversion Funnel
- Zone Heatmap
- Active Anomalies

---

# API Endpoints

## Health

```bash
curl http://localhost:3000/health
```

---

## Metrics

```bash
curl http://localhost:3000/stores/ST1008/metrics
```

Returns:

- unique_visitors
- conversion_rate
- queue_depth
- abandonment_rate
- average dwell time

---

## Funnel

```bash
curl http://localhost:3000/stores/ST1008/funnel
```

Returns:

```text
Entry
→ Zone Visit
→ Billing
→ Purchase
```

with drop-off percentages.

---

## Heatmap

```bash
curl http://localhost:3000/stores/ST1008/heatmap
```

Returns:

- zone popularity
- average dwell
- normalized heatmap scores

---

## Anomalies

```bash
curl http://localhost:3000/stores/ST1008/anomalies
```

Returns:

- dead zones
- queue spikes
- conversion anomalies
- suggested actions

---

## Event Ingestion

```bash
curl -X POST http://localhost:3000/events/ingest
```

Supports:

- validation
- deduplication
- idempotency

---

# Running Tests

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Coverage:

```bash
npm run test:coverage
```

Current status:

```text
58 / 58 tests passing
```

---

# Architecture Documents

See:

```text
DESIGN.md
```

for architecture and AI-assisted decisions.

See:

```text
CHOICES.md
```

for:

1. Detection model selection
2. Event schema design
3. API architecture decisions

---

# Technology Stack

| Layer | Technology |
|---------|------------|
| API | Node.js + Fastify |
| Validation | Zod |
| Database | SQLite + better-sqlite3 |
| Detection | YOLOv8n |
| Tracking | ByteTrack |
| Logging | Pino |
| Testing | Vitest |
| Dashboard | HTML / CSS / JS |
| Containerization | Docker Compose |

---

# Notes

- CCTV clips are not included in the repository.
- POS datasets are not included in the repository.
- Model weights are not included in the repository.
- Generated databases are ignored via `.gitignore`.
- Folder placeholders are committed using `.gitkeep`.