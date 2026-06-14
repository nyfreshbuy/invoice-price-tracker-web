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

async function findMongoDuplicateInvoice(db, incoming, companyId) {
  const collection = db.collection('invoices');
  const invoiceNo = String(incoming.invoiceNo || '').trim();
  const invoiceDate = String(incoming.invoiceDate || '').trim();
  const supplierId = String(incoming.supplierId || '').trim();
  const totalAmount = Number(incoming.totalAmount || 0);
  const selfIds = [incoming.id, incoming.serverId, incoming.localId].filter(Boolean);
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
      invoiceDate,
      totalAmount: { $gte: totalAmount - 0.009, $lte: totalAmount + 0.009 },
      ...(supplierId ? { supplierId } : {})
    }).limit(5).toArray();
    if (candidates.length) return candidates[0];
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
    if (duplicate) return duplicate;
  }

  const imageHash = String(incoming.imageHash || '').trim();
  if (imageHash && totalAmount > 0) {
    return collection.findOne({
      ...base,
      imageHash,
      totalAmount: { $gte: totalAmount - 0.009, $lte: totalAmount + 0.009 }
    });
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
    const duplicate = await findMongoDuplicateInvoice(db, record, companyId);
    if (duplicate && !incoming.forceSave && !incoming.force) {
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
    if (duplicate) {
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

export async function mongoSyncPush({ companyId, deviceId = 'unknown', changes = {} }) {
  const db = await getDb();
  const results = [];
  const syncContext = { rejectedInvoiceIds: new Set() };
  for (const table of syncTables) {
    const records = Array.isArray(changes[table]) ? changes[table] : [];
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
      results.push(await pushOneMongo(db, table, record, deviceId, companyId, syncContext));
    }
  }
  return { ok: true, companyId, serverTime: nowIso(), results, backend: 'mongodb' };
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
