import { id, nowIso, syncTables, tableColumns } from '../db.js';
import { getMongoDb } from './mongoAccountStore.js';

let syncIndexesReady = false;

function collectionName(table) {
  if (!syncTables.includes(table)) throw new Error(`Invalid sync table: ${table}`);
  return table;
}

function stripMongoId(record = {}) {
  const { _id, ...rest } = record;
  return rest;
}

function cleanRecord(table, record = {}, companyId, deviceId = '') {
  const now = nowIso();
  const columns = tableColumns[table] || [];
  const serverId = record.serverId || record.id || id();
  const version = Math.max(1, Number(record.version || 0));
  const base = {
    id: serverId,
    companyId,
    localId: record.localId || record.id || serverId,
    serverId,
    syncStatus: record.deletedAt ? 'deleted' : 'synced',
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    deletedAt: record.deletedAt || null,
    deviceId: record.deviceId || deviceId,
    version
  };
  const output = { ...base };
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(record, column)) output[column] = record[column];
  }
  output.id = serverId;
  output.companyId = companyId;
  output.localId = record.localId || record.id || serverId;
  output.serverId = serverId;
  output.syncStatus = record.deletedAt ? 'deleted' : 'synced';
  output.createdAt = record.createdAt || now;
  output.updatedAt = record.updatedAt || now;
  output.deletedAt = record.deletedAt || null;
  output.deviceId = record.deviceId || deviceId;
  output.version = version;
  return output;
}

async function ensureSyncIndexes(db) {
  if (syncIndexesReady) return;
  const indexJobs = syncTables.flatMap((table) => {
    const collection = db.collection(collectionName(table));
    return [
      collection.createIndex({ companyId: 1, updatedAt: 1 }),
      collection.createIndex({ companyId: 1, deletedAt: 1 }),
      collection.createIndex({ companyId: 1, serverId: 1 }, { unique: true, sparse: true }),
      collection.createIndex({ companyId: 1, localId: 1, deviceId: 1 })
    ];
  });
  await Promise.all(indexJobs);
  syncIndexesReady = true;
}

async function getDb() {
  const db = await getMongoDb();
  await ensureSyncIndexes(db);
  return db;
}

async function findExisting(db, table, incoming, companyId) {
  const collection = db.collection(collectionName(table));
  if (incoming.serverId || incoming.id) {
    const key = incoming.serverId || incoming.id;
    const existing = await collection.findOne({
      companyId,
      $or: [{ id: key }, { serverId: key }]
    });
    if (existing) return existing;
  }
  if (incoming.localId && incoming.deviceId) {
    return collection.findOne({
      companyId,
      localId: incoming.localId,
      deviceId: incoming.deviceId
    });
  }
  return null;
}

function amountSame(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 0.01;
}

