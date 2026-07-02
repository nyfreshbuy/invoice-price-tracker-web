import { api, getAuthSession, getCompanyId } from './api.js';
import { localDb, syncTables, getDeviceId, nowIso } from './localDb.js';

const SYNC_BATCH_SIZE = 5;
const PULL_IMPORT_CHUNK_SIZE = 50;
const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const SYNC_STALE_MS = 120 * 1000;
const CORE_PULL_TABLES = new Set(['purchase_batches', 'suppliers', 'invoices', 'invoice_items', 'products', 'price_history']);

let syncing = false;
let lastError = '';
let waitingForWifi = false;
let syncProgress = { done: 0, total: 0, failed: 0 };
let autoSyncTimer = null;
let activeSyncRunId = 0;
let syncWatchdogTimer = null;
let syncStartedAt = 0;
let lastSyncProgressAt = 0;

function touchSyncProgress(extra = {}) {
  lastSyncProgressAt = Date.now();
  syncProgress = { ...syncProgress, ...extra, updatedAt: nowIso() };
}

function lastSyncStorageKey(companyId) {
  return `invoicePriceTrackerLastSyncAt:${companyId || 'default'}`;
}

function syncDiagnosticKey(companyId) {
  return `sync:lastResult:${companyId || 'default'}`;
}

function emitSyncStateChange() {
  window.dispatchEvent(new Event('sync-state-change'));
}

function clearSyncWatchdog() {
  if (syncWatchdogTimer) window.clearTimeout(syncWatchdogTimer);
  syncWatchdogTimer = null;
}

function armSyncWatchdog(runId) {
  clearSyncWatchdog();
  syncWatchdogTimer = window.setTimeout(() => {
    if (!syncing || activeSyncRunId !== runId) return;
    const remaining = Math.max(0, Number(syncProgress.total || 0) - Number(syncProgress.done || 0));
    syncing = false;
    syncProgress.failed = syncProgress.failed || remaining;
    lastError = 'Sync timeout, please retry';
    clearSyncWatchdog();
    const companyId = getCompanyId();
    if (companyId) {
      setSyncDiagnostic(companyId, {
        status: 'failed',
        finishedAt: nowIso(),
        error: lastError,
        pendingCount: remaining,
        failedCount: syncProgress.failed,
        stalledAt: syncProgress.table || '',
        lastRecordId: syncProgress.lastRecordId || ''
      }).catch(() => {});
    }
    console.error('[SYNC] watchdog timeout reset:', {
      runId,
      progress: { ...syncProgress }
    });
    emitSyncStateChange();
  }, SYNC_TIMEOUT_MS);
}

function flattenPendingChanges(changes) {
  return syncTables.flatMap((table) => (changes[table] || []).map((record) => ({ table, record })));
}

function buildBatchChanges(records) {
  const changes = Object.fromEntries(syncTables.map((table) => [table, []]));
  for (const entry of records) {
    const { record, droppedFields } = sanitizeSyncRecord(entry.table, entry.record);
    if (droppedFields.length) {
      console.warn('[SYNC] stripped non-sync image payload fields', {
        table: entry.table,
        id: entry.record?.id || entry.record?.localId || '',
        droppedFields
      });
    }
    changes[entry.table].push(record);
  }
  return changes;
}

const BINARY_FIELD_NAMES = new Set([
  'blob',
  'imageBlob',
  'file',
  'rawFile',
  'imageFile',
  'imageBinary',
  'imageData',
  'base64',
  'dataUrl',
  'dataURL',
  'objectUrl',
  'objectURL',
  'arrayBuffer',
  'buffer'
]);

function isBinaryLike(value) {
  return Boolean(
    value
    && ((typeof Blob !== 'undefined' && value instanceof Blob)
      || (typeof File !== 'undefined' && value instanceof File)
      || (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)
      || (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array))
  );
}

function sanitizeSyncValue(value, path = '', droppedFields = []) {
  const key = path.split('.').pop() || '';
  if (BINARY_FIELD_NAMES.has(key) || isBinaryLike(value)) {
    droppedFields.push(path || key || 'binary');
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^data:image\//i.test(trimmed) || /^blob:/i.test(trimmed)) {
      droppedFields.push(path || key || 'imageUrl');
      return '';
    }
    return value;
  }
  if (Array.isArray(value)) {
    const nextArray = [];
    value.forEach((item, index) => {
      const sanitized = sanitizeSyncValue(item, `${path}[${index}]`, droppedFields);
      if (sanitized !== undefined) nextArray.push(sanitized);
    });
    return nextArray;
  }
  if (value && typeof value === 'object') {
    const nextObject = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const childPath = path ? `${path}.${childKey}` : childKey;
      const sanitized = sanitizeSyncValue(childValue, childPath, droppedFields);
      if (sanitized !== undefined) nextObject[childKey] = sanitized;
    }
    return nextObject;
  }
  return value;
}

