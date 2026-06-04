// pipeline/detect.js
// Main CCTV detection script
// Reads video frames via ffmpeg, runs YOLOv8 ONNX inference, feeds into tracker
require('dotenv').config();
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Tracker } = require('./tracker');
const { getZoneId, detectEntryExit } = require('./zones');
const { assignVisitorId, markExit, updateZoneHistory, getZoneHistory, simpleBboxEmbedding } = require('./reid');
const { isStaff, markAsStaff } = require('./staff');
const emit = require('./emit');

// ── Config ────────────────────────────────────────────────────────────────────
const MODEL_PATH = process.env.YOLO_MODEL_PATH ||
  path.join(__dirname, '../models/yolov8n.onnx');
const FRAME_RATE = 5;    // process 5 fps (source is 15fps — skip every 3rd)
const CONF_THRESH = 0.30; // minimum detection confidence to include
const PERSON_CLASS = 0;    // COCO class index for "person"
const DWELL_EMIT_INTERVAL_MS = 30000; // emit ZONE_DWELL every 30s of continuous presence
const FRAME_W = 1920;
const FRAME_H = 1080;

/**
 * Process a single CCTV clip
 * @param {string} clipPath - path to .mp4 file
 * @param {string} storeId
 * @param {string} cameraId
 * @param {Date} clipStartTime - real-world start time for timestamp calculation
 */
async function processClip(clipPath, storeId, cameraId, clipStartTime) {
  console.log(`[detect] Processing ${path.basename(clipPath)} | camera: ${cameraId}`);

  // Load ONNX model
  let session;
  try {
    const ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(MODEL_PATH);
    console.log('[detect] ONNX model loaded');
  } catch (err) {
    console.error('[detect] Failed to load ONNX model:', err.message);
    console.log('[detect] Falling back to mock detection mode for testing');
    return mockProcessClip(clipPath, storeId, cameraId, clipStartTime);
  }

  const tracker = new Tracker();
  const frameMs = 1000 / FRAME_RATE;

  // Zone dwell tracking: visitorId → { zoneId, enterTime, lastDwellEmit }
  const zoneDwellMap = new Map();
  // Entry/exit tracking: visitorId → last normalised cy
  const prevCyMap = new Map();
  // Session sequence counter per visitor
  const sessionSeqMap = new Map();

  let frameIdx = 0;
  let frameBuffer = [];

  // Stream frames from ffmpeg at target fps
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(process.env.FFMPEG_BIN
      ? `${process.env.FFMPEG_BIN}\\ffmpeg.exe`
      : 'ffmpeg',
      [
        '-hwaccel', 'auto',
        '-i', clipPath,
        '-vf', `fps=${FRAME_RATE}`,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-'
      ]);;

    const FRAME_BYTES = FRAME_W * FRAME_H * 3;
    let buffer = Buffer.alloc(0);

    ffmpeg.stdout.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= FRAME_BYTES) {
        const frame = buffer.slice(0, FRAME_BYTES);
        buffer = buffer.slice(FRAME_BYTES);

        const nowMs = clipStartTime.getTime() + (frameIdx * frameMs * (15 / FRAME_RATE));
        await processFrame(frame, frameIdx, nowMs, session, tracker,
          storeId, cameraId, zoneDwellMap, prevCyMap, sessionSeqMap);
        frameIdx++;
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      process.stdout.write('.')
    });
    ffmpeg.on('close', resolve);
    ffmpeg.on('error', reject);
  });

  // Close any open dwell sessions at clip end
  const endMs = clipStartTime.getTime() + (frameIdx * frameMs);
  for (const [visitorId, dwell] of zoneDwellMap.entries()) {
    const dwellMs = Math.max(0, endMs - dwell.enterTime);
    emit.emitZoneExit({
      storeId, cameraId, visitorId,
      timestamp: endMs,
      zoneId: dwell.zoneId,
      dwellMs,
      confidence: 0.5,
      sessionSeq: sessionSeqMap.get(visitorId) || 1
    });
  }

  emit.closeStream();
  console.log(`[detect] Done processing ${path.basename(clipPath)} — ${frameIdx} frames`);
}

