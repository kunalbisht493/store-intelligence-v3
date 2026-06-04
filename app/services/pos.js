// app/services/pos.js
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { getDb } = require('../db');

function loadPosData() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM pos_transactions').get().c;
  if (count > 0) return;

  // Load store 1 POS
  const pos1 = process.env.STORE1_POS || process.env.POS_CSV_PATH || './data/store1/pos_transactions.csv';
  if (fs.existsSync(pos1)) loadCsv(db, 'ST1008', pos1);

  // Load store 2 POS if exists  
  const pos2 = process.env.STORE2_POS || './data/store2/pos_transactions.csv';
  if (fs.existsSync(pos2)) loadCsv(db, 'ST1076', pos2);
}

function loadCsv(db, defaultStoreId, csvPath) {
  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO pos_transactions
      (order_id, store_id, order_date, order_time, order_datetime, total_amount, brand_name, product_id)
    VALUES (@order_id, @store_id, @order_date, @order_time, @order_datetime, @total_amount, @brand_name, @product_id)
  `);

  const orderMap = {};
  for (const row of rows) {
    const oid = String(row.order_id || row.transaction_id || '');
    if (!oid) continue;
    if (!orderMap[oid]) {
      const storeId = row.store_id || defaultStoreId;
      const date    = row.order_date || '';
      const time    = row.order_time || '';
      orderMap[oid] = {
        order_id:       oid,
        store_id:       storeId,
        order_date:     date,
        order_time:     time,
        order_datetime: buildIso(date, time),
        total_amount:   0,
        brand_name:     row.brand_name || null,
        product_id:     String(row.product_id || '')
      };
    }
    orderMap[oid].total_amount += parseFloat(row.total_amount || row.basket_value_inr || 0);
  }

  const insertMany = db.transaction((orders) => {
    for (const o of orders) insert.run(o);
  });
  insertMany(Object.values(orderMap));
  console.log(`[pos] Loaded ${Object.keys(orderMap).length} orders from ${csvPath}`);
}

// Convert "10-04-2026" + "16:55:36" → "2026-04-10T16:55:36Z"
function buildIso(date, time) {
  if (!date) return null;
  if (time && time.includes('T')) return time.slice(0, 19) + 'Z';
  const parts = date.split('-');
  if (parts.length !== 3) return null;
  // Handle DD-MM-YYYY format
  const [d, m, y] = parts[0].length === 4 ? [parts[2], parts[1], parts[0]] : parts;
  return `${y.length === 4 ? y : '20'+y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${(time||'00:00:00').padStart(8,'0')}Z`;
}

function getTransactionsInWindow(storeId, fromIso, toIso) {
  return getDb().prepare(`
    SELECT * FROM pos_transactions
    WHERE store_id = ? AND order_datetime >= ? AND order_datetime <= ?
    ORDER BY order_datetime ASC
  `).all(storeId, fromIso, toIso);
}

module.exports = { loadPosData, getTransactionsInWindow };
