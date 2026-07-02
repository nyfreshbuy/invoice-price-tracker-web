import { Component, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  BarChart3,
  Camera,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  Home,
  Image as ImageIcon,
  MoreVertical,
  PackageSearch,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Share2,
  ShoppingCart,
  Trash2,
  Upload,
  UserPlus,
  Wand2
} from 'lucide-react';
import { api, getAuthSession, getLastApiDebug, setAuthSession } from './api.js';
import { generateId, localDb, today } from './localDb.js';
import { repairTextEncoding } from './encoding.js';
import {
  clearLastSyncedPendingRecords,
  getSyncPreferences,
  getSyncSnapshot,
  markSyncPending,
  pullFromCloud,
  resetLocalCacheAndPull,
  setSyncPreferences,
  startAutoSync,
  syncNow
} from './syncService.js';

const emptyItem = () => ({
  rawName: '',
  nameCn: '',
  nameEn: '',
  spec: '',
  productNameOriginal: '',
  productNameNormalized: '',
  normalizedName: '',
  category: '',
  quantity: 0,
  unit: '',
  unitPrice: 0,
  totalPrice: 0,
  chargedQty: 0,
  freeQty: 0,
  totalQty: 0,
  actualQty: 0,
  originalUnitCost: 0,
  effectiveUnitCost: 0,
  discountedEffectiveUnitCost: 0,
  discountAmount: 0,
  promoGroupId: '',
  promoGroupName: '',
  promoGroupRule: '',
  participatesInGiftAllocation: false,
  isFreeItem: false,
  isDiscountLine: false,
  candidateOnly: false,
  correctedByUser: false,
  isHandwrittenQuantity: false,
  isHandwrittenPrice: false,
  isHandwrittenAmount: false,
  isCircled: false,
  isChecked: false,
  freeReason: '',
  notes: ''
});

const emptySupplier = {
  name: '',
  displayName: '',
  supplierNameChinese: '',
  supplierNameEnglish: '',
  supplierDisplayName: '',
  normalizedName: '',
  aliases: '[]',
  contactName: '',
  phone: '',
  email: '',
  address: '',
  notes: ''
};

function uiText(value) {
  return typeof value === 'string' ? repairTextEncoding(value) : value;
}

const emptyTemplate = (supplierName = '') => ({
  supplierNameKeywords: supplierName,
  invoiceNoKeywords: '发票号,单号,票号,invoice no,invoice #',
  dateKeywords: '日期,开票日期,invoice date,date',
  itemTableStartKeywords: '品名,商品,名称,description,item',
  itemTableEndKeywords: '合计,总计,total',
  itemNameColumnIndex: 0,
  quantityColumnIndex: 1,
  unitColumnIndex: 2,
  unitPriceColumnIndex: 3,
  totalPriceColumnIndex: 4,
  notes: ''
});

const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'web-pwa';
const ERROR_UI_TEXT = {
  title: '\u9875\u9762\u52a0\u8f7d\u5931\u8d25',
  body: '\u9875\u9762\u7ec4\u4ef6\u6e32\u67d3\u65f6\u53d1\u751f\u9519\u8bef\uff0c\u9519\u8bef\u65e5\u5fd7\u5df2\u4fdd\u5b58\u5728\u672c\u673a\u3002',
  reload: '\u91cd\u65b0\u52a0\u8f7d',
  home: '\u8fd4\u56de\u9996\u9875',
  log: '\u67e5\u770b\u9519\u8bef\u65e5\u5fd7'
};

function recordPageError(error, info = {}, pageName = 'unknown') {
  const session = getAuthSession?.() || {};
  const locationInfo = extractErrorLocation(error);
  const entry = {
    pageName,
    route: typeof window !== 'undefined' ? window.location.pathname : '',
    url: typeof window !== 'undefined' ? window.location.href : '',
    message: error?.message || String(error || 'Unknown error'),
    stack: error?.stack || '',
    componentStack: info?.componentStack || '',
    fileName: locationInfo.fileName,
    lineNumber: locationInfo.lineNumber,
    columnNumber: locationInfo.columnNumber,
    functionName: locationInfo.functionName,
    lastApi: getLastApiDebug?.() || null,
    user: session?.user?.email || session?.user?.username || '',
    companyId: session?.company?.id || session?.user?.companyId || '',
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString()
  };
  console.error('[PAGE_RUNTIME_ERROR]', entry);
  try {
    const key = 'invoice_runtime_error_logs';
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    localStorage.setItem(key, JSON.stringify([entry, ...existing].slice(0, 30)));
  } catch (storageError) {
    console.warn('[PAGE_RUNTIME_ERROR_LOG_FAILED]', storageError);
  }
}

function extractErrorLocation(error) {
  const stack = String(error?.stack || '');
  const lines = stack.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/) || line.match(/^at\s+(.*?):(\d+):(\d+)$/);
    if (!match) continue;
    if (match.length === 5) {
      return {
        functionName: match[1],
        fileName: match[2],
        lineNumber: Number(match[3]),
        columnNumber: Number(match[4])
      };
    }
    return {
      functionName: '',
      fileName: match[1],
      lineNumber: Number(match[2]),
      columnNumber: Number(match[3])
    };
  }
  return { functionName: '', fileName: '', lineNumber: null, columnNumber: null };
}

class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    recordPageError(error, info, this.props.pageName);
  }

  componentDidUpdate(previousProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <PageErrorFallback error={this.state.error} info={this.state.info} pageName={this.props.pageName} />;
  }
}

function PageErrorFallback({ error, info, pageName }) {
  const locationInfo = extractErrorLocation(error);
  const log = {
    pageName,
    route: typeof window !== 'undefined' ? window.location.pathname : '',
    url: typeof window !== 'undefined' ? window.location.href : '',
    message: error?.message || String(error || ''),
    stack: error?.stack || '',
    componentStack: info?.componentStack || '',
    fileName: locationInfo.fileName,
    lineNumber: locationInfo.lineNumber,
    columnNumber: locationInfo.columnNumber,
    functionName: locationInfo.functionName,
    lastApi: getLastApiDebug?.() || null,
    appVersion: APP_VERSION
  };
  return (
    <div className="page-error">
      <h1>{ERROR_UI_TEXT.title}</h1>
      <p>{ERROR_UI_TEXT.body}</p>
      <div className="error-summary">
        <strong>{log.message || 'Unknown runtime error'}</strong>
        <span>Route: {log.route || '-'}</span>
        <span>Component: {pageName || '-'}</span>
        <span>File: {log.fileName || '-'}{log.lineNumber ? `:${log.lineNumber}` : ''}</span>
        <span>Function: {log.functionName || '-'}</span>
      </div>
      <div className="row-actions">
        <button type="button" onClick={() => window.location.reload()}>{ERROR_UI_TEXT.reload}</button>
        <a className="icon-button" href="/">{ERROR_UI_TEXT.home}</a>
      </div>
      <details open>
        <summary>{ERROR_UI_TEXT.log}</summary>
        <pre className="ocr-text">{JSON.stringify(log, null, 2)}</pre>
      </details>
    </div>
  );
}

function PageBoundary({ pageName, children }) {
  const location = useLocation();
  return (
    <PageErrorBoundary pageName={pageName} resetKey={`${location.pathname}${location.search}`}>
      {children}
    </PageErrorBoundary>
  );
}

