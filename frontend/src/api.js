import { repairRecordEncoding } from './encoding.js';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const AUTH_KEY = 'invoicePriceTrackerAuth';
const AUTH_TOKEN_KEY = 'authToken';
const LEGACY_AUTH_KEYS = ['token', 'user', 'company', 'companyId', 'invoicePriceTrackerLoggedOut'];
const DEFAULT_TIMEOUT_MS = 20000;
const API_DEBUG_KEY = 'invoice_last_api_debug';

function makeApiError(message, extras = {}) {
  const error = new Error(message);
  Object.assign(error, extras);
  return error;
}

function rememberApiDebug(entry) {
  try {
    localStorage.setItem(API_DEBUG_KEY, JSON.stringify({
      ...entry,
      createdAt: new Date().toISOString()
    }));
  } catch {
    // Diagnostic only.
  }
}

export function getLastApiDebug() {
  try {
    return JSON.parse(localStorage.getItem(API_DEBUG_KEY) || 'null');
  } catch {
    return null;
  }
}

function summarizeApiPayload(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (!value || typeof value !== 'object') return value;
  const summary = {};
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) summary[key] = { type: 'array', length: item.length };
    else if (item && typeof item === 'object') summary[key] = { type: 'object', keys: Object.keys(item).slice(0, 20) };
    else summary[key] = item;
  }
  return summary;
}

function parseStoredSession() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
  } catch {
    return null;
  }
}

function isLegacyDemoSession(session) {
  const company = session?.company || {};
  const user = session?.user || {};
  const legacyCompanyId = ['demo', 'company'].join('-');
  const legacyUserId = ['demo', 'user'].join('-');
  const legacyUsername = ['de', 'mo'].join('');
  const legacyCompanyName = '\u6d4b\u8bd5\u516c\u53f8';
  const legacyMojibakeCompanyName = '\u5a34\u5b2d\u762f\u934f\ue100\u5f83';
  return !session?.token
    || company.id === legacyCompanyId
    || user.companyId === legacyCompanyId
    || user.id === legacyUserId
    || company.name === legacyCompanyName
    || company.name === legacyMojibakeCompanyName
    || user.username === legacyUsername;
}

export function clearAuthStorage() {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  for (const key of LEGACY_AUTH_KEYS) localStorage.removeItem(key);
}

export function sanitizeAuthStorage() {
  const authToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  const session = repairRecordEncoding(parseStoredSession());
  if (!session) {
    clearAuthStorage();
    return null;
  }
  if (!authToken || session.token !== authToken || isLegacyDemoSession(session)) {
    clearAuthStorage();
    return null;
  }
  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  return session;
}

sanitizeAuthStorage();

export function getAuthSession() {
  return sanitizeAuthStorage();
}

export function setAuthSession(session) {
  if (session?.token) {
    const safeSession = repairRecordEncoding(session);
    if (isLegacyDemoSession(safeSession)) {
      clearAuthStorage();
      window.dispatchEvent(new Event('auth-change'));
      return;
    }
    localStorage.setItem(AUTH_TOKEN_KEY, safeSession.token);
    localStorage.setItem(AUTH_KEY, JSON.stringify(safeSession));
  } else {
    clearAuthStorage();
  }
  window.dispatchEvent(new Event('auth-change'));
}

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

export function getCompanyId() {
  return getAuthSession()?.company?.id || getAuthSession()?.user?.companyId || '';
}

export function fileUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

async function request(path, options = {}) {
  const token = getAuthToken();
  const pathname = path.split('?')[0];
  const publicPaths = ['/api/auth/login', '/api/auth/register'];
  const isPublicInvitationRead = options.method !== 'POST' && pathname.startsWith('/api/invitations/');
  const isPublicInvitationAccept = pathname === '/api/invitations/accept';
  if (!token && !publicPaths.includes(pathname) && !isPublicInvitationRead && !isPublicInvitationAccept) {
    throw makeApiError('请先登录', { status: 401 });
  }
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let response;
  try {
    const { timeoutMs: _timeoutMs, signal: _signal, ...fetchOptions } = options;
    response = await fetch(`${API_BASE}${path}`, {
      headers,
      ...fetchOptions,
      signal: controller.signal
    });
  } catch (error) {
    rememberApiDebug({ path, method: options.method || 'GET', status: 0, error: error?.message || 'network error' });
    if (error?.name === 'AbortError') {
      throw makeApiError('请求超时，请稍后重试', { isTimeout: true, status: 0 });
    }
    throw makeApiError(error.message || '网络请求失败', { isNetworkError: true, status: 0, cause: error });
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let message = '请求失败';
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      message = response.statusText || message;
    }
    rememberApiDebug({ path, method: options.method || 'GET', status: response.status, error: message });
    throw makeApiError(message, { status: response.status });
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    rememberApiDebug({ path, method: options.method || 'GET', status: response.status, response: summarizeApiPayload(data) });
    return data;
  }
  rememberApiDebug({ path, method: options.method || 'GET', status: response.status, responseType: contentType || 'unknown' });
  return response;
}

