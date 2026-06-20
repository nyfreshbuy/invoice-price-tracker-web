import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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
import { saveOrUpdateTemplateFromResult } from './services/invoiceTemplateService.js';
import {
  detectDiscountLine,
  discountTypeFor,
  displayRawName,
  displayStandardName,
  normalizeProductNameAdvanced,
  promoGroupCandidate
} from './services/productNormalizationService.js';
import {
  buildSupplierDisplayName,
  cleanSupplierEnglishName,
  displaySupplierName,
  isSupplierDuplicateCandidate,
  mergeAliases,
  normalizeSupplierName,
  parseAliases,
  splitSupplierNameParts,
  supplierAliasesFromName
} from './services/supplierNormalizationService.js';
import { buildInvoiceGroupKey } from './services/handwrittenInvoiceService.js';
import {
  createConnectionRequest,
  acceptMongoInvitation,
  createMongoInvitation,
  createMongoUser,
  decideConnection,
  expireMongoInvitation,
  findMongoCompanyById,
  findMongoInvitationByToken,
  getMongoDb,
  getMongoConnectionSnapshot,
  getMongoDebugStatus,
  findMongoUserByEmail,
  findMongoUserById,
  findMongoUserByLogin,
  isMongoAuthConfigured,
  listMongoInvitations,
  listReceivedConnections,
  listSentConnections,
  searchMongoUsers,
  toPublicMongoUser,
  updateMongoUserFromLegacy
} from './services/mongoAccountStore.js';
import { mongoSyncPull, mongoSyncPush, mongoSyncStatus } from './services/mongoSyncStore.js';

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

export const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = process.env.UPLOAD_DIR || path.resolve(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const OCR_LANGUAGE = process.env.OCR_LANG || 'eng+chi_sim';
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120000);
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-only-change-me';
const AUTH_STORE = String(process.env.AUTH_STORE || process.env.AUTH_DB || '').trim().toLowerCase();

const hasMongoUri = Boolean(process.env.MONGODB_URI || process.env.MONGO_URL);
const syncBackend = hasMongoUri ? 'MongoDB' : (usingPostgres ? 'PostgreSQL' : 'SQLite');
console.log('Mongo URI configured:', !!process.env.MONGODB_URI);
console.log(`[database] mode: ${syncBackend}`);
console.log(`[sync] enabled (${syncBackend})`);
console.log('[mongo] startup status:', getMongoConnectionSnapshot());

function useMongoAuth() {
  if (!isMongoAuthConfigured()) return false;
  if (['sqlite', 'sql', 'postgres', 'postgresql'].includes(AUTH_STORE)) return false;
  if (process.env.USE_MONGO_AUTH === 'false') return false;
  return AUTH_STORE === ''
    || AUTH_STORE === 'mongo'
    || AUTH_STORE === 'mongodb'
    || process.env.USE_MONGO_AUTH === 'true';
}

function useMongoSync() {
  return hasMongoUri && process.env.USE_MONGO_SYNC !== 'false';
}

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
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  let body;
  let signature;
  let signedContent;
  if (parts.length === 3) {
    [, body, signature] = parts;
    signedContent = `${parts[0]}.${body}`;
  } else if (parts.length === 2) {
    [body, signature] = parts;
    signedContent = body;
  } else {
    return null;
  }
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(signedContent).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function optionalAuthPayload(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifyToken(token);
}

const pbkdf2Async = promisify(crypto.pbkdf2);
const LEGACY_PASSWORD_ITERATIONS = 120000;
const PASSWORD_HASH_ITERATIONS = Number(process.env.PASSWORD_HASH_ITERATIONS || 60000);

async function pbkdf2Hex(password, salt, iterations) {
  const buffer = await pbkdf2Async(String(password), salt, iterations, 32, 'sha256');
  return buffer.toString('hex');
}

async function hashPasswordAsync(password, salt = crypto.randomBytes(16).toString('hex'), iterations = PASSWORD_HASH_ITERATIONS) {
  const hash = await pbkdf2Hex(password, salt, iterations);
  return `v2:${iterations}:${salt}:${hash}`;
}

async function verifyPasswordAsync(password, stored) {
  const storedText = String(stored || '');
  if (storedText && !storedText.includes(':')) {
    const passwordBuffer = Buffer.from(String(password));
    const storedBuffer = Buffer.from(storedText);
    return passwordBuffer.length === storedBuffer.length
      ? crypto.timingSafeEqual(passwordBuffer, storedBuffer)
      : false;
  }
  const parts = storedText.split(':');
  if (parts[0] === 'v2') {
    const [, iterationText, salt, expectedHash] = parts;
    const iterations = Number(iterationText || 0);
    if (!iterations || !salt || !expectedHash) return false;
    const actualHash = await pbkdf2Hex(password, salt, iterations);
    if (actualHash.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
  }
  const [salt, expectedHash] = parts;
  if (!salt || !expectedHash) return false;
  const actualHash = await pbkdf2Hex(password, salt, LEGACY_PASSWORD_ITERATIONS);
  if (actualHash.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
}

function authResponse(user, company) {
  const token = signToken({
    userId: user.id,
    companyId: user.companyId,
    email: user.email,
    username: user.username || user.name || '',
    role: user.role || 'admin',
    authStore: user.authStore || 'sql',
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
  });
  return {
    token,
    user: {
      id: user.id,
      username: user.username || user.name || '',
      email: user.email,
      name: user.name || user.username || '',
      role: user.role || 'admin',
      status: user.status || 'active',
      phone: user.phone || '',
      note: user.note || '',
      lastLoginAt: user.lastLoginAt || '',
      companyId: user.companyId,
      companyName: user.companyName || company.name || ''
    },
    company: { id: company.id, name: company.name || user.companyName || '' }
  };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload?.userId || !payload?.companyId) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  if (payload.authStore === 'mongo' && useMongoAuth()) {
    const mongoUser = await findMongoUserById(payload.userId);
    if (!mongoUser || mongoUser.companyId !== payload.companyId) {
      res.status(401).json({ error: '登录已失效' });
      return;
    }
    if ((mongoUser.status || 'active') !== 'active') {
      res.status(403).json({ error: '账号已被禁用' });
      return;
    }
    req.user = {
      id: mongoUser.id,
      username: mongoUser.username || '',
      email: mongoUser.email,
      name: mongoUser.name || mongoUser.username || '',
      role: mongoUser.role || 'user',
      status: mongoUser.status || 'active',
      companyId: mongoUser.companyId,
      companyName: mongoUser.companyName || ''
    };
    req.company = { id: mongoUser.companyId, name: mongoUser.companyName || '' };
    next();
    return;
  }
  const user = await queryGet(`SELECT * FROM ${quoteTable('users')} WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ? LIMIT 1`, [payload.userId, payload.companyId]);
  if (!user) {
    res.status(401).json({ error: '登录已失效' });
    return;
  }
  if ((user.status || 'active') !== 'active') {
    res.status(403).json({ error: '账号已被禁用' });
    return;
  }
  req.user = { id: user.id, email: user.email, name: user.name || '', role: user.role || 'admin', status: user.status || 'active', companyId: user.companyId };
  next();
}

function isAdminRole(role) {
  return ['admin', 'super_admin'].includes(String(role || '').toLowerCase());
}

function requireAdmin(req, res, next) {
  if (!isAdminRole(req.user?.role || '')) {
    res.status(403).json({ error: '只有管理员可以管理成员。' });
    return;
  }
  next();
}

async function requireAccountAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload?.userId) {
    res.status(401).json({ error: '请先登录账户' });
    return;
  }
  if (!useMongoAuth()) {
    res.status(503).json({ error: 'MongoDB 未配置，请设置 MONGODB_URI' });
    return;
  }
  const mongoUser = await findMongoUserById(payload.userId);
  if (!mongoUser) {
    res.status(401).json({ error: '登录已失效' });
    return;
  }
  if ((mongoUser.status || 'active') !== 'active') {
    res.status(403).json({ error: '账号已被禁用' });
    return;
  }
  req.accountUser = toPublicMongoUser(mongoUser);
  req.user = {
    id: mongoUser.id,
    username: mongoUser.username || '',
    email: mongoUser.email,
    name: mongoUser.name || mongoUser.username || '',
    role: mongoUser.role || 'user',
    companyId: mongoUser.companyId,
    companyName: mongoUser.companyName || ''
  };
  req.company = { id: mongoUser.companyId, name: mongoUser.companyName || '' };
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

function describeAuthRegisterError(error) {
  const message = error?.message || String(error);
  if (/timeout/i.test(message)) return `Registration timed out: ${message}`;
  if (/ssl|tls|alert internal error|MongoServerSelectionError/i.test(message)) {
    return `Database connection failed: MongoDB TLS/network error: ${message}. Please check MONGODB_URI, MongoDB network access list, and TLS settings.`;
  }
  if (/authentication failed|auth failed|bad auth/i.test(message)) {
    return 'Database authentication failed: please check MongoDB username, password, and permissions.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return `Database connection failed: ${message}`;
  }
  return message || 'Registration failed. Please try again later.';
}

async function findSqlUserByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  return queryGet(`SELECT * FROM ${quoteTable('users')} WHERE LOWER(${quoteIdentifier('email')}) = ? LIMIT 1`, [normalizedEmail]);
}

async function findSqlUserByLogin(login) {
  const normalizedLogin = String(login || '').trim().toLowerCase();
  if (!normalizedLogin) return null;
  return queryGet(`
    SELECT * FROM ${quoteTable('users')}
    WHERE LOWER(${quoteIdentifier('email')}) = ?
       OR LOWER(COALESCE(${quoteIdentifier('name')}, '')) = ?
    LIMIT 1
  `, [normalizedLogin, normalizedLogin]);
}

async function findSqlUserByUsername(username) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!normalizedUsername) return null;
  return queryGet(`
    SELECT * FROM ${quoteTable('users')}
    WHERE LOWER(COALESCE(${quoteIdentifier('name')}, '')) = ?
    LIMIT 1
  `, [normalizedUsername]);
}

async function sqlCompanyForUser(user) {
  if (!user?.companyId) return { id: '', name: '' };
  return queryGet(`SELECT * FROM ${quoteTable('companies')} WHERE ${quoteIdentifier('id')} = ? LIMIT 1`, [user.companyId])
    || { id: user.companyId, name: user.companyName || '' };
}

async function createMongoUserFromSqlUser(sqlUser) {
  const company = await sqlCompanyForUser(sqlUser);
  const baseUsername = String(sqlUser.name || sqlUser.email?.split('@')[0] || `user-${sqlUser.id}`).trim();
  for (let index = 0; index < 5; index += 1) {
    const username = index === 0 ? baseUsername : `${baseUsername}-${String(sqlUser.id || '').slice(0, 6) || index}`;
    try {
      return await createMongoUser({
        id: sqlUser.id,
        username,
        email: sqlUser.email,
        passwordHash: sqlUser.passwordHash,
        role: sqlUser.role || 'admin',
        companyName: company.name || '',
        companyId: sqlUser.companyId,
        name: sqlUser.name || username
      });
    } catch (error) {
      if (error?.code !== 11000 || index === 4) throw error;
    }
  }
  throw new Error('Unable to migrate legacy user');
}

function normalizeMemberRole(value, { allowSuperAdmin = false } = {}) {
  const role = String(value || '').toLowerCase();
  if (role === 'super_admin') return allowSuperAdmin ? role : 'admin';
  if (role === 'admin') return role;
  return 'sales';
}

function normalizeMemberStatus(value) {
  return String(value || '').toLowerCase() === 'disabled' ? 'disabled' : 'active';
}

function publicMember(user = {}) {
  return {
    id: user.id || user._id || '',
    companyId: user.companyId || '',
    name: user.name || user.username || '',
    username: user.username || user.email || '',
    email: user.email || '',
    role: user.role || 'sales',
    status: user.status || 'active',
    phone: user.phone || '',
    note: user.note || '',
    lastLoginAt: user.lastLoginAt || '',
    createdAt: user.createdAt || '',
    updatedAt: user.updatedAt || ''
  };
}

function canManageMember(actor, target) {
  if (!isAdminRole(actor?.role)) return false;
  if (target?.role === 'super_admin' && actor?.role !== 'super_admin' && actor?.id !== target?.id) return false;
  return true;
}

async function getCompanyLimits(companyId) {
  if (useMongoAuth()) {
    const db = await getMongoDb();
    const company = await db.collection('companies').findOne({ id: companyId });
    return {
      maxAdminUsers: Number(company?.maxAdminUsers || 99),
      maxSalesUsers: Number(company?.maxSalesUsers || 999)
    };
  }
  const company = await queryGet(`SELECT * FROM ${quoteTable('companies')} WHERE ${quoteIdentifier('id')} = ? LIMIT 1`, [companyId]);
  return {
    maxAdminUsers: Number(company?.maxAdminUsers || 99),
    maxSalesUsers: Number(company?.maxSalesUsers || 999)
  };
}

async function assertMemberQuota({ companyId, role, targetUserId = '' }) {
  const normalizedRole = normalizeMemberRole(role);
  const limits = await getCompanyLimits(companyId);
  const countAdmin = ['admin', 'super_admin'].includes(normalizedRole);
  if (useMongoAuth()) {
    const db = await getMongoDb();
    const query = {
      companyId,
      status: 'active',
      ...(targetUserId ? { id: { $ne: targetUserId } } : {}),
      role: countAdmin ? { $in: ['admin', 'super_admin'] } : 'sales'
    };
    const count = await db.collection('users').countDocuments(query);
    if (countAdmin && count + 1 > limits.maxAdminUsers) {
      const error = new Error(`管理员数量已达到上限 ${limits.maxAdminUsers}`);
      error.statusCode = 409;
      throw error;
    }
    if (!countAdmin && count + 1 > limits.maxSalesUsers) {
      const error = new Error(`销售员数量已达到上限 ${limits.maxSalesUsers}`);
      error.statusCode = 409;
      throw error;
    }
    return;
  }
  const rows = await queryAll(`
    SELECT ${quoteIdentifier('id')}, ${quoteIdentifier('role')}
    FROM ${quoteTable('users')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND COALESCE(${quoteIdentifier('status')}, 'active') = 'active'
      ${targetUserId ? `AND ${quoteIdentifier('id')} != ?` : ''}
  `, targetUserId ? [companyId, targetUserId] : [companyId]);
  const count = rows.filter((row) => countAdmin ? ['admin', 'super_admin'].includes(row.role) : row.role === 'sales').length;
  if (countAdmin && count + 1 > limits.maxAdminUsers) {
    const error = new Error(`管理员数量已达到上限 ${limits.maxAdminUsers}`);
    error.statusCode = 409;
    throw error;
  }
  if (!countAdmin && count + 1 > limits.maxSalesUsers) {
    const error = new Error(`销售员数量已达到上限 ${limits.maxSalesUsers}`);
    error.statusCode = 409;
    throw error;
  }
}