function ProtectedPage({ pageName, session, children }) {
  return (
    <PageBoundary pageName={pageName}>
      <RequireAuth session={session}>{children}</RequireAuth>
    </PageBoundary>
  );
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function apiItems(value) {
  if (Array.isArray(value)) return value;
  return safeArray(value?.items || value?.results || value?.data);
}

function errorMessage(error) {
  return error?.message || String(error || '');
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanDisplayText(value = '', fallback = '') {
  const repaired = repairTextEncoding(String(value || '').trim());
  if (!repaired || /^\?+$/.test(repaired)) return fallback;
  return repaired;
}

function displayCompanyName(session = {}) {
  return cleanDisplayText(
    session?.company?.name || session?.user?.companyName || '',
    '\u672a\u547d\u540d\u516c\u53f8'
  );
}

export default function App() {
  const [authSession, setAuthState] = useState(() => getAuthSession());
  const [authStatus, setAuthStatus] = useState(() => {
    const session = getAuthSession();
    if (!session?.token) return 'unauthenticated';
    return navigator.onLine ? 'checkingAuth' : 'offlineMode';
  });
  const [authNotice, setAuthNotice] = useState('');
  const [syncState, setSyncState] = useState({ label: '\u2601 \u5df2\u540c\u6b65', pendingCount: 0, online: navigator.onLine, syncing: false });
  const [syncingNow, setSyncingNow] = useState(false);

  useEffect(() => {
    const handleWindowError = (event) => {
      recordPageError(event.error || event.message, { componentStack: 'window.error' }, 'global');
    };
    const handleUnhandledRejection = (event) => {
      recordPageError(event.reason || 'Unhandled promise rejection', { componentStack: 'unhandledrejection' }, 'global');
    };
    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = () => getSyncSnapshot().then((snapshot) => mounted && setSyncState(snapshot));
    const stop = startAutoSync();
    refresh();
    window.addEventListener('sync-state-change', refresh);
    window.addEventListener('local-db-change', refresh);
    window.addEventListener('auth-change', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      mounted = false;
      stop();
      window.removeEventListener('sync-state-change', refresh);
      window.removeEventListener('local-db-change', refresh);
      window.removeEventListener('auth-change', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  useEffect(() => {
    const refreshAuth = () => {
      const session = getAuthSession();
      setAuthState(session);
      if (!session?.token) {
        setAuthStatus('unauthenticated');
        setAuthNotice('');
      }
    };
    window.addEventListener('auth-change', refreshAuth);
    return () => window.removeEventListener('auth-change', refreshAuth);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function verifyCurrentToken() {
      if (!authSession?.token) {
        setAuthStatus('unauthenticated');
        setAuthNotice('');
        return;
      }
      if (!navigator.onLine) {
        setAuthStatus('offlineMode');
        setAuthNotice('当前离线，已进入离线模式，可先查看本地缓存数据。');
        return;
      }
      setAuthStatus('checkingAuth');
      setAuthNotice('');
      try {
        const data = await api.me();
        if (cancelled) return;
        const verifiedSession = { token: authSession.token, user: data.user, company: data.company };
        setAuthSession(verifiedSession);
        setAuthState(getAuthSession());
        setAuthStatus('authenticated');
        setAuthNotice('');
        markSyncPending();
      } catch (error) {
        if (cancelled) return;
        if (error?.status === 401 || error?.status === 403) {
          setAuthSession(null);
          setAuthState(null);
          setAuthStatus('unauthenticated');
          setAuthNotice('登录已失效，请重新登录。');
          return;
        }
        if (error?.isTimeout || error?.isNetworkError || error?.status === 0) {
          setAuthStatus('serverStarting');
          setAuthNotice('服务器启动中，请稍后重试。已保留本地离线模式，可先查看本地缓存数据。');
          return;
        }
        setAuthStatus('serverStarting');
        setAuthNotice(error.message || '服务器暂时不可用，请稍后重试。');
      }
    }
    verifyCurrentToken();
    return () => {
      cancelled = true;
    };
  }, [authSession?.token]);

  useEffect(() => {
    const markOffline = () => {
      if (getAuthSession()?.token) {
        setAuthStatus('offlineMode');
        setAuthNotice('当前离线，已进入离线模式，可先查看本地缓存数据。');
      }
    };
    const markOnline = () => {
      if (getAuthSession()?.token) handleRetryAuth();
    };
    window.addEventListener('offline', markOffline);
    window.addEventListener('online', markOnline);
    return () => {
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('online', markOnline);
    };
  }, []);

  async function handleSyncNow() {
    setSyncingNow(true);
    try {
      setSyncState(await syncNow({ force: true, reason: 'manual' }));
    } finally {
      setSyncingNow(false);
    }
  }

  async function handleRetryAuth() {
    const session = getAuthSession();
    if (!session?.token) {
      setAuthStatus('unauthenticated');
      setAuthNotice('');
      return;
    }
    setAuthState(session);
    setAuthStatus('checkingAuth');
    setAuthNotice('');
    try {
      const data = await api.me();
      const verifiedSession = { token: session.token, user: data.user, company: data.company };
      setAuthSession(verifiedSession);
      setAuthState(getAuthSession());
      setAuthStatus('authenticated');
      setAuthNotice('');
      const repairedEncoding = await localDb.repairEncodingForCurrentCompany().catch((repairError) => {
        console.warn('[encoding] local repair failed', repairError);
        return {};
      });
      if (Object.keys(repairedEncoding || {}).length) {
        console.info('[encoding] repaired local records', repairedEncoding);
        markSyncPending();
      }
      await syncNow({ reason: 'startup' });
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        setAuthSession(null);
        setAuthState(null);
        setAuthStatus('unauthenticated');
        setAuthNotice('登录已失效，请重新登录。');
        return;
      }
      setAuthStatus('serverStarting');
      setAuthNotice('服务器启动中，请稍后重试。已保留本地离线模式，可先查看本地缓存数据。');
    }
  }

  function handleLogout() {
    setAuthSession(null);
  }

  if (window.location.pathname.startsWith('/invite/')) {
    return (
      <Routes>
        <Route path="/invite/:token" element={<PageBoundary pageName="InvitationAccept"><InvitationAcceptPage onAuthenticated={setAuthState} /></PageBoundary>} />
      </Routes>
    );
  }

  if (window.location.hostname.includes('invoice-frontend-ufq4.onrender.com') && !localStorage.getItem('authToken')) {
    return <AuthPageFixed onAuthenticated={setAuthState} />;
  }

  if (!authSession?.token) {
    return <AuthPageFixed onAuthenticated={setAuthState} />;
  }

  return (
    <div className="app-shell">
      <SyncBar state={syncState} session={authSession} syncingNow={syncingNow} onSyncNow={handleSyncNow} onLogout={handleLogout} />
      <AuthStatusBanner status={authStatus} message={authNotice} onRetry={handleRetryAuth} />
      <main className="main">
        <Routes>
          <Route path="/" element={<ProtectedPage pageName="HomeDashboard" session={authSession}><HomeDashboardPage /></ProtectedPage>} />
          <Route path="/invoices" element={<ProtectedPage pageName="InvoiceList" session={authSession}><InvoiceListPage /></ProtectedPage>} />
          <Route path="/invoices/new" element={<ProtectedPage pageName="InvoiceForm" session={authSession}><InvoiceFormPage /></ProtectedPage>} />
          <Route path="/invoices/batch" element={<ProtectedPage pageName="BatchImport" session={authSession}><BatchImportPage /></ProtectedPage>} />
          <Route path="/recognition-tasks" element={<ProtectedPage pageName="RecognitionTaskList" session={authSession}><RecognitionTaskListPage /></ProtectedPage>} />
          <Route path="/archive" element={<Navigate to="/" replace />} />
          <Route path="/invoices/:id" element={<ProtectedPage pageName="InvoiceDetail" session={authSession}><InvoiceDetailPageWithGifts /></ProtectedPage>} />
          <Route path="/products" element={<ProtectedPage pageName="ProductSearch" session={authSession}><ProductSearchPage /></ProtectedPage>} />
          <Route path="/products/:name" element={<ProtectedPage pageName="ProductDetail" session={authSession}><ProductDetailPage /></ProtectedPage>} />
          <Route path="/supplier-center" element={<ProtectedPage pageName="SupplierCenter" session={authSession}><SupplierCenterPage /></ProtectedPage>} />
          <Route path="/suppliers/:id" element={<ProtectedPage pageName="SupplierDetail" session={authSession}><SupplierDetailPage /></ProtectedPage>} />
          <Route path="/suppliers/:id/products" element={<ProtectedPage pageName="SupplierProducts" session={authSession}><SupplierProductsPage /></ProtectedPage>} />
          <Route path="/suppliers" element={<ProtectedPage pageName="SupplierList" session={authSession}><SupplierPage /></ProtectedPage>} />
          <Route path="/suppliers/:id/invoices" element={<ProtectedPage pageName="SupplierInvoiceHistory" session={authSession}><SupplierInvoiceHistoryPage /></ProtectedPage>} />
          <Route path="/account-connections" element={<ProtectedPage pageName="AccountConnection" session={authSession}><AccountConnectionPage /></ProtectedPage>} />
          <Route path="/invite/:token" element={<PageBoundary pageName="InvitationAccept"><InvitationAcceptPage onAuthenticated={setAuthState} /></PageBoundary>} />
          <Route path="/analytics" element={<ProtectedPage pageName="PurchaseAnalysis" session={authSession}><PurchaseAnalysisPage /></ProtectedPage>} />
          <Route path="/settings" element={<ProtectedPage pageName="Settings" session={authSession}><SettingsPage /></ProtectedPage>} />
        </Routes>
      </main>
      <BottomNav />
    </div>
  );
}

function AuthStatusBanner({ status, message, onRetry }) {
  if (!['checkingAuth', 'serverStarting', 'offlineMode'].includes(status)) return null;
  const text = status === 'checkingAuth'
    ? '正在后台验证登录状态，不影响本地数据查看。'
    : message || (status === 'offlineMode' ? '当前离线，已进入离线模式。' : '服务器启动中，请稍后重试。');
  return (
    <div className={`auth-status-banner ${status}`}>
      <span>{text}</span>
      {status !== 'checkingAuth' && <button type="button" onClick={onRetry}>重试登录验证</button>}
    </div>
  );
}
function AuthPageFixed({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ companyName: '', username: '', email: '', password: '', confirmPassword: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (mode === 'register') {
        console.info('[auth:register] submit clicked', {
          email: form.email,
          username: form.username,
          companyName: form.companyName
        });
        if (form.password !== form.confirmPassword) {
          console.warn('[auth:register] password confirmation mismatch');
          setMessage('两次输入的密码不一致');
          return;
        }
        console.info('[auth:register] POST /api/auth/register start');
        const result = await api.register(form);
        console.info('[auth:register] POST /api/auth/register success', result);
        setMode('login');
        setMessage('注册成功，请登录');
        return;
      }
      console.info('[auth:login] POST /api/auth/login start', { login: form.email });
      const session = await api.login({ login: form.email, password: form.password });
      console.info('[auth:login] POST /api/auth/login success', { userId: session.user?.id, companyId: session.company?.id });
      setAuthSession(session);
      onAuthenticated(getAuthSession());
      window.dispatchEvent(new Event('auth-change'));
      markSyncPending();
    } catch (error) {
      console.error(`[auth:${mode}] failed`, error);
      setMessage(error.message || (mode === 'register' ? '注册失败' : '登录失败'));
    } finally {
      console.info(`[auth:${mode}] loading=false`);
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1>InvoicePriceTracker</h1>
        <p>使用邮箱 + 密码登录，云端储存、离线可用、自动同步。</p>
        <div className="segmented">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册账号</button>
        </div>
        {mode === 'register' && (
          <>
            <label className="field"><span>公司/门店名称</span><input value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} /></label>
            <label className="field"><span>用户名</span><input autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
          </>
        )}
        <label className="field"><span>邮箱</span><input type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="field"><span>密码</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        {mode === 'register' && <label className="field"><span>确认密码</span><input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} /></label>}
        {message && <p className="error">{message}</p>}
        <button className="primary-button" disabled={loading}>{loading ? '处理中...' : mode === 'login' ? '登录' : '注册'}</button>
      </form>
    </div>
  );
}
function InvitationAcceptPage({ onAuthenticated }) {
  const { token } = useParams();
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState(null);
  const [form, setForm] = useState({ username: '', password: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getInvitation(token)
      .then((data) => setInvitation(data.invitation))
      .catch((error) => setMessage(error.message || '邀请链接无效'));
  }, [token]);

  async function accept(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const session = await api.acceptInvitation({ token, ...form });
      setAuthSession(session);
      onAuthenticated?.(getAuthSession());
      setMessage('已加入公司');
      navigate('/');
    } catch (error) {
      setMessage(error.message || '接受邀请失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={accept}>
        <h1>接受邀请</h1>
        {invitation ? (
          <>
            <p>加入 {invitation.companyName || '公司'}，角色：{invitation.role === 'admin' ? '管理员' : '普通成员'}</p>
            <label className="field"><span>邮箱</span><input value={invitation.email || ''} readOnly /></label>
            <label className="field"><span>用户名（新账号需要）</span><input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
            <label className="field"><span>密码（新账号需要）</span><input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
            <p className="hint">如果该邮箱已经注册，请先登录该账号或输入正确密码后接受邀请；如果没有注册，请填写用户名和密码创建账号。</p>
          </>
        ) : (
          <p>正在读取邀请...</p>
        )}
        {message && <p className={message.includes('失败') || message.includes('无效') ? 'error' : 'success-text'}>{message}</p>}
        <button className="primary-button" disabled={loading || !invitation}>{loading ? '处理中...' : '接受邀请'}</button>
      </form>
    </div>
  );
}
function AuthPage({ onAuthenticated }) {
  return <AuthPageFixed onAuthenticated={onAuthenticated} />;
}
function SyncBar({ state, session, syncingNow, onSyncNow, onLogout }) {
  const busy = Boolean(state.syncing || syncingNow);
  return (
    <div className={`sync-bar ${state.online ? '' : 'offline'}`}>
      <span>{uiText(displayCompanyName(session))} / {uiText(state.label || '\u2601 \u5df2\u540c\u6b65')}</span>
      <button onClick={onSyncNow} disabled={busy || !state.online}>
        <RefreshCw size={15} className={busy ? 'spin' : ''} />
        {uiText(busy ? '\u540c\u6b65\u4e2d...' : '\u7acb\u5373\u540c\u6b65')}
      </button>
      <button type="button" onClick={onLogout}>{uiText('\u9000\u51fa')}</button>
    </div>
  );
}


function HomePage({ embedded = false }) {
  const content = (
    <>
      <Section title="发票">
        <ActionLink to="/invoices/new" icon={<Camera />} title="新增发票" subtitle="上传后创建后台识别任务，完成后自动保存" />
        <ActionLink to="/invoices/batch" icon={<Upload />} title="批量导入发票" subtitle="多张图片批量创建后台识别任务" />
        <ActionLink to="/recognition-tasks" icon={<RefreshCw />} title="识别记录/任务列表" subtitle="查看后台 AI 识别状态和历史结果" />
        <ActionLink to="/invoices" icon={<FileText />} title="发票列表" subtitle="按日期倒序查看本地数据" />
      </Section>
      <Section title="查询">
        <ActionLink to="/products" icon={<PackageSearch />} title="商品价格查询" subtitle="所有查询优先使用 IndexedDB" />
      </Section>
      <Section title="管理">
        <ActionLink to="/suppliers" icon={<Building2 />} title="供应商管理" subtitle="供应商和模板支持离线编辑" />
        <ActionLink to="/account-connections" icon={<UserPlus />} title="账户连接" subtitle="搜索账户、发送连接申请、审批收到的申请" />
        <ActionLink to="/settings" icon={<Settings />} title="设置/导出" subtitle="查看本地统计、导出云端 CSV" />
      </Section>
    </>
  );
  if (embedded) return content;
  return <Page title="InvoicePriceTracker" subtitle="云端存储、本地离线、自动同步">{content}</Page>;
}
function InvoiceListPage() {
  const location = useLocation();
  const [items, setItems] = useState([]);
  const [mergeInvoice, setMergeInvoice] = useState(null);
  const [message, setMessage] = useState('');
  const load = () => localDb.getInvoices().then((data) => setItems(safeArray(data)));
  useLocalReload(load);
  const filter = new URLSearchParams(location.search).get('filter') || '';
  const invoiceItems = safeArray(items);
  const filteredItems = invoiceItems.filter((invoice) => {
    if (filter === 'pending') return isPendingInvoice(invoice);
    if (filter === 'abnormal') return isAbnormalInvoice(invoice);
    if (filter === 'duplicate') return isDuplicateInvoice(invoice);
    if (filter === 'conflict') return isConflictInvoice(invoice);
    if (filter === 'multipage') return isPossibleMultiPageInvoice(invoice);
    return true;
  });
  const counts = {
    pending: invoiceItems.filter(isPendingInvoice).length,
    abnormal: invoiceItems.filter(isAbnormalInvoice).length,
    duplicate: invoiceItems.filter(isDuplicateInvoice).length,
    conflict: invoiceItems.filter(isConflictInvoice).length
  };

  return (
    <Page title="发票列表" action={<div className="row-actions"><Link className="icon-button" to="/invoices/batch"><Upload size={18} />批量</Link><Link className="icon-button" to="/invoices/new"><Plus size={18} />新增</Link></div>}>
      <Section title="待处理">
        <div className="metric-grid compact">
          <Metric label="待确认" value={counts.pending} to="/invoices?filter=pending" />
          <Metric label="重复发票" value={counts.duplicate} to="/invoices?filter=duplicate" />
          <Metric label="同步冲突" value={counts.conflict} to="/invoices?filter=conflict" />
          <Metric label="异常发票" value={counts.abnormal} to="/invoices?filter=abnormal" />
        </div>
      </Section>
      {filter && <p className="hint">当前筛选：{filterLabel(filter)} <Link to="/invoices">查看全部</Link></p>}
      {filteredItems.length === 0 && <EmptyState text="暂无发票" />}
      {message && <p className={message.includes('失败') || message.includes('没有') ? 'error' : 'success-text'}>{message}</p>}
      <div className="card-list">
        {filteredItems.map((invoice) => (
          <div className="row-card" key={invoice.id}>
            <div>
              <h3>{invoice.supplierName || '未命名供应商'}</h3>
              <p>日期 {invoice.invoiceDate || '-'} · 金额 {money(invoice.totalAmount)}</p>
              <p><span className={`status-badge ${invoiceBadgeClass(invoice)}`}>{invoiceStatusLabel(invoice)}</span> <span className={`status-badge ${syncBadgeClass(invoice.syncStatus)}`}>{statusText(invoice.syncStatus)}</span>{invoice.invoiceNo ? ` · 发票号 ${invoice.invoiceNo}` : ''}</p>
              <p className="issue-reason">原因：{invoiceIssueReason(invoice)}</p>
            </div>
            <div className="row-actions">
              <button type="button" onClick={() => setMergeInvoice(invoice)}>合并</button>
              <Link to={`/invoices/${invoice.id}`}>详情</Link>
            </div>
          </div>
        ))}
      </div>
      {mergeInvoice && (
        <MergeInvoiceDialog
          invoice={mergeInvoice}
          onClose={() => setMergeInvoice(null)}
          onMerged={(text) => {
            setMergeInvoice(null);
            setMessage(text);
            load();
          }}
        />
      )}
    </Page>
  );
}
function RequireAuth({ session, children }) {
  if (!session?.token || !localStorage.getItem('authToken')) {
    return <AuthPageFixed onAuthenticated={() => {}} />;
  }
  return children;
}

function MergeInvoiceDialog({ invoice, onClose, onMerged }) {
  const navigate = useNavigate();
  const [candidates, setCandidates] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    localDb.getMergeCandidates(invoice.id).then((rows) => {
      if (cancelled) return;
      setCandidates(rows);
      setSelectedIds(rows.filter((row) => row.possibleSameInvoice).map((row) => row.id));
      if (rows.length === 0) setMessage('当前批次没有可合并的发票');
    }).catch((error) => setMessage(error.message || '读取可合并发票失败'));
    return () => {
      cancelled = true;
    };
  }, [invoice.id]);

  function toggle(idValue) {
    setSelectedIds((current) => current.includes(idValue)
      ? current.filter((entry) => entry !== idValue)
      : [...current, idValue]);
  }

  async function confirmMerge() {
    if (selectedIds.length === 0) {
      setMessage('请选择要合并的发票');
      return;
    }
    const selectedRows = candidates.filter((row) => selectedIds.includes(row.id));
    const hasConflict = selectedRows.some((row) => row.supplierId !== invoice.supplierId || row.invoiceNo !== invoice.invoiceNo || Number(row.totalAmount || 0) !== Number(invoice.totalAmount || 0));
    if (hasConflict && !confirm('这些发票可能不是同一张，是否继续合并？')) return;
    setLoading(true);
    setMessage('合并中...');
    try {
      const result = await api.mergeInvoice(invoice.id, selectedIds);
      await pullFromCloud({ full: true });
      onMerged?.(result.message || '✓ 已合并');
      navigate(`/invoices/${encodeURIComponent(result.invoiceId || invoice.id)}`);
    } catch (error) {
      setMessage(error.message || '合并失败');
      alert(`操作失败：${error.message || '合并失败'}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog title="合并多页发票" onClose={onClose}>
      <Section title="主发票">
        <div className="detail-item">
          <strong>{invoice.supplierName || '未命名供应商'}</strong>
          <p>发票号 {invoice.invoiceNo || '-'} · 金额 {money(invoice.totalAmount)} · 批次 {invoice.batchId || invoice.scanBatchId || '-'}</p>
          <p>创建时间 {invoice.createdAt || '-'} · 来源 {sourceLabel(invoice.recognitionSource)}</p>
        </div>
      </Section>
      <Section title="选择要合并的发票/图片">
        {message && <p className={message.includes('失败') || message.includes('没有') ? 'error' : 'hint'}>{message}</p>}
        {candidates.length === 0 && <EmptyState text="当前批次没有可合并的发票" />}
        {candidates.map((candidate) => (
          <label className="merge-candidate" key={candidate.id}>
            <input type="checkbox" checked={selectedIds.includes(candidate.id)} onChange={() => toggle(candidate.id)} />
            {candidate.imagePath && !String(candidate.imagePath).startsWith('indexeddb:') && <img src={api.fileUrl(candidate.imagePath)} alt="发票缩略图" />}
            <span>
              <strong>{candidate.supplierName || '未命名供应商'}</strong>
              <small>发票号 {candidate.invoiceNo || '-'} · 金额 {money(candidate.totalAmount)} · 创建 {candidate.createdAt || '-'}</small>
              <small>来源 {sourceLabel(candidate.recognitionSource)} · {candidate.possibleSameInvoice ? '疑似同一张发票' : '需人工确认'}</small>
            </span>
          </label>
        ))}
      </Section>
      <div className="dialog-actions">
        <button className="secondary-button" disabled={loading} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={loading || candidates.length === 0} onClick={confirmMerge}>{loading ? '合并中...' : '确认合并'}</button>
      </div>
    </Dialog>
  );
}
function BatchImportPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const session = getAuthSession();
  const currentCompanyName = displayCompanyName(session);
  const [entries, setEntries] = useState([]);
  const [existingInvoices, setExistingInvoices] = useState([]);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [batchId, setBatchId] = useState('');
  const [selectedMergeIds, setSelectedMergeIds] = useState([]);
  const [batchAction, setBatchAction] = useState('');

  useLocalReload(() => localDb.getInvoices().then(setExistingInvoices));

  const analyzedEntries = useMemo(() => analyzeBatchEntries(entries, existingInvoices), [entries, existingInvoices]);
  const groupedEntries = useMemo(() => groupBySupplier(analyzedEntries), [analyzedEntries]);
  const successfulEntries = analyzedEntries.filter((entry) => entry.status === 'success');
  const nonDuplicateEntries = successfulEntries.filter((entry) => !entry.isDuplicate);
  const sameInvoiceGroupEntries = successfulEntries.filter((entry) => entry.sameInvoiceGroup && !entry.isDuplicate);
  const possibleDuplicateEntries = successfulEntries.filter((entry) => entry.duplicateStatus === 'possible' && !entry.isDuplicate);
  const failedEntries = analyzedEntries.filter((entry) => entry.status === 'failed');
  const mergeableEntries = analyzedEntries.filter((entry) => entry.status === 'success' && (entry.task?.invoiceId || entry.result?.invoiceId));
  const activeTaskIds = entries.filter((entry) => entry.taskId && !['success', 'failed'].includes(entry.status)).map((entry) => entry.taskId);

  useEffect(() => {
    if (activeTaskIds.length === 0) return undefined;
    let cancelled = false;
    async function refreshTasks() {
      try {
        const tasks = await Promise.all(activeTaskIds.map((taskId) => api.getRecognitionTask(taskId)));
        if (cancelled) return;
        setEntries((current) => current.map((entry) => {
          const task = tasks.find((item) => item.id === entry.taskId);
          if (!task) return entry;
          return {
            ...entry,
            task,
            status: taskStatusToEntryStatus(task.status),
            result: task.result || entry.result,
            error: task.error || entry.error
          };
        }));
        const completedTasks = tasks.filter((task) => task.status === 'completed');
        if (completedTasks.length) {
          console.log('[recognition] completed tasks detected:', completedTasks.map((task) => ({
            taskId: task.id,
            invoiceId: task.invoiceId || '',
            supplierName: task.result?.parsed?.supplierName || '',
            invoiceNo: task.result?.parsed?.invoiceNo || '',
            totalAmount: task.result?.parsed?.totalAmount || 0
          })));
          markSyncPending();
        }
      } catch (error) {
        console.error('Refresh recognition tasks failed:', error);
      }
    }
    refreshTasks();
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshTasks();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTaskIds.join('|')]);

  function updateEntry(id, patch) {
    setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  async function handleFilesSelected(files) {
    const fileList = Array.from(files || []);
    if (fileList.length === 0) return;
    setSaving(true);
    const nextBatchId = generateId();
    setBatchId(nextBatchId);
    const nextEntries = fileList.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      page: null,
      group: null,
      file,
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      status: 'pending',
      result: null,
      error: ''
    }));
    setEntries(nextEntries);
    setMessage(`批量识别任务：${nextBatchId}`);

    if (!navigator.onLine) {
      setMessage('离线模式下无法批量 OCR/AI 识别，请联网后再导入。');
      setEntries(nextEntries.map((entry) => ({ ...entry, status: 'failed', error: 'offline' })));
      setSaving(false);
      return;
    }

    for (const entry of nextEntries) {
      if (entry.status === 'skipped') continue;
      updateEntry(entry.id, { status: 'recognizing' });
      const data = new FormData();
      data.append('image', entry.file);
      data.append('batchId', nextBatchId);
      data.append('companyName', currentCompanyName);
      try {
        const created = await api.createRecognitionTask(data);
        console.log('Batch recognition task:', entry.fileName, created);
        updateEntry(entry.id, {
          taskId: created.taskId,
          task: created.task,
          status: taskStatusToEntryStatus(created.task?.status || 'pending'),
          result: created.task?.result || null,
          error: ''
        });
      } catch (error) {
        console.error('Batch OCR failed:', entry.fileName, error);
        updateEntry(entry.id, { status: 'failed', error: error.message || '识别失败' });
      }
    }
    setSaving(false);
  }

  async function saveBatch() {
    markSyncPending();
    navigate('/recognition-tasks');
  }

  async function retryEntry(entry) {
    updateEntry(entry.id, { status: 'recognizing', error: '' });
    const data = new FormData();
    data.append('image', entry.file);
    data.append('batchId', batchId || generateId());
    data.append('companyName', currentCompanyName);
    try {
      const created = await api.createRecognitionTask(data);
      updateEntry(entry.id, {
        taskId: created.taskId,
        task: created.task,
        status: taskStatusToEntryStatus(created.task?.status || 'pending'),
        result: created.task?.result || null,
        error: ''
      });
    } catch (error) {
      updateEntry(entry.id, { status: 'failed', error: error.message || '识别失败' });
    }
  }

  function deleteEntry(id) {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    setSelectedMergeIds((current) => current.filter((entryId) => entryId !== id));
  }

  function toggleBatchMerge(id) {
    setSelectedMergeIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }

  async function mergeSelectedBatchInvoices() {
    const selected = mergeableEntries.filter((entry) => selectedMergeIds.includes(entry.id));
    if (selected.length < 2) {
      setMessage('请至少选择两张已识别成功的发票进行合并。');
      return;
    }
    const invoiceIds = selected.map((entry) => entry.task?.invoiceId || entry.result?.invoiceId).filter(Boolean);
    setBatchAction('merge');
    try {
      const result = await api.mergeInvoice(invoiceIds[0], invoiceIds.slice(1));
      await pullFromCloud({ full: true });
      setMessage(result.message || '✓ 已合并');
      navigate(`/invoices/${encodeURIComponent(result.invoiceId || invoiceIds[0])}`);
    } catch (error) {
      setMessage(error.message || '合并失败');
    } finally {
      setBatchAction('');
    }
  }

  async function controlBatch(action) {
    if (!batchId) return;
    setBatchAction(action);
    try {
      if (action === 'pause') await api.pauseRecognitionBatch(batchId);
      if (action === 'resume') await api.resumeRecognitionBatch(batchId);
      if (action === 'cancel') await api.cancelRecognitionBatch(batchId);
      setMessage(action === 'pause' ? '已暂停本批次等待中的任务。' : action === 'resume' ? '已继续识别本批次。' : '已取消本批次剩余等待任务。');
    } catch (error) {
      setMessage(error.message || '批次控制失败');
    } finally {
      setBatchAction('');
    }
  }

  return (
    <Page title="批量导入发票" subtitle="一次选择多张图片，后台 OCR/AI 识别并自动保存">
      <Section title="选择图片">
        <div className="field">
          <span>鍙戠エ鍥剧墖</span>
          <button type="button" className="primary-button" disabled={saving} onClick={() => fileInputRef.current?.click()}>
            <Upload size={18} />一次选择多张图片
          </button>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              handleFilesSelected(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
        {batchId && (
          <div className="detail-item">
            <Info label="识别批次" value={batchId} />
            <Info label="照片数量" value={entries.length} />
            <Info label="已完成" value={successfulEntries.length} />
          </div>
        )}
        {batchId && (
          <div className="row-actions">
            <button type="button" disabled={Boolean(batchAction)} onClick={() => controlBatch('resume')}>{batchAction === 'resume' ? '处理中...' : '继续识别'}</button>
            <button type="button" disabled={Boolean(batchAction)} onClick={() => controlBatch('pause')}>{batchAction === 'pause' ? '处理中...' : '暂停识别'}</button>
            <button type="button" className="danger-button" disabled={Boolean(batchAction)} onClick={() => controlBatch('cancel')}>{batchAction === 'cancel' ? '处理中...' : '取消剩余识别'}</button>
          </div>
        )}
      </Section>

      <Section title="识别结果汇总">
        <Info label="已选择" value={entries.length} />
        <Info label="识别成功" value={successfulEntries.length} />
        <Info label="重复发票" value={analyzedEntries.filter((entry) => entry.duplicateStatus === 'confirmed' || entry.isDuplicate).length} />
        <Info label="疑似重复" value={possibleDuplicateEntries.length} />
        <Info label="同号不同金额" value={sameInvoiceGroupEntries.length} />
        <Info label="失败" value={failedEntries.length} />
        <Info label="可保存" value={nonDuplicateEntries.length} />
        {failedEntries.length > 0 && (
          <div className="detail-item">
            <strong>错误列表</strong>
            {failedEntries.map((entry) => <p key={entry.id}>{entry.fileName}: {entry.error || '识别失败'}</p>)}
          </div>
        )}
        {mergeableEntries.length >= 2 && (
          <button type="button" className="secondary-button" disabled={Boolean(batchAction)} onClick={mergeSelectedBatchInvoices}>{batchAction === 'merge' ? '合并中...' : '合并选中的发票'}</button>
        )}
      </Section>

      {Object.entries(groupedEntries).map(([supplierName, supplierEntries]) => (
        <Section key={supplierName} title={`供应商：${supplierName}`}>
          {supplierEntries.map((entry) => (
            <div className="detail-item" key={entry.id}>
              <div className="split">
                <strong>{entry.fileName}</strong>
                <strong className={(entry.duplicateStatus === 'confirmed' || entry.isDuplicate) ? 'text-danger' : (entry.duplicateStatus === 'possible' || entry.sameInvoiceGroup) ? 'warning-text' : ''}>{batchStatusText(entry)}</strong>
              </div>
              {entry.taskId && <p>任务 ID：{entry.taskId}</p>}
              <img className="invoice-preview" src={entry.previewUrl} alt={entry.fileName} />
              {entry.status === 'success' && (
                <>
                  {(entry.task?.invoiceId || entry.result?.invoiceId) && (
                    <label className="hint"><input type="checkbox" checked={selectedMergeIds.includes(entry.id)} onChange={() => toggleBatchMerge(entry.id)} /> 选择用于合并</label>
                  )}
                  <p>发票号：{entry.parsed.invoiceNo || '-'}</p>
                  <p>日期：{entry.parsed.invoiceDate || '-'} · 金额：{money(entry.parsed.totalAmount || entry.itemTotal)}</p>
                  <p>识别来源：{entry.result.recognitionSource || sourceLabel(entry.result.source)} · 商品 {entry.parsed.items?.length || 0} 行</p>
                  {(entry.duplicateStatus === 'confirmed' || entry.isDuplicate) && <p className="error">检测到重复发票：{entry.duplicateReason}</p>}
                  {entry.duplicateStatus === 'possible' && !entry.isDuplicate && <p className="warning-text">{entry.possibleDuplicateReason || '疑似重复，请确认。'}</p>}
                  {entry.autoMerged && <p className="success-text">{entry.autoMergeMessage || `已自动合并：发票号 ${entry.parsed.invoiceNo || '-'}，总金额 ${money(entry.result?.duplicateCheck?.invoiceTotal || entry.parsed.totalAmount)}`}</p>}
                  {entry.sameInvoiceGroup && !entry.isDuplicate && !entry.autoMerged && <p className="warning-text">{entry.sameInvoiceGroupReason}</p>}
                  {entry.sequenceNote && <p className="hint">{entry.sequenceNote}</p>}
                </>
              )}
              {entry.status === 'failed' && (
                <>
                  <p className="error">{entry.error}</p>
                  <div className="row-actions">
                    <button type="button" onClick={() => retryEntry(entry)}>重新识别</button>
                    <button type="button" onClick={() => navigate('/invoices/new')}>手动编辑</button>
                    <button type="button" className="text-danger" onClick={() => deleteEntry(entry.id)}>删除</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </Section>
      ))}

      {message && <p className="error">{message}</p>}
      <div className="sticky-actions">
        <button className="primary-button" onClick={saveBatch}>
          <Save size={18} />查看识别记录
        </button>
      </div>    </Page>
  );
}

function RecognitionTaskListPage() {
  const [tasks, setTasks] = useState([]);
  const [message, setMessage] = useState('');
  const [taskActions, setTaskActions] = useState({});
  const [taskMessages, setTaskMessages] = useState({});
  const pulledCompletedTaskIds = useRef(new Set());

  async function load() {
    try {
      const data = await api.getRecognitionTasks();
      const taskRows = safeArray(data);
      setTasks(taskRows);
      const completedWithInvoice = taskRows.filter((task) => task?.status === 'completed' && task?.invoiceId);
      if (completedWithInvoice.some((task) => !pulledCompletedTaskIds.current.has(task.id))) {
        completedWithInvoice.forEach((task) => pulledCompletedTaskIds.current.add(task.id));
        await pullFromCloud({ full: true });
      }
    } catch (error) {
      setMessage(error.message || '读取识别任务失败');
    }
  }

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!cancelled) await load();
    };
    run();
    const timer = window.setInterval(() => {
      if (!document.hidden) run();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  function setTaskMessage(taskId, text, type = 'info') {
    setTaskMessages((current) => ({ ...current, [taskId]: { text, type } }));
  }

  async function retry(taskId) {
    setTaskActions((current) => ({ ...current, [taskId]: 'retry' }));
    setTaskMessage(taskId, '重新识别处理中...', 'info');
    try {
      await api.retryRecognitionTask(taskId);
      setTaskMessage(taskId, '✓ 已重新加入后台识别队列', 'success');
      load();
    } catch (error) {
      setTaskMessage(taskId, error.message || '重新识别失败', 'error');
      alert(`操作失败：${error.message || '重新识别失败'}`);
    } finally {
      setTaskActions((current) => ({ ...current, [taskId]: '' }));
    }
  }

  async function forceSave(taskId) {
    setTaskActions((current) => ({ ...current, [taskId]: 'force' }));
    setTaskMessage(taskId, '强制保存处理中...', 'info');
    try {
      await api.forceSaveRecognitionTask(taskId);
      setTaskMessage(taskId, '✓ 已强制保存该识别结果', 'success');
      await pullFromCloud({ full: true });
      load();
    } catch (error) {
      setTaskMessage(taskId, error.message || '强制保存失败', 'error');
      alert(`操作失败：${error.message || '强制保存失败'}`);
    } finally {
      setTaskActions((current) => ({ ...current, [taskId]: '' }));
    }
  }

  async function reuploadTaskImage(task, file) {
    if (!file) return;
    setTaskActions((current) => ({ ...current, [task.id]: 'reupload' }));
    setTaskMessage(task.id, '重新上传处理中...', 'info');
    const data = new FormData();
    data.append('image', file);
    data.append('batchId', task.batchId || generateId());
    try {
      const created = await api.createRecognitionTask(data);
      setTaskMessage(task.id, `✓ 已重新上传并创建任务：${created.taskId}`, 'success');
      load();
    } catch (error) {
      setTaskMessage(task.id, error.message || '重新上传失败', 'error');
    } finally {
      setTaskActions((current) => ({ ...current, [task.id]: '' }));
    }
  }

  async function decideTask(taskId, action) {
    setTaskActions((current) => ({ ...current, [taskId]: action }));
    setTaskMessage(taskId, '处理中...', 'info');
    try {
      await api.decideRecognitionTask(taskId, action);
      setTaskMessage(taskId, action === 'merge' ? '✓ 已合并' : action === 'duplicate' ? '✓ 已标记重复' : '✓ 已保留', 'success');
      await pullFromCloud({ full: true });
      load();
    } catch (error) {
      setTaskMessage(taskId, error.message || '人工确认失败', 'error');
      alert(`操作失败：${error.message || '人工确认失败'}`);
    } finally {
      setTaskActions((current) => ({ ...current, [taskId]: action === 'merge' ? 'merged' : action === 'duplicate' ? 'duplicated' : action === 'independent' ? 'kept' : '' }));
    }
  }

  return (
    <Page title="识别记录/任务列表" action={<Link className="icon-button" to="/invoices/new"><Plus size={18} />新增</Link>}>
      {message && <p className="error">{message}</p>}
      {tasks.length === 0 && <EmptyState text="暂无识别任务" />}
      <div className="card-list">
        {tasks.map((task) => {
          const action = taskActions[task.id] || '';
          const taskMessage = taskMessages[task.id];
          const handled = ['merged', 'duplicated', 'kept'].includes(action);
          return (
            <div className="row-card" key={task.id}>
              <div>
                <h3>{task.originalName || task.id}</h3>
                <p>状态：{recognitionTaskStatusText(task.status)} · 创建时间 {task.createdAt || '-'}</p>
                {task.batchId && <p>批次：{task.batchId}</p>}
                <p>来源：{task.recognitionSource || sourceLabel(task.source)} · 重试 {task.retryCount || 0} 次</p>
                {task.imagePath && <img className="invoice-preview" src={api.fileUrl(task.imagePath)} alt={task.originalName || task.id} />}
                {task.result?.parsed && <p>{task.result.parsed.supplierName || '未识别供应商'} · {task.result.parsed.invoiceNo || '无发票号'} · {money(task.result.parsed.totalAmount)}</p>}
                {task.result?.parsed?.totalDifference > 0.05 && <p className="warning-text">商品明细与发票总额不一致，请检查。差额：{money(task.result.parsed.totalDifference)}</p>}
                {(task.result?.duplicateCheck?.duplicateStatus === 'confirmed' || task.result?.duplicateCheck?.isDuplicate) && <p className="error">重复发票：{task.result.duplicateCheck.duplicateReason}</p>}
                {task.result?.duplicateCheck?.duplicateStatus === 'possible' && !task.result?.duplicateCheck?.isDuplicate && <p className="warning-text">{task.result.duplicateCheck.possibleDuplicateReason || '疑似重复，请确认。'}</p>}
                {task.result?.duplicateCheck?.autoMerged && <p className="success-text">{task.result.duplicateCheck.autoMergeMessage || `已自动合并：发票号 ${task.result?.parsed?.invoiceNo || '-'}，总金额 ${money(task.result.duplicateCheck.invoiceTotal || task.result?.parsed?.totalAmount)}`}</p>}
                {task.result?.duplicateCheck?.sameInvoiceGroup && !task.result?.duplicateCheck?.isDuplicate && !task.result?.duplicateCheck?.autoMerged && <p className="warning-text">{task.result.duplicateCheck.sameInvoiceGroupReason}</p>}
                {task.error && <p className="error">{task.error}</p>}
                {taskMessage?.text && <p className={taskMessage.type === 'error' ? 'error' : taskMessage.type === 'success' ? 'success-text' : 'hint'}>{taskMessage.text}</p>}
              </div>
              <div className="row-actions">
                {task.invoiceId && <Link className="icon-button" to={`/invoices/${task.invoiceId}`}>{task.result?.duplicateCheck?.autoMerged ? '查看合并明细' : '发票'}</Link>}
                {task.status === 'failed' && <button disabled={Boolean(action)} onClick={() => retry(task.id)}>{action === 'retry' ? '处理中...' : '重新识别'}</button>}
                {task.status === 'failed' && (
                  <label className="icon-button">
                    重新上传图片
                    <input className="hidden-file-input" type="file" accept="image/*" onChange={(event) => { reuploadTaskImage(task, event.target.files?.[0]); event.target.value = ''; }} />
                  </label>
                )}
                {task.status === 'failed' && <Link className="icon-button" to="/invoices/new">手动编辑</Link>}
                {task.status === 'completed' && task.result?.duplicateCheck?.isDuplicate && !task.invoiceId && <button disabled={Boolean(action)} onClick={() => forceSave(task.id)}>{action === 'force' ? '处理中...' : '强制保存'}</button>}
                {task.status === 'completed' && task.result?.duplicateCheck?.sameInvoiceGroup && !task.result?.duplicateCheck?.autoMerged && (
                  <>
                    <button className={action === 'merged' ? 'success-button' : ''} disabled={handled || Boolean(action)} onClick={() => decideTask(task.id, 'merge')}>{action === 'merge' ? '合并中...' : action === 'merged' ? '✓ 已合并' : '合并'}</button>
                    <button className={action === 'duplicated' ? 'danger-button' : ''} disabled={handled || Boolean(action)} onClick={() => decideTask(task.id, 'duplicate')}>{action === 'duplicate' ? '标记中...' : action === 'duplicated' ? '✓ 已标记重复' : '标记重复'}</button>
                    <button className={action === 'kept' ? 'success-button' : ''} disabled={handled || Boolean(action)} onClick={() => decideTask(task.id, 'independent')}>{action === 'independent' ? '处理中...' : action === 'kept' ? '✓ 已保留' : '保留为独立发票'}</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
function InvoiceArchivePage() {
  const navigate = useNavigate();
  const uploadRef = useRef(null);
  const [q, setQ] = useState('');
  const [tree, setTree] = useState([]);
  const [message, setMessage] = useState('');
  const [sortMode, setSortMode] = useState('name');
  const [currentKey, setCurrentKey] = useState('root');
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewer, setViewer] = useState(null);
  const session = getAuthSession();
  const companyName = session?.company?.name || session?.user?.companyName || '我的公司';

  const load = () => localDb.getArchiveTree('')
    .then((data) => {
      setTree(safeArray(data));
      setMessage('');
    })
    .catch((error) => setMessage(error.message || '文档库加载失败'));
  useLocalReload(load, []);

  const archive = useMemo(() => buildArchiveFileSystem(safeArray(tree), companyName, sortMode), [tree, companyName, sortMode]);
  const currentNode = archive.nodeIndex.get(currentKey) || archive.root;
  const breadcrumbs = archiveBreadcrumbs(archive.nodeIndex, currentNode.key);
  const searchResults = useMemo(() => archiveSearchResults(archive, q), [archive, q]);
  const currentSupplierName = useMemo(() => {
    if (currentNode?.type === 'supplier') return currentNode.label;
    if (currentNode?.type === 'month') {
      const parent = archive.nodeIndex.get(currentNode.parentKey);
      return parent?.type === 'supplier' ? parent.label : '';
    }
    return '';
  }, [archive, currentNode]);

  useEffect(() => {
    if (!archive.nodeIndex.has(currentKey)) setCurrentKey('root');
  }, [archive, currentKey]);

  function openFolder(nodeKey) {
    if (archive.nodeIndex.has(nodeKey)) setCurrentKey(nodeKey);
  }

  function goBack() {
    const parentKey = currentNode?.parentKey;
    if (parentKey && archive.nodeIndex.has(parentKey)) setCurrentKey(parentKey);
  }

  async function deleteArchiveFile(file) {
    if (!file?.invoiceId) return;
    if (!window.confirm(`确定删除 ${file.fileName} 对应的发票记录和本地图片吗？`)) return;
    try {
      await localDb.deleteInvoice(file.invoiceId);
      markSyncPending();
      setViewer(null);
      await load();
      setMessage('已删除发票、本地图片索引和文档库记录。');
    } catch (error) {
      setMessage(error.message || '删除失败');
    }
  }

  function openFile(file) {
    const files = currentNode?.files?.length ? currentNode.files : archive.allFiles;
    const index = Math.max(0, files.findIndex((item) => item.key === file.key));
    setViewer({ files, index });
  }

  function openSearchResult(result) {
    if (result.kind === 'file') {
      openFolder(result.parentKey);
      setViewer({ files: archive.nodeIndex.get(result.parentKey)?.files || [result.file], index: Math.max(0, (archive.nodeIndex.get(result.parentKey)?.files || []).findIndex((file) => file.key === result.file.key)) });
    } else {
      openFolder(result.node.key);
    }
    setQ('');
  }

  async function handleArchiveUpload(files) {
    const fileList = Array.from(files || []);
    if (!fileList.length) return;
    if (!currentSupplierName || currentSupplierName === '未分类') {
      setMessage('请先进入具体供货商文件夹，再上传发票照片。');
      return;
    }
    try {
      setMessage('正在导入到当前供货商目录...');
      const session = await localDb.createImportSessionFromFiles(fileList, { supplierName: currentSupplierName });
      const batchId = session?.session?.id || generateId();
      for (const file of fileList) {
        const page = session?.pages?.find((entry) => entry.originalFileName === file.name);
        const group = session?.groups?.find((entry) => entry.pages?.some((pageEntry) => pageEntry.originalFileName === file.name));
        if (page?.status === 'skipped_duplicate') continue;
        const data = new FormData();
        data.append('image', file);
        data.append('batchId', batchId);
        data.append('companyName', companyName);
        data.append('supplierHint', currentSupplierName);
        if (session?.session?.id) data.append('importSessionId', session.session.id);
        if (group?.id) data.append('invoiceGroupId', group.id);
        if (page?.id) data.append('invoicePageId', page.id);
        await api.createRecognitionTask(data);
      }
      markSyncPending();
      await load();
      setMessage(`已上传到 ${currentSupplierName}，识别任务已创建。`);
    } catch (error) {
      setMessage(error.message || '上传到供货商目录失败');
    } finally {
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }

  const folderNodes = safeArray(currentNode?.children);
  const files = safeArray(currentNode?.files);

  return (
    <Page title="发票文档库" subtitle="文件管理器模式，按供货商和年月自动归档">
      <div className="archive-manager">
        <input
          ref={uploadRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(event) => handleArchiveUpload(event.target.files)}
        />
        <div className="archive-topbar">
          <button type="button" className="icon-button" onClick={goBack} disabled={currentNode.key === 'root'} aria-label="返回上一级">
            <ArrowLeft size={18} />
          </button>
          <div className="archive-breadcrumb" aria-label="当前路径">
            {breadcrumbs.map((crumb, index) => (
              <button type="button" key={crumb.key} onClick={() => openFolder(crumb.key)}>
                {index > 0 && <span>/</span>}
                <strong>{crumb.label}</strong>
              </button>
            ))}
          </div>
          <div className="archive-menu-wrap">
            <button type="button" className="icon-button" onClick={() => setMenuOpen((value) => !value)} aria-label="文档库菜单">
              <MoreVertical size={18} />
            </button>
            {menuOpen && (
              <div className="archive-menu">
                <button type="button" onClick={() => { uploadRef.current?.click(); setMenuOpen(false); }} disabled={!currentSupplierName || currentSupplierName === '未分类'}>上传到当前供货商</button>
                <button type="button" onClick={() => { setMessage('文档库目录由 AI 识别和确认入库自动创建。'); setMenuOpen(false); }}>新建文件夹（管理员）</button>
                <button type="button" onClick={() => { setSortMode('date'); setMenuOpen(false); }}>排序：按日期</button>
                <button type="button" onClick={() => { setSortMode('supplier'); setMenuOpen(false); }}>排序：按供应商</button>
                <button type="button" onClick={() => { setSortMode('name'); setMenuOpen(false); }}>排序：按名称</button>
                <button type="button" onClick={() => { load(); setMenuOpen(false); }}>刷新</button>
                <button type="button" onClick={() => { setMessage('已重新扫描本地归档索引。'); load(); setMenuOpen(false); }}>重新扫描文档</button>
              </div>
            )}
          </div>
        </div>

        <div className="archive-stats">
          <span>供应商：<strong>{archive.stats.supplierCount}</strong></span>
          <span>发票：<strong>{archive.stats.invoiceCount}张</strong></span>
          <span>存储空间：<strong>{formatArchiveBytes(archive.stats.storageBytes)}</strong></span>
        </div>

        <div className="archive-search">
          <Search size={18} />
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索供货商、年份、月份、发票号、日期"
          />
        </div>

        {message && <p className={message.includes('失败') ? 'error' : 'success'}>{message}</p>}

        {q.trim() && (
          <div className="archive-search-results">
            {searchResults.length === 0 && <p className="hint">没有找到匹配的文件夹或发票。</p>}
            {searchResults.slice(0, 12).map((result) => (
              <button type="button" key={result.key} onClick={() => openSearchResult(result)}>
                {result.kind === 'file' ? <ImageIcon size={18} /> : <Folder size={18} />}
                <span>{result.label}</span>
                <small>{result.path}</small>
              </button>
            ))}
          </div>
        )}

        {folderNodes.length === 0 && files.length === 0 && <EmptyState text="暂无归档发票。确认入库后的发票会按供货商和年月自动出现在这里。" />}

        {folderNodes.length > 0 && (
          <div className="archive-grid" aria-label="文件夹">
            {folderNodes.map((node) => (
              <button type="button" className="archive-tile archive-folder-tile" key={node.key} onClick={() => openFolder(node.key)}>
                <span className="folder-icon"><Folder size={44} fill="currentColor" /></span>
                <span className="archive-tile-name">{node.label}</span>
                <small>{node.meta}</small>
              </button>
            ))}
          </div>
        )}

        {files.length > 0 && (
          <div className="archive-grid archive-file-grid" aria-label="发票图片">
            {files.map((file) => (
              <button type="button" className="archive-tile archive-file-tile" key={file.key} onClick={() => openFile(file)}>
                <ArchiveImageThumb file={file} />
                <span className="archive-tile-name">{file.fileName}</span>
                <small>{file.invoiceNo || file.invoiceDate || '发票图片'}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {viewer && (
        <ArchiveImageViewer
          files={viewer.files}
          index={viewer.index}
          onIndexChange={(index) => setViewer((current) => ({ ...current, index }))}
          onClose={() => setViewer(null)}
          onDelete={deleteArchiveFile}
          onDetail={(invoiceId) => navigate(`/invoices/${encodeURIComponent(invoiceId)}`)}
          onReprocessed={load}
        />
      )}
    </Page>
  );
}

function buildArchiveFileSystem(tree, companyName, sortMode = 'name') {
  const nodeIndex = new Map();
  const allFiles = [];
  const supplierNames = new Set();
  let invoiceCount = 0;
  let storageBytes = 0;
  const root = createArchiveNode('root', 'Home', 'root', '');

  for (const supplier of safeArray(tree)) {
    const supplierName = normalizeArchiveLabel(supplier?.supplierName || '\u672a\u5206\u7c7b');
    if (supplierName) supplierNames.add(supplierName);
    const supplierNode = createArchiveNode(`supplier:${supplierName}`, supplierName, 'supplier', root.key);
    for (const month of safeArray(supplier?.months)) {
      const monthKey = month?.month || '\u672a\u5206\u7c7b\u6708\u4efd';
      const monthNode = createArchiveNode(`supplier:${supplierName}:month:${monthKey}`, formatArchiveMonth(monthKey), 'month', supplierNode.key);
      const monthInvoices = safeArray(month?.invoices).map((invoice) => ({
        ...invoice,
        supplierName: normalizeArchiveLabel(invoice?.supplierDisplayName || invoice?.supplierName || supplierName || '\u672a\u5206\u7c7b')
      }));
      sortArchiveEntries(monthInvoices, sortMode, (invoice) => `${invoice?.invoiceDate || ''} ${invoice?.invoiceNo || ''}`);
      let sequence = 1;
      for (const invoice of monthInvoices) {
        invoiceCount += 1;
        const files = archiveFilesForInvoice(invoice, sequence);
        sequence += files.length || 1;
        for (const file of files) {
          storageBytes += Number(file.size || 0);
          file.parentKey = monthNode.key;
          monthNode.files.push(file);
          allFiles.push(file);
        }
      }
      monthNode.meta = `${safeArray(monthNode.files).length} \u5f20`;
      supplierNode.children.push(monthNode);
    }
    sortArchiveEntries(supplierNode.children, sortMode, (month) => month.label);
    supplierNode.meta = `${supplierNode.children.length} \u4e2a\u6708 / ${supplierNode.children.reduce((sum, month) => sum + safeArray(month.files).length, 0)} \u5f20`;
    root.children.push(supplierNode);
  }
  sortArchiveEntries(root.children, sortMode, (supplier) => supplier.label);

  const visit = (node) => {
    nodeIndex.set(node.key, node);
    for (const child of safeArray(node.children)) visit(child);
  };
  visit(root);
  return { root, nodeIndex, allFiles, stats: { supplierCount: supplierNames.size, invoiceCount, storageBytes } };
}
function createArchiveNode(key, label, type, parentKey) {
  return {
    key,
    label,
    type,
    parentKey,
    children: [],
    files: [],
    meta: ''
  };
}

function normalizeArchiveLabel(value) {
  const text = String(value || '').trim();
  if (!text || /^unknown supplier$/i.test(text) || text === '\u672a\u547d\u540d\u4f9b\u5e94\u5546') return '\u672a\u5206\u7c7b';
  return text.replace(/\s+/g, ' ');
}

function sortArchiveEntries(entries, sortMode, labelGetter) {
  entries.sort((a, b) => {
    if (sortMode === 'date') {
      return `${b?.invoiceDate || b?.month || b?.label || ''}${b?.createdAt || ''}`.localeCompare(`${a?.invoiceDate || a?.month || a?.label || ''}${a?.createdAt || ''}`);
    }
    if (sortMode === 'supplier') {
      return String(a?.supplierName || a?.label || '').localeCompare(String(b?.supplierName || b?.label || ''));
    }
    return String(labelGetter(a) || '').localeCompare(String(labelGetter(b) || ''));
  });
  return entries;
}

function formatArchiveMonth(monthKey) {
  const match = String(monthKey || '').match(/^(\d{4})-(\d{1,2})/);
  if (!match) return monthKey || '\u672a\u5206\u7c7b\u6708\u4efd';
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;
}

function archiveFilesForInvoice(invoice, startSequence = 1) {
  const pages = safeArray(invoice?.pages);
  const sourcePages = pages.length > 0 ? pages : [{
    id: `${invoice?.id || 'invoice'}-page-1`,
    invoiceId: invoice?.id || invoice?.serverId || '',
    imageId: invoice?.imageId || '',
    imagePath: invoice?.imagePath || invoice?.imageUrl || invoice?.originalImageUrl || '',
    archiveFilePath: invoice?.archiveFilePath || '',
    originalFileName: invoice?.originalFilePath || '',
    fileSize: invoice?.fileSize || invoice?.imageSize || 0,
    pageIndex: 1
  }];
  return sourcePages.map((page, index) => {
    const sequence = startSequence + index;
    const date = invoice?.invoiceDate || 'undated';
    const ext = archiveFileExtension(page?.originalFileName || page?.archiveFilePath || invoice?.archiveFilePath || invoice?.imagePath || '');
    const fileName = `${date}-${String(sequence).padStart(3, '0')}${ext}`;
    return {
      key: `${invoice?.id || invoice?.serverId || 'invoice'}:${page?.id || index}`,
      fileName,
      invoiceId: invoice?.id || invoice?.serverId || '',
      invoiceNo: invoice?.invoiceNo || '',
      invoiceDate: invoice?.invoiceDate || '',
      supplierName: normalizeArchiveLabel(invoice?.supplierDisplayName || invoice?.supplierName || ''),
      totalAmount: Number(invoice?.totalAmount || 0),
      imageId: page?.imageId || invoice?.imageId || '',
      imagePath: page?.imagePath || page?.archiveFilePath || invoice?.imagePath || invoice?.imageUrl || invoice?.originalImageUrl || '',
      archiveFilePath: page?.archiveFilePath || invoice?.archiveFilePath || '',
      size: Number(page?.fileSize || invoice?.fileSize || invoice?.imageSize || 0),
      pageIndex: Number(page?.pageIndex || page?.pageNumber || index + 1),
      pageCount: Number(page?.pageCount || sourcePages.length || 1),
      invoice
    };
  });
}

function archiveFileExtension(value) {
  const match = String(value || '').match(/\.(jpe?g|png|heic|webp)$/i);
  return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

function archiveBreadcrumbs(nodeIndex, key) {
  const crumbs = [];
  let node = nodeIndex.get(key);
  while (node) {
    crumbs.unshift({ key: node.key, label: node.label });
    node = node.parentKey ? nodeIndex.get(node.parentKey) : null;
  }
  return crumbs;
}

function archiveSearchResults(archive, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const node of archive.nodeIndex.values()) {
    if (node.type === 'root') continue;
    const path = archiveBreadcrumbs(archive.nodeIndex, node.key).map((crumb) => crumb.label).join(' / ');
    if (`${node.label} ${path}`.toLowerCase().includes(q)) {
      results.push({ key: `node:${node.key}`, kind: 'folder', label: node.label, path, node });
    }
  }
  for (const file of archive.allFiles) {
    const path = archiveBreadcrumbs(archive.nodeIndex, file.parentKey).map((crumb) => crumb.label).join(' / ');
    const haystack = `${file.fileName} ${file.invoiceNo} ${file.invoiceDate} ${file.supplierName} ${path}`.toLowerCase();
    if (haystack.includes(q)) results.push({ key: `file:${file.key}`, kind: 'file', label: file.fileName, path, file });
  }
  return results;
}

function formatArchiveBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ArchiveImageThumb({ file }) {
  const [src, setSrc] = useState('');
  const [status, setStatus] = useState('loading');
  const imageKey = `${file?.imageId || ''}|${file?.imagePath || ''}|${file?.archiveFilePath || ''}`;

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    async function loadImage() {
      setStatus('loading');
      setSrc('');
      try {
        const record = await localDb.getInvoiceImage({ id: file?.invoiceId, imageId: file?.imageId, imagePath: file?.imagePath });
        const blob = record?.imageBlob || record?.blob;
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) {
            setSrc(objectUrl);
            setStatus('loaded');
          }
          return;
        }
        const serverPath = file?.imagePath || file?.archiveFilePath || '';
        if (serverPath && !String(serverPath).startsWith('indexeddb:') && !String(serverPath).startsWith('blob:')) {
          if (!cancelled) {
            setSrc(api.fileUrl(serverPath));
            setStatus('loading');
          }
          return;
        }
        if (!cancelled) setStatus('error');
      } catch {
        if (!cancelled) setStatus('error');
      }
    }
    loadImage();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageKey, file?.invoiceId]);

  if (src) {
    return <img className="archive-thumb" src={src} alt={file?.fileName || '发票图片'} onLoad={() => setStatus('loaded')} onError={() => { setSrc(''); setStatus('error'); }} />;
  }
  return (
    <span className={`archive-thumb-placeholder ${status === 'error' ? 'is-error' : ''}`}>
      <ImageIcon size={30} />
      <small>{status === 'error' ? '图片缺失' : '加载中'}</small>
    </span>
  );
}

function ArchiveImageViewer({ files, index, onIndexChange, onClose, onDelete, onDetail, onReprocessed }) {
  const fileList = safeArray(files);
  const activeIndex = Math.min(Math.max(index || 0, 0), Math.max(fileList.length - 1, 0));
  const file = fileList[activeIndex];
  const [src, setSrc] = useState('');
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [zoomed, setZoomed] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [busy, setBusy] = useState('');
  const touchStartX = useRef(null);
  const lastTapAt = useRef(0);
  const imageKey = `${file?.key || ''}|${file?.imageId || ''}|${file?.imagePath || ''}`;

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    async function loadImage() {
      setStatus('loading');
      setSrc('');
      setMessage('');
      try {
        const record = await localDb.getInvoiceImage({ id: file?.invoiceId, imageId: file?.imageId, imagePath: file?.imagePath });
        const blob = record?.imageBlob || record?.blob;
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) {
            setSrc(objectUrl);
            setStatus('loaded');
          }
          return;
        }
        const serverPath = file?.imagePath || file?.archiveFilePath || '';
        if (serverPath && !String(serverPath).startsWith('indexeddb:') && !String(serverPath).startsWith('blob:')) {
          if (!cancelled) {
            setSrc(api.fileUrl(serverPath));
            setStatus('loading');
          }
          return;
        }
        if (!cancelled) {
          setStatus('error');
          setMessage('图片加载失败，请重新上传图片。');
        }
      } catch (error) {
        if (!cancelled) {
          setStatus('error');
          setMessage(error.message || '图片读取失败');
        }
      }
    }
    loadImage();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageKey, file?.invoiceId]);

  function move(delta) {
    const next = activeIndex + delta;
    if (next >= 0 && next < fileList.length) {
      setShowAi(false);
      setZoomed(false);
      onIndexChange(next);
    }
  }

  async function shareFile() {
    try {
      if (navigator.share) {
        await navigator.share({ title: file?.fileName || '发票图片', text: `${file?.supplierName || ''} ${file?.invoiceNo || ''}`.trim(), url: src || window.location.href });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(src || file?.fileName || '');
        setMessage('图片链接已复制。');
      }
    } catch (error) {
      setMessage(error.message || '分享失败');
    }
  }

  async function reprocess() {
    if (!file?.invoiceId) return;
    setBusy('reprocess');
    try {
      await api.reprocessInvoiceWithAI(file.invoiceId);
      await onReprocessed?.();
      setMessage('已提交 AI 重新识别。');
    } catch (error) {
      setMessage(error.message || '重新识别失败');
    } finally {
      setBusy('');
    }
  }

  const aiJson = file?.invoice?.aiResult || file?.invoice?.aiJson || file?.invoice?.recognitionJson || file?.invoice?.recognitionResult || '';

  return (
    <div className="archive-viewer" role="dialog" aria-modal="true">
      <div className="archive-viewer-toolbar">
        <button type="button" onClick={onClose}>关闭</button>
        <div>
          <strong>{file?.fileName || '发票图片'}</strong>
          <small>{activeIndex + 1} / {fileList.length}</small>
        </div>
        <button type="button" onClick={shareFile}><Share2 size={16} /> 分享</button>
      </div>
      <div
        className="archive-viewer-canvas"
        onTouchStart={(event) => { touchStartX.current = event.touches?.[0]?.clientX ?? null; }}
        onTouchEnd={(event) => {
          const start = touchStartX.current;
          const end = event.changedTouches?.[0]?.clientX ?? null;
          if (start !== null && end !== null && Math.abs(start - end) > 50) move(start > end ? 1 : -1);
          if (start !== null && end !== null && Math.abs(start - end) <= 10) {
            const now = Date.now();
            if (now - lastTapAt.current < 320) setZoomed((value) => !value);
            lastTapAt.current = now;
          }
          touchStartX.current = null;
        }}
      >
        <button type="button" className="archive-viewer-nav left" onClick={() => move(-1)} disabled={activeIndex === 0}><ChevronLeft /></button>
        {src && status !== 'error' ? (
          <img
            className={zoomed ? 'is-zoomed' : ''}
            src={src}
            alt={file?.fileName || '发票图片'}
            onDoubleClick={() => setZoomed((value) => !value)}
            onLoad={() => setStatus('loaded')}
            onError={() => { setSrc(''); setStatus('error'); setMessage('图片加载失败，请重新上传图片。'); }}
          />
        ) : (
          <div className="archive-viewer-error">
            <ImageIcon size={42} />
            <strong>{status === 'loading' ? '图片加载中' : '图片加载失败，请重新上传图片'}</strong>
          </div>
        )}
        <button type="button" className="archive-viewer-nav right" onClick={() => move(1)} disabled={activeIndex >= fileList.length - 1}><ChevronRight /></button>
      </div>
      <div className="archive-viewer-actions">
        <button type="button" onClick={() => setShowAi((value) => !value)}>查看 AI 识别结果</button>
        <button type="button" onClick={reprocess} disabled={busy === 'reprocess'}><Wand2 size={16} /> {busy === 'reprocess' ? '处理中…' : '重新 AI 识别'}</button>
        <button type="button" onClick={() => onDetail?.(file?.invoiceId)} disabled={!file?.invoiceId}>查看发票详情</button>
        <button type="button" className="danger" onClick={() => onDelete?.(file)}><Trash2 size={16} /> 删除</button>
      </div>
      {message && <p className={message.includes('失败') ? 'error' : 'success'}>{message}</p>}
      {showAi && (
        <pre className="archive-ai-json">{typeof aiJson === 'string' ? (aiJson || '暂无 AI 识别结果') : JSON.stringify(aiJson || {}, null, 2)}</pre>
      )}
    </div>
  );
}
function InvoiceFormPage() {
  const navigate = useNavigate();
  const cameraInputRef = useRef(null);
  const albumInputRef = useRef(null);
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState({
    id: generateId(),
    supplierName: '',
    invoiceNo: '',
    invoiceDate: today(),
    totalAmount: 0,
    imagePath: '',
    imageId: '',
    ocrText: '',
    status: 'PENDING_REVIEW',
    notes: '',
    items: [emptyItem()]
  });
  const [preview, setPreview] = useState('');
  const [ocrStatus, setOcrStatus] = useState('未识别');
  const [recognitionTask, setRecognitionTask] = useState(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    localDb.getSuppliers().then(setSuppliers);
  }, []);

  useEffect(() => {
    if (!recognitionTask?.id || ['completed', 'failed'].includes(recognitionTask.status)) return undefined;
    let cancelled = false;
    async function refreshTask() {
      try {
        const task = await api.getRecognitionTask(recognitionTask.id);
        if (cancelled) return;
        setRecognitionTask(task);
        setOcrStatus(`后台识别：${recognitionTaskStatusText(task.status)}`);
        if (task.status === 'completed') {
          applyRecognitionTaskToForm(task);
          setMessage(task.invoiceId ? '识别完成，后端已保存发票。' : '识别完成。');
          markSyncPending();
        }
        if (task.status === 'failed') setMessage(task.error || '识别失败');
      } catch (error) {
        if (!cancelled) setMessage(error.message || '读取识别任务失败');
      }
    }
    refreshTask();
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshTask();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [recognitionTask?.id, recognitionTask?.status]);

  function updateItem(index, field, value) {
    setForm((current) => {
      const items = [...current.items];
      const next = { ...items[index], [field]: value };
      if (field === 'quantity' || field === 'unitPrice') {
        next.totalPrice = Number(next.quantity || 0) * Number(next.unitPrice || 0);
      }
      if (field === 'quantity' || field === 'unitPrice' || field === 'totalPrice') {
        next.isFreeItem = Number(next.unitPrice || 0) === 0 || Number(next.totalPrice || 0) === 0;
        next.freeReason = next.isFreeItem ? (next.freeReason || '免费/赠品行') : '';
      }
      items[index] = next;
      return { ...current, items };
    });
  }

  function applyRecognitionTaskToForm(task) {
    const parsed = task.result?.parsed || task.result || {};
    const mappedItems = (parsed.items || []).map((item) => ({
      ...emptyItem(),
      id: generateId(),
      productNameOriginal: item.name || item.productNameOriginal || [item.nameCn, item.nameEn].filter(Boolean).join(' '),
      productNameNormalized: item.normalizedName || item.productNameNormalized || item.name || '',
      quantity: Number(item.qty ?? item.quantity ?? 0),
      unit: item.unit || '',
      unitPrice: Number(item.unitPrice ?? item.priceEach ?? 0),
      totalPrice: Number(item.totalPrice ?? item.amount ?? 0),
      nameConfidence: Number(item.nameConfidence ?? item.itemConfidence ?? 0),
      nameQualityStatus: item.nameQualityStatus || 'trusted',
      nameQualityReason: item.nameQualityReason || '',
      rawOcrLine: item.rawOcrLine || '',
      itemRecognitionSource: item.itemRecognitionSource || task.result?.source || 'ai',
      candidateOnly: Boolean(item.candidateOnly || item.nameQualityStatus === 'needs_review')
    }));
    setForm((current) => ({
      ...current,
      supplierName: parsed.supplierName || current.supplierName,
      invoiceNo: parsed.invoiceNo || current.invoiceNo,
      invoiceDate: parsed.invoiceDate || current.invoiceDate,
      totalAmount: Number(parsed.totalAmount || current.totalAmount || 0),
      ocrText: task.result?.ocrText || current.ocrText,
      recognitionSource: task.result?.recognitionSource || task.result?.source || current.recognitionSource,
      items: mappedItems.length ? mappedItems : current.items
    }));
  }

  async function handleInvoiceImageSelected(file) {
    if (!file) return;
    const invoiceId = form.id || generateId();
    const previewUrl = URL.createObjectURL(file);
    setPreview(previewUrl);
    setForm((current) => ({ ...current, id: invoiceId }));
    try {
      const image = await localDb.saveInvoiceImage(file, { invoiceId, source: 'invoice-upload' });
      setForm((current) => ({ ...current, id: invoiceId, imageId: image.id, imagePath: `indexeddb:${image.id}` }));
    } catch (error) {
      setMessage(error.message || '图片保存失败，请重新上传。');
      setOcrStatus('图片保存失败');
      return;
    }
    if (!navigator.onLine) {
      setOcrStatus('识别失败');
      setMessage('离线模式下 OCR 暂不可用，请先手动录入。');
      return;
    }
    setOcrStatus('识别中');
    setMessage('');
    const data = new FormData();
    data.append('image', file);
    if (form.supplierName) data.append('supplierHint', form.supplierName);
    try {
      const created = await api.createRecognitionTask(data);
      setRecognitionTask(created.task);
      setOcrStatus(`后台识别：${recognitionTaskStatusText(created.task?.status || 'pending')}`);
      setMessage(`已创建后台识别任务：${created.taskId}`);
    } catch (error) {
      setOcrStatus(`识别失败：${error.message || '未知错误'} · 识别来源：OCR`);
      setMessage(error.message || '识别失败');
    }
  }

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      if (form.imagePath || form.imageId) {
        const imageCheck = await localDb.verifyInvoiceImage(form);
        if (!imageCheck.ok && String(form.imagePath || '').startsWith('indexeddb:')) {
          throw new Error(imageCheck.message || '图片保存失败，请重新上传。');
        }
      }
      await localDb.createInvoice(form);
      markSyncPending();
      navigate('/invoices');
    } catch (error) {
      setMessage(error.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page title="新增发票" subtitle="上传后创建后台识别任务，完成后自动保存；也可以手动录入。">
      <Section title="发票信息">
        <label className="field"><span>供应商名称</span><input list="supplier-list" value={form.supplierName} onChange={(event) => setForm({ ...form, supplierName: event.target.value })} /></label>
        <datalist id="supplier-list">{suppliers.map((supplier) => <option key={supplier.id} value={supplier.supplierDisplayName || supplier.displayName || supplier.name} />)}</datalist>
        <label className="field"><span>发票号</span><input value={form.invoiceNo} onChange={(event) => setForm({ ...form, invoiceNo: event.target.value })} /></label>
        <label className="field"><span>日期</span><input type="date" value={form.invoiceDate} onChange={(event) => setForm({ ...form, invoiceDate: event.target.value })} /></label>
        <label className="field"><span>总金额</span><input type="number" value={form.totalAmount} onChange={(event) => setForm({ ...form, totalAmount: Number(event.target.value) })} /></label>
      </Section>
      <Section title="上传图片">
        <div className="row-actions">
          <button type="button" onClick={() => cameraInputRef.current?.click()}>拍照识别</button>
          <button type="button" onClick={() => albumInputRef.current?.click()}>从相册选择</button>
        </div>
        <input ref={cameraInputRef} className="hidden-file-input" type="file" accept="image/*" capture="environment" onChange={(event) => handleInvoiceImageSelected(event.target.files?.[0])} />
        <input ref={albumInputRef} className="hidden-file-input" type="file" accept="image/*" onChange={(event) => handleInvoiceImageSelected(event.target.files?.[0])} />
        {preview && <img className="invoice-preview" src={preview} alt="发票预览" />}
        <p className="hint">OCR 状态：{ocrStatus}</p>
        {recognitionTask?.id && <p className="hint">任务 ID：{recognitionTask.id}</p>}
        {message && <p className={message.includes('失败') ? 'error' : 'success-text'}>{message}</p>}
      </Section>
      <Section title={`商品明细 · ${form.items.length} 行`}>
        {form.items.map((item, index) => (
          <div className="detail-item" key={item.id || index}>
            <label className="field"><span>商品名称</span><input value={item.productNameOriginal || ''} onChange={(event) => updateItem(index, 'productNameOriginal', event.target.value)} /></label>
            <label className="field"><span>标准名</span><input value={item.productNameNormalized || ''} onChange={(event) => updateItem(index, 'productNameNormalized', event.target.value)} /></label>
            <label className="field"><span>数量</span><input type="number" value={item.quantity || 0} onChange={(event) => updateItem(index, 'quantity', event.target.value)} /></label>
            <label className="field"><span>单位</span><input value={item.unit || ''} onChange={(event) => updateItem(index, 'unit', event.target.value)} /></label>
            <label className="field"><span>单价</span><input type="number" value={item.unitPrice || 0} onChange={(event) => updateItem(index, 'unitPrice', event.target.value)} /></label>
            <label className="field"><span>总价</span><input type="number" value={item.totalPrice || 0} onChange={(event) => updateItem(index, 'totalPrice', event.target.value)} /></label>
            {(item.candidateOnly || item.nameQualityStatus === 'needs_review') && <p className="warning-text">待确认/异常商品：不会进入正式商品统计和价格历史。{item.nameQualityReason || ''}</p>}
            <button type="button" className="danger-button" onClick={() => setForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}>删除行</button>
          </div>
        ))}
        <button type="button" onClick={() => setForm((current) => ({ ...current, items: [...current.items, emptyItem()] }))}>新增行</button>
      </Section>
      <div className="sticky-actions">
        <button className="primary-button" disabled={saving} onClick={save}><Save size={18} />{saving ? '保存中...' : '保存发票'}</button>
      </div>
    </Page>
  );
}
function InvoiceDetailPage() {
  return <InvoiceDetailPageWithGifts />;
}
function HomeDashboardPage() {
  const [dashboard, setDashboard] = useState(null);
  const load = () => {
    const readLocalDashboard = localDb.getDashboardStats || localDb.getDashboardMetrics;
    return api.getDashboardStats()
      .then((data) => setDashboard(data || {}))
      .catch((error) => {
        console.warn('[dashboard] cloud stats failed, falling back to IndexedDB', error);
        if (typeof readLocalDashboard !== 'function') {
          setDashboard({});
          return null;
        }
        return readLocalDashboard.call(localDb).then((data) => setDashboard(data || {}));
      });
  };
  useLocalReload(load);
  return (
    <Page title="InvoicePriceTracker" subtitle="采购数据库、供应商数据库、历史价格数据库">
      <Section title="采购仪表盘">
        <div className="metric-grid">
          <Metric label="已确认采购金额" value={money(dashboard?.confirmedPurchaseAmount ?? dashboard?.totalPurchaseAmount)} />
          <Metric label="待确认采购金额" value={money(dashboard?.pendingPurchaseAmount)} to="/invoices?filter=pending" />
          <Metric label="异常发票金额" value={money(dashboard?.abnormalPurchaseAmount)} to="/invoices?filter=abnormal" />
          <Metric label="本月已确认金额" value={money(dashboard?.monthConfirmedAmount ?? dashboard?.monthAmount)} />
          <Metric label="本月待确认金额" value={money(dashboard?.monthPendingAmount)} to="/invoices?filter=pending" />
          <Metric label="已确认发票数量" value={dashboard?.confirmedInvoiceCount ?? dashboard?.invoiceCount ?? 0} />
          <Metric label="待确认发票数量" value={dashboard?.pendingInvoiceCount ?? 0} to="/invoices?filter=pending" />
          <Metric label="异常发票数量" value={dashboard?.abnormalInvoiceCount ?? 0} to="/invoices?filter=abnormal" />
          <Metric label="重复发票数量" value={dashboard?.duplicateInvoiceCount ?? 0} to="/invoices?filter=duplicate" />
          <Metric label="同步冲突数量" value={dashboard?.conflictInvoiceCount ?? 0} to="/invoices?filter=conflict" />
          <Metric label="供应商数量" value={dashboard?.supplierCount ?? 0} />
          <Metric label="赠品总价值" value={money(dashboard?.giftValue)} />
          <Metric label="折扣总金额" value={money(dashboard?.discountAmount)} />
        </div>
      </Section>
      <HomePage embedded />
    </Page>
  );
}
function InvoiceDetailPageWithGifts() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [recognitionTask, setRecognitionTask] = useState(null);
  const [editingInvoice, setEditingInvoice] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [detailMessage, setDetailMessage] = useState('');
  const [operation, setOperation] = useState('');

  const loadDetail = () => localDb.getInvoice(id).then(setDetail);
  useLocalReload(loadDetail, [id], { listenToEvents: false });

  useEffect(() => {
    let cancelled = false;
    api.getRecognitionTasks()
      .then((tasks) => {
        if (cancelled) return;
        const task = tasks.find((entry) => entry.invoiceId === id || entry.result?.invoiceId === id);
        setRecognitionTask(task || null);
      })
      .catch(() => {
        if (!cancelled) setRecognitionTask(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function remove() {
    if (!confirm('确认删除这张发票？')) return;
    await localDb.deleteInvoice(id);
    markSyncPending();
    navigate('/invoices');
  }

  async function saveEditedItems(nextItems) {
    setOperation('save-items');
    try {
      const updated = await localDb.updateInvoiceItems(id, nextItems, detail?.items || []);
      setDetail(updated);
      setDetailMessage('✓ 商品已保存');
      markSyncPending();
      return updated;
    } catch (error) {
      alert(`操作失败：${error.message || '保存商品失败'}`);
      throw error;
    } finally {
      setOperation('');
    }
  }

  async function saveEditedItem(nextItem) {
    const nextItems = (detail?.items || []).map((item) => item.id === nextItem.id ? nextItem : item);
    await saveEditedItems(nextItems);
    setEditingItem(null);
  }

  async function saveInvoiceFields(fields) {
    setOperation('save-invoice');
    try {
      const updated = await localDb.updateInvoiceFields(id, fields);
      setDetail(updated);
      setEditingInvoice(false);
      setDetailMessage('✓ 发票已保存');
      markSyncPending();
    } catch (error) {
      alert(`操作失败：${error.message || '保存发票失败'}`);
    } finally {
      setOperation('');
    }
  }

  async function confirmInvoice(status = 'CONFIRMED') {
    setOperation('confirm-invoice');
    try {
      const updated = await localDb.confirmInvoice(id, status);
      setDetail(updated);
      setDetailMessage(status === 'ABNORMAL_HANDLED' ? '✓ 异常已处理' : '✓ 发票已确认');
      markSyncPending();
    } catch (error) {
      alert(`操作失败：${error.message || '确认发票失败'}`);
    } finally {
      setOperation('');
    }
  }

  async function markDuplicate() {
    setOperation('mark-duplicate');
    try {
      const updated = await localDb.updateInvoiceDuplicateStatus(id, 'duplicate', 'DUPLICATE');
      setDetail(updated);
      setDetailMessage('✓ 已标记重复');
      markSyncPending();
    } catch (error) {
      alert(`操作失败：${error.message || '标记重复失败'}`);
    } finally {
      setOperation('');
    }
  }

  async function keepIndependent() {
    setOperation('keep-independent');
    try {
      const updated = await localDb.updateInvoiceDuplicateStatus(id, 'none', 'CONFIRMED');
      setDetail(updated);
      setDetailMessage('✓ 已保留为独立发票');
      markSyncPending();
    } catch (error) {
      alert(`操作失败：${error.message || '保留独立发票失败'}`);
    } finally {
      setOperation('');
    }
  }

  async function reprocessWithAI() {
    setOperation('reprocess-ai');
    setDetailMessage('AI Vision 重新识别中...');
    try {
      await api.reprocessInvoiceWithAI(id);
      await pullFromCloud({ full: true });
      const updated = await localDb.getInvoice(id);
      setDetail(updated);
      setDetailMessage('✓ AI Vision 重新识别完成，商品明细已更新');
    } catch (error) {
      setDetailMessage('');
      alert(`操作失败：${error.message || 'AI Vision 重新识别失败'}`);
    } finally {
      setOperation('');
    }
  }

  if (!detail) return <Page title="发票详情"><EmptyState text="未找到发票" /></Page>;

  const { invoice, items, discounts = [], mergedInvoices = [] } = detail;
  const giftSummary = summarizeGiftAccounting(items);
  const finalSavedResult = { invoice, items, discounts, mergedInvoices };

  return (
    <Page title="发票详情" action={<div className="row-actions"><button type="button" disabled={operation === 'reprocess-ai'} onClick={reprocessWithAI}>{operation === 'reprocess-ai' ? 'AI 识别中...' : '使用 AI Vision 重新识别'}</button><button type="button" onClick={() => setEditingInvoice(true)}>编辑发票</button><button className="danger-button" onClick={remove}><Trash2 size={16} />删除</button></div>}>
      {detailMessage && <p className="success-text">{detailMessage}</p>}
      <Section title="处理状态">
        <div className="status-row">
          <span className={`status-badge ${invoiceBadgeClass(invoice)}`}>{invoiceStatusLabel(invoice)}</span>
          <span className={`status-badge ${syncBadgeClass(invoice.syncStatus)}`}>{statusText(invoice.syncStatus)}</span>
        </div>
        <p className="issue-reason">原因：{invoiceIssueReason(invoice)}</p>
        {isDuplicateInvoice(invoice) && <p className="error">重复候选：{invoice.duplicateOfInvoiceId || '-'}</p>}
        {isConflictInvoice(invoice) && <p className="warning-text">同步冲突需要人工确认。请编辑后保存，或保留为独立发票。</p>}
        {(isDuplicateInvoice(invoice) || isConflictInvoice(invoice) || invoice.duplicateStatus === 'possible') && (
          <div className="row-actions">
            <button className="secondary-button" type="button" onClick={() => setEditingInvoice(true)}>编辑发票</button>
            <button className="secondary-button" type="button" disabled={!items.length} onClick={() => items[0] && setEditingItem(items[0])}>编辑商品明细</button>
            {invoice.duplicateStatus === 'possible' && <button className="danger-button" type="button" disabled={operation === 'mark-duplicate'} onClick={markDuplicate}>{operation === 'mark-duplicate' ? '标记中...' : '标记重复'}</button>}
            <button className="primary-button success-button" type="button" disabled={operation === 'keep-independent'} onClick={keepIndependent}>{operation === 'keep-independent' ? '处理中...' : '保留为独立发票'}</button>
          </div>
        )}
        {(isPendingInvoice(invoice) || isAbnormalInvoice(invoice)) && (
          <div className="row-actions">
            <button className="primary-button success-button" type="button" disabled={operation === 'confirm-invoice'} onClick={() => confirmInvoice('CONFIRMED')}>{operation === 'confirm-invoice' ? '处理中...' : '确认发票'}</button>
            <button className="secondary-button" type="button" onClick={() => setEditingInvoice(true)}>编辑发票</button>
            <button className="secondary-button" type="button" disabled={!items.length} onClick={() => items[0] && setEditingItem(items[0])}>编辑商品明细</button>
          </div>
        )}
      </Section>
      <Section title="发票信息">
        <Info label="供应商" value={invoice.supplierName || '-'} />
        <Info label="发票号" value={invoice.invoiceNo || '-'} />
        <Info label="日期" value={invoice.invoiceDate || '-'} />
        <Info label="总金额" value={money(invoice.totalAmount)} />
        <Info label="识别来源" value={sourceLabel(invoice.recognitionSource)} />
      </Section>
      <Section title="查看原图">
        <InvoiceImageViewer invoice={invoice} onUpdated={loadDetail} />
        {mergedInvoices.map((mergedInvoice, index) => (
          <div className="detail-item" key={mergedInvoice.id}>
            <strong>页面 {index + 2} · {mergedInvoice.invoiceNo || '-'}</strong>
            <InvoiceImageViewer invoice={mergedInvoice} onUpdated={loadDetail} />
          </div>
        ))}
      </Section>
      <Section title="赠品核算">
        <Info label="收费数量" value={numberText(giftSummary.chargedQty)} />
        <Info label="免费数量" value={numberText(giftSummary.freeQty)} />
        <Info label="实际数量" value={numberText(giftSummary.totalQty)} />
        <Info label="发票金额" value={money(giftSummary.invoiceAmount)} />
        <Info label="原始单价" value={money(giftSummary.originalUnitCost)} />
        <Info label="实际成本" value={money(giftSummary.effectiveUnitCost)} />
      </Section>
      <Section title="商品明细">
        {items.map((item) => (
          <div className="detail-item" key={item.id}>
            <div className="split"><strong>{item.productNameOriginal}</strong><button type="button" onClick={() => setEditingItem(item)}>编辑</button></div>
            <p>标准名：{standardProductNameText(item)}</p>
            <p>数量 {numberText(item.quantity)} {item.unit} · 原单价 {money(item.unitPrice)} · 总价 {money(item.totalPrice)}</p>
            <p>是否赠品：{Number(item.isFreeItem || 0) ? `是（${item.freeReason || '免费行'}）` : '否'} · 收费数量 {numberText(item.chargedQty)} · 免费数量 {numberText(item.freeQty)} · 实际数量 {numberText(item.totalQty)}</p>
            <p>原始单价 {money(item.originalUnitCost || item.unitPrice)} · 实际摊薄成本 {money(item.effectiveUnitCost || item.unitPrice)} · 折后实际成本 {money(item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice)}</p>
            {(Number(item.candidateOnly || 0) || item.nameQualityStatus === 'needs_review') && <p className="warning-text">待确认/异常商品：不会进入正式商品统计和价格历史。{item.nameQualityReason || ''}</p>}
            {item.itemRecognitionSource && <p className="hint">商品名来源：{sourceLabel(item.itemRecognitionSource)} · 置信度 {Number(item.nameConfidence || 0).toFixed(2)}</p>}
          </div>
        ))}
      </Section>
      <CollapsibleSection title="查看 OCR 原文">
        <pre className="ocr-text">{invoice.ocrText || '无 OCR 内容'}</pre>
      </CollapsibleSection>
      <CollapsibleSection title="查看 AI 识别 JSON">
        <pre className="ocr-text">{recognitionTask?.result ? JSON.stringify(recognitionTask.result, null, 2) : '未找到关联 AI 识别 JSON'}</pre>
      </CollapsibleSection>
      <CollapsibleSection title="查看最终保存结果">
        <pre className="ocr-text">{JSON.stringify(finalSavedResult, null, 2)}</pre>
      </CollapsibleSection>
      {editingItem && <InvoiceItemEditDialog item={editingItem} onClose={() => setEditingItem(null)} onSave={saveEditedItem} />}
      {editingInvoice && <InvoiceEditDialog invoice={invoice} onClose={() => setEditingInvoice(false)} onSave={saveInvoiceFields} />}
    </Page>
  );
}
function InvoiceEditDialog({ invoice, onClose, onSave }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
    supplierName: invoice.supplierName || '',
    supplierNameChinese: invoice.supplierNameChinese || '',
    supplierNameEnglish: invoice.supplierNameEnglish || '',
    supplierDisplayName: invoice.supplierDisplayName || invoice.supplierName || '',
    invoiceNo: invoice.invoiceNo || '',
    invoiceDate: invoice.invoiceDate || today(),
    totalAmount: Number(invoice.totalAmount || 0),
    notes: invoice.notes || ''
  }));
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  async function save() {
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title="编辑发票" onClose={onClose}>
      <label className="field"><span>供应商</span><input value={form.supplierName} onChange={(event) => update('supplierName', event.target.value)} /></label>
      <label className="field"><span>中文公司名</span><input value={form.supplierNameChinese} onChange={(event) => update('supplierNameChinese', event.target.value)} /></label>
      <label className="field"><span>英文公司名</span><input value={form.supplierNameEnglish} onChange={(event) => update('supplierNameEnglish', event.target.value)} /></label>
      <label className="field"><span>显示名称</span><input value={form.supplierDisplayName} onChange={(event) => update('supplierDisplayName', event.target.value)} /></label>
      <label className="field"><span>发票号</span><input value={form.invoiceNo} onChange={(event) => update('invoiceNo', event.target.value)} /></label>
      <label className="field"><span>日期</span><input type="date" value={form.invoiceDate} onChange={(event) => update('invoiceDate', event.target.value)} /></label>
      <div className="grid-2">
        <label className="field"><span>金额</span><input type="number" value={form.totalAmount} onChange={(event) => update('totalAmount', event.target.value)} /></label>
      </div>
      <label className="field"><span>备注</span><textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} /></label>
      <div className="dialog-actions sticky-actions sticky-dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button success-button" type="button" disabled={saving} onClick={save}>{saving ? '处理中...' : '保存发票'}</button>
      </div>
    </Dialog>
  );
}
function InvoiceItemEditDialog({ item, onClose, onSave }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({ ...emptyItem(), ...item, correctedByUser: true }));
  const calculatedTotal = Number(form.quantity || 0) * Number(form.unitPrice || 0);
  const mismatch = Math.abs(calculatedTotal - Number(form.totalPrice || 0)) > 0.05;
  const update = (field, value) => {
    setForm((current) => {
      const next = { ...current, [field]: value, correctedByUser: true };
      if (field === 'quantity' || field === 'unitPrice') {
        next.totalPrice = Number(next.quantity || 0) * Number(next.unitPrice || 0);
      }
      if (field === 'chargedQty' || field === 'freeQty') {
        next.totalQty = Number(next.chargedQty || 0) + Number(next.freeQty || 0);
        next.actualQty = next.totalQty;
      }
      const actualQty = Number(next.actualQty || next.totalQty || next.quantity || 0);
      if (actualQty > 0) next.effectiveUnitCost = Number(next.totalPrice || 0) / actualQty;
      if (field === 'productNameOriginal') {
        next.productNameNormalized = value;
        next.nameQualityStatus = 'trusted';
        next.nameQualityReason = '';
        next.nameConfidence = 1;
        next.candidateOnly = false;
      }
      return next;
    });
  };
  async function save() {
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title="编辑商品明细" onClose={onClose}>
      <div className="compact-form">
        <label className="field"><span>商品名称</span><input value={form.productNameOriginal || ''} onChange={(event) => update('productNameOriginal', event.target.value)} /></label>
        <label className="field"><span>品牌</span><input value={form.brand || ''} onChange={(event) => update('brand', event.target.value)} /></label>
        <label className="field"><span>规格</span><input value={form.spec || form.size || ''} onChange={(event) => update('spec', event.target.value)} /></label>
        <div className="grid-2">
          <label className="field"><span>数量</span><input type="number" value={form.quantity || 0} onChange={(event) => update('quantity', event.target.value)} /></label>
          <label className="field"><span>单价</span><input type="number" value={form.unitPrice || 0} onChange={(event) => update('unitPrice', event.target.value)} /></label>
          <label className="field"><span>总价</span><input type="number" value={form.totalPrice || 0} onChange={(event) => update('totalPrice', event.target.value)} /></label>
          <label className="field"><span>收费数量</span><input type="number" value={form.chargedQty || 0} onChange={(event) => update('chargedQty', event.target.value)} /></label>
          <label className="field"><span>免费数量</span><input type="number" value={form.freeQty || 0} onChange={(event) => update('freeQty', event.target.value)} /></label>
          <label className="field"><span>实际数量</span><input type="number" value={form.actualQty || form.totalQty || 0} onChange={(event) => update('actualQty', event.target.value)} /></label>
          <label className="field"><span>实际摊薄成本</span><input type="number" value={Number(form.effectiveUnitCost || 0).toFixed(2)} onChange={(event) => update('effectiveUnitCost', event.target.value)} /></label>
        </div>
        {mismatch && <p className="warning-text">总价与 数量 x 单价 不一致，计算值：{money(calculatedTotal)}。允许保存。</p>}
        <SwitchField label="是否赠品" checked={Boolean(form.isFreeItem)} onChange={(checked) => update('isFreeItem', checked)} />
        <SwitchField label="是否折扣行" checked={Boolean(form.isDiscountLine)} onChange={(checked) => update('isDiscountLine', checked)} />
        <SwitchField label="备注/候选行不计入价格" checked={Boolean(form.candidateOnly)} onChange={(checked) => update('candidateOnly', checked)} />
        <SwitchField label="参与赠品分摊" checked={Boolean(form.participatesInGiftAllocation)} onChange={(checked) => update('participatesInGiftAllocation', checked)} />
        <label className="field"><span>备注</span><input value={form.notes || ''} onChange={(event) => update('notes', event.target.value)} /></label>
        <CollapsibleSection title="高级信息">
          <label className="field"><span>标准名</span><input value={form.productNameNormalized || ''} onChange={(event) => update('productNameNormalized', event.target.value)} /></label>
          <label className="field"><span>单位</span><input value={form.unit || ''} onChange={(event) => update('unit', event.target.value)} /></label>
          <label className="field"><span>分摊组 ID</span><input value={form.promoGroupId || ''} onChange={(event) => update('promoGroupId', event.target.value)} /></label>
          <label className="field"><span>分摊组名称</span><input value={form.promoGroupName || ''} onChange={(event) => update('promoGroupName', event.target.value)} /></label>
          <label className="field"><span>OCR 原文行</span><input value={form.rawOcrLine || ''} onChange={(event) => update('rawOcrLine', event.target.value)} /></label>
        </CollapsibleSection>
      </div>
      <div className="dialog-actions sticky-actions sticky-dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button success-button" type="button" disabled={saving} onClick={save}>{saving ? '保存中...' : '保存商品'}</button>
      </div>
    </Dialog>
  );
}
function PromoAllocationDialog({ items, onClose, onSave }) {
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState(() => items.map((item) => ({ ...item })));
  const update = (id, field, value) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      const next = { ...row, [field]: value, correctedByUser: true };
      if (field === 'chargedQty' || field === 'freeQty') {
        next.totalQty = Number(next.chargedQty || 0) + Number(next.freeQty || 0);
        next.actualQty = next.totalQty;
      }
      const actualQty = Number(next.actualQty || next.totalQty || next.quantity || 0);
      if (actualQty > 0) next.effectiveUnitCost = Number(next.totalPrice || 0) / actualQty;
      return next;
    }));
  };
  async function save() {
    setSaving(true);
    try {
      await onSave(rows);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title="编辑赠品分摊组" onClose={onClose}>
      <div className="card-list">
        {rows.map((row) => (
          <div className="detail-item" key={row.id}>
            <strong>{row.productNameOriginal}</strong>
            <label className="field"><span>分摊组名称</span><input value={row.promoGroupName || ''} onChange={(event) => update(row.id, 'promoGroupName', event.target.value)} /></label>
            <label className="field"><span>收费数量</span><input type="number" value={row.chargedQty || 0} onChange={(event) => update(row.id, 'chargedQty', event.target.value)} /></label>
            <label className="field"><span>免费数量</span><input type="number" value={row.freeQty || 0} onChange={(event) => update(row.id, 'freeQty', event.target.value)} /></label>
            <label className="field"><span>实际数量</span><input type="number" value={row.actualQty || row.totalQty || 0} onChange={(event) => update(row.id, 'actualQty', event.target.value)} /></label>
            <label className="field"><span>发票金额</span><input type="number" value={row.totalPrice || 0} onChange={(event) => update(row.id, 'totalPrice', event.target.value)} /></label>
            <label className="field"><span>原始单价</span><input type="number" value={row.originalUnitCost || row.unitPrice || 0} onChange={(event) => update(row.id, 'originalUnitCost', event.target.value)} /></label>
            <label className="field"><span>实际摊薄成本</span><input type="number" value={Number(row.effectiveUnitCost || 0).toFixed(2)} onChange={(event) => update(row.id, 'effectiveUnitCost', event.target.value)} /></label>
          </div>
        ))}
      </div>
      <div className="dialog-actions sticky-actions sticky-dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button success-button" type="button" disabled={saving} onClick={save}>{saving ? '保存中...' : '保存分摊'}</button>
      </div>
    </Dialog>
  );
}
function ProductSearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [diagnostics, setDiagnostics] = useState(null);
  const [syncSnapshot, setSyncSnapshot] = useState(null);
  const [searchError, setSearchError] = useState('');
  const searchSeq = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const seq = searchSeq.current + 1;
      searchSeq.current = seq;
      const keyword = q;
      try {
        console.info('[products] cloud search request', { q: keyword });
        let data;
        let nextSearchError = '';
        try {
          data = await api.searchProducts(keyword);
          console.info('[products] cloud search response', {
            q: keyword,
            count: apiItems(data).length,
            counts: data?.counts || null,
            source: data?.source || 'cloud'
          });
        } catch (cloudError) {
          console.warn('[products] cloud search failed, falling back to IndexedDB', cloudError);
          nextSearchError = `云端查询失败：${errorMessage(cloudError)}`;
          data = await localDb.searchProducts(keyword);
        }
        if (!cancelled && searchSeq.current === seq) {
          setResults(apiItems(data));
          setSearchError(nextSearchError);
        }
        const [localDiagnostics, snapshot] = await Promise.all([
          localDb.getLocalDiagnostics().catch((error) => ({
            counts: {
              products: `error: ${errorMessage(error)}`,
              invoice_items: `error: ${errorMessage(error)}`,
              price_history: `error: ${errorMessage(error)}`
            },
            error: errorMessage(error)
          })),
          getSyncSnapshot().catch((error) => ({
            label: '同步状态读取失败',
            lastError: errorMessage(error)
          }))
        ]);
        if (!cancelled && searchSeq.current === seq) {
          setDiagnostics(localDiagnostics);
          setSyncSnapshot(snapshot);
        }
      } catch (error) {
        recordPageError(error, { componentStack: 'ProductSearchPage' }, 'searchProducts');
        if (!cancelled && searchSeq.current === seq) {
          setResults([]);
          setSearchError(`商品查询失败：${errorMessage(error)}`);
          setDiagnostics({
            counts: {
              products: `error: ${errorMessage(error)}`,
              invoice_items: `error: ${errorMessage(error)}`,
              price_history: `error: ${errorMessage(error)}`
            },
            error: errorMessage(error)
          });
          setSyncSnapshot({
            label: '同步状态读取失败',
            lastError: errorMessage(error)
          });
        }
      }
    };
    const handler = () => run();
    run();
    window.addEventListener('local-db-change', handler);
    window.addEventListener('sync-state-change', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('local-db-change', handler);
      window.removeEventListener('sync-state-change', handler);
    };
  }, [q]);
  const productResults = safeArray(results);
  const hasKeyword = q.trim().length > 0;
  const counts = diagnostics?.counts || {};
  const syncErrorText = syncSnapshot?.lastError
    || syncSnapshot?.diagnostic?.error
    || (syncSnapshot?.diagnostic?.status === 'failed' ? '同步失败但未返回错误，请查看 Console [SYNC]' : '')
    || (syncSnapshot?.diagnostic?.warningCount ? `同步有 ${syncSnapshot.diagnostic.warningCount} 个警告` : '')
    || '\u65e0';
  const noLocalData = Number(counts.invoice_items || 0) === 0 && Number(counts.price_history || 0) === 0 && Number(counts.products || 0) === 0;
  const emptyText = hasKeyword
    ? (searchError || '\u6ca1\u6709\u627e\u5230\u76f8\u5173\u5546\u54c1')
    : (noLocalData ? '\u672c\u5730\u6682\u65e0\u6570\u636e\uff0c\u8bf7\u5148\u540c\u6b65' : '\u672c\u5730\u6709\u6570\u636e\uff0c\u4f46\u6ca1\u6709\u53ef\u663e\u793a\u7684\u5546\u54c1\u8bb0\u5f55');
  return (
    <Page title={'\u5546\u54c1\u4ef7\u683c\u67e5\u8be2'} subtitle={'\u8054\u7f51\u65f6\u76f4\u63a5\u67e5\u8be2\u4e91\u7aef\u6570\u636e\uff1b\u79bb\u7ebf\u65f6\u4f7f\u7528\u672c\u5730 IndexedDB \u7f13\u5b58\u3002'}>
      <Section title={'\u641c\u7d22'}>
        <label className="field"><span>{'\u5546\u54c1\u540d\u79f0'}</span><input value={q} onChange={(event) => setQ(event.target.value)} placeholder={'\u5343\u9875\u8c46\u8150 / Rice Chips / ITOEN'} /></label>
        {!hasKeyword && <p className="hint">{'\u672a\u8f93\u5165\u5173\u952e\u8bcd\u65f6\u663e\u793a\u6700\u8fd1 20 \u4e2a\u8d2d\u4e70\u5546\u54c1\u3002'}</p>}
      </Section>
      {productResults.length === 0 && (
        <EmptyState text={emptyText} />
      )}
      {productResults.length === 0 && (
        <Section title={'\u672c\u5730\u6570\u636e\u8bca\u65ad'}>
          {searchError && <p className="error">{searchError}</p>}
          <Info label="products" value={counts.products ?? '-'} />
          <Info label="invoice_items" value={counts.invoice_items ?? '-'} />
          <Info label="price_history" value={counts.price_history ?? '-'} />
          <Info label={'\u540c\u6b65\u72b6\u6001'} value={syncSnapshot?.label || '-'} />
          <Info label={'\u540c\u6b65\u9519\u8bef'} value={syncErrorText} />
        </Section>
      )}
      <div className="card-list">
        {productResults.map((item, index) => {
          const displayName = uiText(item?.productName || item?.productNameOriginal || item?.originalName || item?.itemName || item?.name || item?.standardName || item?.productNameNormalized || '\u672a\u547d\u540d\u5546\u54c1');
          const routeName = uiText(item?.productNameNormalized || item?.normalizedName || item?.standardName || displayName);
          return (
          <Link className="row-card" to={`/products/${encodeURIComponent(routeName || '')}`} key={routeName || item?.productId || index}>
            <div>
              <h3>{displayName}</h3>
              <p>{'\u6700\u8fd1\u4ef7\u683c'} {money(item?.recentPrice)} / {'\u6700\u4f4e\u4ef7'} {money(item?.minPrice)} / {'\u6700\u9ad8\u4ef7'} {money(item?.maxPrice)}</p>
              <p>{'\u5747\u4ef7'} {money(item?.averagePrice)} / {'\u6700\u8fd1\u4f9b\u5e94\u5546'} {item?.recentSupplierName || '-'} / {'\u6700\u8fd1\u91c7\u8d2d'} {item?.recentPurchaseDate || '-'} / {item?.recordCount || 0} {'\u6761'}</p>
              {Number(item?.pendingCount || 0) > 0 && <p className="warning-text">{item.pendingCount} {'\u6761\u4ef7\u683c\u6765\u81ea\u5f85\u786e\u8ba4/\u5f02\u5e38\u53d1\u7968'}</p>}
            </div>
            <ChevronRight />
          </Link>
          );
        })}
      </div>
    </Page>
  );
}

function buildSupplierCompareFromRecords(records = []) {
  const groups = new Map();
  for (const record of safeArray(records)) {
    const key = record?.supplierId || record?.supplierName || 'unknown';
    const group = groups.get(key) || { supplierId: record?.supplierId || '', supplierName: record?.supplierName || '-', prices: [], recentDate: '', recentPrice: 0, count: 0 };
    const price = Number(record?.effectiveUnitCost || record?.unitPrice || record?.price || 0);
    if (price > 0) group.prices.push(price);
    const date = record?.invoiceDate || record?.createdAt || '';
    if (!group.recentDate || String(date).localeCompare(group.recentDate) > 0) {
      group.recentDate = date;
      group.recentPrice = price;
    }
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    supplierId: group.supplierId,
    supplierName: group.supplierName,
    recentPrice: group.recentPrice,
    minPrice: group.prices.length ? Math.min(...group.prices) : 0,
    count: group.count
  }));
}

function ProductDetailPage() {
  const { name } = useParams();
  const decoded = decodeURIComponent(name || '');
  const [detail, setDetail] = useState(null);
  const load = async () => {
    try {
      const response = await api.getProductPriceHistory(decoded);
      const records = apiItems(response);
      setDetail({
        standardName: uiText(decoded),
        records,
        supplierCompare: buildSupplierCompareFromRecords(records)
      });
    } catch (error) {
      console.warn('[products] cloud price history failed, falling back to IndexedDB', error);
      setDetail(await localDb.getProductDetail(decoded));
    }
  };
  useLocalReload(load, [decoded]);
  if (!detail) return <Page title="商品详情"><EmptyState text="暂无记录" /></Page>;
  const records = safeArray(detail.records);
  const supplierCompare = safeArray(detail.supplierCompare);
  return (
    <Page title={detail.standardName || decoded} subtitle="按 productId / normalizedName / alias 匹配历史价格">
      <Section title="供应商价格对比">
        {supplierCompare.length === 0 && <EmptyState text="暂无供应商价格记录" />}
        {supplierCompare.map((row, index) => (
          <div className="detail-item" key={row?.supplierId || row?.supplierName || index}>
            <div className="split"><strong>{row?.supplierName || '-'}</strong><strong>{money(row?.minPrice)}</strong></div>
            <p>最近价格 {money(row?.recentPrice)} · 历史最低 {money(row?.minPrice)} · 记录 {row?.count || 0} 条</p>
          </div>
        ))}
      </Section>
      <Section title="采购记录">
        {records.length === 0 && <EmptyState text="暂无采购记录" />}
        {records.map((record, index) => (
          <div className="detail-item" key={record?.id || index}>
            <div className="split"><strong>{record?.invoiceDate || '-'}</strong><strong>{money(record?.effectiveUnitCost || record?.unitPrice)}</strong></div>
            <p>{record?.supplierName || '-'} · 发票 {record?.invoiceNo || '-'}</p>
            <p>原始名称：{record?.productNameOriginal || '-'}</p>
            <p>数量 {numberText(record?.quantity)} {record?.unit || ''} · 原始单价 {money(record?.unitPrice)} · 实际摊薄成本 {money(record?.effectiveUnitCost || record?.unitPrice)}</p>
            <p>赠品 {Number(record?.isFreeItem || 0) ? '是' : '否'} · 分摊组 {record?.promoGroupName || '-'}</p>
            {record?.invoiceId && <Link to={`/invoices/${record.invoiceId}`}>查看完整发票</Link>}
          </div>
        ))}
      </Section>
    </Page>
  );
}
function SupplierCenterPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const load = () => localDb.searchSupplierCenter(q).then((data) => setRows(safeArray(data)));
  useLocalReload(load, [q]);
  const supplierRows = safeArray(rows);
  return (
    <Page title="供应商查询中心" subtitle="按供应商、电话、联系人、发票号、商品名称搜索">
      <form className="search-bar" onSubmit={(event) => event.preventDefault()}>
        <input placeholder="输入供应商/电话/联系人/发票号/商品名" value={q} onChange={(event) => setQ(event.target.value)} />
        <button type="button"><Search size={18} />搜索</button>
      </form>
      {supplierRows.length === 0 && <EmptyState text="暂无供应商采购数据" />}
      <div className="card-list">
        {supplierRows.map((row, index) => (
          <Link className="row-card" key={row?.id || index} to={`/suppliers/${row?.id || ''}`}>
            <div>
              <h3>{row?.displayName || row?.name || '-'}</h3>
              <p>累计采购 {money(row?.totalAmount)} · 发票 {row?.invoiceCount || 0} 张 · SKU {row?.skuCount || 0}</p>
              <p>最近采购 {row?.lastPurchaseDate || '-'} · 最近金额 {money(row?.lastPurchaseAmount)}</p>
              <p>赠品数量 {numberText(row?.freeQty)} · 折扣 {money(row?.discountAmount)} · 异常 {row?.abnormalInvoiceCount || 0}</p>
            </div>
            <ChevronRight />
          </Link>
        ))}
      </div>
    </Page>
  );
}
function SupplierDetailPage() {
  const { id } = useParams();
  const [detail, setDetail] = useState(null);
  const load = () => localDb.getSupplierDetail(id).then(setDetail);
  useLocalReload(load, [id]);
  if (!detail) return <Page title="供应商详情"><EmptyState text="未找到供应商" /></Page>;
  const { supplier, stats } = detail;
  return (
    <Page title={supplier.displayName || supplier.name} subtitle="供应商采购统计">
      <Section title="基本信息">
        <Info label="联系人" value={supplier.contact || supplier.phone || '-'} />
        <Info label="电话" value={supplier.phone || '-'} />
        <Info label="地址" value={supplier.address || '-'} />
        <Info label="备注" value={supplier.notes || '-'} />
      </Section>
      <Section title="统计信息">
        <Info label="总采购金额" value={money(stats?.totalAmount)} />
        <Info label="总采购数量" value={numberText(stats?.totalQty)} />
        <Info label="总发票数量" value={stats?.invoiceCount || 0} />
        <Info label="平均订单金额" value={money(stats?.averageOrderAmount)} />
        <Info label="最近采购日期" value={stats?.lastPurchaseDate || '-'} />
      </Section>
      <div className="row-actions">
        <Link className="icon-button" to={`/suppliers/${id}/invoices`}>历史发票</Link>
        <Link className="icon-button" to={`/suppliers/${id}/products`}>采购商品</Link>
      </div>
    </Page>
  );
}
function SupplierProductsPage() {
  const { id } = useParams();
  const [sort, setSort] = useState('recent');
  const [rows, setRows] = useState([]);
  const load = () => localDb.getSupplierProducts(id, sort).then(setRows);
  useLocalReload(load, [id, sort]);
  return (
    <Page title="供应商采购商品">
      <Section title="排序">
        <div className="segmented-control">
          {[
            ['recent', '最近采购'],
            ['min', '最低价'],
            ['max', '最高价'],
            ['count', '采购次数'],
            ['qty', '采购数量']
          ].map(([key, label]) => <button key={key} className={sort === key ? 'active' : ''} onClick={() => setSort(key)}>{label}</button>)}
        </div>
      </Section>
      {rows.length === 0 && <EmptyState text="暂无采购商品记录" />}
      {rows.map((row) => (
        <div className="detail-item" key={row.productId || row.productNameNormalized}>
          <div className="split"><strong>{row.productNameNormalized}</strong><strong>{money(row.recentPrice)}</strong></div>
          <p>最低 {money(row.minPrice)} · 最高 {money(row.maxPrice)} · 平均 {money(row.averagePrice)}</p>
          <p>次数 {row.purchaseCount || 0} · 数量 {numberText(row.totalQty)} · 最近 {row.lastPurchaseDate || '-'}</p>
        </div>
      ))}
    </Page>
  );
}
function PurchaseAnalysisPage() {
  const [analytics, setAnalytics] = useState(null);
  const load = () => api.getPurchaseAnalytics()
    .then((data) => setAnalytics(safeObject(data)))
    .catch((error) => {
      console.warn('[analytics] cloud analytics failed, falling back to IndexedDB', error);
      return localDb.getPurchaseAnalytics().then((data) => setAnalytics(safeObject(data)));
    });
  useLocalReload(load);
  if (!analytics) return <Page title="采购分析"><EmptyState text="正在读取本地分析数据" /></Page>;
  const supplierRanking = safeArray(analytics.supplierRanking);
  const productRanking = safeArray(analytics.productRanking);
  const monthly = safeArray(analytics.monthly);
  const lowestPrices = safeArray(analytics.lowestPrices);
  return (
    <Page title="采购分析">
      {(analytics.pendingInvoiceCount > 0 || analytics.abnormalInvoiceCount > 0) && (
        <Section title="待处理数据">
          <p className="warning-text">当前有 {analytics.pendingInvoiceCount || 0} 张待确认发票、{analytics.abnormalInvoiceCount || 0} 张异常发票，确认后会进入正式采购分析。</p>
          <div className="row-actions">
            <Link className="secondary-button" to="/invoices?filter=pending">查看待确认发票</Link>
            <Link className="secondary-button" to="/invoices?filter=abnormal">查看异常发票</Link>
          </div>
        </Section>
      )}
      <Section title="供应商采购排名">
        {supplierRanking.length === 0 && <EmptyState text="暂无供应商采购数据" />}
        {supplierRanking.slice(0, 20).map((row, index) => (
          <div className="detail-item" key={row?.supplierName || index}>
            <div className="split"><strong>{row?.supplierName || '-'}</strong><strong>{money(row?.amount)}</strong></div>
            <p>采购次数 {row?.count || 0} · 平均订单 {money(row?.averageOrderAmount)}</p>
          </div>
        ))}
      </Section>
      <Section title="商品采购排名">
        {productRanking.slice(0, 20).map((row, index) => (
          <div className="detail-item" key={row?.productNameNormalized || row?.productName || index}>
            <div className="split"><strong>{row?.productNameNormalized || row?.productName || '-'}</strong><strong>{numberText(row?.quantity)}</strong></div>
            <p>采购金额 {money(row?.amount)}</p>
          </div>
        ))}
      </Section>
      <Section title="月度采购分析">
        {monthly.map((row, index) => <Info key={row?.month || index} label={row?.month || '-'} value={`${money(row?.amount)} / ${numberText(row?.quantity)}`} />)}
      </Section>
      <Section title="最低采购价分析">
        {lowestPrices.slice(0, 20).map((row, index) => (
          <div className="detail-item" key={`${row?.productNameNormalized || row?.productName || index}-${row?.invoiceId || ''}`}>
            <div className="split"><strong>{row?.productNameNormalized || row?.productName || '-'}</strong><strong>{money(row?.unitPrice)}</strong></div>
            <p>{row?.supplierName || '-'} · {row?.invoiceDate || '-'} · 发票 {row?.invoiceNo || '-'}</p>
          </div>
        ))}
      </Section>
    </Page>
  );
}
function SupplierPage() {
  const [suppliers, setSuppliers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [merging, setMerging] = useState(null);
  const load = () => localDb.getSuppliers().then(setSuppliers);
  useLocalReload(load);
  async function saveSupplier() {
    await localDb.saveSupplier(editing);
    markSyncPending();
    setEditing(null);
    load();
  }
  async function removeSupplier(id) {
    if (!confirm('删除供应商？')) return;
    await localDb.deleteSupplier(id);
    markSyncPending();
    load();
  }
  return (
    <Page title="供应商管理" action={<button className="icon-button" onClick={() => setEditing({ ...emptySupplier })}><Plus size={18} />新增</button>}>
      <div className="card-list">
        {suppliers.length === 0 && <EmptyState text="暂无供应商" />}
        {suppliers.map((supplier) => (
          <div className="row-card" key={supplier.id}>
            <div>
              <h3>{supplier.supplierDisplayName || supplier.displayName || supplier.name}</h3>
              <p>{supplier.phone || '-'} · {supplier.email || '-'}</p>
              {supplier.suspectedDuplicateOf && <p className="warning-text">疑似重复供应商：{supplier.suspectedDuplicateOf}</p>}
            </div>
            <div className="row-actions">
              <Link to={`/suppliers/${supplier.id}`}>详情</Link>
              <Link to={`/suppliers/${supplier.id}/template`}>模板</Link>
              <button type="button" onClick={() => setMerging(supplier)}>合并</button>
              <button type="button" onClick={() => setEditing(supplier)}>编辑</button>
              <button type="button" className="danger-button" onClick={() => removeSupplier(supplier.id)}>删除</button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <Dialog title="供应商" onClose={() => setEditing(null)}>
          {['name', 'displayName', 'supplierNameChinese', 'supplierNameEnglish', 'phone', 'email', 'address', 'notes'].map((field) => (
            <label className="field" key={field}><span>{field}</span><input value={editing[field] || ''} onChange={(event) => setEditing({ ...editing, [field]: event.target.value })} /></label>
          ))}
          <button className="primary-button" onClick={saveSupplier}>保存</button>
        </Dialog>
      )}
      {merging && <MergeSupplierDialog supplier={merging} suppliers={suppliers} onClose={() => setMerging(null)} onMerged={() => { setMerging(null); load(); }} />}
    </Page>
  );
}
function MergeSupplierDialog({ supplier, suppliers, onClose, onMerged }) {
  const [targetId, setTargetId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const options = suppliers.filter((entry) => entry.id !== supplier.id && !entry.mergedIntoSupplierId);
  async function merge() {
    if (!targetId) {
      setMessage('请选择目标供应商');
      return;
    }
    setLoading(true);
    setMessage('合并中...');
    try {
      await localDb.mergeSuppliers(supplier.id, targetId);
      markSyncPending();
      setMessage('✓ 已合并供应商');
      onMerged?.();
    } catch (error) {
      setMessage(error.message || '合并供应商失败');
    } finally {
      setLoading(false);
    }
  }
  return (
    <Dialog title="合并供应商" onClose={onClose}>
      <p>当前供应商：{supplier.supplierDisplayName || supplier.displayName || supplier.name}</p>
      <label className="field">
        <span>目标供应商</span>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="">请选择</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.supplierDisplayName || option.displayName || option.name}</option>)}
        </select>
      </label>
      {message && <p className={message.includes('失败') ? 'error' : 'success-text'}>{message}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={loading} onClick={onClose}>取消</button>
        <button type="button" className="primary-button" disabled={loading} onClick={merge}>{loading ? '合并中...' : '确认合并'}</button>
      </div>
    </Dialog>
  );
}
function SupplierInvoiceHistoryPage() {
  const { id } = useParams();
  const [filters, setFilters] = useState({ invoiceNo: '', startDate: '', endDate: '', minAmount: '', maxAmount: '', hasGift: false, hasDiscount: false, abnormalOnly: false, multiPageOnly: false });
  const [data, setData] = useState({ supplier: null, invoices: [], stats: {} });
  const load = () => localDb.getSupplierInvoiceHistory(id, filters).then(setData);
  useLocalReload(load, [id, filters]);
  const { supplier, invoices, stats: historyStats } = data;
  return (
    <Page title="历史发票" subtitle={supplier?.supplierDisplayName || supplier?.displayName || supplier?.name || '供应商'}>
      <Section title="汇总">
        <Info label="发票数量" value={historyStats.invoiceCount || invoices.length} />
        <Info label="累计采购金额" value={money(historyStats.totalAmount)} />
        <Info label="赠品数量" value={numberText(historyStats.freeQty)} />
        <Info label="折扣金额" value={money(historyStats.discountAmount)} />
      </Section>
      <Section title="筛选">
        <div className="grid-2">
          <label className="field"><span>发票号</span><input value={filters.invoiceNo} onChange={(event) => setFilters({ ...filters, invoiceNo: event.target.value })} /></label>
          <label className="field"><span>开始日期</span><input type="date" value={filters.startDate} onChange={(event) => setFilters({ ...filters, startDate: event.target.value })} /></label>
          <label className="field"><span>结束日期</span><input type="date" value={filters.endDate} onChange={(event) => setFilters({ ...filters, endDate: event.target.value })} /></label>
          <label className="field"><span>最小金额</span><input type="number" value={filters.minAmount} onChange={(event) => setFilters({ ...filters, minAmount: event.target.value })} /></label>
          <label className="field"><span>最大金额</span><input type="number" value={filters.maxAmount} onChange={(event) => setFilters({ ...filters, maxAmount: event.target.value })} /></label>
        </div>
      </Section>
      {invoices.length === 0 && <EmptyState text="暂无历史发票" />}
      {invoices.map((invoice) => (
        <Link className="row-card" key={invoice.id} to={`/invoices/${invoice.id}`}>
          <div>
            <h3>{invoice.invoiceNo || '-'} · {invoice.invoiceDate || '-'}</h3>
            <p>金额 {money(invoice.totalAmount)} · 商品 {invoice.itemCount || 0} · 赠品 {numberText(invoice.freeQty)} · 折扣 {money(invoice.discountAmount)}</p>
            <p>{invoiceStatusLabel(invoice)} · {sourceLabel(invoice.recognitionSource)}</p>
          </div>
          <ChevronRight />
        </Link>
      ))}
    </Page>
  );
}
function AccountConnectionPage() {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState([]);
  const [sent, setSent] = useState([]);
  const [received, setReceived] = useState([]);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');

  async function searchUsers(event) {
    event.preventDefault();
    setNotice('');
    try {
      const data = await api.searchUsers(keyword);
      setResults(data.users || []);
    } catch (error) {
      setNotice(error.message || '搜索失败');
    }
  }

  async function loadRequests() {
    try {
      const [sentData, receivedData] = await Promise.all([api.getSentConnections(), api.getReceivedConnections()]);
      setSent(sentData.requests || []);
      setReceived(receivedData.requests || []);
    } catch (error) {
      setNotice(error.message || '读取申请失败');
    }
  }

  useEffect(() => { loadRequests(); }, []);

  async function requestConnection(targetUserId) {
    try {
      await api.requestAccountConnection({ targetUserId, message });
      setNotice('连接申请已发送');
      setMessage('');
      await loadRequests();
    } catch (error) {
      setNotice(error.message || '发送申请失败');
    }
  }

  async function decide(id, action) {
    try {
      if (action === 'approve') await api.approveConnection(id);
      if (action === 'reject') await api.rejectConnection(id);
      setNotice(action === 'approve' ? '已同意申请' : '已拒绝申请');
      await loadRequests();
    } catch (error) {
      setNotice(error.message || '处理申请失败');
    }
  }

  return (
    <Page title="账户连接">
      <Section title="搜索账户">
        <form className="search-bar" onSubmit={searchUsers}>
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="邮箱、用户名、公司名" />
          <button type="submit"><Search size={18} />搜索</button>
        </form>
        <label className="field"><span>申请备注</span><input value={message} onChange={(event) => setMessage(event.target.value)} /></label>
        {notice && <p className={notice.includes('失败') ? 'error' : 'success-text'}>{notice}</p>}
        {results.map((user) => (
          <div className="row-card" key={user.id}>
            <div><h3>{user.username || user.email}</h3><p>{user.email} · {user.companyName || '-'}</p></div>
            <button type="button" onClick={() => requestConnection(user.id)}>申请连接</button>
          </div>
        ))}
      </Section>
      <ConnectionList title="我发出的申请" requests={sent} direction="sent" />
      <ConnectionList title="收到的申请" requests={received} direction="received" onDecide={decide} />
    </Page>
  );
}

function ConnectionList({ title, requests, direction, onDecide }) {
  return (
    <Section title={title}>
      {requests.length === 0 && <EmptyState text="暂无申请" />}
      {requests.map((request) => (
        <div className="row-card" key={request.id}>
          <div>
            <h3>{direction === 'sent' ? request.targetUser?.email : request.requesterUser?.email}</h3>
            <p>{connectionStatusLabel(request.status)} · {request.message || '-'}</p>
          </div>
          {direction === 'received' && request.status === 'pending' && (
            <div className="row-actions">
              <button type="button" onClick={() => onDecide?.(request.id, 'approve')}>同意</button>
              <button type="button" className="danger-button" onClick={() => onDecide?.(request.id, 'reject')}>拒绝</button>
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}
function connectionStatusLabel(status) {
  if (status === 'approved') return '已同意';
  if (status === 'rejected') return '已拒绝';
  return '待处理';
}

function MemberManagementPanel() {
  const [members, setMembers] = useState([]);
  const [message, setMessage] = useState('');
  const [editingMember, setEditingMember] = useState(null);
  const [resetMember, setResetMember] = useState(null);
  async function loadMembers() {
    try {
      const data = await (api.getAdminMembers ? api.getAdminMembers() : api.getMembers());
      setMembers(safeArray(data?.members));
    } catch (error) {
      setMessage(error.message || '读取成员失败');
    }
  }
  useEffect(() => { loadMembers(); }, []);
  async function saveMember(payload) {
    try {
      if (payload.id) await (api.updateAdminMember || api.updateMember)(payload.id, payload);
      else await (api.createAdminMember || api.createMember)(payload);
      setEditingMember(null);
      setMessage('成员已保存');
      await loadMembers();
    } catch (error) {
      setMessage(error.message || '保存成员失败');
    }
  }
  async function resetPassword(id, password) {
    try {
      await (api.resetAdminMemberPassword || api.resetMemberPassword)(id, password);
      setResetMember(null);
      setMessage('密码已重置');
    } catch (error) {
      setMessage(error.message || '重置密码失败');
    }
  }
  async function toggleStatus(member, enabled) {
    try {
      if (enabled) await (api.enableAdminMember || api.enableMember)(member.id);
      else await (api.disableAdminMember || api.disableMember)(member.id);
      await loadMembers();
    } catch (error) {
      setMessage(error.message || '修改状态失败');
    }
  }
  async function removeMember(member) {
    if (!confirm('确认删除/停用该成员？')) return;
    try {
      await (api.deleteAdminMember || api.deleteMember)(member.id);
      await loadMembers();
    } catch (error) {
      setMessage(error.message || '删除成员失败');
    }
  }
  return (
    <Section title="成员管理">
      {message && <p className={message.includes('失败') ? 'error' : 'success-text'}>{message}</p>}
      <button className="primary-button" type="button" onClick={() => setEditingMember({ role: 'sales', status: 'active' })}>新增成员</button>
      <div className="card-list">
        {members.map((member) => (
          <div className="row-card" key={member.id}>
            <div>
              <h3>{member.name || member.username || member.email}</h3>
              <p>{member.email} · {memberRoleLabel(member.role)} · {memberStatusLabel(member.status)}</p>
              <p>最后登录 {member.lastLoginAt || '-'} · 创建 {member.createdAt || '-'}</p>
            </div>
            <div className="row-actions">
              <button type="button" onClick={() => setEditingMember(member)}>编辑</button>
              <button type="button" onClick={() => setResetMember(member)}>重置密码</button>
              {member.status === 'disabled'
                ? <button type="button" onClick={() => toggleStatus(member, true)}>启用</button>
                : <button type="button" onClick={() => toggleStatus(member, false)}>禁用</button>}
              <button type="button" className="danger-button" onClick={() => removeMember(member)}>删除</button>
            </div>
          </div>
        ))}
      </div>
      {editingMember && <MemberDialog member={editingMember} onClose={() => setEditingMember(null)} onSave={saveMember} />}
      {resetMember && <ResetPasswordDialog member={resetMember} onClose={() => setResetMember(null)} onSave={resetPassword} />}
    </Section>
  );
}

function MemberDialog({ member, onClose, onSave }) {
  const [form, setForm] = useState(() => ({ role: 'sales', status: 'active', ...member, password: '' }));
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  return (
    <Dialog title={form.id ? '编辑成员' : '新增成员'} onClose={onClose}>
      <label className="field"><span>姓名</span><input value={form.name || ''} onChange={(event) => update('name', event.target.value)} /></label>
      <label className="field"><span>邮箱</span><input value={form.email || ''} onChange={(event) => update('email', event.target.value)} /></label>
      {!form.id && <label className="field"><span>初始密码</span><input type="password" value={form.password || ''} onChange={(event) => update('password', event.target.value)} /></label>}
      <label className="field"><span>角色</span><select value={form.role || 'sales'} onChange={(event) => update('role', event.target.value)}><option value="admin">管理员</option><option value="sales">销售员</option></select></label>
      <label className="field"><span>状态</span><select value={form.status || 'active'} onChange={(event) => update('status', event.target.value)}><option value="active">启用</option><option value="disabled">禁用</option></select></label>
      <label className="field"><span>电话</span><input value={form.phone || ''} onChange={(event) => update('phone', event.target.value)} /></label>
      <label className="field"><span>备注</span><input value={form.note || ''} onChange={(event) => update('note', event.target.value)} /></label>
      <div className="dialog-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary-button" onClick={() => onSave(form)}>保存</button></div>
    </Dialog>
  );
}

function ResetPasswordDialog({ member, onClose, onSave }) {
  const [password, setPassword] = useState('');
  return (
    <Dialog title="重置密码" onClose={onClose}>
      <p>{member.email}</p>
      <label className="field"><span>新密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <div className="dialog-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary-button" onClick={() => onSave(member.id, password)}>保存</button></div>
    </Dialog>
  );
}

function memberRoleLabel(role) {
  if (role === 'admin' || role === 'super_admin') return '管理员';
  return '销售员';
}

function memberStatusLabel(status) {
  return status === 'disabled' ? '禁用' : '启用';
}
function SettingsPage() {
  const session = getAuthSession();
  const [stats, setStats] = useState({});
  const [diagnostics, setDiagnostics] = useState(null);
  const [syncSnapshot, setSyncSnapshot] = useState({ label: '\u2601 \u5df2\u540c\u6b65', pendingCount: 0, pendingByTable: {}, lastSyncAt: '', lastError: '', syncing: false });
  const [pendingDetails, setPendingDetails] = useState([]);
  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const load = async () => {
    const [nextStats, nextSnapshot, nextDiagnostics, nextPendingDetails] = await Promise.all([
      localDb.getStats(),
      getSyncSnapshot(),
      localDb.getLocalDiagnostics(),
      localDb.getPendingDebugDetails()
    ]);
    setStats(nextStats);
    setSyncSnapshot(nextSnapshot);
    setDiagnostics(nextDiagnostics);
    setPendingDetails(nextPendingDetails);
  };
  useLocalReload(load);
  useEffect(() => {
    const handler = () => getSyncSnapshot().then(setSyncSnapshot);
    window.addEventListener('sync-state-change', handler);
    return () => window.removeEventListener('sync-state-change', handler);
  }, []);
  async function handleSettingsSyncNow() {
    setSyncing(true);
    setMessage('\u540c\u6b65\u4e2d...');
    try {
      const result = await syncNow({ force: true, reason: 'settings' });
      const latest = await getSyncSnapshot();
      setSyncSnapshot(latest);
      setMessage(latest.lastError
        ? `\u540c\u6b65\u5931\u8d25\uff1a${latest.lastError}`
        : (latest.diagnostic?.pushError || '\u540c\u6b65\u5b8c\u6210'));
      await load();
      return result;
    } catch (error) {
      setMessage(error.message || '\u540c\u6b65\u5931\u8d25');
    } finally {
      setSyncing(false);
    }
  }
  async function restoreCloud() {
    setSyncing(true);
    setMessage('\u6b63\u5728\u4ece\u4e91\u7aef\u6062\u590d...');
    try {
      await pullFromCloud({ full: true });
      setMessage('\u5df2\u4ece\u4e91\u7aef\u6062\u590d\u8d44\u6599');
      await load();
    } catch (error) {
      setMessage(error.message || '\u4ece\u4e91\u7aef\u6062\u590d\u5931\u8d25');
    } finally {
      setSyncing(false);
    }
  }
  async function clearLocalAndRestore() {
    if (!confirm('\u786e\u8ba4\u6e05\u7a7a\u672c\u5730\u7f13\u5b58\u540e\u91cd\u65b0\u62c9\u53d6\u4e91\u7aef\u6570\u636e\uff1f')) return;
    await localDb.clearAllLocalData();
    await restoreCloud();
  }
  async function clearSyncedPendingStatus() {
    setSyncing(true);
    setMessage('\u6b63\u5728\u6e05\u9664\u5df2\u6210\u529f\u540c\u6b65\u7684 pending \u72b6\u6001...');
    try {
      const result = await clearLastSyncedPendingRecords();
      await load();
      setMessage(`\u5df2\u5904\u7406 ${result.applied}/${result.total} \u6761\uff0c\u5269\u4f59\u5f85\u540c\u6b65 ${result.pendingCount} \u6761`);
    } catch (error) {
      setMessage(error.message || '\u6e05\u9664 pending \u72b6\u6001\u5931\u8d25');
    } finally {
      setSyncing(false);
    }
  }
  async function clearData() {
    if (!confirm('\u786e\u8ba4\u6e05\u7a7a\u672c\u5730\u6d4b\u8bd5\u6570\u636e\u5e76\u540c\u6b65\u5220\u9664\u5230\u4e91\u7aef\uff1f')) return;
    await localDb.softDeleteAll();
    markSyncPending();
    load();
  }
  async function exportCloudExcel() {
    try {
      const blob = await api.exportCloudExcel();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `invoice-cloud-export-${Date.now()}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error.message || '\u5bfc\u51fa\u4e91\u7aef Excel \u5931\u8d25');
    }
  }
  const apiDebug = getLastApiDebug();
  const diagnosticCounts = diagnostics?.counts || {};
  const syncDiagnostic = syncSnapshot.diagnostic || {};
  return (
    <Page title={'\u8bbe\u7f6e/\u540c\u6b65'}>
      <Section title={'\u540c\u6b65\u4e2d\u5fc3'}>
        <Info label={'\u540c\u6b65\u72b6\u6001'} value={syncSnapshot.label} />
        <Info label={'\u5f85\u540c\u6b65\u603b\u6570'} value={syncSnapshot.pendingCount || 0} />
        <Info label={'\u5f85\u540c\u6b65\u53d1\u7968'} value={syncSnapshot.pendingByTable?.invoices || 0} />
        <Info label={'\u5f85\u540c\u6b65\u5546\u54c1\u660e\u7ec6'} value={syncSnapshot.pendingByTable?.invoice_items || 0} />
        <Info label={'\u5f85\u540c\u6b65\u5546\u54c1'} value={syncSnapshot.pendingByTable?.products || 0} />
        <Info label={'\u5f85\u540c\u6b65\u4ef7\u683c\u5386\u53f2'} value={syncSnapshot.pendingByTable?.price_history || 0} />
        <Info label={'\u6700\u540e\u540c\u6b65\u65f6\u95f4'} value={syncSnapshot.lastSyncAt || '-'} />
        <Info label={'\u6700\u8fd1\u9519\u8bef'} value={syncSnapshot.lastError || syncDiagnostic.error || syncDiagnostic.pushError || '\u65e0'} />
        <div className="row-actions">
          <button className="primary-button" disabled={syncing || syncSnapshot.syncing} onClick={handleSettingsSyncNow}><RefreshCw size={16} />{syncing || syncSnapshot.syncing ? '\u540c\u6b65\u4e2d...' : '\u7acb\u5373\u540c\u6b65'}</button>
          <button type="button" disabled={syncing} onClick={restoreCloud}>{'\u4ece\u4e91\u7aef\u6062\u590d'}</button>
          <button type="button" disabled={syncing} onClick={clearLocalAndRestore}>{'\u6e05\u7a7a\u672c\u5730\u7f13\u5b58\u540e\u91cd\u65b0\u62c9\u53d6'}</button>
          <button type="button" disabled={syncing} onClick={clearSyncedPendingStatus}>{'\u6e05\u9664\u5df2\u6210\u529f\u540c\u6b65\u7684 pending \u72b6\u6001'}</button>
        </div>
        <p className={(message || syncSnapshot.lastError || syncSnapshot.diagnostic?.error || '').includes('\u5931\u8d25') || syncSnapshot.lastError || syncSnapshot.diagnostic?.error ? 'error' : 'success-text'}>{message || syncSnapshot.lastError || syncSnapshot.diagnostic?.error || syncSnapshot.diagnostic?.pushError || syncSnapshot.label || '\u2601 \u5df2\u540c\u6b65'}</p>
      </Section>
      <Section title={'\u540c\u6b65\u8bca\u65ad'}>
        <Info label="userId" value={session?.user?.id || '-'} />
        <Info label="companyId" value={session?.company?.id || session?.user?.companyId || '-'} />
        <Info label="companyName" value={displayCompanyName(session)} />
        <Info label="token" value={session?.token ? '\u5b58\u5728' : '\u65e0'} />
        <Info label="syncState" value={syncSnapshot.syncing ? 'syncing' : (syncSnapshot.lastError || syncDiagnostic.error ? 'failed' : 'idle')} />
        <Info label="lastSyncAt" value={syncSnapshot.lastSyncAt || '-'} />
        <Info label="lastError" value={syncSnapshot.lastError || syncDiagnostic.error || '-'} />
        <Info label="IndexedDB products" value={diagnosticCounts.products ?? '-'} />
        <Info label="IndexedDB invoice_items" value={diagnosticCounts.invoice_items ?? '-'} />
        <Info label="IndexedDB price_history" value={diagnosticCounts.price_history ?? '-'} />
        <Info label="pendingPush" value={syncSnapshot.pendingCount ?? diagnostics?.pendingCount ?? 0} />
        <Info label="failedItems" value={diagnostics?.failedCount ?? syncSnapshot.failedCount ?? 0} />
        <Info label="last pull count" value={syncDiagnostic.pullCount ?? '-'} />
        <Info label="last push count" value={syncDiagnostic.pushCount ?? '-'} />
        <Info label="last API status" value={apiDebug?.status ?? '-'} />
        <p className="long-text">last API error: {apiDebug?.error || '-'}</p>
        {pendingDetails.length > 0 && (
          <details className="debug-box">
            <summary>{'\u67e5\u770b\u5f85\u540c\u6b65\u9879\u76ee'} ({pendingDetails.length})</summary>
            {pendingDetails.slice(0, 30).map((item, index) => (
              <div className="info-row" key={`${item.table}-${item.id || item.localId || index}`}>
                <span>{item.table}</span>
                <strong className="long-text">
                  {item.id || item.localId || item.serverId || '-'} / {item.invoiceId || '-'} / {item.syncStatus || '-'} / {item.error || item.syncError || '-'}
                </strong>
              </div>
            ))}
          </details>
        )}
      </Section>
      <MemberManagementPanel />
      <Section title={'\u6570\u636e\u5e93\u7edf\u8ba1'}>
        {Object.entries(safeObject(stats)).map(([key, value]) => <Info key={key} label={key} value={value} />)}
      </Section>
      <Section title={'\u5bfc\u51fa/\u7ef4\u62a4'}>
        <div className="row-actions">
          <button onClick={exportCloudExcel}>{'\u5bfc\u51fa\u4e91\u7aef Excel'}</button>
          <button className="danger-button" onClick={clearData}>{'\u6e05\u7a7a\u6d4b\u8bd5\u6570\u636e'}</button>
        </div>
      </Section>
    </Page>
  );
}

function SupplierDialog({ supplier, onClose, onSave }) {
  const [form, setForm] = useState(supplier);
  return (
    <Dialog title="编辑供应商" onClose={onClose}>
      {['supplierNameChinese', 'supplierNameEnglish', 'supplierDisplayName', 'name', 'displayName', 'normalizedName', 'aliases', 'contactName', 'phone', 'email', 'address', 'notes'].map((field) => {
        const labels = { supplierNameChinese: '中文公司名', supplierNameEnglish: '英文公司名', supplierDisplayName: '显示名称', name: '名称', displayName: '旧显示名称', normalizedName: '标准化名称', aliases: '别名', contactName: '联系人', phone: '电话', email: '邮箱', address: '地址', notes: '备注' };
        return <label className="field" key={field}><span>{labels[field]}</span><input value={form[field] || ''} onChange={(event) => setForm({ ...form, [field]: event.target.value })} /></label>;
      })}
      <button className="primary-button" onClick={() => onSave(form)}>保存</button>
    </Dialog>
  );
}

function TemplateDialog({ supplier, onClose }) {
  const [form, setForm] = useState(supplier.template || {});
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  async function save() {
    await localDb.saveSupplierTemplate({ ...form, supplierId: supplier.id });
    markSyncPending();
    onClose();
  }
  return (
    <Dialog title="供应商模板" onClose={onClose}>
      {['supplierNameKeywords', 'invoiceNoKeywords', 'dateKeywords', 'itemTableStartKeywords', 'itemTableEndKeywords'].map((field) => (
        <label className="field" key={field}><span>{field}</span><input value={form[field] || ''} onChange={(event) => update(field, event.target.value)} /></label>
      ))}
      {['itemNameColumnIndex', 'quantityColumnIndex', 'unitColumnIndex', 'unitPriceColumnIndex', 'totalPriceColumnIndex'].map((field) => (
        <label className="field" key={field}><span>{field}</span><input type="number" value={form[field] || 0} onChange={(event) => update(field, event.target.value)} /></label>
      ))}
      <button className="primary-button" onClick={save}>保存模板</button>
    </Dialog>
  );
}
function Page({ title, subtitle, action, children }) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{uiText(title)}</h1>
          {subtitle && <p>{uiText(subtitle)}</p>}
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}

function Section({ title, children }) {
  return <section className="section"><h2>{uiText(title)}</h2>{children}</section>;
}

function CollapsibleSection({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="section">
      <button type="button" className="collapsible-toggle" onClick={() => setOpen((value) => !value)}>
        <span>{uiText(title)}</span>
        <span>{uiText(open ? '\u6536\u8d77' : '\u5c55\u5f00')}</span>
      </button>
      {open && <div className="collapsible-content">{children}</div>}
    </section>
  );
}

function ActionLink({ to, icon, title, subtitle }) {
  return (
    <Link className="action-row" to={to}>
      <span className="action-icon">{icon}</span>
      <span><strong>{uiText(title)}</strong><small>{uiText(subtitle)}</small></span>
      <ChevronRight />
    </Link>
  );
}

function InvoiceImageViewer({ invoice, onUpdated }) {
  const [imageUrl, setImageUrl] = useState('');
  const [imageStatus, setImageStatus] = useState('idle');
  const [diagnostic, setDiagnostic] = useState({
    invoiceId: '',
    imageStatus: 'idle',
    localImageKey: '',
    hasCloudImageUrl: false,
    localExists: false,
    fileSize: 0,
    source: '-',
    errorReason: ''
  });
  const [showDebug, setShowDebug] = useState(false);
  const [reuploading, setReuploading] = useState(false);
  const fileRef = useRef(null);

  const imageKey = [
    invoice?.id,
    invoice?.serverId,
    invoice?.localId,
    invoice?.imageId,
    invoice?.localImageKey,
    invoice?.imagePath,
    invoice?.cloudImageUrl,
    invoice?.imageUrl,
    invoice?.originalImageUrl
  ].filter(Boolean).join('|');

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';

    async function loadImage() {
      setImageStatus('loading');
      setImageUrl('');
      setDiagnostic({
        invoiceId: invoice?.id || invoice?.serverId || invoice?.localId || '',
        imageStatus: 'loading',
        localImageKey: invoice?.localImageKey || invoice?.imageId || String(invoice?.imagePath || '').replace(/^indexeddb:/, ''),
        hasCloudImageUrl: Boolean(invoice?.cloudImageUrl),
        localExists: false,
        fileSize: Number(invoice?.fileSize || 0),
        source: '-',
        errorReason: ''
      });

      try {
        const check = await localDb.verifyInvoiceImage(invoice);
        if (cancelled) return;
        const resource = check.resource || {};
        const baseDiagnostic = {
          invoiceId: invoice?.id || invoice?.serverId || invoice?.localId || resource.invoiceId || '',
          imageStatus: check.status || resource.imageStatus || 'missing',
          localImageKey: resource.localImageKey || invoice?.localImageKey || invoice?.imageId || String(invoice?.imagePath || '').replace(/^indexeddb:/, ''),
          hasCloudImageUrl: Boolean(resource.cloudImageUrl || invoice?.cloudImageUrl),
          localExists: Boolean(check.image?.imageBlob),
          fileSize: Number(resource.fileSize || check.image?.fileSize || check.image?.size || invoice?.fileSize || 0),
          source: resource.storageType === 'indexeddb' || check.image?.imageBlob ? 'Local / IndexedDB' : (resource.cloudImageUrl ? 'Cloud' : 'Server'),
          errorReason: check.message || resource.errorReason || ''
        };

        if (check.image?.imageBlob) {
          objectUrl = URL.createObjectURL(check.image.imageBlob);
          setImageUrl(objectUrl);
          setImageStatus('loading');
          setDiagnostic({ ...baseDiagnostic, imageStatus: check.status || 'local', localExists: true });
          return;
        }

        const cloudUrl = resource.cloudImageUrl || invoice?.cloudImageUrl || '';
        const serverPath = String(invoice?.imageUrl || invoice?.originalImageUrl || invoice?.imagePath || '');
        if (cloudUrl) {
          setImageUrl(cloudUrl);
          setImageStatus('loading');
          setDiagnostic({ ...baseDiagnostic, source: 'Cloud', imageStatus: 'uploaded' });
          return;
        }
        if (serverPath && !serverPath.startsWith('indexeddb:') && !serverPath.startsWith('blob:') && !serverPath.startsWith('data:image')) {
          setImageUrl(api.fileUrl(serverPath));
          setImageStatus('loading');
          setDiagnostic({ ...baseDiagnostic, source: 'Server', imageStatus: 'loading' });
          return;
        }

        setImageUrl('');
        setImageStatus('missing');
        setDiagnostic({
          ...baseDiagnostic,
          imageStatus: 'missing',
          source: baseDiagnostic.source || 'Local / IndexedDB',
          errorReason: check.message || '\u672c\u5730\u56fe\u7247\u5df2\u4e22\u5931\uff0c\u8bf7\u91cd\u65b0\u7ed1\u5b9a\u56fe\u7247\u3002'
        });
      } catch (error) {
        if (!cancelled) {
          setImageUrl('');
          setImageStatus('error');
          setDiagnostic((current) => ({
            ...current,
            imageStatus: 'failed',
            errorReason: error.message || '\u56fe\u7247\u8bfb\u53d6\u5931\u8d25'
          }));
        }
      }
    }

    loadImage();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageKey]);

  async function rebindImage(file) {
    if (!file || !invoice?.id) return;
    setReuploading(true);
    try {
      const image = await localDb.saveInvoiceImage(file, { invoiceId: invoice.id, source: 'invoice-rebind' });
      await localDb.updateInvoiceImageFields(invoice.id, {
        imageId: image.id,
        imagePath: `indexeddb:${image.localImageKey || image.id}`,
        localImageKey: image.localImageKey || image.id,
        imageStatus: 'local',
        storageType: 'indexeddb',
        originalFileName: image.originalFileName || file.name || '',
        fileSize: image.fileSize || file.size || 0
      });
      markSyncPending();
      await onUpdated?.();
    } catch (error) {
      setImageUrl('');
      setImageStatus('error');
      setDiagnostic((current) => ({
        ...current,
        imageStatus: 'failed',
        errorReason: error.message || '\u91cd\u65b0\u7ed1\u5b9a\u56fe\u7247\u5931\u8d25'
      }));
    } finally {
      setReuploading(false);
    }
  }

  const statusLabel = {
    idle: '\u7b49\u5f85\u52a0\u8f7d',
    loading: '\u52a0\u8f7d\u4e2d',
    loaded: '\u5df2\u52a0\u8f7d',
    local: '\u672c\u5730\u53ef\u7528',
    uploaded: '\u4e91\u7aef\u53ef\u7528',
    missing: '\u672c\u5730\u56fe\u7247\u5df2\u4e22\u5931',
    error: '\u52a0\u8f7d\u5931\u8d25',
    failed: '\u8bfb\u53d6\u5931\u8d25'
  }[imageStatus] || diagnostic.imageStatus || imageStatus;

  return (
    <div className="invoice-image-viewer">
      <div className="row-actions">
        <button type="button" onClick={() => fileRef.current?.click()} disabled={reuploading}>{reuploading ? '\u7ed1\u5b9a\u4e2d...' : '\u91cd\u65b0\u7ed1\u5b9a\u56fe\u7247'}</button>
        <button type="button" onClick={() => setShowDebug((value) => !value)}>{showDebug ? '\u9690\u85cf\u8bca\u65ad\u4fe1\u606f' : '\u663e\u793a\u8bca\u65ad\u4fe1\u606f'}</button>
      </div>
      <input ref={fileRef} className="hidden-file-input" type="file" accept="image/*" onChange={(event) => { rebindImage(event.target.files?.[0]); event.target.value = ''; }} />
      <p className="hint image-diagnostics">{'\u56fe\u7247\u6765\u6e90\uff1a'}{diagnostic.source || '-'} / {'\u56fe\u7247\u5927\u5c0f\uff1a'}{formatBytes(diagnostic.fileSize)} / {'\u56fe\u7247\u72b6\u6001\uff1a'}{statusLabel}</p>
      {imageUrl && imageStatus !== 'missing' && imageStatus !== 'error' && (
        <img
          className="invoice-full-image"
          src={imageUrl}
          alt={'\u53d1\u7968\u539f\u56fe'}
          onLoad={() => {
            setImageStatus('loaded');
            setDiagnostic((current) => ({ ...current, imageStatus: current.imageStatus === 'uploaded' ? 'uploaded' : 'local', localExists: current.source !== 'Server' || current.localExists }));
          }}
          onError={() => {
            setImageUrl('');
            setImageStatus('error');
            setDiagnostic((current) => ({
              ...current,
              imageStatus: 'failed',
              errorReason: current.source === 'Server' || current.source === 'Cloud'
                ? '\u670d\u52a1\u5668\u56fe\u7247\u4e0d\u53ef\u7528\uff0c\u8bf7\u91cd\u65b0\u7ed1\u5b9a\u672c\u5730\u56fe\u7247\u3002'
                : '\u56fe\u7247\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u91cd\u65b0\u7ed1\u5b9a\u56fe\u7247\u3002'
            }));
          }}
        />
      )}
      {imageStatus === 'missing' && <p className="warning-text">{'\u672c\u5730\u56fe\u7247\u5df2\u4e22\u5931\uff0c\u8bf7\u91cd\u65b0\u7ed1\u5b9a\u56fe\u7247\u3002\u53d1\u7968\u6570\u636e\u3001AI \u8bc6\u522b\u7ed3\u679c\u548c\u5546\u54c1\u660e\u7ec6\u4ecd\u53ef\u67e5\u770b\u3002'}</p>}
      {imageStatus === 'error' && <p className="error">{diagnostic.errorReason || '\u56fe\u7247\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u91cd\u65b0\u7ed1\u5b9a\u56fe\u7247\u3002'}</p>}
      {showDebug && (
        <div className="debug-box">
          <Info label="invoiceId" value={diagnostic.invoiceId || '-'} />
          <Info label="imageStatus" value={diagnostic.imageStatus || imageStatus || '-'} />
          <Info label="localImageKey" value={diagnostic.localImageKey || '-'} />
          <Info label="cloudImageUrl" value={diagnostic.hasCloudImageUrl ? '\u5b58\u5728' : '\u65e0'} />
          <Info label={'\u672c\u5730\u56fe\u7247'} value={diagnostic.localExists ? '\u5b58\u5728' : '\u4e0d\u5b58\u5728'} />
          <Info label={'\u6587\u4ef6\u5927\u5c0f'} value={formatBytes(diagnostic.fileSize)} />
          <p className="long-text">{'\u9519\u8bef\u539f\u56e0\uff1a'}{diagnostic.errorReason || '-'}</p>
          <p className="long-text">imagePath: {invoice?.imagePath || '-'}</p>
        </div>
      )}
    </div>
  );
}

