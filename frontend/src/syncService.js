import { api, getAuthSession, getCompanyId } from './api.js';
import { localDb, syncTables, getDeviceId, nowIso } from './localDb.js';

const SYNC_BATCH_SIZE = 20;
const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

let syncing = false;
let lastError = '';
let waitingForWifi = false;
let syncProgress = { done: 0, total: 0, failed: 0 };
let autoSyncTimer = null;

function emitSyncStateChange() {
  window.dispatchEvent(new Event('sync-state-change'));
}

function flattenPendingChanges(changes) {
  return syncTables.flatMap((table) => (changes[table] || []).map((record) => ({ table, record })));
}

function buildBatchChanges(records) {
  const changes = Object.fromEntries(syncTables.map((table) => [table, []]));
  for (const entry of records) {
    changes[entry.table].push(entry.record);
  }
  return changes;
}

function connectionType() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    type: String(connection?.type || ''),
    effectiveType: String(connection?.effectiveType || '')
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
  return meta?.value || '';
}

function syncLabel({ session, pendingCount, conflictCount }) {
  if (!session) return '请先登录';
  if (!navigator.onLine) return '☁ 离线模式';
  if (waitingForWifi) return '☁ 等待 WiFi';
  if (syncing && syncProgress.total > 0) return `☁ 正在同步 ${syncProgress.done}/${syncProgress.total}`;
  if (syncing) return '☁ 正在同步...';
  if (lastError) return syncProgress.failed > 0 ? `☁ 同步失败 ${syncProgress.failed} 条` : '☁ 同步失败';
  if (conflictCount > 0) return `☁ 需要人工确认 ${conflictCount} 条`;
  if (pendingCount > 0) return `☁ 待同步 ${pendingCount}`;
  return '☁ 已同步';
}

export async function getSyncSnapshot() {
  const session = getAuthSession();
  const [pendingCount, conflictCount, pendingChanges, preferences, lastSync] = await Promise.all([
    localDb.getPendingCount(),
    localDb.getConflictCount(),
    localDb.getPendingChanges(),
    getSyncPreferences(),
    lastSyncAt()
  ]);
  return {
    online: navigator.onLine,
    authenticated: Boolean(session),
    pendingCount,
    conflictCount,
    pendingByTable: Object.fromEntries(Object.entries(pendingChanges).map(([table, records]) => [table, records.length])),
    syncing,
    lastError,
    waitingForWifi,
    syncProgress: { ...syncProgress },
    preferences,
    lastSyncAt: lastSync,
    connection: connectionType(),
    label: syncLabel({ session, pendingCount, conflictCount })
  };
}