function normalizeComparable(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

function itemSignature(items = []) {
  return items
    .filter((item) => !Number(item.isDiscountLine || 0) && !Number(item.candidateOnly || 0) && !Number(item.isFreeItem || 0))
    .map((item) => `${normalizeComparable(item.productNameNormalized || item.normalizedName || item.productNameOriginal || item.name || item.rawName || '')}:${Number(item.quantity || item.actualQty || item.totalQty || 0)}:${Number(item.totalPrice || 0).toFixed(2)}`)
    .filter((part) => !part.startsWith(':'))
    .sort()
    .join('|');
}

function daysBetween(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const left = new Date(`${String(a).slice(0, 10)}T00:00:00Z`).getTime();
  const right = new Date(`${String(b).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86400000;
}

function idsFor(record = {}) {
  return [record.id, record.localId, record.serverId].filter(Boolean);
}

async function invoiceItemsFor(db, invoice, incomingItems = []) {
  const invoiceIds = idsFor(invoice);
  const localItems = incomingItems.filter((item) => invoiceIds.includes(item.invoiceId));
  if (localItems.length) return localItems;
  return db.collection('invoice_items').find({
    companyId: invoice.companyId,
    invoiceId: { $in: invoiceIds },
    deletedAt: { $in: [null, ''] }
  }).toArray();
}

async function findMongoDuplicateInvoice(db, incoming, companyId, syncContext = {}) {
  const collection = db.collection('invoices');
  const invoiceNo = String(incoming.invoiceNo || '').trim();
  const invoiceDate = String(incoming.invoiceDate || '').trim();
  const supplierId = String(incoming.supplierId || '').trim();
  const supplierNameKey = normalizeComparable(incoming.supplierName || incoming.supplierDisplayName || '');
  const totalAmount = Number(incoming.totalAmount || 0);
  const selfIds = [incoming.id, incoming.serverId, incoming.localId].filter(Boolean);
  const incomingItems = Array.isArray(syncContext.changes?.invoice_items) ? syncContext.changes.invoice_items : [];
  const currentSignature = itemSignature(await invoiceItemsFor(db, incoming, incomingItems));
  const base = {
    companyId,
    deletedAt: { $in: [null, ''] },
    id: { $nin: selfIds },
    serverId: { $nin: selfIds },
    localId: { $nin: selfIds }
  };

  if (invoiceNo && invoiceDate && totalAmount > 0) {
    const candidates = await collection.find({
      ...base,
      invoiceNo,
      totalAmount: { $gte: totalAmount - 0.009, $lte: totalAmount + 0.009 },
      ...(supplierId ? { supplierId } : {})
    }).limit(20).toArray();
    for (const candidate of candidates) {
      const sameSupplier = supplierId && candidate.supplierId
        ? supplierId === candidate.supplierId
        : normalizeComparable(candidate.supplierName || candidate.supplierDisplayName || '') === supplierNameKey;
      if (!sameSupplier || daysBetween(invoiceDate, candidate.invoiceDate) > 1) continue;
      const candidateSignature = itemSignature(await invoiceItemsFor(db, candidate, incomingItems));
      if (!currentSignature || !candidateSignature || currentSignature === candidateSignature) {
        return { status: 'duplicate', invoice: candidate };
      }
      const sameBatch = Boolean(incoming.batchId && candidate.batchId && incoming.batchId === candidate.batchId);
      const sameGroup = Boolean(incoming.sameInvoiceGroup || candidate.sameInvoiceGroup || (incoming.invoiceGroupKey && incoming.invoiceGroupKey === candidate.invoiceGroupKey));
      if (sameBatch || sameGroup) return { status: 'possible', invoice: candidate };
      return { status: 'possible', invoice: candidate };
    }
  }

  const ocrTextHash = String(incoming.ocrTextHash || '').trim();
  if (!invoiceNo && ocrTextHash && invoiceDate && totalAmount > 0) {
    const duplicate = await collection.findOne({
      ...base,
      invoiceDate,
      ocrTextHash,
      totalAmount: { $gte: totalAmount - 0.009, $lte: totalAmount + 0.009 },
      ...(supplierId ? { supplierId } : {})
    });
    if (duplicate) return { status: 'duplicate', invoice: duplicate };
  }

  const imageHash = String(incoming.imageHash || incoming.sourceHash || '').trim();
  if (imageHash && totalAmount > 0) {
    const duplicate = await collection.findOne({
      ...base,
      $or: [{ imageHash }, { sourceHash: imageHash }],
      totalAmount: { $gte: totalAmount - 0.009, $lte: totalAmount + 0.009 }
    });
    if (duplicate) return { status: 'duplicate', invoice: duplicate };
  }
  return null;
}

async function pushOneMongo(db, table, incoming, deviceId, companyId, syncContext) {
  const existing = await findExisting(db, table, incoming, companyId);
  const incomingUpdatedAt = incoming.updatedAt || nowIso();
  if (existing && existing.updatedAt && existing.updatedAt > incomingUpdatedAt) {
    const moneyConflict = table === 'invoices' && !amountSame(existing.totalAmount, incoming.totalAmount);
    const status = moneyConflict || table === 'invoice_items' ? 'conflict' : 'synced';
    if (status === 'conflict') {
      return { table, localId: incoming.localId || incoming.id, serverId: existing.serverId || existing.id, status: 'conflict', record: stripMongoId(existing) };
    }
  }

  const serverId = existing?.serverId || existing?.id || incoming.serverId || id();
  const nextVersion = Math.max(Number(existing?.version || 0), Number(incoming.version || 0)) + 1;
  const record = cleanRecord(table, { ...incoming, id: serverId, serverId, version: nextVersion }, companyId, deviceId);

  if (table === 'invoices' && !record.deletedAt) {
    const duplicateInfo = await findMongoDuplicateInvoice(db, record, companyId, syncContext);
    const duplicate = duplicateInfo?.invoice || null;
    if (duplicateInfo?.status === 'duplicate' && duplicate && !incoming.forceSave && !incoming.force) {
      const invoiceIds = [incoming.id, incoming.localId, incoming.serverId, record.id, record.localId, record.serverId].filter(Boolean);
      for (const value of invoiceIds) syncContext.rejectedInvoiceIds.add(value);
      return {
        table,
        localId: incoming.localId || incoming.id || record.localId,
        serverId: duplicate.serverId || duplicate.id,
        status: 'duplicate',
        duplicateStatus: 'duplicate',
        duplicate: {
          id: duplicate.serverId || duplicate.id,
          invoiceNo: duplicate.invoiceNo || '',
          invoiceDate: duplicate.invoiceDate || '',
          totalAmount: Number(duplicate.totalAmount || 0)
        },
        record: null
      };
    }
    if (duplicateInfo?.status === 'possible') {
      record.status = 'PENDING_REVIEW';
      record.duplicateStatus = 'possible';
      record.recognitionWarnings = [record.recognitionWarnings || '', 'POSSIBLE_MULTI_PAGE_OR_DUPLICATE'].filter(Boolean).join(' | ');
    } else if (duplicate) {
      record.duplicateStatus = 'duplicate';
      record.duplicateOfInvoiceId = duplicate.serverId || duplicate.id;
    }
  }

  await db.collection(collectionName(table)).updateOne(
    { companyId, serverId },
    { $set: record, $setOnInsert: { _id: serverId } },
    { upsert: true }
  );
  return { table, localId: incoming.localId || incoming.id || record.localId, serverId: record.serverId, status: 'synced', record };
}

async function bulkPushMongoTable(db, table, records = [], deviceId, companyId) {
  if (!records.length) return [];
  const collection = db.collection(collectionName(table));
  const prepared = records.map((incoming) => {
    const serverId = incoming.serverId || incoming.id || id();
    const record = cleanRecord(table, { ...incoming, id: serverId, serverId }, companyId, deviceId);
    return { incoming, record };
  });
  const operations = prepared.map(({ record }) => ({
    updateOne: {
      filter: { companyId, serverId: record.serverId },
      update: { $set: record, $setOnInsert: { _id: record.serverId } },
      upsert: true
    }
  }));
  const startedAt = Date.now();
  try {
    await collection.bulkWrite(operations, { ordered: false });
    console.log('[SYNC PUSH BATCH] bulkWrite finish:', {
      table,
      count: records.length,
      durationMs: Date.now() - startedAt
    });
    return prepared.map(({ incoming, record }) => ({
      table,
      localId: incoming.localId || incoming.id || record.localId,
      serverId: record.serverId,
      status: 'synced',
      record
    }));
  } catch (error) {
    console.error('[SYNC PUSH BATCH] bulkWrite failed, falling back to one-by-one:', {
      table,
      count: records.length,
      durationMs: Date.now() - startedAt,
      message: error?.message || String(error || '')
    });
    const results = [];
    const fallbackContext = { changes: { [table]: records }, rejectedInvoiceIds: new Set() };
    for (const record of records) {
      results.push(await pushOneMongo(db, table, record, deviceId, companyId, fallbackContext));
    }
    return results;
  }
}

async function upsertGeneratedPriceHistoryForItem(db, item = {}, companyId, deviceId) {
  if (item.deletedAt || item.syncStatus === 'deleted') {
    await db.collection('price_history').updateMany(
      { companyId, invoiceItemId: { $in: [item.id, item.serverId, item.localId].filter(Boolean) } },
      { $set: { deletedAt: item.deletedAt || nowIso(), syncStatus: 'deleted', updatedAt: nowIso() } }
    );
    return;
  }
  if (Number(item.isDiscountLine || 0) || Number(item.candidateOnly || 0) || Number(item.isFreeItem || 0)) return;
  const price = Number(item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice || 0);
  const amount = Number(item.totalPrice || 0);
  const quantity = Number(item.actualQty || item.totalQty || item.quantity || 0);
  const name = item.productNameOriginal || item.rawName || item.name || item.productNameNormalized || item.normalizedName || '';
  if (!price || !amount || !quantity || !name) return;
  const invoiceItemId = item.serverId || item.id || item.localId;
  const serverId = `price-${invoiceItemId}`;
  const record = cleanRecord('price_history', {
    id: serverId,
    serverId,
    localId: serverId,
    productId: item.productId || '',
    invoiceId: item.invoiceId || '',
    invoiceItemId,
    supplierId: item.supplierId || '',
    productName: name,
    productNameOriginal: item.productNameOriginal || item.rawName || name,
    productNameNormalized: item.productNameNormalized || item.normalizedName || name,
    normalizedName: item.normalizedName || item.productNameNormalized || name,
    originalName: item.productNameOriginal || item.rawName || name,
    itemName: name,
    name,
    nameCn: item.nameCn || '',
    nameEn: item.nameEn || '',
    price,
    quantity,
    unit: item.unit || '',
    invoiceDate: item.invoiceDate || '',
    status: 'active',
    createdAt: item.createdAt || nowIso(),
    updatedAt: item.updatedAt || nowIso(),
    deviceId
  }, companyId, deviceId);
  await db.collection('price_history').updateOne(
    { companyId, invoiceItemId },
    { $set: record, $setOnInsert: { _id: serverId } },
    { upsert: true }
  );
}

export async function mongoSyncPush({ companyId, deviceId = 'unknown', changes = {} }) {
  const db = await getDb();
  const results = [];
  const syncContext = { changes, rejectedInvoiceIds: new Set() };
  for (const table of syncTables) {
    const records = Array.isArray(changes[table]) ? changes[table] : [];
    if (table === 'price_history' && records.length) {
      results.push(...records.map((record) => ({
        table,
        localId: record.localId || record.id || record.serverId || '',
        serverId: record.serverId || record.id || record.localId || '',
        status: 'synced_server_generated',
        reason: 'price_history is generated on the server from invoice_items',
        record: null
      })));
      continue;
    }
    if (table === 'price_history' && records.length > 1) {
      const skipped = [];
      const allowed = records.filter((record) => {
        const relatedItem = (changes.invoice_items || []).find((item) => [item.id, item.localId, item.serverId].filter(Boolean).includes(record.invoiceItemId));
        if (relatedItem && syncContext.rejectedInvoiceIds.has(relatedItem.invoiceId)) {
          skipped.push({ table, localId: record.localId || record.id, serverId: '', status: 'skipped_duplicate_invoice', record: null });
          return false;
        }
        return true;
      });
      results.push(...skipped);
      results.push(...await bulkPushMongoTable(db, table, allowed, deviceId, companyId));
      continue;
    }
    for (const record of records) {
      if ((table === 'invoice_items' || table === 'invoice_discounts') && syncContext.rejectedInvoiceIds.has(record.invoiceId)) {
        results.push({ table, localId: record.localId || record.id, serverId: '', status: 'skipped_duplicate_invoice', record: null });
        continue;
      }
      if (table === 'price_history') {
        const relatedItem = (changes.invoice_items || []).find((item) => [item.id, item.localId, item.serverId].filter(Boolean).includes(record.invoiceItemId));
        if (relatedItem && syncContext.rejectedInvoiceIds.has(relatedItem.invoiceId)) {
          results.push({ table, localId: record.localId || record.id, serverId: '', status: 'skipped_duplicate_invoice', record: null });
          continue;
        }
      }
      const result = await pushOneMongo(db, table, record, deviceId, companyId, syncContext);
      results.push(result);
      if (table === 'invoice_items' && result.status === 'synced' && result.record) {
        await upsertGeneratedPriceHistoryForItem(db, result.record, companyId, deviceId);
      }
    }
  }
  return { ok: true, companyId, serverTime: nowIso(), results, backend: 'mongodb' };
}

export async function mongoSyncPushBatch({ companyId, deviceId = 'unknown', changes = {} }) {
  return mongoSyncPush({ companyId, deviceId, changes });
}

export async function mongoSyncPull({ companyId, since = '' }) {
  const db = await getDb();
  const data = {};
  for (const table of syncTables) {
    const query = since
      ? {
          companyId,
          $or: [
            { updatedAt: { $gt: since } },
            { deletedAt: { $gt: since } }
          ]
        }
      : { companyId };
    data[table] = (await db.collection(collectionName(table))
      .find(query)
      .sort({ updatedAt: 1 })
      .toArray())
      .map(stripMongoId);
  }
  return { companyId, serverTime: nowIso(), data, backend: 'mongodb' };
}

export async function mongoSyncStatus(companyId) {
  const db = await getDb();
  const counts = {};
  for (const table of syncTables) {
    counts[table] = await db.collection(collectionName(table)).countDocuments({ companyId, deletedAt: { $in: [null, ''] } });
  }
  return { ok: true, enabled: true, backend: 'mongodb', companyId, counts, serverTime: nowIso() };
}

export const __test__ = {
  findMongoDuplicateInvoice,
  itemSignature,
  normalizeComparable
};
