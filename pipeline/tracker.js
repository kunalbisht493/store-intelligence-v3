// pipeline/tracker.js
// ByteTrack-style multi-object tracker
// Maintains active tracks across frames using IoU matching
// Assigns stable track_id per person per camera

const LOST_TRACK_TTL = 30;       // frames to keep a lost track alive before closing
const IOU_MATCH_THRESHOLD = 0.3; // minimum IoU to match detection to existing track
const HIGH_CONF_THRESHOLD = 0.6; // high-confidence detections matched first

let nextTrackId = 1;

class Track {
  constructor(bbox, confidence, frameIdx) {
    this.track_id    = nextTrackId++;
    this.bbox        = bbox;       // { x1, y1, x2, y2 }
    this.confidence  = confidence;
    this.state       = 'active';   // active | lost | closed
    this.lost_frames = 0;
    this.age         = 1;          // total frames tracked
    this.history     = [{ bbox, frameIdx }]; // last N positions
    this.zone_history = [];
    this.avg_dwell_ms = 0;
    this.entry_frame  = frameIdx;
  }

  update(bbox, confidence, frameIdx) {
    this.bbox        = bbox;
    this.confidence  = confidence;
    this.state       = 'active';
    this.lost_frames = 0;
    this.age++;
    this.history.push({ bbox, frameIdx });
    if (this.history.length > 30) this.history.shift(); // keep last 30
  }

  getCentroid() {
    return {
      cx: (this.bbox.x1 + this.bbox.x2) / 2,
      cy: (this.bbox.y1 + this.bbox.y2) / 2
    };
  }

  getNormalisedCentroid(frameWidth, frameHeight) {
    const c = this.getCentroid();
    return {
      cx: c.cx / frameWidth,
      cy: c.cy / frameHeight
    };
  }
}

class Tracker {
  constructor() {
    this.tracks      = [];
    this.closedTracks = [];
  }

  // Main update — call once per frame with array of detections
  // detections: [{ bbox: {x1,y1,x2,y2}, confidence }]
  update(detections, frameIdx) {
    // Split detections by confidence
    const high = detections.filter(d => d.confidence >= HIGH_CONF_THRESHOLD);
    const low  = detections.filter(d => d.confidence <  HIGH_CONF_THRESHOLD);

    const activeTracks = this.tracks.filter(t => t.state === 'active');
    const lostTracks   = this.tracks.filter(t => t.state === 'lost');

    // Step 1: Match high-confidence detections to active tracks
    const { matched: m1, unmatchedTracks: ut1, unmatchedDets: ud1 } =
      this._match(high, activeTracks);

    // Step 2: Match low-confidence detections to remaining active tracks
    const { matched: m2, unmatchedTracks: ut2, unmatchedDets: ud2 } =
      this._match(low, ut1);

    // Step 3: Match unmatched detections to lost tracks (re-activation)
    const { matched: m3, unmatchedTracks: ut3, unmatchedDets: ud3 } =
      this._match([...ud1, ...ud2], lostTracks);

    // Update matched tracks
    for (const { track, det } of [...m1, ...m2, ...m3]) {
      track.update(det.bbox, det.confidence, frameIdx);
    }

    // Mark unmatched active tracks as lost
    for (const track of [...ut2, ...ut3.filter(t => t.state === 'active')]) {
      track.state = 'lost';
      track.lost_frames++;
    }

    // Increment lost counter for already-lost tracks and close if TTL exceeded
    for (const track of lostTracks) {
      if (!m3.find(m => m.track === track)) {
        track.lost_frames++;
        if (track.lost_frames > LOST_TRACK_TTL) {
          track.state = 'closed';
          this.closedTracks.push(track);
        }
      }
    }

    // Create new tracks for unmatched high-confidence detections
    for (const det of ud3.filter(d => d.confidence >= HIGH_CONF_THRESHOLD)) {
      this.tracks.push(new Track(det.bbox, det.confidence, frameIdx));
    }

    // Remove closed tracks from active list
    this.tracks = this.tracks.filter(t => t.state !== 'closed');

    return this.tracks.filter(t => t.state === 'active');
  }

  // IoU-based greedy matching
  _match(detections, tracks) {
    if (detections.length === 0 || tracks.length === 0) {
      return { matched: [], unmatchedTracks: tracks, unmatchedDets: detections };
    }

    const matched = [];
    const usedDets = new Set();
    const usedTracks = new Set();

    // Build IoU matrix
    const iouMatrix = tracks.map(track =>
      detections.map(det => computeIoU(track.bbox, det.bbox))
    );

    // Greedy matching — find highest IoU pairs
    while (true) {
      let maxIoU = IOU_MATCH_THRESHOLD;
      let bestT = -1, bestD = -1;

      for (let t = 0; t < tracks.length; t++) {
        if (usedTracks.has(t)) continue;
        for (let d = 0; d < detections.length; d++) {
          if (usedDets.has(d)) continue;
          if (iouMatrix[t][d] > maxIoU) {
            maxIoU = iouMatrix[t][d];
            bestT = t; bestD = d;
          }
        }
      }

      if (bestT === -1) break;
      matched.push({ track: tracks[bestT], det: detections[bestD] });
      usedTracks.add(bestT);
      usedDets.add(bestD);
    }

    const unmatchedTracks = tracks.filter((_, i) => !usedTracks.has(i));
    const unmatchedDets   = detections.filter((_, i) => !usedDets.has(i));

    return { matched, unmatchedTracks, unmatchedDets };
  }

  getActiveTracks() {
    return this.tracks.filter(t => t.state === 'active');
  }

  reset() {
    this.tracks = [];
    this.closedTracks = [];
    nextTrackId = 1;
  }
}

// Intersection over Union for two bounding boxes
function computeIoU(a, b) {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);

  const interW = Math.max(0, ix2 - ix1);
  const interH = Math.max(0, iy2 - iy1);
  const inter  = interW * interH;

  if (inter === 0) return 0;

  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);

  return inter / (areaA + areaB - inter);
}

module.exports = { Tracker, computeIoU };