async function processFrame(frame, frameIdx, nowMs, session, tracker,
  storeId, cameraId, zoneDwellMap, prevCyMap, sessionSeqMap) {

  // Run YOLOv8 inference
  const detections = await runInference(session, frame);

  // Update tracker
  const activeTracks = tracker.update(detections, frameIdx);

  for (const track of activeTracks) {
    const { cx, cy } = track.getNormalisedCentroid(FRAME_W, FRAME_H);
    const confidence = track.confidence;

    // Get or assign visitor_id via Re-ID
    if (!track.visitor_id) {
      const embedding = simpleBboxEmbedding(track.bbox, FRAME_W, FRAME_H);
      const { visitor_id, is_reentry } = assignVisitorId(embedding, nowMs, storeId);
      track.visitor_id = visitor_id;

      const seq = (sessionSeqMap.get(visitor_id) || 0) + 1;
      sessionSeqMap.set(visitor_id, seq);

      if (is_reentry) {
        emit.emitReentry({ storeId, cameraId, visitorId: visitor_id, timestamp: nowMs, confidence, sessionSeq: seq });
      } else {
        // Check for entry/exit on entry camera
        if (cameraId.includes('ENTRY')) {
          emit.emitEntry({ storeId, cameraId, visitorId: visitor_id, timestamp: nowMs, confidence, sessionSeq: 1 });
        }
      }
    }

    const visitorId = track.visitor_id;
    const seq = sessionSeqMap.get(visitorId) || 1;

    // Entry/exit direction detection (entry camera only)
    if (cameraId.includes('ENTRY')) {
      const prevCy = prevCyMap.get(visitorId);
      if (prevCy !== undefined) {
        const direction = detectEntryExit(cameraId, prevCy, cy);
        if (direction === 'EXIT') {
          markExit(visitorId, nowMs);
          emit.emitExit({ storeId, cameraId, visitorId, timestamp: nowMs, confidence, sessionSeq: seq });
        }
      }
      prevCyMap.set(visitorId, cy);
    }

    // Zone detection (floor/billing cameras)
    if (!cameraId.includes('ENTRY')) {
      const zoneId = getZoneId(cameraId, cx, cy);
      updateZoneHistory(visitorId, zoneId);

      // Staff detection based on zone pattern
      const zoneHistory = getZoneHistory(visitorId);
      const staffCheck = isStaff(visitorId, {
        zoneHistory,
        avgDwellMs: track.avg_dwell_ms
      });
      if (staffCheck) markAsStaff(visitorId);

      // Zone dwell tracking
      const current = zoneDwellMap.get(visitorId);

      if (!current || current.zoneId !== zoneId) {
        // Zone changed
        if (current) {
          const dwellMs = Math.max(0, nowMs - current.enterTime);
          emit.emitZoneExit({
            storeId, cameraId, visitorId,
            timestamp: nowMs,
            zoneId: current.zoneId,
            dwellMs, confidence,
            isStaff: staffCheck,
            sessionSeq: seq
          });
        }
        if (zoneId) {
          emit.emitZoneEnter({
            storeId, cameraId, visitorId,
            timestamp: nowMs,
            zoneId, confidence,
            isStaff: staffCheck,
            sessionSeq: seq,
            skuZone: zoneId
          });

          zoneDwellMap.set(visitorId, { zoneId, enterTime: nowMs, lastDwellEmit: nowMs });

          // Billing queue join
          if (zoneId === 'BILLING') {
            const queueDepth = tracker.getActiveTracks()
              .filter(t => t.visitor_id !== visitorId)
              .filter(t => {
                const { cx: tx, cy: ty } = t.getNormalisedCentroid(FRAME_W, FRAME_H);
                return getZoneId(cameraId, tx, ty) === 'BILLING';
              }).length;

            if (queueDepth > 0) {
              emit.emitBillingQueueJoin({
                storeId, cameraId, visitorId,
                timestamp: nowMs,
                queueDepth,
                confidence,
                isStaff: staffCheck,
                sessionSeq: seq
              });
            }
          }
        }
      } else if (zoneId) {
        // Same zone — check if 30s dwell emit is due
        const timeSinceDwell = nowMs - current.lastDwellEmit;
        if (timeSinceDwell >= DWELL_EMIT_INTERVAL_MS) {
          emit.emitZoneDwell({
            storeId, cameraId, visitorId,
            timestamp: nowMs,
            zoneId,
            dwellMs: nowMs - current.enterTime,
            confidence,
            isStaff: staffCheck,
            sessionSeq: seq
          });
          current.lastDwellEmit = nowMs;
        }
      }
    }
  }
}