function Info({ label, value }) {
  return <div className="info-row"><span>{uiText(label)}</span><strong>{uiText(value)}</strong></div>;
}

function Metric({ label, value, to }) {
  const content = <><span>{uiText(label)}</span><strong>{uiText(value)}</strong></>;
  if (to) return <Link className="metric-card metric-link" to={to}>{content}</Link>;
  return <div className="metric-card">{content}</div>;
}

function SwitchField({ label, checked, onChange }) {
  return (
    <label className="switch-field">
      <span>{uiText(label)}</span>
      <button type="button" className={`ios-switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} aria-pressed={checked}>
        <span />
      </button>
    </label>
  );
}

function ConfidenceSummary({ parsed = {} }) {
  const fields = [
    ['供应商', parsed.supplierConfidence],
    ['发票号', parsed.invoiceNoConfidence],
    ['日期', parsed.dateConfidence],
    ['商品', parsed.itemConfidence],
    ['价格', parsed.priceConfidence]
  ];
  const lowFields = fields.filter(([, value]) => Number(value ?? 1) < 0.7);
  return (
    <div>
      {lowFields.length > 0 && <p className="warning-text">低置信度字段：{lowFields.map(([label, value]) => `${label} ${Number(value || 0).toFixed(2)}`).join('，')}，请重点检查。</p>}
      {Number(parsed.totalDifference || 0) > 0.05 && <p className="warning-text">商品明细与发票总额不一致，请检查。差额：{money(parsed.totalDifference)}</p>}
    </div>
  );
}
function EmptyState({ text }) {
  return <div className="empty-state">{uiText(text)}</div>;
}

function Dialog({ title, onClose, children }) {
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog">
        <div className="dialog-header"><h2>{uiText(title)}</h2><button onClick={onClose}>{uiText('\u5173\u95ed')}</button></div>
        {children}
      </div>
    </div>
  );
}

function BottomNav() {
  const labels = {
    home: '\u9996\u9875',
    invoices: '\u53d1\u7968',
    purchase: '\u91c7\u8d2d',
    search: '\u67e5\u8be2',
    analytics: '\u5206\u6790',
    settings: '\u8bbe\u7f6e'
  };
  const items = [
    ['/', Home, labels.home],
    ['/invoices', FileText, labels.invoices],
    ['/supplier-center', Building2, labels.purchase],
    ['/products', Search, labels.search],
    ['/analytics', BarChart3, labels.analytics],
    ['/settings', Settings, labels.settings]
  ];
  return (
    <nav className="bottom-nav">
      {items.map(([to, Icon, label]) => (
        <NavLink key={to} to={to} end={to === '/'}>
          <Icon size={20} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function useLocalReload(loader, deps = [], options = {}) {
  useEffect(() => {
    let cancelled = false;
    const listenToEvents = options.listenToEvents !== false;
    const run = () => {
      try {
        return Promise.resolve(loader()).catch((error) => {
          recordPageError(error, { componentStack: 'useLocalReload' }, 'loader');
        }).then(() => undefined);
      } catch (error) {
        recordPageError(error, { componentStack: 'useLocalReload' }, 'loader');
        return Promise.resolve();
      }
    };
    const guardedRun = () => {
      if (!cancelled) run();
    };
    guardedRun();
    if (listenToEvents) {
      window.addEventListener('local-db-change', guardedRun);
      window.addEventListener('sync-state-change', guardedRun);
    }
    return () => {
      cancelled = true;
      if (listenToEvents) {
        window.removeEventListener('local-db-change', guardedRun);
        window.removeEventListener('sync-state-change', guardedRun);
      }
    };
  }, deps);
}

function statusText(status) {
  if (status === 'pending') return '待同步';
  if (status === 'deleted') return '待删除同步';
  if (status === 'conflict') return '同步冲突';
  if (status === 'needs_review') return '待确认';
  if (status === 'duplicate') return '重复发票';
  if (status === 'failed') return '同步失败';
  return '已同步';
}

function isDuplicateInvoice(invoice = {}) {
  return ['duplicate', 'confirmed'].includes(String(invoice.duplicateStatus || '').toLowerCase())
    || String(invoice.status || '').toUpperCase() === 'DUPLICATE';
}

function isConflictInvoice(invoice = {}) {
  return String(invoice.syncStatus || '').toLowerCase() === 'conflict'
    || String(invoice.status || '').toUpperCase() === 'CONFLICT';
}

function isPossibleMultiPageInvoice(invoice = {}) {
  const reason = `${invoice.reason || ''} ${invoice.syncNote || ''} ${invoice.recognitionWarnings || ''}`.toUpperCase();
  return Boolean(invoice.sameInvoiceGroup || invoice.possibleSameInvoicePages || reason.includes('MULTI_PAGE'));
}

function filterLabel(filter) {
  return {
    pending: '待确认发票',
    abnormal: '异常发票',
    duplicate: '重复发票',
    conflict: '同步冲突',
    multipage: '疑似多页'
  }[filter] || filter;
}

function isConfirmedInvoice(invoice = {}) {
  return ['APPROVED', 'CONFIRMED'].includes(String(invoice.status || '').toUpperCase());
}

function isPendingInvoice(invoice = {}) {
  if (isConfirmedInvoice(invoice)) return false;
  return String(invoice.status || '').toUpperCase() === 'PENDING_REVIEW' || invoice.duplicateStatus === 'possible';
}

function isAbnormalInvoice(invoice = {}) {
  if (isConfirmedInvoice(invoice)) return false;
  return String(invoice.status || '').toUpperCase() === 'ABNORMAL'
    || Boolean(invoice.recognitionWarnings)
    || Number(invoice.totalDifference || 0) > 0.05;
}

function invoiceStatusLabel(invoice = {}) {
  if (isConflictInvoice(invoice)) return '同步冲突';
  if (isDuplicateInvoice(invoice)) return '重复发票';
  if (isPossibleMultiPageInvoice(invoice)) return '疑似多页';
  if (isConfirmedInvoice(invoice)) return '已确认';
  if (isAbnormalInvoice(invoice)) return '异常';
  if (isPendingInvoice(invoice)) return '待确认';
  if (String(invoice.status || '').toLowerCase() === 'merged') return '已合并';
  return invoice.status || '正常';
}

function invoiceBadgeClass(invoice = {}) {
  if (isDuplicateInvoice(invoice)) return 'duplicate';
  if (isConflictInvoice(invoice)) return 'conflict';
  if (isAbnormalInvoice(invoice)) return 'abnormal';
  if (isPossibleMultiPageInvoice(invoice)) return 'multipage';
  if (isPendingInvoice(invoice)) return 'pending';
  if (isConfirmedInvoice(invoice)) return 'confirmed';
  return 'normal';
}

function syncBadgeClass(syncStatus = '') {
  if (syncStatus === 'conflict') return 'conflict';
  if (syncStatus === 'pending' || syncStatus === 'deleted') return 'pending';
  if (syncStatus === 'failed') return 'abnormal';
  return 'confirmed';
}

function invoiceIssueReason(invoice = {}) {
  const conflictRecord = parseMaybeJson(invoice.conflictRecord);
  const reasons = [
    invoice.reason,
    invoice.syncNote,
    invoice.recognitionWarnings,
    invoice.duplicateReason,
    invoice.possibleDuplicateReason,
    invoice.sameInvoiceGroupReason,
    conflictRecord.reason,
    conflictRecord.status,
    conflictRecord.duplicateCheck?.duplicateReason,
    conflictRecord.duplicateCheck?.possibleDuplicateReason
  ].filter(Boolean);
  if (Number(invoice.totalDifference || 0) > 0.05) reasons.push(`金额差异 ${money(invoice.totalDifference)}`);
  if (isConflictInvoice(invoice) && reasons.length === 0) reasons.push('本地与云端数据冲突');
  if (isDuplicateInvoice(invoice) && reasons.length === 0) reasons.push('后端检测到重复发票');
  if (isPendingInvoice(invoice) && reasons.length === 0) reasons.push('需要人工确认后进入正式统计');
  if (isAbnormalInvoice(invoice) && reasons.length === 0) reasons.push('识别结果或金额校验异常');
  return reasons.join(' | ') || '无';
}
function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isAdminRole(role) {
  return ['admin', 'super_admin'].includes(String(role || '').toLowerCase());
}

function sourceLabel(source) {
  if (source === 'template') return '模板';
  if (source === 'ai') return 'AI Vision';
  if (source === 'plain_ocr') return 'OCR';
  return 'OCR';
}

function duplicateStatusLabel(status) {
  if (status === 'duplicate') return '重复发票';
  if (status === 'confirmed') return '重复发票';
  if (status === 'possible') return '疑似重复，请确认';
  return '正常';
}

function batchStatusText(entry) {
  if (entry.status === 'skipped') return 'Skipped duplicate file';
  if (entry.status === 'recognizing') return '识别中';
  if (entry.status === 'failed') return '失败';
  if (entry.status === 'success' && entry.autoMerged) return '已自动合并';
  if (entry.status === 'success' && (entry.duplicateStatus === 'confirmed' || entry.isDuplicate)) return '重复发票';
  if (entry.status === 'success' && entry.duplicateStatus === 'possible') return '疑似重复，请确认';
  if (entry.status === 'success' && entry.sameInvoiceGroup) return '同发票号不同金额，可能是多页/同批次';
  if (entry.status === 'success') return '已完成';
  return '等待中';
}

function taskStatusToEntryStatus(status) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'failed';
  if (status === 'processing') return 'recognizing';
  return 'pending';
}

function recognitionTaskStatusText(status) {
  if (status === 'waiting' || status === 'pending') return '等待中';
  if (status === 'processing') return '识别中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return status || '-';
}

function groupBySupplier(entries) {
  return entries.reduce((groups, entry) => {
    const supplierName = entry.parsed?.supplierName || '未识别供应商';
    groups[supplierName] = groups[supplierName] || [];
    groups[supplierName].push(entry);
    return groups;
  }, {});
}
function emptyDuplicateInfo() {
  return {
    isDuplicate: false,
    duplicateReason: '',
    sameInvoiceGroup: false,
    possibleSameInvoicePages: false,
    sameInvoiceGroupReason: '',
    sameSupplierBatch: false,
    duplicateStatus: 'none',
    possibleDuplicateReason: ''
  };
}

function invoiceFingerprintFromParsed(parsed = {}, itemTotal = 0) {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    supplierName: parsed.supplierName || '',
    supplierKey: normalizedSupplierKey(parsed.supplierName),
    invoiceNo: normalizedKey(parsed.invoiceNo),
    invoiceDate: parsed.invoiceDate || '',
    pageNumber: Number(parsed.pageNumber || 0),
    pageCount: Number(parsed.pageCount || 0),
    invoiceGroupKey: parsed.invoiceGroupKey || '',
    totalAmount: normalizedAmount(Number(parsed.totalAmount || 0) > 0 ? parsed.totalAmount : itemTotal),
    itemCount: items.length,
    itemNames: normalizedItemNames(items.map((item) => displayInvoiceItemNormalizedName(item) || displayInvoiceItemName(item))),
    totalQuantity: normalizedAmount(items.reduce((sum, item) => sum + Number(item.quantity ?? item.qty ?? 0), 0))
  };
}

function invoiceFingerprintFromInvoice(invoice = {}) {
  return {
    supplierName: invoice.supplierName || '',
    supplierKey: normalizedSupplierKey(invoice.supplierName),
    invoiceNo: normalizedKey(invoice.invoiceNo),
    invoiceDate: invoice.invoiceDate || '',
    pageNumber: Number(invoice.pageNumber || 0),
    pageCount: Number(invoice.pageCount || 0),
    invoiceGroupKey: invoice.invoiceGroupKey || '',
    totalAmount: normalizedAmount(Number(invoice.totalAmount || 0) > 0 ? invoice.totalAmount : invoice.itemTotal),
    itemCount: Number(invoice.itemCount || 0),
    itemNames: normalizedItemNames(invoice.itemNames || []),
    totalQuantity: normalizedAmount(invoice.itemTotalQuantity || 0)
  };
}

function compareInvoiceFingerprints(current, candidate, sourceLabelText) {
  const result = emptyDuplicateInfo();
  if (!supplierNamesSimilar(current.supplierName, candidate.supplierName)) return result;

  result.sameSupplierBatch = true;
  const sameInvoiceNo = Boolean(current.invoiceNo && current.invoiceNo === candidate.invoiceNo);
  const sameAmount = amountsClose(current.totalAmount, candidate.totalAmount);
  const similarItems = invoiceItemsHighlySimilar(current, candidate);
  const sameOrCloseDate = daysBetweenDates(current.invoiceDate, candidate.invoiceDate) <= 1;
  const sameGroupKey = Boolean(current.invoiceGroupKey && candidate.invoiceGroupKey && current.invoiceGroupKey === candidate.invoiceGroupKey);

  if (!sameInvoiceNo) {
    if (sameAmount && similarItems && sameOrCloseDate) {
      result.duplicateStatus = 'possible';
      result.possibleDuplicateReason = `${sourceLabelText}: 发票号不同，只能标记疑似重复。`;
    }
    return result;
  }

  if (!sameOrCloseDate) {
    result.duplicateStatus = 'possible';
    result.sameInvoiceGroup = true;
    result.possibleSameInvoicePages = true;
    result.sameInvoiceGroupReason = '同供应商同发票号但日期冲突，请人工确认正确日期，不自动拆分。';
    return result;
  }

  if (sameGroupKey && sameInvoiceNo && !similarItems) {
    result.sameInvoiceGroup = true;
    result.possibleSameInvoicePages = true;
    result.duplicateStatus = 'none';
    result.sameInvoiceGroupReason = '同供应商同发票号，可能是同一张多页发票，请人工确认合并。';
    return result;
  }

  if (sameAmount && similarItems) {
    result.isDuplicate = true;
    result.duplicateStatus = 'confirmed';
    result.duplicateReason = `${sourceLabelText}：同供应商、同发票号、同金额，且商品明细高度相似`;
    return result;
  }

  result.duplicateStatus = 'possible';
  result.sameInvoiceGroup = true;
  result.possibleSameInvoicePages = !sameAmount;
  result.sameInvoiceGroupReason = sameAmount
    ? '同供应商同发票号，金额相同但商品明细不同，请人工确认。'
    : '同供应商同发票号，但金额不同，可能是同一发票的不同页/同批次发票，请人工确认。';
  return result;
}

function normalizedAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function amountsClose(a, b) {
  return Math.abs(normalizedAmount(a) - normalizedAmount(b)) < 0.01;
}

function daysBetweenDates(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const left = new Date(`${String(a).slice(0, 10)}T00:00:00Z`).getTime();
  const right = new Date(`${String(b).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86400000;
}

function normalizedSupplierKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function supplierNamesSimilar(a, b) {
  const left = normalizedSupplierKey(a);
  const right = normalizedSupplierKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 5 && right.includes(left)) return true;
  if (right.length >= 5 && left.includes(right)) return true;
  return similarityScore(left, right) >= 0.86;
}

function normalizedItemNames(names = []) {
  return names
    .map((name) => normalizedKey(name).replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();
}

function invoiceItemsHighlySimilar(a, b) {
  if (a.itemCount !== b.itemCount) return false;
  if (a.itemCount === 0 && b.itemCount === 0) return true;
  const nameSimilarity = itemNameSetSimilarity(a.itemNames, b.itemNames);
  if (nameSimilarity >= 0.8) return true;
  return a.itemNames.length === 0 && b.itemNames.length === 0 && amountsClose(a.totalQuantity, b.totalQuantity);
}

function itemNameSetSimilarity(left = [], right = []) {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let matches = 0;
  for (const name of left) {
    if (rightSet.has(name)) {
      matches += 1;
      continue;
    }
    if (right.some((candidate) => similarityScore(name, candidate) >= 0.88)) matches += 1;
  }
  return matches / Math.max(left.length, right.length);
}

function similarityScore(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function levenshteinDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const oldDiagonal = previous[j + 1];
      const cost = a[i] === b[j] ? 0 : 1;
      previous[j + 1] = Math.min(previous[j + 1] + 1, previous[j] + 1, diagonal + cost);
      diagonal = oldDiagonal;
    }
  }
  return previous[b.length];
}

function analyzeBatchEntries(entries, existingInvoices = []) {
  const seenInBatch = [];
  const analyzed = entries.map((entry) => {
    const parsed = normalizeParsedInvoice(entry.result?.parsed);
    const itemTotal = totalFromItems(parsed.items);
    const fingerprint = invoiceFingerprintFromParsed(parsed, itemTotal);
    let duplicateInfo = emptyDuplicateInfo();

    if (entry.status === 'success' && fingerprint.invoiceNo) {
      for (const invoice of existingInvoices) {
        duplicateInfo = compareInvoiceFingerprints(fingerprint, invoiceFingerprintFromInvoice(invoice), '本地已有发票');
        if (duplicateInfo.isDuplicate || duplicateInfo.sameInvoiceGroup) break;
      }

      if (!duplicateInfo.isDuplicate) {
        for (const previous of seenInBatch) {
          const batchDuplicateInfo = compareInvoiceFingerprints(fingerprint, previous.fingerprint, '本次选择中已有发票');
          if (batchDuplicateInfo.isDuplicate || (!duplicateInfo.sameInvoiceGroup && batchDuplicateInfo.sameInvoiceGroup)) {
            duplicateInfo = batchDuplicateInfo;
            if (duplicateInfo.isDuplicate) break;
          }
        }
      }

      seenInBatch.push({ id: entry.id, fingerprint });
    }

    if (entry.result?.duplicateCheck?.isDuplicate) {
      duplicateInfo = {
        ...duplicateInfo,
        ...entry.result.duplicateCheck,
        isDuplicate: true,
        duplicateReason: entry.result.duplicateCheck.duplicateReason || duplicateInfo.duplicateReason
      };
    } else if (entry.result?.duplicateCheck?.sameInvoiceGroup && !duplicateInfo.isDuplicate) {
      duplicateInfo = {
        ...duplicateInfo,
        ...entry.result.duplicateCheck,
        sameInvoiceGroup: true,
        sameInvoiceGroupReason: entry.result.duplicateCheck.sameInvoiceGroupReason || duplicateInfo.sameInvoiceGroupReason
      };
    }

    return {
      ...entry,
      parsed,
      itemTotal,
      ...duplicateInfo,
      sequenceNote: ''
    };
  });

  const sequenceNotes = detectContinuousInvoiceNumbers(analyzed);
  return analyzed.map((entry) => ({
    ...entry,
    sequenceNote: sequenceNotes.get(entry.id) || entry.sequenceNote
  }));
}

function normalizeParsedInvoice(parsed = {}) {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    ...parsed,
    supplierName: (parsed.supplierName || '').trim() || '未识别供应商',
    invoiceNo: (parsed.invoiceNo || '').trim(),
    invoiceDate: normalizeDateInput(parsed.invoiceDate) || today(),
    pageNumber: Number(parsed.pageNumber || 0),
    pageCount: Number(parsed.pageCount || 0),
    invoiceGroupKey: parsed.invoiceGroupKey || '',
    invoiceLayoutType: parsed.invoiceLayoutType || 'normal_invoice',
    totalAmount: Number(parsed.totalAmount || 0),
    items
  };
}

