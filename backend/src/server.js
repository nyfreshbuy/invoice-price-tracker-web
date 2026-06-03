import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getByAnyId,
  id,
  isValidSyncTable,
  migrate,
  normalizeProductName,
  nowIso,
  queryAll,
  queryGet,
  quoteIdentifier,
  quoteTable,
  rowToCsv,
  run,
  syncTables,
  tableColumns,
  today,
  upsertRecord,
  usingPostgres,
  withTransaction
} from './db.js';
import aiInvoiceRoutes from './routes/aiInvoice.js';
import { recognizeInvoice } from './services/aiInvoiceOrchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.resolve(__dirname, '..', '.env'));

await migrate();

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = process.env.UPLOAD_DIR || path.resolve(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const OCR_LANGUAGE = process.env.OCR_LANG || 'eng+chi_sim';
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120000);
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-only-change-me';
const AUTO_LOGIN = process.env.AUTO_LOGIN === 'true';
const DEMO_NO_AUTH = AUTO_LOGIN || process.env.DEMO_NO_AUTH !== 'false';
const DEMO_COMPANY = { id: 'demo-company', name: '测试公司' };
const DEMO_USER = {
  id: 'demo-user',
  email: 'demo@example.com',
  username: 'demo',
  name: 'demo',
  companyId: DEMO_COMPANY.id
};

console.log(`[database] mode: ${usingPostgres ? 'PostgreSQL' : 'SQLite'}`);
console.log(`[auth] demo no auth mode: ${DEMO_NO_AUTH ? 'enabled' : 'disabled'}`);

const localDevOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://192.168.50.49:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://192.168.50.49:3000'
];

const configuredOrigins = (process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...configuredOrigins, ...localDevOrigins])];
console.log('[cors] allowed origins:', allowedOrigins.join(', '));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadDir));

const upload = multer({ dest: uploadDir });

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt] = String(stored || '').split(':');
  if (!salt) return false;
  return hashPassword(password, salt) === stored;
}

