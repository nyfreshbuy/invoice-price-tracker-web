import { getCompanyId as getAuthCompanyId } from './api.js';
import { hasEncodingDamage, repairRecordEncoding, repairTextEncoding } from './encoding.js';

const DB_NAME = 'InvoicePriceTrackerLocal';
const DB_VERSION = 14;

export const syncTables = ['purchase_batches', 'import_sessions', 'invoice_groups', 'invoice_pages', 'invoice_image_resources', 'suppliers', 'invoices', 'invoice_items', 'products', 'price_history', 'invoice_discounts', 'gift_allocation_rules', 'supplier_templates', 'product_aliases', 'product_learning_rules', 'recognition_corrections', 'price_anomalies'];
const localOnlyTables = ['invoice_images', 'meta'];

let dbPromise;

export function generateId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return (
    Date.now().toString(36) +
    Math.random().toString(36).substring(2, 10)
  );
}

export async function hashFile(file) {
  if (!file) return '';
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof file.arrayBuffer === 'function') {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${file.name || 'file'}-${file.size || 0}-${file.lastModified || 0}`;
}

export function getDeviceId() {
  const key = 'invoicePriceTrackerDeviceId';
  let value = localStorage.getItem(key);
  if (!value) {
    value = generateId();
    localStorage.setItem(key, value);
  }
  return value;
}

export function normalizeProductName(value = '') {
  return repairTextEncoding(value)
    .trim()
    .replace(/干页豆腐/g, '千页豆腐')
    .replace(/仟页豆腐/g, '千页豆腐')
    .replace(/龍眼/g, '龙眼')
    .replace(/鳳梨/g, '凤梨')
    .replace(/蘋果/g, '苹果')
    .replace(/\bITO\s+EN\b/gi, 'ITOEN')
    .replace(/(\d+)\.0+\s*(FZ|OZ|ML|G|KG|LB|L)\b/gi, '$1$2')
    .replace(/(\d+\.\d*?[1-9])0+\s*(FZ|OZ|ML|G|KG|LB|L)\b/gi, '$1$2')
    .replace(/(\d+(?:\.\d+)?)\s*(FZ|OZ|ML|G|KG|LB|L)\b/gi, (_, number, unit) => `${Number(number)}${unit.toUpperCase()}`)
    .replace(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(FZ|OZ|ML|G|KG|LB|L|CT|PC|PCS|PK)\b/gi, (_, count, size, unit) => `${count}X${Number(size)}${unit.toUpperCase()}`)
    .toLowerCase()
    .replace(/[，,。；;：:｜|()[\]{}【】"'“”‘’]/g, ' ')
    .replace(/\u3000/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

const supplierTraditionalMap = {
  '閩': '闽',
  '國': '国',
  '際': '际',
  '貿': '贸',
  '進': '进',
  '東': '东',
  '華': '华',
  '聯': '联',
  '業': '业'
};

export function normalizeSupplierName(value = '') {
  const simplified = String(repairTextEncoding(value) || '')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[閩國際貿進東華聯業]/g, (char) => supplierTraditionalMap[char] || char)
    .toUpperCase()
    .replace(/\b(INC|INCORPORATED|CO|COMPANY|LTD|LIMITED|LLC|CORP|CORPORATION|INTERNATIONAL|TRADING|IMPORT|EXPORT)\b/g, ' ')
    .replace(/(股份有限公司|有限责任公司|有限公司|公司|股份|国际|贸易|进出口|商行|企业)$/g, '');
  return simplified.replace(/[^\u3400-\u9fffA-Z0-9]+/g, '');
}

function supplierAliasesFromName(value = '') {
  const raw = String(repairTextEncoding(value) || '').trim();
  const normalized = normalizeSupplierName(raw);
  const english = cleanSupplierEnglishName(raw.match(/[A-Za-z][A-Za-z0-9&.,'\-\s]+/g)?.join(' ') || '');
  const chinese = raw.match(/[\u3400-\u9fff]+/g)?.join('').trim() || '';
  return [...new Set([raw, normalized, english, chinese].filter(Boolean))];
}

function titleCaseEnglishCompany(value = '') {
  const legalSuffixes = new Set(['INC', 'INC.', 'INCORPORATED', 'CO', 'CO.', 'COMPANY', 'LTD', 'LTD.', 'LIMITED', 'LLC', 'CORP', 'CORP.', 'CORPORATION']);
  const suffixDisplay = {
    INC: 'Inc.',
    'INC.': 'Inc.',
    INCORPORATED: 'Inc.',
    CO: 'Co.',
    'CO.': 'Co.',
    COMPANY: 'Company',
    LTD: 'Ltd.',
    'LTD.': 'Ltd.',
    LIMITED: 'Ltd.',
    LLC: 'LLC',
    CORP: 'Corp.',
    'CORP.': 'Corp.',
    CORPORATION: 'Corp.'
  };
  return String(repairTextEncoding(value) || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (legalSuffixes.has(upper)) return suffixDisplay[upper] || upper;
      if (upper.length <= 2) return upper;
      return `${upper.slice(0, 1)}${upper.slice(1).toLowerCase()}`;
    })
    .join(' ')
    .replace(/\bInc\b\.?/g, 'Inc.')
    .replace(/\bCo\b\.?/g, 'Co.')
    .replace(/\bCorp\b\.?/g, 'Corp.')
    .replace(/\bLtd\b\.?/g, 'Ltd.');
}

function collapseRepeatedWordSequence(words = []) {
  const clean = words.map((word) => String(word || '').replace(/[^\w&.'-]/g, '').toUpperCase()).filter(Boolean);
  if (clean.length < 2) return clean;
  for (let offset = 0; offset < clean.length - 1; offset += 1) {
    const tail = clean.slice(offset);
    for (let size = 1; size <= Math.floor(tail.length / 2); size += 1) {
      if (tail.length % size !== 0) continue;
      const base = tail.slice(0, size);
      if (tail.every((word, index) => word === base[index % size])) return base;
    }
  }
  const output = [];
  for (const word of clean) {
    if (output[output.length - 1] !== word) output.push(word);
  }
  return output;
}

function cleanSupplierEnglishName(value = '') {
  const normalized = String(repairTextEncoding(value) || '')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[^A-Za-z0-9&.'\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (!/[A-Z]/.test(normalized)) return '';
  return titleCaseEnglishCompany(collapseRepeatedWordSequence(normalized.split(/\s+/)).join(' '));
}

function splitSupplierNameParts(value = '') {
  const raw = String(repairTextEncoding(value) || '')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
  return {
    supplierNameChinese: raw.match(/[\u3400-\u9fff]+/g)?.join('').trim() || '',
    supplierNameEnglish: cleanSupplierEnglishName(raw.match(/[A-Za-z][A-Za-z0-9&.,'\-\s]+/g)?.join(' ') || '')
  };
}

function buildSupplierDisplayName({ supplierNameChinese = '', supplierNameEnglish = '', supplierDisplayName = '', displayName = '', name = '' } = {}) {
  const fallback = splitSupplierNameParts(supplierDisplayName || displayName || name);
  const chinese = String(repairTextEncoding(supplierNameChinese) || fallback.supplierNameChinese || '').trim();
  const english = cleanSupplierEnglishName(supplierNameEnglish || fallback.supplierNameEnglish || '');
  return [chinese, english].filter(Boolean).join(' ') || cleanSupplierEnglishName(supplierDisplayName || displayName || name) || String(supplierDisplayName || displayName || name || '').trim();
}

function supplierDisplayName(record = {}) {
  return buildSupplierDisplayName(record) || record.displayName || record.name || '未命名供应商';
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value || '').split('|').map((entry) => entry.trim()).filter(Boolean);
  }
}

function mergeJsonLists(...values) {
  return [...new Set(values.flatMap(parseJsonList).map((entry) => String(entry || '').trim()).filter(Boolean))];
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

function giftAccountingKey(item = {}) {
  const candidate = promoGroupCandidate(item);
  const manual = Number(item.participatesInGiftAllocation || 0) || String(item.promoGroupRule || '').includes('manual');
  return manual && item.promoGroupId
    ? item.promoGroupId
    : candidate.key || normalizeProductName(item.standardName || item.productNameNormalized || item.normalizedName || item.productNameOriginal || item.name || '');
}

function displayItemName(item = {}) {
  return repairTextEncoding(String(item.name || item.productNameOriginal || [item.nameCn, item.nameEn].filter(Boolean).join(' ') || item.rawName || '').trim());
}

function productRawName(record = {}, item = {}, product = {}) {
  return repairTextEncoding(String(
    record.productName
    || record.productNameOriginal
    || record.originalName
    || record.itemName
    || record.name
    || item.productNameOriginal
    || item.rawName
    || item.name
    || product.name
    || ''
  ).trim());
}

function productStandardName(record = {}, item = {}, product = {}) {
  return repairTextEncoding(String(
    record.normalizedName
    || record.productNameNormalized
    || record.standardName
    || product.normalizedName
    || product.name
    || item.productNameNormalized
    || item.normalizedName
    || productRawName(record, item, product)
    || ''
  ).trim());
}

function productDisplayName(record = {}, item = {}, product = {}) {
  const cn = repairTextEncoding(String(record.nameCn || item.nameCn || '').trim());
  const en = repairTextEncoding(String(record.nameEn || item.nameEn || '').trim());
  if (cn && en) return `${cn} / ${en}`;
  return productRawName(record, item, product)
    || productStandardName(record, item, product)
    || '未命名商品';
}

function productSearchText(record = {}, item = {}, product = {}) {
  return [
    productDisplayName(record, item, product),
    productRawName(record, item, product),
    productStandardName(record, item, product),
    record.productName,
    record.productNameOriginal,
    record.originalName,
    record.itemName,
    record.name,
    item.productNameOriginal,
    item.productNameNormalized,
    item.rawName,
    item.name,
    product.name,
    product.normalizedName
  ].map((value) => normalizeProductName(value || '')).filter(Boolean).join(' ');
}

function priceHistoryNameFields(item = {}, product = {}) {
  const productNameOriginal = productRawName({}, item, product);
  const productNameNormalized = productStandardName({}, item, product) || normalizeProductName(productNameOriginal);
  const productName = productDisplayName({}, item, product);
  return {
    productName,
    productNameOriginal,
    productNameNormalized,
    normalizedName: normalizeProductName(productNameNormalized || productNameOriginal),
    originalName: productNameOriginal,
    itemName: productNameOriginal,
    name: productName,
    nameCn: item.nameCn || '',
    nameEn: item.nameEn || ''
  };
}

function promoGroupCandidate(item = {}) {
  const source = `${item.standardName || item.productNameNormalized || item.normalizedName || displayItemName(item)} ${item.spec || ''} ${item.unit || ''}`.toUpperCase();
  const normalized = normalizeProductName(source).toUpperCase();
  const tokens = normalized.split(/[^A-Z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const brand = tokens.find((token) => !/^\d/.test(token) && !['PET', 'CAN', 'BTL', 'BOTTLE', 'CASE', 'CS', 'PK', 'PACK'].includes(token)) || '';
  const normalizedProductName = normalizeProductName(item.standardName || item.productNameNormalized || item.normalizedName || displayItemName(item));
  const specs = [];
  const packageMatch = source.match(/\b(PET|CAN|BTL|BOTTLE|JAR|BAG|BOX|TIN)\b/);
  if (packageMatch) specs.push(packageMatch[1]);
  const sizeMatch = source.match(/\b\d+\/\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L)\b/) || source.match(/\b\d+X\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L|CT|PC|PCS|PK)\b/) || source.match(/\b\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L)\b/);
  if (sizeMatch) specs.push(sizeMatch[0]);
  if (!brand || !normalizedProductName || specs.length === 0) return { key: '', name: '需要人工确认分摊组', rule: 'uncertain: missing brand, product name, or package/spec' };
  return { key: `${brand}|${normalizedProductName}|${specs.join('|')}`, name: `${brand} ${specs.join(' ')}`, rule: 'same brand + same normalized product + same spec/package' };
}

function isDiscountLine(item = {}) {
  const name = displayItemName(item).toLowerCase();
  const amount = Number(item.totalPrice ?? item.amount ?? 0);
  const unitPrice = Number(item.unitPrice ?? item.priceEach ?? item.price ?? 0);
  const code = String(item.code || item.barcode || '').trim();
  return name.includes('discount') || name.includes('折扣') || amount < 0 || unitPrice < 0 || (!code && amount < 0);
}

function splitInvoiceRows(items = []) {
  return {
    productItems: items.filter((item) => !isDiscountLine(item)),
    discountItems: items.filter(isDiscountLine)
  };
}

export function applyGiftAccounting(items = []) {
  const normalized = items.map((item) => {
    const quantity = Number(item.quantity ?? item.qty ?? 0);
    const unitPrice = Number(item.unitPrice ?? item.priceEach ?? item.price ?? 0);
    const totalPrice = Number(item.totalPrice ?? item.amount ?? 0);
    const isFreeItem = Boolean(item.isFreeItem) || unitPrice === 0 || totalPrice === 0;
    const candidate = promoGroupCandidate(item);
    return {
      ...item,
      quantity,
      unitPrice,
      totalPrice,
      rawName: item.rawName || displayItemName(item),
      productNameOriginal: item.productNameOriginal || displayItemName(item),
      productNameNormalized: normalizeProductName(item.productNameNormalized || item.normalizedName || item.productNameOriginal || displayItemName(item)),
      normalizedName: normalizeProductName(item.normalizedName || item.productNameNormalized || item.productNameOriginal || displayItemName(item)),
      promoGroupId: item.promoGroupId || candidate.key || '',
      promoGroupName: item.promoGroupName || candidate.name || '',
      promoGroupRule: item.promoGroupRule || candidate.rule || '',
      isFreeItem,
      freeReason: item.freeReason || (isFreeItem ? (unitPrice === 0 ? 'priceEach = 0' : 'amount = 0') : '')
    };
  });
  const groups = new Map();
  for (const item of normalized) {
    const key = giftAccountingKey(item) || item.productNameOriginal || item.id;
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
    const key = giftAccountingKey(item) || item.productNameOriginal || item.id;
    const group = groups.get(key) || { chargedQty: item.quantity, freeQty: 0, invoiceAmount: item.totalPrice };
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

function summarizeLocalPromoGroups(items = []) {
  const groups = new Map();
  for (const item of items) {
    const idValue = item.promoGroupId || giftAccountingKey(item) || item.id;
    if (!idValue) continue;
    const group = groups.get(idValue) || {
      id: idValue,
      name: item.promoGroupName || idValue,
      rule: item.promoGroupRule || '',
      productNames: [],
      chargedQty: 0,
      freeQty: 0,
      actualQty: 0,
      invoiceAmount: 0
    };
    group.productNames.push(displayItemName(item));
    if (Number(item.isFreeItem || 0)) {
      group.freeQty += moneyNumber(item.quantity);
    } else {
      group.chargedQty += moneyNumber(item.quantity);
      group.invoiceAmount += moneyNumber(item.totalPrice);
    }
    group.actualQty = group.chargedQty + group.freeQty;
    groups.set(idValue, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    productNames: [...new Set(group.productNames.filter(Boolean))],
    originalUnitCost: group.chargedQty > 0 ? group.invoiceAmount / group.chargedQty : 0,
    effectiveUnitCost: group.actualQty > 0 ? group.invoiceAmount / group.actualQty : 0
  })).filter((group) => group.freeQty > 0 || group.productNames.length > 1);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const table of [...syncTables, ...localOnlyTables]) {
        if (!db.objectStoreNames.contains(table)) {
          db.createObjectStore(table, { keyPath: 'id' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function store(table, mode = 'readonly') {
  const db = await openDb();
  const tx = db.transaction(table, mode);
  return { tx, objectStore: tx.objectStore(table) };
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function all(table) {
  const { objectStore } = await store(table);
  return promisify(objectStore.getAll());
}

async function put(table, record) {
  const { objectStore } = await store(table, 'readwrite');
  const nextRecord = table === 'invoice_images' ? record : repairRecordEncoding(record);
  await promisify(objectStore.put(nextRecord));
  window.dispatchEvent(new CustomEvent('local-db-change', { detail: { table } }));
  return nextRecord;
}

async function putMany(table, records) {
  const { tx, objectStore } = await store(table, 'readwrite');
  for (const record of records) objectStore.put(table === 'invoice_images' ? record : repairRecordEncoding(record));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  window.dispatchEvent(new CustomEvent('local-db-change', { detail: { table } }));
}

async function get(table, id) {
  const { objectStore } = await store(table);
  return promisify(objectStore.get(id));
}

async function remove(table, id) {
  const { objectStore } = await store(table, 'readwrite');
  await promisify(objectStore.delete(id));
  window.dispatchEvent(new CustomEvent('local-db-change', { detail: { table } }));
}

export function getCurrentCompanyId() {
  return getAuthCompanyId();
}

function belongsToCurrentCompany(record) {
  const companyId = getCurrentCompanyId();
  const current = String(companyId || '').trim();
  const recordCompanyId = String(record?.companyId || record?.company_id || record?.company?.id || '').trim();
  if (!current) return !recordCompanyId;
  return !recordCompanyId || recordCompanyId === current;
}

function active(record) {
  return !record.deletedAt && belongsToCurrentCompany(record);
}

function isBlobLike(value) {
  return Boolean(
    value
    && ((typeof Blob !== 'undefined' && value instanceof Blob)
      || (typeof File !== 'undefined' && value instanceof File))
  );
}

function pendingReviewInvoice(invoice = {}) {
  const status = String(invoice.status || '').toUpperCase();
  if (['CONFIRMED', 'APPROVED'].includes(status)) return false;
  return status === 'PENDING_REVIEW'
    || invoice.duplicateStatus === 'possible';
}

function abnormalInvoice(invoice = {}) {
  const status = String(invoice.status || '').toUpperCase();
  if (['CONFIRMED', 'APPROVED'].includes(status)) return false;
  return status === 'ABNORMAL'
    || Boolean(invoice.recognitionWarnings)
    || Number(invoice.totalDifference || 0) > 0.05;
}

function approvedForStats(invoice = {}) {
  if (!active(invoice) || ['merged', 'hidden', 'duplicate'].includes(String(invoice.status || '').toLowerCase())) return false;
  if (['duplicate', 'confirmed'].includes(String(invoice.duplicateStatus || '').toLowerCase())) return false;
  if (['APPROVED', 'CONFIRMED'].includes(String(invoice.status || '').toUpperCase())) return true;
  return !pendingReviewInvoice(invoice) && !abnormalInvoice(invoice);
}

function priceHistoryEligibleItem(item = {}, invoice = {}) {
  if (!approvedForStats(invoice)) return false;
  if (!active(item)) return false;
  if (Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0) || Number(item.isFreeItem || 0)) return false;
  if (String(item.nameQualityStatus || 'trusted') !== 'trusted') return false;
  const name = String(item.productNameOriginal || item.productNameNormalized || item.rawName || '').trim().toLowerCase();
  if (!name || /^(remark|remarks|note|notes|memo|subtotal|total)$/.test(name)) return false;
  if (name.includes('discount') || name.includes('折扣')) return false;
  if (Number(item.quantity || item.actualQty || item.totalQty || 0) <= 0) return false;
  if (Number(item.unitPrice || item.effectiveUnitCost || 0) <= 0) return false;
  if (Number(item.totalPrice || 0) <= 0) return false;
  return true;
}

function trustedItemName(item = {}) {
  return String(item.nameQualityStatus || 'trusted') !== 'needs_review';
}

function invoiceIdSet(invoices = []) {
  return new Set(invoices.flatMap((invoice) => idsFor(invoice)));
}

function moneyNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function idsFor(record, fallback = '') {
  return [fallback, record?.id, record?.localId, record?.serverId].filter(Boolean);
}

function priceForItem(item) {
  return moneyNumber(item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice || 0);
}

function evaluateProductNameQuality(item = {}, context = {}) {
  const name = String(item.standardName || item.productNameNormalized || item.normalizedName || item.productNameOriginal || item.name || [item.nameCn, item.nameEn].filter(Boolean).join(' ') || '').trim();
  const confidence = Number(item.nameConfidence ?? item.itemConfidence ?? item.confidence ?? (context.source === 'ai' || context.usedAI ? 0.82 : 0.45));
  const reasons = [];
  if (!name) reasons.push('empty_name');
  if (confidence < 0.55) reasons.push('low_confidence');
  if (/={1,}|\*{2,}|\?{2,}|[_|]{3,}/.test(name)) reasons.push('symbol_noise');
  const compact = name.replace(/\s+/g, '');
  if (compact.length <= 2 && !/[\u3400-\u9fff]/.test(compact)) reasons.push('too_short');
  const symbolCount = (name.match(/[^A-Za-z0-9\u3400-\u9fff\s.&'’()\-/]/g) || []).length;
  if (name.length > 0 && symbolCount / name.length > 0.22) reasons.push('too_many_symbols');
  const alphaTokens = name.match(/[A-Za-z]+/g) || [];
  const shortAlphaTokens = alphaTokens.filter((token) => token.length <= 2).length;
  if (alphaTokens.length >= 3 && shortAlphaTokens / alphaTokens.length > 0.65) reasons.push('broken_english_tokens');
  if (/^[a-z]{1,4}\s*[=:-]?$/i.test(name)) reasons.push('ocr_fragment');
  if (context.source && context.source !== 'ai' && !context.usedAI) reasons.push('not_ai_verified');
  return { ok: reasons.length === 0, confidence, reasons };
}

function applyProductNameQuality(items = [], context = {}) {
  return items.map((item) => {
    const quality = evaluateProductNameQuality(item, context);
    return {
      ...item,
      nameConfidence: quality.confidence,
      itemConfidence: Number(item.itemConfidence ?? item.confidence ?? quality.confidence),
      nameQualityStatus: quality.ok ? 'trusted' : 'needs_review',
      nameQualityReason: quality.reasons.join(', '),
      itemRecognitionSource: item.itemRecognitionSource || context.source || '',
      candidateOnly: Boolean(item.candidateOnly) || !quality.ok
    };
  });
}

function invoiceMonth(value = '') {
  return String(value || '').slice(0, 7) || '未 dated';
}

function safeArchiveSegment(value = '') {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'Unknown Supplier';
}

function buildArchivePath({ supplierName = '', invoiceDate = '', invoiceNo = '', pageNumber = 1, fileHash = '', originalFileName = '' } = {}) {
  const supplierFolder = safeArchiveSegment(supplierName);
  const month = invoiceMonth(invoiceDate);
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(String(invoiceDate || '')) ? invoiceDate : 'undated';
  const invoicePart = safeArchiveSegment(invoiceNo || (fileHash ? fileHash.slice(0, 8) : String(originalFileName || 'invoice').replace(/\.[^.]+$/, '')));
  const ext = (String(originalFileName || '').match(/\.[A-Za-z0-9]+$/)?.[0] || '.jpg').toLowerCase();
  const archiveFolder = `InvoiceArchive/${supplierFolder}/${month}`;
  return {
    archiveFolder,
    invoiceMonth: month,
    archiveFilePath: `${archiveFolder}/${datePart}_${invoicePart}_page${Math.max(1, Number(pageNumber || 1))}${ext}`
  };
}

function inferPageInfoFromFileName(fileName = '') {
  const base = String(fileName || '').replace(/\.[^.]+$/, '');
  const pageMatch = base.match(/(?:page|p|页)[\s_-]*(\d+)(?:[\s_-]*(?:of|-|\/)[\s_-]*(\d+))?/i)
    || base.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
  if (!pageMatch) return { pageNumber: 0, pageCount: 0, groupKey: '' };
  const pageNumber = Number(pageMatch[1] || 0);
  const pageCount = Number(pageMatch[2] || 0);
  const groupKey = base
    .replace(pageMatch[0], '')
    .replace(/[_\-\s]+$/g, '')
    .trim() || base;
  return { pageNumber, pageCount, groupKey };
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function syncFields(record, status = 'pending') {
  const timestamp = nowIso();
  const generatedId = record.id || record.localId || generateId();
  const companyId = getCurrentCompanyId();
  if (!companyId) throw new Error('请先登录');
  const nextVersion = Math.max(0, Number(record.version || 0)) + (status === 'synced' ? 0 : 1);
  return {
    ...record,
    id: record.id || generatedId,
    companyId: record.companyId || companyId,
    localId: record.localId || generatedId,
    serverId: record.serverId || null,
    syncStatus: status,
    version: nextVersion || 1,
    createdAt: record.createdAt || timestamp,
    updatedAt: timestamp,
    deletedAt: record.deletedAt || null,
    deviceId: record.deviceId || getDeviceId()
  };
}

function resolveByAnyId(records, id) {
  return records.find((record) => record.id === id || record.localId === id || record.serverId === id);
}

async function findSupplierByName(name) {
  const suppliers = await localDb.getSuppliers();
  const normalizedName = normalizeSupplierName(name);
  return suppliers.find((supplier) => {
    const aliases = mergeJsonLists(supplier.aliases, supplier.name, supplier.displayName, supplier.supplierDisplayName, supplier.supplierNameChinese, supplier.supplierNameEnglish);
    return supplier.name === name
      || supplier.displayName === name
      || supplier.normalizedName === normalizedName
      || aliases.some((alias) => normalizeSupplierName(alias) === normalizedName || alias === name);
  });
}

async function findOrCreateSupplier(name) {
  const supplierName = (name || '').trim() || '未命名供应商';
  const existing = await findSupplierByName(supplierName);
  if (existing) return existing;
  return localDb.saveSupplier({ name: supplierName, phone: '', email: '', address: '', notes: '' });
}

async function upsertProductForItem(item) {
  const normalizedName = normalizeProductName(item.productNameNormalized || item.productNameOriginal || '');
  if (!normalizedName) return null;
  const products = await all('products');
  const existing = products.find((product) => active(product) && product.normalizedName === normalizedName);
  const product = syncFields({
    ...(existing || {}),
    name: item.productNameNormalized || item.productNameOriginal,
    normalizedName,
    category: item.category || existing?.category || '',
    notes: existing?.notes || ''
  });
  await put('products', product);
  return product;
}

export const localDb = {
  all,
  put,
  putMany,
  get,
  remove,

  async getMeta(key) {
    return get('meta', key);
  },

  async setMeta(key, value) {
    return put('meta', { id: key, value, updatedAt: nowIso() });
  },

  async getPendingCount() {
    const groups = await Promise.all(syncTables.map(async (table) => (await all(table)).filter((record) => belongsToCurrentCompany(record) && ['pending', 'deleted'].includes(record.syncStatus)).length));
    return groups.reduce((sum, count) => sum + count, 0);
  },

  async getConflictCount() {
    const groups = await Promise.all(syncTables.map(async (table) => (await all(table)).filter((record) => belongsToCurrentCompany(record) && record.syncStatus === 'conflict').length));
    return groups.reduce((sum, count) => sum + count, 0);
  },

  async getFailedCount() {
    const groups = await Promise.all(syncTables.map(async (table) => (await all(table)).filter((record) => belongsToCurrentCompany(record) && record.syncStatus === 'failed').length));
    return groups.reduce((sum, count) => sum + count, 0);
  },

  async getPendingChanges() {
    const entries = await Promise.all(syncTables.map(async (table) => [
      table,
      (await all(table)).filter((record) => belongsToCurrentCompany(record) && ['pending', 'deleted'].includes(record.syncStatus))
    ]));
    return Object.fromEntries(entries);
  },

  async retryFailedSyncRecords() {
    const retriedByTable = {};
    for (const table of syncTables) {
      const failed = (await all(table)).filter((record) => belongsToCurrentCompany(record) && record.syncStatus === 'failed');
      if (!failed.length) continue;
      await putMany(table, failed.map((record) => ({
        ...record,
        syncStatus: record.deletedAt ? 'deleted' : 'pending',
        syncNote: record.syncNote || 'retry failed sync',
        syncError: ''
      })));
      retriedByTable[table] = failed.length;
    }
    return retriedByTable;
  },

  async getPendingDebugDetails() {
    const pending = await this.getPendingChanges();
    return syncTables.flatMap((table) => (pending[table] || []).map((record) => ({
      table,
      id: record.id || '',
      localId: record.localId || '',
      serverId: record.serverId || '',
      syncStatus: record.syncStatus || '',
      pendingSync: ['pending', 'deleted'].includes(record.syncStatus),
      lastSyncError: record.syncError || record.syncNote || '',
      updatedAt: record.updatedAt || '',
      payload: record
    })));
  },

  async markSynced(table, result) {
    if (result.status === 'conflict') {
      const records = await all(table);
      const local = records.find((record) => record.localId === result.localId || record.id === result.localId || record.serverId === result.serverId);
      if (local) await put(table, {
        ...local,
        serverId: result.serverId || local.serverId || local.id,
        syncStatus: 'synced',
        syncNote: result.reason || 'conflict',
        conflictRecord: JSON.stringify(result.record || result)
      });
      return Boolean(local);
    }
    if (result.status === 'duplicate' || result.duplicate === true || result.already_exists === true || result.alreadyExists === true || result.status === 'already_exists' || result.status === 'alreadyExists') {
      const records = await all(table);
      const local = records.find((record) => record.localId === result.localId || record.id === result.localId || record.serverId === result.serverId);
      if (local) await put(table, {
        ...local,
        serverId: result.serverId || result.duplicateCheck?.duplicateInvoiceId || result.duplicate?.id || local.serverId || local.id,
        syncStatus: 'synced',
        duplicateStatus: result.duplicateStatus || 'duplicate',
        duplicateOfInvoiceId: result.serverId || result.duplicateCheck?.duplicateInvoiceId || result.duplicate?.id || '',
        syncNote: result.reason || result.status || 'duplicate',
        conflictRecord: JSON.stringify(result)
      });
      return Boolean(local);
    }
    if (result.status === 'skipped_duplicate_invoice' || result.status === 'skipped_integrity_generated') {
      const records = await all(table);
      const local = records.find((record) => record.localId === result.localId || record.id === result.localId || record.serverId === result.serverId);
      if (local) await put(table, {
        ...local,
        serverId: result.serverId || local.serverId || local.id,
        syncStatus: 'synced',
        syncNote: result.status
      });
      return Boolean(local);
    }
    const records = await all(table);
    const local = records.find((record) => record.localId === result.localId || record.id === result.localId || record.serverId === result.serverId);
    if (!local) return false;
    const serverRecord = result.record || {};
    await put(table, {
      ...serverRecord,
      id: local.id,
      localId: local.localId || result.localId || local.id,
      serverId: result.serverId || serverRecord.serverId || serverRecord.id,
      syncStatus: 'synced',
      status: result.status === 'needs_review' ? 'PENDING_REVIEW' : (serverRecord.status || local.status),
      syncNote: result.reason || result.status || '',
      version: Number(serverRecord.version || local.version || 1)
    });
    return true;
  },

  async markSyncFailed(table, localId, errorMessage = 'Sync result missing') {
    if (!table || !localId) return false;
    const records = await all(table);
    const local = records.find((record) => record.localId === localId || record.id === localId || record.serverId === localId);
    if (!local) return false;
    await put(table, {
      ...local,
      syncStatus: 'failed',
      syncNote: errorMessage,
      syncError: errorMessage,
      updatedAt: local.updatedAt || nowIso()
    });
    return true;
  },

  async mergeRemote(table, remote) {
    if (!belongsToCurrentCompany(remote)) return;
    const repairedRemote = repairRecordEncoding(remote);
    const encodingFixed = repairedRemote !== remote;
    const records = await all(table);
    const local = records.find((record) => record.serverId === remote.serverId || record.serverId === remote.id || record.id === remote.serverId || record.id === remote.id);
    if (local && local.syncStatus === 'pending' && local.updatedAt > remote.updatedAt) return;
    if (local && local.syncStatus === 'pending' && local.updatedAt <= remote.updatedAt && ['invoices', 'invoice_items'].includes(table)) {
      await put(table, { ...local, syncStatus: 'conflict', conflictRecord: JSON.stringify(repairedRemote) });
      return;
    }
    const id = local?.id || remote.serverId || remote.id || generateId();
    await put(table, {
      ...repairedRemote,
      id,
      localId: local?.localId || remote.localId || id,
      serverId: remote.serverId || remote.id,
      syncStatus: remote.deletedAt ? 'deleted' : (encodingFixed ? 'pending' : 'synced'),
      encodingFixedAt: encodingFixed ? nowIso() : repairedRemote.encodingFixedAt,
      updatedAt: encodingFixed ? nowIso() : repairedRemote.updatedAt,
      version: Number(remote.version || local?.version || 1)
    });
  },

  async mergeRemoteMany(table, remotes = []) {
    const incoming = Array.isArray(remotes) ? remotes.filter(belongsToCurrentCompany) : [];
    if (!incoming.length) return { table, imported: 0, skipped: 0 };
    const records = await all(table);
    const localByKey = new Map();
    for (const record of records) {
      for (const key of [record.serverId, record.id].filter(Boolean)) localByKey.set(key, record);
    }
    const { tx, objectStore } = await store(table, 'readwrite');
    let imported = 0;
    let skipped = 0;
    for (const remote of incoming) {
      const repairedRemote = repairRecordEncoding(remote);
      const encodingFixed = repairedRemote !== remote;
      const local = localByKey.get(remote.serverId) || localByKey.get(remote.id);
      if (local && local.syncStatus === 'pending' && local.updatedAt > remote.updatedAt) {
        skipped += 1;
        continue;
      }
      if (local && local.syncStatus === 'pending' && local.updatedAt <= remote.updatedAt && ['invoices', 'invoice_items'].includes(table)) {
        objectStore.put(repairRecordEncoding({ ...local, syncStatus: 'conflict', conflictRecord: JSON.stringify(repairedRemote) }));
        imported += 1;
        continue;
      }
      const id = local?.id || remote.serverId || remote.id || generateId();
      objectStore.put(repairRecordEncoding({
        ...repairedRemote,
        id,
        localId: local?.localId || remote.localId || id,
        serverId: remote.serverId || remote.id,
        syncStatus: remote.deletedAt ? 'deleted' : (encodingFixed ? 'pending' : 'synced'),
        encodingFixedAt: encodingFixed ? nowIso() : repairedRemote.encodingFixedAt,
        updatedAt: encodingFixed ? nowIso() : repairedRemote.updatedAt,
        version: Number(remote.version || local?.version || 1)
      }));
      imported += 1;
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error(`IndexedDB transaction aborted for ${table}`));
    });
    window.dispatchEvent(new CustomEvent('local-db-change', { detail: { table } }));
    return { table, imported, skipped };
  },

  async getSuppliers() {
    return (await all('suppliers'))
      .filter((supplier) => active(supplier) && supplier.status !== 'merged')
      .map((supplier) => ({ ...supplier, supplierDisplayName: supplierDisplayName(supplier), displayName: supplierDisplayName(supplier), name: supplierDisplayName(supplier) }))
      .sort((a, b) => supplierDisplayName(a).localeCompare(supplierDisplayName(b)));
  },

  async saveSupplier(supplier) {
    const parts = splitSupplierNameParts([
      supplier.supplierNameChinese,
      supplier.supplierNameEnglish,
      supplier.supplierDisplayName,
      supplier.displayName,
      supplier.name
    ].filter(Boolean).join(' '));
    const supplierNameChinese = supplier.supplierNameChinese || parts.supplierNameChinese || '';
    const supplierNameEnglish = cleanSupplierEnglishName(supplier.supplierNameEnglish || parts.supplierNameEnglish || '');
    const displayName = buildSupplierDisplayName({
      supplierNameChinese,
      supplierNameEnglish,
      supplierDisplayName: supplier.supplierDisplayName,
      displayName: supplier.displayName,
      name: supplier.name
    });
    const normalizedName = normalizeSupplierName(displayName);
    const existing = (await localDb.getSuppliers()).find((entry) => {
      if (supplier.id && idsFor(entry).includes(supplier.id)) return false;
      const aliases = mergeJsonLists(entry.aliases, entry.name, entry.displayName, entry.supplierDisplayName, entry.supplierNameChinese, entry.supplierNameEnglish);
      return entry.normalizedName === normalizedName || aliases.some((alias) => normalizeSupplierName(alias) === normalizedName);
    });
    if (existing) {
      return put('suppliers', syncFields({
        ...existing,
        ...supplier,
        id: existing.id,
        name: displayName,
        displayName,
        supplierNameChinese: existing.supplierNameChinese || supplierNameChinese,
        supplierNameEnglish: existing.supplierNameEnglish || supplierNameEnglish,
        supplierDisplayName: displayName,
        normalizedName: existing.normalizedName || normalizedName,
        aliases: JSON.stringify(mergeJsonLists(existing.aliases, supplier.aliases, supplierAliasesFromName(displayName), supplierNameChinese, supplierNameEnglish))
      }));
    }
    return put('suppliers', syncFields({
      ...supplier,
      name: displayName,
      displayName,
      supplierNameChinese,
      supplierNameEnglish,
      supplierDisplayName: displayName,
      normalizedName,
      aliases: JSON.stringify(mergeJsonLists(supplier.aliases, supplierAliasesFromName(displayName), supplierNameChinese, supplierNameEnglish)),
      templateIds: supplier.templateIds || '[]',
      status: supplier.status || 'active'
    }));
  },

  async deleteSupplier(supplier) {
    await put('suppliers', syncFields({ ...supplier, deletedAt: nowIso() }, 'deleted'));
    const templates = await all('supplier_templates');
    await putMany('supplier_templates', templates.filter((template) => template.supplierId === supplier.id || template.supplierId === supplier.serverId).map((template) => syncFields({ ...template, deletedAt: nowIso() }, 'deleted')));
  },

  async getTemplate(supplierId) {
    const templates = await all('supplier_templates');
    return templates.filter(active).filter((template) => template.supplierId === supplierId || template.supplierId === resolveByAnyId(templates, supplierId)?.serverId)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0] || null;
  },

  async saveTemplate(supplierId, template) {
    const existing = await localDb.getTemplate(supplierId);
    const saved = await put('supplier_templates', syncFields({ ...(existing || {}), ...template, supplierId }));
    const templates = (await all('supplier_templates')).filter((entry) => active(entry) && entry.supplierId === supplierId && entry.id !== saved.id);
    if (templates.length) {
      await putMany('supplier_templates', templates.map((entry) => syncFields({ ...entry, deletedAt: nowIso() }, 'deleted')));
    }
    return saved;
  },

  async createPurchaseBatch(payload) {
    const batch = syncFields({
      batchName: payload.batchName || `采购批次 ${new Date().toLocaleString()}`,
      supplierCount: Number(payload.supplierCount || 0),
      invoiceCount: Number(payload.invoiceCount || 0),
      totalAmount: Number(payload.totalAmount || 0)
    });
    await put('purchase_batches', batch);
    return batch;
  },

  async getPurchaseBatches() {
    return (await all('purchase_batches')).filter(active).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  },

  async createImportSessionFromFiles(files = [], options = {}) {
    const fileList = Array.from(files || []);
    if (!fileList.length) throw new Error('No files selected');
    const timestamp = nowIso();
    const sessionId = options.id || generateId();
    const existingPages = (await all('invoice_pages')).filter(active);
    const existingHashes = new Set(existingPages.map((page) => page.fileHash).filter(Boolean));
    const session = syncFields({
      id: sessionId,
      localId: sessionId,
      serverId: sessionId,
      sessionName: options.sessionName || `Import Session ${new Date().toLocaleString()}`,
      sourceType: 'images',
      fileCount: fileList.length,
      groupCount: 0,
      status: 'imported',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await put('import_sessions', session);

    const pages = [];
    const groupsByKey = new Map();
    for (let index = 0; index < fileList.length; index += 1) {
      const file = fileList[index];
      const pageId = generateId();
      const imageId = generateId();
      const fileHash = await hashFile(file);
      const pageInfo = inferPageInfoFromFileName(file.name || '');
      const duplicateFile = fileHash && existingHashes.has(fileHash);
      let imagePath = '';
      if (!duplicateFile) {
        await localDb.saveInvoiceImage({ id: imageId, invoiceId: pageId, file, source: 'IndexedDB' });
        imagePath = `indexeddb:${imageId}`;
      }
      const groupKey = pageInfo.groupKey || pageId;
      if (!groupsByKey.has(groupKey)) groupsByKey.set(groupKey, []);
      const page = syncFields({
        id: pageId,
        localId: pageId,
        serverId: pageId,
        importSessionId: sessionId,
        invoiceGroupId: '',
        invoiceId: '',
        pageIndex: index + 1,
        pageNumber: pageInfo.pageNumber,
        pageCount: pageInfo.pageCount,
        originalFileName: file.name || `image-${index + 1}`,
        originalFilePath: file.name || '',
        archiveFilePath: '',
        archiveFolder: '',
        fileHash,
        fileSize: Number(file.size || 0),
        imageId: duplicateFile ? '' : imageId,
        imagePath,
        mimeType: file.type || 'image/jpeg',
        lightOcrText: '',
        lightOcrJson: '',
        status: duplicateFile ? 'skipped_duplicate' : 'waiting'
      });
      pages.push(page);
      groupsByKey.get(groupKey).push(page);
      if (fileHash) existingHashes.add(fileHash);
    }

    const groups = [];
    for (const [key, groupPages] of groupsByKey.entries()) {
      const groupId = generateId();
      const pageIds = groupPages.map((page) => page.id);
      groups.push(syncFields({
        id: groupId,
        localId: groupId,
        serverId: groupId,
        importSessionId: sessionId,
        supplierId: '',
        supplierName: '',
        invoiceNo: '',
        invoiceDate: '',
        confidence: key === groupPages[0]?.id ? 0.2 : 0.55,
        reason: key === groupPages[0]?.id ? 'Initial single-page group; confirm or merge if needed.' : 'Grouped by filename page pattern.',
        status: 'needs_review',
        pageIds: JSON.stringify(pageIds),
        pageCount: groupPages.length,
        totalAmount: 0,
        aiSupplierNameCandidate: ''
      }));
      for (const page of groupPages) page.invoiceGroupId = groupId;
    }
    await putMany('invoice_pages', pages);
    await putMany('invoice_groups', groups);
    await put('import_sessions', syncFields({ ...session, groupCount: groups.length, status: 'grouped' }));
    return localDb.getImportSessionDetail(sessionId);
  },

  async getImportSessions() {
    return (await all('import_sessions')).filter(active).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  },

  async getImportSessionDetail(sessionId) {
    const session = await get('import_sessions', sessionId);
    if (!session || !belongsToCurrentCompany(session)) return null;
    const pages = (await all('invoice_pages'))
      .filter((page) => active(page) && page.importSessionId === sessionId)
      .sort((a, b) => Number(a.pageIndex || 0) - Number(b.pageIndex || 0));
    const groups = (await all('invoice_groups'))
      .filter((group) => active(group) && group.importSessionId === sessionId)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      .map((group) => ({
        ...group,
        pages: pages.filter((page) => page.invoiceGroupId === group.id || page.invoiceGroupId === group.serverId)
      }));
    return { session, pages, groups };
  },

  async updateImportGroup(groupId, fields = {}) {
    const group = await get('invoice_groups', groupId);
    if (!group || !belongsToCurrentCompany(group)) throw new Error('Import group not found');
    const updated = syncFields({ ...group, ...fields });
    await put('invoice_groups', updated);
    return updated;
  },

  async saveInvoiceImage(...args) {
    const options = isBlobLike(args[0])
      ? { ...(args[1] || {}), file: args[0] }
      : (args[0] || {});
    const { id: imageId, invoiceId, file, source = 'IndexedDB' } = options;
    if (!file) throw new Error('未选择图片文件');
    const companyId = getCurrentCompanyId();
    if (!companyId) throw new Error('请先登录');
    const idValue = imageId || generateId();
    const timestamp = nowIso();
    const fileSize = file.size || file.byteLength || 0;
    const resource = syncFields({
      id: idValue,
      companyId,
      invoiceId,
      originalFileName: file.name || '',
      localId: idValue,
      localImageKey: idValue,
      cloudImageUrl: '',
      storageType: 'indexeddb',
      imageStatus: 'local',
      fileSize,
      mimeType: file.type || 'image/jpeg',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const record = {
      ...resource,
      imageBlob: file,
      fileName: file.name || '',
      size: fileSize,
      source,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await put('invoice_images', record);
    await put('invoice_image_resources', resource);
    const saved = await get('invoice_images', idValue);
    if (!saved?.imageBlob) {
      await put('invoice_image_resources', syncFields({ ...resource, imageStatus: 'failed', updatedAt: nowIso(), errorReason: 'IndexedDB blob missing after save' }));
      throw new Error('图片保存失败，请重新选择图片');
    }
    return { ...record, ...resource };
  },

  async getInvoiceImage(invoice) {
    if (typeof invoice === 'string') invoice = { imageId: invoice };
    const imageId = invoice?.imageId || invoice?.localImageKey || String(invoice?.imagePath || '').replace(/^indexeddb:/, '');
    const imageIds = [imageId].filter(Boolean);
    if (invoice?.id) {
      const images = await all('invoice_images');
      const invoiceIds = idsFor(invoice);
      const byInvoice = images
        .filter((image) => belongsToCurrentCompany(image) && invoiceIds.includes(image.invoiceId))
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
      if (byInvoice?.imageBlob) return byInvoice;
    }
    for (const idValue of imageIds) {
      const image = await get('invoice_images', idValue);
      if (image?.imageBlob && belongsToCurrentCompany(image)) return image;
    }
    return null;
  },

  async getInvoiceImageResource(invoice) {
    if (typeof invoice === 'string') invoice = { imageId: invoice };
    const imageId = invoice?.imageId || invoice?.localImageKey || String(invoice?.imagePath || '').replace(/^indexeddb:/, '');
    const resources = (await all('invoice_image_resources')).filter((resource) => belongsToCurrentCompany(resource));
    const invoiceIds = idsFor(invoice);
    const byInvoice = invoice?.id
      ? resources.filter((resource) => invoiceIds.includes(resource.invoiceId)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]
      : null;
    const direct = imageId ? await get('invoice_image_resources', imageId) : null;
    if (byInvoice) return byInvoice;
    if (direct && belongsToCurrentCompany(direct)) return direct;
    return {
      id: imageId || '',
      companyId: getCurrentCompanyId(),
      invoiceId: invoice?.id || '',
      originalFileName: invoice?.originalFileName || '',
      localImageKey: imageId || '',
      cloudImageUrl: invoice?.cloudImageUrl || '',
      storageType: String(invoice?.imagePath || '').startsWith('indexeddb:') || imageId ? 'indexeddb' : (invoice?.imagePath ? 'server' : ''),
      imageStatus: 'missing',
      fileSize: 0,
      createdAt: '',
      updatedAt: ''
    };
  },

  async verifyInvoiceImage(invoice) {
    const resource = await localDb.getInvoiceImageResource(invoice);
    const persistResourceStatus = async (status, errorReason = '') => {
      const next = { ...resource, imageStatus: status, errorReason };
      const changed = resource?.imageStatus !== status || String(resource?.errorReason || '') !== String(errorReason || '');
      if (resource?.id && changed) {
        const updated = syncFields({ ...next, updatedAt: nowIso() }, resource.syncStatus || 'pending');
        await put('invoice_image_resources', updated);
        return updated;
      }
      return next;
    };
    const imagePath = String(invoice?.imagePath || '');
    if (!imagePath && !invoice?.imageId && !resource?.localImageKey && !resource?.cloudImageUrl) {
      return { ok: false, status: 'missing', resource: { ...resource, imageStatus: 'missing' }, message: '本地图片已丢失，请重新绑定图片。' };
    }
    if (imagePath.startsWith('indexeddb:') || invoice?.imageId || resource?.localImageKey) {
      const image = await localDb.getInvoiceImage(invoice);
      if (image?.imageBlob) {
        const okResource = await persistResourceStatus(resource?.cloudImageUrl ? 'uploaded' : 'local', '');
        return { ok: true, status: okResource.imageStatus, image, resource: okResource };
      }
      const missingResource = await persistResourceStatus('missing', 'IndexedDB image blob missing');
      return { ok: false, status: 'missing', resource: missingResource, message: '本地图片已丢失，请重新绑定图片。' };
    }
    if (imagePath.startsWith('blob:')) {
      const missingResource = await persistResourceStatus('missing', 'Saved blob URL is not durable');
      return { ok: false, status: 'missing', resource: missingResource, message: '本地图片已丢失，请重新绑定图片。' };
    }
    return { ok: true, status: resource?.cloudImageUrl ? 'uploaded' : 'server', resource };
  },

  async updateInvoiceImageFields(invoiceId, fields) {
    const detail = await localDb.getInvoice(invoiceId);
    if (!detail) throw new Error('Invoice not found');
    const updated = syncFields({ ...detail.invoice, ...fields });
    await put('invoices', updated);
    return updated;
  },

  async updateInvoiceFields(invoiceId, fields) {
    const detail = await localDb.getInvoice(invoiceId);
    if (!detail) throw new Error('Invoice not found');
    const before = detail.invoice;
    const supplierInput = {
      id: before.supplierId || '',
      name: fields.supplierName || fields.supplierDisplayName || before.supplierName || '',
      displayName: fields.supplierDisplayName || fields.supplierName || before.supplierName || '',
      supplierDisplayName: fields.supplierDisplayName || fields.supplierName || before.supplierName || '',
      supplierNameChinese: fields.supplierNameChinese || '',
      supplierNameEnglish: fields.supplierNameEnglish || ''
    };
    const supplier = (supplierInput.name || supplierInput.supplierNameChinese || supplierInput.supplierNameEnglish)
      ? await localDb.saveSupplier(supplierInput)
      : null;
    const supplierName = supplierDisplayName(supplier) || fields.supplierName || before.supplierName || '';
    const calculatedTotal = Number(before.calculatedTotal || detail.items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0));
    const updated = syncFields({
      ...before,
      ...fields,
      supplierId: supplier?.id || before.supplierId || '',
      supplierName,
      totalAmount: Number(fields.totalAmount ?? before.totalAmount ?? 0),
      subtotal: Number(fields.subtotal ?? before.subtotal ?? fields.totalAmount ?? before.totalAmount ?? 0),
      tax: Number(fields.tax ?? before.tax ?? 0),
      calculatedTotal,
      totalDifference: Math.abs(calculatedTotal - Number(fields.totalAmount ?? before.totalAmount ?? 0)),
      status: 'APPROVED'
    });
    await put('invoices', updated);
    const corrections = Object.entries(fields)
      .filter(([fieldName, afterValue]) => String(before[fieldName] ?? '') !== String(afterValue ?? ''))
      .map(([fieldName, afterValue]) => syncFields({
        fieldName: `invoices.${fieldName}`,
        beforeValue: String(before[fieldName] ?? ''),
        afterValue: String(afterValue ?? ''),
        supplierId: updated.supplierId || '',
        invoiceTemplateId: '',
        invoiceId: updated.id,
        invoiceItemId: ''
      }));
    if (corrections.length) await putMany('recognition_corrections', corrections);
    await localDb.rebuildInvoicePriceHistory(updated.id);
    return localDb.getInvoice(invoiceId);
  },

  async confirmInvoice(invoiceId, status = 'CONFIRMED') {
    const detail = await localDb.getInvoice(invoiceId);
    if (!detail) throw new Error('Invoice not found');
    const calculatedTotal = detail.items
      .filter((item) => !Number(item.isDiscountLine || 0) && !Number(item.candidateOnly || 0))
      .reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
    const updated = syncFields({
      ...detail.invoice,
      status,
      duplicateStatus: status === 'CONFIRMED' ? (detail.invoice.duplicateStatus === 'possible' ? 'none' : detail.invoice.duplicateStatus) : detail.invoice.duplicateStatus,
      recognitionWarnings: status === 'CONFIRMED' ? '' : detail.invoice.recognitionWarnings,
      calculatedTotal,
      totalDifference: status === 'CONFIRMED' ? 0 : Math.abs(calculatedTotal - Number(detail.invoice.totalAmount || 0))
    });
    await put('invoices', updated);
    await localDb.rebuildInvoicePriceHistory(updated.id);
    return localDb.getInvoice(invoiceId);
  },

  async updateInvoiceDuplicateStatus(invoiceId, duplicateStatus, status = '') {
    const detail = await localDb.getInvoice(invoiceId);
    if (!detail) throw new Error('Invoice not found');
    const updated = syncFields({
      ...detail.invoice,
      duplicateStatus,
      status: status || detail.invoice.status || 'APPROVED'
    });
    await put('invoices', updated);
    return localDb.getInvoice(invoiceId);
  },

  async rebuildInvoicePriceHistory(invoiceId) {
    const detail = await localDb.getInvoice(invoiceId);
    if (!detail) return;
    const invoiceIds = idsFor(detail.invoice);
    const itemIds = detail.items.flatMap(idsFor);
    const existingRows = (await all('price_history')).filter((row) => itemIds.includes(row.invoiceItemId) || invoiceIds.includes(row.invoiceId));
    if (existingRows.length) {
      await putMany('price_history', existingRows.map((row) => syncFields({ ...row, deletedAt: nowIso(), status: 'deleted' }, 'deleted')));
    }
    const rows = [];
    for (const item of detail.items.filter((entry) => priceHistoryEligibleItem(entry, detail.invoice))) {
      const product = await upsertProductForItem(item);
      rows.push(syncFields({
        productId: product?.id || item.productId || '',
        invoiceId: detail.invoice.id,
        invoiceItemId: item.id,
        supplierId: detail.invoice.supplierId || item.supplierId || '',
        ...priceHistoryNameFields(item, product || {}),
        price: item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice,
        quantity: item.actualQty || item.totalQty || item.quantity,
        unit: item.unit || '',
        invoiceDate: detail.invoice.invoiceDate || today(),
        invoiceNo: detail.invoice.invoiceNo || '',
        status: approvedForStats(detail.invoice) ? 'confirmed' : 'pending_review'
      }));
    }
    if (rows.length) await putMany('price_history', rows);
  },

  async createInvoice(payload) {
    const supplier = payload.supplierId ? resolveByAnyId(await all('suppliers'), payload.supplierId) : await findOrCreateSupplier(payload.supplierName);
    const invoiceId = payload.id || generateId();
    const invoiceDate = payload.invoiceDate || today();
    const sourceContext = {
      source: payload.source || payload.recognitionSource || payload.itemRecognitionSource || '',
      usedAI: Boolean(payload.usedAI || String(payload.recognitionSource || '').toLowerCase().includes('ai'))
    };
    const { productItems, discountItems } = splitInvoiceRows(applyProductNameQuality((payload.items || []).filter((item) => (item.productNameOriginal || item.name || item.rawName || '').trim()), sourceContext));
    const items = applyGiftAccounting(productItems);
    const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
    const discountTotal = discountItems.reduce((sum, item) => sum + Number(item.totalPrice ?? item.amount ?? 0), 0);
    const totalAmount = Number(payload.totalAmount || 0) > 0 ? Number(payload.totalAmount) : itemTotal;
    const integrityWarnings = [];
    if (items.length === 0) integrityWarnings.push('EMPTY_ITEMS');
    const totalDifference = Math.abs(itemTotal + discountTotal - totalAmount);
    if (Number(totalAmount || 0) > 0 && totalDifference > 0.05) integrityWarnings.push('AMOUNT_MISMATCH');
    const invoiceStatus = integrityWarnings.length ? 'PENDING_REVIEW' : (payload.status || 'APPROVED');
    const existingInvoices = (await localDb.getInvoices()).filter((invoice) => idsFor(invoice).every((idValue) => idValue !== invoiceId));
    const duplicateInvoice = existingInvoices.find((invoice) => {
      const sameSupplier = supplier?.id && invoice.supplierId
        ? invoice.supplierId === supplier.id
        : normalizeSupplierName(invoice.supplierName || '') === normalizeSupplierName(payload.supplierName || supplierDisplayName(supplier));
      const sameInvoiceNo = payload.invoiceNo && invoice.invoiceNo && String(invoice.invoiceNo).trim().toLowerCase() === String(payload.invoiceNo).trim().toLowerCase();
      const sameDate = (invoice.invoiceDate || '') === (invoiceDate || '');
      const sameAmount = Math.abs(Number(invoice.totalAmount || 0) - totalAmount) < 0.01;
      return sameSupplier && sameInvoiceNo && sameDate && sameAmount;
    });
    if (duplicateInvoice && !payload.forceSave) {
      const error = new Error('可能重复发票，是否强制保存');
      error.duplicateStatus = 'duplicate';
      error.duplicateCheck = {
        isDuplicate: true,
        duplicate: true,
        duplicateStatus: 'duplicate',
        duplicateOfInvoiceId: duplicateInvoice.id,
        duplicateInvoiceId: duplicateInvoice.id,
        invoiceNo: duplicateInvoice.invoiceNo || '',
        supplier: duplicateInvoice.supplierName || '',
        invoiceDate: duplicateInvoice.invoiceDate || '',
        totalAmount: Number(duplicateInvoice.totalAmount || 0)
      };
      throw error;
    }
    const invoice = syncFields({
      id: invoiceId,
      batchId: payload.batchId || '',
      supplierId: supplier?.id || '',
      invoiceNo: payload.invoiceNo || '',
      invoiceDate,
      pageNumber: Number(payload.pageNumber || 0),
      pageCount: Number(payload.pageCount || 0),
      invoiceGroupKey: payload.invoiceGroupKey || [payload.supplierName || supplierDisplayName(supplier), payload.invoiceNo || '', Number(totalAmount || 0).toFixed(2)].join('|').toLowerCase(),
      invoiceLayoutType: payload.invoiceLayoutType || 'normal_invoice',
      imageId: payload.imageId || '',
      imageUrl: payload.imageUrl || '',
      imagePath: payload.imagePath || '',
      ocrText: payload.ocrText || '',
      subtotal: Number(payload.subtotal || totalAmount || 0),
      tax: Number(payload.tax || 0),
      totalAmount,
      calculatedTotal: itemTotal,
      totalDifference,
      duplicateStatus: duplicateInvoice ? 'duplicate' : (payload.duplicateStatus || 'none'),
      duplicateOfInvoiceId: duplicateInvoice?.id || payload.duplicateOfInvoiceId || '',
      isMultiPage: payload.isMultiPage ? 1 : 0,
      mergedInvoiceIds: payload.mergedInvoiceIds || '[]',
      recognitionWarnings: [payload.recognitionWarnings || '', ...integrityWarnings].filter(Boolean).join(' | '),
      status: invoiceStatus
    });
    await put('invoices', invoice);

    for (const rawItem of items) {
      const item = syncFields({
        ...rawItem,
        id: rawItem.id || generateId(),
        invoiceId: invoice.id,
        supplierId: supplier?.id || '',
        rawName: rawItem.rawName || displayItemName(rawItem),
        nameCn: rawItem.nameCn || '',
        nameEn: rawItem.nameEn || '',
        spec: rawItem.spec || '',
        productNameOriginal: rawItem.productNameOriginal || displayItemName(rawItem),
        productNameNormalized: normalizeProductName(rawItem.productNameNormalized || rawItem.productNameOriginal || ''),
        normalizedName: normalizeProductName(rawItem.normalizedName || rawItem.productNameNormalized || rawItem.productNameOriginal || ''),
        nameConfidence: Number(rawItem.nameConfidence ?? rawItem.itemConfidence ?? 0),
        nameQualityStatus: rawItem.nameQualityStatus || 'trusted',
        nameQualityReason: rawItem.nameQualityReason || '',
        rawOcrLine: rawItem.rawOcrLine || '',
        itemRecognitionSource: rawItem.itemRecognitionSource || sourceContext.source || '',
        quantity: Number(rawItem.quantity || 0),
        unit: rawItem.unit || '',
        unitPrice: Number(rawItem.unitPrice || 0),
        totalPrice: Number(rawItem.totalPrice || 0),
        chargedQty: Number(rawItem.chargedQty || 0),
        freeQty: Number(rawItem.freeQty || 0),
        totalQty: Number(rawItem.totalQty || rawItem.quantity || 0),
        actualQty: Number(rawItem.actualQty || rawItem.totalQty || rawItem.quantity || 0),
        originalUnitCost: Number(rawItem.originalUnitCost || rawItem.unitPrice || 0),
        effectiveUnitCost: Number(rawItem.effectiveUnitCost || rawItem.unitPrice || 0),
        discountedEffectiveUnitCost: Number(rawItem.discountedEffectiveUnitCost || rawItem.effectiveUnitCost || rawItem.unitPrice || 0),
        discountAmount: Number(rawItem.discountAmount || 0),
        promoGroupId: rawItem.promoGroupId || '',
        promoGroupName: rawItem.promoGroupName || '',
        promoGroupRule: rawItem.promoGroupRule || '',
        participatesInGiftAllocation: rawItem.participatesInGiftAllocation ? 1 : 0,
        isFreeItem: rawItem.isFreeItem ? 1 : 0,
        isDiscountLine: 0,
        candidateOnly: rawItem.candidateOnly ? 1 : 0,
        correctedByUser: rawItem.correctedByUser ? 1 : 0,
        isHandwrittenQuantity: rawItem.isHandwrittenQuantity ? 1 : 0,
        isHandwrittenPrice: rawItem.isHandwrittenPrice ? 1 : 0,
        isHandwrittenAmount: rawItem.isHandwrittenAmount ? 1 : 0,
        isCircled: rawItem.isCircled ? 1 : 0,
        isChecked: rawItem.isChecked ? 1 : 0,
        freeReason: rawItem.freeReason || '',
        invoiceDate
      });
      await put('invoice_items', item);
      if (priceHistoryEligibleItem(item, invoice)) {
        const product = await upsertProductForItem(item);
        await put('price_history', syncFields({
          productId: product?.id || '',
          invoiceId: invoice.id,
          invoiceItemId: item.id,
          supplierId: supplier?.id || '',
          ...priceHistoryNameFields(item, product || {}),
          price: item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice,
          quantity: item.actualQty || item.totalQty || item.quantity,
          unit: item.unit,
          invoiceDate,
          invoiceNo: invoice.invoiceNo || '',
          status: 'confirmed'
        }));
      }
    }
    for (const rawDiscount of discountItems) {
      await put('invoice_discounts', syncFields({
        invoiceId: invoice.id,
        supplierId: supplier?.id || '',
        discountName: displayItemName(rawDiscount) || 'Discount',
        amount: Number(rawDiscount.totalPrice ?? rawDiscount.amount ?? 0),
        discountType: 'unknown',
        appliedToProductIds: ''
      }));
    }
    return invoice;
  },

  async getInvoices() {
    const suppliers = await all('suppliers');
    const invoiceItems = (await all('invoice_items')).filter(active);
    return (await all('invoices')).filter((invoice) => active(invoice) && !['merged', 'hidden'].includes(invoice.status)).map((invoice) => {
      const supplier = resolveByAnyId(suppliers, invoice.supplierId);
      const invoiceIds = [invoice.id, invoice.localId, invoice.serverId].filter(Boolean);
      const items = invoiceItems.filter((item) => invoiceIds.includes(item.invoiceId));
      return {
        ...invoice,
        supplierName: supplierDisplayName(supplier),
        itemCount: items.length,
        itemNames: items.map((item) => item.productNameNormalized || item.productNameOriginal || ''),
        itemTotal: items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0),
        itemTotalQuantity: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      };
    }).sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`));
  },

  async getInvoice(id) {
    const invoices = await all('invoices');
    const invoice = resolveByAnyId(invoices.filter(active), id);
    if (!invoice) return null;
    const suppliers = await all('suppliers');
    const supplier = resolveByAnyId(suppliers, invoice.supplierId);
    const invoiceIds = [invoice.id, invoice.localId, invoice.serverId].filter(Boolean);
    const items = (await all('invoice_items')).filter((item) => active(item) && invoiceIds.includes(item.invoiceId));
    const discounts = (await all('invoice_discounts')).filter((discount) => active(discount) && invoiceIds.includes(discount.invoiceId));
    const mergedIds = parseJsonList(invoice.mergedInvoiceIds);
    const mergedInvoices = invoices.filter((entry) => mergedIds.some((idValue) => idsFor(entry).includes(idValue)));
    return { invoice: { ...invoice, supplierName: supplierDisplayName(supplier) }, items, discounts, mergedInvoices };
  },

  async getMergeCandidates(invoiceId) {
    const invoices = await localDb.getInvoices();
    const master = invoices.find((invoice) => idsFor(invoice).includes(invoiceId));
    if (!master) return [];
    const masterIds = idsFor(master);
    return invoices.filter((invoice) => {
      if (idsFor(invoice).some((idValue) => masterIds.includes(idValue))) return false;
      if (master.batchId && invoice.batchId === master.batchId) return true;
      if (master.scanBatchId && invoice.scanBatchId === master.scanBatchId) return true;
      return master.supplierId && invoice.supplierId === master.supplierId && master.invoiceNo && invoice.invoiceNo === master.invoiceNo;
    }).map((invoice) => ({
      ...invoice,
      possibleSameInvoice: Boolean(
        (master.batchId && invoice.batchId === master.batchId)
        || (master.supplierId === invoice.supplierId && master.invoiceNo && invoice.invoiceNo === master.invoiceNo)
      )
    }));
  },

  async mergeSuppliers(sourceSupplierId, targetSupplierId) {
    const suppliers = await all('suppliers');
    const source = resolveByAnyId(suppliers, sourceSupplierId);
    const target = resolveByAnyId(suppliers, targetSupplierId);
    if (!source || !target) throw new Error('Supplier not found');
    const sourceIds = idsFor(source);
    const targetId = target.serverId || target.id;
    const tablesWithSupplier = ['invoices', 'invoice_items', 'invoice_discounts', 'gift_allocation_rules', 'price_history', 'product_aliases', 'product_learning_rules', 'recognition_corrections', 'price_anomalies', 'supplier_templates'];
    for (const table of tablesWithSupplier) {
      const rows = await all(table);
      await putMany(table, rows
        .filter((row) => sourceIds.includes(row.supplierId))
        .map((row) => syncFields({ ...row, supplierId: targetId })));
    }
    const mergedDisplayName = buildSupplierDisplayName({
      supplierNameChinese: target.supplierNameChinese || source.supplierNameChinese,
      supplierNameEnglish: target.supplierNameEnglish || source.supplierNameEnglish,
      supplierDisplayName: target.supplierDisplayName || target.displayName || target.name,
      displayName: source.supplierDisplayName || source.displayName || source.name
    });
    const mergedParts = splitSupplierNameParts(mergedDisplayName);
    await put('suppliers', syncFields({
      ...target,
      name: mergedDisplayName,
      displayName: mergedDisplayName,
      supplierNameChinese: target.supplierNameChinese || source.supplierNameChinese || mergedParts.supplierNameChinese,
      supplierNameEnglish: target.supplierNameEnglish || source.supplierNameEnglish || mergedParts.supplierNameEnglish,
      supplierDisplayName: mergedDisplayName,
      aliases: JSON.stringify(mergeJsonLists(target.aliases, source.aliases, supplierAliasesFromName(source.supplierDisplayName || source.displayName || source.name || ''), source.supplierNameChinese, source.supplierNameEnglish)),
      templateIds: JSON.stringify(mergeJsonLists(target.templateIds, source.templateIds))
    }));
    await put('suppliers', syncFields({ ...source, status: 'merged', suspectedDuplicateOf: targetId, deletedAt: nowIso() }, 'deleted'));
  },

  async deleteInvoice(id) {
    const detail = await localDb.getInvoice(id);
    if (!detail) return;
    const deletedAt = nowIso();
    await put('invoices', syncFields({ ...detail.invoice, deletedAt }, 'deleted'));
    await putMany('invoice_items', detail.items.map((item) => syncFields({ ...item, deletedAt }, 'deleted')));
    await putMany('invoice_discounts', (detail.discounts || []).map((discount) => syncFields({ ...discount, deletedAt }, 'deleted')));
    const invoiceIds = idsFor(detail.invoice);
    const pageRows = (await all('invoice_pages')).filter((page) => active(page) && invoiceIds.includes(page.invoiceId));
    if (pageRows.length) {
      await putMany('invoice_pages', pageRows.map((page) => syncFields({ ...page, deletedAt }, 'deleted')));
    }
    const imageIds = new Set([detail.invoice.imageId, ...pageRows.map((page) => page.imageId)].filter(Boolean));
    const imageRows = (await all('invoice_images')).filter((image) => {
      if (!belongsToCurrentCompany(image)) return false;
      return imageIds.has(image.id) || invoiceIds.includes(image.invoiceId) || pageRows.some((page) => page.id === image.invoiceId);
    });
    for (const image of imageRows) {
      await remove('invoice_images', image.id);
    }
    const itemIds = detail.items.flatMap(idsFor);
    const priceRows = (await all('price_history')).filter((row) => itemIds.includes(row.invoiceItemId) || (detail.invoice.invoiceNo && row.invoiceNo === detail.invoice.invoiceNo && row.supplierId === detail.invoice.supplierId));
    if (priceRows.length) {
      await putMany('price_history', priceRows.map((row) => syncFields({ ...row, deletedAt, status: 'deleted' }, 'deleted')));
    }
    if (detail.invoice.batchId) {
      const activeBatchInvoices = (await all('invoices')).filter((invoice) => active(invoice) && invoice.batchId === detail.invoice.batchId && !idsFor(invoice).includes(detail.invoice.id));
      if (activeBatchInvoices.length === 0) {
        const batch = resolveByAnyId(await all('purchase_batches'), detail.invoice.batchId);
        if (batch) await put('purchase_batches', syncFields({ ...batch, deletedAt }, 'deleted'));
      }
    }
  },

  async updateInvoiceItems(invoiceId, nextItems, beforeItems = []) {
    const detail = await localDb.getInvoice(invoiceId);
    if (!detail) throw new Error('Invoice not found');
    const { invoice } = detail;
    const now = nowIso();
    const existingById = new Map(beforeItems.map((item) => [item.id, item]));
    const requestedById = new Map((nextItems || []).map((item) => [item.id, item]));
    const recalculated = applyGiftAccounting((nextItems || []).map((item) => ({
      ...item,
      id: item.id || generateId(),
      invoiceId: invoice.id,
      supplierId: invoice.supplierId || item.supplierId || '',
      rawName: item.rawName || displayItemName(item),
      nameCn: item.nameCn || '',
      nameEn: item.nameEn || '',
      spec: item.spec || '',
      productNameOriginal: item.productNameOriginal || displayItemName(item),
      productNameNormalized: normalizeProductName(item.productNameNormalized || item.normalizedName || item.productNameOriginal || displayItemName(item)),
      normalizedName: normalizeProductName(item.normalizedName || item.productNameNormalized || item.productNameOriginal || displayItemName(item)),
      nameConfidence: item.correctedByUser ? 1 : Number(item.nameConfidence ?? item.itemConfidence ?? 0),
      nameQualityStatus: item.correctedByUser ? 'trusted' : (item.nameQualityStatus || 'trusted'),
      nameQualityReason: item.correctedByUser ? '' : (item.nameQualityReason || ''),
      rawOcrLine: item.rawOcrLine || '',
      itemRecognitionSource: item.itemRecognitionSource || '',
      quantity: Number(item.quantity || 0),
      unit: item.unit || '',
      unitPrice: Number(item.unitPrice || 0),
      totalPrice: Number(item.totalPrice || 0),
      isFreeItem: item.isFreeItem ? 1 : 0,
      participatesInGiftAllocation: item.participatesInGiftAllocation ? 1 : 0,
      correctedByUser: 1,
      invoiceDate: invoice.invoiceDate || today(),
      updatedAt: now
    })));
    const savedItems = recalculated.map((item) => syncFields({
      ...item,
      chargedQty: Number(item.chargedQty || 0),
      freeQty: Number(item.freeQty || 0),
      totalQty: Number(item.totalQty || item.actualQty || item.quantity || 0),
      actualQty: Number(item.actualQty || item.totalQty || item.quantity || 0),
      originalUnitCost: Number(requestedById.get(item.id)?.manualCostOverride ? requestedById.get(item.id)?.originalUnitCost : (item.originalUnitCost || item.unitPrice || 0)),
      effectiveUnitCost: Number(requestedById.get(item.id)?.manualCostOverride ? requestedById.get(item.id)?.effectiveUnitCost : (item.effectiveUnitCost || item.unitPrice || 0)),
      discountedEffectiveUnitCost: Number(item.discountedEffectiveUnitCost || (requestedById.get(item.id)?.manualCostOverride ? requestedById.get(item.id)?.effectiveUnitCost : item.effectiveUnitCost) || item.unitPrice || 0),
      discountAmount: Number(item.discountAmount || 0),
      candidateOnly: item.candidateOnly ? 1 : 0,
      isDiscountLine: item.isDiscountLine ? 1 : 0
    }));
    await putMany('invoice_items', savedItems);

    const calculatedTotal = savedItems
      .filter((item) => !Number(item.isDiscountLine || 0) && !Number(item.candidateOnly || 0))
      .reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
    const nextDifference = Math.abs(calculatedTotal - Number(invoice.totalAmount || 0));
    const nextWarnings = [];
    if (savedItems.length === 0) nextWarnings.push('EMPTY_ITEMS');
    if (Number(invoice.totalAmount || 0) > 0 && nextDifference > 0.05) nextWarnings.push('AMOUNT_MISMATCH');
    const updatedInvoice = syncFields({
      ...invoice,
      calculatedTotal,
      totalDifference: nextDifference,
      recognitionWarnings: nextWarnings.length ? [invoice.recognitionWarnings || '', ...nextWarnings].filter(Boolean).join(' | ') : invoice.recognitionWarnings,
      status: nextWarnings.length ? 'PENDING_REVIEW' : 'APPROVED'
    });
    await put('invoices', syncFields({
      ...updatedInvoice
    }));

    const correctionFields = ['nameCn', 'nameEn', 'spec', 'productNameOriginal', 'productNameNormalized', 'quantity', 'unit', 'unitPrice', 'totalPrice', 'isFreeItem', 'promoGroupId', 'promoGroupName', 'chargedQty', 'freeQty', 'actualQty', 'effectiveUnitCost'];
    const corrections = [];
    for (const item of savedItems) {
      const before = existingById.get(item.id) || {};
      for (const fieldName of correctionFields) {
        const beforeValue = String(before[fieldName] ?? '');
        const afterValue = String(item[fieldName] ?? '');
        if (beforeValue !== afterValue) {
          corrections.push(syncFields({
            fieldName: `invoice_items.${fieldName}`,
            beforeValue,
            afterValue,
            supplierId: invoice.supplierId || '',
            invoiceTemplateId: '',
            invoiceId: invoice.id,
            invoiceItemId: item.id
          }));
        }
      }
    }
    if (corrections.length) await putMany('recognition_corrections', corrections);

    const savedItemIds = savedItems.flatMap(idsFor);
    const existingPrices = (await all('price_history')).filter((row) => savedItemIds.includes(row.invoiceItemId));
    if (existingPrices.length) {
      await putMany('price_history', existingPrices.map((row) => syncFields({ ...row, deletedAt: nowIso(), status: 'deleted' }, 'deleted')));
    }

    for (const item of savedItems.filter((entry) => priceHistoryEligibleItem(entry, updatedInvoice))) {
      const product = await upsertProductForItem(item);
      await put('product_aliases', syncFields({
        keyword: normalizeProductName(item.rawName || item.productNameOriginal || ''),
        aliasName: item.rawName || item.productNameOriginal || '',
        normalizedAlias: normalizeProductName(item.rawName || item.productNameOriginal || ''),
        standardName: item.productNameNormalized || item.productNameOriginal || '',
        productId: product?.id || item.productId || '',
        supplierId: invoice.supplierId || '',
        rawName: item.rawName || '',
        nameCn: item.nameCn || '',
        nameEn: item.nameEn || '',
        spec: item.spec || '',
        unit: item.unit || '',
        confidence: 1,
        createdByUser: 1
      }));
      await put('price_history', syncFields({
        productId: product?.id || item.productId || '',
        invoiceItemId: item.id,
        supplierId: updatedInvoice.supplierId || '',
        ...priceHistoryNameFields(item, product || {}),
        price: item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice,
        quantity: item.actualQty || item.totalQty || item.quantity,
        unit: item.unit || '',
        invoiceDate: updatedInvoice.invoiceDate || today(),
        invoiceNo: updatedInvoice.invoiceNo || '',
        invoiceId: updatedInvoice.id,
        status: 'confirmed'
      }));
    }

    const groups = summarizeLocalPromoGroups(savedItems);
    if (groups.length) {
      await putMany('gift_allocation_rules', groups.map((group) => syncFields({
        supplierId: invoice.supplierId || '',
        ruleKey: group.id,
        productNames: JSON.stringify(group.productNames),
        promoGroupName: group.name,
        promoGroupRule: group.rule,
        chargedQty: group.chargedQty,
        freeQty: group.freeQty,
        actualQty: group.actualQty,
        invoiceAmount: group.invoiceAmount,
        originalUnitCost: group.originalUnitCost,
        effectiveUnitCost: group.effectiveUnitCost
      })));
    }
    return localDb.getInvoice(invoiceId);
  },

  async repairPriceHistoryProductNames() {
    const priceRows = (await all('price_history')).filter((row) => belongsToCurrentCompany(row) && active(row));
    const items = (await all('invoice_items')).filter((item) => belongsToCurrentCompany(item) && active(item));
    const products = (await all('products')).filter((product) => belongsToCurrentCompany(product) && active(product));
    const itemById = new Map(items.flatMap((item) => idsFor(item).map((idValue) => [idValue, item])));
    const productById = new Map(products.flatMap((product) => idsFor(product).map((idValue) => [idValue, product])));
    const repaired = [];
    for (const row of priceRows) {
      const item = itemById.get(row.invoiceItemId) || {};
      const product = productById.get(row.productId) || {};
      const existingName = String(row.productName || row.productNameOriginal || row.productNameNormalized || row.normalizedName || row.itemName || row.name || '').trim();
      const fallbackName = productRawName(row, item, product) || productStandardName(row, item, product);
      if (existingName || !fallbackName) continue;
      repaired.push(syncFields({
        ...row,
        ...priceHistoryNameFields(item, product),
        syncStatus: row.syncStatus === 'synced' ? 'pending' : row.syncStatus
      }, row.deletedAt ? 'deleted' : (row.syncStatus === 'synced' ? 'pending' : row.syncStatus || 'pending')));
    }
    if (repaired.length) await putMany('price_history', repaired);
    return repaired.length;
  },

  async searchProducts(query) {
    await localDb.repairPriceHistoryProductNames();
    const q = normalizeProductName(query);
    const allInvoices = await all('invoices');
    const invoiceAnyById = new Map(allInvoices.flatMap((invoice) => idsFor(invoice).map((idValue) => [idValue, invoice])));
    const invoiceRecordUsable = (invoiceId) => {
      if (!invoiceId) return true;
      const invoice = invoiceAnyById.get(invoiceId);
      return invoice ? active(invoice) : true;
    };
    const allActiveInvoices = allInvoices.filter(active);
    const invoiceById = new Map(allActiveInvoices.flatMap((invoice) => idsFor(invoice).map((idValue) => [idValue, invoice])));
    const approvedInvoiceIds = invoiceIdSet(allActiveInvoices.filter(approvedForStats));
    const suppliers = await all('suppliers');
    const products = (await all('products')).filter(active);
    const productById = new Map(products.flatMap((product) => idsFor(product).map((idValue) => [idValue, product])));
    const aliases = (await all('product_aliases')).filter(active);
    const aliasProductIds = new Set(aliases
      .filter((alias) => `${normalizeProductName(alias.aliasName || alias.rawName || alias.keyword || '')} ${normalizeProductName(alias.normalizedAlias || '')} ${normalizeProductName(alias.standardName || '')}`.includes(q))
      .map((alias) => alias.productId)
      .filter(Boolean));
    const allItems = (await all('invoice_items')).filter((item) => {
      if (!active(item) || Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0) || !trustedItemName(item)) return false;
      if (!invoiceRecordUsable(item.invoiceId)) return false;
      return true;
    });
    const itemById = new Map(allItems.flatMap((item) => idsFor(item).map((idValue) => [idValue, item])));
    const itemRecords = allItems.filter((item) => {
      if (!q) return true;
      const haystack = productSearchText(item, item, productById.get(item.productId) || {});
      return haystack.includes(q) || aliasProductIds.has(item.productId);
    }).map((item) => {
      const product = productById.get(item.productId) || {};
      return {
        ...item,
        sourceType: 'invoice_item',
        displayName: productDisplayName(item, item, product),
        standardName: productStandardName(item, item, product),
        effectiveSearchPrice: Number(item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice || 0)
      };
    });
    const priceRecordsFromHistory = (await all('price_history')).filter((row) => {
      if (!active(row) || ['deleted', 'inactive'].includes(String(row.status || '').toLowerCase())) return false;
      const invoice = invoiceById.get(row.invoiceId);
      if (!invoiceRecordUsable(row.invoiceId)) return false;
      const item = itemById.get(row.invoiceItemId) || {};
      const product = productById.get(row.productId) || {};
      if (Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0) || Number(item.isFreeItem || 0)) return false;
      if (!q) return true;
      return productSearchText(row, item, product).includes(q) || aliasProductIds.has(row.productId);
    }).map((row) => {
      const item = itemById.get(row.invoiceItemId) || {};
      const product = productById.get(row.productId) || {};
      const invoice = invoiceById.get(row.invoiceId);
      return {
        ...item,
        ...row,
        sourceType: 'price_history',
        invoiceId: row.invoiceId || item.invoiceId,
        supplierId: row.supplierId || item.supplierId || invoice?.supplierId || '',
        invoiceDate: row.invoiceDate || item.invoiceDate || invoice?.invoiceDate || '',
        displayName: productDisplayName(row, item, product),
        standardName: productStandardName(row, item, product),
        effectiveSearchPrice: Number(row.price || item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice || 0)
      };
    });
    const recordsByKey = new Map();
    for (const record of [...itemRecords, ...priceRecordsFromHistory]) {
      const key = record.invoiceItemId || record.id || `${record.productId || record.standardName}-${record.invoiceId}-${record.invoiceDate}`;
      if (!recordsByKey.has(key) || record.sourceType === 'price_history') recordsByKey.set(key, record);
    }
    const items = [...recordsByKey.values()].filter((record) => productDisplayName(record, record, productById.get(record.productId) || {}) !== '未命名商品');
    console.info('[ProductSearch] local index', {
      companyId: getCurrentCompanyId(),
      keyword: query,
      normalizedKeyword: q,
      invoices: allInvoices.length,
      activeInvoices: allActiveInvoices.length,
      invoiceItems: allItems.length,
      products: products.length,
      priceHistory: (await all('price_history')).filter((row) => belongsToCurrentCompany(row) && active(row)).length,
      generatedPriceIndex: items.length
    });
    const groups = new Map();
    for (const item of items) {
      const key = item.productId || normalizeProductName(item.standardName || item.productNameNormalized || item.productNameOriginal || item.displayName);
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    const results = [...groups.entries()].map(([groupKey, records]) => {
      const sorted = [...records].sort((a, b) => `${b.invoiceDate}${b.createdAt}`.localeCompare(`${a.invoiceDate}${a.createdAt}`));
      const confirmedRecords = records.filter((record) => approvedInvoiceIds.has(record.invoiceId));
      const groupedPriceRecords = confirmedRecords.length ? confirmedRecords : records;
      const prices = groupedPriceRecords.map((record) => Number(record.effectiveSearchPrice || record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice || record.price || 0)).filter((price) => price > 0);
      const recentInvoice = invoiceById.get(sorted[0]?.invoiceId);
      const recentSupplier = resolveByAnyId(suppliers, sorted[0]?.supplierId || recentInvoice?.supplierId);
      const product = productById.get(records[0]?.productId) || {};
      const productNameOriginal = productDisplayName(sorted[0], sorted[0], product);
      const productNameNormalized = productStandardName(sorted[0], sorted[0], product) || normalizeProductName(productNameOriginal);
      return {
        productId: records[0]?.productId || '',
        productName: productNameOriginal,
        name: productNameOriginal,
        productNameOriginal,
        productNameNormalized,
        normalizedName: normalizeProductName(productNameNormalized || productNameOriginal),
        standardName: productNameNormalized || productNameOriginal || groupKey,
        recentPrice: Number(sorted[0]?.effectiveSearchPrice || sorted[0]?.discountedEffectiveUnitCost || sorted[0]?.effectiveUnitCost || sorted[0]?.unitPrice || sorted[0]?.price || 0),
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
        averagePrice: prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 0,
        recentPurchaseDate: sorted[0]?.invoiceDate || '',
        recentSupplierName: supplierDisplayName(recentSupplier),
        recordCount: records.length,
        pendingCount: records.length - confirmedRecords.length
      };
    }).sort((a, b) => (b.recentPurchaseDate || '').localeCompare(a.recentPurchaseDate || '')).slice(0, q ? 100 : 20);
    console.info('[ProductSearch] final result count', {
      keyword: query,
      normalizedKeyword: q,
      finalResultCount: results.length
    });
    return results;
  },

  async getProduct(name) {
    await localDb.repairPriceHistoryProductNames();
    const suppliers = await all('suppliers');
    const allInvoices = await all('invoices');
    const invoiceAnyById = new Map(allInvoices.flatMap((invoice) => idsFor(invoice).map((idValue) => [idValue, invoice])));
    const invoiceRecordUsable = (invoiceId) => {
      if (!invoiceId) return true;
      const invoice = invoiceAnyById.get(invoiceId);
      return invoice ? active(invoice) : true;
    };
    const invoices = allInvoices.filter(active);
    const q = normalizeProductName(name);
    const products = (await all('products')).filter(active);
    const productById = new Map(products.flatMap((product) => idsFor(product).map((idValue) => [idValue, product])));
    const aliases = (await all('product_aliases')).filter(active);
    const aliasProductIds = new Set(aliases
      .filter((alias) => `${normalizeProductName(alias.aliasName || alias.rawName || alias.keyword || '')} ${normalizeProductName(alias.normalizedAlias || '')} ${normalizeProductName(alias.standardName || '')}`.includes(q) || alias.productId === name)
      .map((alias) => alias.productId)
      .filter(Boolean));
    const allItems = (await all('invoice_items')).filter((item) => {
      if (!active(item) || Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0) || !trustedItemName(item)) return false;
      if (!invoiceRecordUsable(item.invoiceId)) return false;
      const haystack = productSearchText(item, item, productById.get(item.productId) || {});
      return haystack.includes(q) || item.productId === name || aliasProductIds.has(item.productId);
    });
    const itemById = new Map(allItems.flatMap((item) => idsFor(item).map((idValue) => [idValue, item])));
    const priceRows = (await all('price_history')).filter((row) => {
      if (!active(row) || ['deleted', 'inactive'].includes(String(row.status || '').toLowerCase())) return false;
      const invoice = resolveByAnyId(invoices, row.invoiceId);
      if (!invoiceRecordUsable(row.invoiceId)) return false;
      const item = itemById.get(row.invoiceItemId) || {};
      const product = productById.get(row.productId) || {};
      const haystack = productSearchText(row, item, product);
      return haystack.includes(q) || row.productId === name || aliasProductIds.has(row.productId);
    }).map((row) => {
      const item = itemById.get(row.invoiceItemId) || {};
      const product = productById.get(row.productId) || {};
      return {
        ...item,
        ...row,
        productNameOriginal: productRawName(row, item, product),
        productNameNormalized: productStandardName(row, item, product),
        unitPrice: Number(row.price || item.unitPrice || 0),
        effectiveUnitCost: Number(row.price || item.effectiveUnitCost || item.unitPrice || 0),
        quantity: Number(row.quantity || item.quantity || 0)
      };
    });
    const rowsByKey = new Map();
    for (const row of [...allItems, ...priceRows]) {
      const key = row.invoiceItemId || row.id || `${row.productId}-${row.invoiceId}-${row.invoiceDate}`;
      if (!rowsByKey.has(key) || row.price) rowsByKey.set(key, row);
    }
    return [...rowsByKey.values()].map((item) => {
      const supplier = resolveByAnyId(suppliers, item.supplierId);
      const invoice = resolveByAnyId(invoices, item.invoiceId);
      const product = productById.get(item.productId) || {};
      return {
        ...item,
        productNameOriginal: productDisplayName(item, item, product),
        productNameNormalized: productStandardName(item, item, product),
        supplierName: supplierDisplayName(supplier),
        invoiceNo: invoice?.invoiceNo || item.invoiceNo || '',
        invoiceImagePath: invoice?.imagePath || '',
        invoiceRecordId: invoice?.id || '',
        invoiceStatus: invoice?.status || ''
      };
    }).sort((a, b) => `${b.invoiceDate}${b.createdAt}`.localeCompare(`${a.invoiceDate}${a.createdAt}`));
  },

  async getSupplierInvoices(supplierId, filters = {}) {
    const suppliers = await all('suppliers');
    const supplier = resolveByAnyId(suppliers, supplierId);
    const ids = [supplierId, supplier?.id, supplier?.localId, supplier?.serverId].filter(Boolean);
    const invoiceItems = (await all('invoice_items')).filter(active);
    const invoiceDiscounts = (await all('invoice_discounts')).filter(active);
    return (await all('invoices')).filter((invoice) => active(invoice) && ids.includes(invoice.supplierId)).map((invoice) => {
      const invoiceIds = [invoice.id, invoice.localId, invoice.serverId].filter(Boolean);
      const items = invoiceItems.filter((item) => invoiceIds.includes(item.invoiceId));
      const discounts = invoiceDiscounts.filter((discount) => invoiceIds.includes(discount.invoiceId));
      return {
        ...invoice,
        supplierName: supplierDisplayName(supplier),
        itemCount: items.length,
        hasGifts: items.some((item) => Number(item.isFreeItem || 0) || Number(item.freeQty || 0) > 0),
        hasDiscounts: discounts.length > 0,
        hasWarnings: Boolean(invoice.recognitionWarnings || invoice.duplicateStatus === 'possible'),
        isMultipage: invoice.status === 'recognized-multipage' || String(invoice.ocrText || '').includes('--- page ---')
      };
    }).filter((invoice) => {
      if (filters.dateFrom && String(invoice.invoiceDate || '') < filters.dateFrom) return false;
      if (filters.dateTo && String(invoice.invoiceDate || '') > filters.dateTo) return false;
      if (filters.invoiceNo && !String(invoice.invoiceNo || '').toLowerCase().includes(String(filters.invoiceNo).toLowerCase())) return false;
      if (filters.totalAmount && Math.abs(Number(invoice.totalAmount || 0) - Number(filters.totalAmount)) >= 0.01) return false;
      if (filters.amountMin && moneyNumber(invoice.totalAmount) < Number(filters.amountMin)) return false;
      if (filters.amountMax && moneyNumber(invoice.totalAmount) > Number(filters.amountMax)) return false;
      if (filters.hasGifts && !invoice.hasGifts) return false;
      if (filters.hasDiscounts && !invoice.hasDiscounts) return false;
      if (filters.hasWarnings && !invoice.hasWarnings) return false;
      if (filters.isMultipage && !invoice.isMultipage) return false;
      return true;
    }).sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`));
  },

  async getSupplierCenter(query = '') {
    const q = normalizeProductName(query);
    const supplierQ = normalizeSupplierName(query);
    const suppliers = (await all('suppliers')).filter((supplier) => active(supplier) && supplier.status !== 'merged');
    const allInvoices = (await all('invoices')).filter(active);
    const invoices = allInvoices.filter((invoice) => !['merged', 'hidden'].includes(invoice.status));
    const invoiceIdsForStats = invoiceIdSet(invoices);
    const items = (await all('invoice_items')).filter((item) => active(item) && invoiceIdsForStats.has(item.invoiceId) && !Number(item.candidateOnly || 0) && !Number(item.isDiscountLine || 0) && trustedItemName(item));
    const discounts = (await all('invoice_discounts')).filter((discount) => active(discount) && invoiceIdsForStats.has(discount.invoiceId));
    return suppliers.map((supplier) => {
      const supplierIds = idsFor(supplier);
      const supplierInvoices = invoices.filter((invoice) => supplierIds.includes(invoice.supplierId));
      const invoiceIds = new Set(supplierInvoices.flatMap((invoice) => idsFor(invoice)));
      const supplierItems = items.filter((item) => supplierIds.includes(item.supplierId) || invoiceIds.has(item.invoiceId));
      const supplierDiscounts = discounts.filter((discount) => supplierIds.includes(discount.supplierId) || invoiceIds.has(discount.invoiceId));
      const sortedInvoices = [...supplierInvoices].sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`));
      const skuSet = new Set(supplierItems.map((item) => item.productId || item.productNameNormalized || normalizeProductName(item.productNameOriginal || '')).filter(Boolean));
      const searchText = normalizeProductName([
        supplier.name,
        supplier.displayName,
        supplier.normalizedName,
        ...mergeJsonLists(supplier.aliases),
        supplier.contactName,
        supplier.phone,
        supplier.email,
        supplier.address,
        supplier.notes,
        ...supplierInvoices.map((invoice) => invoice.invoiceNo),
        ...supplierItems.map((item) => `${item.rawName || ''} ${item.productNameOriginal || ''} ${item.productNameNormalized || ''}`)
      ].join(' '));
      const supplierSearchText = normalizeSupplierName([
        supplier.name,
        supplier.displayName,
        supplier.normalizedName,
        ...mergeJsonLists(supplier.aliases)
      ].join(' '));
      return {
        ...supplier,
        name: supplierDisplayName(supplier),
        displayName: supplierDisplayName(supplier),
        supplierDisplayName: supplierDisplayName(supplier),
        totalPurchaseAmount: supplierInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
        invoiceCount: supplierInvoices.length,
        recentPurchaseDate: sortedInvoices[0]?.invoiceDate || '',
        recentPurchaseAmount: moneyNumber(sortedInvoices[0]?.totalAmount || 0),
        skuCount: skuSet.size,
        freeQtyTotal: supplierItems.reduce((sum, item) => sum + moneyNumber(item.freeQty), 0),
        discountTotal: supplierDiscounts.reduce((sum, discount) => sum + moneyNumber(discount.amount), 0),
        abnormalInvoiceCount: allInvoices.filter((invoice) => supplierIds.includes(invoice.supplierId) && abnormalInvoice(invoice)).length,
        totalPurchaseQty: supplierItems.reduce((sum, item) => sum + moneyNumber(item.actualQty || item.totalQty || item.quantity), 0),
        searchText,
        supplierSearchText
      };
    }).filter((supplier) => !q || supplier.searchText.includes(q) || supplier.supplierSearchText.includes(supplierQ)).sort((a, b) => b.totalPurchaseAmount - a.totalPurchaseAmount);
  },

  async getSupplierDetail(supplierId) {
    const suppliers = await localDb.getSupplierCenter('');
    const supplier = suppliers.find((entry) => idsFor(entry).includes(supplierId));
    if (!supplier) return null;
    const invoices = await localDb.getSupplierInvoices(supplierId);
    return {
      supplier,
      invoices,
      stats: {
        totalPurchaseAmount: supplier.totalPurchaseAmount,
        totalPurchaseQty: supplier.totalPurchaseQty,
        invoiceCount: supplier.invoiceCount,
        averageOrderAmount: supplier.invoiceCount ? supplier.totalPurchaseAmount / supplier.invoiceCount : 0,
        recentPurchaseDate: supplier.recentPurchaseDate,
        recentPurchaseAmount: supplier.recentPurchaseAmount,
        recentPriceChange: ''
      }
    };
  },

  async getSupplierProducts(supplierId, sortBy = 'recent') {
    const suppliers = await all('suppliers');
    const supplier = resolveByAnyId(suppliers, supplierId);
    const supplierIds = idsFor(supplier, supplierId);
    const invoices = (await all('invoices')).filter(approvedForStats);
    const approvedInvoiceIds = invoiceIdSet(invoices);
    const invoiceById = new Map(invoices.flatMap((invoice) => idsFor(invoice).map((idValue) => [idValue, invoice])));
    const records = (await all('invoice_items')).filter((item) => active(item) && approvedInvoiceIds.has(item.invoiceId) && !Number(item.isDiscountLine || 0) && !Number(item.candidateOnly || 0) && trustedItemName(item) && supplierIds.includes(item.supplierId));
    const groups = new Map();
    for (const item of records) {
      const key = item.productId || item.productNameNormalized || normalizeProductName(item.productNameOriginal || item.rawName || '');
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    const rows = [...groups.entries()].map(([key, group]) => {
      const sorted = [...group].sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`));
      const prices = group.map(priceForItem).filter((price) => price > 0);
      return {
        productKey: key,
        productName: sorted[0]?.productNameNormalized || sorted[0]?.productNameOriginal || key,
        recentPrice: priceForItem(sorted[0]),
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
        averagePrice: prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 0,
        purchaseCount: group.length,
        totalQty: group.reduce((sum, item) => sum + moneyNumber(item.actualQty || item.totalQty || item.quantity), 0),
        recentPurchaseDate: sorted[0]?.invoiceDate || '',
        invoiceNo: invoiceById.get(sorted[0]?.invoiceId)?.invoiceNo || ''
      };
    });
    const sorters = {
      minPrice: (a, b) => a.minPrice - b.minPrice,
      maxPrice: (a, b) => b.maxPrice - a.maxPrice,
      recent: (a, b) => (b.recentPurchaseDate || '').localeCompare(a.recentPurchaseDate || ''),
      count: (a, b) => b.purchaseCount - a.purchaseCount,
      quantity: (a, b) => b.totalQty - a.totalQty
    };
    return rows.sort(sorters[sortBy] || sorters.recent);
  },

  async getDashboardMetrics() {
    const suppliers = (await all('suppliers')).filter(active);
    const allInvoices = (await all('invoices')).filter(active);
    const invoices = allInvoices.filter(approvedForStats);
    const pendingInvoices = allInvoices.filter(pendingReviewInvoice);
    const abnormalInvoices = allInvoices.filter(abnormalInvoice);
    const duplicateInvoices = allInvoices.filter((invoice) => ['duplicate', 'confirmed'].includes(String(invoice.duplicateStatus || '').toLowerCase())
      || String(invoice.status || '').toUpperCase() === 'DUPLICATE');
    const conflictInvoices = allInvoices.filter((invoice) => String(invoice.syncStatus || '').toLowerCase() === 'conflict'
      || String(invoice.status || '').toUpperCase() === 'CONFLICT');
    const approvedInvoiceIds = invoiceIdSet(invoices);
    const items = (await all('invoice_items')).filter((item) => active(item) && approvedInvoiceIds.has(item.invoiceId) && !Number(item.candidateOnly || 0) && !Number(item.isDiscountLine || 0) && trustedItemName(item));
    const discounts = (await all('invoice_discounts')).filter((discount) => active(discount) && approvedInvoiceIds.has(discount.invoiceId));
    const month = currentMonth();
    const monthInvoices = invoices.filter((invoice) => String(invoice.invoiceDate || invoice.createdAt || '').startsWith(month));
    const monthPendingInvoices = pendingInvoices.filter((invoice) => String(invoice.invoiceDate || invoice.createdAt || '').startsWith(month));
    const monthSupplierIds = new Set(monthInvoices.map((invoice) => invoice.supplierId).filter(Boolean));
    const metrics = {
      totalPurchaseAmount: invoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      confirmedPurchaseAmount: invoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      pendingPurchaseAmount: pendingInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      abnormalInvoiceAmount: abnormalInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      monthPurchaseAmount: monthInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      monthConfirmedAmount: monthInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      monthPendingAmount: monthPendingInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      monthInvoiceCount: monthInvoices.length,
      confirmedInvoiceCount: invoices.length,
      monthNewSupplierCount: suppliers.filter((supplier) => monthSupplierIds.has(supplier.id) || monthSupplierIds.has(supplier.serverId) || String(supplier.createdAt || '').startsWith(month)).length,
      giftValueTotal: items.reduce((sum, item) => sum + moneyNumber(item.freeQty) * moneyNumber(item.effectiveUnitCost || item.unitPrice), 0),
      discountTotal: discounts.reduce((sum, discount) => sum + moneyNumber(discount.amount), 0),
      abnormalInvoiceCount: abnormalInvoices.length,
      pendingInvoiceCount: pendingInvoices.length,
      duplicateInvoiceCount: duplicateInvoices.length,
      conflictInvoiceCount: conflictInvoices.length
    };
    console.log('[dashboard] local IndexedDB stats query:', {
      companyId: getCurrentCompanyId(),
      suppliers: suppliers.length,
      allInvoices: allInvoices.length,
      approvedInvoices: invoices.length,
      metrics
    });
    return metrics;
  },

  async getPurchaseAnalytics() {
    const suppliers = (await all('suppliers')).filter(active);
    const supplierById = new Map(suppliers.flatMap((supplier) => idsFor(supplier).map((idValue) => [idValue, supplier])));
    const allInvoices = (await all('invoices')).filter(active);
    const invoices = allInvoices.filter(approvedForStats);
    const pendingOrAbnormalInvoices = allInvoices.filter((invoice) => pendingReviewInvoice(invoice) || abnormalInvoice(invoice));
    const approvedInvoiceIds = invoiceIdSet(invoices);
    const items = (await all('invoice_items')).filter((item) => active(item) && approvedInvoiceIds.has(item.invoiceId) && !Number(item.candidateOnly || 0) && !Number(item.isDiscountLine || 0) && trustedItemName(item));
    const supplierGroups = new Map();
    for (const invoice of invoices) {
      const key = invoice.supplierId || 'unknown';
      const group = supplierGroups.get(key) || { supplier: supplierById.get(key), amount: 0, count: 0 };
      group.amount += moneyNumber(invoice.totalAmount);
      group.count += 1;
      supplierGroups.set(key, group);
    }
    const productGroups = new Map();
    for (const item of items) {
      const key = item.productId || item.productNameNormalized || normalizeProductName(item.productNameOriginal || '');
      const group = productGroups.get(key) || { productName: item.productNameNormalized || item.productNameOriginal || key, quantity: 0, amount: 0 };
      group.quantity += moneyNumber(item.actualQty || item.totalQty || item.quantity);
      group.amount += moneyNumber(item.totalPrice);
      productGroups.set(key, group);
    }
    const monthGroups = new Map();
    for (const invoice of invoices) {
      const month = invoiceMonth(invoice.invoiceDate || invoice.createdAt);
      const group = monthGroups.get(month) || { month, amount: 0, quantity: 0 };
      group.amount += moneyNumber(invoice.totalAmount);
      monthGroups.set(month, group);
    }
    for (const item of items) {
      const month = invoiceMonth(item.invoiceDate || item.createdAt);
      const group = monthGroups.get(month) || { month, amount: 0, quantity: 0 };
      group.quantity += moneyNumber(item.actualQty || item.totalQty || item.quantity);
      monthGroups.set(month, group);
    }
    const lowestByProduct = new Map();
    for (const item of items) {
      const key = item.productId || item.productNameNormalized || normalizeProductName(item.productNameOriginal || '');
      const price = priceForItem(item);
      if (!price) continue;
      const current = lowestByProduct.get(key);
      if (!current || price < current.price) {
        const invoice = invoices.find((entry) => idsFor(entry).includes(item.invoiceId));
        lowestByProduct.set(key, {
          productName: item.productNameNormalized || item.productNameOriginal || key,
          price,
          supplierName: supplierDisplayName(supplierById.get(item.supplierId)),
          invoiceId: invoice?.id || '',
          invoiceNo: invoice?.invoiceNo || '',
          invoiceDate: item.invoiceDate || ''
        });
      }
    }
    return {
      supplierRanking: [...supplierGroups.values()].map((group) => ({
        supplierName: supplierDisplayName(group.supplier),
        amount: group.amount,
        count: group.count,
        averageOrderAmount: group.count ? group.amount / group.count : 0
      })).sort((a, b) => b.amount - a.amount),
      productRanking: [...productGroups.values()].sort((a, b) => b.amount - a.amount),
      monthly: [...monthGroups.values()].sort((a, b) => a.month.localeCompare(b.month)),
      lowestPrices: [...lowestByProduct.values()].sort((a, b) => a.price - b.price),
      pendingOrAbnormalCount: pendingOrAbnormalInvoices.length,
      pendingCount: allInvoices.filter(pendingReviewInvoice).length,
      abnormalCount: allInvoices.filter(abnormalInvoice).length
    };
  },

  async compareProductSuppliers(name) {
    const records = await localDb.getProduct(name);
    const groups = new Map();
    for (const record of records) {
      const key = record.supplierId || record.supplierName || 'unknown';
      const group = groups.get(key) || [];
      group.push(record);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => {
      const sorted = [...group].sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`));
      const prices = group.map(priceForItem).filter((price) => price > 0);
      return {
        supplierId: key,
        supplierName: sorted[0]?.supplierName || '未命名供应商',
        recentPrice: priceForItem(sorted[0]),
        minPrice: prices.length ? Math.min(...prices) : 0,
        recentPurchaseDate: sorted[0]?.invoiceDate || '',
        recordCount: group.length
      };
    }).sort((a, b) => a.minPrice - b.minPrice);
  },

  async getArchiveTree(query = '') {
    const q = normalizeProductName(query);
    const [invoices, pages] = await Promise.all([localDb.getInvoices(), all('invoice_pages')]);
    const pagesByInvoice = new Map();
    for (const page of pages.filter(active)) {
      const ids = [page.invoiceId].filter(Boolean);
      for (const key of ids) {
        const list = pagesByInvoice.get(key) || [];
        list.push(page);
        pagesByInvoice.set(key, list);
      }
    }
    const rows = invoices
      .filter((invoice) => active(invoice) && !['merged', 'hidden'].includes(String(invoice.status || '').toLowerCase()))
      .filter((invoice) => {
        if (!q) return true;
        const haystack = normalizeProductName([
          invoice.supplierName,
          invoice.supplierDisplayName,
          invoice.invoiceNo,
          invoice.invoiceDate,
          invoice.archiveFilePath
        ].filter(Boolean).join(' '));
        return haystack.includes(q);
      })
      .map((invoice) => {
        const fallbackArchive = buildArchivePath({
          supplierName: invoice.supplierName || invoice.supplierDisplayName || '',
          invoiceDate: invoice.invoiceDate || '',
          invoiceNo: invoice.invoiceNo || '',
          fileHash: invoice.fileHash || invoice.imageHash || '',
          originalFileName: invoice.originalFilePath || ''
        });
        return {
          ...invoice,
          archiveFolder: invoice.archiveFolder || fallbackArchive.archiveFolder,
          invoiceMonth: invoice.invoiceMonth || fallbackArchive.invoiceMonth,
          archiveFilePath: invoice.archiveFilePath || fallbackArchive.archiveFilePath,
          pages: pagesByInvoice.get(invoice.id) || pagesByInvoice.get(invoice.serverId) || []
        };
      });
    const supplierMap = new Map();
    for (const invoice of rows) {
      const supplierName = supplierDisplayName(invoice) || invoice.supplierName || 'Unknown Supplier';
      const month = invoice.invoiceMonth || invoiceMonth(invoice.invoiceDate);
      if (!supplierMap.has(supplierName)) supplierMap.set(supplierName, new Map());
      const monthMap = supplierMap.get(supplierName);
      if (!monthMap.has(month)) monthMap.set(month, []);
      monthMap.get(month).push(invoice);
    }
    return [...supplierMap.entries()].map(([supplierName, monthMap]) => ({
      supplierName,
      invoiceCount: [...monthMap.values()].reduce((sum, list) => sum + list.length, 0),
      months: [...monthMap.entries()].map(([month, monthInvoices]) => ({
        month,
        invoiceCount: monthInvoices.length,
        invoices: monthInvoices.sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`))
      })).sort((a, b) => b.month.localeCompare(a.month))
    })).sort((a, b) => a.supplierName.localeCompare(b.supplierName));
  },

  async repairEncodingForCurrentCompany() {
    const repairedByTable = {};
    for (const table of syncTables) {
      const records = (await all(table)).filter(belongsToCurrentCompany);
      const repaired = [];
      for (const record of records) {
        if (!hasEncodingDamage(record)) continue;
        const next = repairRecordEncoding(record);
        repaired.push({
          ...next,
          syncStatus: record.deletedAt ? record.syncStatus : (record.syncStatus === 'synced' ? 'pending' : record.syncStatus),
          updatedAt: record.deletedAt ? record.updatedAt : nowIso(),
          encodingFixedAt: nowIso()
        });
      }
      if (repaired.length) {
        await putMany(table, repaired);
        repairedByTable[table] = repaired.length;
      }
    }
    return repairedByTable;
  },

  async getStats() {
    const entries = await Promise.all(syncTables.map(async (table) => [table, (await all(table)).filter(active).length]));
    return Object.fromEntries(entries);
  },

  async softDeleteAll() {
    const deletedAt = nowIso();
    for (const table of syncTables) {
      const records = await all(table);
      await putMany(table, records.filter(active).map((record) => syncFields({ ...record, deletedAt }, 'deleted')));
    }
  },

  async clearLocalCacheForCurrentCompany() {
    const companyId = getCurrentCompanyId();
    if (!companyId) throw new Error('请先登录');
    const db = await openDb();
    const tableNames = [...syncTables, 'meta'];
    await Promise.all(tableNames.map((table) => new Promise((resolve, reject) => {
      const tx = db.transaction(table, 'readwrite');
      const objectStore = tx.objectStore(table);
      const request = objectStore.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value || {};
        if ((table === 'meta' && String(value.id || '').includes(companyId)) || value.companyId === companyId) {
          cursor.delete();
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    })));
    window.dispatchEvent(new Event('local-db-change'));
  },

  async cleanupSyncedDeletedCache() {
    let removed = 0;
    for (const table of syncTables) {
      const records = (await all(table)).filter((record) => belongsToCurrentCompany(record) && record.deletedAt && ['synced', 'deleted'].includes(record.syncStatus));
      for (const record of records) {
        await remove(table, record.id);
        removed += 1;
      }
    }
    window.dispatchEvent(new Event('local-db-change'));
    return removed;
  }
};