function sanitizeSyncRecord(table, record = {}) {
  const droppedFields = [];
  const sanitized = sanitizeSyncValue(record, '', droppedFields) || {};
  if (table === 'invoice_image_resources') {
    return {
      droppedFields,
      record: {
        id: sanitized.id || sanitized.localImageKey || sanitized.localId || '',
        companyId: sanitized.companyId || '',
        localId: sanitized.localId || sanitized.id || sanitized.localImageKey || '',
        serverId: sanitized.serverId || '',
        syncStatus: sanitized.syncStatus || 'pending',
        version: sanitized.version || 1,
        invoiceId: sanitized.invoiceId || '',
        originalFileName: sanitized.originalFileName || sanitized.fileName || '',
        localImageKey: sanitized.localImageKey || sanitized.id || '',
        cloudImageUrl: sanitized.cloudImageUrl || '',
        storageType: sanitized.storageType || 'indexeddb',
        imageStatus: ['local', 'missing', 'failed', 'uploaded'].includes(sanitized.imageStatus) ? sanitized.imageStatus : 'local',
        fileSize: Number(sanitized.fileSize || sanitized.size || 0),
        mimeType: sanitized.mimeType || '',
        errorReason: sanitized.errorReason || sanitized.syncError || '',
        createdAt: sanitized.createdAt || '',
        updatedAt: sanitized.updatedAt || '',
        deletedAt: sanitized.deletedAt || '',
        deviceId: sanitized.deviceId || ''
      }
    };
  }
  return { record: sanitized, droppedFields };
}