async function memberById(companyId, memberId) {
  if (useMongoAuth()) {
    const db = await getMongoDb();
    return db.collection('users').findOne({ id: memberId, companyId });
  }
  return queryGet(`SELECT * FROM ${quoteTable('users')} WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ? LIMIT 1`, [memberId, companyId]);
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
    version: Math.max(1, Number(record.version || 0)),
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    deletedAt: record.deletedAt || null,
    deviceId: record.deviceId || deviceId
  };

  if (table === 'purchase_batches') {
    return { ...base, batchName: record.batchName || '', supplierCount: Number(record.supplierCount || 0), invoiceCount: Number(record.invoiceCount || 0), totalAmount: Number(record.totalAmount || 0) };
  }
  if (table === 'suppliers') {
    const rawName = record.supplierDisplayName || record.displayName || record.name || '';
    const parts = splitSupplierNameParts([
      record.supplierNameChinese,
      record.supplierNameEnglish,
      rawName
    ].filter(Boolean).join(' '));
    const supplierNameChinese = record.supplierNameChinese || parts.supplierNameChinese || '';
    const supplierNameEnglish = cleanSupplierEnglishName(record.supplierNameEnglish || parts.supplierNameEnglish || '');
    const supplierDisplayName = buildSupplierDisplayName({
      supplierNameChinese,
      supplierNameEnglish,
      displayName: record.supplierDisplayName || record.displayName || rawName,
      name: record.name || rawName
    });
    const normalizedName = record.normalizedName || normalizeSupplierName(supplierDisplayName || rawName);
    const aliases = mergeAliases(
      record.aliases,
      supplierAliasesFromName(rawName),
      supplierAliasesFromName(record.name || ''),
      supplierAliasesFromName(record.displayName || ''),
      supplierAliasesFromName(supplierDisplayName)
    );
    return {
      ...base,
      name: supplierDisplayName || rawName,
      displayName: supplierDisplayName || rawName,
      supplierNameChinese,
      supplierNameEnglish,
      supplierDisplayName: supplierDisplayName || rawName,
      normalizedName,
      aliases: JSON.stringify(aliases),
      contactName: record.contactName || '',
      phone: record.phone || '',
      email: record.email || '',
      address: record.address || '',
      notes: record.notes || '',
      templateIds: Array.isArray(record.templateIds) ? JSON.stringify(record.templateIds) : (record.templateIds || '[]'),
      suspectedDuplicateOf: record.suspectedDuplicateOf || '',
      status: record.status || 'active'
    };
  }
  if (table === 'invoices') {
    return {
      ...base,
      batchId: record.batchId || '',
      scanBatchId: record.scanBatchId || record.batchId || '',
      supplierId: record.supplierId || '',
      invoiceNo: record.invoiceNo || '',
      invoiceDate: record.invoiceDate || '',
      pageNumber: Number(record.pageNumber || 0),
      pageCount: Number(record.pageCount || 0),
      invoiceGroupKey: record.invoiceGroupKey || buildInvoiceGroupKey({
        supplierName: record.supplierName || '',
        invoiceNo: record.invoiceNo || '',
        totalAmount: record.totalAmount || 0
      }),
      isMergedInvoice: record.isMergedInvoice ? 1 : 0,
      isMultiPage: record.isMultiPage || record.isMergedInvoice ? 1 : 0,
      mergedInvoiceIds: Array.isArray(record.mergedInvoiceIds) ? JSON.stringify(record.mergedInvoiceIds) : (record.mergedInvoiceIds || '[]'),
      invoiceLayoutType: record.invoiceLayoutType || 'normal_invoice',
      imagePath: record.imagePath || '',
      imageHash: record.imageHash || '',
      ocrText: record.ocrText || '',
      ocrTextHash: record.ocrTextHash || '',
      subtotal: Number(record.subtotal || record.totalAmount || 0),
      tax: Number(record.tax || 0),
      totalAmount: Number(record.totalAmount || 0),
      calculatedTotal: Number(record.calculatedTotal || 0),
      totalDifference: Number(record.totalDifference || 0),
      duplicateStatus: record.duplicateStatus || 'none',
      duplicateOfInvoiceId: record.duplicateOfInvoiceId || '',
      recognitionSource: record.recognitionSource || '',
      recognitionWarnings: Array.isArray(record.recognitionWarnings) ? JSON.stringify(record.recognitionWarnings) : (record.recognitionWarnings || ''),
      status: record.status || 'saved'
    };
  }
  if (table === 'invoice_items') {
    const rawName = displayRawName(record);
    const standardName = displayStandardName(record) || rawName;
    const normalizedName = normalizeProductNameAdvanced(record.normalizedName || record.productNameNormalized || standardName || rawName);
    return {
      ...base,
      invoiceId: record.invoiceId || '',
      supplierId: record.supplierId || '',
      productId: record.productId || '',
      rawName,
      nameCn: record.nameCn || '',
      nameEn: record.nameEn || '',
      spec: record.spec || '',
      productNameOriginal: standardName,
      productNameNormalized: normalizedName,
      normalizedName,
      category: record.category || '',
      quantity: Number(record.quantity || 0),
      unit: record.unit || '',
      unitPrice: Number(record.unitPrice || 0),
      totalPrice: Number(record.totalPrice || 0),
      chargedQty: Number(record.chargedQty || 0),
      freeQty: Number(record.freeQty || 0),
      totalQty: Number(record.totalQty || record.quantity || 0),
      actualQty: Number(record.actualQty || record.totalQty || record.quantity || 0),
      originalUnitCost: Number(record.originalUnitCost || record.unitPrice || 0),
      effectiveUnitCost: Number(record.effectiveUnitCost || record.unitPrice || 0),
      discountAmount: Number(record.discountAmount || 0),
      discountedEffectiveUnitCost: Number(record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice || 0),
      promoGroupId: record.promoGroupId || '',
      promoGroupName: record.promoGroupName || '',
      promoGroupRule: record.promoGroupRule || '',
      participatesInGiftAllocation: record.participatesInGiftAllocation ? 1 : 0,
      isFreeItem: record.isFreeItem ? 1 : 0,
      isDiscountLine: record.isDiscountLine ? 1 : 0,
      candidateOnly: record.candidateOnly ? 1 : 0,
      correctedByUser: record.correctedByUser ? 1 : 0,
      isHandwrittenQuantity: record.isHandwrittenQuantity ? 1 : 0,
      isHandwrittenPrice: record.isHandwrittenPrice ? 1 : 0,
      isHandwrittenAmount: record.isHandwrittenAmount ? 1 : 0,
      isCircled: record.isCircled ? 1 : 0,
      isChecked: record.isChecked ? 1 : 0,
      freeReason: record.freeReason || '',
      invoiceDate: record.invoiceDate || today(),
      notes: record.notes || ''
    };
  }
  if (table === 'products') {
    return { ...base, name: record.name || '', normalizedName: normalizeProductNameAdvanced(record.normalizedName || record.name || ''), category: record.category || '', notes: record.notes || '' };
  }
  if (table === 'price_history') {
    return { ...base, productId: record.productId || '', invoiceId: record.invoiceId || '', invoiceItemId: record.invoiceItemId || '', supplierId: record.supplierId || '', price: Number(record.price || 0), quantity: Number(record.quantity || 0), unit: record.unit || '', invoiceDate: record.invoiceDate || today(), invoiceNo: record.invoiceNo || '', status: record.status || (record.deletedAt ? 'deleted' : 'active') };
  }
  if (table === 'invoice_discounts') {
    return {
      ...base,
      invoiceId: record.invoiceId || '',
      supplierId: record.supplierId || '',
      discountName: record.discountName || '',
      amount: Number(record.amount || 0),
      discountType: record.discountType || 'unknown',
      appliedToProductIds: Array.isArray(record.appliedToProductIds) ? record.appliedToProductIds.join(',') : (record.appliedToProductIds || '')
    };
  }
  if (table === 'gift_allocation_rules') {
    return {
      ...base,
      supplierId: record.supplierId || '',
      ruleKey: record.ruleKey || '',
      productNames: Array.isArray(record.productNames) ? JSON.stringify(record.productNames) : (record.productNames || '[]'),
      promoGroupName: record.promoGroupName || '',
      promoGroupRule: record.promoGroupRule || '',
      chargedQty: Number(record.chargedQty || 0),
      freeQty: Number(record.freeQty || 0),
      actualQty: Number(record.actualQty || 0),
      invoiceAmount: Number(record.invoiceAmount || 0),
      originalUnitCost: Number(record.originalUnitCost || 0),
      effectiveUnitCost: Number(record.effectiveUnitCost || 0)
    };
  }
  if (table === 'product_aliases') {
    const aliasName = record.aliasName || record.rawName || record.keyword || '';
    const normalizedAlias = normalizeProductNameAdvanced(record.normalizedAlias || aliasName);
    return {
      ...base,
      keyword: normalizeProductNameAdvanced(record.keyword || aliasName),
      aliasName,
      normalizedAlias,
      standardName: record.standardName || '',
      category: record.category || '',
      productId: record.productId || '',
      supplierId: record.supplierId || '',
      rawName: record.rawName || '',
      nameCn: record.nameCn || '',
      nameEn: record.nameEn || '',
      barcode: record.barcode || '',
      spec: record.spec || '',
      unit: record.unit || '',
      minPrice: Number(record.minPrice || 0),
      maxPrice: Number(record.maxPrice || 0),
      avgPrice: Number(record.avgPrice || 0),
      occurrenceCount: Number(record.occurrenceCount || 0),
      confidence: Number(record.confidence || 0.85),
      createdByUser: record.createdByUser ? 1 : 0
    };
  }
  if (table === 'product_learning_rules') {
    return {
      ...base,
      rawName: record.rawName || '',
      nameCn: record.nameCn || '',
      nameEn: record.nameEn || '',
      standardName: record.standardName || '',
      barcode: record.barcode || '',
      spec: record.spec || '',
      unit: record.unit || '',
      supplierId: record.supplierId || '',
      productId: record.productId || '',
      minPrice: Number(record.minPrice || 0),
      maxPrice: Number(record.maxPrice || 0),
      avgPrice: Number(record.avgPrice || 0),
      occurrenceCount: Number(record.occurrenceCount || 0),
      confidence: Number(record.confidence || 0.85)
    };
  }
  if (table === 'recognition_corrections') {
    return {
      ...base,
      fieldName: record.fieldName || '',
      beforeValue: record.beforeValue || '',
      afterValue: record.afterValue || '',
      supplierId: record.supplierId || '',
      invoiceTemplateId: record.invoiceTemplateId || '',
      invoiceId: record.invoiceId || '',
      invoiceItemId: record.invoiceItemId || ''
    };
  }
  if (table === 'price_anomalies') {
    return {
      ...base,
      supplierId: record.supplierId || '',
      productId: record.productId || '',
      invoiceId: record.invoiceId || '',
      invoiceItemId: record.invoiceItemId || '',
      unitPrice: Number(record.unitPrice || 0),
      averagePrice: Number(record.averagePrice || 0),
      deviationPercent: Number(record.deviationPercent || 0),
      invoiceDate: record.invoiceDate || today(),
      invoiceNo: record.invoiceNo || '',
      status: record.status || 'pending',
      message: record.message || ''
    };
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
    prepared.productId = await resolveReference('products', prepared.productId, deviceId, companyId, client);
  }
  if (table === 'price_history') {
    prepared.productId = await resolveReference('products', prepared.productId, deviceId, companyId, client);
    prepared.invoiceId = await resolveReference('invoices', prepared.invoiceId, deviceId, companyId, client);
    prepared.invoiceItemId = await resolveReference('invoice_items', prepared.invoiceItemId, deviceId, companyId, client);
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  if (table === 'invoice_discounts') {
    prepared.invoiceId = await resolveReference('invoices', prepared.invoiceId, deviceId, companyId, client);
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  if (table === 'gift_allocation_rules') {
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  if (table === 'product_aliases' || table === 'product_learning_rules') {
    prepared.productId = await resolveReference('products', prepared.productId, deviceId, companyId, client);
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
  }
  if (table === 'recognition_corrections') {
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
    prepared.invoiceId = await resolveReference('invoices', prepared.invoiceId, deviceId, companyId, client);
    prepared.invoiceItemId = await resolveReference('invoice_items', prepared.invoiceItemId, deviceId, companyId, client);
  }
  if (table === 'price_anomalies') {
    prepared.productId = await resolveReference('products', prepared.productId, deviceId, companyId, client);
    prepared.supplierId = await resolveReference('suppliers', prepared.supplierId, deviceId, companyId, client);
    prepared.invoiceId = await resolveReference('invoices', prepared.invoiceId, deviceId, companyId, client);
    prepared.invoiceItemId = await resolveReference('invoice_items', prepared.invoiceItemId, deviceId, companyId, client);
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

async function findOrCreateSupplierV2(name, deviceId, companyId, client = null) {
  const supplierName = (name || '').trim() || '未命名供应商';
  const normalizedName = normalizeSupplierName(supplierName);
  const existing = await queryGet(`
    SELECT * FROM ${quoteTable('suppliers')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND COALESCE(${quoteIdentifier('status')}, 'active') != 'merged'
      AND (
        ${quoteIdentifier('name')} = ?
        OR ${quoteIdentifier('displayName')} = ?
        OR ${quoteIdentifier('normalizedName')} = ?
        OR ${quoteIdentifier('aliases')} LIKE ?
      )
    LIMIT 1
  `, [companyId, supplierName, supplierName, normalizedName, `%${supplierName}%`], client);
  if (existing) {
    const updated = prepareRecord('suppliers', {
      ...existing,
      displayName: displaySupplierName(existing, supplierName),
      aliases: mergeAliases(existing.aliases, supplierAliasesFromName(supplierName)),
      updatedAt: nowIso()
    }, deviceId, companyId);
    await upsertRecord('suppliers', updated, client);
    return updated;
  }

  const candidates = await queryAll(`
    SELECT * FROM ${quoteTable('suppliers')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND COALESCE(${quoteIdentifier('status')}, 'active') != 'merged'
  `, [companyId], client);
  const duplicate = candidates.find((candidate) => isSupplierDuplicateCandidate(candidate, {
    name: supplierName,
    displayName: supplierName,
    normalizedName
  }));
  if (duplicate) {
    const updated = prepareRecord('suppliers', {
      ...duplicate,
      displayName: displaySupplierName(duplicate, supplierName),
      aliases: mergeAliases(duplicate.aliases, supplierAliasesFromName(supplierName)),
      updatedAt: nowIso()
    }, deviceId, companyId);
    await upsertRecord('suppliers', updated, client);
    return updated;
  }

  const now = nowIso();
  const serverId = id();
  const supplier = prepareRecord('suppliers', {
    id: serverId,
    localId: serverId,
    serverId,
    name: supplierName,
    displayName: supplierName,
    normalizedName,
    aliases: supplierAliasesFromName(supplierName),
    createdAt: now,
    updatedAt: now
  }, deviceId, companyId);
  await upsertRecord('suppliers', supplier, client);
  return supplier;
}

function itemStandardName(item = {}) {
  return String(item.standardName || item.productNameNormalized || item.normalizedName || item.name || item.productNameOriginal || [item.nameCn, item.nameEn].filter(Boolean).join(' ')).trim();
}

function itemRawName(item = {}) {
  return String(item.rawName || item.productNameOriginal || item.name || [item.nameCn, item.nameEn].filter(Boolean).join(' ')).trim();
}

function itemNameParts(item = {}) {
  const raw = itemRawName(item);
  return {
    rawName: raw,
    nameCn: String(item.nameCn || (/[\u3400-\u9fff]/.test(raw) ? raw : '')).trim(),
    nameEn: String(item.nameEn || (/[\u3400-\u9fff]/.test(raw) ? '' : raw)).trim(),
    standardName: itemStandardName(item) || raw
  };
}

function giftAccountingKey(item = {}) {
  const candidate = promoGroupCandidate(item);
  const manual = Number(item.participatesInGiftAllocation || 0) || String(item.promoGroupRule || '').includes('manual');
  return manual && item.promoGroupId
    ? item.promoGroupId
    : candidate.key || normalizeProductNameAdvanced(item.standardName || item.productNameNormalized || item.normalizedName || item.productNameOriginal || item.name || item.rawName || '');
}

function splitInvoiceRows(items = []) {
  const discountItems = [];
  const productItems = [];
  for (const item of items) {
    if (item.candidateOnly) continue;
    if (detectDiscountLine(item)) discountItems.push(item);
    else productItems.push(item);
  }
  return { productItems, discountItems };
}

function applyGiftAccounting(items = []) {
  const normalized = items.map((item) => {
    const quantity = Number(item.quantity ?? item.qty ?? 0);
    const unitPrice = Number(item.unitPrice ?? item.priceEach ?? item.price ?? 0);
    const totalPrice = Number(item.totalPrice ?? item.amount ?? 0);
    const isFreeItem = Boolean(item.isFreeItem) || unitPrice === 0 || totalPrice === 0;
    const candidate = promoGroupCandidate(item);
    return {
      ...item,
      quantity,
      qty: quantity,
      unitPrice,
      totalPrice,
      rawName: displayRawName(item),
      productNameOriginal: displayStandardName(item) || displayRawName(item),
      productNameNormalized: normalizeProductNameAdvanced(item.productNameNormalized || item.normalizedName || displayStandardName(item) || displayRawName(item)),
      normalizedName: normalizeProductNameAdvanced(item.normalizedName || item.productNameNormalized || displayStandardName(item) || displayRawName(item)),
      promoGroupId: item.promoGroupId || candidate.key || '',
      promoGroupName: item.promoGroupName || candidate.name || '',
      promoGroupRule: item.promoGroupRule || candidate.rule || '',
      isFreeItem,
      freeReason: item.freeReason || (isFreeItem ? (unitPrice === 0 ? 'priceEach = 0' : 'amount = 0') : '')
    };
  });
  const groups = new Map();
  for (const item of normalized) {
    const key = giftAccountingKey(item) || itemRawName(item);
    const group = groups.get(key) || { chargedQty: 0, freeQty: 0, invoiceAmount: 0 };
    if (item.isFreeItem) {
      group.freeQty += Number(item.quantity || 0);
    } else {
      group.chargedQty += Number(item.quantity || 0);
      group.invoiceAmount += Number(item.totalPrice || 0);
    }
    groups.set(key, group);
  }
  return normalized.map((item) => {
    const key = giftAccountingKey(item) || itemRawName(item);
    const group = groups.get(key) || { chargedQty: item.isFreeItem ? 0 : item.quantity, freeQty: item.isFreeItem ? item.quantity : 0, invoiceAmount: item.isFreeItem ? 0 : item.totalPrice };
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unitPrice || 0);
    const chargedQty = Number(group.chargedQty || 0);
    const freeQty = Number(group.freeQty || 0);
    const totalQty = chargedQty + freeQty;
    const invoiceAmount = Number(group.invoiceAmount || 0);
    const hasFreeShare = freeQty > 0 && chargedQty > 0;
    const noDiscount = Number(item.discountAmount || 0) === 0;
    const originalCost = hasFreeShare ? (invoiceAmount / chargedQty) : unitPrice;
    const effectiveCost = hasFreeShare ? (invoiceAmount / totalQty) : unitPrice;
    return {
      ...item,
      chargedQty: hasFreeShare ? chargedQty : (item.isFreeItem ? 0 : quantity),
      freeQty: hasFreeShare ? freeQty : (item.isFreeItem ? quantity : 0),
      totalQty: hasFreeShare ? totalQty : quantity,
      actualQty: hasFreeShare ? totalQty : quantity,
      originalUnitCost: originalCost,
      effectiveUnitCost: effectiveCost,
      discountedEffectiveUnitCost: noDiscount ? effectiveCost : Number(item.discountedEffectiveUnitCost || effectiveCost)
    };
  });
}

function applyDiscountAllocation(items = [], discountItems = []) {
  if (!discountItems.length) return items;
  const discounts = discountItems.map((discount) => ({
    ...discount,
    amount: Number(discount.totalPrice ?? discount.amount ?? 0)
  }));
  return items.map((item) => {
    const itemId = item.id || item.serverId || item.localId || '';
    const matching = discounts.filter((discount) => {
      const info = discountTypeFor(discount, items);
      const ids = String(info.appliedToProductIds || '').split(',').filter(Boolean);
      if (ids.length) return ids.includes(itemId);
      const name = normalizeProductNameAdvanced(discount.name || discount.productNameOriginal || discount.rawName || '');
      const productName = normalizeProductNameAdvanced(item.productNameOriginal || item.productNameNormalized || item.rawName || '');
      const token = name.split(/\s+/).find((part) => part && part !== 'discount' && part !== '折扣');
      return token && productName.includes(token);
    });
    const discountAmount = matching.reduce((sum, discount) => sum + Number(discount.amount || 0), 0);
    const actualQty = Number(item.actualQty || item.totalQty || item.quantity || 0);
    const discountedTotal = Number(item.totalPrice || 0) + discountAmount;
    return {
      ...item,
      discountAmount,
      discountedEffectiveUnitCost: actualQty > 0 ? discountedTotal / actualQty : Number(item.effectiveUnitCost || item.unitPrice || 0)
    };
  });
}

function summarizeGiftAccounting(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = item.promoGroupId || giftAccountingKey(item) || itemRawName(item) || item.id;
    if (groups.has(key)) continue;
    groups.set(key, {
      chargedQty: Number(item.chargedQty || 0),
      freeQty: Number(item.freeQty || 0),
      totalQty: Number(item.actualQty || item.totalQty || 0),
      invoiceAmount: Number(item.originalUnitCost || 0) * Number(item.chargedQty || 0)
    });
  }
  const summary = [...groups.values()].reduce((acc, group) => ({
    chargedQty: acc.chargedQty + group.chargedQty,
    freeQty: acc.freeQty + group.freeQty,
    totalQty: acc.totalQty + group.totalQty,
    invoiceAmount: acc.invoiceAmount + group.invoiceAmount
  }), { chargedQty: 0, freeQty: 0, totalQty: 0, invoiceAmount: 0 });
  return {
    ...summary,
    originalUnitCost: summary.chargedQty > 0 ? summary.invoiceAmount / summary.chargedQty : 0,
    effectiveUnitCost: summary.totalQty > 0 ? summary.invoiceAmount / summary.totalQty : 0
  };
}

async function findOrCreateProductForLearning(item, deviceId, companyId, client = null) {
  const parts = itemNameParts(item);
  const normalizedName = normalizeProductNameAdvanced(parts.standardName || parts.rawName);
  if (!normalizedName) return null;
  const existing = await queryGet(`
    SELECT * FROM ${quoteTable('products')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND ${quoteIdentifier('normalizedName')} = ?
    LIMIT 1
  `, [companyId, normalizedName], client);
  if (existing) return existing;

  const productId = id();
  const product = prepareRecord('products', {
    id: productId,
    localId: productId,
    serverId: productId,
    name: parts.standardName || parts.rawName,
    normalizedName,
    category: item.category || '',
    notes: ''
  }, deviceId, companyId);
  await upsertRecord('products', product, client);
  return product;
}

async function learnProductAlias({ item, itemRecord, invoice, supplier, product, deviceId, companyId, client }) {
  const parts = itemNameParts(item);
  const keyword = normalizeProductNameAdvanced(parts.rawName || parts.standardName);
  if (!keyword || !product) return;
  const existing = await queryGet(`
    SELECT * FROM ${quoteTable('product_aliases')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND ${quoteIdentifier('keyword')} = ?
      AND ${quoteIdentifier('supplierId')} = ?
    LIMIT 1
  `, [companyId, keyword, supplier?.serverId || supplier?.id || ''], client);
  const unitPrice = Number(itemRecord.unitPrice || item.unitPrice || 0);
  const count = Number(existing?.occurrenceCount || 0);
  const avgPrice = count > 0 ? ((Number(existing.avgPrice || 0) * count) + unitPrice) / (count + 1) : unitPrice;
  const record = await prepareRecordWithReferences('product_aliases', {
    ...(existing || {}),
    keyword,
    aliasName: parts.rawName || parts.standardName,
    normalizedAlias: keyword,
    standardName: parts.standardName,
    category: item.category || existing?.category || '',
    productId: product.serverId || product.id,
    supplierId: supplier?.serverId || supplier?.id || '',
    rawName: parts.rawName,
    nameCn: parts.nameCn,
    nameEn: parts.nameEn,
    barcode: item.barcode || existing?.barcode || '',
    spec: item.spec || existing?.spec || '',
    unit: item.unit || existing?.unit || '',
    minPrice: count > 0 ? Math.min(Number(existing.minPrice || unitPrice), unitPrice) : unitPrice,
    maxPrice: count > 0 ? Math.max(Number(existing.maxPrice || unitPrice), unitPrice) : unitPrice,
    avgPrice,
    occurrenceCount: count + 1,
    confidence: Math.min(0.99, Number(existing?.confidence || 0.82) + 0.02),
    createdByUser: item.createdByUser || false,
    updatedAt: nowIso()
  }, deviceId, companyId, client);
  await upsertRecord('product_aliases', record, client);
}

async function learnProductRule({ item, supplier, product, deviceId, companyId, client }) {
  const parts = itemNameParts(item);
  const rawKey = normalizeProductNameAdvanced(parts.rawName || parts.standardName);
  if (!rawKey || !product) return;
  const existing = await queryGet(`
    SELECT * FROM ${quoteTable('product_learning_rules')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND ${quoteIdentifier('rawName')} = ?
      AND ${quoteIdentifier('supplierId')} = ?
    LIMIT 1
  `, [companyId, rawKey, supplier?.serverId || supplier?.id || ''], client);
  const unitPrice = Number(item.unitPrice || 0);
  const count = Number(existing?.occurrenceCount || 0);
  const avgPrice = count > 0 ? ((Number(existing.avgPrice || 0) * count) + unitPrice) / (count + 1) : unitPrice;
  const record = await prepareRecordWithReferences('product_learning_rules', {
    ...(existing || {}),
    rawName: rawKey,
    nameCn: parts.nameCn,
    nameEn: parts.nameEn,
    standardName: parts.standardName,
    barcode: item.barcode || existing?.barcode || '',
    spec: item.spec || existing?.spec || '',
    unit: item.unit || existing?.unit || '',
    supplierId: supplier?.serverId || supplier?.id || '',
    productId: product.serverId || product.id,
    minPrice: count > 0 ? Math.min(Number(existing.minPrice || unitPrice), unitPrice) : unitPrice,
    maxPrice: count > 0 ? Math.max(Number(existing.maxPrice || unitPrice), unitPrice) : unitPrice,
    avgPrice,
    occurrenceCount: count + 1,
    confidence: Math.min(1, Number(existing?.confidence || 0.75) + 0.03),
    updatedAt: nowIso()
  }, deviceId, companyId, client);
  await upsertRecord('product_learning_rules', record, client);
}

async function learnPrice({ itemRecord, invoice, supplier, product, deviceId, companyId, client }) {
  const learnedPrice = Number(itemRecord.discountedEffectiveUnitCost || itemRecord.effectiveUnitCost || itemRecord.unitPrice || 0);
  if (!product || !learnedPrice) return null;
  const productId = product.serverId || product.id;
  const history = await queryGet(`
    SELECT AVG(${quoteIdentifier('price')}) AS "averagePrice", COUNT(*) AS "count"
    FROM ${quoteTable('price_history')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND ${quoteIdentifier('productId')} = ?
      AND ${quoteIdentifier('supplierId')} = ?
  `, [companyId, productId, supplier?.serverId || supplier?.id || ''], client);
  const averagePrice = Number(history?.averagePrice || 0);
  const unitPrice = learnedPrice;
  let anomaly = null;
  if (averagePrice > 0) {
    const deviationPercent = Math.abs(unitPrice - averagePrice) / averagePrice;
    if (deviationPercent > 0.3) {
      anomaly = await prepareRecordWithReferences('price_anomalies', {
        supplierId: supplier?.serverId || supplier?.id || '',
        productId,
        invoiceId: invoice.serverId || invoice.id,
        invoiceItemId: itemRecord.serverId || itemRecord.id,
        unitPrice,
        averagePrice,
        deviationPercent,
        invoiceDate: invoice.invoiceDate,
        invoiceNo: invoice.invoiceNo,
        status: 'pending',
        message: `价格高于/低于历史均价 ${Math.round(deviationPercent * 100)}%，请确认。`
      }, deviceId, companyId, client);
      await upsertRecord('price_anomalies', anomaly, client);
    }
  }
  const priceRecord = await prepareRecordWithReferences('price_history', {
    productId,
    invoiceId: invoice.serverId || invoice.id,
    invoiceItemId: itemRecord.serverId || itemRecord.id,
    supplierId: supplier?.serverId || supplier?.id || '',
    price: unitPrice,
    quantity: Number(itemRecord.actualQty || itemRecord.totalQty || itemRecord.quantity || 0),
    unit: itemRecord.unit || '',
    invoiceDate: invoice.invoiceDate,
    invoiceNo: invoice.invoiceNo || '',
    status: 'active'
  }, deviceId, companyId, client);
  await upsertRecord('price_history', priceRecord, client);
  return anomaly;
}

async function saveInvoiceDiscounts({ discountItems, productItemRecords, invoice, supplier, deviceId, companyId, client }) {
  const saved = [];
  for (const discount of discountItems) {
    const discountName = displayRawName(discount) || discount.productNameOriginal || discount.name || 'Discount';
    const amount = Number(discount.totalPrice ?? discount.amount ?? 0);
    const info = discountTypeFor(discount, productItemRecords);
    let appliedToProductIds = info.appliedToProductIds || '';
    if (!appliedToProductIds && info.discountType !== 'invoice_level') {
      appliedToProductIds = productItemRecords.map((item) => item.productId).filter(Boolean).join(',');
    }
    const record = await prepareRecordWithReferences('invoice_discounts', {
      invoiceId: invoice.serverId || invoice.id,
      supplierId: supplier?.serverId || supplier?.id || '',
      discountName,
      amount,
      discountType: info.discountType || 'unknown',
      appliedToProductIds,
      updatedAt: nowIso()
    }, deviceId, companyId, client);
    await upsertRecord('invoice_discounts', record, client);
    saved.push(record);
  }
  return saved;
}

function correctionEntries(before = {}, after = {}, prefix = '') {
  const entries = [];
  for (const fieldName of Object.keys(after || {})) {
    if (typeof after[fieldName] === 'object') continue;
    const beforeValue = before?.[fieldName] ?? '';
    const afterValue = after?.[fieldName] ?? '';
    if (String(beforeValue) !== String(afterValue)) {
      entries.push({ fieldName: prefix ? `${prefix}.${fieldName}` : fieldName, beforeValue: String(beforeValue), afterValue: String(afterValue) });
    }
  }
  return entries;
}

async function learnCorrections({ beforeResult, finalPayload, invoice, itemRecords, supplier, templateId, deviceId, companyId, client }) {
  const corrections = [
    ...correctionEntries(beforeResult || {}, finalPayload || ''),
    ...((finalPayload.items || []).flatMap((item, index) => correctionEntries((beforeResult?.items || [])[index] || {}, item, `items.${index}`)))
  ];
  for (const correction of corrections) {
    const record = await prepareRecordWithReferences('recognition_corrections', {
      ...correction,
      supplierId: supplier?.serverId || supplier?.id || '',
      invoiceTemplateId: templateId || '',
      invoiceId: invoice.serverId || invoice.id,
      invoiceItemId: itemRecords[Number(correction.fieldName.match(/^items\.(\d+)/)?.[1] || -1)]?.serverId || ''
    }, deviceId, companyId, client);
    await upsertRecord('recognition_corrections', record, client);
  }
}

function simpleSimilarity(a, b) {
  const left = normalizeProductNameAdvanced(a);
  const right = normalizeProductNameAdvanced(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;
  const leftTokens = new Set(left.split(/\s+/));
  const rightTokens = new Set(right.split(/\s+/));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.size, rightTokens.size, 1);
}

async function enhanceRecognizedResultWithLearning(result, companyId) {
  const parsed = result?.parsed || {};
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  if (!items.length) return result;
  const aliases = await queryAll(`
    SELECT * FROM ${quoteTable('product_aliases')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('occurrenceCount')} DESC, ${quoteIdentifier('updatedAt')} DESC
    LIMIT 500
  `, [companyId]);
  const rules = await queryAll(`
    SELECT * FROM ${quoteTable('product_learning_rules')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('confidence')} DESC, ${quoteIdentifier('occurrenceCount')} DESC
    LIMIT 500
  `, [companyId]);
  const candidates = [...aliases, ...rules];
  const enhancedItems = items.map((item) => {
    const rawName = itemRawName(item);
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = Math.max(
        simpleSimilarity(rawName, candidate.rawName || candidate.aliasName || candidate.normalizedAlias || candidate.keyword),
        simpleSimilarity(itemStandardName(item), candidate.standardName)
      );
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best || bestScore < 0.78) {
      return { ...item, itemConfidence: item.itemConfidence ?? 0.65 };
    }
    return {
      ...item,
      rawName,
      nameCn: item.nameCn || best.nameCn || '',
      nameEn: item.nameEn || best.nameEn || '',
      standardName: best.standardName || itemStandardName(item),
      name: best.standardName || itemStandardName(item),
      normalizedName: normalizeProductNameAdvanced(best.standardName || itemStandardName(item)),
      productNameOriginal: best.standardName || itemStandardName(item),
      productNameNormalized: normalizeProductNameAdvanced(best.standardName || itemStandardName(item)),
      barcode: item.barcode || best.barcode || '',
      spec: item.spec || best.spec || '',
      unit: item.unit || best.unit || '',
      itemConfidence: Math.max(Number(item.itemConfidence || 0), Math.min(0.98, bestScore))
    };
  });
  return {
    ...result,
    parsed: {
      ...parsed,
      items: enhancedItems,
      itemConfidence: Math.min(...enhancedItems.map((item) => Number(item.itemConfidence || 0.65)))
    }
  };
}

function resultFromFinalPayload(payload = {}) {
  const totalAmount = Number(payload.totalAmount || 0);
  return {
    supplierName: payload.supplierName || '',
    invoiceNo: payload.invoiceNo || '',
    invoiceDate: payload.invoiceDate || '',
    totalAmount,
    pageNumber: Number(payload.pageNumber || 0),
    pageCount: Number(payload.pageCount || 0),
    invoiceGroupKey: payload.invoiceGroupKey || buildInvoiceGroupKey({ supplierName: payload.supplierName || '', invoiceNo: payload.invoiceNo || '', totalAmount }),
    invoiceLayoutType: payload.invoiceLayoutType || 'normal_invoice',
    items: (payload.items || []).map((item) => ({
      rawName: item.rawName || item.productNameOriginal || item.name || '',
      nameCn: item.nameCn || '',
      nameEn: item.nameEn || '',
      standardName: item.standardName || item.productNameNormalized || item.productNameOriginal || item.name || '',
      name: item.standardName || item.productNameOriginal || item.name || '',
      normalizedName: item.productNameNormalized || item.normalizedName || item.standardName || item.productNameOriginal || '',
      barcode: item.barcode || '',
      spec: item.spec || '',
      qty: Number(item.quantity ?? item.qty ?? 0),
      unit: item.unit || '',
      unitPrice: Number(item.unitPrice || 0),
      totalPrice: Number(item.totalPrice || 0),
      candidateOnly: Boolean(item.candidateOnly),
      isHandwrittenQuantity: Boolean(item.isHandwrittenQuantity),
      isHandwrittenPrice: Boolean(item.isHandwrittenPrice),
      isHandwrittenAmount: Boolean(item.isHandwrittenAmount),
      isCircled: Boolean(item.isCircled),
      isChecked: Boolean(item.isChecked)
    })),
    templateCandidate: payload.templateCandidate,
    confidence: Number(payload.confidence || 0.95),
    warnings: []
  };
}

function shouldCreatePriceHistoryForItem(item = {}, invoice = {}) {
  if (!['APPROVED', 'CONFIRMED'].includes(String(invoice.status || '').toUpperCase())) return false;
  if (Number(item.isFreeItem || 0) || Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0)) return false;
  if (Number(item.quantity || item.actualQty || item.totalQty || 0) <= 0) return false;
  if (Number(item.unitPrice || 0) <= 0) return false;
  if (Number(item.totalPrice || 0) <= 0) return false;
  const name = displayRawName(item) || item.productNameOriginal || item.name || '';
  if (!name.trim()) return false;
  if (/^(remark|remarks|note|notes|memo|comment)$/i.test(name.trim())) return false;
  return true;
}

