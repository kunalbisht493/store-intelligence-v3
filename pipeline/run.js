// pipeline/run.js
// Process all CCTV clips → events.jsonl
// Usage: node pipeline/run.js ./clips/store1
require('dotenv').config();
if (process.env.FFMPEG_BIN) process.env.PATH = process.env.PATH + ';' + process.env.FFMPEG_BIN;

const path = require('path');
const fs   = require('fs');
const { processClip } = require('./detect');
const emit = require('./emit');

// ── Store configs ─────────────────────────────────────────────────────────────
const STORE_CONFIGS = {
  'store1': {
    store_id: 'ST1008',
    cameras: [
      { camera_id: 'CAM_ENTRY_01',   file_pattern: 'cam 3 - entry',  start_time: new Date('2026-04-10T12:00:00Z') },
      { camera_id: 'CAM_FLOOR_01',   file_pattern: 'cam 1 - zone',   start_time: new Date('2026-04-10T12:00:00Z') },
      { camera_id: 'CAM_FLOOR_02',   file_pattern: 'cam 2 - zone',   start_time: new Date('2026-04-10T12:00:00Z') },
      { camera_id: 'CAM_BILLING_01', file_pattern: 'cam 5 - billing', start_time: new Date('2026-04-10T12:00:00Z') },
      // CAM 4 excluded — stockroom, no customer traffic
    ]
  },
  'store2': {
    store_id: 'ST1076',
    cameras: [
      { camera_id: 'CAM_ENTRY_01',   file_pattern: 'entry 1',      start_time: new Date('2026-03-08T12:00:00Z') },
      { camera_id: 'CAM_ENTRY_02',   file_pattern: 'entry 2',      start_time: new Date('2026-03-08T13:00:00Z') },
      { camera_id: 'CAM_FLOOR_01',   file_pattern: 'zone',         start_time: new Date('2026-03-08T12:00:00Z') },
      { camera_id: 'CAM_BILLING_01', file_pattern: 'billing_area', start_time: new Date('2026-03-08T12:00:00Z') },
    ]
  }
};

async function main() {
  const clipsDir = process.argv[2];
  if (!clipsDir) {
    console.error('Usage: node pipeline/run.js <clips_directory>');
    console.error('Examples:');
    console.error('  node pipeline/run.js ./clips/store1');
    console.error('  node pipeline/run.js ./clips/store2');
    process.exit(1);
  }

  if (!fs.existsSync(clipsDir)) {
    console.error(`Clips directory not found: ${clipsDir}`);
    process.exit(1);
  }

  // Match store config by folder name
  const folderName = path.basename(clipsDir).toLowerCase();
  const storeConfig = STORE_CONFIGS[folderName] || STORE_CONFIGS['store1'];
  const storeId = storeConfig.store_id;

  console.log(`\n[run] Store: ${storeId} (${folderName})`);
  console.log(`[run] Clips directory: ${clipsDir}`);

  const files = fs.readdirSync(clipsDir).filter(f =>
    ['.mp4', '.avi', '.mov', '.mkv'].some(ext => f.toLowerCase().endsWith(ext))
  );

  console.log(`[run] Found ${files.length} clip(s):`, files);

  for (const cam of storeConfig.cameras) {
    const clipFile = files.find(f => f.toLowerCase().includes(cam.file_pattern.toLowerCase()));
    if (!clipFile) {
      console.warn(`[run] No clip found for ${cam.camera_id} (pattern: "${cam.file_pattern}") — running mock mode`);
      await processClip(null, storeId, cam.camera_id, cam.start_time);
      continue;
    }
    const clipPath = path.join(clipsDir, clipFile);
    console.log(`\n[run] Processing ${cam.camera_id}: ${clipFile}`);
    await processClip(clipPath, storeId, cam.camera_id, cam.start_time);
  }

  emit.closeStream();
  sortEventsByTimestamp();

  console.log('\n[run] ✓ All clips processed');
  console.log(`[run] Events written to: ${require('./emit').OUTPUT_PATH}`);
  console.log('[run] Next: node pipeline/feed.js\n');
}

function sortEventsByTimestamp() {
  const { OUTPUT_PATH } = require('./emit');
  if (!fs.existsSync(OUTPUT_PATH)) return;
  const lines = fs.readFileSync(OUTPUT_PATH, 'utf8').split('\n').filter(Boolean);
  const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  fs.writeFileSync(OUTPUT_PATH, events.map(l => JSON.stringify(l)).join('\n') + '\n');
  console.log(`[run] Sorted ${events.length} events by timestamp`);
}

main().catch(err => {
  console.error('[run] Fatal error:', err);
  process.exit(1);
});