function authResponse(user, company) {
  const token = signToken({
    userId: user.id,
    companyId: user.companyId,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
  });
  return {
    token,
    user: { id: user.id, email: user.email, name: user.name || '', companyId: user.companyId },
    company: { id: company.id, name: company.name }
  };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
  if (!token && DEMO_NO_AUTH) {
    req.user = DEMO_USER;
    req.company = DEMO_COMPANY;
    next();
    return;
  }
  const payload = verifyToken(token);
  if (!payload?.userId || !payload?.companyId) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  const user = await queryGet(`SELECT * FROM ${quoteTable('users')} WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ? LIMIT 1`, [payload.userId, payload.companyId]);
  if (!user) {
    res.status(401).json({ error: '登录已失效' });
    return;
  }
  req.user = { id: user.id, email: user.email, name: user.name || '', companyId: user.companyId };
  next();
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeOcrError(error) {
  const message = error?.message || String(error);
  if (/timeout/i.test(message)) return `OCR 超时：${message}`;
  if (/worker/i.test(message)) return `worker 加载失败：${message}`;
  if (/traineddata|language|chi_sim|chi_tra|eng/i.test(message)) return `OCR 训练包加载失败：${message}`;
  if (/enoent|no such file|read|image/i.test(message)) return `图片读取失败：${message}`;
  if (/tesseract/i.test(message)) return `Tesseract 执行失败：${message}`;
  return message;
}

function prepareRecord(table, record, deviceId, companyId) {
  const now = nowIso();
  const serverId = record.serverId || record.id || id();
  const base = {
    id: serverId,
    companyId,
    localId: record.localId || record.id || serverId,
    serverId,
    syncStatus: 'synced',
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    deletedAt: record.deletedAt || null,
    deviceId: record.deviceId || deviceId
  };

  if (table === 'purchase_batches') {
    return { ...base, batchName: record.batchName || '', supplierCount: Number(record.supplierCount || 0), invoiceCount: Number(record.invoiceCount || 0), totalAmount: Number(record.totalAmount || 0) };
  }
  if (table === 'suppliers') {
    return { ...base, name: record.name || '', phone: record.phone || '', email: record.email || '', address: record.address || '', notes: record.notes || '' };
  }
  if (table === 'invoices') {
    return { ...base, batchId: record.batchId || '', supplierId: record.supplierId || '', invoiceNo: record.invoiceNo || '', invoiceDate: record.invoiceDate || today(), imagePath: record.imagePath || '', ocrText: record.ocrText || '', totalAmount: Number(record.totalAmount || 0), status: record.status || 'saved' };
  }
  if (table === 'invoice_items') {
    return {
      ...base,
      invoiceId: record.invoiceId || '',
      supplierId: record.supplierId || '',
      productNameOriginal: record.productNameOriginal || '',
      productNameNormalized: normalizeProductName(record.productNameNormalized || record.productNameOriginal || ''),
      category: record.category || '',
      quantity: Number(record.quantity || 0),
      unit: record.unit || '',
      unitPrice: Number(record.unitPrice || 0),
      totalPrice: Number(record.totalPrice || 0),
      invoiceDate: record.invoiceDate || today(),
      notes: record.notes || ''
    };
  }
  if (table === 'products') {
    return { ...base, name: record.name || '', normalizedName: normalizeProductName(record.normalizedName || record.name || ''), category: record.category || '', notes: record.notes || '' };
  }
  if (table === 'price_history') {
    return { ...base, productId: record.productId || '', invoiceItemId: record.invoiceItemId || '', supplierId: record.supplierId || '', price: Number(record.price || 0), quantity: Number(record.quantity || 0), unit: record.unit || '', invoiceDate: record.invoiceDate || today() };
  }
  return {
    ...base,
    supplierId: record.supplierId || '',
    supplierNameKeywords: record.supplierNameKeywords || '',
    invoiceNoKeywords: record.invoiceNoKeywords || 'invoice no,invoice #,发票号,单号',
    dateKeywords: record.dateKeywords || 'date,invoice date,日期',
    itemTableStartKeywords: record.itemTableStartKeywords || '品名,商品,名称',
    itemTableEndKeywords: record.itemTableEndKeywords || '合计,总计',
    itemNameColumnIndex: Number(record.itemNameColumnIndex ?? 0),
    quantityColumnIndex: Number(record.quantityColumnIndex ?? 1),
    unitColumnIndex: Number(record.unitColumnIndex ?? 2),
    unitPriceColumnIndex: Number(record.unitPriceColumnIndex ?? 3),
    totalPriceColumnIndex: Number(record.totalPriceColumnIndex ?? 4),
    notes: record.notes || ''
  };
}

async function resolveReference(table, value, deviceId, companyId, client = null) {
  if (!value || !isValidSyncTable(table)) return value || '';
  const existing = await queryGet(`
    SELECT * FROM ${quoteTable(table)}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR (${quoteIdentifier('localId')} = ? AND ${quoteIdentifier('deviceId')} = ?))
    LIMIT 1
  `, [companyId, value, value, value, deviceId], client);
  return existing?.serverId || existing?.id || value;
}

async function prepareRecordWithReferences(table, record, deviceId, companyId, client = null) {
  const prepared = prepareRecord(table, record, deviceId, companyId);
  if (table === 'invoices') {
    prepared.batchId = await resolveReference('purchase_batches', prepared.batchId, deviceId, companyId, client);
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  if (table === 'invoice_items') {
    prepared.invoiceId = await resolveReference('invoices', prepared.invoiceId, deviceId, companyId, client);
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  if (table === 'price_history') {
    prepared.productId = await resolveReference('products', prepared.productId, deviceId, companyId, client);
    prepared.invoiceItemId = await resolveReference('invoice_items', prepared.invoiceItemId, deviceId, companyId, client);
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  if (table === 'supplier_templates') {
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  return prepared;
}

async function findOrCreateSupplier(name, deviceId, companyId, client = null) {
  const supplierName = (name || '').trim() || '未命名供应商';
  const existing = await queryGet(`
    SELECT * FROM ${quoteTable('suppliers')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('name')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    LIMIT 1
  `, [companyId, supplierName], client);
  if (existing) return existing;

  const now = nowIso();
  const serverId = id();
  const supplier = prepareRecord('suppliers', {
    id: serverId,
    localId: serverId,
    serverId,
    name: supplierName,
    createdAt: now,
    updatedAt: now
  }, deviceId, companyId);
  await upsertRecord('suppliers', supplier, client);
  return supplier;
}

async function getCloudRecord(table, incoming, companyId, client = null) {
  if (incoming.serverId) {
    const byServerId = await queryGet(`
      SELECT * FROM ${quoteTable(table)}
      WHERE ${quoteIdentifier('companyId')} = ? AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ?)
      LIMIT 1
    `, [companyId, incoming.serverId, incoming.serverId], client);
    if (byServerId) return byServerId;
  }
  if (incoming.localId && incoming.deviceId) {
    return queryGet(`
      SELECT * FROM ${quoteTable(table)}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('localId')} = ? AND ${quoteIdentifier('deviceId')} = ?
      LIMIT 1
    `, [companyId, incoming.localId, incoming.deviceId], client);
  }
  return null;
}

async function pushOne(table, incoming, deviceId, companyId, client = null) {
  const existing = await getCloudRecord(table, incoming, companyId, client);
  const incomingUpdatedAt = incoming.updatedAt || nowIso();
  if (existing && existing.updatedAt && existing.updatedAt > incomingUpdatedAt) {
    return { table, localId: incoming.localId || incoming.id, serverId: existing.serverId || existing.id, status: 'conflict', record: existing };
  }

  const record = await prepareRecordWithReferences(table, { ...incoming, serverId: existing?.serverId || existing?.id || incoming.serverId }, deviceId, companyId, client);
  await upsertRecord(table, record, client);
  return { table, localId: incoming.localId || incoming.id || record.localId, serverId: record.serverId, status: 'synced', record };
}

async function allSyncData(companyId, since) {
  const result = {};
  for (const table of syncTables) {
    const rows = since
      ? await queryAll(`
          SELECT * FROM ${quoteTable(table)}
          WHERE ${quoteIdentifier('companyId')} = ? AND (${quoteIdentifier('updatedAt')} > ? OR ${quoteIdentifier('deletedAt')} > ?)
          ORDER BY ${quoteIdentifier('updatedAt')} ASC
        `, [companyId, since, since])
      : await queryAll(`
          SELECT * FROM ${quoteTable(table)}
          WHERE ${quoteIdentifier('companyId')} = ?
          ORDER BY ${quoteIdentifier('updatedAt')} ASC
        `, [companyId]);
    result[table] = rows;
  }
  return result;
}

async function invoiceWithSupplierRows(companyId) {
  return queryAll(`
    SELECT invoices.*, suppliers.${quoteIdentifier('name')} AS "supplierName"
    FROM ${quoteTable('invoices')} invoices
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoices.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoices.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoices.${quoteIdentifier('supplierId')})
    WHERE invoices.${quoteIdentifier('companyId')} = ? AND invoices.${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY invoices.${quoteIdentifier('invoiceDate')} DESC, invoices.${quoteIdentifier('createdAt')} DESC
  `, [companyId]);
}

function parseTaskRow(row) {
  if (!row) return null;
  let result = null;
  try {
    result = row.resultJson ? JSON.parse(row.resultJson) : null;
  } catch {
    result = null;
  }
  return {
    ...row,
    usedTemplate: Boolean(Number(row.usedTemplate || 0)),
    usedAI: Boolean(Number(row.usedAI || 0)),
    retryCount: Number(row.retryCount || 0),
    fileSize: Number(row.fileSize || 0),
    result
  };
}

function taskFileFromRow(task) {
  return {
    path: task.filePath,
    filename: path.basename(task.filePath || task.imagePath || ''),
    originalname: task.originalName || '',
    mimetype: task.mimeType || 'image/jpeg',
    size: Number(task.fileSize || 0)
  };
}

let recognitionQueueRunning = false;
let currentRecognitionTaskId = '';
const pausedRecognitionBatches = new Set();

async function createRecognitionTask(file, user, deviceId = 'web', options = {}) {
  const timestamp = nowIso();
  const task = {
    id: id(),
    companyId: user.companyId,
    batchId: options.batchId || '',
    supplierHint: options.supplierHint || '',
    status: 'waiting',
    imagePath: `/uploads/${file.filename}`,
    filePath: file.path,
    originalName: file.originalname || '',
    mimeType: file.mimetype || '',
    fileSize: Number(file.size || 0),
    source: '',
    recognitionSource: '',
    ocrLanguage: '',
    usedTemplate: 0,
    usedAI: 0,
    invoiceId: '',
    resultJson: '',
    error: '',
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: '',
    completedAt: '',
    deviceId
  };
  await upsertRecord('invoice_recognition_tasks', task);
  enqueueRecognitionTask();
  return parseTaskRow(task);
}

function enqueueRecognitionTask() {
  if (recognitionQueueRunning) return;
  recognitionQueueRunning = true;
  setImmediate(() => {
    processRecognitionQueue()
      .catch((error) => console.error('[recognition-queue] unhandled failure:', error))
      .finally(() => {
        recognitionQueueRunning = false;
        currentRecognitionTaskId = '';
      });
  });
}

async function nextWaitingRecognitionTask() {
  const rows = await queryAll(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('status')} IN ('waiting', 'pending')
    ORDER BY ${quoteIdentifier('createdAt')} ASC
    LIMIT 50
  `);
  return rows.find((task) => !task.batchId || !pausedRecognitionBatches.has(task.batchId)) || null;
}

async function processRecognitionQueue() {
  while (true) {
    const task = await nextWaitingRecognitionTask();
    if (!task) return;
    currentRecognitionTaskId = task.id;
    await processRecognitionTask(task.id);
    currentRecognitionTaskId = '';
  }
}

async function processRecognitionTask(taskId) {
  const task = await queryGet(`SELECT * FROM ${quoteTable('invoice_recognition_tasks')} WHERE ${quoteIdentifier('id')} = ? LIMIT 1`, [taskId]);
  if (!task || !['waiting', 'pending', 'processing'].includes(task.status)) return;
  if (task.batchId && pausedRecognitionBatches.has(task.batchId) && task.status !== 'processing') return;
  if (!task.filePath || !fs.existsSync(task.filePath)) {
    await markRecognitionTaskFailed(taskId, `Invoice image file not found: ${task.filePath || ''}`);
    return;
  }

  const startedAt = nowIso();
  await run(`
    UPDATE ${quoteTable('invoice_recognition_tasks')}
    SET ${quoteIdentifier('status')} = 'processing',
        ${quoteIdentifier('startedAt')} = ?,
        ${quoteIdentifier('updatedAt')} = ?,
        ${quoteIdentifier('error')} = ''
    WHERE ${quoteIdentifier('id')} = ?
  `, [startedAt, startedAt, taskId]);

  try {
    console.log('[recognition-task] start:', taskId);
    const result = await withTimeout(recognizeInvoice(taskFileFromRow(task), {
      companyId: task.companyId,
      supplierHint: task.supplierHint || '',
      batchId: task.batchId || ''
    }), OCR_TIMEOUT_MS, 'Invoice recognition');
    const saveResult = await saveRecognizedInvoiceFromTask(task, result);
    const completedResult = {
      ...result,
      duplicateCheck: saveResult.duplicateCheck,
      imageHash: saveResult.imageHash || result.imageHash || ''
    };
    const completedAt = nowIso();
    await run(`
      UPDATE ${quoteTable('invoice_recognition_tasks')}
      SET ${quoteIdentifier('status')} = 'completed',
          ${quoteIdentifier('source')} = ?,
          ${quoteIdentifier('recognitionSource')} = ?,
          ${quoteIdentifier('ocrLanguage')} = ?,
          ${quoteIdentifier('usedTemplate')} = ?,
          ${quoteIdentifier('usedAI')} = ?,
          ${quoteIdentifier('invoiceId')} = ?,
          ${quoteIdentifier('resultJson')} = ?,
          ${quoteIdentifier('error')} = '',
          ${quoteIdentifier('completedAt')} = ?,
          ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('id')} = ?
    `, [
      completedResult.source || '',
      completedResult.recognitionSource || '',
      completedResult.ocrLanguage || OCR_LANGUAGE,
      completedResult.usedTemplate ? 1 : 0,
      completedResult.usedAI ? 1 : 0,
      saveResult.invoiceId || '',
      JSON.stringify(completedResult),
      completedAt,
      completedAt,
      taskId
    ]);
    console.log('[recognition-task] completed:', taskId, saveResult.invoiceId || 'duplicate-skipped');
  } catch (error) {
    await markRecognitionTaskFailed(taskId, describeOcrError(error));
  }
}

async function markRecognitionTaskFailed(taskId, error) {
  const timestamp = nowIso();
  console.error('[recognition-task] failed:', taskId, error);
  await run(`
    UPDATE ${quoteTable('invoice_recognition_tasks')}
    SET ${quoteIdentifier('status')} = 'failed',
        ${quoteIdentifier('error')} = ?,
        ${quoteIdentifier('completedAt')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ?
  `, [error || 'Recognition failed', timestamp, timestamp, taskId]);
}

function emptyDuplicateCheck() {
  return {
    isDuplicate: false,
    duplicate: false,
    duplicateReason: '',
    sameInvoiceGroup: false,
    possibleSameInvoicePages: false,
    sameInvoiceGroupReason: '',
    sameSupplierBatch: false,
    skippedSave: false
  };
}

function normalizeComparisonText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSupplierComparisonKey(value) {
  return normalizeComparisonText(value).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function comparisonAmount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function amountsNearlyEqual(a, b) {
  return Math.abs(comparisonAmount(a) - comparisonAmount(b)) < 0.01;
}

function comparisonSimilarity(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const oldDiagonal = previous[j + 1];
      const cost = left[i] === right[j] ? 0 : 1;
      previous[j + 1] = Math.min(previous[j + 1] + 1, previous[j] + 1, diagonal + cost);
      diagonal = oldDiagonal;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function supplierNamesNearlyEqual(a, b) {
  const left = normalizeSupplierComparisonKey(a);
  const right = normalizeSupplierComparisonKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 5 && right.includes(left)) return true;
  if (right.length >= 5 && left.includes(right)) return true;
  return comparisonSimilarity(left, right) >= 0.86;
}

function itemComparisonName(item = {}) {
  return normalizeComparisonText(item.productNameNormalized || item.normalizedName || item.productNameOriginal || item.name || [item.nameCn, item.nameEn].filter(Boolean).join(' ')).replace(/\s+/g, ' ');
}

function invoiceComparisonFingerprint({ supplierName = '', invoiceNo = '', totalAmount = 0, items = [] }) {
  return {
    supplierName,
    invoiceNo: normalizeComparisonText(invoiceNo),
    totalAmount: comparisonAmount(totalAmount),
    itemCount: items.length,
    itemNames: items.map(itemComparisonName).filter(Boolean).sort(),
    totalQuantity: comparisonAmount(items.reduce((sum, item) => sum + Number(item.quantity ?? item.qty ?? 0), 0))
  };
}

function itemNameSimilarity(left = [], right = []) {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let matches = 0;
  for (const name of left) {
    if (rightSet.has(name) || right.some((candidate) => comparisonSimilarity(name, candidate) >= 0.88)) matches += 1;
  }
  return matches / Math.max(left.length, right.length);
}

function invoiceItemsNearlyEqual(a, b) {
  if (a.itemCount !== b.itemCount) return false;
  if (a.itemCount === 0 && b.itemCount === 0) return true;
  if (itemNameSimilarity(a.itemNames, b.itemNames) >= 0.8) return true;
  return a.itemNames.length === 0 && b.itemNames.length === 0 && amountsNearlyEqual(a.totalQuantity, b.totalQuantity);
}

function compareInvoiceForDuplicate(current, candidate, label) {
  const result = emptyDuplicateCheck();
  if (!current.invoiceNo || current.invoiceNo !== candidate.invoiceNo) return result;
  if (!supplierNamesNearlyEqual(current.supplierName, candidate.supplierName)) return result;

  result.sameSupplierBatch = true;
  const sameAmount = amountsNearlyEqual(current.totalAmount, candidate.totalAmount);
  const sameItems = invoiceItemsNearlyEqual(current, candidate);

  if (sameAmount && sameItems) {
    result.isDuplicate = true;
    result.duplicate = true;
    result.duplicateReason = `${label}：同供应商、同发票号、同金额，且商品明细高度相似`;
    result.skippedSave = true;
    return result;
  }

  result.sameInvoiceGroup = true;
  result.possibleSameInvoicePages = !sameAmount;
  result.sameInvoiceGroupReason = sameAmount
    ? '同供应商同发票号，金额相同但商品明细不同，请人工确认。'
    : '同供应商同发票号，但金额不同，可能是同一发票的不同页/同批次发票，请人工确认。';
  return result;
}

async function sha256File(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function findRecognitionDuplicate(companyId, parsed, totalAmount, currentItems, excludeInvoiceId = '', batchId = '') {
  const current = invoiceComparisonFingerprint({
    supplierName: parsed.supplierName || '',
    invoiceNo: parsed.invoiceNo || '',
    totalAmount,
    items: currentItems
  });
  if (!current.invoiceNo) return emptyDuplicateCheck();

  const candidates = await queryAll(`
    SELECT invoices.*, suppliers.${quoteIdentifier('name')} AS "supplierName"
    FROM ${quoteTable('invoices')} invoices
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoices.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoices.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoices.${quoteIdentifier('supplierId')})
    WHERE invoices.${quoteIdentifier('companyId')} = ?
      AND invoices.${quoteIdentifier('deletedAt')} IS NULL
      AND LOWER(invoices.${quoteIdentifier('invoiceNo')}) = ?
  `, [companyId, current.invoiceNo]);

  let groupInfo = emptyDuplicateCheck();
  for (const candidate of candidates) {
    const candidateIdList = [candidate.id, candidate.localId, candidate.serverId].filter(Boolean);
    if (excludeInvoiceId && candidateIdList.includes(excludeInvoiceId)) continue;
    if (candidateIdList.length === 0) continue;
    const items = await queryAll(`
      SELECT * FROM ${quoteTable('invoice_items')}
      WHERE ${quoteIdentifier('companyId')} = ?
        AND ${quoteIdentifier('deletedAt')} IS NULL
        AND ${quoteIdentifier('invoiceId')} IN (${candidateIdList.map(() => '?').join(',')})
    `, [companyId, ...candidateIdList]);
    const candidateFingerprint = invoiceComparisonFingerprint({
      supplierName: candidate.supplierName || '',
      invoiceNo: candidate.invoiceNo || '',
      totalAmount: candidate.totalAmount || items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0),
      items
    });
    const duplicateInfo = compareInvoiceForDuplicate(current, candidateFingerprint, '云端已有发票');
    if (duplicateInfo.isDuplicate) return duplicateInfo;
    if (duplicateInfo.sameInvoiceGroup && batchId && candidate.batchId === batchId) {
      return {
        ...duplicateInfo,
        sameInvoiceGroup: true,
        possibleSameInvoicePages: true,
        multiPageInvoice: true,
        mergeInvoiceId: candidate.serverId || candidate.id,
        pageTotal: totalAmount,
        sameInvoiceGroupReason: '同批次同供应商同发票号，金额和商品不同，已自动判定为同一发票多页并合并。'
      };
    }
    if (duplicateInfo.sameInvoiceGroup && !groupInfo.sameInvoiceGroup) groupInfo = duplicateInfo;
  }
  return groupInfo;
}

async function saveRecognizedInvoiceFromTask(task, result, options = {}) {
  const parsed = result.parsed || {};
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const deviceId = task.deviceId || 'recognition-task';
  const companyId = task.companyId;
  const now = nowIso();
  const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  const totalAmount = Number(parsed.totalAmount || 0) > 0 ? Number(parsed.totalAmount) : itemTotal;
  const imageHash = await sha256File(task.filePath);
  const duplicateCheck = await findRecognitionDuplicate(companyId, parsed, totalAmount, items, task.invoiceId, task.batchId || '');
  duplicateCheck.pageTotal = totalAmount;
  duplicateCheck.calculatedTotal = itemTotal;
  duplicateCheck.totalDifference = Math.abs(itemTotal - totalAmount);
  if (duplicateCheck.isDuplicate && !options.force) {
    return { invoiceId: '', duplicateCheck, imageHash };
  }
  if (options.force) {
    duplicateCheck.forcedSave = true;
    duplicateCheck.skippedSave = false;
  }
  const supplier = await findOrCreateSupplier(parsed.supplierName, deviceId, companyId);
  const mergeInvoiceId = !options.independent && duplicateCheck.multiPageInvoice ? duplicateCheck.mergeInvoiceId : '';
  const existingInvoice = mergeInvoiceId ? await queryGet(`
    SELECT * FROM ${quoteTable('invoices')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ?)
    LIMIT 1
  `, [companyId, mergeInvoiceId, mergeInvoiceId]) : null;
  const invoiceId = mergeInvoiceId || task.invoiceId || id();
  const invoiceTotal = existingInvoice
    ? Number(existingInvoice.totalAmount || 0) + totalAmount
    : totalAmount;
  if (existingInvoice) {
    duplicateCheck.mergedIntoInvoiceId = existingInvoice.serverId || existingInvoice.id;
    duplicateCheck.invoiceTotal = invoiceTotal;
  }
  const invoice = await prepareRecordWithReferences('invoices', {
    id: invoiceId,
    localId: invoiceId,
    serverId: invoiceId,
    supplierId: supplier?.serverId || supplier?.id || '',
    invoiceNo: parsed.invoiceNo || '',
    invoiceDate: parsed.invoiceDate || today(),
    batchId: task.batchId || existingInvoice?.batchId || '',
    imagePath: existingInvoice?.imagePath || result.imagePath || task.imagePath || '',
    ocrText: [existingInvoice?.ocrText, result.ocrText].filter(Boolean).join('\n\n--- page ---\n\n'),
    totalAmount: invoiceTotal,
    status: existingInvoice ? 'recognized-multipage' : 'recognized',
    createdAt: existingInvoice?.createdAt || task.createdAt || now,
    updatedAt: now
  }, deviceId, companyId);

  await withTransaction(async (client) => {
    await upsertRecord('invoices', invoice, client);
    if (!existingInvoice) {
      await run(`
        UPDATE ${quoteTable('invoice_items')}
        SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
        WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
      `, [now, now, companyId, invoice.serverId], client);
    }
    for (const item of items.filter((entry) => (entry.productNameOriginal || entry.name || '').trim())) {
      const itemId = id();
      const itemRecord = await prepareRecordWithReferences('invoice_items', {
        id: itemId,
        localId: itemId,
        serverId: itemId,
        productNameOriginal: item.productNameOriginal || item.name || '',
        productNameNormalized: item.productNameNormalized || item.normalizedName || item.standardName || item.name || '',
        category: item.category || '',
        quantity: Number(item.quantity ?? item.qty ?? 0),
        unit: item.unit || item.spec || '',
        unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.totalPrice || 0),
        notes: [item.notes, duplicateCheck.multiPageInvoice ? `pageTotal=${totalAmount.toFixed(2)}` : ''].filter(Boolean).join(' | '),
        invoiceId: invoice.serverId,
        supplierId: invoice.supplierId,
        invoiceDate: invoice.invoiceDate,
        updatedAt: now
      }, deviceId, companyId, client);
      await upsertRecord('invoice_items', itemRecord, client);
    }
  });

  return { invoiceId: invoice.serverId || invoice.id, duplicateCheck, imageHash };
}

async function resumeRecognitionTasks() {
  await run(`
    UPDATE ${quoteTable('invoice_recognition_tasks')}
    SET ${quoteIdentifier('status')} = 'waiting',
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('status')} = 'processing'
  `, [nowIso()]);
  const tasks = await queryAll(`
    SELECT ${quoteIdentifier('id')} FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('status')} IN ('waiting', 'pending')
    ORDER BY ${quoteIdentifier('createdAt')} ASC
  `);
  if (tasks.length) enqueueRecognitionTask();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: usingPostgres ? 'postgres' : 'sqlite', time: nowIso() });
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, service: 'InvoicePriceTracker API', host: '0.0.0.0', port: PORT, database: usingPostgres ? 'postgres' : 'sqlite', time: nowIso() });
});

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const companyName = String(req.body.companyName || '').trim() || '我的门店';
  const name = String(req.body.name || '').trim();
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  const existing = await queryGet(`SELECT * FROM ${quoteTable('users')} WHERE LOWER(${quoteIdentifier('email')}) = ? LIMIT 1`, [email]);
  if (existing) return res.status(409).json({ error: '这个邮箱已经注册' });

  const now = nowIso();
  const company = { id: id(), name: companyName, createdAt: now, updatedAt: now };
  const user = { id: id(), companyId: company.id, email, passwordHash: hashPassword(password), name, createdAt: now, updatedAt: now };
  await withTransaction(async (client) => {
    await upsertRecord('companies', company, client);
    await upsertRecord('users', user, client);
  });
  res.json(authResponse(user, company));
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await queryGet(`SELECT * FROM ${quoteTable('users')} WHERE LOWER(${quoteIdentifier('email')}) = ? LIMIT 1`, [email]);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: '邮箱或密码不正确' });
  }
  const company = await queryGet(`SELECT * FROM ${quoteTable('companies')} WHERE ${quoteIdentifier('id')} = ? LIMIT 1`, [user.companyId]);
  res.json(authResponse(user, company || { id: user.companyId, name: '' }));
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
  if (DEMO_NO_AUTH && req.user.id === DEMO_USER.id) {
    res.json({ user: DEMO_USER, company: DEMO_COMPANY, demo: true });
    return;
  }
  const company = await queryGet(`SELECT * FROM ${quoteTable('companies')} WHERE ${quoteIdentifier('id')} = ? LIMIT 1`, [req.user.companyId]);
  res.json({ user: req.user, company: company || { id: req.user.companyId, name: '' } });
}));

app.use('/api/ai-invoice', requireAuth, aiInvoiceRoutes);

app.post('/api/sync/push', requireAuth, asyncHandler(async (req, res) => {
  const deviceId = req.body.deviceId || 'unknown';
  const companyId = req.user.companyId;
  const changes = req.body.changes || {};
  const results = [];

  await withTransaction(async (client) => {
    for (const table of syncTables) {
      const records = Array.isArray(changes[table]) ? changes[table] : [];
      for (const record of records) {
        results.push(await pushOne(table, record, deviceId, companyId, client));
      }
    }
  });

  res.json({ ok: true, companyId, serverTime: nowIso(), results });
}));

app.get('/api/sync/pull', requireAuth, asyncHandler(async (req, res) => {
  res.json({ companyId: req.user.companyId, serverTime: nowIso(), data: await allSyncData(req.user.companyId, req.query.since || '') });
}));

app.get('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  res.json(await queryAll(`
    SELECT * FROM ${quoteTable('suppliers')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('name')} ASC
  `, [req.user.companyId]));
}));

app.post('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  const record = prepareRecord('suppliers', req.body, req.body.deviceId || 'legacy-api', req.user.companyId);
  await upsertRecord('suppliers', record);
  res.json(record);
}));

app.put('/api/suppliers/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getByAnyId('suppliers', req.params.id, req.user.companyId);
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });
  const record = prepareRecord('suppliers', { ...existing, ...req.body, serverId: existing.serverId || existing.id, updatedAt: nowIso() }, req.body.deviceId || existing.deviceId || 'legacy-api', req.user.companyId);
  await upsertRecord('suppliers', record);
  res.json(record);
}));

app.delete('/api/suppliers/:id', requireAuth, asyncHandler(async (req, res) => {
  const deletedAt = nowIso();
  await run(`
    UPDATE ${quoteTable('suppliers')}
    SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('syncStatus')} = 'synced', ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ? AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ?)
  `, [deletedAt, deletedAt, req.user.companyId, req.params.id, req.params.id]);
  await run(`
    UPDATE ${quoteTable('supplier_templates')}
    SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('syncStatus')} = 'synced', ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('supplierId')} = ?
  `, [deletedAt, deletedAt, req.user.companyId, req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/suppliers/:id/template', requireAuth, asyncHandler(async (req, res) => {
  const template = await queryGet(`
    SELECT * FROM ${quoteTable('supplier_templates')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('supplierId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('updatedAt')} DESC LIMIT 1
  `, [req.user.companyId, req.params.id]);
  res.json(template || null);
}));

app.put('/api/suppliers/:id/template', requireAuth, asyncHandler(async (req, res) => {
  const existing = await queryGet(`
    SELECT * FROM ${quoteTable('supplier_templates')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('supplierId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('updatedAt')} DESC LIMIT 1
  `, [req.user.companyId, req.params.id]);
  const record = await prepareRecordWithReferences('supplier_templates', { ...req.body, id: existing?.id, serverId: existing?.serverId || existing?.id, supplierId: req.params.id, updatedAt: nowIso() }, req.body.deviceId || 'legacy-api', req.user.companyId);
  await upsertRecord('supplier_templates', record);
  res.json(record);
}));

app.get('/api/invoices', requireAuth, asyncHandler(async (req, res) => {
  res.json(await invoiceWithSupplierRows(req.user.companyId));
}));

app.get('/api/purchase-batches', requireAuth, asyncHandler(async (req, res) => {
  res.json(await queryAll(`
    SELECT * FROM ${quoteTable('purchase_batches')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('createdAt')} DESC
  `, [req.user.companyId]));
}));

app.post('/api/purchase-batches', requireAuth, asyncHandler(async (req, res) => {
  const batch = prepareRecord('purchase_batches', { ...req.body, updatedAt: nowIso() }, req.body.deviceId || 'legacy-api', req.user.companyId);
  await upsertRecord('purchase_batches', batch);
  res.json(batch);
}));

app.post('/api/invoices', requireAuth, asyncHandler(async (req, res) => {
  const deviceId = req.body.deviceId || 'legacy-api';
  const supplier = req.body.supplierId
    ? await getByAnyId('suppliers', req.body.supplierId, req.user.companyId)
    : await findOrCreateSupplier(req.body.supplierName, deviceId, req.user.companyId);
  const now = nowIso();
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  const totalAmount = Number(req.body.totalAmount || 0) > 0 ? Number(req.body.totalAmount) : itemTotal;
  const invoice = await prepareRecordWithReferences('invoices', { ...req.body, supplierId: supplier?.serverId || supplier?.id || '', totalAmount, updatedAt: now }, deviceId, req.user.companyId);

  await withTransaction(async (client) => {
    await upsertRecord('invoices', invoice, client);
    await run(`
      UPDATE ${quoteTable('invoice_items')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
    `, [now, now, req.user.companyId, invoice.serverId], client);
    for (const item of items.filter((entry) => (entry.productNameOriginal || '').trim())) {
      const record = await prepareRecordWithReferences('invoice_items', { ...item, invoiceId: invoice.serverId, supplierId: invoice.supplierId, invoiceDate: invoice.invoiceDate, updatedAt: now }, deviceId, req.user.companyId, client);
      await upsertRecord('invoice_items', record, client);
    }
  });
  res.json({ ...invoice, supplierName: supplier?.name || '未命名供应商' });
}));

app.get('/api/invoices/:id', requireAuth, asyncHandler(async (req, res) => {
  const invoice = await queryGet(`
    SELECT invoices.*, suppliers.${quoteIdentifier('name')} AS "supplierName"
    FROM ${quoteTable('invoices')} invoices
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoices.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoices.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoices.${quoteIdentifier('supplierId')})
    WHERE invoices.${quoteIdentifier('companyId')} = ?
      AND (invoices.${quoteIdentifier('id')} = ? OR invoices.${quoteIdentifier('serverId')} = ? OR invoices.${quoteIdentifier('localId')} = ?)
      AND invoices.${quoteIdentifier('deletedAt')} IS NULL
    LIMIT 1
  `, [req.user.companyId, req.params.id, req.params.id, req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const invoiceIds = [invoice.id, invoice.serverId, invoice.localId].filter(Boolean);
  const placeholders = invoiceIds.map(() => '?').join(', ');
  const items = await queryAll(`
    SELECT * FROM ${quoteTable('invoice_items')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${placeholders}) AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('createdAt')} ASC
  `, [req.user.companyId, ...invoiceIds]);
  res.json({ invoice, items });
}));

app.delete('/api/invoices/:id', requireAuth, asyncHandler(async (req, res) => {
  const deletedAt = nowIso();
  await run(`
    UPDATE ${quoteTable('invoices')}
    SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ? AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
  `, [deletedAt, deletedAt, req.user.companyId, req.params.id, req.params.id, req.params.id]);
  await run(`
    UPDATE ${quoteTable('invoice_items')}
    SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
  `, [deletedAt, deletedAt, req.user.companyId, req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/products/search', requireAuth, asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const like = `%${q}%`;
  const summaries = await queryAll(`
    SELECT
      CASE WHEN ${quoteIdentifier('productNameNormalized')} IS NULL OR ${quoteIdentifier('productNameNormalized')} = '' THEN ${quoteIdentifier('productNameOriginal')} ELSE ${quoteIdentifier('productNameNormalized')} END AS "standardName",
      MIN(${quoteIdentifier('unitPrice')}) AS "minPrice",
      MAX(${quoteIdentifier('unitPrice')}) AS "maxPrice",
      AVG(${quoteIdentifier('unitPrice')}) AS "averagePrice",
      MAX(${quoteIdentifier('invoiceDate')}) AS "recentPurchaseDate",
      COUNT(*) AS "recordCount"
    FROM ${quoteTable('invoice_items')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
      AND (LOWER(${quoteIdentifier('productNameOriginal')}) LIKE ? OR LOWER(${quoteIdentifier('productNameNormalized')}) LIKE ?)
    GROUP BY "standardName"
    ORDER BY "recentPurchaseDate" DESC
  `, [req.user.companyId, like, like]);

  for (const row of summaries) {
    const recent = await queryGet(`
      SELECT ${quoteIdentifier('unitPrice')} FROM ${quoteTable('invoice_items')}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
        AND (${quoteIdentifier('productNameNormalized')} = ? OR ${quoteIdentifier('productNameOriginal')} = ?)
      ORDER BY ${quoteIdentifier('invoiceDate')} DESC, ${quoteIdentifier('createdAt')} DESC LIMIT 1
    `, [req.user.companyId, row.standardName, row.standardName]);
    row.recentPrice = recent?.unitPrice || 0;
  }
  res.json(summaries);
}));

app.get('/api/products/:name', requireAuth, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const rows = await queryAll(`
    SELECT invoice_items.*, suppliers.${quoteIdentifier('name')} AS "supplierName", invoices.${quoteIdentifier('invoiceNo')} AS "invoiceNo"
    FROM ${quoteTable('invoice_items')} invoice_items
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('supplierId')})
    LEFT JOIN ${quoteTable('invoices')} invoices
      ON invoices.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (invoices.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('invoiceId')} OR invoices.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('invoiceId')})
    WHERE invoice_items.${quoteIdentifier('companyId')} = ?
      AND invoice_items.${quoteIdentifier('deletedAt')} IS NULL
      AND (invoice_items.${quoteIdentifier('productNameNormalized')} = ? OR invoice_items.${quoteIdentifier('productNameOriginal')} = ? OR LOWER(invoice_items.${quoteIdentifier('productNameOriginal')}) LIKE ?)
    ORDER BY invoice_items.${quoteIdentifier('invoiceDate')} DESC, invoice_items.${quoteIdentifier('createdAt')} DESC
  `, [req.user.companyId, name, name, `%${name.toLowerCase()}%`]);
  res.json(rows);
}));

app.post('/api/invoice-recognition/tasks', requireAuth, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'No invoice image uploaded' });
    return;
  }
  const task = await createRecognitionTask(req.file, req.user, req.body.deviceId || 'web', {
    batchId: req.body.batchId || '',
    supplierHint: req.body.supplierHint || ''
  });
  res.status(202).json({ success: true, taskId: task.id, task });
}));

app.post('/api/invoice-recognition/batches/:batchId/pause', requireAuth, asyncHandler(async (req, res) => {
  pausedRecognitionBatches.add(req.params.batchId);
  res.json({ success: true, batchId: req.params.batchId, paused: true, currentTaskId: currentRecognitionTaskId });
}));

app.post('/api/invoice-recognition/batches/:batchId/resume', requireAuth, asyncHandler(async (req, res) => {
  pausedRecognitionBatches.delete(req.params.batchId);
  enqueueRecognitionTask();
  res.json({ success: true, batchId: req.params.batchId, paused: false });
}));

app.post('/api/invoice-recognition/batches/:batchId/cancel', requireAuth, asyncHandler(async (req, res) => {
  const timestamp = nowIso();
  const result = await run(`
    UPDATE ${quoteTable('invoice_recognition_tasks')}
    SET ${quoteIdentifier('status')} = 'failed',
        ${quoteIdentifier('error')} = ?,
        ${quoteIdentifier('completedAt')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('batchId')} = ?
      AND ${quoteIdentifier('status')} IN ('waiting', 'pending')
  `, ['已取消剩余识别', timestamp, timestamp, req.user.companyId, req.params.batchId]);
  pausedRecognitionBatches.delete(req.params.batchId);
  res.json({ success: true, batchId: req.params.batchId, cancelled: result?.changes ?? 0 });
}));

app.get('/api/invoice-recognition/tasks', requireAuth, asyncHandler(async (req, res) => {
  const rows = await queryAll(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('companyId')} = ?
    ORDER BY ${quoteIdentifier('createdAt')} DESC
  `, [req.user.companyId]);
  res.json(rows.map(parseTaskRow));
}));

