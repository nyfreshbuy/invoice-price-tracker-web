import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duplex, PassThrough } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-integrity-'));

process.env.DATA_DIR = dataDir;
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'invoice-integrity-regression-secret-1234567890';

const { app } = await import('../src/server.js');
const { queryAll, queryGet, run, nowIso } = await import('../src/db.js');

function bodyFromRawResponse(raw) {
  const marker = '\r\n\r\n';
  const index = raw.indexOf(marker);
  return index >= 0 ? raw.slice(index + marker.length) : raw;
}

function parseStatus(raw) {
  const match = raw.match(/^HTTP\/1\.\d\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

let authToken = '';

async function invoke(method, url, body, options = {}) {
  const requestBody = body === undefined ? '' : JSON.stringify(body);
  const chunks = [];
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  socket.remoteAddress = '127.0.0.1';

  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(requestBody),
    ...(options.auth === false || !authToken ? {} : { authorization: `Bearer ${authToken}` })
  };
  req.socket = socket;
  req.connection = socket;

  const res = new http.ServerResponse(req);
  res.assignSocket(socket);

  const done = new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
    socket.on('error', reject);
  });

  app.handle(req, res);
  queueMicrotask(() => {
    if (requestBody) req.emit('data', Buffer.from(requestBody));
    req.emit('end');
  });
  await done;

  const raw = Buffer.concat(chunks).toString('utf8');
  const text = bodyFromRawResponse(raw);
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Keep plain text for diagnostics.
  }
  return { status: parseStatus(raw), data, text };
}