function invoiceIntegrityCheck({ items = [], discountItems = [], totalAmount = 0, duplicateCheck = {} }) {
  const warnings = [];
  const productRows = items.filter((entry) => {
    if (Number(entry.isDiscountLine || 0) || Number(entry.candidateOnly || 0)) return false;
    const name = String(entry.productNameOriginal || entry.name || entry.standardName || '').trim().toLowerCase();
    if (!name || /^(remark|remarks|note|notes|memo|subtotal|total)$/.test(name)) return false;
    return true;
  });
  if (productRows.length === 0) warnings.push('EMPTY_ITEMS');
  const itemSubtotal = items
    .filter((entry) => !Number(entry.isDiscountLine || 0) && !Number(entry.candidateOnly || 0))
    .reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  const discountTotal = discountItems.reduce((sum, item) => sum + Number(item.totalPrice ?? item.amount ?? 0), 0);
  const expectedTotal = itemSubtotal + discountTotal;
  const difference = Math.abs(Number(totalAmount || 0) - expectedTotal);
  if (Number(totalAmount || 0) > 0 && difference > 0.05) warnings.push('AMOUNT_MISMATCH');
  if (duplicateCheck.duplicateStatus === 'possible' || duplicateCheck.sameInvoiceGroup) warnings.push('POSSIBLE_MULTI_PAGE_OR_DUPLICATE');
  return {
    needsReview: warnings.length > 0,
    warnings,
    itemSubtotal,
    discountTotal,
    expectedTotal,
    difference
  };
}

async function saveInvoiceWithIntegrityCheck(payload, options = {}) {
  const user = options.user || {};
  const deviceId = options.deviceId || payload.deviceId || 'legacy-api';
  const companyId = options.companyId || user.companyId;
  if (!companyId) throw new Error('Missing companyId');
  const supplier = payload.supplierId
    ? await getByAnyId('suppliers', payload.supplierId, companyId)
    : await findOrCreateSupplierV2(payload.supplierName, deviceId, companyId);
  const now = nowIso();
  const { productItems, discountItems } = splitInvoiceRows(Array.isArray(payload.items) ? payload.items : []);
  const items = applyDiscountAllocation(applyGiftAccounting(productItems), discountItems);
  const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  const totalAmount = Number(payload.totalAmount || 0) > 0 ? Number(payload.totalAmount) : itemTotal;
  console.log('[invoice-save] integrity start:', {
    companyId,
    supplierName: payload.supplierName || '',
    invoiceNo: payload.invoiceNo || '',
    invoiceDate: payload.invoiceDate || '',
    totalAmount,
    itemCount: items.length
  });
  const duplicateCheck = await checkInvoiceDuplicateBeforeSave({
    companyId,
    supplier,
    payload,
    totalAmount,
    items,
    excludeInvoiceId: payload.serverId || payload.id || '',
    batchId: payload.batchId || payload.scanBatchId || ''
  });
  const forceSave = Boolean(payload.forceSave || payload.force || options.forceSave);
  if (duplicateCheck.isDuplicate && !forceSave) {
    console.warn('[invoice-save] integrity duplicate blocked:', { companyId, invoiceNo: payload.invoiceNo || '', totalAmount, duplicateCheck });
    return duplicateBlockedResponse(duplicateCheck);
  }
  const integrity = invoiceIntegrityCheck({ items, discountItems, totalAmount, duplicateCheck });
  const finalStatus = integrity.needsReview
    ? 'PENDING_REVIEW'
    : (payload.status && !['saved', 'PENDING_REVIEW'].includes(payload.status) ? payload.status : 'APPROVED');
  const recognitionWarnings = [
    payload.recognitionWarnings || '',
    ...integrity.warnings,
    integrity.difference > 0.05 ? `totalDifference=${integrity.difference.toFixed(2)}` : ''
  ].filter(Boolean).join(' | ');
  const invoice = await prepareRecordWithReferences('invoices', {
    ...payload,
    supplierId: supplier?.serverId || supplier?.id || '',
    totalAmount,
    calculatedTotal: integrity.itemSubtotal,
    totalDifference: integrity.difference,
    imageHash: payload.imageHash || '',
    ocrTextHash: payload.ocrTextHash || sha256Text(payload.ocrText || ''),
    duplicateStatus: duplicateCheck.isDuplicate ? 'duplicate' : (payload.duplicateStatus || duplicateCheck.duplicateStatus || 'none'),
    duplicateOfInvoiceId: duplicateCheck.isDuplicate ? (duplicateCheck.duplicateOfInvoiceId || duplicateCheck.duplicateInvoiceId || '') : (payload.duplicateOfInvoiceId || ''),
    pageNumber: Number(payload.pageNumber || 0),
    pageCount: Number(payload.pageCount || 0),
    invoiceGroupKey: payload.invoiceGroupKey || '',
    invoiceLayoutType: payload.invoiceLayoutType || 'normal_invoice',
    recognitionWarnings,
    status: finalStatus,
    updatedAt: now
  }, deviceId, companyId);
  const itemRecords = [];
  const priceAnomalies = [];

  const saveBody = async (client) => {
    await upsertRecord('invoices', invoice, client);
    const existingItemRows = await queryAll(`
      SELECT * FROM ${quoteTable('invoice_items')}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
    `, [companyId, invoice.serverId], client);
    await softDeletePriceHistory({
      companyId,
      invoiceIds: [invoice.serverId, invoice.id, invoice.localId],
      itemIds: existingItemRows.flatMap(invoiceIdentityIds),
      deletedAt: now,
      client
    });
    await run(`
      UPDATE ${quoteTable('invoice_items')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
    `, [now, now, companyId, invoice.serverId], client);
    await run(`
      UPDATE ${quoteTable('invoice_discounts')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
    `, [now, now, companyId, invoice.serverId], client);

    for (const item of items.filter((entry) => (entry.productNameOriginal || entry.name || entry.standardName || '').trim())) {
      const standardName = item.standardName || item.productNameNormalized || item.productNameOriginal || item.name || '';
      const record = await prepareRecordWithReferences('invoice_items', {
        ...item,
        rawName: displayRawName(item),
        productNameOriginal: standardName || item.productNameOriginal || item.name || '',
        productNameNormalized: normalizeProductNameAdvanced(standardName || item.productNameNormalized || item.productNameOriginal || ''),
        chargedQty: item.chargedQty,
        freeQty: item.freeQty,
        totalQty: item.totalQty,
        actualQty: item.actualQty,
        originalUnitCost: item.originalUnitCost,
        effectiveUnitCost: item.effectiveUnitCost,
        discountAmount: item.discountAmount,
        discountedEffectiveUnitCost: item.discountedEffectiveUnitCost,
        promoGroupId: item.promoGroupId,
        promoGroupName: item.promoGroupName,
        promoGroupRule: item.promoGroupRule,
        isFreeItem: item.isFreeItem ? 1 : 0,
        candidateOnly: item.candidateOnly ? 1 : 0,
        isHandwrittenQuantity: item.isHandwrittenQuantity ? 1 : 0,
        isHandwrittenPrice: item.isHandwrittenPrice ? 1 : 0,
        isHandwrittenAmount: item.isHandwrittenAmount ? 1 : 0,
        isCircled: item.isCircled ? 1 : 0,
        isChecked: item.isChecked ? 1 : 0,
        freeReason: item.freeReason || '',
        invoiceId: invoice.serverId,
        supplierId: invoice.supplierId,
        invoiceDate: invoice.invoiceDate,
        updatedAt: now
      }, deviceId, companyId, client);
      await upsertRecord('invoice_items', record, client);
      itemRecords.push(record);

      const product = await findOrCreateProductForLearning({ ...item, productNameOriginal: record.productNameOriginal, productNameNormalized: record.productNameNormalized }, deviceId, companyId, client);
      if (product) {
        record.productId = product.serverId || product.id;
        await upsertRecord('invoice_items', { ...record, productId: record.productId }, client);
      }
      await learnProductAlias({ item, itemRecord: record, invoice, supplier, product, deviceId, companyId, client });
      await learnProductRule({ item: { ...item, unitPrice: record.unitPrice }, supplier, product, deviceId, companyId, client });
      if (shouldCreatePriceHistoryForItem(record, invoice)) {
        const anomaly = await learnPrice({ itemRecord: record, invoice, supplier, product, deviceId, companyId, client });
        if (anomaly) priceAnomalies.push(anomaly);
      }
    }
    await saveInvoiceDiscounts({ discountItems, productItemRecords: itemRecords, invoice, supplier, deviceId, companyId, client });

    if (options.beforeResult) {
      await learnCorrections({
        beforeResult: options.beforeResult,
        finalPayload: payload,
        invoice,
        itemRecords,
        supplier,
        templateId: options.invoiceTemplateId || payload.templateId || '',
        deviceId,
        companyId,
        client
      });
    }
  };

  if (options.client) await saveBody(options.client);
  else await withTransaction(saveBody);

  console.log('[invoice-save] integrity saved:', {
    companyId,
    invoiceId: invoice.serverId || invoice.id,
    supplierId: invoice.supplierId,
    invoiceNo: invoice.invoiceNo,
    totalAmount: invoice.totalAmount,
    status: invoice.status
  });
  if (options.mirrorToMongo !== false) await mirrorSqlSyncDataToMongo(companyId, options.mirrorReason || 'invoice-save');

  let template = null;
  if (options.learnTemplate !== false) {
    template = await saveOrUpdateTemplateFromResult(resultFromFinalPayload(payload), payload.sampleImageHash || '', companyId);
  }

  return {
    success: true,
    saved: true,
    needsReview: integrity.needsReview,
    duplicate: Boolean(duplicateCheck.isDuplicate),
    forceSaved: Boolean(duplicateCheck.isDuplicate && forceSave),
    savedAsIndependent: Boolean(duplicateCheck.isDuplicate && forceSave),
    invoiceId: invoice.serverId || invoice.id,
    reason: integrity.warnings.join(','),
    invoice: { ...invoice, supplierName: displaySupplierName(supplier, payload.supplierName || '') },
    items: itemRecords,
    priceAnomalies,
    template,
    duplicateCheck,
    integrity
  };
}

