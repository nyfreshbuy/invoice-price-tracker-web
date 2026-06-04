const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const AUTH_KEY = 'invoicePriceTrackerAuth';
export const AUTO_LOGIN = import.meta.env.VITE_AUTO_LOGIN === 'true';
export const DEMO_NO_AUTH = AUTO_LOGIN || import.meta.env.VITE_DEMO_NO_AUTH !== 'false';
export const DEMO_SESSION = {
  token: '',
  user: {
    id: 'demo-user',
    username: 'demo',
    email: 'demo@example.com',
    name: 'demo',
    companyId: 'demo-company'
  },
  company: {
    id: 'demo-company',
    name: '测试公司'
  },
  demo: true
};

export function getAuthSession() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null') || (DEMO_NO_AUTH ? DEMO_SESSION : null);
  } catch {
    return DEMO_NO_AUTH ? DEMO_SESSION : null;
  }
}

export function setAuthSession(session) {
  if (session?.token) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(AUTH_KEY);
  }
  window.dispatchEvent(new Event('auth-change'));
}

export function getAuthToken() {
  return getAuthSession()?.token || '';
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
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options
  });

  if (!response.ok) {
    let message = '请求失败';
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      message = response.statusText || message;
    }
    throw new Error(message);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response;
}

export const api = {
  login: (payload) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  register: (payload) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  me: () => request('/api/auth/me'),

  getInvoices: () => request('/api/invoices'),
  getInvoice: (id) => request(`/api/invoices/${id}`),
  createInvoice: (payload) => request('/api/invoices', { method: 'POST', body: JSON.stringify(payload) }),
  confirmAndLearnInvoice: (payload) => request('/api/learning/confirm-invoice', { method: 'POST', body: JSON.stringify(payload) }),
  deleteInvoice: (id) => request(`/api/invoices/${id}`, { method: 'DELETE' }),

  getSuppliers: () => request('/api/suppliers'),
  createSupplier: (payload) => request('/api/suppliers', { method: 'POST', body: JSON.stringify(payload) }),
  updateSupplier: (id, payload) => request(`/api/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteSupplier: (id) => request(`/api/suppliers/${id}`, { method: 'DELETE' }),
  getTemplate: (supplierId) => request(`/api/suppliers/${supplierId}/template`),
  saveTemplate: (supplierId, payload) => request(`/api/suppliers/${supplierId}/template`, { method: 'PUT', body: JSON.stringify(payload) }),
  getSupplierInvoices: (supplierId, params = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value !== false && value !== null && value !== undefined)).toString();
    return request(`/api/suppliers/${supplierId}/invoices${query ? `?${query}` : ''}`);
  },
  supplierInvoicesExportUrl: (supplierId, params = {}) => {
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== false && value !== null && value !== undefined)), token: getAuthToken() }).toString();
    return `${API_BASE}/api/suppliers/${supplierId}/invoices.csv?${query}`;
  },

  searchProducts: (q) => request(`/api/products/search?q=${encodeURIComponent(q)}`),
  getProduct: (name) => request(`/api/products/${encodeURIComponent(name)}`),

  getStats: () => request('/api/stats'),
  clearData: () => request('/api/dev/clear', { method: 'DELETE' }),
  exportUrl: () => `${API_BASE}/api/export.csv?token=${encodeURIComponent(getAuthToken())}`,
  ocrUpload: (formData) => {
    console.log('OCR upload URL:', `${API_BASE}/api/ocr`);
    return request('/api/ocr', { method: 'POST', body: formData });
  },
  createRecognitionTask: (formData) => request('/api/invoice-recognition/tasks', { method: 'POST', body: formData }),
  getRecognitionTasks: () => request('/api/invoice-recognition/tasks'),
  getRecognitionTask: (id) => request(`/api/invoice-recognition/tasks/${id}`),
  retryRecognitionTask: (id) => request(`/api/invoice-recognition/tasks/${id}/retry`, { method: 'POST' }),
  forceSaveRecognitionTask: (id) => request(`/api/invoice-recognition/tasks/${id}/force-save`, { method: 'POST' }),
  decideRecognitionTask: (id, action) => request(`/api/invoice-recognition/tasks/${id}/decision`, { method: 'POST', body: JSON.stringify({ action }) }),
  pauseRecognitionBatch: (batchId) => request(`/api/invoice-recognition/batches/${encodeURIComponent(batchId)}/pause`, { method: 'POST' }),
  resumeRecognitionBatch: (batchId) => request(`/api/invoice-recognition/batches/${encodeURIComponent(batchId)}/resume`, { method: 'POST' }),
  cancelRecognitionBatch: (batchId) => request(`/api/invoice-recognition/batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' }),
  fileUrl,
  syncPush: (payload) => request('/api/sync/push', { method: 'POST', body: JSON.stringify(payload) }),
  syncPull: (since) => request(`/api/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ''}`)
};