function shouldSkipAutoSync({ force, reason, preferences, lastSync }) {
  if (force) return '';
  if (!preferences.autoSync) return '自动同步已关闭';
  if (preferences.wifiOnly && !preferences.allowCellular && looksCellularConnection()) return '等待 WiFi';
  const last = Date.parse(lastSync || '');
  if (['startup', 'online'].includes(reason)) {
    if (Number.isFinite(last) && Date.now() - last < 60 * 1000) return '刚刚同步过';
    return '';
  }
  if (Number.isFinite(last) && Date.now() - last < AUTO_SYNC_INTERVAL_MS) return '距离上次同步未超过 30 分钟';
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
  if (syncing) return getSyncSnapshot();
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

  const preferences = await getSyncPreferences();
  const lastSync = await lastSyncAt();
  const skipReason = shouldSkipAutoSync({ force, reason, preferences, lastSync });
  if (skipReason) {
    waitingForWifi = skipReason === '等待 WiFi';
    lastError = '';
    emitSyncStateChange();
    return getSyncSnapshot();
  }

  syncing = true;
  waitingForWifi = false;
  syncProgress = { done: 0, total: 0, failed: 0 };
  emitSyncStateChange();

  try {
    const deviceId = getDeviceId();
    const companyId = getCompanyId();
    if (!companyId) {
      lastError = '请先登录';
      return getSyncSnapshot();
    }

    const pending = await localDb.getPendingChanges();
    const pendingRecords = flattenPendingChanges(pending);
    console.log('[sync] start:', {
      companyId,
      reason,
      pendingCounts: Object.fromEntries(Object.entries(pending).map(([table, records]) => [table, records.length]))
    });

    if (pendingRecords.length) {
      syncProgress = { done: 0, total: pendingRecords.length, failed: 0 };
      emitSyncStateChange();

      for (let index = 0; index < pendingRecords.length; index += SYNC_BATCH_SIZE) {
        const batch = pendingRecords.slice(index, index + SYNC_BATCH_SIZE);
        try {
          const pushed = await api.syncPush({ deviceId, companyId, changes: buildBatchChanges(batch) });
          console.log('[sync] push batch completed:', {
            companyId,
            batchStart: index,
            batchSize: batch.length,
            resultCount: Array.isArray(pushed.results) ? pushed.results.length : 0,
            backend: pushed.backend || ''
          });
          for (const result of pushed.results || []) {
            await localDb.markSynced(result.table, result);
          }
        } catch (error) {
          syncProgress.failed += batch.length;
          lastError = error.message || '同步失败';
          console.error('[sync] push batch failed:', { batchStart: index, batchSize: batch.length, error });
        } finally {
          syncProgress.done += batch.length;
          emitSyncStateChange();
        }
      }
    }

    const metaKey = `lastPullAt:${companyId}`;
    const meta = await localDb.getMeta(metaKey);
    const stats = await localDb.getStats();
    const hasLocalData = Object.values(stats).some((count) => Number(count || 0) > 0);
    const pulled = await api.syncPull(hasLocalData ? (meta?.value || '') : '');
    console.log('[sync] pull completed:', {
      companyId,
      since: hasLocalData ? (meta?.value || '') : '',
      backend: pulled.backend || '',
      counts: Object.fromEntries(syncTables.map((table) => [table, (pulled.data?.[table] || []).length]))
    });
    for (const table of syncTables) {
      for (const record of pulled.data?.[table] || []) {
        await localDb.mergeRemote(table, record);
      }
    }
    await localDb.setMeta(metaKey, pulled.serverTime || nowIso());
    if (syncProgress.failed === 0) lastError = '';
  } catch (error) {
    lastError = error.message || '同步失败';
    console.error('[sync] failed:', error);
  } finally {
    syncing = false;
    scheduleNextAutoSync();
    emitSyncStateChange();
  }

  return getSyncSnapshot();
}

export async function pullFromCloud({ full = false } = {}) {
  if (!getAuthSession()) {
    lastError = '请先登录';
    return getSyncSnapshot();
  }
  if (!navigator.onLine) {
    lastError = '当前离线，无法从云端恢复';
    return getSyncSnapshot();
  }
  syncing = true;
  waitingForWifi = false;
  syncProgress = { done: 0, total: 0, failed: 0 };
  emitSyncStateChange();
  try {
    const companyId = getCompanyId();
    const metaKey = `lastPullAt:${companyId}`;
    const meta = full ? null : await localDb.getMeta(metaKey);
    const pulled = await api.syncPull(meta?.value || '');
    console.log('[sync] cloud pull completed:', {
      companyId,
      full,
      since: meta?.value || '',
      backend: pulled.backend || '',
      counts: Object.fromEntries(syncTables.map((table) => [table, (pulled.data?.[table] || []).length]))
    });
    for (const table of syncTables) {
      for (const record of pulled.data?.[table] || []) {
        await localDb.mergeRemote(table, record);
      }
    }
    await localDb.setMeta(metaKey, pulled.serverTime || nowIso());
    lastError = '';
  } catch (error) {
    lastError = error.message || '从云端恢复失败';
  } finally {
    syncing = false;
    emitSyncStateChange();
  }
  return getSyncSnapshot();
}

export async function resetLocalCacheAndPull() {
  if (!getAuthSession()) {
    lastError = '请先登录';
    return getSyncSnapshot();
  }
  if (!navigator.onLine) {
    lastError = '当前离线，无法重新拉取云端数据';
    return getSyncSnapshot();
  }
  syncing = true;
  waitingForWifi = false;
  syncProgress = { done: 0, total: 0, failed: 0 };
  emitSyncStateChange();
  try {
    await localDb.clearLocalCacheForCurrentCompany();
    lastError = '';
  } catch (error) {
    lastError = error.message || '清空本地缓存失败';
  } finally {
    syncing = false;
    emitSyncStateChange();
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