async function json(method, url, body, options = {}) {
  const response = await invoke(method, url, body, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${url} failed: ${response.status} ${response.text}`);
  }
  return response.data;
}

async function loginRegressionUser() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `integrity-${suffix}@example.com`;
  const password = 'integrity-pass-123';
  await json('POST', '/api/auth/register', {
    username: `integrity-${suffix}`,
    email,
    password,
    companyName: `Integrity ${suffix}`
  }, { auth: false });
  const session = await json('POST', '/api/auth/login', { login: email, password }, { auth: false });
  authToken = session.token;
  assert.ok(authToken);
  return session;
}

async function confirmInvoice(payload) {
  const result = await json('POST', '/api/learning/confirm-invoice', payload);
  assert.equal(result.success, true);
  return result;
}

async function runAudit(args = []) {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/audit_invoices.js', ...args], {
    cwd: backendDir,
    env: { ...process.env, DATA_DIR: dataDir }
  });
  return JSON.parse(stdout);
}

await loginRegressionUser();

const invoiceDeleteId = 'integrity-delete-invoice';
await confirmInvoice({
  id: invoiceDeleteId,
  supplierName: 'Integrity Supplier',
  invoiceNo: 'INT-DELETE',
  invoiceDate: '2026-06-15',
  totalAmount: 30,
  items: [
    { productNameOriginal: 'Integrity Apple', productNameNormalized: 'integrity apple', quantity: 2, unitPrice: 10, totalPrice: 20 },
    { productNameOriginal: 'Integrity Banana', productNameNormalized: 'integrity banana', quantity: 1, unitPrice: 10, totalPrice: 10 }
  ]
});

let activePrices = await queryAll(`SELECT * FROM price_history WHERE invoiceId = ? AND deletedAt IS NULL`, [invoiceDeleteId]);
assert.equal(activePrices.length, 2);
await json('DELETE', `/api/invoices/${invoiceDeleteId}`);
activePrices = await queryAll(`SELECT * FROM price_history WHERE invoiceId = ? AND deletedAt IS NULL`, [invoiceDeleteId]);
assert.equal(activePrices.length, 0);
const deletedPrices = await queryAll(`SELECT * FROM price_history WHERE invoiceId = ?`, [invoiceDeleteId]);
assert.ok(deletedPrices.every((row) => row.deletedAt && row.status === 'deleted'));

const invoiceReplaceId = 'integrity-replace-invoice';
await confirmInvoice({
  id: invoiceReplaceId,
  supplierName: 'Integrity Supplier',
  invoiceNo: 'INT-REPLACE',
  invoiceDate: '2026-06-16',
  totalAmount: 30,
  items: [
    { productNameOriginal: 'Integrity Old A', productNameNormalized: 'integrity old a', quantity: 1, unitPrice: 10, totalPrice: 10 },
    { productNameOriginal: 'Integrity Old B', productNameNormalized: 'integrity old b', quantity: 1, unitPrice: 20, totalPrice: 20 }
  ]
});
await confirmInvoice({
  id: invoiceReplaceId,
  forceSave: true,
  supplierName: 'Integrity Supplier',
  invoiceNo: 'INT-REPLACE',
  invoiceDate: '2026-06-16',
  totalAmount: 12,
  items: [
    { productNameOriginal: 'Integrity New A', productNameNormalized: 'integrity new a', quantity: 1, unitPrice: 12, totalPrice: 12 }
  ]
});
activePrices = await queryAll(`SELECT * FROM price_history WHERE invoiceId = ? AND deletedAt IS NULL`, [invoiceReplaceId]);
assert.equal(activePrices.length, 1);
assert.equal(Number(activePrices[0].price), 12);

const timestamp = nowIso();
await run(`INSERT INTO invoice_items (id, companyId, invoiceId, productNameOriginal, quantity, unitPrice, totalPrice, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
  'orphan-item',
  'audit-company',
  'orphan-invoice',
  'Deleted Item',
  1,
  5,
  5,
  timestamp,
  timestamp,
  timestamp
]);
await run(`INSERT INTO price_history (id, companyId, invoiceId, invoiceItemId, supplierId, productId, price, quantity, invoiceDate, invoiceNo, status, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
  'orphan-price',
  'audit-company',
  'orphan-invoice',
  'orphan-item',
  'audit-supplier',
  'audit-product',
  5,
  1,
  '2026-06-17',
  'ORPHAN',
  'active',
  timestamp,
  timestamp,
  null
]);
let audit = await runAudit();
assert.ok(audit.orphanPriceHistory.some((row) => row.id === 'orphan-price'));
audit = await runAudit(['--fix']);
assert.ok(!audit.orphanPriceHistory.some((row) => row.id === 'orphan-price'));
const fixedOrphan = await queryGet(`SELECT * FROM price_history WHERE id = ?`, ['orphan-price']);
assert.equal(fixedOrphan.status, 'deleted');
assert.ok(fixedOrphan.deletedAt);

await run(`INSERT INTO suppliers (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`, ['legacy-supplier', 'Legacy Supplier', timestamp, timestamp]);
await run(`INSERT INTO invoices (id, supplierId, invoiceNo, invoiceDate, totalAmount, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['legacy-invoice', 'legacy-supplier', 'LEGACY-1', '2026-06-17', 9, 'APPROVED', timestamp, timestamp]);
await run(`INSERT INTO invoice_items (id, invoiceId, supplierId, productNameOriginal, quantity, unitPrice, totalPrice, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['legacy-item', 'legacy-invoice', 'legacy-supplier', 'Legacy Item', 1, 9, 9, timestamp, timestamp]);
await run(`INSERT INTO products (id, name, normalizedName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`, ['legacy-product', 'Legacy Item', 'legacy item', timestamp, timestamp]);
await run(`INSERT INTO price_history (id, invoiceId, invoiceItemId, supplierId, productId, price, quantity, invoiceDate, invoiceNo, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['legacy-price', 'legacy-invoice', 'legacy-item', 'legacy-supplier', 'legacy-product', 9, 1, '2026-06-17', 'LEGACY-1', 'active', timestamp, timestamp]);

audit = await runAudit();
assert.ok(audit.nullCompanyData.some((entry) => entry.table === 'invoices' && entry.count >= 1));
audit = await runAudit(['--company-id', 'legacy-company', '--fix']);
assert.ok(!audit.nullCompanyData.some((entry) => ['suppliers', 'invoices', 'invoice_items', 'products', 'price_history'].includes(entry.table)));

console.log(JSON.stringify({
  ok: true,
  dataDir,
  deleteInvoicePriceHistoryInvalidated: true,
  replaceInvoiceItemsPriceHistoryInvalidated: true,
  auditDetectedOrphanPriceHistory: true,
  auditFixedOrphanPriceHistory: true,
  auditDetectedNullCompanyData: true,
  auditFixedNullCompanyData: true
}, null, 2));
