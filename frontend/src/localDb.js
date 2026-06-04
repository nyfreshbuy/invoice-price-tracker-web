import { getCompanyId as getAuthCompanyId } from './api.js';

const DB_NAME = 'InvoicePriceTrackerLocal';
const DB_VERSION = 5;

export const syncTables = ['purchase_batches', 'suppliers', 'invoices', 'invoice_items', 'products', 'price_history', 'invoice_discounts', 'supplier_templates', 'product_aliases', 'product_learning_rules', 'recognition_corrections', 'price_anomalies'];

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
  return value
    .trim()
    .replace(/干页豆腐/g, '千页豆腐')
    .replace(/仟页豆腐/g, '千页豆腐')
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

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

function giftAccountingKey(item = {}) {
  const candidate = promoGroupCandidate(item);
  return candidate.key || normalizeProductName(item.standardName || item.productNameNormalized || item.normalizedName || item.productNameOriginal || item.name || '');
}

function displayItemName(item = {}) {
  return String(item.name || item.productNameOriginal || [item.nameCn, item.nameEn].filter(Boolean).join(' ') || item.rawName || '').trim();
}

function promoGroupCandidate(item = {}) {
  const source = `${item.standardName || item.productNameNormalized || item.normalizedName || displayItemName(item)} ${item.spec || ''} ${item.unit || ''}`.toUpperCase();
  const normalized = normalizeProductName(source).toUpperCase();
  const tokens = normalized.split(/[^A-Z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const brand = tokens.find((token) => !/^\d/.test(token) && !['PET', 'CAN', 'BTL', 'BOTTLE', 'CASE', 'CS', 'PK', 'PACK'].includes(token)) || '';
  const specs = [];
  const packageMatch = source.match(/\b(PET|CAN|BTL|BOTTLE|JAR|BAG|BOX|TIN)\b/);
  if (packageMatch) specs.push(packageMatch[1]);
  const sizeMatch = source.match(/\b\d+\/\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L)\b/) || source.match(/\b\d+X\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L|CT|PC|PCS|PK)\b/) || source.match(/\b\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L)\b/);
  if (sizeMatch) specs.push(sizeMatch[0]);
  if (!brand || specs.length === 0) return { key: '', name: '需要人工确认分摊组', rule: 'uncertain: missing brand or package/spec' };
  return { key: `${brand}|${specs.join('|')}`, name: `${brand} ${specs.join(' ')}`, rule: 'same brand + same spec/package' };
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
    const chargedQty = Number(group.chargedQty || 0);
    const freeQty = Number(group.freeQty || 0);
    const totalQty = chargedQty + freeQty;
    const invoiceAmount = Number(group.invoiceAmount || 0);
    return {
      ...item,
      chargedQty,
      freeQty,
      totalQty,
      actualQty: totalQty,
      originalUnitCost: chargedQty > 0 ? invoiceAmount / chargedQty : 0,
      effectiveUnitCost: totalQty > 0 ? invoiceAmount / totalQty : 0,
      discountedEffectiveUnitCost: totalQty > 0 ? invoiceAmount / totalQty : 0
    };
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const table of [...syncTables, 'meta']) {
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
  await promisify(objectStore.put(record));
  window.dispatchEvent(new CustomEvent('local-db-change', { detail: { table } }));
  return record;
}