// Run YOLOv8 ONNX inference on a raw RGB frame
async function runInference(session, frameBuffer) {
  const ort = require('onnxruntime-node');

  // Pre-process: normalise to [0,1] float32, shape [1, 3, 640, 640]
  const INPUT_SIZE = 640;
  const floatData = new Float32Array(1 * 3 * INPUT_SIZE * INPUT_SIZE);

  // Simple resize by sampling (not bicubic — fast enough for detection)
  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      const srcX = Math.floor(x * FRAME_W / INPUT_SIZE);
      const srcY = Math.floor(y * FRAME_H / INPUT_SIZE);
      const srcIdx = (srcY * FRAME_W + srcX) * 3;
      floatData[0 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = frameBuffer[srcIdx] / 255.0; // R
      floatData[1 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = frameBuffer[srcIdx + 1] / 255.0; // G
      floatData[2 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = frameBuffer[srcIdx + 2] / 255.0; // B
    }
  }

  const tensor = new ort.Tensor('float32', floatData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await session.run({ images: tensor });

  // YOLOv8 output: [1, 84, 8400] — 84 = 4 bbox + 80 class scores
  const output = results.output0 || results[Object.keys(results)[0]];
  const data = output.data;
  const numDets = 8400;

  const detections = [];

  for (let i = 0; i < numDets; i++) {
    // Class scores start at index 4
    const personScore = data[4 * numDets + PERSON_CLASS * numDets + i];
    if (personScore < CONF_THRESH) continue;

    // Bbox is cx, cy, w, h (normalised 0-1)
    // Bbox is cx, cy, w, h in 640x640 model coordinates
    const cx = data[0 * numDets + i];
    const cy = data[1 * numDets + i];
    const w = data[2 * numDets + i];
    const h = data[3 * numDets + i];

    const scaleX = FRAME_W / INPUT_SIZE; // 1920/640 = 3
    const scaleY = FRAME_H / INPUT_SIZE; // 1080/640 = 1.6875

    const x1 = (cx - w / 2) * scaleX;
    const y1 = (cy - h / 2) * scaleY;
    const x2 = (cx + w / 2) * scaleX;
    const y2 = (cy + h / 2) * scaleY;

    detections.push({
      bbox: { x1, y1, x2, y2 },
      confidence: parseFloat(personScore.toFixed(4))
    });
  }

  return detections;
}


// Mock mode — generates synthetic events for API testing without real CCTV
function mockProcessClip(clipPath, storeId, cameraId, clipStartTime) {
  console.log('[detect] Running in MOCK mode — generating synthetic events');
  const visitors = ['VIS_a1b2c3', 'VIS_d4e5f6', 'VIS_g7h8i9', 'VIS_j0k1l2'];
  const zones = ['SKINCARE', 'MAKEUP', 'HAIRCARE', 'BILLING', 'BATH_BODY'];

  let t = clipStartTime.getTime();

  for (const v of visitors) {
    emit.emitEntry({ storeId, cameraId: 'CAM_ENTRY_01', visitorId: v, timestamp: t, confidence: 0.92, sessionSeq: 1 });
    t += 30000;

    for (const z of zones.slice(0, 3)) {
      emit.emitZoneEnter({ storeId, cameraId: 'CAM_FLOOR_01', visitorId: v, timestamp: t, zoneId: z, confidence: 0.87, sessionSeq: 1, skuZone: z });
      t += 45000;
      emit.emitZoneDwell({ storeId, cameraId: 'CAM_FLOOR_01', visitorId: v, timestamp: t, zoneId: z, dwellMs: 45000, confidence: 0.85, sessionSeq: 1 });
      emit.emitZoneExit({ storeId, cameraId: 'CAM_FLOOR_01', visitorId: v, timestamp: t, zoneId: z, dwellMs: 45000, confidence: 0.85, sessionSeq: 1 });
      t += 5000;
    }

    emit.emitBillingQueueJoin({ storeId, cameraId: 'CAM_BILLING_01', visitorId: v, timestamp: t, queueDepth: 2, confidence: 0.88, sessionSeq: 1 });
    t += 60000;
    emit.emitExit({ storeId, cameraId: 'CAM_ENTRY_01', visitorId: v, timestamp: t, confidence: 0.90, sessionSeq: 1 });
    t += 120000;
  }

  emit.closeStream();
  console.log(`[detect] Mock events written for ${visitors.length} visitors`);
}

module.exports = { processClip };