function countByStatus(results = []) {
  return results.reduce((counts, result) => {
    const key = result?.status || 'missing_status';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function countResultsByTable(results = []) {
  return results.reduce((counts, result) => {
    const table = result?.table || 'unknown';
    counts[table] = (counts[table] || 0) + 1;
    return counts;
  }, {});
}

function hasCoreBusinessData(stats = {}) {
  return ['invoices', 'invoice_items', 'products', 'price_history']
    .some((table) => Number(stats?.[table] || 0) > 0);
}

function extractPullData(payload = {}) {
  if (payload?.data && typeof payload.data === 'object') return payload.data;
  const rootData = {};
  for (const table of syncTables) {
    if (Array.isArray(payload?.[table])) rootData[table] = payload[table];
  }
  return rootData;
}

function pullDataCounts(data = {}) {
  return Object.fromEntries(syncTables.map((table) => [table, Array.isArray(data?.[table]) ? data[table].length : 0]));
}

function resultKey(result = {}) {
  const record = result.record || {};
  return [
    result.localId,
    result.serverId,
    result.id,
    result.clientId,
    result.recordId,
    result.uuid,
    record.localId,
    record.serverId,
    record.id,
    record.clientId,
    record.recordId,
    record.uuid
  ].filter(Boolean).map(String);
}

function recordKey(entry = {}) {
  const record = entry.record || {};
  return [
    record.localId,
    record.id,
    record.serverId,
    record.clientId,
    record.recordId,
    record.uuid
  ].filter(Boolean).map(String);
}

function inferResultTable(result = {}, batch = []) {
  if (result.table) return result.table;
  const keys = new Set(resultKey(result));
  const match = batch.find((entry) => recordKey(entry).some((key) => keys.has(key)));
  return match?.table || '';
}

async function applyPushResults(batch = [], results = []) {
  let appliedCount = 0;
  let notFoundCount = 0;
  let missingResultCount = 0;
  const appliedByTable = {};
  const notFoundByTable = {};
  const lastSyncedResults = [];
  const resultKeys = new Set();
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const positionalEntry = batch[index];
    let table = inferResultTable(result, batch);
    if (!table) {
      table = positionalEntry?.table || '';
    }
    if (!table) {
      notFoundCount += 1;
      notFoundByTable.unknown = (notFoundByTable.unknown || 0) + 1;
      console.warn('[SYNC FRONTEND] push result missing table and local match', result);
      continue;
    }
    for (const key of resultKey(result)) resultKeys.add(`${table}:${key}`);
    let applied = await localDb.markSynced(table, { ...result, table });
    if (!applied && positionalEntry?.table === table) {
      const fallbackLocalId = positionalEntry.record?.localId || positionalEntry.record?.id || positionalEntry.record?.serverId || '';
      applied = await localDb.markSynced(table, { ...result, table, localId: result.localId || fallbackLocalId });
      if (fallbackLocalId) resultKeys.add(`${table}:${fallbackLocalId}`);
      console.warn('[SYNC FRONTEND] markSynced used positional fallback', {
        table,
        fallbackLocalId,
        resultKeys: resultKey(result)
      });
    }
    if (applied) {
      appliedCount += 1;
      appliedByTable[table] = (appliedByTable[table] || 0) + 1;
      if (result?.status === 'synced') lastSyncedResults.push({ ...result, table, localId: result.localId || positionalEntry?.record?.localId || positionalEntry?.record?.id });
    } else {
      notFoundCount += 1;
      notFoundByTable[table] = (notFoundByTable[table] || 0) + 1;
    }
  }
  for (const entry of batch) {
    const keys = recordKey(entry).map((key) => `${entry.table}:${key}`);
    if (keys.some((key) => resultKeys.has(key))) continue;
    const marked = await localDb.markSyncFailed(entry.table, entry.record.localId || entry.record.id || entry.record.serverId, 'Sync push returned no result for this record');
    if (marked) missingResultCount += 1;
  }
  return {
    appliedCount,
    notFoundCount,
    missingResultCount,
    appliedByTable,
    notFoundByTable,
    lastSyncedResults,
    failedCount: notFoundCount + missingResultCount,
    resultCount: results.length
  };
}

function connectionType() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const online = navigator.onLine;
  const type = String(connection?.type || '');
  const effectiveType = String(connection?.effectiveType || '');
  return {
    type: type || (online ? 'online' : 'offline'),
    effectiveType,
    label: type || effectiveType || (online ? 'online' : 'offline')
  };
}

function looksCellularConnection() {
  const { type, effectiveType } = connectionType();
  return type === 'cellular' || ['slow-2g', '2g', '3g'].includes(effectiveType);
}

export async function getSyncPreferences() {
  const [autoSync, wifiOnly, allowCellular] = await Promise.all([
    localDb.getMeta('sync:autoSync'),
    localDb.getMeta('sync:wifiOnly'),
    localDb.getMeta('sync:allowCellular')
  ]);
  return {
    autoSync: autoSync?.value !== 'false',
    wifiOnly: wifiOnly?.value === 'true',
    allowCellular: allowCellular?.value === 'true'
  };
}

export async function setSyncPreferences(preferences = {}) {
  if ('autoSync' in preferences) await localDb.setMeta('sync:autoSync', preferences.autoSync ? 'true' : 'false');
  if ('wifiOnly' in preferences) await localDb.setMeta('sync:wifiOnly', preferences.wifiOnly ? 'true' : 'false');
  if ('allowCellular' in preferences) await localDb.setMeta('sync:allowCellular', preferences.allowCellular ? 'true' : 'false');
  emitSyncStateChange();
  return getSyncPreferences();
}

async function lastSyncAt() {
  const companyId = getCompanyId();
  const meta = companyId ? await localDb.getMeta(`lastPullAt:${companyId}`) : null;
  return meta?.value || localStorage.getItem(lastSyncStorageKey(companyId)) || localStorage.getItem('lastSyncTime') || '';
}

async function setLastSyncAt(companyId, value) {
  const timestamp = value || nowIso();
  await localDb.setMeta(`lastPullAt:${companyId}`, timestamp);
  localStorage.setItem(lastSyncStorageKey(companyId), timestamp);
  localStorage.setItem('lastSyncTime', timestamp);
  return timestamp;
}

async function getSyncDiagnostic(companyId = getCompanyId()) {
  const meta = companyId ? await localDb.getMeta(syncDiagnosticKey(companyId)) : null;
  if (meta?.value) {
    try {
      return JSON.parse(meta.value);
    } catch {
      return { status: 'unknown', error: meta.value };
    }
  }
  try {
    return JSON.parse(localStorage.getItem(syncDiagnosticKey(companyId)) || 'null') || null;
  } catch {
    return null;
  }
}

async function setSyncDiagnostic(companyId, patch = {}) {
  const current = await getSyncDiagnostic(companyId);
  const next = {
    ...(current || {}),
    ...patch,
    updatedAt: nowIso()
  };
  const serialized = JSON.stringify(next);
  if (companyId) await localDb.setMeta(syncDiagnosticKey(companyId), serialized);
  localStorage.setItem(syncDiagnosticKey(companyId), serialized);
  return next;
}

export async function clearLastSyncedPendingRecords() {
  const companyId = getCompanyId();
  const diagnostic = await getSyncDiagnostic(companyId);
  const results = Array.isArray(diagnostic?.lastPushSyncedResults) ? diagnostic.lastPushSyncedResults : [];
  let applied = 0;
  const appliedByTable = {};
  for (const result of results) {
    if (!result?.table) continue;
    const ok = await localDb.markSynced(result.table, result);
    if (!ok) continue;
    applied += 1;
    appliedByTable[result.table] = (appliedByTable[result.table] || 0) + 1;
  }
  const clearedWithServerId = typeof localDb.clearPendingRecordsWithServerId === 'function'
    ? await localDb.clearPendingRecordsWithServerId()
    : {};
  for (const [table, count] of Object.entries(clearedWithServerId)) {
    applied += Number(count || 0);
    appliedByTable[table] = (appliedByTable[table] || 0) + Number(count || 0);
  }
  const pendingCount = await localDb.getPendingCount();
  await setSyncDiagnostic(companyId, {
    manualPendingClearAt: nowIso(),
    manualPendingClearApplied: applied,
    manualPendingClearByServerId: clearedWithServerId,
    pendingCount
  });
  console.log('[SYNC FRONTEND] manual clear last synced pending', {
    totalResults: results.length,
    applied,
    appliedByTable,
    pendingCount
  });
  emitSyncStateChange();
  return { total: results.length, applied, appliedByTable, pendingCount };
}

function totalSyncRecords(changes = {}) {
  return Object.values(changes || {}).reduce((sum, records) => sum + (Array.isArray(records) ? records.length : 0), 0);
}

function errorDetails(error) {
  return {
    name: error?.name || '',
    message: error?.message || String(error || ''),
    stack: error?.stack || ''
  };
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function importPulledTable(table, records = [], importWarnings = []) {
  if (!records.length) return { table, imported: 0, skipped: 0 };
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failedRecords = [];
  for (let index = 0; index < records.length; index += PULL_IMPORT_CHUNK_SIZE) {
    const chunk = records.slice(index, index + PULL_IMPORT_CHUNK_SIZE);
    touchSyncProgress({
      phase: 'import',
      table,
      tableDone: index,
      tableTotal: records.length,
      lastRecordId: chunk[0]?.id || chunk[0]?.localId || chunk[0]?.serverId || ''
    });
    emitSyncStateChange();
    const failedBeforeChunk = failedRecords.length;
    try {
      if (typeof localDb.mergeRemoteMany === 'function') {
        const result = await localDb.mergeRemoteMany(table, chunk, { silent: true, batchSize: 50 });
        imported += Number(result.imported || 0);
        skipped += Number(result.skipped || 0);
        failed += Number(result.failed || 0);
        if (Array.isArray(result.failedRecords)) failedRecords.push(...result.failedRecords);
      } else {
        for (const record of chunk) await localDb.mergeRemote(table, record);
        imported += chunk.length;
      }
      console.log('[SYNC] imported chunk', {
        table,
        imported,
        skipped,
        chunkStart: index,
        chunkSize: chunk.length
      });
    } catch (error) {
      const details = errorDetails(error);
      console.error('[SYNC] failed table:', table, details);
      if (CORE_PULL_TABLES.has(table)) throw error;
      importWarnings.push({ table, ...details });
    } finally {
      const newFailedCount = failedRecords.length - failedBeforeChunk;
      if (newFailedCount > 0) {
        importWarnings.push({
          table,
          warning: 'Some records failed to import',
          failedRecords: failedRecords.slice(failedBeforeChunk).slice(-20)
        });
      }
      syncProgress.done = Math.min(syncProgress.total, syncProgress.done + chunk.length);
      touchSyncProgress({
        phase: 'import',
        table,
        tableDone: Math.min(records.length, index + chunk.length),
        tableTotal: records.length,
        lastRecordId: chunk[chunk.length - 1]?.id || chunk[chunk.length - 1]?.localId || chunk[chunk.length - 1]?.serverId || ''
      });
      emitSyncStateChange();
      await yieldToBrowser();
    }
  }
  return { table, imported, skipped, failed, failedRecords };
}

function syncLabel({ session, pendingCount, conflictCount, error }) {
  if (!session) return '\u8bf7\u5148\u767b\u5f55';
  if (!navigator.onLine) return '\u2601 \u79bb\u7ebf\u6a21\u5f0f';
  if (waitingForWifi) return '\u2601 \u7b49\u5f85 WiFi';
  if (syncing && syncProgress.phase === 'import' && syncProgress.table) {
    return `\u2601 \u6b63\u5728\u5bfc\u5165 ${syncProgress.table} ${syncProgress.done}/${syncProgress.total}`;
  }
  if (syncing && syncProgress.total > 0) return `\u2601 \u6b63\u5728\u540c\u6b65 ${syncProgress.done}/${syncProgress.total}`;
  if (syncing) return '\u2601 \u6b63\u5728\u540c\u6b65...';
  if (error) return syncProgress.failed > 0 ? `\u2601 \u540c\u6b65\u5931\u8d25 ${syncProgress.failed} \u6761` : '\u2601 \u540c\u6b65\u5931\u8d25';
  if (conflictCount > 0) return `\u2601 \u9700\u8981\u4eba\u5de5\u786e\u8ba4 ${conflictCount} \u6761`;
  if (pendingCount > 0) return `\u2601 \u5f85\u540c\u6b65 ${pendingCount} \u6761`;
  return '\u2601 \u5df2\u540c\u6b65';
}


export async function getSyncSnapshot() {
  if (syncing && lastSyncProgressAt && Date.now() - lastSyncProgressAt > SYNC_STALE_MS) {
    const companyId = getCompanyId();
    lastError = `\u540c\u6b65\u505c\u6ede\uff1a${syncProgress.table || '\u672a\u77e5\u8868'} ${syncProgress.lastRecordId || ''}`;
    syncing = false;
    clearSyncWatchdog();
    syncStartedAt = 0;
    if (companyId) {
      await setSyncDiagnostic(companyId, {
        status: 'failed',
        finishedAt: nowIso(),
        error: lastError,
        stalledAt: syncProgress.table || '',
        lastRecordId: syncProgress.lastRecordId || '',
        pendingCount: await localDb.getPendingCount().catch(() => null),
        failedCount: syncProgress.failed || 0
      }).catch(() => {});
    }
  }
  if (syncing && syncStartedAt && Date.now() - syncStartedAt > SYNC_TIMEOUT_MS + 10000) {
    console.warn('[SYNC] stale sync state reset from snapshot', {
      startedAt: syncStartedAt,
      progress: { ...syncProgress }
    });
    syncing = false;
    lastError = lastError || '\u540c\u6b65\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5';
    clearSyncWatchdog();
    syncStartedAt = 0;
  }
  const session = getAuthSession();
  const companyId = getCompanyId();
  const [pendingCount, conflictCount, failedCount, pendingChanges, preferences, lastSync, diagnostic] = await Promise.all([
    localDb.getPendingCount(),
    localDb.getConflictCount(),
    localDb.getFailedCount(),
    localDb.getPendingChanges(),
    getSyncPreferences(),
    lastSyncAt(),
    getSyncDiagnostic(companyId)
  ]);
  const effectiveLastError = lastError || (diagnostic?.status === 'failed' ? diagnostic.error || '' : '');
  return {
    online: navigator.onLine,
    authenticated: Boolean(session),
    pendingCount,
    conflictCount,
    failedCount,
    pendingByTable: Object.fromEntries(Object.entries(pendingChanges).map(([table, records]) => [table, records.length])),
    syncing,
    lastError: effectiveLastError,
    waitingForWifi,
    syncProgress: { ...syncProgress },
    diagnostic,
    preferences,
    lastSyncAt: lastSync,
    connection: connectionType(),
    label: syncLabel({ session, pendingCount, conflictCount, error: effectiveLastError })
  };
}

function shouldSkipAutoSync({ force, reason, preferences, lastSync }) {
  if (force) return '';
  if (!preferences.autoSync) return '\u81ea\u52a8\u540c\u6b65\u5df2\u5173\u95ed';
  if (preferences.wifiOnly && !preferences.allowCellular && looksCellularConnection()) return '\u7b49\u5f85 WiFi';
  const last = Date.parse(lastSync || '');
  if (['startup', 'online'].includes(reason)) {
    if (Number.isFinite(last) && Date.now() - last < 60 * 1000) return '\u521a\u521a\u540c\u6b65\u8fc7';
    return '';
  }
  if (Number.isFinite(last) && Date.now() - last < AUTO_SYNC_INTERVAL_MS) return '\u8ddd\u79bb\u4e0a\u6b21\u540c\u6b65\u672a\u8d85\u8fc7 30 \u5206\u949f';
  return '';
}


function scheduleNextAutoSync() {
  if (autoSyncTimer) window.clearTimeout(autoSyncTimer);
  autoSyncTimer = window.setTimeout(() => {
    syncNow({ reason: 'interval' }).catch((error) => console.error('[sync] scheduled sync failed:', error));
    scheduleNextAutoSync();
  }, AUTO_SYNC_INTERVAL_MS);
}

export function markSyncPending() {
  emitSyncStateChange();
}

export async function syncNow({ force = false, reason = 'manual' } = {}) {
  if (syncing) {
    const stale = syncStartedAt && Date.now() - syncStartedAt > SYNC_TIMEOUT_MS + 5000;
    if (!force || !stale) return getSyncSnapshot();
    console.warn('[SYNC] stale sync lock reset before force sync', {
      reason,
      startedAt: syncStartedAt,
      progress: { ...syncProgress }
    });
    syncing = false;
    clearSyncWatchdog();
  }
  if (!getAuthSession()) {
    lastError = '';
    waitingForWifi = false;
    return getSyncSnapshot();
  }
  if (!navigator.onLine) {
    lastError = '';
    waitingForWifi = false;
    return getSyncSnapshot();
  }

  syncing = true;
  syncStartedAt = Date.now();
  lastSyncProgressAt = Date.now();
  waitingForWifi = false;
  touchSyncProgress({ done: 0, total: 0, failed: 0, phase: 'start', table: '', lastRecordId: '' });
  lastError = '';
  const runId = activeSyncRunId + 1;
  activeSyncRunId = runId;
  armSyncWatchdog(runId);
  console.log('[SYNC] start', { reason, force, runId });
  emitSyncStateChange();

  let syncCompanyId = '';
  let pushedTotal = 0;
  let pulledTotal = 0;
  let pushFailedCount = 0;
  const pushErrors = [];
  const syncedResultsForDiagnostic = [];
  try {
    const preferences = await getSyncPreferences();
    const lastSync = await lastSyncAt();
    const skipReason = shouldSkipAutoSync({ force, reason, preferences, lastSync });
    if (skipReason) {
      waitingForWifi = skipReason === '等待 WiFi';
      lastError = '';
      console.log('[SYNC] skipped', { reason, skipReason });
      return getSyncSnapshot();
    }

    const deviceId = getDeviceId();
    const companyId = getCompanyId();
    syncCompanyId = companyId;
    if (!companyId) {
      lastError = '请先登录';
      return getSyncSnapshot();
    }

    if (force) {
      const retried = await localDb.retryFailedSyncRecords();
      const retriedCount = Object.values(retried).reduce((sum, count) => sum + Number(count || 0), 0);
      if (retriedCount) {
        console.warn('[SYNC] retrying failed local records', { companyId, retried });
      }
    }

    const clearedRemoteRepairPending = typeof localDb.clearRemoteRepairPendingRecords === 'function'
      ? await localDb.clearRemoteRepairPendingRecords()
      : {};
    if (Object.keys(clearedRemoteRepairPending).length) {
      console.log('[SYNC FRONTEND] cleared remote repair pending records', clearedRemoteRepairPending);
    }
    const pending = await localDb.getPendingChanges();
    const pendingRecords = flattenPendingChanges(pending);
    const pendingDetails = await localDb.getPendingDebugDetails();
    await setSyncDiagnostic(companyId, {
      status: 'running',
      startedAt: nowIso(),
      finishedAt: '',
      error: '',
      reason,
      pushCount: pendingRecords.length,
      pullCount: 0,
      pendingCount: pendingRecords.length
    });
    console.log('[SYNC] state', {
      syncInProgress: syncing,
      lastSyncTime: await lastSyncAt(),
      pendingCount: pendingRecords.length
    });
    console.log('[SYNC] push start', {
      companyId,
      reason,
      pendingCounts: Object.fromEntries(Object.entries(pending).map(([table, records]) => [table, records.length])),
      pendingDetails
    });
    console.log('[SYNC FRONTEND] pending before push', {
      total: pendingRecords.length,
      byTable: Object.fromEntries(Object.entries(pending).map(([table, records]) => [table, records.length]))
    });

    if (pendingRecords.length) {
      touchSyncProgress({ done: 0, total: pendingRecords.length, failed: 0, phase: 'push', table: '', lastRecordId: '' });
      emitSyncStateChange();

      for (let index = 0; index < pendingRecords.length; index += SYNC_BATCH_SIZE) {
        const batch = pendingRecords.slice(index, index + SYNC_BATCH_SIZE);
        try {
          const batchChanges = buildBatchChanges(batch);
          console.log('[SYNC FRONTEND] pushed table price_history count', (batchChanges.price_history || []).length);
          console.log('[SYNC FRONTEND] pushed table products count', (batchChanges.products || []).length);
          const pushed = await api.syncPush({ deviceId, companyId, changes: batchChanges });
          const results = Array.isArray(pushed.results) ? pushed.results : [];
          pushedTotal += results.length;
          const resultTables = countResultsByTable(results);
          console.log('[SYNC] push batch finish', {
            companyId,
            batchStart: index,
            batchSize: batch.length,
            uploadCounts: Object.fromEntries(Object.entries(batchChanges).map(([table, records]) => [table, records.length]).filter(([, count]) => count > 0)),
            resultCount: results.length,
            resultTables,
            resultStatuses: countByStatus(results),
            backend: pushed.backend || '',
            responseOk: Boolean(pushed.ok)
          });
          const { appliedCount, notFoundCount, missingResultCount, appliedByTable, lastSyncedResults } = await applyPushResults(batch, results);
          syncedResultsForDiagnostic.push(...lastSyncedResults);
          console.log('[SYNC FRONTEND] markSynced table products success count', appliedByTable.products || 0);
          console.log('[SYNC FRONTEND] markSynced table price_history success count', appliedByTable.price_history || 0);
          const batchFailedCount = notFoundCount + missingResultCount;
          if (batchFailedCount > 0) {
            pushFailedCount += batchFailedCount;
            syncProgress.failed += batchFailedCount;
            pushErrors.push(`${batchFailedCount} sync records did not apply locally`);
          }
          const remainingAfterBatch = await localDb.getPendingCount();
          console.log('[SYNC FRONTEND] pending after markSynced', remainingAfterBatch);
          console.log('[SYNC] local apply finish', {
            companyId,
            batchStart: index,
            appliedCount,
            notFoundCount,
            missingResultCount,
            appliedByTable,
            successCount: results.length - notFoundCount,
            failedCount: notFoundCount + missingResultCount,
            remainingPending: remainingAfterBatch
          });
        } catch (error) {
          lastError = error.message || '\u540c\u6b65\u5931\u8d25';
          console.error('[SYNC] push error', { batchStart: index, batchSize: batch.length, error });
          console.warn('[SYNC] retrying failed batch item-by-item', { batchStart: index, batchSize: batch.length });
          for (const entry of batch) {
            try {
              const singleChanges = buildBatchChanges([entry]);
              const pushed = await api.syncPush({ deviceId, companyId, changes: singleChanges });
              const singleResults = Array.isArray(pushed.results) ? pushed.results : [];
              pushedTotal += singleResults.length;
              const applied = await applyPushResults([entry], singleResults);
              syncedResultsForDiagnostic.push(...(applied.lastSyncedResults || []));
              if (applied.failedCount > 0) {
                pushFailedCount += applied.failedCount;
                syncProgress.failed += applied.failedCount;
                pushErrors.push(`\u540c\u6b65\u5931\u8d25\uff1a${entry.table} ${entry.record?.id || entry.record?.localId || ''}`);
              }
              console.log('[SYNC] single push finish', {
                table: entry.table,
                id: entry.record?.id || entry.record?.localId || '',
                resultStatuses: countByStatus(singleResults),
                applied
              });
            } catch (singleError) {
              syncProgress.failed += 1;
              pushFailedCount += 1;
              const message = singleError.message || '\u540c\u6b65\u5931\u8d25';
              pushErrors.push(`${entry.table} ${entry.record?.id || entry.record?.localId || ''}: ${message}`);
              await localDb.markSyncFailed(entry.table, entry.record.localId || entry.record.id || entry.record.serverId, message);
              console.error('[SYNC] single push failed', {
                table: entry.table,
                id: entry.record?.id || entry.record?.localId || '',
                error: errorDetails(singleError)
              });
            }
          }
        } finally {
          touchSyncProgress({ done: Math.min(syncProgress.total, syncProgress.done + batch.length), phase: 'push' });
          emitSyncStateChange();
        }
      }
    }
    console.log('[SYNC] push finish', {
      companyId,
      uploadedTotal: pendingRecords.length,
      failedTotal: syncProgress.failed,
      remainingPending: await localDb.getPendingCount(),
      remainingPendingDetails: await localDb.getPendingDebugDetails()
    });

    const metaKey = `lastPullAt:${companyId}`;
    const meta = await localDb.getMeta(metaKey);
    const stats = await localDb.getStats();
    const hasLocalData = hasCoreBusinessData(stats);
    console.log('[SYNC] pull start', {
      companyId,
      since: hasLocalData ? (meta?.value || '') : '',
      coreBusinessCounts: {
        invoices: stats.invoices || 0,
        invoice_items: stats.invoice_items || 0,
        products: stats.products || 0,
        price_history: stats.price_history || 0
      }
    });
    const pulled = await api.syncPull(hasLocalData ? (meta?.value || '') : '');
    const pulledData = extractPullData(pulled);
    pulledTotal = totalSyncRecords(pulledData);
    if (pulledTotal > 0) {
      touchSyncProgress({ done: 0, total: pulledTotal, failed: syncProgress.failed || 0, phase: 'import', table: '', lastRecordId: '' });
      emitSyncStateChange();
    }
    console.log('[SYNC] pull finish', {
      companyId,
      since: hasLocalData ? (meta?.value || '') : '',
      backend: pulled.backend || '',
      responseKeys: Object.keys(pulled || {}),
      counts: pullDataCounts(pulledData)
    });
    console.log('[SYNC] pull response counts', pullDataCounts(pulledData));
    const importWarnings = [];
    for (const table of syncTables) {
      const records = pulledData?.[table] || [];
      console.log(`[SYNC] importing ${table} count`, records.length);
      const result = await importPulledTable(table, records, importWarnings);
      console.log(`[SYNC] imported ${table}`, result);
    }
    const statsBeforeProductRebuild = await localDb.getStats().catch(() => ({}));
    const productRebuild = typeof localDb.rebuildProductsFromLocalRecords === 'function'
      ? await localDb.rebuildProductsFromLocalRecords()
      : null;
    const statsAfterProductRebuild = await localDb.getStats().catch(() => ({}));
    console.log('[SYNC FRONTEND] products restore summary', {
      cloudProducts: (pulledData?.products || []).length,
      localProductsBefore: statsBeforeProductRebuild.products ?? null,
      localProductsAfter: statsAfterProductRebuild.products ?? null,
      rebuiltCreated: productRebuild?.created || 0,
      rebuiltUpdatedReferences: productRebuild?.updatedReferences || 0,
      deletedProducts: (pulledData?.products || []).filter((record) => record?.deletedAt).length
    });
    window.dispatchEvent(new Event('local-db-change'));
    console.log('[SYNC] import finished', { warnings: importWarnings });
    if (pulledData && typeof pulledData === 'object') {
      await setLastSyncAt(companyId, pulled.serverTime || nowIso());
      const latestLastSyncAt = await lastSyncAt();
      const localDiagnostics = typeof localDb.getLocalDiagnostics === 'function'
        ? await localDb.getLocalDiagnostics().catch(() => null)
        : null;
      const coreLocalCounts = {
        invoices: localDiagnostics?.counts?.invoices ?? null,
        invoice_items: localDiagnostics?.counts?.invoice_items ?? null,
        products: localDiagnostics?.counts?.products ?? null,
        price_history: localDiagnostics?.counts?.price_history ?? null
      };
      console.log('[SYNC] lastSyncAt updated', { companyId, lastSyncAt: latestLastSyncAt });
      console.log('[SYNC] local diagnostics after sync', {
        ...coreLocalCounts,
        lastSyncAt: latestLastSyncAt,
        lastSyncError: ''
      });
      const pushErrorMessage = pushFailedCount > 0
        ? `\u6709 ${pushFailedCount} \u6761\u5f85\u4e0a\u4f20\u6570\u636e\u540c\u6b65\u5931\u8d25\uff0c\u672c\u5730\u67e5\u8be2\u4e0d\u53d7\u5f71\u54cd`
        : '';
      await setSyncDiagnostic(companyId, {
        status: pushFailedCount > 0 ? 'partial_success' : (importWarnings.length ? 'success_with_warnings' : 'success'),
        finishedAt: nowIso(),
        error: '',
        pushErrors: pushErrors.slice(-20),
        pushError: pushErrorMessage,
        warnings: importWarnings,
        warningCount: importWarnings.length,
        localCounts: coreLocalCounts,
        lastSyncAt: latestLastSyncAt,
        lastSyncError: '',
        pushCount: pushedTotal,
        pullCount: pulledTotal,
        pendingCount: await localDb.getPendingCount(),
        failedCount: pushFailedCount,
        pendingDetails: (await localDb.getPendingDebugDetails()).slice(0, 50),
        lastPushSyncedResults: syncedResultsForDiagnostic.slice(-500)
      });
      lastError = '';
      console.log('[SYNC] finish', { companyId, serverTime: pulled.serverTime || '', pendingCount: await localDb.getPendingCount() });
    } else {
      lastError = `同步失败：剩余 ${await localDb.getPendingCount()} 条`;
      await setSyncDiagnostic(companyId, {
        status: 'failed',
        finishedAt: nowIso(),
        error: lastError,
        pushCount: pushedTotal,
        pullCount: pulledTotal,
        pendingCount: await localDb.getPendingCount(),
        failedCount: syncProgress.failed,
        lastPushSyncedResults: syncedResultsForDiagnostic.slice(-500)
      });
      console.warn('[SYNC] finish with failures', {
        companyId,
        failedTotal: syncProgress.failed,
        remainingPending: await localDb.getPendingCount(),
        remainingPendingDetails: await localDb.getPendingDebugDetails()
      });
    }
  } catch (error) {
    lastError = error.message || '同步失败';
    if (syncCompanyId) {
      await setSyncDiagnostic(syncCompanyId, {
        status: 'failed',
        finishedAt: nowIso(),
        error: lastError,
        pushCount: pushedTotal,
        pullCount: pulledTotal,
        pendingCount: await localDb.getPendingCount().catch(() => null),
        failedCount: syncProgress.failed,
        lastPushSyncedResults: syncedResultsForDiagnostic.slice(-500)
      }).catch(() => {});
    }
    console.error('[SYNC] error', error);
  } finally {
    if (activeSyncRunId === runId) {
      clearSyncWatchdog();
      syncing = false;
      syncProgress.done = Math.min(syncProgress.done, syncProgress.total);
      console.log('[SYNC] finally reset', {
        runId,
        syncInProgress: syncing,
        progress: { ...syncProgress },
        lastError,
        pendingCount: await localDb.getPendingCount().catch(() => null),
        lastSyncTime: await lastSyncAt().catch(() => '')
      });
      syncStartedAt = 0;
      scheduleNextAutoSync();
      emitSyncStateChange();
    }
  }

  return getSyncSnapshot();
}

export async function pullFromCloud({ full = false } = {}) {
  if (syncing) return getSyncSnapshot();
  if (!getAuthSession()) {
    lastError = '请先登录';
    return getSyncSnapshot();
  }
  if (!navigator.onLine) {
    lastError = '当前离线，无法从云端恢复';
    return getSyncSnapshot();
  }
  syncing = true;
  syncStartedAt = Date.now();
  lastSyncProgressAt = Date.now();
  waitingForWifi = false;
  touchSyncProgress({ done: 0, total: 0, failed: 0, phase: 'pull', table: '', lastRecordId: '' });
  lastError = '';
  const runId = activeSyncRunId + 1;
  activeSyncRunId = runId;
  armSyncWatchdog(runId);
  console.log('[SYNC] pull start', { full, runId });
  emitSyncStateChange();
  let syncCompanyId = '';
  try {
    const companyId = getCompanyId();
    syncCompanyId = companyId;
    await setSyncDiagnostic(companyId, {
      status: 'running',
      startedAt: nowIso(),
      finishedAt: '',
      error: '',
      reason: full ? 'restore-full' : 'restore',
      pushCount: 0,
      pullCount: 0
    });
    const metaKey = `lastPullAt:${companyId}`;
    const stats = await localDb.getStats();
    const shouldFullPull = full || !hasCoreBusinessData(stats);
    const meta = shouldFullPull ? null : await localDb.getMeta(metaKey);
    const pulled = await api.syncPull(meta?.value || '');
    const pulledData = extractPullData(pulled);
    const restorePullTotal = totalSyncRecords(pulledData);
    if (restorePullTotal > 0) {
      touchSyncProgress({ done: 0, total: restorePullTotal, failed: 0, phase: 'import', table: '', lastRecordId: '' });
      emitSyncStateChange();
    }
    console.log('[sync] cloud pull completed:', {
      companyId,
      full: shouldFullPull,
      since: meta?.value || '',
      coreBusinessCounts: {
        invoices: stats.invoices || 0,
        invoice_items: stats.invoice_items || 0,
        products: stats.products || 0,
        price_history: stats.price_history || 0
      },
      backend: pulled.backend || '',
      responseKeys: Object.keys(pulled || {}),
      counts: pullDataCounts(pulledData)
    });
    console.log('[SYNC] pull response counts', pullDataCounts(pulledData));
    const importWarnings = [];
    for (const table of syncTables) {
      const records = pulledData?.[table] || [];
      console.log(`[SYNC] importing ${table} count`, records.length);
      const result = await importPulledTable(table, records, importWarnings);
      console.log(`[SYNC] imported ${table}`, result);
    }
    const productRebuild = typeof localDb.rebuildProductsFromLocalRecords === 'function'
      ? await localDb.rebuildProductsFromLocalRecords()
      : null;
    const localDiagnostics = typeof localDb.getLocalDiagnostics === 'function'
      ? await localDb.getLocalDiagnostics().catch(() => null)
      : null;
    window.dispatchEvent(new Event('local-db-change'));
    console.log('[SYNC] import finished', { warnings: importWarnings });
    await setLastSyncAt(companyId, pulled.serverTime || nowIso());
    const latestLastSyncAt = await lastSyncAt();
    console.log('[SYNC] lastSyncAt updated', { companyId, lastSyncAt: latestLastSyncAt });
    await setSyncDiagnostic(companyId, {
      status: importWarnings.length ? 'success_with_warnings' : 'success',
      finishedAt: nowIso(),
      error: '',
      warnings: importWarnings,
      warningCount: importWarnings.length,
      localCounts: {
        invoices: localDiagnostics?.counts?.invoices ?? null,
        invoice_items: localDiagnostics?.counts?.invoice_items ?? null,
        products: localDiagnostics?.counts?.products ?? null,
        price_history: localDiagnostics?.counts?.price_history ?? null
      },
      productRebuild,
      lastSyncAt: latestLastSyncAt,
      lastSyncError: '',
      pushCount: 0,
      pullCount: totalSyncRecords(pulledData),
      pendingCount: await localDb.getPendingCount()
    });
    lastError = '';
    console.log('[SYNC] pull finish', { full, serverTime: pulled.serverTime || '' });
  } catch (error) {
    lastError = error.message || '从云端恢复失败';
    if (syncCompanyId) {
      await setSyncDiagnostic(syncCompanyId, {
        status: 'failed',
        finishedAt: nowIso(),
        error: lastError,
        pushCount: 0,
        pullCount: 0,
        pendingCount: await localDb.getPendingCount().catch(() => null)
      }).catch(() => {});
    }
    console.error('[SYNC] pull error', error);
  } finally {
    if (activeSyncRunId === runId) {
      clearSyncWatchdog();
      syncing = false;
      syncStartedAt = 0;
      console.log('[SYNC] finally reset', { runId, syncInProgress: syncing, lastError });
      emitSyncStateChange();
    }
  }
  return getSyncSnapshot();
}

export async function resetLocalCacheAndPull() {
  if (syncing) return getSyncSnapshot();
  if (!getAuthSession()) {
    lastError = '请先登录';
    return getSyncSnapshot();
  }
  if (!navigator.onLine) {
    lastError = '当前离线，无法重新拉取云端数据';
    return getSyncSnapshot();
  }
  syncing = true;
  syncStartedAt = Date.now();
  lastSyncProgressAt = Date.now();
  waitingForWifi = false;
  touchSyncProgress({ done: 0, total: 0, failed: 0, phase: 'reset', table: '', lastRecordId: '' });
  lastError = '';
  const runId = activeSyncRunId + 1;
  activeSyncRunId = runId;
  armSyncWatchdog(runId);
  console.log('[SYNC] reset local cache start', { runId });
  emitSyncStateChange();
  try {
    await localDb.clearLocalCacheForCurrentCompany();
    lastError = '';
  } catch (error) {
    lastError = error.message || '清空本地缓存失败';
    console.error('[SYNC] reset local cache error', error);
  } finally {
    if (activeSyncRunId === runId) {
      clearSyncWatchdog();
      syncing = false;
      syncStartedAt = 0;
      console.log('[SYNC] finally reset', { runId, syncInProgress: syncing, lastError });
      emitSyncStateChange();
    }
  }
  if (!lastError) return pullFromCloud({ full: true });
  return getSyncSnapshot();
}

export function startAutoSync() {
  const runStartupSync = () => syncNow({ reason: 'startup' });
  const runOnlineSync = () => syncNow({ reason: 'online' });
  const runAuthSync = () => syncNow({ reason: 'startup' });

  window.addEventListener('online', runOnlineSync);
  window.addEventListener('auth-change', runAuthSync);
  window.setTimeout(runStartupSync, 300);
  scheduleNextAutoSync();

  return () => {
    window.removeEventListener('online', runOnlineSync);
    window.removeEventListener('auth-change', runAuthSync);
    if (autoSyncTimer) window.clearTimeout(autoSyncTimer);
  };
}