async function saveInvoicePayloadWithLearning(payload, user, options = {}) {
  return saveInvoiceWithIntegrityCheck(payload, { ...options, user, mirrorReason: 'confirm-invoice' });
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

async function pushOne(table, incoming, deviceId, companyId, client = null, syncContext = {}) {
  const existing = await getCloudRecord(table, incoming, companyId, client);
  const incomingUpdatedAt = incoming.updatedAt || nowIso();
  if (existing && existing.updatedAt && existing.updatedAt > incomingUpdatedAt) {
    return { table, localId: incoming.localId || incoming.id, serverId: existing.serverId || existing.id, status: 'conflict', record: existing };
  }

  const record = await prepareRecordWithReferences(table, { ...incoming, serverId: existing?.serverId || existing?.id || incoming.serverId }, deviceId, companyId, client);
  if (table === 'invoices' && !record.deletedAt) {
    const invoiceIds = [incoming.id, incoming.localId, incoming.serverId, record.id, record.localId, record.serverId].filter(Boolean);
    const relatedItems = (syncContext.changes?.invoice_items || [])
      .filter((item) => invoiceIds.includes(item.invoiceId))
      .map((item) => ({ ...item, invoiceId: record.serverId || record.id || item.invoiceId }));
    const relatedDiscountItems = (syncContext.changes?.invoice_discounts || [])
      .filter((discount) => invoiceIds.includes(discount.invoiceId))
      .map((discount) => ({
        ...discount,
        invoiceId: record.serverId || record.id || discount.invoiceId,
        productNameOriginal: discount.discountName || 'Discount',
        productNameNormalized: 'discount',
        name: discount.discountName || 'Discount',
        totalPrice: Number(discount.amount ?? discount.totalPrice ?? 0),
        unitPrice: Number(discount.amount ?? discount.totalPrice ?? 0),
        quantity: 1,
        isDiscountLine: 1
      }));
    const saveResult = await saveInvoiceWithIntegrityCheck({
      ...record,
      supplierName: incoming.supplierName || record.supplierName || '',
      items: [...relatedItems, ...relatedDiscountItems],
      forceSave: incoming.forceSave,
      force: incoming.force
    }, {
      companyId,
      deviceId,
      client,
      learnTemplate: false,
      mirrorToMongo: false,
      source: 'sync-push'
    });
    if (saveResult.duplicate && !incoming.forceSave && !incoming.force) {
      for (const value of invoiceIds) syncContext.rejectedInvoiceIds?.add(value);
      return {
        table,
        localId: incoming.localId || incoming.id || record.localId,
        serverId: saveResult.duplicateCheck?.duplicateOfInvoiceId || saveResult.duplicateCheck?.duplicateInvoiceId || '',
        status: 'duplicate',
        duplicateStatus: 'duplicate',
        duplicateCheck: saveResult.duplicateCheck,
        record: null
      };
    }
    for (const value of invoiceIds) syncContext.integritySavedInvoiceIds?.add(value);
    return {
      table,
      localId: incoming.localId || incoming.id || record.localId,
      serverId: saveResult.invoiceId,
      status: saveResult.needsReview ? 'needs_review' : 'synced',
      duplicateStatus: saveResult.duplicateCheck?.duplicateStatus || 'none',
      needsReview: saveResult.needsReview,
      reason: saveResult.reason || '',
      record: saveResult.invoice || null
    };
  }
  if ((table === 'invoice_items' || table === 'invoice_discounts') && syncContext.integritySavedInvoiceIds?.has(record.invoiceId)) {
    return { table, localId: incoming.localId || incoming.id || record.localId, serverId: record.serverId || record.id, status: 'skipped_integrity_generated', record: null };
  }
  if (table === 'price_history') {
    const relatedItem = (syncContext.changes?.invoice_items || []).find((item) => [item.id, item.localId, item.serverId].filter(Boolean).includes(record.invoiceItemId));
    if (relatedItem && syncContext.integritySavedInvoiceIds?.has(relatedItem.invoiceId)) {
      return { table, localId: incoming.localId || incoming.id || record.localId, serverId: record.serverId || record.id, status: 'skipped_integrity_generated', record: null };
    }
  }
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

function countSyncRecords(changes = {}) {
  return Object.fromEntries(syncTables.map((table) => [table, Array.isArray(changes[table]) ? changes[table].length : 0]));
}

function countSyncResultStatuses(results = []) {
  return results.reduce((counts, result) => {
    const status = result?.status || 'missing_status';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

async function mirrorSqlSyncDataToMongo(companyId, reason = 'server-save', since = '') {
  if (!useMongoSync()) return null;
  try {
    const changes = await allSyncData(companyId, since);
    const counts = countSyncRecords(changes);
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    console.log('[sync/mirror] start:', { reason, companyId, since, total, counts });
    if (!total) return { ok: true, skipped: true, counts };
    const result = await mongoSyncPush({ companyId, deviceId: `server-${reason}`, changes });
    console.log('[sync/mirror] completed:', {
      reason,
      companyId,
      resultCount: Array.isArray(result.results) ? result.results.length : 0
    });
    return result;
  } catch (error) {
    console.error('[sync/mirror] failed:', { reason, companyId, since, error: error?.stack || error?.message || String(error) });
    return null;
  }
}

async function invoiceWithSupplierRows(companyId) {
  return queryAll(`
    SELECT invoices.*, COALESCE(suppliers.${quoteIdentifier('supplierDisplayName')}, suppliers.${quoteIdentifier('displayName')}, suppliers.${quoteIdentifier('name')}) AS "supplierName"
    FROM ${quoteTable('invoices')} invoices
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoices.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoices.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoices.${quoteIdentifier('supplierId')})
    WHERE invoices.${quoteIdentifier('companyId')} = ?
      AND invoices.${quoteIdentifier('deletedAt')} IS NULL
      AND COALESCE(invoices.${quoteIdentifier('status')}, 'saved') NOT IN ('merged', 'hidden')
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
  console.log('[recognition-task] created:', {
    taskId: task.id,
    companyId: task.companyId,
    batchId: task.batchId,
    imagePath: task.imagePath,
    fileSize: task.fileSize
  });
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
    const rawResult = await withTimeout(recognizeInvoice(taskFileFromRow(task), {
      companyId: task.companyId,
      supplierHint: task.supplierHint || '',
      batchId: task.batchId || ''
    }), OCR_TIMEOUT_MS, 'Invoice recognition');
    console.log('[recognition-task] ai/ocr completed:', {
      taskId,
      companyId: task.companyId,
      recognitionSource: rawResult?.recognitionSource || rawResult?.source || '',
      supplierName: rawResult?.parsed?.supplierName || '',
      invoiceNo: rawResult?.parsed?.invoiceNo || '',
      totalAmount: Number(rawResult?.parsed?.totalAmount || 0),
      itemCount: Array.isArray(rawResult?.parsed?.items) ? rawResult.parsed.items.length : 0
    });
    const result = await enhanceRecognizedResultWithLearning(rawResult, task.companyId);
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
    console.log('[recognition-task] completed:', {
      taskId,
      companyId: task.companyId,
      invoiceId: saveResult.invoiceId || '',
      duplicateStatus: saveResult.duplicateCheck?.duplicateStatus || '',
      skippedSave: Boolean(saveResult.duplicateCheck?.skippedSave)
    });
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
    duplicateStatus: 'none',
    possibleDuplicateReason: '',
    autoMerged: false,
    autoMergeMessage: '',
    mergeTotalMode: '',
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

function daysBetweenDates(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const left = new Date(`${String(a).slice(0, 10)}T00:00:00Z`).getTime();
  const right = new Date(`${String(b).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86400000;
}

function invoiceComparisonFingerprint({ supplierId = '', supplierName = '', invoiceNo = '', invoiceDate = '', totalAmount = 0, items = [], batchId = '', scanBatchId = '', pageNumber = 0, pageCount = 0, invoiceGroupKey = '', createdAt = '' }) {
  return {
    supplierId,
    supplierName,
    invoiceNo: normalizeComparisonText(invoiceNo),
    invoiceDate,
    totalAmount: comparisonAmount(totalAmount),
    itemCount: items.length,
    itemNames: items.map(itemComparisonName).filter(Boolean).sort(),
    totalQuantity: comparisonAmount(items.reduce((sum, item) => sum + Number(item.quantity ?? item.qty ?? 0), 0)),
    batchId,
    scanBatchId,
    pageNumber: Number(pageNumber || 0),
    pageCount: Number(pageCount || 0),
    invoiceGroupKey,
    createdAt
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

function compareInvoiceForDuplicateV2(current, candidate, label) {
  const result = emptyDuplicateCheck();
  const sameSupplier = current.supplierId && candidate.supplierId
    ? current.supplierId === candidate.supplierId
    : supplierNamesNearlyEqual(current.supplierName, candidate.supplierName);
  if (!sameSupplier) return result;

  const sameInvoiceNo = Boolean(current.invoiceNo && current.invoiceNo === candidate.invoiceNo);
  const sameAmount = amountsNearlyEqual(current.totalAmount, candidate.totalAmount);
  const sameItems = invoiceItemsNearlyEqual(current, candidate);
  const sameOrCloseDate = daysBetweenDates(current.invoiceDate, candidate.invoiceDate) <= 1;
  const sameBatch = Boolean(current.batchId && candidate.batchId && current.batchId === candidate.batchId);
  const sameGroupKey = Boolean(current.invoiceGroupKey && candidate.invoiceGroupKey && current.invoiceGroupKey === candidate.invoiceGroupKey);

  result.sameSupplierBatch = true;

  if (!sameInvoiceNo) {
    if (sameAmount && sameItems && sameOrCloseDate) {
      result.duplicateStatus = 'possible';
      result.possibleDuplicateReason = `${label}: supplier/date/amount/items are similar, but invoiceNo is different.`;
    }
    return result;
  }

  if (!sameOrCloseDate) {
    result.duplicateStatus = 'possible';
    result.sameInvoiceGroup = true;
    result.possibleSameInvoicePages = true;
    result.possibleDuplicateReason = `${label}: same supplier and invoiceNo, but invoiceDate conflicts. Please confirm the correct date.`;
    result.sameInvoiceGroupReason = '同供应商同发票号但日期冲突，请人工确认，不自动拆分或自动合并。';
    return result;
  }

  const safeSameGroup = sameBatch || sameGroupKey;

  if (sameInvoiceNo && sameOrCloseDate && !sameItems && safeSameGroup) {
    result.sameInvoiceGroup = true;
    result.possibleSameInvoicePages = true;
    result.multiPageInvoice = true;
    result.autoMerged = true;
    result.mergeTotalMode = 'sum';
    result.duplicateStatus = 'none';
    result.autoMergeMessage = `已自动合并：发票号 ${current.invoiceNo}，检测到同一张多页发票。`;
    result.sameInvoiceGroupReason = result.autoMergeMessage;
    return result;
  }

  if (sameInvoiceNo && sameOrCloseDate && !sameItems && !safeSameGroup) {
    result.duplicateStatus = 'possible';
    result.sameInvoiceGroup = true;
    result.possibleSameInvoicePages = true;
    result.possibleDuplicateReason = `${label}: same supplier and invoiceNo, but batch/account grouping is missing. Review before merging.`;
    result.sameInvoiceGroupReason = 'POSSIBLE_MULTI_PAGE_OR_DUPLICATE';
    return result;
  }

  if (sameAmount && sameItems) {
    result.isDuplicate = true;
    result.duplicate = true;
    result.duplicateStatus = 'confirmed';
    result.duplicateReason = `${label}: same supplier, invoiceNo, close invoiceDate, totalAmount, and item details.`;
    result.skippedSave = true;
    return result;
  }

  result.duplicateStatus = 'possible';
  result.sameInvoiceGroup = true;
  result.possibleSameInvoicePages = safeSameGroup && (!sameAmount || !sameItems);
  result.multiPageInvoice = result.possibleSameInvoicePages;
  result.sameInvoiceGroupReason = sameAmount
    ? '同供应商同发票号且日期接近，金额相同但商品明细不同，请人工确认。'
    : '同供应商同发票号且日期接近，但金额不同，可能是多页/同批次发票，请人工确认。';
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

function sha256Text(value = '') {
  const text = String(value || '');
  return text ? crypto.createHash('sha256').update(text).digest('hex') : '';
}

function invoiceIdentityIds(invoice = {}) {
  return [invoice.id, invoice.serverId, invoice.localId].filter(Boolean);
}

function invoiceDuplicateSummary(invoice = {}, supplierName = '') {
  return {
    duplicateInvoiceId: invoice.serverId || invoice.id || '',
    duplicateOfInvoiceId: invoice.serverId || invoice.id || '',
    invoiceNo: invoice.invoiceNo || '',
    supplier: supplierName || invoice.supplierName || invoice.supplierId || '',
    invoiceDate: invoice.invoiceDate || '',
    date: invoice.invoiceDate || '',
    totalAmount: Number(invoice.totalAmount || 0)
  };
}

function markDuplicateCheck(result, candidate, supplierName, reason) {
  const summary = invoiceDuplicateSummary(candidate, supplierName);
  return {
    ...result,
    ...summary,
    isDuplicate: true,
    duplicate: true,
    duplicateStatus: 'duplicate',
    duplicateReason: reason,
    skippedSave: true
  };
}

async function findRecognitionDuplicate(companyId, parsed, totalAmount, currentItems, excludeInvoiceId = '', batchId = '') {
  const currentOcrTextHash = parsed.ocrTextHash || sha256Text(parsed.ocrText || '');
  const currentImageHash = parsed.imageHash || '';
  const current = invoiceComparisonFingerprint({
    supplierId: parsed.supplierId || '',
    supplierName: parsed.supplierName || '',
    invoiceNo: parsed.invoiceNo || '',
    invoiceDate: parsed.invoiceDate || '',
    totalAmount,
    items: currentItems,
    batchId,
    scanBatchId: batchId,
    pageNumber: parsed.pageNumber || 0,
    pageCount: parsed.pageCount || 0,
    invoiceGroupKey: parsed.invoiceGroupKey || buildInvoiceGroupKey({ supplierName: parsed.supplierName || '', invoiceNo: parsed.invoiceNo || '', totalAmount }),
    createdAt: parsed.createdAt || ''
  });

  const candidates = await queryAll(`
    SELECT invoices.*, COALESCE(suppliers.${quoteIdentifier('supplierDisplayName')}, suppliers.${quoteIdentifier('displayName')}, suppliers.${quoteIdentifier('name')}) AS "supplierName"
    FROM ${quoteTable('invoices')} invoices
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoices.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoices.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoices.${quoteIdentifier('supplierId')})
    WHERE invoices.${quoteIdentifier('companyId')} = ?
      AND invoices.${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY invoices.${quoteIdentifier('createdAt')} DESC
    LIMIT 250
  `, [companyId]);

  let groupInfo = emptyDuplicateCheck();
  for (const candidate of candidates) {
    const candidateIdList = [candidate.id, candidate.localId, candidate.serverId].filter(Boolean);
    if (excludeInvoiceId && candidateIdList.includes(excludeInvoiceId)) continue;
    if (candidateIdList.length === 0) continue;
    const candidateSupplierName = candidate.supplierName || '';
    const sameSupplier = current.supplierId && candidate.supplierId
      ? current.supplierId === candidate.supplierId
      : supplierNamesNearlyEqual(current.supplierName, candidateSupplierName);
    const sameDate = daysBetweenDates(current.invoiceDate, candidate.invoiceDate) <= 1;
    const sameAmount = amountsNearlyEqual(current.totalAmount, candidate.totalAmount);
    const sameInvoiceNo = Boolean(current.invoiceNo && normalizeComparisonText(candidate.invoiceNo || '') === current.invoiceNo);
    if (sameInvoiceNo && !sameSupplier && !groupInfo.sameInvoiceGroup) {
      groupInfo = {
        ...emptyDuplicateCheck(),
        duplicateStatus: 'possible',
        sameInvoiceGroup: true,
        possibleSameInvoicePages: false,
        possibleDuplicateReason: 'Same invoice number but supplier is different. Please review before saving.',
        sameInvoiceGroupReason: '发票号相同，但供应商不同或相似度不足，已进入待确认发票。'
      };
      continue;
    }
    if (!current.invoiceNo && sameSupplier && sameDate && sameAmount) {
      const candidateOcrHash = candidate.ocrTextHash || sha256Text(candidate.ocrText || '');
      const candidateImageHash = candidate.imageHash || '';
      if (currentOcrTextHash && candidateOcrHash && currentOcrTextHash === candidateOcrHash) {
        return markDuplicateCheck(emptyDuplicateCheck(), candidate, candidateSupplierName, 'same supplier, close invoiceDate, totalAmount, and OCR text hash.');
      }
      if (currentImageHash && candidateImageHash && currentImageHash === candidateImageHash) {
        return markDuplicateCheck(emptyDuplicateCheck(), candidate, candidateSupplierName, 'same image hash and totalAmount.');
      }
    }
    const items = await queryAll(`
      SELECT * FROM ${quoteTable('invoice_items')}
      WHERE ${quoteIdentifier('companyId')} = ?
        AND ${quoteIdentifier('deletedAt')} IS NULL
        AND ${quoteIdentifier('invoiceId')} IN (${candidateIdList.map(() => '?').join(',')})
    `, [companyId, ...candidateIdList]);
    const candidateFingerprint = invoiceComparisonFingerprint({
      supplierId: candidate.supplierId || '',
      supplierName: candidate.supplierName || '',
      invoiceNo: candidate.invoiceNo || '',
      invoiceDate: candidate.invoiceDate || '',
      totalAmount: candidate.totalAmount || items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0),
      items,
      batchId: candidate.batchId || '',
      scanBatchId: candidate.scanBatchId || candidate.batchId || '',
      pageNumber: candidate.pageNumber || 0,
      pageCount: candidate.pageCount || 0,
      invoiceGroupKey: candidate.invoiceGroupKey || '',
      createdAt: candidate.createdAt || ''
    });
    const duplicateInfo = compareInvoiceForDuplicateV2(current, candidateFingerprint, 'Cloud invoice');
    if (duplicateInfo.isDuplicate) {
      return markDuplicateCheck(duplicateInfo, candidate, candidateSupplierName, duplicateInfo.duplicateReason || 'duplicate invoice');
    }
    if (duplicateInfo.possibleSameInvoicePages && batchId && candidate.batchId === batchId) {
      return {
        ...duplicateInfo,
        sameInvoiceGroup: true,
        possibleSameInvoicePages: true,
        multiPageInvoice: true,
        duplicateStatus: 'none',
        mergeInvoiceId: candidate.serverId || candidate.id,
        pageTotal: totalAmount,
        sameInvoiceGroupReason: '同批次同供应商同发票号，可能是同一张多页发票，请人工确认合并。'
      };
    }
    if (duplicateInfo.multiPageInvoice) {
      return {
        ...duplicateInfo,
        mergeInvoiceId: candidate.serverId || candidate.id,
        pageTotal: totalAmount
      };
    }
    if (duplicateInfo.sameInvoiceGroup && !groupInfo.sameInvoiceGroup) groupInfo = duplicateInfo;
  }
  return groupInfo;
}

async function checkInvoiceDuplicateBeforeSave({ companyId, supplier, payload, totalAmount, items, excludeInvoiceId = '', batchId = '' }) {
  const supplierName = displaySupplierName(supplier, payload.supplierName || '');
  const duplicateCheck = await findRecognitionDuplicate(companyId, {
    supplierId: supplier?.serverId || supplier?.id || payload.supplierId || '',
    supplierName,
    invoiceNo: payload.invoiceNo || '',
    invoiceDate: payload.invoiceDate || '',
    pageNumber: payload.pageNumber || 0,
    pageCount: payload.pageCount || 0,
    invoiceGroupKey: payload.invoiceGroupKey || '',
    ocrText: payload.ocrText || '',
    ocrTextHash: payload.ocrTextHash || sha256Text(payload.ocrText || ''),
    imageHash: payload.imageHash || ''
  }, totalAmount, items, excludeInvoiceId, batchId || payload.batchId || payload.scanBatchId || '');
  duplicateCheck.calculatedTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  duplicateCheck.totalDifference = Math.abs(duplicateCheck.calculatedTotal - Number(totalAmount || 0));
  return duplicateCheck;
}

function duplicateBlockedResponse(duplicateCheck) {
  return {
    success: false,
    duplicate: true,
    isDuplicate: true,
    duplicateStatus: 'duplicate',
    duplicateCheck,
    error: '可能重复发票，是否强制保存',
    message: '可能重复发票，是否强制保存'
  };
}

async function softDeletePriceHistory({ companyId, invoiceIds = [], itemIds = [], deletedAt = nowIso(), client = null }) {
  const invoiceIdList = [...new Set(invoiceIds.filter(Boolean))];
  const itemIdList = [...new Set(itemIds.filter(Boolean))];
  if (invoiceIdList.length === 0 && itemIdList.length === 0) return;
  const clauses = [];
  const params = [deletedAt, deletedAt, companyId];
  if (invoiceIdList.length) {
    clauses.push(`${quoteIdentifier('invoiceId')} IN (${invoiceIdList.map(() => '?').join(', ')})`);
    params.push(...invoiceIdList);
  }
  if (itemIdList.length) {
    clauses.push(`${quoteIdentifier('invoiceItemId')} IN (${itemIdList.map(() => '?').join(', ')})`);
    params.push(...itemIdList);
  }
  await run(`
    UPDATE ${quoteTable('price_history')}
    SET ${quoteIdentifier('deletedAt')} = ?,
        ${quoteIdentifier('updatedAt')} = ?,
        ${quoteIdentifier('status')} = 'deleted',
        ${quoteIdentifier('syncStatus')} = 'deleted'
    WHERE ${quoteIdentifier('companyId')} = ?
      AND (${clauses.join(' OR ')})
      AND ${quoteIdentifier('deletedAt')} IS NULL
  `, params, client);
}

async function saveRecognizedInvoiceFromTask(task, result, options = {}) {
  const parsed = result.parsed || {};
  const { productItems, discountItems } = splitInvoiceRows(Array.isArray(parsed.items) ? parsed.items : []);
  const items = applyDiscountAllocation(applyGiftAccounting(productItems), discountItems);
  const deviceId = task.deviceId || 'recognition-task';
  const companyId = task.companyId;
  const now = nowIso();
  const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  const totalAmount = Number(parsed.totalAmount || 0) > 0 ? Number(parsed.totalAmount) : itemTotal;
  console.log('[invoice-save] recognition-task start:', {
    taskId: task.id,
    companyId,
    supplierName: parsed.supplierName || '',
    invoiceNo: parsed.invoiceNo || '',
    invoiceDate: parsed.invoiceDate || '',
    totalAmount,
    itemCount: items.length
  });
  const imageHash = await sha256File(task.filePath);
  const duplicateCheck = await findRecognitionDuplicate(companyId, {
    ...parsed,
    ocrText: result.ocrText || parsed.ocrText || '',
    ocrTextHash: parsed.ocrTextHash || sha256Text(result.ocrText || parsed.ocrText || ''),
    imageHash
  }, totalAmount, items, task.invoiceId, task.batchId || '');
  duplicateCheck.pageTotal = totalAmount;
  duplicateCheck.calculatedTotal = itemTotal;
  duplicateCheck.totalDifference = Math.abs(itemTotal - totalAmount);
  duplicateCheck.priceAnomalies = [];
  if (duplicateCheck.isDuplicate && !options.force) {
    console.warn('[invoice-save] recognition-task duplicate skipped:', {
      taskId: task.id,
      companyId,
      invoiceNo: parsed.invoiceNo || '',
      totalAmount,
      duplicateCheck
    });
    return { invoiceId: '', duplicateCheck, imageHash };
  }
  if (options.force) {
    duplicateCheck.forcedSave = true;
    duplicateCheck.skippedSave = false;
  }
  const supplier = await findOrCreateSupplierV2(parsed.supplierName, deviceId, companyId);
  const mergeInvoiceId = !options.independent && duplicateCheck.multiPageInvoice ? duplicateCheck.mergeInvoiceId : '';
  const existingInvoice = mergeInvoiceId ? await queryGet(`
    SELECT * FROM ${quoteTable('invoices')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ?)
    LIMIT 1
  `, [companyId, mergeInvoiceId, mergeInvoiceId]) : null;
  const invoiceId = mergeInvoiceId || task.invoiceId || id();
  const pageInvoiceId = existingInvoice ? (task.invoiceId && task.invoiceId !== invoiceId ? task.invoiceId : id()) : '';
  const existingMergedIds = existingInvoice ? parseAliases(existingInvoice.mergedInvoiceIds) : [];
  const mergedInvoiceIds = existingInvoice ? [...new Set([...existingMergedIds, pageInvoiceId].filter(Boolean))] : [];
  const invoiceTotal = existingInvoice
    ? Number(existingInvoice.totalAmount || 0) + totalAmount
    : totalAmount;
  const calculatedTotal = Number(existingInvoice?.calculatedTotal || 0) + itemTotal;
  const totalDifference = Math.abs(calculatedTotal - invoiceTotal);
  const needsReview = duplicateCheck.duplicateStatus === 'possible'
    || totalDifference > 0.05
    || Number(parsed.dateConfidence ?? 1) < 0.7
    || !parsed.invoiceDate;
  if (existingInvoice) {
    duplicateCheck.mergedIntoInvoiceId = existingInvoice.serverId || existingInvoice.id;
    duplicateCheck.pageInvoiceId = pageInvoiceId;
    duplicateCheck.invoiceTotal = invoiceTotal;
    duplicateCheck.autoMerged = true;
    duplicateCheck.mergeTotalMode = 'sum';
    duplicateCheck.autoMergeMessage = `已自动合并：发票号 ${parsed.invoiceNo || existingInvoice.invoiceNo || '-'}，共 ${mergedInvoiceIds.length + 1} 页，总金额 $${invoiceTotal.toFixed(2)}`;
  }
  const invoice = await prepareRecordWithReferences('invoices', {
    id: invoiceId,
    localId: invoiceId,
    serverId: invoiceId,
    supplierId: supplier?.serverId || supplier?.id || '',
    invoiceNo: parsed.invoiceNo || '',
    invoiceDate: parsed.invoiceDate || '',
    pageNumber: Number(parsed.pageNumber || 0),
    pageCount: existingInvoice ? Math.max(Number(existingInvoice.pageCount || 1) + 1, Number(parsed.pageCount || 0), mergedInvoiceIds.length + 1) : Number(parsed.pageCount || 0),
    invoiceGroupKey: parsed.invoiceGroupKey || '',
    isMergedInvoice: Boolean(existingInvoice),
    isMultiPage: Boolean(existingInvoice),
    mergedInvoiceIds,
    invoiceLayoutType: parsed.invoiceLayoutType || 'normal_invoice',
    batchId: task.batchId || existingInvoice?.batchId || '',
    scanBatchId: task.batchId || existingInvoice?.scanBatchId || existingInvoice?.batchId || '',
    duplicateStatus: duplicateCheck.duplicateStatus || (duplicateCheck.isDuplicate ? 'confirmed' : duplicateCheck.sameInvoiceGroup ? 'possible' : 'none'),
    duplicateOfInvoiceId: duplicateCheck.duplicateOfInvoiceId || '',
    recognitionSource: result.recognitionSource || result.source || task.recognitionSource || '',
    recognitionWarnings: needsReview ? (parsed.warnings || duplicateCheck.sameInvoiceGroupReason || '') : '',
    imagePath: existingInvoice?.imagePath || result.imagePath || task.imagePath || '',
    imageHash: existingInvoice?.imageHash || imageHash,
    ocrText: [existingInvoice?.ocrText, result.ocrText].filter(Boolean).join('\n\n--- page ---\n\n'),
    ocrTextHash: sha256Text([existingInvoice?.ocrText, result.ocrText].filter(Boolean).join('\n\n--- page ---\n\n')),
    totalAmount: invoiceTotal,
    calculatedTotal,
    totalDifference,
    status: needsReview ? 'PENDING_REVIEW' : 'APPROVED',
    createdAt: existingInvoice?.createdAt || task.createdAt || now,
    updatedAt: now
  }, deviceId, companyId);

  const pageInvoice = existingInvoice ? await prepareRecordWithReferences('invoices', {
    id: pageInvoiceId,
    localId: pageInvoiceId,
    serverId: pageInvoiceId,
    supplierId: invoice.supplierId,
    invoiceNo: invoice.invoiceNo,
    invoiceDate: invoice.invoiceDate,
    pageNumber: invoice.pageCount,
    pageCount: invoice.pageCount,
    invoiceGroupKey: invoice.invoiceGroupKey,
    isMergedInvoice: 0,
    isMultiPage: 1,
    mergedInvoiceIds: '[]',
    invoiceLayoutType: parsed.invoiceLayoutType || 'normal_invoice',
    batchId: task.batchId || existingInvoice?.batchId || '',
    scanBatchId: task.batchId || existingInvoice?.scanBatchId || existingInvoice?.batchId || '',
    duplicateStatus: 'none',
    recognitionSource: result.recognitionSource || result.source || task.recognitionSource || '',
    recognitionWarnings: '',
    imagePath: result.imagePath || task.imagePath || '',
    ocrText: result.ocrText || '',
    totalAmount,
    calculatedTotal: itemTotal,
    totalDifference: Math.abs(itemTotal - totalAmount),
    status: 'merged',
    createdAt: task.createdAt || now,
    updatedAt: now
  }, deviceId, companyId) : null;

  await withTransaction(async (client) => {
    await upsertRecord('invoices', invoice, client);
    if (pageInvoice) await upsertRecord('invoices', pageInvoice, client);
    if (!existingInvoice) {
      const existingItemRows = await queryAll(`
        SELECT * FROM ${quoteTable('invoice_items')}
        WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
      `, [companyId, invoice.serverId], client);
      await softDeletePriceHistory({
        companyId,
        invoiceIds: [invoice.serverId, invoice.id, invoice.localId],
        itemIds: existingItemRows.flatMap(invoiceIdentityIds),
        deletedAt: now,
        client
      });
      await run(`
        UPDATE ${quoteTable('invoice_items')}
        SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
        WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
      `, [now, now, companyId, invoice.serverId], client);
      await run(`
        UPDATE ${quoteTable('invoice_discounts')}
        SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
        WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
      `, [now, now, companyId, invoice.serverId], client);
    }
    const itemRecords = [];
    for (const item of items.filter((entry) => (entry.productNameOriginal || entry.name || '').trim())) {
      const itemId = id();
      const itemRecord = await prepareRecordWithReferences('invoice_items', {
        id: itemId,
        localId: itemId,
        serverId: itemId,
        rawName: item.rawName || item.name || item.productNameOriginal || '',
        nameCn: item.nameCn || '',
        nameEn: item.nameEn || '',
        spec: item.spec || '',
        productNameOriginal: item.productNameOriginal || item.name || '',
        productNameNormalized: item.productNameNormalized || item.normalizedName || item.standardName || item.name || '',
        category: item.category || '',
        quantity: Number(item.quantity ?? item.qty ?? 0),
        unit: item.unit || item.spec || '',
        unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.totalPrice || 0),
        chargedQty: item.chargedQty,
        freeQty: item.freeQty,
        totalQty: item.totalQty,
        actualQty: item.actualQty,
        originalUnitCost: item.originalUnitCost,
        effectiveUnitCost: item.effectiveUnitCost,
        discountAmount: item.discountAmount,
        discountedEffectiveUnitCost: item.discountedEffectiveUnitCost,
        promoGroupId: item.promoGroupId,
        promoGroupName: item.promoGroupName,
        promoGroupRule: item.promoGroupRule,
        participatesInGiftAllocation: item.participatesInGiftAllocation ? 1 : 0,
        isFreeItem: item.isFreeItem ? 1 : 0,
        candidateOnly: item.candidateOnly ? 1 : 0,
        isHandwrittenQuantity: item.isHandwrittenQuantity ? 1 : 0,
        isHandwrittenPrice: item.isHandwrittenPrice ? 1 : 0,
        isHandwrittenAmount: item.isHandwrittenAmount ? 1 : 0,
        isCircled: item.isCircled ? 1 : 0,
        isChecked: item.isChecked ? 1 : 0,
        freeReason: item.freeReason || '',
        notes: [item.notes, duplicateCheck.multiPageInvoice ? `pageTotal=${totalAmount.toFixed(2)}` : '', task.id ? `taskId=${task.id}` : ''].filter(Boolean).join(' | '),
        invoiceId: invoice.serverId,
        supplierId: invoice.supplierId,
        invoiceDate: invoice.invoiceDate,
        updatedAt: now
      }, deviceId, companyId, client);
      await upsertRecord('invoice_items', itemRecord, client);
      itemRecords.push(itemRecord);
      const product = await findOrCreateProductForLearning(item, deviceId, companyId, client);
      if (product) {
        itemRecord.productId = product.serverId || product.id;
        await upsertRecord('invoice_items', { ...itemRecord, productId: itemRecord.productId }, client);
      }
      await learnProductAlias({ item, itemRecord, invoice, supplier, product, deviceId, companyId, client });
      await learnProductRule({ item, supplier, product, deviceId, companyId, client });
      const anomaly = await learnPrice({ itemRecord, invoice, supplier, product, deviceId, companyId, client });
      if (anomaly) duplicateCheck.priceAnomalies.push(anomaly);
    }
    await saveInvoiceDiscounts({ discountItems, productItemRecords: itemRecords, invoice, supplier, deviceId, companyId, client });
  });

  console.log('[invoice-save] recognition-task saved:', {
    taskId: task.id,
    companyId,
    invoiceId: invoice.serverId || invoice.id,
    supplierId: invoice.supplierId,
    invoiceNo: invoice.invoiceNo,
    totalAmount: invoice.totalAmount,
    status: invoice.status
  });
  await mirrorSqlSyncDataToMongo(companyId, 'recognition-task-save');

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
  res.json({ ok: true, database: syncBackend.toLowerCase(), time: nowIso() });
});

app.get('/api/debug/db', asyncHandler(async (req, res) => {
  const mongo = await getMongoDebugStatus();
  res.json({
    mongoConfigured: mongo.mongoConfigured,
    mongoConnected: mongo.mongoConnected,
    status: mongo.status,
    databaseName: mongo.databaseName,
    host: mongo.host,
    lastError: mongo.lastError || ''
  });
}));

app.get('/ping', (req, res) => {
  res.json({ ok: true, service: 'InvoicePriceTracker API', host: '0.0.0.0', port: PORT, database: usingPostgres ? 'postgres' : 'sqlite', time: nowIso() });
});

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const requestId = crypto.randomBytes(4).toString('hex');
  const email = String(req.body.email || '').trim().toLowerCase();
  const username = String(req.body.username || req.body.name || '').trim();
  const password = String(req.body.password || '');
  const companyName = String(req.body.companyName || '').trim() || '我的门店';
  const name = String(req.body.name || '').trim();
  console.info(`[auth/register:${requestId}] request received`, {
    email,
    username,
    companyName,
    mode: useMongoAuth() ? 'Mongo' : 'SQLite'
  });
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  if (useMongoAuth()) {
    if (!username) return res.status(400).json({ error: '用户名不能为空' });
    try {
      console.info(`[auth/register:${requestId}] mode Mongo`);
      const [existingMongoEmail, existingMongoUsername, existingSqlEmail, existingSqlUsername] = await Promise.all([
        findMongoUserByEmail(email),
        findMongoUserByLogin(username),
        findSqlUserByEmail(email),
        findSqlUserByUsername(username)
      ]);
      if (existingMongoEmail || existingSqlEmail) {
        return res.status(409).json({ error: '邮箱已注册，请直接登录' });
      }
      if (existingMongoUsername || existingSqlUsername) {
        return res.status(409).json({ error: '用户名已注册，请换一个用户名' });
      }
      console.info(`[auth/register:${requestId}] creating Mongo user`);
      const user = await withTimeout(createMongoUser({
        id: id(),
        username,
        email,
        passwordHash: await withTimeout(hashPasswordAsync(password), 15000, 'Password hash'),
        role: 'super_admin',
        status: 'active',
        companyName,
        companyId: id(),
        name: name || username
      }), 15000, 'MongoDB create user');
      console.info(`[auth/register:${requestId}] success`, { userId: user.id, companyId: user.companyId });
      res.json({ success: true, message: '注册成功，请登录', user: toPublicMongoUser(user) });
      return;
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: '邮箱或用户名已被注册' });
      console.error(`[auth/register:${requestId}] error:`, error?.stack || error);
      return res.status(error.statusCode || 500).json({ success: false, error: describeAuthRegisterError(error) });
    }
  }

  console.info(`[auth/register:${requestId}] mode SQLite`);
  const existing = await findSqlUserByEmail(email);
  if (existing) return res.status(409).json({ error: '这个邮箱已经注册' });
  const existingUsername = username ? await findSqlUserByUsername(username) : null;
  if (existingUsername) return res.status(409).json({ error: '用户名已注册，请换一个用户名' });

  const now = nowIso();
  const company = { id: id(), name: companyName, maxAdminUsers: 99, maxSalesUsers: 999, createdAt: now, updatedAt: now };
  const passwordHash = await withTimeout(hashPasswordAsync(password), 15000, 'Password hash');
  const user = { id: id(), companyId: company.id, username, email, passwordHash, name: name || username, role: 'super_admin', status: 'active', phone: '', note: '', lastLoginAt: '', createdAt: now, updatedAt: now };
  await withTransaction(async (client) => {
    await upsertRecord('companies', company, client);
    await upsertRecord('users', user, client);
  });
  console.info(`[auth/register:${requestId}] success`, { userId: user.id, companyId: company.id });
  res.json({ success: true, message: '注册成功，请登录', user: { id: user.id, email: user.email, companyId: user.companyId }, company });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const login = String(req.body.login || req.body.email || req.body.username || '').trim();
  const email = login.toLowerCase();
  const password = String(req.body.password || '');
  if (useMongoAuth()) {
    const mongoUser = await findMongoUserByLogin(login);
    if (mongoUser && (await verifyPasswordAsync(password, mongoUser.passwordHash))) {
      if ((mongoUser.status || 'active') !== 'active') return res.status(403).json({ error: '账号已被禁用' });
      const lastLoginAt = nowIso();
      const mongoDb = await getMongoDb();
      await mongoDb.collection('users').updateOne({ id: mongoUser.id }, { $set: { lastLoginAt, updatedAt: lastLoginAt } });
      res.json(authResponse({ ...mongoUser, lastLoginAt, authStore: 'mongo' }, { id: mongoUser.companyId, name: mongoUser.companyName || '' }));
      return;
    }

    const legacySqlUser = await findSqlUserByLogin(login);
    if (legacySqlUser && (await verifyPasswordAsync(password, legacySqlUser.passwordHash))) {
      const company = await sqlCompanyForUser(legacySqlUser);
      const migratedUser = mongoUser?.email === legacySqlUser.email
        ? await updateMongoUserFromLegacy({
            email: legacySqlUser.email,
            passwordHash: legacySqlUser.passwordHash,
            companyId: legacySqlUser.companyId,
            companyName: company.name || '',
            role: legacySqlUser.role || mongoUser.role || 'admin',
            name: legacySqlUser.name || mongoUser.name || mongoUser.username || ''
          })
        : await createMongoUserFromSqlUser(legacySqlUser);
      if ((migratedUser.status || 'active') !== 'active') return res.status(403).json({ error: '账号已被禁用' });
      res.json(authResponse({ ...migratedUser, authStore: 'mongo' }, { id: migratedUser.companyId, name: migratedUser.companyName || company.name || '' }));
      return;
    }

    if (!mongoUser) {
      return res.status(401).json({ error: '邮箱/用户名或密码不正确' });
    }
    return res.status(401).json({ error: '邮箱/用户名或密码不正确' });
  }
  const user = await findSqlUserByLogin(email);
  if (!user || !(await verifyPasswordAsync(password, user.passwordHash))) {
    return res.status(401).json({ error: '邮箱或密码不正确' });
  }
  if ((user.status || 'active') !== 'active') return res.status(403).json({ error: '账号已被禁用' });
  const lastLoginAt = nowIso();
  await run(`
    UPDATE ${quoteTable('users')}
    SET ${quoteIdentifier('lastLoginAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ?
  `, [lastLoginAt, lastLoginAt, user.id]);
  const company = await sqlCompanyForUser(user);
  res.json(authResponse({ ...user, lastLoginAt }, company || { id: user.companyId, name: '' }));
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
  if (req.company) {
    res.json({ user: req.user, company: req.company });
    return;
  }
  const company = await queryGet(`SELECT * FROM ${quoteTable('companies')} WHERE ${quoteIdentifier('id')} = ? LIMIT 1`, [req.user.companyId]);
  res.json({ user: req.user, company: company || { id: req.user.companyId, name: '' } });
}));

app.get('/api/admin/members', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (useMongoAuth()) {
    const db = await getMongoDb();
    const members = await db.collection('users')
      .find({ companyId: req.user.companyId })
      .sort({ createdAt: 1 })
      .toArray();
    res.json({ members: members.map(publicMember), limits: await getCompanyLimits(req.user.companyId) });
    return;
  }
  const members = await queryAll(`
    SELECT * FROM ${quoteTable('users')}
    WHERE ${quoteIdentifier('companyId')} = ?
    ORDER BY ${quoteIdentifier('createdAt')} ASC
  `, [req.user.companyId]);
  res.json({ members: members.map(publicMember), limits: await getCompanyLimits(req.user.companyId) });
}));

