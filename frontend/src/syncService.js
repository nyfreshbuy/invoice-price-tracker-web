import { api, getAuthSession, getCompanyId } from './api.js';
import { localDb, syncTables, getDeviceId, nowIso } from './localDb.js';

const SYNC_BATCH_SIZE = 20;

let syncing = false;
let lastError = '';
let syncProgress = { done: 0, total: 0, failed: 0 };

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

function syncLabel({ session, pendingCount, conflictCount }) {
  if (!session) return '请先登录';
  if (!navigator.onLine) return '离线模式';
  if (syncing && syncProgress.total > 0) return `同步中 ${syncProgress.done}/${syncProgress.total}`;
  if (syncing) return '同步中';
  if (lastError) return syncProgress.failed > 0 ? `同步失败 ${syncProgress.failed} 条` : '同步失败';
  if (conflictCount > 0) return `需要人工确认 ${conflictCount} 条`;
  if (pendingCount > 0) return `待同步 ${pendingCount} 条`;
  return '已同步';
}

export async function getSyncSnapshot() {
  const session = getAuthSession();
  const pendingCount = await localDb.getPendingCount();
  const conflictCount = await localDb.getConflictCount();
  return {
    online: navigator.onLine,
    authenticated: Boolean(session),
    pendingCount,
    conflictCount,
    syncing,
    lastError,
    syncProgress: { ...syncProgress },
    label: syncLabel({ session, pendingCount, conflictCount })
  };
}

export async function syncNow() {
  if (syncing) return getSyncSnapshot();
  if (!getAuthSession()) {
    lastError = '';
    return getSyncSnapshot();
  }
  if (!navigator.onLine) {
    lastError = '';
    return getSyncSnapshot();
  }

  syncing = true;
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
  const run = () => syncNow();
  window.addEventListener('online', run);
  window.addEventListener('local-db-change', run);
  window.addEventListener('auth-change', run);
  setTimeout(run, 300);
  const timer = window.setInterval(run, 30000);
  return () => {
    window.removeEventListener('online', run);
    window.removeEventListener('local-db-change', run);
    window.removeEventListener('auth-change', run);
    window.clearInterval(timer);
  };
}