app.get('/api/invoice-recognition/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const task = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
    LIMIT 1
  `, [req.params.id, req.user.companyId]);
  if (!task) return res.status(404).json({ error: 'Recognition task not found' });
  res.json(parseTaskRow(task));
}));

app.post('/api/invoice-recognition/tasks/:id/retry', requireAuth, asyncHandler(async (req, res) => {
  const task = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
    LIMIT 1
  `, [req.params.id, req.user.companyId]);
  if (!task) return res.status(404).json({ error: 'Recognition task not found' });
  if (!task.filePath || !fs.existsSync(task.filePath)) return res.status(400).json({ error: 'Original invoice image is missing' });
  const timestamp = nowIso();
  await run(`
    UPDATE ${quoteTable('invoice_recognition_tasks')}
    SET ${quoteIdentifier('status')} = 'waiting',
        ${quoteIdentifier('error')} = '',
        ${quoteIdentifier('startedAt')} = '',
        ${quoteIdentifier('completedAt')} = '',
        ${quoteIdentifier('retryCount')} = COALESCE(${quoteIdentifier('retryCount')}, 0) + 1,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [timestamp, req.params.id, req.user.companyId]);
  enqueueRecognitionTask();
  const updated = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
    LIMIT 1
  `, [req.params.id, req.user.companyId]);
  res.json({ success: true, task: parseTaskRow(updated) });
}));