async function download(path, filename) {
  const response = await request(path);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  login: (payload) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  register: (payload) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 15000 }),
  me: (options = {}) => request('/api/auth/me', { timeoutMs: 5000, ...options }),
  searchUsers: (keyword) => request(`/api/users/search?keyword=${encodeURIComponent(keyword)}`),
  requestAccountConnection: (payload) => request('/api/account-connections/request', { method: 'POST', body: JSON.stringify(payload) }),
  getSentConnections: () => request('/api/account-connections/sent'),
  getReceivedConnections: () => request('/api/account-connections/received'),
  approveConnection: (id) => request(`/api/account-connections/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  rejectConnection: (id) => request(`/api/account-connections/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  getMembers: () => request('/api/admin/members'),
  createMember: (payload) => request('/api/admin/members', { method: 'POST', body: JSON.stringify(payload) }),
  updateMember: (id, payload) => request(`/api/admin/members/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  resetMemberPassword: (id, password) => request(`/api/admin/members/${encodeURIComponent(id)}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }),
  enableMember: (id) => request(`/api/admin/members/${encodeURIComponent(id)}/enable`, { method: 'POST' }),
  disableMember: (id) => request(`/api/admin/members/${encodeURIComponent(id)}/disable`, { method: 'POST' }),
  deleteMember: (id) => request(`/api/admin/members/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createInvitation: (payload) => request('/api/invitations', { method: 'POST', body: JSON.stringify(payload) }),
  getInvitations: () => request('/api/invitations'),
  getInvitation: (token) => request(`/api/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (payload) => request('/api/invitations/accept', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 15000 }),

  getInvoices: () => request('/api/invoices'),
  getInvoice: (id) => request(`/api/invoices/${id}`),
  createInvoice: (payload) => request('/api/invoices', { method: 'POST', body: JSON.stringify(payload) }),
  confirmAndLearnInvoice: (payload) => request('/api/learning/confirm-invoice', { method: 'POST', body: JSON.stringify(payload) }),
  uploadInvoiceImage: (id, formData) => request(`/api/invoices/${encodeURIComponent(id)}/image`, { method: 'POST', body: formData, timeoutMs: 60000 }),
  reprocessInvoiceWithAI: (id) => request(`/api/invoices/${encodeURIComponent(id)}/reprocess-ai`, { method: 'POST', timeoutMs: 120000 }),
  mergeInvoice: (id, mergeIds) => request(`/api/invoices/${encodeURIComponent(id)}/merge`, { method: 'POST', body: JSON.stringify({ mergeIds }) }),
  deleteInvoice: (id) => request(`/api/invoices/${id}`, { method: 'DELETE' }),

  getSuppliers: () => request('/api/suppliers'),
  createSupplier: (payload) => request('/api/suppliers', { method: 'POST', body: JSON.stringify(payload) }),
  updateSupplier: (id, payload) => request(`/api/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  mergeSupplier: (id, targetSupplierId) => request(`/api/suppliers/${id}/merge`, { method: 'POST', body: JSON.stringify({ targetSupplierId }) }),
  deleteSupplier: (id) => request(`/api/suppliers/${id}`, { method: 'DELETE' }),
  getTemplate: (supplierId) => request(`/api/suppliers/${supplierId}/template`),
  saveTemplate: (supplierId, payload) => request(`/api/suppliers/${supplierId}/template`, { method: 'PUT', body: JSON.stringify(payload) }),
  getSupplierInvoices: (supplierId, params = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value !== false && value !== null && value !== undefined)).toString();
    return request(`/api/suppliers/${supplierId}/invoices${query ? `?${query}` : ''}`);
  },
  downloadSupplierInvoicesCsv: (supplierId, params = {}) => {
    const query = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== false && value !== null && value !== undefined))).toString();
    return download(`/api/suppliers/${supplierId}/invoices.csv${query ? `?${query}` : ''}`, `supplier-${supplierId}-invoices.csv`);
  },
  downloadSupplierInvoicesExcel: (supplierId, params = {}) => {
    const query = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== false && value !== null && value !== undefined))).toString();
    return download(`/api/suppliers/${supplierId}/invoices.xls${query ? `?${query}` : ''}`, `supplier-${supplierId}-invoices.xls`);
  },

  searchProducts: (q) => request(`/api/products/search?q=${encodeURIComponent(q)}`),
  getProduct: (name) => request(`/api/products/${encodeURIComponent(name)}`),

  getStats: () => request('/api/stats'),
  clearData: () => request('/api/dev/clear', { method: 'DELETE' }),
  downloadExportCsv: () => download('/api/export.csv', 'invoice-export.csv'),
  downloadExportExcel: () => download('/api/export.xls', 'invoice-export.xls'),
  ocrUpload: (formData) => {
    console.log('OCR upload URL:', `${API_BASE}/api/ocr`);
    return request('/api/ocr', { method: 'POST', body: formData, timeoutMs: 60000 });
  },
  createRecognitionTask: (formData) => request('/api/invoice-recognition/tasks', { method: 'POST', body: formData, timeoutMs: 60000 }),
  getRecognitionTasks: () => request('/api/invoice-recognition/tasks'),
  getRecognitionStats: (limit = 100) => request(`/api/invoice-recognition/stats?limit=${encodeURIComponent(limit)}`),
  getRecognitionTask: (id) => request(`/api/invoice-recognition/tasks/${id}`),
  retryRecognitionTask: (id) => request(`/api/invoice-recognition/tasks/${id}/retry`, { method: 'POST' }),
  forceSaveRecognitionTask: (id) => request(`/api/invoice-recognition/tasks/${id}/force-save`, { method: 'POST' }),
  decideRecognitionTask: (id, action) => request(`/api/invoice-recognition/tasks/${id}/decision`, { method: 'POST', body: JSON.stringify({ action }) }),
  pauseRecognitionBatch: (batchId) => request(`/api/invoice-recognition/batches/${encodeURIComponent(batchId)}/pause`, { method: 'POST' }),
  resumeRecognitionBatch: (batchId) => request(`/api/invoice-recognition/batches/${encodeURIComponent(batchId)}/resume`, { method: 'POST' }),
  cancelRecognitionBatch: (batchId) => request(`/api/invoice-recognition/batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' }),
  fileUrl,
  syncPush: (payload) => request('/api/sync/push', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 30000 }),
  syncPull: (since) => request(`/api/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ''}`, { timeoutMs: 30000 }),
  syncStatus: () => request('/api/sync/status')
};