app.post('/api/admin/members', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const role = normalizeMemberRole(req.body.role);
  const status = normalizeMemberStatus(req.body.status);
  const phone = String(req.body.phone || '').trim();
  const note = String(req.body.note || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '请输入有效邮箱' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  await assertMemberQuota({ companyId: req.user.companyId, role });
  const now = nowIso();
  const passwordHash = await withTimeout(hashPasswordAsync(password), 15000, 'Password hash');
  if (useMongoAuth()) {
    const existing = await findMongoUserByEmail(email);
    if (existing) return res.status(409).json({ error: '邮箱已注册' });
    const company = req.company || await findMongoCompanyById(req.user.companyId) || { id: req.user.companyId, name: req.user.companyName || '' };
    const user = await createMongoUser({
      id: id(),
      username: email,
      email,
      passwordHash,
      role,
      status,
      companyName: company.name || req.user.companyName || '',
      companyId: req.user.companyId,
      name: name || email,
      phone,
      note
    });
    res.status(201).json({ member: publicMember(user) });
    return;
  }
  const existing = await findSqlUserByEmail(email);
  if (existing) return res.status(409).json({ error: '邮箱已注册' });
  const user = {
    id: id(),
    companyId: req.user.companyId,
    username: email,
    email,
    passwordHash,
    name: name || email,
    role,
    status,
    phone,
    note,
    lastLoginAt: '',
    createdAt: now,
    updatedAt: now
  };
  await upsertRecord('users', user);
  res.status(201).json({ member: publicMember(user) });
}));

