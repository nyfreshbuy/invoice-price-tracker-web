import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-save-integrity-'));
process.env.DATA_DIR = dataDir;
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'invoice-save-integrity-secret-1234567890';

const { app } = await import('../src/server.js');
const { queryAll } = await import('../src/db.js');

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
  const email = `invoice-save-${suffix}@example.com`;
  const password = 'invoice-save-pass-123';
  await json('POST', '/api/auth/register', {
    username: `invoice-save-${suffix}`,
    email,
    password,
    companyName: `Invoice Save ${suffix}`
  }, { auth: false });
  const session = await json('POST', '/api/auth/login', { login: email, password }, { auth: false });
  authToken = session.token;
  assert.ok(authToken);
}

function invoicePayload(overrides = {}) {
  const id = overrides.id || `save-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    supplierName: overrides.supplierName || 'Save Integrity Supplier',
    invoiceNo: overrides.invoiceNo || id.toUpperCase(),
    invoiceDate: overrides.invoiceDate || '2026-06-18',
    totalAmount: overrides.totalAmount ?? 30,
    ocrText: overrides.ocrText || `Invoice # ${overrides.invoiceNo || id}\nTotal ${overrides.totalAmount ?? 30}`,
    items: overrides.items || [
      { productNameOriginal: 'Save Apple', productNameNormalized: 'save apple', quantity: 2, unit: 'case', unitPrice: 10, totalPrice: 20 },
      { productNameOriginal: 'Save Banana', productNameNormalized: 'save banana', quantity: 1, unit: 'case', unitPrice: 10, totalPrice: 10 }
    ],
    ...overrides
  };
}

async function activePriceHistory(invoiceId) {
  return queryAll(
    `SELECT * FROM price_history WHERE invoiceId = ? AND deletedAt IS NULL AND COALESCE(status, 'active') NOT IN ('deleted', 'inactive')`,
    [invoiceId]
  );
}

await loginRegressionUser();

const apiInvoice = await json('POST', '/api/invoices', invoicePayload({ id: 'save-api-invoice', invoiceNo: 'SAVE-API-1' }));
assert.equal(apiInvoice.success, true);
assert.equal(apiInvoice.saved, true);
assert.equal(apiInvoice.needsReview, false);
assert.equal(apiInvoice.invoice.status, 'APPROVED');
assert.equal((await activePriceHistory('save-api-invoice')).length, 2);
assert.ok((await queryAll(`SELECT * FROM products WHERE deletedAt IS NULL`)).length >= 2);
assert.ok((await queryAll(`SELECT * FROM product_aliases WHERE deletedAt IS NULL`)).length >= 2);
assert.ok((await queryAll(`SELECT * FROM product_learning_rules WHERE deletedAt IS NULL`)).length >= 2);
const searchResults = await json('GET', '/api/products/search?q=save%20apple');
assert.ok(searchResults.some((row) => String(row.standardName || '').includes('save apple')));
const productHistory = await json('GET', `/api/products/${encodeURIComponent('save apple')}`);
assert.ok(productHistory.some((row) => row.invoiceNo === 'SAVE-API-1'));

const learningInvoice = await json('POST', '/api/learning/confirm-invoice', invoicePayload({ id: 'save-learning-invoice', invoiceNo: 'SAVE-LEARN-1' }));
assert.equal(learningInvoice.success, true);
assert.equal(learningInvoice.saved, true);
assert.equal(learningInvoice.needsReview, false);
assert.equal(learningInvoice.invoice.status, 'APPROVED');
assert.equal((await activePriceHistory('save-learning-invoice')).length, 2);

const emptyInvoice = await json('POST', '/api/invoices', invoicePayload({
  id: 'save-empty-invoice',
  invoiceNo: 'SAVE-EMPTY-1',
  totalAmount: 12,
  items: []
}));
assert.equal(emptyInvoice.needsReview, true);
assert.equal(emptyInvoice.invoice.status, 'PENDING_REVIEW');
assert.equal((await activePriceHistory('save-empty-invoice')).length, 0);

