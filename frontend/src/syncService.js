import { api, getAuthSession, getCompanyId } from './api.js';
import { localDb, syncTables, getDeviceId, nowIso } from './localDb.js';

let syncing = false;
let lastError = '';

export async function getSyncSnapshot() {
  const session = getAuthSession();
  const pendingCount = await localDb.getPendingCount();
  return {
    online: navigator.onLine,
    authenticated: Boolean(session),
    pendingCount,
    syncing,
    lastError,
    label: !session
      ? '请先登录'
      : !navigator.onLine
        ? '离线模式'
        : lastError
          ? '同步失败'
          : pendingCount > 0
            ? `待同步 ${pendingCount} 条`
            : '已同步'
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
  window.dispatchEvent(new Event('sync-state-change'));

  try {
    const deviceId = getDeviceId();
    const companyId = getCompanyId();
    if (!companyId) {
      lastError = '请先登录';
      return getSyncSnapshot();
    }
    const pending = await localDb.getPendingChanges();
    const hasPending = Object.values(pending).some((records) => records.length > 0);
    if (hasPending) {
      const pushed = await api.syncPush({ deviceId, companyId, changes: pending });
      for (const result of pushed.results || []) {
        await localDb.markSynced(result.table, result);
      }
    }

    const metaKey = `lastPullAt:${companyId}`;
    const meta = await localDb.getMeta(metaKey);
    const pulled = await api.syncPull(meta?.value || '');
    for (const table of syncTables) {
      for (const record of pulled.data?.[table] || []) {
        await localDb.mergeRemote(table, record);
      }
    }
    await localDb.setMeta(metaKey, pulled.serverTime || nowIso());
    lastError = '';
  } catch (error) {
    lastError = error.message || '同步失败';
  } finally {
    syncing = false;
    window.dispatchEvent(new Event('sync-state-change'));
  }

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