function totalFromItems(items = []) {
  return items.reduce((sum, item) => sum + Number(item.totalPrice ?? item.amount ?? 0), 0);
}

function normalizeParsedItemForForm(item = {}) {
  return {
    productNameOriginal: displayInvoiceItemName(item),
    productNameNormalized: displayInvoiceItemNormalizedName(item),
    category: item.category || '',
    quantity: Number(item.quantity ?? item.qty ?? 0),
    unit: item.unit || item.spec || item.size || '',
    unitPrice: Number(item.unitPrice || 0),
    totalPrice: Number(item.totalPrice ?? item.amount ?? 0),
    chargedQty: Number(item.chargedQty || 0),
    freeQty: Number(item.freeQty || 0),
    totalQty: Number(item.totalQty || item.quantity || item.qty || 0),
    actualQty: Number(item.actualQty || item.totalQty || item.quantity || item.qty || 0),
    originalUnitCost: Number(item.originalUnitCost || item.unitPrice || 0),
    effectiveUnitCost: Number(item.effectiveUnitCost || item.unitPrice || 0),
    discountedEffectiveUnitCost: Number(item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice || 0),
    discountAmount: Number(item.discountAmount || 0),
    promoGroupId: item.promoGroupId || '',
    promoGroupName: item.promoGroupName || '',
    promoGroupRule: item.promoGroupRule || '',
    isFreeItem: Boolean(item.isFreeItem) || Number(item.unitPrice || 0) === 0 || Number(item.totalPrice ?? item.amount ?? 0) === 0,
    isDiscountLine: Boolean(item.isDiscountLine),
    candidateOnly: Boolean(item.candidateOnly),
    isHandwrittenQuantity: Boolean(item.isHandwrittenQuantity),
    isHandwrittenPrice: Boolean(item.isHandwrittenPrice),
    isHandwrittenAmount: Boolean(item.isHandwrittenAmount),
    isCircled: Boolean(item.isCircled),
    isChecked: Boolean(item.isChecked),
    freeReason: item.freeReason || '',
    notes: item.notes || ''
  };
}