const mismatchInvoice = await json('POST', '/api/invoices', invoicePayload({
  id: 'save-mismatch-invoice',
  invoiceNo: 'SAVE-MISMATCH-1',
  totalAmount: 99,
  items: [
    { productNameOriginal: 'Mismatch Item', productNameNormalized: 'mismatch item', quantity: 1, unitPrice: 10, totalPrice: 10 }
  ]
}));
assert.equal(mismatchInvoice.needsReview, true);
assert.equal(mismatchInvoice.invoice.status, 'PENDING_REVIEW');
assert.equal((await activePriceHistory('save-mismatch-invoice')).length, 0);

const filteredRowsInvoice = await json('POST', '/api/invoices', invoicePayload({
  id: 'save-filtered-rows',
  invoiceNo: 'SAVE-FILTER-1',
  totalAmount: 8,
  items: [
    { productNameOriginal: 'Valid Item', productNameNormalized: 'valid item', quantity: 1, unitPrice: 10, totalPrice: 10 },
    { productNameOriginal: 'Free Item', productNameNormalized: 'free item', quantity: 1, unitPrice: 0, totalPrice: 0, isFreeItem: true },
    { productNameOriginal: 'Candidate Item', productNameNormalized: 'candidate item', quantity: 1, unitPrice: 100, totalPrice: 100, candidateOnly: true },
    { productNameOriginal: 'Discount', productNameNormalized: 'discount', quantity: 1, unitPrice: -2, totalPrice: -2, isDiscountLine: true }
  ]
}));
assert.equal(filteredRowsInvoice.needsReview, false);
assert.equal((await activePriceHistory('save-filtered-rows')).length, 1);

const duplicateResponse = await invoke('POST', '/api/invoices', invoicePayload({
  id: 'save-api-invoice-duplicate',
  invoiceNo: 'SAVE-API-1'
}));
assert.equal(duplicateResponse.status, 409);
assert.equal(duplicateResponse.data.duplicate, true);
assert.equal((await activePriceHistory('save-api-invoice')).length, 2);
assert.equal((await queryAll(`SELECT * FROM price_history WHERE invoiceNo = ? AND deletedAt IS NULL`, ['SAVE-API-1'])).length, 2);

await json('POST', '/api/learning/confirm-invoice', invoicePayload({
  id: 'force-learning-base',
  invoiceNo: 'FORCE-LEARN-1'
}));
const learningDuplicate = await invoke('POST', '/api/learning/confirm-invoice', invoicePayload({
  id: 'force-learning-duplicate',
  invoiceNo: 'FORCE-LEARN-1'
}));
assert.equal(learningDuplicate.status, 409);
assert.equal(learningDuplicate.data.duplicate, true);
const forcedLearningDuplicate = await json('POST', '/api/learning/confirm-invoice', invoicePayload({
  id: 'force-learning-independent',
  invoiceNo: 'FORCE-LEARN-1',
  forceSave: true
}));
assert.equal(forcedLearningDuplicate.success, true);
assert.equal(forcedLearningDuplicate.duplicate, true);
assert.equal(forcedLearningDuplicate.forceSaved, true);
assert.equal(forcedLearningDuplicate.savedAsIndependent, true);
assert.ok(forcedLearningDuplicate.invoiceId);

await json('POST', '/api/invoices', invoicePayload({
  id: 'mp-no-group-base',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-NOGROUP',
  totalAmount: 20,
  items: [
    { productNameOriginal: 'Multipart Apple', productNameNormalized: 'multipart apple', quantity: 1, unitPrice: 20, totalPrice: 20 }
  ]
}));
const noGroupCandidate = await json('POST', '/api/invoices', invoicePayload({
  id: 'mp-no-group-next',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-NOGROUP',
  totalAmount: 20,
  items: [
    { productNameOriginal: 'Multipart Banana', productNameNormalized: 'multipart banana', quantity: 1, unitPrice: 20, totalPrice: 20 }
  ]
}));
assert.equal(noGroupCandidate.needsReview, true);
assert.equal(noGroupCandidate.invoice.status, 'PENDING_REVIEW');
assert.ok(String(noGroupCandidate.reason || '').includes('POSSIBLE_MULTI_PAGE_OR_DUPLICATE'));
assert.equal(noGroupCandidate.duplicate, false);