app.post('/api/invoice-recognition/tasks/:id/force-save', requireAuth, asyncHandler(async (req, res) => {
  const task = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
    LIMIT 1
  `, [req.params.id, req.user.companyId]);
  if (!task) return res.status(404).json({ error: 'Recognition task not found' });
  if (task.status !== 'completed') return res.status(409).json({ error: 'Only completed recognition tasks can be force saved' });

  const parsedTask = parseTaskRow(task);
  if (parsedTask.invoiceId) return res.json({ success: true, task: parsedTask });
  if (!parsedTask.result?.parsed) return res.status(409).json({ error: 'Recognition result is empty' });

  const saveResult = await saveRecognizedInvoiceFromTask(task, parsedTask.result, { force: true });
  const resultJson = {
    ...parsedTask.result,
    duplicateCheck: saveResult.duplicateCheck,
    imageHash: saveResult.imageHash || parsedTask.result.imageHash || ''
  };
  const timestamp = nowIso();
  await run(`
    UPDATE ${quoteTable('invoice_recognition_tasks')}
    SET ${quoteIdentifier('invoiceId')} = ?,
        ${quoteIdentifier('resultJson')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [saveResult.invoiceId || '', JSON.stringify(resultJson), timestamp, req.params.id, req.user.companyId]);
  const updated = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
    LIMIT 1
  `, [req.params.id, req.user.companyId]);
  res.json({ success: true, task: parseTaskRow(updated) });
}));

app.post('/api/invoice-recognition/tasks/:id/decision', requireAuth, asyncHandler(async (req, res) => {
  const action = String(req.body.action || '').trim();
  if (!['merge', 'duplicate', 'independent'].includes(action)) {
    return res.status(400).json({ error: 'Invalid decision action' });
  }
  const task = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
    LIMIT 1
  `, [req.params.id, req.user.companyId]);
  if (!task) return res.status(404).json({ error: 'Recognition task not found' });
  const parsedTask = parseTaskRow(task);
  if (!parsedTask.result?.parsed) return res.status(409).json({ error: 'Recognition result is empty' });

  let invoiceId = parsedTask.invoiceId || '';
  const resultJson = { ...parsedTask.result };
  resultJson.duplicateCheck = {
    ...(resultJson.duplicateCheck || {}),
    manualDecision: action,
    decidedAt: nowIso()
  };

  if (action === 'duplicate') {
    resultJson.duplicateCheck.isDuplicate = true;
    resultJson.duplicateCheck.duplicate = true;
    resultJson.duplicateCheck.skippedSave = true;
    resultJson.duplicateCheck.duplicateReason = resultJson.duplicateCheck.duplicateReason || '用户标记为重复发票';
    invoiceId = '';
  } else if (!invoiceId) {
    const saveResult = await saveRecognizedInvoiceFromTask(task, resultJson, {
      force: true,
      independent: action === 'independent'
    });
    invoiceId = saveResult.invoiceId || '';
    resultJson.duplicateCheck = {
      ...resultJson.duplicateCheck,
      ...saveResult.duplicateCheck,
      manualDecision: action,
      decidedAt: nowIso()
    };
    resultJson.imageHash = saveResult.imageHash || resultJson.imageHash || '';
  }

  const timestamp = nowIso();
  await run(`
    UPDATE ${quoteTable('invoice_recognition_tasks')}
    SET ${quoteIdentifier('invoiceId')} = ?,
        ${quoteIdentifier('resultJson')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [invoiceId, JSON.stringify(resultJson), timestamp, req.params.id, req.user.companyId]);
  const updated = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
    LIMIT 1
  `, [req.params.id, req.user.companyId]);
  res.json({ success: true, task: parseTaskRow(updated) });
}));