function displayInvoiceItemName(item = {}) {
  return String(item.name || item.productNameOriginal || [item.nameCn, item.nameEn].filter(Boolean).join(' ')).trim();
}

function displayInvoiceItemNormalizedName(item = {}) {
  return String(item.normalizedName || item.productNameNormalized || displayInvoiceItemName(item)).trim().toLowerCase();
}

function standardProductNameText(item = {}) {
  const original = displayInvoiceItemName(item).trim().toLowerCase();
  const normalized = displayInvoiceItemNormalizedName(item);
  if (!normalized) return '-';
  return normalized === original ? '同商品名称' : normalized;
}

function normalizeDateInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return formatDateInput(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return formatDateInput(match[3], match[1], match[2]);
  return '';
}

function formatDateInput(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizedKey(value) {
  return String(value || '').trim().toLowerCase();
}

function extractInvoiceSequence(invoiceNo) {
  const match = String(invoiceNo || '').match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  return Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
}

function detectContinuousInvoiceNumbers(entries) {
  const bySupplier = new Map();
  for (const entry of entries) {
    if (entry.status !== 'success' || entry.isDuplicate) continue;
    const sequence = extractInvoiceSequence(entry.parsed.invoiceNo);
    if (sequence === null) continue;
    const supplierKey = normalizedKey(entry.parsed.supplierName);
    const group = bySupplier.get(supplierKey) || [];
    group.push({ entry, sequence });
    bySupplier.set(supplierKey, group);
  }

  const notes = new Map();
  for (const group of bySupplier.values()) {
    const sorted = [...group].sort((a, b) => a.sequence - b.sequence);
    let run = [];

    function flushRun() {
      if (run.length < 2) {
        run = [];
        return;
      }
      const first = run[0].entry.parsed.invoiceNo;
      const last = run[run.length - 1].entry.parsed.invoiceNo;
      for (const item of run) {
        notes.set(item.entry.id, `连续发票号范围：${first} - ${last}`);
      }
      run = [];
    }

    for (const item of sorted) {
      const previous = run[run.length - 1];
      if (!previous || item.sequence === previous.sequence + 1) {
        run.push(item);
      } else {
        flushRun();
        run.push(item);
      }
    }
    flushRun();
  }

  return notes;
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function numberText(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function summarizeGiftAccounting(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = item.promoGroupId || normalizedKey(item.productNameNormalized || item.productNameOriginal || item.id);
    if (groups.has(key)) continue;
    const chargedQty = Number(item.chargedQty || (Number(item.isFreeItem || 0) ? 0 : item.quantity) || 0);
    const freeQty = Number(item.freeQty || (Number(item.isFreeItem || 0) ? item.quantity : 0) || 0);
    const totalQty = Number(item.actualQty || item.totalQty || chargedQty + freeQty);
    const originalUnitCost = Number(item.originalUnitCost || item.unitPrice || 0);
    groups.set(key, {
      chargedQty,
      freeQty,
      totalQty,
      invoiceAmount: originalUnitCost * chargedQty
    });
  }
  const summary = [...groups.values()].reduce((acc, group) => ({
    chargedQty: acc.chargedQty + group.chargedQty,
    freeQty: acc.freeQty + group.freeQty,
    totalQty: acc.totalQty + group.totalQty,
    invoiceAmount: acc.invoiceAmount + group.invoiceAmount
  }), { chargedQty: 0, freeQty: 0, totalQty: 0, invoiceAmount: 0 });
  return {
    ...summary,
    originalUnitCost: summary.chargedQty > 0 ? summary.invoiceAmount / summary.chargedQty : 0,
    effectiveUnitCost: summary.totalQty > 0 ? summary.invoiceAmount / summary.totalQty : 0
  };
}

function summarizePromoGroups(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = item.promoGroupId || normalizedKey(item.promoGroupName || item.productNameNormalized || item.productNameOriginal || item.id);
    const current = groups.get(key) || {
      id: key,
      name: item.promoGroupName || '闇€瑕佷汉宸ョ‘璁ゅ垎鎽婄粍',
      rule: item.promoGroupRule || '',
      chargedQty: 0,
      freeQty: 0,
      actualQty: 0,
      invoiceAmount: 0
    };
    if (!Number(item.isFreeItem || 0)) {
      current.invoiceAmount += Number(item.totalPrice || 0);
    }
    current.chargedQty = Math.max(current.chargedQty, Number(item.chargedQty || 0));
    current.freeQty = Math.max(current.freeQty, Number(item.freeQty || 0));
    current.actualQty = Math.max(current.actualQty, Number(item.actualQty || item.totalQty || 0));
    groups.set(key, current);
  }
  return [...groups.values()]
    .filter((group) => group.freeQty > 0 || group.name === '闇€瑕佷汉宸ョ‘璁ゅ垎鎽婄粍')
    .map((group) => ({
      ...group,
      originalUnitCost: group.chargedQty > 0 ? group.invoiceAmount / group.chargedQty : 0,
      effectiveUnitCost: group.actualQty > 0 ? group.invoiceAmount / group.actualQty : 0
    }));
}