app.put('/api/admin/members/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const target = await memberById(req.user.companyId, req.params.id);
  if (!target) return res.status(404).json({ error: '成员不存在' });
  if (!canManageMember(req.user, target)) return res.status(403).json({ error: '没有权限管理该成员' });
  const role = target.role === 'super_admin'
    ? 'super_admin'
    : normalizeMemberRole(req.body.role ?? target.role);
  const status = normalizeMemberStatus(req.body.status ?? target.status);
  if (role !== target.role && status === 'active') await assertMemberQuota({ companyId: req.user.companyId, role, targetUserId: target.id });
  if (target.id === req.user.id && status === 'disabled') return res.status(400).json({ error: '不能禁用自己' });
  const update = {
    name: String(req.body.name ?? target.name ?? '').trim(),
    username: String(req.body.email ?? target.email ?? '').trim().toLowerCase(),
    email: String(req.body.email ?? target.email ?? '').trim().toLowerCase(),
    role,
    status,
    phone: String(req.body.phone ?? target.phone ?? '').trim(),
    note: String(req.body.note ?? target.note ?? '').trim(),
    updatedAt: nowIso()
  };
  if (!update.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.email)) return res.status(400).json({ error: '请输入有效邮箱' });
  if (useMongoAuth()) {
    const existing = await findMongoUserByEmail(update.email);
    if (existing && existing.id !== target.id) return res.status(409).json({ error: '邮箱已注册' });
    const db = await getMongoDb();
    await db.collection('users').updateOne({ id: target.id, companyId: req.user.companyId }, { $set: update });
    res.json({ member: publicMember({ ...target, ...update }) });
    return;
  }
  const existing = await findSqlUserByEmail(update.email);
  if (existing && existing.id !== target.id) return res.status(409).json({ error: '邮箱已注册' });
  await run(`
    UPDATE ${quoteTable('users')}
    SET ${quoteIdentifier('name')} = ?,
        ${quoteIdentifier('username')} = ?,
        ${quoteIdentifier('email')} = ?,
        ${quoteIdentifier('role')} = ?,
        ${quoteIdentifier('status')} = ?,
        ${quoteIdentifier('phone')} = ?,
        ${quoteIdentifier('note')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [update.name, update.username, update.email, update.role, update.status, update.phone, update.note, update.updatedAt, target.id, req.user.companyId]);
  res.json({ member: publicMember({ ...target, ...update }) });
}));

app.post('/api/admin/members/:id/reset-password', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const target = await memberById(req.user.companyId, req.params.id);
  if (!target) return res.status(404).json({ error: '成员不存在' });
  if (!canManageMember(req.user, target)) return res.status(403).json({ error: '没有权限管理该成员' });
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const passwordHash = await withTimeout(hashPasswordAsync(password), 15000, 'Password hash');
  const updatedAt = nowIso();
  if (useMongoAuth()) {
    const db = await getMongoDb();
    await db.collection('users').updateOne({ id: target.id, companyId: req.user.companyId }, { $set: { passwordHash, updatedAt } });
    res.json({ ok: true });
    return;
  }
  await run(`
    UPDATE ${quoteTable('users')}
    SET ${quoteIdentifier('passwordHash')} = ?, ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [passwordHash, updatedAt, target.id, req.user.companyId]);
  res.json({ ok: true });
}));

async function setMemberStatus(req, res, status) {
  const target = await memberById(req.user.companyId, req.params.id);
  if (!target) return res.status(404).json({ error: '成员不存在' });
  if (!canManageMember(req.user, target)) return res.status(403).json({ error: '没有权限管理该成员' });
  if (target.id === req.user.id && status === 'disabled') return res.status(400).json({ error: '不能禁用自己' });
  if (status === 'active') await assertMemberQuota({ companyId: req.user.companyId, role: target.role, targetUserId: target.id });
  const updatedAt = nowIso();
  if (useMongoAuth()) {
    const db = await getMongoDb();
    await db.collection('users').updateOne({ id: target.id, companyId: req.user.companyId }, { $set: { status, updatedAt } });
    return res.json({ member: publicMember({ ...target, status, updatedAt }) });
  }
  await run(`
    UPDATE ${quoteTable('users')}
    SET ${quoteIdentifier('status')} = ?, ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [status, updatedAt, target.id, req.user.companyId]);
  return res.json({ member: publicMember({ ...target, status, updatedAt }) });
}

app.post('/api/admin/members/:id/enable', requireAuth, requireAdmin, asyncHandler(async (req, res) => setMemberStatus(req, res, 'active')));
app.post('/api/admin/members/:id/disable', requireAuth, requireAdmin, asyncHandler(async (req, res) => setMemberStatus(req, res, 'disabled')));

app.delete('/api/admin/members/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const target = await memberById(req.user.companyId, req.params.id);
  if (!target) return res.status(404).json({ error: '成员不存在' });
  if (!canManageMember(req.user, target)) return res.status(403).json({ error: '没有权限管理该成员' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  if (useMongoAuth()) {
    const db = await getMongoDb();
    await db.collection('users').deleteOne({ id: target.id, companyId: req.user.companyId });
    res.json({ ok: true });
    return;
  }
  await run(`DELETE FROM ${quoteTable('users')} WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?`, [target.id, req.user.companyId]);
  res.json({ ok: true });
}));

function frontendBaseUrl(req) {
  const configured = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '').split(',').map((entry) => entry.trim()).find(Boolean);
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function normalizeInviteRole(value) {
  return String(value || '').toLowerCase() === 'admin' ? 'admin' : 'user';
}

async function invitationByToken(token) {
  if (!token) return null;
  return queryGet(`
    SELECT invitations.*, companies.${quoteIdentifier('name')} AS "companyName"
    FROM ${quoteTable('company_invitations')} invitations
    LEFT JOIN ${quoteTable('companies')} companies
      ON companies.${quoteIdentifier('id')} = invitations.${quoteIdentifier('company_id')}
    WHERE invitations.${quoteIdentifier('token')} = ?
    LIMIT 1
  `, [token]);
}

app.post('/api/invitations', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = normalizeInviteRole(req.body.role);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (useMongoAuth()) {
    const invitation = await createMongoInvitation({
      id: id(),
      companyId: req.user.companyId,
      companyName: req.company?.name || req.user.companyName || '',
      email,
      role,
      token: crypto.randomBytes(32).toString('hex'),
      createdBy: req.user.id,
      expiresAt
    });
    const inviteLink = `${frontendBaseUrl(req)}/invite/${invitation.token}`;
    res.json({ success: true, invitation: { ...invitation, inviteLink } });
    return;
  }
  const invitation = {
    id: id(),
    company_id: req.user.companyId,
    email,
    role,
    token: crypto.randomBytes(32).toString('hex'),
    status: 'pending',
    created_by: req.user.id,
    created_at: now,
    accepted_at: '',
    expires_at: expiresAt
  };
  await upsertRecord('company_invitations', invitation);
  const inviteLink = `${frontendBaseUrl(req)}/invite/${invitation.token}`;
  res.json({ success: true, invitation: { ...invitation, inviteLink } });
}));

app.get('/api/invitations', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (useMongoAuth()) {
    const baseUrl = frontendBaseUrl(req);
    const invitations = await listMongoInvitations(req.user.companyId);
    res.json({ invitations: invitations.map((entry) => ({ ...entry, inviteLink: `${baseUrl}/invite/${entry.token}` })) });
    return;
  }
  const invitations = await queryAll(`
    SELECT invitations.*, users.${quoteIdentifier('email')} AS "createdByEmail"
    FROM ${quoteTable('company_invitations')} invitations
    LEFT JOIN ${quoteTable('users')} users
      ON users.${quoteIdentifier('id')} = invitations.${quoteIdentifier('created_by')}
    WHERE invitations.${quoteIdentifier('company_id')} = ?
    ORDER BY invitations.${quoteIdentifier('created_at')} DESC
  `, [req.user.companyId]);
  const baseUrl = frontendBaseUrl(req);
  res.json({ invitations: invitations.map((entry) => ({ ...entry, inviteLink: `${baseUrl}/invite/${entry.token}` })) });
}));

app.get('/api/invitations/:token', asyncHandler(async (req, res) => {
  const token = String(req.params.token || '').trim();
  const invitation = useMongoAuth()
    ? await findMongoInvitationByToken(token)
    : await invitationByToken(token);
  if (!invitation) {
    res.status(404).json({ error: 'Invitation not found.' });
    return;
  }
  const expiresAt = invitation.expires_at || invitation.expiresAt || '';
  const expired = invitation.status === 'pending' && expiresAt && new Date(expiresAt).getTime() < Date.now();
  if (expired) {
    if (useMongoAuth()) await expireMongoInvitation(invitation.id);
    else await run(`UPDATE ${quoteTable('company_invitations')} SET ${quoteIdentifier('status')} = 'expired' WHERE ${quoteIdentifier('id')} = ?`, [invitation.id]);
    invitation.status = 'expired';
  }
  res.json({
    invitation: {
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      companyName: invitation.companyName || '',
      expiresAt
    }
  });
}));

app.post('/api/invitations/accept', asyncHandler(async (req, res) => {
  const token = String(req.body.token || '').trim();
  const invitation = useMongoAuth()
    ? await findMongoInvitationByToken(token)
    : await invitationByToken(token);
  if (!invitation) {
    res.status(404).json({ error: 'Invitation not found.' });
    return;
  }
  if (invitation.status !== 'pending') {
    res.status(409).json({ error: `Invitation is ${invitation.status}.` });
    return;
  }
  const expiresAt = invitation.expires_at || invitation.expiresAt || '';
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    if (useMongoAuth()) await expireMongoInvitation(invitation.id);
    else await run(`UPDATE ${quoteTable('company_invitations')} SET ${quoteIdentifier('status')} = 'expired' WHERE ${quoteIdentifier('id')} = ?`, [invitation.id]);
    res.status(410).json({ error: 'Invitation has expired.' });
    return;
  }

  const now = nowIso();
  if (useMongoAuth()) {
    let existingUser = await findMongoUserByLogin(invitation.email);
    let passwordHash = existingUser?.passwordHash || '';
    const password = String(req.body.password || '');
    if (existingUser) {
      const payload = optionalAuthPayload(req);
      const authenticatedSameUser = payload?.userId === existingUser.id && String(payload.email || '').toLowerCase() === String(existingUser.email || '').toLowerCase();
      const passwordMatches = password && await verifyPasswordAsync(password, existingUser.passwordHash);
      if (!authenticatedSameUser && !passwordMatches) {
        res.status(401).json({ error: '该邮箱已注册，请先登录该账号或输入正确密码后接受邀请。' });
        return;
      }
    } else {
      if (password.length < 6) {
        res.status(400).json({ error: 'Password must be at least 6 characters for a new account.' });
        return;
      }
      passwordHash = await withTimeout(hashPasswordAsync(password), 15000, 'Password hash');
    }
    const user = await acceptMongoInvitation({
      invitation,
      userId: id(),
      username: String(req.body.username || req.body.name || invitation.email).trim(),
      passwordHash
    });
    const company = await findMongoCompanyById(user.companyId);
    res.json({ success: true, message: 'Invitation accepted.', ...authResponse({ ...user, authStore: 'mongo' }, company || { id: user.companyId, name: user.companyName || invitation.companyName || '' }) });
    return;
  }
  let user = await queryGet(`SELECT * FROM ${quoteTable('users')} WHERE LOWER(${quoteIdentifier('email')}) = ? LIMIT 1`, [String(invitation.email || '').toLowerCase()]);
  if (!user) {
    const password = String(req.body.password || '');
    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters for a new account.' });
      return;
    }
    user = {
      id: id(),
      companyId: invitation.company_id,
      email: invitation.email,
      passwordHash: await withTimeout(hashPasswordAsync(password), 15000, 'Password hash'),
      name: String(req.body.username || req.body.name || invitation.email).trim(),
      role: invitation.role,
      createdAt: now,
      updatedAt: now
    };
    await upsertRecord('users', user);
  } else {
    const password = String(req.body.password || '');
    const payload = optionalAuthPayload(req);
    const authenticatedSameUser = payload?.userId === user.id && String(payload.email || '').toLowerCase() === String(user.email || '').toLowerCase();
    const passwordMatches = password && await verifyPasswordAsync(password, user.passwordHash);
    if (!authenticatedSameUser && !passwordMatches) {
      res.status(401).json({ error: '该邮箱已注册，请先登录该账号或输入正确密码后接受邀请。' });
      return;
    }
    await run(`
      UPDATE ${quoteTable('users')}
      SET ${quoteIdentifier('companyId')} = ?,
          ${quoteIdentifier('role')} = ?,
          ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('id')} = ?
    `, [invitation.company_id, invitation.role, now, user.id]);
    user = { ...user, companyId: invitation.company_id, role: invitation.role, updatedAt: now };
  }

  await run(`
    UPDATE ${quoteTable('company_invitations')}
    SET ${quoteIdentifier('status')} = 'accepted',
        ${quoteIdentifier('accepted_at')} = ?
    WHERE ${quoteIdentifier('id')} = ?
  `, [now, invitation.id]);

  const company = await queryGet(`SELECT * FROM ${quoteTable('companies')} WHERE ${quoteIdentifier('id')} = ? LIMIT 1`, [invitation.company_id]);
  res.json({ success: true, message: 'Invitation accepted.', ...authResponse(user, company || { id: invitation.company_id, name: invitation.companyName || '' }) });
}));

app.get('/api/users/search', requireAccountAuth, asyncHandler(async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) {
    res.json({ users: [] });
    return;
  }
  const users = await searchMongoUsers(keyword, req.accountUser.id);
  res.json({ users });
}));

app.post('/api/account-connections/request', requireAccountAuth, asyncHandler(async (req, res) => {
  const targetUserId = String(req.body.targetUserId || '').trim();
  const message = String(req.body.message || '').trim();
  if (!targetUserId) return res.status(400).json({ error: '请选择要连接的账户' });
  const request = await createConnectionRequest({
    id: id(),
    requesterUserId: req.accountUser.id,
    targetUserId,
    message
  });
  res.json({ success: true, request });
}));

app.get('/api/account-connections/sent', requireAccountAuth, asyncHandler(async (req, res) => {
  const requests = await listSentConnections(req.accountUser.id);
  res.json({ requests });
}));

app.get('/api/account-connections/received', requireAccountAuth, asyncHandler(async (req, res) => {
  const requests = await listReceivedConnections(req.accountUser.id);
  res.json({ requests });
}));

app.post('/api/account-connections/:id/approve', requireAccountAuth, asyncHandler(async (req, res) => {
  const request = await decideConnection(req.params.id, req.accountUser.id, 'approved');
  res.json({ success: true, request });
}));

app.post('/api/account-connections/:id/reject', requireAccountAuth, asyncHandler(async (req, res) => {
  const request = await decideConnection(req.params.id, req.accountUser.id, 'rejected');
  res.json({ success: true, request });
}));

app.use('/api/ai-invoice', requireAuth, aiInvoiceRoutes);

app.post('/api/sync/push', requireAuth, asyncHandler(async (req, res) => {
  const deviceId = req.body.deviceId || 'unknown';
  const companyId = req.user.companyId;
  const changes = req.body.changes || {};
  const counts = countSyncRecords(changes);
  const invoiceCount = Number(counts.invoices || 0);
  console.log('[SYNC PUSH] start:', { companyId, deviceId, backend: syncBackend, invoiceCount, counts });
  if (useMongoSync()) {
    try {
      const result = await mongoSyncPush({ companyId, deviceId, changes });
      const results = Array.isArray(result.results) ? result.results : [];
      console.log('[SYNC PUSH] finish:', {
        companyId,
        backend: 'mongodb',
        resultCount: results.length,
        resultStatuses: countSyncResultStatuses(results)
      });
      res.json(result);
      return;
    } catch (error) {
      console.error('[SYNC PUSH] error:', { companyId, backend: 'mongodb', message: error.message, stack: error.stack });
      throw error;
    }
  }
  const results = [];
  const syncContext = { changes, rejectedInvoiceIds: new Set(), integritySavedInvoiceIds: new Set() };

  try {
    await withTransaction(async (client) => {
      for (const table of syncTables) {
        const records = Array.isArray(changes[table]) ? changes[table] : [];
        for (const record of records) {
          if ((table === 'invoice_items' || table === 'invoice_discounts') && syncContext.rejectedInvoiceIds.has(record.invoiceId)) {
            results.push({ table, localId: record.localId || record.id, serverId: '', status: 'skipped_duplicate_invoice', record: null });
            continue;
          }
          if ((table === 'invoice_items' || table === 'invoice_discounts') && syncContext.integritySavedInvoiceIds.has(record.invoiceId)) {
            results.push({ table, localId: record.localId || record.id, serverId: record.serverId || record.id || '', status: 'skipped_integrity_generated', record: null });
            continue;
          }
          if (table === 'price_history') {
            const relatedItem = (changes.invoice_items || []).find((item) => (item.id && item.id === record.invoiceItemId) || (item.localId && item.localId === record.invoiceItemId) || (item.serverId && item.serverId === record.invoiceItemId));
            if (relatedItem && syncContext.rejectedInvoiceIds.has(relatedItem.invoiceId)) {
              results.push({ table, localId: record.localId || record.id, serverId: '', status: 'skipped_duplicate_invoice', record: null });
              continue;
            }
            if (relatedItem && syncContext.integritySavedInvoiceIds.has(relatedItem.invoiceId)) {
              results.push({ table, localId: record.localId || record.id, serverId: record.serverId || record.id || '', status: 'skipped_integrity_generated', record: null });
              continue;
            }
          }
          results.push(await pushOne(table, record, deviceId, companyId, client, syncContext));
        }
      }
    });
  } catch (error) {
    console.error('[SYNC PUSH] error:', { companyId, backend: usingPostgres ? 'postgres' : 'sqlite', message: error.message, stack: error.stack });
    throw error;
  }

  console.log('[SYNC PUSH] finish:', {
    companyId,
    backend: usingPostgres ? 'postgres' : 'sqlite',
    resultCount: results.length,
    resultStatuses: countSyncResultStatuses(results)
  });
  res.json({ ok: true, companyId, serverTime: nowIso(), results });
}));

app.get('/api/sync/pull', requireAuth, asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const since = req.query.since || '';
  console.log('[SYNC PULL] start:', { companyId, since, backend: syncBackend });
  if (useMongoSync()) {
    try {
      await mirrorSqlSyncDataToMongo(companyId, 'sync-pull', since);
      const result = await mongoSyncPull({ companyId, since });
      console.log('[SYNC PULL] finish:', { companyId, backend: 'mongodb', since, counts: countSyncRecords(result.data || {}) });
      res.json(result);
      return;
    } catch (error) {
      console.error('[SYNC PULL] error:', { companyId, backend: 'mongodb', since, message: error.message, stack: error.stack });
      throw error;
    }
  }
  try {
    const data = await allSyncData(companyId, since);
    console.log('[SYNC PULL] finish:', { companyId, backend: usingPostgres ? 'postgres' : 'sqlite', since, counts: countSyncRecords(data) });
    res.json({ companyId, serverTime: nowIso(), data });
  } catch (error) {
    console.error('[SYNC PULL] error:', { companyId, backend: usingPostgres ? 'postgres' : 'sqlite', since, message: error.message, stack: error.stack });
    throw error;
  }
}));

app.get('/api/sync/status', requireAuth, asyncHandler(async (req, res) => {
  if (useMongoSync()) {
    res.json(await mongoSyncStatus(req.user.companyId));
    return;
  }
  const counts = {};
  for (const table of syncTables) {
    const row = await queryGet(`
      SELECT COUNT(*) AS "count"
      FROM ${quoteTable(table)}
      WHERE ${quoteIdentifier('companyId')} = ?
        AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [req.user.companyId]);
    counts[table] = Number(row?.count || 0);
  }
  res.json({ ok: true, enabled: true, backend: usingPostgres ? 'postgres' : 'sqlite', companyId: req.user.companyId, counts, serverTime: nowIso() });
}));