app.post('/api/ocr', requireAuth, upload.single('image'), asyncHandler(async (req, res) => {
  console.log('[ocr] request received');
  console.log('[ocr] companyId:', req.user.companyId);
  console.log('[ocr] has image:', Boolean(req.file));

  if (!req.file) {
    const error = '未收到图片文件';
    console.error('[ocr] failed:', error);
    res.status(400).json({ success: false, error });
    return;
  }

  const imagePath = `/uploads/${req.file.filename}`;
  console.log('[ocr] image original name:', req.file.originalname || '');
  console.log('[ocr] image filename:', req.file.filename);
  console.log('[ocr] image size:', req.file.size);
  console.log('[ocr] image path:', req.file.path);
  console.log('[ocr] image mimetype:', req.file.mimetype || '');

  try {
    if (!fs.existsSync(req.file.path)) throw new Error(`图片文件不存在：${req.file.path}`);
    const stat = fs.statSync(req.file.path);
    console.log('[ocr] file stat size:', stat.size);
    console.log('[ocr] engine: template-first + AI Vision fallback');
    console.log('[ocr] language:', OCR_LANGUAGE);
    console.log('[ocr] timeout ms:', OCR_TIMEOUT_MS);
    console.log('[ocr] start');

    const result = await withTimeout(recognizeInvoice(req.file, { companyId: req.user.companyId }), OCR_TIMEOUT_MS, 'Invoice recognition');
    const ocrText = result.ocrText || '';
    console.log('[ocr] end');
    console.log('[ocr] text length:', ocrText.length);
    console.log('[ocr] recognitionSource:', result.recognitionSource || result.source || '');
    console.log('[ocr] ocrLanguage:', result.ocrLanguage || OCR_LANGUAGE);
    console.log('[ocr] usedTemplate:', Boolean(result.usedTemplate));
    console.log('[ocr] usedAI:', Boolean(result.usedAI));
    console.log('[ocr] warnings:', JSON.stringify(result.parsed?.warnings || []));
    console.log('[ocr] parsed supplier:', result.parsed?.supplierName || '');
    console.log('[ocr] parsed item count:', result.parsed?.items?.length || 0);

    res.json({ ...result, success: true, imagePath: result.imagePath || imagePath, message: result.message || 'Invoice recognized' });
  } catch (error) {
    const detailedError = describeOcrError(error);
    console.error('[ocr] failed message:', detailedError);
    console.error('[ocr] failed stack:', error?.stack || error);
    res.status(500).json({
      success: false,
      imagePath,
      ocrText: '',
      parsed: { supplierName: '', items: [] },
      error: detailedError
    });
  }
}));