await json('POST', '/api/invoices', invoicePayload({
  id: 'mp-batch-base',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-BATCH',
  totalAmount: 20,
  batchId: 'batch-mp-1',
  items: [
    { productNameOriginal: 'Batch Page A', productNameNormalized: 'batch page a', quantity: 1, unitPrice: 20, totalPrice: 20 }
  ]
}));
const batchCandidate = await json('POST', '/api/invoices', invoicePayload({
  id: 'mp-batch-next',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-BATCH',
  totalAmount: 15,
  batchId: 'batch-mp-1',
  items: [
    { productNameOriginal: 'Batch Page B', productNameNormalized: 'batch page b', quantity: 1, unitPrice: 15, totalPrice: 15 }
  ]
}));
assert.equal(batchCandidate.duplicate, false);
assert.equal(batchCandidate.duplicateCheck.possibleSameInvoicePages, true);
assert.notEqual(batchCandidate.duplicateCheck.duplicateStatus, 'duplicate');

await json('POST', '/api/invoices', invoicePayload({
  id: 'mp-group-base',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-GROUP',
  totalAmount: 20,
  invoiceGroupKey: 'mp-group-1',
  items: [
    { productNameOriginal: 'Group Page A', productNameNormalized: 'group page a', quantity: 1, unitPrice: 20, totalPrice: 20 }
  ]
}));
const groupCandidate = await json('POST', '/api/invoices', invoicePayload({
  id: 'mp-group-next',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-GROUP',
  totalAmount: 15,
  invoiceGroupKey: 'mp-group-1',
  items: [
    { productNameOriginal: 'Group Page B', productNameNormalized: 'group page b', quantity: 1, unitPrice: 15, totalPrice: 15 }
  ]
}));
assert.equal(groupCandidate.duplicate, false);
assert.equal(groupCandidate.duplicateCheck.possibleSameInvoicePages, true);
assert.notEqual(groupCandidate.duplicateCheck.duplicateStatus, 'duplicate');

await json('POST', '/api/invoices', invoicePayload({
  id: 'mp-identical-base',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-IDENTICAL',
  totalAmount: 20,
  batchId: 'batch-identical',
  items: [
    { productNameOriginal: 'Identical Page', productNameNormalized: 'identical page', quantity: 1, unitPrice: 20, totalPrice: 20 }
  ]
}));
const identicalResponse = await invoke('POST', '/api/invoices', invoicePayload({
  id: 'mp-identical-next',
  supplierName: 'Multipart Supplier',
  invoiceNo: 'MP-IDENTICAL',
  totalAmount: 20,
  batchId: 'batch-identical',
  items: [
    { productNameOriginal: 'Identical Page', productNameNormalized: 'identical page', quantity: 1, unitPrice: 20, totalPrice: 20 }
  ]
}));
assert.equal(identicalResponse.status, 409);
assert.equal(identicalResponse.data.duplicate, true);

await json('POST', '/api/learning/confirm-invoice', invoicePayload({
  id: 'save-replace-invoice',
  invoiceNo: 'SAVE-REPLACE-1',
  totalAmount: 20,
  items: [
    { productNameOriginal: 'Replace Old', productNameNormalized: 'replace old', quantity: 2, unitPrice: 10, totalPrice: 20 }
  ]
}));
await json('POST', '/api/learning/confirm-invoice', invoicePayload({
  id: 'save-replace-invoice',
  invoiceNo: 'SAVE-REPLACE-1',
  totalAmount: 15,
  forceSave: true,
  items: [
    { productNameOriginal: 'Replace New', productNameNormalized: 'replace new', quantity: 1, unitPrice: 15, totalPrice: 15 }
  ]
}));
const replacementPrices = await activePriceHistory('save-replace-invoice');
assert.equal(replacementPrices.length, 1);
assert.equal(Number(replacementPrices[0].price), 15);

console.log(JSON.stringify({
  ok: true,
  dataDir,
  apiInvoicesGeneratedPriceHistory: true,
  learningConfirmGeneratedPriceHistory: true,
  emptyItemsPendingReview: true,
  mismatchPendingReview: true,
  invalidRowsExcludedFromPriceHistory: true,
  duplicateBlockedWithoutExtraPriceHistory: true,
  replaceInvalidatedOldPriceHistory: true
}, null, 2));
