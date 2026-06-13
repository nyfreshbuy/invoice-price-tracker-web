import http from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import { queryAll } from '../src/db.js';

function bodyFromRawResponse(raw) {
  const marker = '\r\n\r\n';
  const index = raw.indexOf(marker);
  return index >= 0 ? raw.slice(index + marker.length) : raw;
}

function parseStatus(raw) {
  const match = raw.match(/^HTTP\/1\.\d\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function invoke(method, url, body) {
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
    'content-length': Buffer.byteLength(requestBody)
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
    // Keep text body for diagnostics.
  }
  return { status: parseStatus(raw), data, text };
}

async function json(method, url, body) {
  const response = await invoke(method, url, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${url} failed: ${response.status} ${response.text}`);
  }
  return response.data;
}

async function cleanup(ids) {
  for (const invoiceId of ids) {
    await invoke('DELETE', `/api/invoices/${encodeURIComponent(invoiceId)}`);
  }
}

const invoiceA = {
  id: 'reg-a-sync-base',
  supplierName: '回归测试供应商A REGRESSION SUPPLIER A INC. REGRESSION SUPPLIER A INC.',
  invoiceNo: 'REG-A-SYNC',
  invoiceDate: '2026-06-04',
  totalAmount: 35,
  ocrText: 'Invoice # REG-A-SYNC\nTotal 35.00',
  items: [
    { productNameOriginal: '苹果 Apple', productNameNormalized: '苹果 apple', quantity: 2, unit: 'case', unitPrice: 10, totalPrice: 20 },
    { productNameOriginal: '香蕉 Banana', productNameNormalized: '香蕉 banana', quantity: 3, unit: 'case', unitPrice: 5, totalPrice: 15 }
  ]
};

await cleanup(['reg-a-sync-base', 'reg-a-sync-dup']);

const created = await json('POST', '/api/learning/confirm-invoice', invoiceA);
assert.equal(created.success, true);
assert.ok(created.invoice?.supplierId);

const supplierId = created.invoice.supplierId;
const changes = {
  invoices: [{
    id: 'reg-a-sync-dup',
    localId: 'reg-a-sync-dup',
    serverId: 'reg-a-sync-dup',
    supplierId,
    invoiceNo: 'REG-A-SYNC',
    invoiceDate: '2026-06-04',
    totalAmount: 35,
    ocrText: 'Invoice # REG-A-SYNC\nTotal 35.00'
  }],
  invoice_items: [
    { id: 'reg-a-sync-dup-item1', invoiceId: 'reg-a-sync-dup', supplierId, productNameOriginal: '苹果 Apple', productNameNormalized: '苹果 apple', quantity: 2, unit: 'case', unitPrice: 10, totalPrice: 20 },
    { id: 'reg-a-sync-dup-item2', invoiceId: 'reg-a-sync-dup', supplierId, productNameOriginal: '香蕉 Banana', productNameNormalized: '香蕉 banana', quantity: 3, unit: 'case', unitPrice: 5, totalPrice: 15 }
  ]
};

const pushed = await json('POST', '/api/sync/push', { deviceId: 'regression-sync', changes });
const invoiceResult = pushed.results.find((result) => result.table === 'invoices');
const itemResults = pushed.results.filter((result) => result.table === 'invoice_items');

assert.equal(invoiceResult.status, 'duplicate');
assert.equal(invoiceResult.duplicateStatus, 'duplicate');
assert.equal(itemResults.length, 2);
assert.ok(itemResults.every((result) => result.status === 'skipped_duplicate_invoice'));

const activeInvoices = (await json('GET', '/api/invoices')).filter((invoice) => invoice.invoiceNo === 'REG-A-SYNC');
const activePriceHistory = await queryAll(
  `SELECT * FROM price_history WHERE invoiceNo = ? AND deletedAt IS NULL`,
  ['REG-A-SYNC']
);

assert.equal(activeInvoices.length, 1);
assert.equal(activePriceHistory.length, 2);

await cleanup(['reg-a-sync-base', 'reg-a-sync-dup']);

const activeInvoicesAfterDelete = (await json('GET', '/api/invoices')).filter((invoice) => invoice.invoiceNo === 'REG-A-SYNC');
const activePriceHistoryAfterDelete = await queryAll(
  `SELECT * FROM price_history WHERE invoiceNo = ? AND deletedAt IS NULL`,
  ['REG-A-SYNC']
);

assert.equal(activeInvoicesAfterDelete.length, 0);
assert.equal(activePriceHistoryAfterDelete.length, 0);

console.log(JSON.stringify({
  ok: true,
  syncPushInvoiceStatus: invoiceResult.status,
  syncPushDuplicateStatus: invoiceResult.duplicateStatus,
  skippedItems: itemResults.length,
  activeInvoicesBeforeDelete: activeInvoices.length,
  activePriceHistoryBeforeDelete: activePriceHistory.length,
  activeInvoicesAfterDelete: activeInvoicesAfterDelete.length,
  activePriceHistoryAfterDelete: activePriceHistoryAfterDelete.length
}, null, 2));