app.get('/api/stats', requireAuth, asyncHandler(async (req, res) => {
  const stats = {};
  for (const table of syncTables) {
    const row = await queryGet(`
      SELECT COUNT(*) AS "count" FROM ${quoteTable(table)}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [req.user.companyId]);
    stats[table] = Number(row?.count || 0);
  }
  res.json(stats);
}));

app.get('/api/export.csv', requireAuth, asyncHandler(async (req, res) => {
  const rows = await queryAll(`
    SELECT invoices.${quoteIdentifier('id')} AS "invoiceId", invoices.${quoteIdentifier('invoiceNo')} AS "invoiceNo", invoices.${quoteIdentifier('invoiceDate')} AS "invoiceDate",
           suppliers.${quoteIdentifier('name')} AS "supplier",
           invoice_items.${quoteIdentifier('productNameOriginal')} AS "productNameOriginal",
           invoice_items.${quoteIdentifier('productNameNormalized')} AS "productNameNormalized",
           invoice_items.${quoteIdentifier('category')} AS "category",
           invoice_items.${quoteIdentifier('quantity')} AS "quantity",
           invoice_items.${quoteIdentifier('unit')} AS "unit",
           invoice_items.${quoteIdentifier('unitPrice')} AS "unitPrice",
           invoice_items.${quoteIdentifier('totalPrice')} AS "totalPrice",
           invoice_items.${quoteIdentifier('notes')} AS "notes",
           invoices.${quoteIdentifier('imagePath')} AS "imagePath"
    FROM ${quoteTable('invoice_items')} invoice_items
    LEFT JOIN ${quoteTable('invoices')} invoices
      ON invoices.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (invoices.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('invoiceId')} OR invoices.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('invoiceId')})
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('supplierId')})
    WHERE invoice_items.${quoteIdentifier('companyId')} = ? AND invoice_items.${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY invoices.${quoteIdentifier('invoiceDate')} DESC, invoice_items.${quoteIdentifier('createdAt')} DESC
  `, [req.user.companyId]);
  const header = ['invoiceId', 'invoiceNo', 'invoiceDate', 'supplier', 'productNameOriginal', 'productNameNormalized', 'category', 'quantity', 'unit', 'unitPrice', 'totalPrice', 'notes', 'imagePath'];
  const csv = [rowToCsv(header), ...rows.map((row) => rowToCsv(header.map((key) => row[key])))].join('\n');
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`InvoicePriceTrackerExport-${today()}.csv`);
  res.send(`\uFEFF${csv}`);
}));

app.delete('/api/dev/clear', requireAuth, asyncHandler(async (req, res) => {
  const deletedAt = nowIso();
  for (const table of syncTables) {
    await run(`
      UPDATE ${quoteTable(table)}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('syncStatus')} = 'deleted', ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [deletedAt, deletedAt, req.user.companyId]);
  }
  res.json({ ok: true });
}));

app.use((error, req, res, next) => {
  console.error('[server] error:', error);
  res.status(error.status || 500).json({ error: error.message || 'Server error' });
});

const frontendDist = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
}

setTimeout(() => {
  resumeRecognitionTasks().catch((error) => console.error('[recognition-task] resume failed:', error));
}, 500);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});