app.get('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  res.json(await queryAll(`
    SELECT * FROM ${quoteTable('suppliers')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND COALESCE(${quoteIdentifier('status')}, 'active') != 'merged'
    ORDER BY ${quoteIdentifier('name')} ASC
  `, [req.user.companyId]));
}));

app.post('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  const record = await findOrCreateSupplierV2(req.body.displayName || req.body.name, req.body.deviceId || 'legacy-api', req.user.companyId);
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

app.post('/api/suppliers/:id/merge', requireAuth, asyncHandler(async (req, res) => {
  const source = await getByAnyId('suppliers', req.params.id, req.user.companyId);
  const target = await getByAnyId('suppliers', req.body.targetSupplierId, req.user.companyId);
  if (!source || !target) return res.status(404).json({ error: 'Supplier not found' });
  if ((source.serverId || source.id) === (target.serverId || target.id)) return res.status(400).json({ error: '不能合并到同一个供应商' });

  const timestamp = nowIso();
  const sourceIds = [source.id, source.serverId, source.localId].filter(Boolean);
  const targetId = target.serverId || target.id;
  const sourcePlaceholders = sourceIds.map(() => '?').join(', ');
  const aliases = mergeAliases(
    target.aliases,
    source.aliases,
    supplierAliasesFromName(source.supplierDisplayName || source.displayName || source.name || ''),
    supplierAliasesFromName(target.supplierDisplayName || target.displayName || target.name || ''),
    source.supplierNameChinese,
    source.supplierNameEnglish,
    target.supplierNameChinese,
    target.supplierNameEnglish
  );
  const templateIds = mergeAliases(target.templateIds, source.templateIds);
  const mergedDisplayName = displaySupplierName(target, source.supplierDisplayName || source.displayName || source.name || '');
  const mergedParts = splitSupplierNameParts(mergedDisplayName);
  const updatedTarget = prepareRecord('suppliers', {
    ...target,
    supplierNameChinese: target.supplierNameChinese || source.supplierNameChinese || mergedParts.supplierNameChinese,
    supplierNameEnglish: target.supplierNameEnglish || source.supplierNameEnglish || mergedParts.supplierNameEnglish,
    supplierDisplayName: mergedDisplayName,
    displayName: mergedDisplayName,
    aliases,
    templateIds,
    updatedAt: timestamp
  }, req.body.deviceId || 'merge-api', req.user.companyId);

  await withTransaction(async (client) => {
    await upsertRecord('suppliers', updatedTarget, client);
    for (const table of ['invoices', 'invoice_items', 'invoice_discounts', 'gift_allocation_rules', 'price_history', 'product_aliases', 'product_learning_rules', 'recognition_corrections', 'price_anomalies', 'supplier_templates']) {
      await run(`
        UPDATE ${quoteTable(table)}
        SET ${quoteIdentifier('supplierId')} = ?, ${quoteIdentifier('updatedAt')} = ?
        WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('supplierId')} IN (${sourcePlaceholders})
      `, [targetId, timestamp, req.user.companyId, ...sourceIds], client);
    }
    await run(`
      UPDATE ${quoteTable('suppliers')}
      SET ${quoteIdentifier('status')} = 'merged',
          ${quoteIdentifier('suspectedDuplicateOf')} = ?,
          ${quoteIdentifier('deletedAt')} = ?,
          ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('id')} IN (${sourcePlaceholders})
    `, [targetId, timestamp, timestamp, req.user.companyId, ...sourceIds], client);

    const templates = await queryAll(`
      SELECT * FROM ${quoteTable('supplier_templates')}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('supplierId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
      ORDER BY ${quoteIdentifier('updatedAt')} DESC
    `, [req.user.companyId, targetId], client);
    const [mainTemplate, ...duplicates] = templates;
    for (const duplicate of duplicates) {
      await run(`
        UPDATE ${quoteTable('supplier_templates')}
        SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
        WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('id')} = ?
      `, [timestamp, timestamp, req.user.companyId, duplicate.id], client);
    }
    if (mainTemplate) {
      await run(`
        UPDATE ${quoteTable('suppliers')}
        SET ${quoteIdentifier('templateIds')} = ?, ${quoteIdentifier('updatedAt')} = ?
        WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('id')} = ?
      `, [JSON.stringify([mainTemplate.id]), timestamp, req.user.companyId, targetId], client);
    }
  });

  res.json({ success: true, sourceSupplierId: source.serverId || source.id, targetSupplierId: targetId });
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
  await withTransaction(async (client) => {
    await upsertRecord('supplier_templates', record, client);
    await run(`
      UPDATE ${quoteTable('supplier_templates')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ?
        AND ${quoteIdentifier('supplierId')} = ?
        AND ${quoteIdentifier('id')} != ?
        AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [nowIso(), nowIso(), req.user.companyId, req.params.id, record.id], client);
  });
  res.json(record);
}));

async function supplierInvoiceHistoryRows(companyId, supplierId, filters = {}) {
  const supplier = await getByAnyId('suppliers', supplierId, companyId);
  const resolvedSupplierId = supplier?.serverId || supplier?.id || supplierId;
  const rows = await queryAll(`
    SELECT invoices.*, COALESCE(suppliers.${quoteIdentifier('supplierDisplayName')}, suppliers.${quoteIdentifier('displayName')}, suppliers.${quoteIdentifier('name')}) AS "supplierName"
    FROM ${quoteTable('invoices')} invoices
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoices.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoices.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoices.${quoteIdentifier('supplierId')})
    WHERE invoices.${quoteIdentifier('companyId')} = ?
      AND invoices.${quoteIdentifier('deletedAt')} IS NULL
      AND (invoices.${quoteIdentifier('supplierId')} = ? OR invoices.${quoteIdentifier('supplierId')} = ?)
    ORDER BY invoices.${quoteIdentifier('invoiceDate')} DESC, invoices.${quoteIdentifier('createdAt')} DESC
  `, [companyId, supplierId, resolvedSupplierId]);
  const withDetails = [];
  for (const invoice of rows) {
    const invoiceIds = [invoice.id, invoice.serverId, invoice.localId].filter(Boolean);
    const placeholders = invoiceIds.map(() => '?').join(', ');
    const items = await queryAll(`
      SELECT * FROM ${quoteTable('invoice_items')}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${placeholders}) AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [companyId, ...invoiceIds]);
    const discounts = await queryAll(`
      SELECT * FROM ${quoteTable('invoice_discounts')}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${placeholders}) AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [companyId, ...invoiceIds]);
    withDetails.push({
      ...invoice,
      itemCount: items.length,
      hasGifts: items.some((item) => Number(item.isFreeItem || 0) || Number(item.freeQty || 0) > 0) ? 1 : 0,
      hasDiscounts: discounts.length ? 1 : 0,
      hasWarnings: invoice.recognitionWarnings || invoice.duplicateStatus === 'possible' ? 1 : 0,
      isMultipage: invoice.status === 'recognized-multipage' || (invoice.ocrText || '').includes('--- page ---') ? 1 : 0,
      discounts
    });
  }
  return withDetails.filter((invoice) => {
    if (filters.dateFrom && String(invoice.invoiceDate || '') < filters.dateFrom) return false;
    if (filters.dateTo && String(invoice.invoiceDate || '') > filters.dateTo) return false;
    if (filters.invoiceNo && !String(invoice.invoiceNo || '').toLowerCase().includes(String(filters.invoiceNo).toLowerCase())) return false;
    if (filters.totalAmount && Math.abs(Number(invoice.totalAmount || 0) - Number(filters.totalAmount)) >= 0.01) return false;
    if (filters.amountMin && Number(invoice.totalAmount || 0) < Number(filters.amountMin)) return false;
    if (filters.amountMax && Number(invoice.totalAmount || 0) > Number(filters.amountMax)) return false;
    if (filters.hasGifts === 'true' && !invoice.hasGifts) return false;
    if (filters.hasDiscounts === 'true' && !invoice.hasDiscounts) return false;
    if (filters.hasWarnings === 'true' && !invoice.hasWarnings) return false;
    if (filters.isMultipage === 'true' && !invoice.isMultipage) return false;
    return true;
  });
}

function rowsToExcelTsv(header, rows) {
  const escapeCell = (value) => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  return [header.map(escapeCell).join('\t'), ...rows.map((row) => header.map((key) => escapeCell(row[key])).join('\t'))].join('\n');
}

app.get('/api/suppliers/:id/invoices', requireAuth, asyncHandler(async (req, res) => {
  res.json(await supplierInvoiceHistoryRows(req.user.companyId, req.params.id, req.query));
}));

app.get('/api/suppliers/:id/invoices.csv', requireAuth, asyncHandler(async (req, res) => {
  const rows = await supplierInvoiceHistoryRows(req.user.companyId, req.params.id, req.query);
  const header = ['id', 'supplierName', 'invoiceNo', 'invoiceDate', 'totalAmount', 'itemCount', 'hasGifts', 'hasDiscounts', 'hasWarnings', 'isMultipage', 'duplicateStatus', 'recognitionSource'];
  const csv = [rowToCsv(header), ...rows.map((row) => rowToCsv(header.map((key) => row[key])))].join('\n');
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`SupplierInvoiceHistory-${today()}.csv`);
  res.send(`\uFEFF${csv}`);
}));

