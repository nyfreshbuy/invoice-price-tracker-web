import { getCompanyId as getAuthCompanyId } from './api.js';

const DB_NAME = 'InvoicePriceTrackerLocal';
const DB_VERSION = 6;

export const syncTables = ['purchase_batches', 'suppliers', 'invoices', 'invoice_items', 'products', 'price_history', 'invoice_discounts', 'supplier_templates', 'product_aliases', 'product_learning_rules', 'recognition_corrections', 'price_anomalies'];
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
    productItems: items.filter((item) => !isDiscountLine(item) && !item.candidateOnly),
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

function invoiceMonth(value = '') {
  return String(value || '').slice(0, 7) || '未 dated';
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
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

  async saveInvoiceImage({ id: imageId, invoiceId, file, source = 'IndexedDB' }) {
    if (!file) throw new Error('图片保存失败，请重新上传。');
    const idValue = imageId || generateId();
    const record = {
      id: idValue,
      companyId: getCurrentCompanyId(),
      invoiceId,
      imageBlob: file,
      mimeType: file.type || 'image/jpeg',
      fileName: file.name || '',
      size: file.size || file.byteLength || 0,
      source,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await put('invoice_images', record);
    const saved = await get('invoice_images', idValue);
    if (!saved?.imageBlob) throw new Error('图片保存失败，请重新上传。');
    return record;
  },

  async getInvoiceImage(invoice) {
    const imageId = invoice?.imageId || String(invoice?.imagePath || '').replace(/^indexeddb:/, '');
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

  async verifyInvoiceImage(invoice) {
    const imagePath = String(invoice?.imagePath || '');
    if (!imagePath && !invoice?.imageId) return { ok: false, status: 'missing', message: '图片不存在' };
    if (imagePath.startsWith('indexeddb:') || invoice?.imageId) {
      const image = await localDb.getInvoiceImage(invoice);
      return image?.imageBlob
        ? { ok: true, status: 'normal', image }
        : { ok: false, status: 'missing', message: '图片不存在' };
    }
    if (imagePath.startsWith('blob:')) {
      return { ok: false, status: 'missing', message: 'Blob URL 已失效，请重新上传图片。' };
    }
    return { ok: true, status: 'server' };
  },

  async updateInvoiceImageFields(invoiceId, fields) {
    const detail = await localDb.getInvoice(invoiceId);
    if (!detail) throw new Error('Invoice not found');
    const updated = syncFields({ ...detail.invoice, ...fields });
    await put('invoices', updated);
    return updated;
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
      pageNumber: Number(payload.pageNumber || 0),
      pageCount: Number(payload.pageCount || 0),
      invoiceGroupKey: payload.invoiceGroupKey || [payload.supplierName || supplier?.name || '', payload.invoiceNo || '', Number(totalAmount || 0).toFixed(2)].join('|').toLowerCase(),
      invoiceLayoutType: payload.invoiceLayoutType || 'normal_invoice',
      imageId: payload.imageId || '',
      imageUrl: payload.imageUrl || '',
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
        candidateOnly: rawItem.candidateOnly ? 1 : 0,
        isHandwrittenQuantity: rawItem.isHandwrittenQuantity ? 1 : 0,
        isHandwrittenPrice: rawItem.isHandwrittenPrice ? 1 : 0,
        isHandwrittenAmount: rawItem.isHandwrittenAmount ? 1 : 0,
        isCircled: rawItem.isCircled ? 1 : 0,
        isChecked: rawItem.isChecked ? 1 : 0,
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
      if (!active(item) || Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0)) return false;
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
      if (!active(item) || Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0)) return false;
      const haystack = `${normalizeProductName(item.rawName || item.productNameOriginal || '')} ${normalizeProductName(item.normalizedName || item.productNameNormalized || '')}`;
      return haystack.includes(q) || item.productId === name || aliasProductIds.has(item.productId);
    }).map((item) => {
      const supplier = resolveByAnyId(suppliers, item.supplierId);
      const invoice = resolveByAnyId(invoices, item.invoiceId);
      return { ...item, supplierName: supplier?.name || '未命名供应商', invoiceNo: invoice?.invoiceNo || '', invoiceImagePath: invoice?.imagePath || '', invoiceRecordId: invoice?.id || '' };
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
    const suppliers = (await all('suppliers')).filter(active);
    const invoices = (await all('invoices')).filter(active);
    const items = (await all('invoice_items')).filter((item) => active(item) && !Number(item.candidateOnly || 0) && !Number(item.isDiscountLine || 0));
    const discounts = (await all('invoice_discounts')).filter(active);
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
        supplier.contactName,
        supplier.phone,
        supplier.email,
        supplier.address,
        supplier.notes,
        ...supplierInvoices.map((invoice) => invoice.invoiceNo),
        ...supplierItems.map((item) => `${item.rawName || ''} ${item.productNameOriginal || ''} ${item.productNameNormalized || ''}`)
      ].join(' '));
      return {
        ...supplier,
        totalPurchaseAmount: supplierInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
        invoiceCount: supplierInvoices.length,
        recentPurchaseDate: sortedInvoices[0]?.invoiceDate || '',
        recentPurchaseAmount: moneyNumber(sortedInvoices[0]?.totalAmount || 0),
        skuCount: skuSet.size,
        freeQtyTotal: supplierItems.reduce((sum, item) => sum + moneyNumber(item.freeQty), 0),
        discountTotal: supplierDiscounts.reduce((sum, discount) => sum + moneyNumber(discount.amount), 0),
        abnormalInvoiceCount: supplierInvoices.filter((invoice) => invoice.duplicateStatus === 'possible' || invoice.recognitionWarnings).length,
        totalPurchaseQty: supplierItems.reduce((sum, item) => sum + moneyNumber(item.actualQty || item.totalQty || item.quantity), 0),
        searchText
      };
    }).filter((supplier) => !q || supplier.searchText.includes(q)).sort((a, b) => b.totalPurchaseAmount - a.totalPurchaseAmount);
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
    const invoices = (await all('invoices')).filter(active);
    const invoiceById = new Map(invoices.flatMap((invoice) => idsFor(invoice).map((idValue) => [idValue, invoice])));
    const records = (await all('invoice_items')).filter((item) => active(item) && !Number(item.isDiscountLine || 0) && !Number(item.candidateOnly || 0) && supplierIds.includes(item.supplierId));
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
    const invoices = (await all('invoices')).filter(active);
    const items = (await all('invoice_items')).filter((item) => active(item) && !Number(item.candidateOnly || 0) && !Number(item.isDiscountLine || 0));
    const discounts = (await all('invoice_discounts')).filter(active);
    const month = currentMonth();
    const monthInvoices = invoices.filter((invoice) => String(invoice.invoiceDate || invoice.createdAt || '').startsWith(month));
    const monthSupplierIds = new Set(monthInvoices.map((invoice) => invoice.supplierId).filter(Boolean));
    return {
      totalPurchaseAmount: invoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      monthPurchaseAmount: monthInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.totalAmount), 0),
      monthInvoiceCount: monthInvoices.length,
      monthNewSupplierCount: suppliers.filter((supplier) => monthSupplierIds.has(supplier.id) || monthSupplierIds.has(supplier.serverId) || String(supplier.createdAt || '').startsWith(month)).length,
      giftValueTotal: items.reduce((sum, item) => sum + moneyNumber(item.freeQty) * moneyNumber(item.effectiveUnitCost || item.unitPrice), 0),
      discountTotal: discounts.reduce((sum, discount) => sum + moneyNumber(discount.amount), 0),
      abnormalInvoiceCount: invoices.filter((invoice) => invoice.duplicateStatus === 'possible' || invoice.recognitionWarnings).length,
      pendingInvoiceCount: invoices.filter((invoice) => ['pending', 'review', 'needs_review'].includes(invoice.status) || invoice.syncStatus === 'pending').length
    };
  },

  async getPurchaseAnalytics() {
    const suppliers = (await all('suppliers')).filter(active);
    const supplierById = new Map(suppliers.flatMap((supplier) => idsFor(supplier).map((idValue) => [idValue, supplier])));
    const invoices = (await all('invoices')).filter(active);
    const items = (await all('invoice_items')).filter((item) => active(item) && !Number(item.candidateOnly || 0) && !Number(item.isDiscountLine || 0));
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
          supplierName: supplierById.get(item.supplierId)?.name || '未命名供应商',
          invoiceId: invoice?.id || '',
          invoiceNo: invoice?.invoiceNo || '',
          invoiceDate: item.invoiceDate || ''
        });
      }
    }
    return {
      supplierRanking: [...supplierGroups.values()].map((group) => ({
        supplierName: group.supplier?.name || '未命名供应商',
        amount: group.amount,
        count: group.count,
        averageOrderAmount: group.count ? group.amount / group.count : 0
      })).sort((a, b) => b.amount - a.amount),
      productRanking: [...productGroups.values()].sort((a, b) => b.amount - a.amount),
      monthly: [...monthGroups.values()].sort((a, b) => a.month.localeCompare(b.month)),
      lowestPrices: [...lowestByProduct.values()].sort((a, b) => a.price - b.price)
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