async function putMany(table, records) {
  const { tx, objectStore } = await store(table, 'readwrite');
  for (const record of records) objectStore.put(record);
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

export function getCurrentCompanyId() {
  return getAuthCompanyId();
}

function belongsToCurrentCompany(record) {
  const companyId = getCurrentCompanyId();
  return !companyId || !record.companyId || record.companyId === companyId;
}

function active(record) {
  return !record.deletedAt && belongsToCurrentCompany(record);
}

function syncFields(record, status = 'pending') {
  const timestamp = nowIso();
  const generatedId = record.id || record.localId || generateId();
  return {
    ...record,
    id: record.id || generatedId,
    companyId: record.companyId || getCurrentCompanyId(),
    localId: record.localId || generatedId,
    serverId: record.serverId || null,
    syncStatus: status,
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
  return suppliers.find((supplier) => supplier.name === name);
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

  async getPendingChanges() {
    const entries = await Promise.all(syncTables.map(async (table) => [
      table,
      (await all(table)).filter((record) => belongsToCurrentCompany(record) && ['pending', 'deleted'].includes(record.syncStatus))
    ]));
    return Object.fromEntries(entries);
  },

  async markSynced(table, result) {
    const records = await all(table);
    const local = records.find((record) => record.localId === result.localId || record.id === result.localId || record.serverId === result.serverId);
    if (!local) return;
    const serverRecord = result.record || {};
    await put(table, {
      ...serverRecord,
      id: local.id,
      localId: local.localId || result.localId || local.id,
      serverId: result.serverId || serverRecord.serverId || serverRecord.id,
      syncStatus: 'synced'
    });
  },

  async mergeRemote(table, remote) {
    if (!belongsToCurrentCompany(remote)) return;
    const records = await all(table);
    const local = records.find((record) => record.serverId === remote.serverId || record.serverId === remote.id || record.id === remote.serverId || record.id === remote.id);
    if (local && local.syncStatus === 'pending' && local.updatedAt > remote.updatedAt) return;
    const id = local?.id || remote.serverId || remote.id || generateId();
    await put(table, {
      ...remote,
      id,
      localId: local?.localId || remote.localId || id,
      serverId: remote.serverId || remote.id,
      syncStatus: 'synced'
    });
  },

  async getSuppliers() {
    return (await all('suppliers')).filter(active).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  },

  async saveSupplier(supplier) {
    return put('suppliers', syncFields(supplier));
  },

  async deleteSupplier(supplier) {
    await put('suppliers', syncFields({ ...supplier, deletedAt: nowIso() }, 'deleted'));
    const templates = await all('supplier_templates');
    await putMany('supplier_templates', templates.filter((template) => template.supplierId === supplier.id || template.supplierId === supplier.serverId).map((template) => syncFields({ ...template, deletedAt: nowIso() }, 'deleted')));
  },

  async getTemplate(supplierId) {
    const templates = await all('supplier_templates');
    return templates.filter(active).find((template) => template.supplierId === supplierId || template.supplierId === resolveByAnyId(templates, supplierId)?.serverId) || null;
  },

  async saveTemplate(supplierId, template) {
    const existing = await localDb.getTemplate(supplierId);
    return put('supplier_templates', syncFields({ ...(existing || {}), ...template, supplierId }));
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

  async createInvoice(payload) {
    const supplier = payload.supplierId ? resolveByAnyId(await all('suppliers'), payload.supplierId) : await findOrCreateSupplier(payload.supplierName);
    const invoiceId = payload.id || generateId();
    const invoiceDate = payload.invoiceDate || today();
    const { productItems, discountItems } = splitInvoiceRows((payload.items || []).filter((item) => (item.productNameOriginal || item.name || item.rawName || '').trim()));
    const items = applyGiftAccounting(productItems);
    const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
    const totalAmount = Number(payload.totalAmount || 0) > 0 ? Number(payload.totalAmount) : itemTotal;
    const invoice = syncFields({
      id: invoiceId,
      batchId: payload.batchId || '',
      supplierId: supplier?.id || '',
      invoiceNo: payload.invoiceNo || '',
      invoiceDate,
      imagePath: payload.imagePath || '',
      ocrText: payload.ocrText || '',
      totalAmount,
      status: 'saved'
    });
    await put('invoices', invoice);

    for (const rawItem of items) {
      const item = syncFields({
        ...rawItem,
        id: rawItem.id || generateId(),
        invoiceId: invoice.id,
        supplierId: supplier?.id || '',
        productNameNormalized: normalizeProductName(rawItem.productNameNormalized || rawItem.productNameOriginal || ''),
        quantity: Number(rawItem.quantity || 0),
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
        isFreeItem: rawItem.isFreeItem ? 1 : 0,
        isDiscountLine: 0,
        freeReason: rawItem.freeReason || '',
        invoiceDate
      });
      await put('invoice_items', item);
      const product = await upsertProductForItem(item);
      await put('price_history', syncFields({
        productId: product?.id || '',
        invoiceItemId: item.id,
        supplierId: supplier?.id || '',
        price: item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice,
        quantity: item.actualQty || item.totalQty || item.quantity,
        unit: item.unit,
        invoiceDate,
        invoiceNo: invoice.invoiceNo || ''
      }));
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
    return (await all('invoices')).filter(active).map((invoice) => {
      const supplier = resolveByAnyId(suppliers, invoice.supplierId);
      const invoiceIds = [invoice.id, invoice.localId, invoice.serverId].filter(Boolean);
      const items = invoiceItems.filter((item) => invoiceIds.includes(item.invoiceId));
      return {
        ...invoice,
        supplierName: supplier?.name || '未命名供应商',
        itemCount: items.length,
        itemNames: items.map((item) => item.productNameNormalized || item.productNameOriginal || ''),
        itemTotal: items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0),
        itemTotalQuantity: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      };
      return { ...invoice, supplierName: supplier?.name || '未命名供应商' };
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
    return { invoice: { ...invoice, supplierName: supplier?.name || '未命名供应商' }, items, discounts };
  },

  async deleteInvoice(id) {
    const detail = await localDb.getInvoice(id);
    if (!detail) return;
    const deletedAt = nowIso();
    await put('invoices', syncFields({ ...detail.invoice, deletedAt }, 'deleted'));
    await putMany('invoice_items', detail.items.map((item) => syncFields({ ...item, deletedAt }, 'deleted')));
    await putMany('invoice_discounts', (detail.discounts || []).map((discount) => syncFields({ ...discount, deletedAt }, 'deleted')));
  },

  async searchProducts(query) {
    const q = normalizeProductName(query);
    if (!q) return [];
    const aliases = (await all('product_aliases')).filter(active);
    const aliasProductIds = new Set(aliases
      .filter((alias) => `${normalizeProductName(alias.aliasName || alias.rawName || alias.keyword || '')} ${normalizeProductName(alias.normalizedAlias || '')} ${normalizeProductName(alias.standardName || '')}`.includes(q))
      .map((alias) => alias.productId)
      .filter(Boolean));
    const items = (await all('invoice_items')).filter((item) => {
      if (!active(item) || Number(item.isDiscountLine || 0)) return false;
      const haystack = `${normalizeProductName(item.rawName || item.productNameOriginal || '')} ${normalizeProductName(item.normalizedName || item.productNameNormalized || '')}`;
      return haystack.includes(q) || aliasProductIds.has(item.productId);
    });
    const groups = new Map();
    for (const item of items) {
      const key = item.productNameNormalized || normalizeProductName(item.productNameOriginal);
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([standardName, records]) => {
      const sorted = [...records].sort((a, b) => `${b.invoiceDate}${b.createdAt}`.localeCompare(`${a.invoiceDate}${a.createdAt}`));
      const prices = records.map((record) => Number(record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice || 0));
      return {
        productId: records[0]?.productId || '',
        standardName,
        recentPrice: Number(sorted[0]?.discountedEffectiveUnitCost || sorted[0]?.effectiveUnitCost || sorted[0]?.unitPrice || 0),
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        averagePrice: prices.reduce((sum, price) => sum + price, 0) / prices.length,
        recentPurchaseDate: sorted[0]?.invoiceDate || '',
        recordCount: records.length
      };
    }).sort((a, b) => (b.recentPurchaseDate || '').localeCompare(a.recentPurchaseDate || ''));
  },

  async getProduct(name) {
    const suppliers = await all('suppliers');
    const invoices = await all('invoices');
    const q = normalizeProductName(name);
    const aliases = (await all('product_aliases')).filter(active);
    const aliasProductIds = new Set(aliases
      .filter((alias) => `${normalizeProductName(alias.aliasName || alias.rawName || alias.keyword || '')} ${normalizeProductName(alias.normalizedAlias || '')} ${normalizeProductName(alias.standardName || '')}`.includes(q) || alias.productId === name)
      .map((alias) => alias.productId)
      .filter(Boolean));
    return (await all('invoice_items')).filter((item) => {
      if (!active(item) || Number(item.isDiscountLine || 0)) return false;
      const haystack = `${normalizeProductName(item.rawName || item.productNameOriginal || '')} ${normalizeProductName(item.normalizedName || item.productNameNormalized || '')}`;
      return haystack.includes(q) || item.productId === name || aliasProductIds.has(item.productId);
    }).map((item) => {
      const supplier = resolveByAnyId(suppliers, item.supplierId);
      const invoice = resolveByAnyId(invoices, item.invoiceId);
      return { ...item, supplierName: supplier?.name || '未命名供应商', invoiceNo: invoice?.invoiceNo || '' };
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
        supplierName: supplier?.name || '未命名供应商',
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
      if (filters.hasGifts && !invoice.hasGifts) return false;
      if (filters.hasWarnings && !invoice.hasWarnings) return false;
      if (filters.isMultipage && !invoice.isMultipage) return false;
      return true;
    }).sort((a, b) => `${b.invoiceDate || ''}${b.createdAt || ''}`.localeCompare(`${a.invoiceDate || ''}${a.createdAt || ''}`));
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
  }
};