app.get('/api/suppliers/:id/invoices.xls', requireAuth, asyncHandler(async (req, res) => {
  const rows = await supplierInvoiceHistoryRows(req.user.companyId, req.params.id, req.query);
  const header = ['id', 'supplierName', 'invoiceNo', 'invoiceDate', 'totalAmount', 'itemCount', 'hasGifts', 'hasDiscounts', 'hasWarnings', 'isMultipage', 'duplicateStatus', 'recognitionSource'];
  res.header('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.attachment(`SupplierInvoiceHistory-${today()}.xls`);
  res.send(`\uFEFF${rowsToExcelTsv(header, rows)}`);
}));

app.get('/api/invoices', requireAuth, asyncHandler(async (req, res) => {
  if (useMongoSync()) await mirrorSqlSyncDataToMongo(req.user.companyId, 'invoice-list-query');
  const invoices = await invoiceWithSupplierRows(req.user.companyId);
  console.log('[invoices] list query:', { companyId: req.user.companyId, backend: usingPostgres ? 'postgres/sql' : 'sqlite/sql', count: invoices.length });
  res.json(invoices);
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

app.post('/api/learning/confirm-invoice', requireAuth, asyncHandler(async (req, res) => {
  const result = await saveInvoicePayloadWithLearning(req.body.finalInvoice || req.body, req.user, {
    beforeResult: req.body.beforeResult || null,
    invoiceTemplateId: req.body.invoiceTemplateId || req.body.templateId || '',
    learnTemplate: true
  });
  const finalPayload = req.body.finalInvoice || req.body;
  if (result.duplicate && !finalPayload.forceSave && !finalPayload.force) {
    res.status(409).json(result);
    return;
  }
  res.json({ success: true, ...result });
}));

app.post('/api/invoices', requireAuth, asyncHandler(async (req, res) => {
  const result = await saveInvoiceWithIntegrityCheck(req.body, {
    user: req.user,
    learnTemplate: false,
    mirrorReason: 'api-invoices-save'
  });
  if (result.duplicate && !req.body.forceSave && !req.body.force) {
    res.status(409).json(result);
    return;
  }
  res.json(result);
}));

app.post('/api/invoices-legacy-disabled', requireAuth, asyncHandler(async (req, res) => {
  res.status(410).json({ error: 'Legacy invoice save path disabled. Use POST /api/invoices.' });
  return;
  const deviceId = req.body.deviceId || 'legacy-api';
  const supplier = req.body.supplierId
    ? await getByAnyId('suppliers', req.body.supplierId, req.user.companyId)
    : await findOrCreateSupplierV2(req.body.supplierName, deviceId, req.user.companyId);
  const now = nowIso();
  const { productItems, discountItems } = splitInvoiceRows(Array.isArray(req.body.items) ? req.body.items : []);
  const items = applyDiscountAllocation(applyGiftAccounting(productItems), discountItems);
  const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  const totalAmount = Number(req.body.totalAmount || 0) > 0 ? Number(req.body.totalAmount) : itemTotal;
  console.log('[invoice-save] api-invoices start:', {
    companyId: req.user.companyId,
    supplierName: req.body.supplierName || '',
    invoiceNo: req.body.invoiceNo || '',
    invoiceDate: req.body.invoiceDate || '',
    totalAmount,
    itemCount: items.length
  });
  const duplicateCheck = await checkInvoiceDuplicateBeforeSave({
    companyId: req.user.companyId,
    supplier,
    payload: req.body,
    totalAmount,
    items,
    excludeInvoiceId: req.body.serverId || req.body.id || '',
    batchId: req.body.batchId || req.body.scanBatchId || ''
  });
  const forceSave = Boolean(req.body.forceSave || req.body.force);
  if (duplicateCheck.isDuplicate && !forceSave) {
    console.warn('[invoice-save] api-invoices duplicate blocked:', {
      companyId: req.user.companyId,
      invoiceNo: req.body.invoiceNo || '',
      totalAmount,
      duplicateCheck
    });
    res.status(409).json(duplicateBlockedResponse(duplicateCheck));
    return;
  }
  const invoice = await prepareRecordWithReferences('invoices', {
    ...req.body,
    supplierId: supplier?.serverId || supplier?.id || '',
    totalAmount,
    imageHash: req.body.imageHash || '',
    ocrTextHash: req.body.ocrTextHash || sha256Text(req.body.ocrText || ''),
    duplicateStatus: duplicateCheck.isDuplicate ? 'duplicate' : (req.body.duplicateStatus || duplicateCheck.duplicateStatus || 'none'),
    duplicateOfInvoiceId: duplicateCheck.isDuplicate ? (duplicateCheck.duplicateOfInvoiceId || duplicateCheck.duplicateInvoiceId || '') : (req.body.duplicateOfInvoiceId || ''),
    invoiceGroupKey: req.body.invoiceGroupKey || buildInvoiceGroupKey({ supplierName: displaySupplierName(supplier, req.body.supplierName || ''), invoiceNo: req.body.invoiceNo || '', totalAmount }),
    updatedAt: now
  }, deviceId, req.user.companyId);

  await withTransaction(async (client) => {
    await upsertRecord('invoices', invoice, client);
    const existingItemRows = await queryAll(`
      SELECT * FROM ${quoteTable('invoice_items')}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
    `, [req.user.companyId, invoice.serverId], client);
    await softDeletePriceHistory({
      companyId: req.user.companyId,
      invoiceIds: [invoice.serverId, invoice.id, invoice.localId],
      itemIds: existingItemRows.flatMap(invoiceIdentityIds),
      deletedAt: now,
      client
    });
    await run(`
      UPDATE ${quoteTable('invoice_items')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
    `, [now, now, req.user.companyId, invoice.serverId], client);
    await run(`
      UPDATE ${quoteTable('invoice_discounts')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} = ?
    `, [now, now, req.user.companyId, invoice.serverId], client);
    const itemRecords = [];
    for (const item of items.filter((entry) => (entry.productNameOriginal || '').trim())) {
      const record = await prepareRecordWithReferences('invoice_items', { ...item, invoiceId: invoice.serverId, supplierId: invoice.supplierId, invoiceDate: invoice.invoiceDate, updatedAt: now }, deviceId, req.user.companyId, client);
      await upsertRecord('invoice_items', record, client);
      itemRecords.push(record);
    }
    await saveInvoiceDiscounts({ discountItems, productItemRecords: itemRecords, invoice, supplier, deviceId, companyId: req.user.companyId, client });
  });
  console.log('[invoice-save] api-invoices saved:', {
    companyId: req.user.companyId,
    invoiceId: invoice.serverId || invoice.id,
    supplierId: invoice.supplierId,
    invoiceNo: invoice.invoiceNo,
    totalAmount: invoice.totalAmount,
    status: invoice.status
  });
  await mirrorSqlSyncDataToMongo(req.user.companyId, 'api-invoices-save');
  res.json({ ...invoice, supplierName: displaySupplierName(supplier, req.body.supplierName || '') || '未命名供应商', duplicateCheck });
}));

app.get('/api/invoices/:id', requireAuth, asyncHandler(async (req, res) => {
  const invoice = await queryGet(`
    SELECT invoices.*, COALESCE(suppliers.${quoteIdentifier('supplierDisplayName')}, suppliers.${quoteIdentifier('displayName')}, suppliers.${quoteIdentifier('name')}) AS "supplierName"
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
  const discounts = await queryAll(`
    SELECT * FROM ${quoteTable('invoice_discounts')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${placeholders}) AND ${quoteIdentifier('deletedAt')} IS NULL
    ORDER BY ${quoteIdentifier('createdAt')} ASC
  `, [req.user.companyId, ...invoiceIds]);
  res.json({ invoice, items, discounts });
}));

app.post('/api/invoices/:id/image', requireAuth, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No invoice image uploaded' });
    return;
  }
  const imagePath = `/uploads/${req.file.filename}`;
  const updatedAt = nowIso();
  const result = await run(`
    UPDATE ${quoteTable('invoices')}
    SET ${quoteIdentifier('imagePath')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ?
      AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
      AND ${quoteIdentifier('deletedAt')} IS NULL
  `, [imagePath, updatedAt, req.user.companyId, req.params.id, req.params.id, req.params.id]);
  const changedRows = result?.changes ?? result?.rowCount ?? 0;
  if (changedRows === 0) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  res.json({
    success: true,
    imagePath,
    imageSize: req.file.size || 0,
    imageMimeType: req.file.mimetype || '',
    originalName: req.file.originalname || ''
  });
}));

app.post('/api/invoices/:id/merge', requireAuth, asyncHandler(async (req, res) => {
  const mergeIds = Array.isArray(req.body.mergeIds) ? req.body.mergeIds.filter(Boolean) : [];
  if (mergeIds.length === 0) return res.status(400).json({ error: '请选择要合并的发票' });

  const master = await queryGet(`
    SELECT * FROM ${quoteTable('invoices')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
      AND ${quoteIdentifier('deletedAt')} IS NULL
    LIMIT 1
  `, [req.user.companyId, req.params.id, req.params.id, req.params.id]);
  if (!master) return res.status(404).json({ error: 'Invoice not found' });

  const mergeRows = [];
  for (const mergeId of mergeIds) {
    const row = await queryGet(`
      SELECT * FROM ${quoteTable('invoices')}
      WHERE ${quoteIdentifier('companyId')} = ?
        AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
        AND ${quoteIdentifier('deletedAt')} IS NULL
      LIMIT 1
    `, [req.user.companyId, mergeId, mergeId, mergeId]);
    if (row && row.id !== master.id) mergeRows.push(row);
  }
  if (mergeRows.length === 0) return res.status(400).json({ error: '当前批次没有可合并的发票' });

  const allInvoices = [master, ...mergeRows];
  const allIds = [...new Set(allInvoices.flatMap((invoice) => [invoice.id, invoice.serverId, invoice.localId].filter(Boolean)))];
  const childIds = [...new Set(mergeRows.flatMap((invoice) => [invoice.id, invoice.serverId, invoice.localId].filter(Boolean)))];
  const childPlaceholders = childIds.map(() => '?').join(', ');
  const mergedInvoiceIds = [...new Set([
    ...parseAliases(master.mergedInvoiceIds),
    ...mergeRows.map((invoice) => invoice.serverId || invoice.id)
  ])];
  const supplierConflict = new Set(allInvoices.map((invoice) => invoice.supplierId || '')).size > 1;
  const invoiceNoConflict = new Set(allInvoices.map((invoice) => invoice.invoiceNo || '')).size > 1;
  const invoiceDateConflict = new Set(allInvoices.map((invoice) => invoice.invoiceDate || '')).size > 1;
  const sameInvoiceIdentity = !supplierConflict && !invoiceNoConflict && !invoiceDateConflict;
  const totalAmount = allInvoices.reduce((sum, invoice) => sum + Number(invoice.totalAmount || 0), 0);
  const subtotal = allInvoices.reduce((sum, invoice) => sum + Number(invoice.subtotal || invoice.totalAmount || 0), 0);
  const tax = allInvoices.reduce((sum, invoice) => sum + Number(invoice.tax || 0), 0);
  const amountConflict = new Set(allInvoices.map((invoice) => Number(invoice.totalAmount || 0).toFixed(2))).size > 1;
  const warnings = [
    supplierConflict ? '供应商不同' : '',
    invoiceNoConflict ? '发票号不同' : '',
    amountConflict && !sameInvoiceIdentity ? '金额不同' : ''
  ].filter(Boolean);
  const timestamp = nowIso();

  await withTransaction(async (client) => {
    await run(`
      UPDATE ${quoteTable('invoice_items')}
      SET ${quoteIdentifier('invoiceId')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${childPlaceholders})
    `, [master.serverId || master.id, timestamp, req.user.companyId, ...childIds], client);
    await run(`
      UPDATE ${quoteTable('invoice_discounts')}
      SET ${quoteIdentifier('invoiceId')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${childPlaceholders})
    `, [master.serverId || master.id, timestamp, req.user.companyId, ...childIds], client);
    await run(`
      UPDATE ${quoteTable('invoices')}
      SET ${quoteIdentifier('status')} = 'merged',
          ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('id')} IN (${childPlaceholders})
    `, [timestamp, req.user.companyId, ...childIds], client);
    await run(`
      UPDATE ${quoteTable('invoices')}
      SET ${quoteIdentifier('pageCount')} = ?,
          ${quoteIdentifier('isMergedInvoice')} = 1,
          ${quoteIdentifier('isMultiPage')} = 1,
          ${quoteIdentifier('mergedInvoiceIds')} = ?,
          ${quoteIdentifier('subtotal')} = ?,
          ${quoteIdentifier('tax')} = ?,
          ${quoteIdentifier('totalAmount')} = ?,
          ${quoteIdentifier('recognitionWarnings')} = ?,
          ${quoteIdentifier('status')} = 'saved',
          ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('id')} = ?
    `, [
      allInvoices.length,
      JSON.stringify(mergedInvoiceIds),
      subtotal,
      tax,
      totalAmount,
      warnings.length ? `人工合并提示：${warnings.join('、')}` : (master.recognitionWarnings || ''),
      timestamp,
      req.user.companyId,
      master.id
    ], client);
  });

  res.json({
    success: true,
    invoiceId: master.serverId || master.id,
    mergedInvoiceIds,
    pageCount: allInvoices.length,
    totalAmount,
    warnings,
    message: '合并成功'
  });
}));

app.delete('/api/invoices/:id', requireAuth, asyncHandler(async (req, res) => {
  const deletedAt = nowIso();
  const invoice = await queryGet(`
    SELECT * FROM ${quoteTable('invoices')}
    WHERE ${quoteIdentifier('companyId')} = ? AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
    LIMIT 1
  `, [req.user.companyId, req.params.id, req.params.id, req.params.id]);
  const invoiceIds = invoiceIdentityIds(invoice || { id: req.params.id });
  const placeholders = invoiceIds.map(() => '?').join(', ');
  const itemRows = invoiceIds.length ? await queryAll(`
    SELECT * FROM ${quoteTable('invoice_items')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${placeholders})
  `, [req.user.companyId, ...invoiceIds]) : [];
  const itemIds = itemRows.flatMap(invoiceIdentityIds);
  await run(`
    UPDATE ${quoteTable('invoices')}
    SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ? AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
  `, [deletedAt, deletedAt, req.user.companyId, req.params.id, req.params.id, req.params.id]);
  if (invoiceIds.length) {
    await run(`
      UPDATE ${quoteTable('invoice_items')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${placeholders})
    `, [deletedAt, deletedAt, req.user.companyId, ...invoiceIds]);
    await run(`
      UPDATE ${quoteTable('invoice_discounts')}
      SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceId')} IN (${placeholders})
    `, [deletedAt, deletedAt, req.user.companyId, ...invoiceIds]);
  }
  if (itemIds.length) {
    await run(`
      UPDATE ${quoteTable('price_history')}
      SET ${quoteIdentifier('deletedAt')} = ?,
          ${quoteIdentifier('updatedAt')} = ?,
          ${quoteIdentifier('status')} = 'deleted',
          ${quoteIdentifier('syncStatus')} = 'deleted'
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceItemId')} IN (${itemIds.map(() => '?').join(', ')})
    `, [deletedAt, deletedAt, req.user.companyId, ...itemIds]);
  }
  if (invoice?.invoiceNo) {
    await run(`
      UPDATE ${quoteTable('price_history')}
      SET ${quoteIdentifier('deletedAt')} = ?,
          ${quoteIdentifier('updatedAt')} = ?,
          ${quoteIdentifier('status')} = 'deleted',
          ${quoteIdentifier('syncStatus')} = 'deleted'
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('invoiceNo')} = ? AND ${quoteIdentifier('supplierId')} = ?
    `, [deletedAt, deletedAt, req.user.companyId, invoice.invoiceNo, invoice.supplierId || '']);
  }
  if (invoice?.batchId) {
    const activeInvoices = await queryAll(`
      SELECT * FROM ${quoteTable('invoices')}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('batchId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [req.user.companyId, invoice.batchId]);
    if (activeInvoices.length === 0) {
      await run(`
        UPDATE ${quoteTable('purchase_batches')}
        SET ${quoteIdentifier('deletedAt')} = ?, ${quoteIdentifier('updatedAt')} = ?
        WHERE ${quoteIdentifier('companyId')} = ? AND (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
      `, [deletedAt, deletedAt, req.user.companyId, invoice.batchId, invoice.batchId, invoice.batchId]);
    }
  }
  res.json({ ok: true });
}));

app.get('/api/products/search', requireAuth, asyncHandler(async (req, res) => {
  const q = normalizeProductNameAdvanced(String(req.query.q || '').trim());
  if (!q) return res.json([]);
  const aliases = await queryAll(`
    SELECT * FROM ${quoteTable('product_aliases')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
  `, [req.user.companyId]);
  const aliasProductIds = new Set(aliases
    .filter((alias) => `${normalizeProductNameAdvanced(alias.aliasName || alias.rawName || alias.keyword)} ${normalizeProductNameAdvanced(alias.normalizedAlias || '')} ${normalizeProductNameAdvanced(alias.standardName || '')}`.includes(q))
    .map((alias) => alias.productId)
    .filter(Boolean));
  const rows = await queryAll(`
    SELECT * FROM ${quoteTable('invoice_items')}
    WHERE ${quoteIdentifier('companyId')} = ?
      AND ${quoteIdentifier('deletedAt')} IS NULL
      AND COALESCE(${quoteIdentifier('isDiscountLine')}, 0) = 0
      AND COALESCE(${quoteIdentifier('candidateOnly')}, 0) = 0
  `, [req.user.companyId]);
  const matched = rows.filter((row) => {
    const haystack = `${normalizeProductNameAdvanced(row.rawName || row.productNameOriginal || '')} ${normalizeProductNameAdvanced(row.normalizedName || row.productNameNormalized || '')}`;
    return haystack.includes(q) || aliasProductIds.has(row.productId);
  });
  const groups = new Map();
  for (const row of matched) {
    const key = row.productId || row.productNameNormalized || normalizeProductNameAdvanced(row.productNameOriginal || row.rawName || '');
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const summaries = [...groups.entries()].map(([key, records]) => {
    const sorted = [...records].sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`));
    const prices = records.map((record) => Number(record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice || 0));
    return {
      productId: records[0]?.productId || '',
      standardName: records[0]?.productNameNormalized || records[0]?.normalizedName || key,
      recentPrice: prices.length ? Number(sorted[0]?.discountedEffectiveUnitCost || sorted[0]?.effectiveUnitCost || sorted[0]?.unitPrice || 0) : 0,
      minPrice: prices.length ? Math.min(...prices) : 0,
      maxPrice: prices.length ? Math.max(...prices) : 0,
      averagePrice: prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 0,
      recentPurchaseDate: sorted[0]?.invoiceDate || '',
      recordCount: records.length
    };
  }).sort((a, b) => (b.recentPurchaseDate || '').localeCompare(a.recentPurchaseDate || ''));
  res.json(summaries);
}));

app.get('/api/products/:name', requireAuth, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const q = normalizeProductNameAdvanced(name);
  const aliases = await queryAll(`
    SELECT * FROM ${quoteTable('product_aliases')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
  `, [req.user.companyId]);
  const aliasProductIds = new Set(aliases
    .filter((alias) => `${normalizeProductNameAdvanced(alias.aliasName || alias.rawName || alias.keyword)} ${normalizeProductNameAdvanced(alias.normalizedAlias || '')} ${normalizeProductNameAdvanced(alias.standardName || '')}`.includes(q) || normalizeProductNameAdvanced(alias.productId || '') === q)
    .map((alias) => alias.productId)
    .filter(Boolean));
  const rows = await queryAll(`
    SELECT invoice_items.*, COALESCE(suppliers.${quoteIdentifier('supplierDisplayName')}, suppliers.${quoteIdentifier('displayName')}, suppliers.${quoteIdentifier('name')}) AS "supplierName", invoices.${quoteIdentifier('invoiceNo')} AS "invoiceNo", invoices.${quoteIdentifier('imagePath')} AS "invoiceImagePath"
    FROM ${quoteTable('invoice_items')} invoice_items
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('supplierId')})
    LEFT JOIN ${quoteTable('invoices')} invoices
      ON invoices.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (invoices.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('invoiceId')} OR invoices.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('invoiceId')})
    WHERE invoice_items.${quoteIdentifier('companyId')} = ?
      AND invoice_items.${quoteIdentifier('deletedAt')} IS NULL
      AND COALESCE(invoice_items.${quoteIdentifier('isDiscountLine')}, 0) = 0
      AND COALESCE(invoice_items.${quoteIdentifier('candidateOnly')}, 0) = 0
    ORDER BY invoice_items.${quoteIdentifier('invoiceDate')} DESC, invoice_items.${quoteIdentifier('createdAt')} DESC
  `, [req.user.companyId]);
  res.json(rows.filter((row) => {
    const haystack = `${normalizeProductNameAdvanced(row.rawName || row.productNameOriginal || '')} ${normalizeProductNameAdvanced(row.normalizedName || row.productNameNormalized || '')}`;
    return haystack.includes(q) || row.productId === name || aliasProductIds.has(row.productId);
  }));
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

app.get('/api/invoice-recognition/stats', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const rows = await queryAll(`
    SELECT * FROM ${quoteTable('invoice_recognition_tasks')}
    WHERE ${quoteIdentifier('companyId')} = ?
    ORDER BY ${quoteIdentifier('createdAt')} DESC
    LIMIT ${limit}
  `, [req.user.companyId]);
  const tasks = rows.map(parseTaskRow);
  const templateCount = tasks.filter((task) => task.usedTemplate || String(task.recognitionSource || '').toLowerCase().includes('template') || String(task.recognitionSource || '').includes('模板')).length;
  const aiVisionCount = tasks.filter((task) => task.usedAI || String(task.recognitionSource || '').toLowerCase().includes('ai')).length;
  const ocrCount = tasks.filter((task) => !task.usedTemplate && !task.usedAI && String(task.recognitionSource || '').toLowerCase().includes('ocr')).length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const templateHitRate = completedCount ? Number((templateCount / completedCount).toFixed(4)) : 0;
  res.json({
    ok: true,
    companyId: req.user.companyId,
    limit,
    total: tasks.length,
    completedCount,
    templateCount,
    aiVisionCount,
    ocrCount,
    templateHitRate,
    sources: tasks.reduce((counts, task) => {
      const key = task.recognitionSource || task.source || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    recent: tasks.map((task) => ({
      id: task.id,
      status: task.status,
      recognitionSource: task.recognitionSource || task.source || '',
      usedTemplate: task.usedTemplate,
      usedAI: task.usedAI,
      supplierHint: task.supplierHint || '',
      invoiceId: task.invoiceId || '',
      createdAt: task.createdAt,
      completedAt: task.completedAt
    }))
  });
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
  if (useMongoSync()) await mirrorSqlSyncDataToMongo(req.user.companyId, 'stats-query');
  const stats = {};
  for (const table of syncTables) {
    const row = await queryGet(`
      SELECT COUNT(*) AS "count" FROM ${quoteTable(table)}
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('deletedAt')} IS NULL
    `, [req.user.companyId]);
    stats[table] = Number(row?.count || 0);
  }
  console.log('[stats] query:', { companyId: req.user.companyId, backend: usingPostgres ? 'postgres/sql' : 'sqlite/sql', stats });
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
      AND COALESCE(invoice_items.${quoteIdentifier('isDiscountLine')}, 0) = 0
      AND COALESCE(invoice_items.${quoteIdentifier('candidateOnly')}, 0) = 0
    ORDER BY invoices.${quoteIdentifier('invoiceDate')} DESC, invoice_items.${quoteIdentifier('createdAt')} DESC
  `, [req.user.companyId]);
  const header = ['invoiceId', 'invoiceNo', 'invoiceDate', 'supplier', 'productNameOriginal', 'productNameNormalized', 'category', 'quantity', 'unit', 'unitPrice', 'totalPrice', 'notes', 'imagePath'];
  const csv = [rowToCsv(header), ...rows.map((row) => rowToCsv(header.map((key) => row[key])))].join('\n');
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`InvoicePriceTrackerExport-${today()}.csv`);
  res.send(`\uFEFF${csv}`);
}));

app.get('/api/export.xls', requireAuth, asyncHandler(async (req, res) => {
  const rows = await queryAll(`
    SELECT invoices.${quoteIdentifier('id')} AS "invoiceId", invoices.${quoteIdentifier('invoiceNo')} AS "invoiceNo", invoices.${quoteIdentifier('invoiceDate')} AS "invoiceDate",
           invoices.${quoteIdentifier('pageNumber')} AS "pageNumber", invoices.${quoteIdentifier('pageCount')} AS "pageCount", invoices.${quoteIdentifier('invoiceLayoutType')} AS "invoiceLayoutType",
           suppliers.${quoteIdentifier('name')} AS "supplier",
           invoice_items.${quoteIdentifier('rawName')} AS "rawName",
           invoice_items.${quoteIdentifier('productNameOriginal')} AS "productNameOriginal",
           invoice_items.${quoteIdentifier('productNameNormalized')} AS "productNameNormalized",
           invoice_items.${quoteIdentifier('category')} AS "category",
           invoice_items.${quoteIdentifier('quantity')} AS "quantity",
           invoice_items.${quoteIdentifier('unit')} AS "unit",
           invoice_items.${quoteIdentifier('unitPrice')} AS "unitPrice",
           invoice_items.${quoteIdentifier('totalPrice')} AS "totalPrice",
           invoice_items.${quoteIdentifier('freeQty')} AS "freeQty",
           invoice_items.${quoteIdentifier('effectiveUnitCost')} AS "effectiveUnitCost",
           invoice_items.${quoteIdentifier('discountAmount')} AS "discountAmount",
           invoice_items.${quoteIdentifier('promoGroupName')} AS "promoGroupName",
           invoices.${quoteIdentifier('imagePath')} AS "imagePath"
    FROM ${quoteTable('invoice_items')} invoice_items
    LEFT JOIN ${quoteTable('invoices')} invoices
      ON invoices.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (invoices.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('invoiceId')} OR invoices.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('invoiceId')})
    LEFT JOIN ${quoteTable('suppliers')} suppliers
      ON suppliers.${quoteIdentifier('companyId')} = invoice_items.${quoteIdentifier('companyId')}
      AND (suppliers.${quoteIdentifier('id')} = invoice_items.${quoteIdentifier('supplierId')} OR suppliers.${quoteIdentifier('serverId')} = invoice_items.${quoteIdentifier('supplierId')})
    WHERE invoice_items.${quoteIdentifier('companyId')} = ? AND invoice_items.${quoteIdentifier('deletedAt')} IS NULL
      AND COALESCE(invoice_items.${quoteIdentifier('isDiscountLine')}, 0) = 0
      AND COALESCE(invoice_items.${quoteIdentifier('candidateOnly')}, 0) = 0
    ORDER BY invoices.${quoteIdentifier('invoiceDate')} DESC, invoice_items.${quoteIdentifier('createdAt')} DESC
  `, [req.user.companyId]);
  const header = ['invoiceId', 'invoiceNo', 'invoiceDate', 'pageNumber', 'pageCount', 'invoiceLayoutType', 'supplier', 'rawName', 'productNameOriginal', 'productNameNormalized', 'category', 'quantity', 'unit', 'unitPrice', 'totalPrice', 'freeQty', 'effectiveUnitCost', 'discountAmount', 'promoGroupName', 'imagePath'];
  res.header('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.attachment(`InvoicePriceTrackerExport-${today()}.xls`);
  res.send(`\uFEFF${rowsToExcelTsv(header, rows)}`);
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
  res.status(error.statusCode || error.status || 500).json({ error: error.message || 'Server error' });
});

const frontendDist = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
}

export function startServer(port = PORT) {
  if (hasMongoUri) {
    setTimeout(() => {
      getMongoDebugStatus()
        .then((status) => console.log('[mongo] startup connection check:', status))
        .catch((error) => console.error('[mongo] startup connection check failed:', error?.stack || error));
    }, 100);
  }
  setTimeout(() => {
    resumeRecognitionTasks().catch((error) => console.error('[recognition-task] resume failed:', error));
  }, 500);

  return app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on 0.0.0.0:${port}`);
  });
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  startServer();
}
