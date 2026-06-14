import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Building2,
  BarChart3,
  Camera,
  ChevronRight,
  FileText,
  Home,
  PackageSearch,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShoppingCart,
  Trash2,
  Upload,
  UserPlus
} from 'lucide-react';
import { api, getAuthSession, setAuthSession } from './api.js';
import { generateId, localDb, today } from './localDb.js';
import {
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

export default function App() {
  const [authSession, setAuthState] = useState(() => getAuthSession());
  const [authStatus, setAuthStatus] = useState(() => {
    const session = getAuthSession();
    if (!session?.token) return 'unauthenticated';
    return navigator.onLine ? 'checkingAuth' : 'offlineMode';
  });
  const [authNotice, setAuthNotice] = useState('');
  const [syncState, setSyncState] = useState({ label: '☁ 已同步', pendingCount: 0, online: navigator.onLine, syncing: false });

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
    setSyncState(await syncNow({ force: true, reason: 'manual' }));
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
        <Route path="/invite/:token" element={<InvitationAcceptPage onAuthenticated={setAuthState} />} />
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
      <SyncBar state={syncState} session={authSession} onSyncNow={handleSyncNow} onLogout={handleLogout} />
      <AuthStatusBanner status={authStatus} message={authNotice} onRetry={handleRetryAuth} />
      <main className="main">
        <Routes>
          <Route path="/" element={<RequireAuth session={authSession}><HomeDashboardPage /></RequireAuth>} />
          <Route path="/invoices" element={<RequireAuth session={authSession}><InvoiceListPage /></RequireAuth>} />
          <Route path="/invoices/new" element={<RequireAuth session={authSession}><InvoiceFormPage /></RequireAuth>} />
          <Route path="/invoices/batch" element={<RequireAuth session={authSession}><BatchImportPage /></RequireAuth>} />
          <Route path="/recognition-tasks" element={<RequireAuth session={authSession}><RecognitionTaskListPage /></RequireAuth>} />
          <Route path="/invoices/:id" element={<RequireAuth session={authSession}><InvoiceDetailPageWithGifts /></RequireAuth>} />
          <Route path="/products" element={<RequireAuth session={authSession}><ProductSearchPage /></RequireAuth>} />
          <Route path="/products/:name" element={<RequireAuth session={authSession}><ProductDetailPage /></RequireAuth>} />
          <Route path="/supplier-center" element={<RequireAuth session={authSession}><SupplierCenterPage /></RequireAuth>} />
          <Route path="/suppliers/:id" element={<RequireAuth session={authSession}><SupplierDetailPage /></RequireAuth>} />
          <Route path="/suppliers/:id/products" element={<RequireAuth session={authSession}><SupplierProductsPage /></RequireAuth>} />
          <Route path="/suppliers" element={<RequireAuth session={authSession}><SupplierPage /></RequireAuth>} />
          <Route path="/suppliers/:id/invoices" element={<RequireAuth session={authSession}><SupplierInvoiceHistoryPage /></RequireAuth>} />
          <Route path="/account-connections" element={<RequireAuth session={authSession}><AccountConnectionPage /></RequireAuth>} />
          <Route path="/invite/:token" element={<InvitationAcceptPage onAuthenticated={setAuthState} />} />
          <Route path="/analytics" element={<RequireAuth session={authSession}><PurchaseAnalysisPage /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth session={authSession}><SettingsPage /></RequireAuth>} />
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
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ companyName: '', username: '', name: '', email: '', password: '', confirmPassword: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (mode === 'register') {
        if (form.password !== form.confirmPassword) {
          setMessage('两次输入的密码不一致');
          return;
        }
        await api.register(form);
        setMode('login');
        setMessage('注册成功，请登录');
        return;
      }
      const session = await api.login({ login: form.email, password: form.password });
      setAuthSession(session);
      onAuthenticated(getAuthSession());
      window.dispatchEvent(new Event('auth-change'));
      markSyncPending();
    } catch (error) {
      setMessage(error.message || '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1>InvoicePriceTracker</h1>
        <p>云端储存、离线可用、自动同步。</p>
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
        <label className="field"><span>{mode === 'login' ? '邮箱/用户名' : '邮箱'}</span><input type={mode === 'login' ? 'text' : 'email'} autoComplete={mode === 'login' ? 'username' : 'email'} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="field"><span>密码</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        {mode === 'register' && <label className="field"><span>确认密码</span><input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} /></label>}
        {message && <p className="error">{message}</p>}
        <button className="primary-button" disabled={loading}>{loading ? '处理中...' : mode === 'login' ? '登录' : '注册'}</button>
      </form>
    </div>
  );
}

function SyncBar({ state, session, onSyncNow, onLogout }) {
  return (
    <div className={`sync-bar ${state.online ? '' : 'offline'}`}>
      <span>{session?.company?.name || 'InvoicePriceTracker'} · {state.label}</span>
      <button onClick={onSyncNow} disabled={state.syncing || !state.online}>
        <RefreshCw size={15} className={state.syncing ? 'spin' : ''} />
        立即同步
      </button>
      <button type="button" onClick={onLogout}>退出</button>
    </div>
  );
}

function HomePage() {
  return (
    <Page title="InvoicePriceTracker" subtitle="云端储存、本地离线、自动同步">
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
    </Page>
  );
}

function InvoiceListPage() {
  const location = useLocation();
  const [items, setItems] = useState([]);
  const [mergeInvoice, setMergeInvoice] = useState(null);
  const [message, setMessage] = useState('');
  const load = () => localDb.getInvoices().then(setItems);
  useLocalReload(load);
  const filter = new URLSearchParams(location.search).get('filter') || '';
  const filteredItems = items.filter((invoice) => {
    if (filter === 'pending') return isPendingInvoice(invoice);
    if (filter === 'abnormal') return isAbnormalInvoice(invoice);
    return true;
  });

  return (
    <Page title="发票列表" action={<div className="row-actions"><Link className="icon-button" to="/invoices/batch"><Upload size={18} />批量</Link><Link className="icon-button" to="/invoices/new"><Plus size={18} />新增</Link></div>}>
      {filter && <p className="hint">当前筛选：{filter === 'pending' ? '待确认发票' : '异常发票'} <Link to="/invoices">查看全部</Link></p>}
      {filteredItems.length === 0 && <EmptyState text="暂无发票" />}
      {message && <p className={message.includes('失败') || message.includes('没有') ? 'error' : 'success-text'}>{message}</p>}
      <div className="card-list">
        {filteredItems.map((invoice) => (
          <div className="row-card" key={invoice.id}>
            <div>
              <h3>{invoice.supplierName || '未命名供应商'}</h3>
              <p>日期 {invoice.invoiceDate || '-'} · 金额 {money(invoice.totalAmount)}</p>
              <p>{invoiceStatusLabel(invoice)} · {statusText(invoice.syncStatus)}{invoice.invoiceNo ? ` · 发票号 ${invoice.invoiceNo}` : ''}</p>
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
  const [entries, setEntries] = useState([]);
  const [existingInvoices, setExistingInvoices] = useState([]);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [batchId, setBatchId] = useState('');
  const [selectedMergeIds, setSelectedMergeIds] = useState([]);

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
    const nextBatchId = generateId();
    setBatchId(nextBatchId);
    const nextEntries = fileList.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      status: 'pending',
      result: null,
      error: ''
    }));
    setEntries(nextEntries);
    setMessage('');

    if (!navigator.onLine) {
      setMessage('离线模式下无法批量 OCR/AI 识别，请联网后再导入。');
      setEntries(nextEntries.map((entry) => ({ ...entry, status: 'failed', error: 'offline' })));
      return;
    }

    for (const entry of nextEntries) {
      updateEntry(entry.id, { status: 'recognizing' });
      const data = new FormData();
      data.append('image', entry.file);
      data.append('batchId', nextBatchId);
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
    try {
      const result = await api.mergeInvoice(invoiceIds[0], invoiceIds.slice(1));
      await pullFromCloud({ full: true });
      setMessage(result.message || '合并成功');
      navigate(`/invoices/${encodeURIComponent(result.invoiceId || invoiceIds[0])}`);
    } catch (error) {
      setMessage(error.message || '合并失败');
    }
  }

  async function controlBatch(action) {
    if (!batchId) return;
    try {
      if (action === 'pause') await api.pauseRecognitionBatch(batchId);
      if (action === 'resume') await api.resumeRecognitionBatch(batchId);
      if (action === 'cancel') await api.cancelRecognitionBatch(batchId);
      setMessage(action === 'pause' ? '已暂停本批次等待中的任务。' : action === 'resume' ? '已继续识别本批次。' : '已取消本批次剩余等待任务。');
    } catch (error) {
      setMessage(error.message || '批次控制失败');
    }
  }

  return (
    <Page title="批量导入发票" subtitle="一次选择多张图片，后台 OCR/AI 识别并自动保存">
      <Section title="选择图片">
        <div className="field">
          <span>发票图片</span>
          <button type="button" className="primary-button" onClick={() => fileInputRef.current?.click()}>
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
          <div className="row-actions">
            <button type="button" onClick={() => controlBatch('resume')}>继续识别</button>
            <button type="button" onClick={() => controlBatch('pause')}>暂停识别</button>
            <button type="button" className="danger-button" onClick={() => controlBatch('cancel')}>取消剩余识别</button>
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
          <button type="button" className="secondary-button" onClick={mergeSelectedBatchInvoices}>合并选中的发票</button>
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
      </div>
    </Page>
  );
}

function RecognitionTaskListPage() {
  const [tasks, setTasks] = useState([]);
  const [message, setMessage] = useState('');
  const [taskActions, setTaskActions] = useState({});
  const pulledCompletedTaskIds = useRef(new Set());

  async function load() {
    try {
      const data = await api.getRecognitionTasks();
      setTasks(data);
      const newCompletedTasks = data.filter((task) => task.status === 'completed' && !pulledCompletedTaskIds.current.has(task.id));
      if (newCompletedTasks.length) {
        newCompletedTasks.forEach((task) => pulledCompletedTaskIds.current.add(task.id));
        console.log('[recognition] task list completed tasks:', newCompletedTasks.map((task) => ({
          taskId: task.id,
          invoiceId: task.invoiceId || '',
          supplierName: task.result?.parsed?.supplierName || '',
          invoiceNo: task.result?.parsed?.invoiceNo || '',
          totalAmount: task.result?.parsed?.totalAmount || 0
        })));
        markSyncPending();
      }
    } catch (error) {
      setMessage(error.message || '读取识别任务失败');
    }
  }

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      load().catch(() => {
        if (!cancelled) setMessage('读取识别任务失败');
      });
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

  async function retry(taskId) {
    setTaskActions((current) => ({ ...current, [taskId]: 'retry' }));
    try {
      await api.retryRecognitionTask(taskId);
      setMessage('已重新加入后台识别队列');
      load();
    } catch (error) {
      setMessage(error.message || '重新识别失败');
      alert(`操作失败：${error.message || '重新识别失败'}`);
    } finally {
      setTaskActions((current) => ({ ...current, [taskId]: '' }));
    }
  }

  async function forceSave(taskId) {
    setTaskActions((current) => ({ ...current, [taskId]: 'force' }));
    try {
      await api.forceSaveRecognitionTask(taskId);
      setMessage('已强制保存该识别结果');
      await pullFromCloud({ full: true });
      load();
    } catch (error) {
      setMessage(error.message || '强制保存失败');
      alert(`操作失败：${error.message || '强制保存失败'}`);
    } finally {
      setTaskActions((current) => ({ ...current, [taskId]: '' }));
    }
  }

  async function reuploadTaskImage(task, file) {
    if (!file) return;
    try {
      const data = new FormData();
      data.append('image', file);
      if (task.batchId) data.append('batchId', task.batchId);
      const created = await api.createRecognitionTask(data);
      setMessage(`已重新上传并创建任务：${created.taskId}`);
      load();
    } catch (error) {
      setMessage(error.message || '重新上传失败');
    }
  }

  async function decideTask(taskId, action) {
    setTaskActions((current) => ({ ...current, [taskId]: action }));
    try {
      await api.decideRecognitionTask(taskId, action);
      setMessage(action === 'merge' ? '✓ 已合并' : action === 'duplicate' ? '✓ 已标记重复' : '✓ 已保留');
      await pullFromCloud({ full: true });
      load();
    } catch (error) {
      setMessage(error.message || '人工确认失败');
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
            </div>
            <div className="row-actions">
              {task.invoiceId && <Link className="icon-button" to={`/invoices/${task.invoiceId}`}>{task.result?.duplicateCheck?.autoMerged ? '查看合并明细' : '发票'}</Link>}
              {task.status === 'failed' && <button disabled={Boolean(action)} onClick={() => retry(task.id)}>{action === 'retry' ? '处理中...' : '重新识别'}</button>}
              {task.status === 'failed' && (
                <label className="icon-button">
                  重新上传图片
                  <input
                    className="hidden-file-input"
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      reuploadTaskImage(task, event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
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
    pageNumber: 0,
    pageCount: 0,
    invoiceGroupKey: '',
    invoiceLayoutType: 'normal_invoice',
    totalAmount: 0,
    ocrText: '',
    imageId: '',
    imagePath: '',
    items: [emptyItem()]
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [imagePreviewUrl, setImagePreviewUrl] = useState('');
  const [recognitionTask, setRecognitionTask] = useState(null);
  const itemTotal = useMemo(() => form.items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0), [form.items]);
  const total = Number(form.totalAmount || 0) > 0 ? Number(form.totalAmount) : itemTotal;

  useLocalReload(() => localDb.getSuppliers().then(setSuppliers));

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

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
          console.log('[recognition] single task completed:', {
            taskId: task.id,
            invoiceId: task.invoiceId || '',
            supplierName: task.result?.parsed?.supplierName || '',
            invoiceNo: task.result?.parsed?.invoiceNo || '',
            totalAmount: task.result?.parsed?.totalAmount || 0
          });
          markSyncPending();
        }
        if (task.status === 'failed') {
          setMessage(task.error || '识别失败');
        }
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
    const result = task.result || {};
    const parsedItems = Array.isArray(result.parsed?.items) ? result.parsed.items.map(normalizeParsedItemForForm) : [];
    const recognitionSource = result.recognitionSource || sourceLabel(result.source);
    setForm((current) => ({
      ...current,
      supplierName: result.parsed?.supplierName || current.supplierName,
      invoiceNo: result.parsed?.invoiceNo || current.invoiceNo,
      invoiceDate: normalizeDateInput(result.parsed?.invoiceDate) || '',
      pageNumber: Number(result.parsed?.pageNumber || current.pageNumber || 0),
      pageCount: Number(result.parsed?.pageCount || current.pageCount || 0),
      invoiceGroupKey: result.parsed?.invoiceGroupKey || current.invoiceGroupKey || '',
      invoiceLayoutType: result.parsed?.invoiceLayoutType || current.invoiceLayoutType || 'normal_invoice',
      totalAmount: Number(result.parsed?.totalAmount || current.totalAmount || 0),
      imagePath: result.imagePath || task.imagePath || current.imagePath,
      ocrText: result.ocrText || current.ocrText,
      items: parsedItems.length > 0 ? parsedItems : current.items
    }));
    setOcrStatus(`识别完成 · 识别来源：${recognitionSource}`);
  }

  async function handleInvoiceImageSelected(file) {
    if (!file) return;

    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(URL.createObjectURL(file));
    const invoiceId = form.id || generateId();
    try {
      const image = await localDb.saveInvoiceImage({ invoiceId, file, source: 'IndexedDB' });
      setForm((current) => ({
        ...current,
        id: current.id || invoiceId,
        imageId: image.id,
        imagePath: `indexeddb:${image.id}`
      }));
      console.log('Invoice image saved to IndexedDB', {
        imageId: image.id,
        invoiceId,
        size: image.size,
        mimeType: image.mimeType
      });
    } catch (error) {
      console.error('Invoice image save failed', error);
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
      console.log('Recognition task:', created);
      setRecognitionTask(created.task);
      setOcrStatus(`后台识别：${recognitionTaskStatusText(created.task?.status || 'pending')}`);
      setMessage(`已创建后台识别任务：${created.taskId}`);
    } catch (error) {
      console.error('OCR failed:', error);
      setOcrStatus(`识别失败：${error.message || '未知错误'} · 识别来源：OCR`);
      setMessage(error.message);
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
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page title="新增发票" subtitle="上传后创建后台识别任务，完成后自动保存；也可以手动录入。">
      <Section title="发票信息">
        <label className="field">
          <span>供应商名称</span>
          <input list="supplier-list" value={form.supplierName} onChange={(event) => setForm({ ...form, supplierName: event.target.value })} />
          <datalist id="supplier-list">
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.supplierDisplayName || supplier.displayName || supplier.name} />)}
          </datalist>
        </label>
        <label className="field"><span>发票号</span><input value={form.invoiceNo} onChange={(event) => setForm({ ...form, invoiceNo: event.target.value })} /></label>
        <label className="field"><span>发票日期</span><input type="date" value={form.invoiceDate} onChange={(event) => setForm({ ...form, invoiceDate: event.target.value })} /></label>
        <label className="field"><span>发票总金额</span><input type="number" value={form.totalAmount} onChange={(event) => setForm({ ...form, totalAmount: event.target.value })} /></label>
        <div className="grid-2">
          <label className="field"><span>页码</span><input type="number" value={form.pageNumber} onChange={(event) => setForm({ ...form, pageNumber: Number(event.target.value) })} /></label>
          <label className="field"><span>总页数</span><input type="number" value={form.pageCount} onChange={(event) => setForm({ ...form, pageCount: Number(event.target.value) })} /></label>
          <label className="field"><span>发票分组 Key</span><input value={form.invoiceGroupKey || ''} onChange={(event) => setForm({ ...form, invoiceGroupKey: event.target.value })} /></label>
          <label className="field">
            <span>发票版式</span>
            <select value={form.invoiceLayoutType || 'normal_invoice'} onChange={(event) => setForm({ ...form, invoiceLayoutType: event.target.value })}>
              <option value="normal_invoice">normal_invoice</option>
              <option value="printed_catalog_handwritten">printed_catalog_handwritten</option>
              <option value="multi_page">multi_page</option>
              <option value="mixed">mixed</option>
            </select>
          </label>
        </div>
        <div className="field">
          <span>发票图片/OCR 预留</span>
          <div className="file-actions">
            <button type="button" className="secondary-button" onClick={() => cameraInputRef.current?.click()}>
              <Camera size={16} />拍照识别
            </button>
            <button type="button" className="secondary-button" onClick={() => albumInputRef.current?.click()}>
              <Upload size={16} />从相册选择
            </button>
          </div>
          <input
            ref={cameraInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => {
              handleInvoiceImageSelected(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <input
            ref={albumInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/*"
            onChange={(event) => {
              handleInvoiceImageSelected(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          {imagePreviewUrl && <img className="invoice-preview" src={imagePreviewUrl} alt="发票预览" />}
        </div>
        <div className="info-row">
          <span>OCR 状态</span>
          <strong>{ocrStatus || '未识别'}</strong>
        </div>
        {recognitionTask && (
          <div className="detail-item">
            <div className="split"><strong>后台识别任务</strong><strong>{recognitionTaskStatusText(recognitionTask.status)}</strong></div>
            <p>任务 ID：{recognitionTask.id}</p>
            {recognitionTask.invoiceId && <p>已保存发票：{recognitionTask.invoiceId}</p>}
            {recognitionTask.result?.parsed && <ConfidenceSummary parsed={recognitionTask.result.parsed} />}
            {recognitionTask.error && <p className="error">{recognitionTask.error}</p>}
          </div>
        )}
        <label className="field"><span>OCR 原文</span><textarea rows="4" value={form.ocrText} onChange={(event) => setForm({ ...form, ocrText: event.target.value })} /></label>
      </Section>

      <Section title={`商品明细 · 总金额 ${money(total)}`}>
        {form.items.map((item, index) => (
          <div className="item-editor" key={index}>
            <div className="item-editor-title">
              <strong>商品 {index + 1}</strong>
              <button className="text-danger" onClick={() => setForm({ ...form, items: form.items.filter((_, itemIndex) => itemIndex !== index) })}>删除</button>
            </div>
            <label className="field"><span>商品名称</span><input value={item.productNameOriginal} onChange={(event) => updateItem(index, 'productNameOriginal', event.target.value)} /></label>
            <label className="field"><span>商品标准名</span><input value={item.productNameNormalized} onChange={(event) => updateItem(index, 'productNameNormalized', event.target.value)} /></label>
            <div className="grid-2">
              <label className="field"><span>分类</span><input value={item.category} onChange={(event) => updateItem(index, 'category', event.target.value)} /></label>
              <label className="field"><span>单位</span><input value={item.unit} onChange={(event) => updateItem(index, 'unit', event.target.value)} /></label>
              <label className="field"><span>数量</span><input type="number" value={item.quantity} onChange={(event) => updateItem(index, 'quantity', event.target.value)} /></label>
              <label className="field"><span>单价</span><input type="number" value={item.unitPrice} onChange={(event) => updateItem(index, 'unitPrice', event.target.value)} /></label>
              <label className="field"><span>总价</span><input type="number" value={item.totalPrice} onChange={(event) => updateItem(index, 'totalPrice', event.target.value)} /></label>
              <label className="field"><span>收费数量</span><input type="number" value={item.chargedQty || 0} onChange={(event) => updateItem(index, 'chargedQty', event.target.value)} /></label>
              <label className="field"><span>赠品数量</span><input type="number" value={item.freeQty || 0} onChange={(event) => updateItem(index, 'freeQty', event.target.value)} /></label>
              <label className="field"><span>实际数量</span><input type="number" value={item.actualQty || item.totalQty || 0} onChange={(event) => updateItem(index, 'actualQty', event.target.value)} /></label>
              <label className="field"><span>分摊组 ID</span><input value={item.promoGroupId || ''} onChange={(event) => updateItem(index, 'promoGroupId', event.target.value)} /></label>
              <label className="field"><span>分摊组名称</span><input value={item.promoGroupName || ''} onChange={(event) => updateItem(index, 'promoGroupName', event.target.value)} /></label>
              <label className="field"><span>是否赠品</span><input type="checkbox" checked={Boolean(item.isFreeItem)} onChange={(event) => updateItem(index, 'isFreeItem', event.target.checked)} /></label>
              <label className="field"><span>候选行不保存</span><input type="checkbox" checked={Boolean(item.candidateOnly)} onChange={(event) => updateItem(index, 'candidateOnly', event.target.checked)} /></label>
              <label className="field"><span>手写数量</span><input type="checkbox" checked={Boolean(item.isHandwrittenQuantity)} onChange={(event) => updateItem(index, 'isHandwrittenQuantity', event.target.checked)} /></label>
              <label className="field"><span>手写价格</span><input type="checkbox" checked={Boolean(item.isHandwrittenPrice)} onChange={(event) => updateItem(index, 'isHandwrittenPrice', event.target.checked)} /></label>
              <label className="field"><span>手写金额</span><input type="checkbox" checked={Boolean(item.isHandwrittenAmount)} onChange={(event) => updateItem(index, 'isHandwrittenAmount', event.target.checked)} /></label>
              <label className="field"><span>圈选</span><input type="checkbox" checked={Boolean(item.isCircled)} onChange={(event) => updateItem(index, 'isCircled', event.target.checked)} /></label>
              <label className="field"><span>勾选</span><input type="checkbox" checked={Boolean(item.isChecked)} onChange={(event) => updateItem(index, 'isChecked', event.target.checked)} /></label>
              <label className="field"><span>赠品原因</span><input value={item.freeReason || ''} onChange={(event) => updateItem(index, 'freeReason', event.target.value)} /></label>
              <label className="field"><span>备注</span><input value={item.notes} onChange={(event) => updateItem(index, 'notes', event.target.value)} /></label>
            </div>
          </div>
        ))}
        <button className="secondary-button" onClick={() => setForm({ ...form, items: [...form.items, emptyItem()] })}><Plus size={16} />新增行</button>
      </Section>

      {message && <p className="error">{message}</p>}
      <div className="sticky-actions">
        <button className="primary-button" disabled={saving || ['waiting', 'pending', 'processing'].includes(recognitionTask?.status)} onClick={save}><Save size={18} />{recognitionTask?.invoiceId ? '查看已保存发票' : saving ? '保存中...' : '确认并学习'}</button>
      </div>
    </Page>
  );
}

function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);

  useLocalReload(() => localDb.getInvoice(id).then(setDetail), [id]);

  async function remove() {
    if (!confirm('确认删除这张发票？')) return;
    await localDb.deleteInvoice(id);
    markSyncPending();
    navigate('/invoices');
  }

  if (!detail) return <Page title="发票详情"><EmptyState text="未找到发票" /></Page>;

  const { invoice, items } = detail;
  return (
    <Page title="发票详情" action={<button className="danger-button" onClick={remove}><Trash2 size={16} />删除</button>}>
      <Section title="发票信息">
        <Info label="供应商" value={invoice.supplierName || '未命名供应商'} />
        <Info label="发票号" value={invoice.invoiceNo || '-'} />
        <Info label="日期" value={invoice.invoiceDate || '-'} />
        <Info label="总金额" value={money(invoice.totalAmount)} />
        <Info label="同步状态" value={statusText(invoice.syncStatus)} />
      </Section>
      {invoice.imagePath && <Section title="查看原图"><img className="invoice-image" src={invoice.imagePath} alt="发票原图" /></Section>}
      <Section title="商品明细">
        {items.map((item) => (
          <div className="detail-item" key={item.id}>
            <strong>{item.productNameOriginal}</strong>
            <p>标准名：{item.productNameNormalized || '-'}</p>
            <p>数量 {item.quantity} {item.unit} · 单价 {money(item.unitPrice)} · 总价 {money(item.totalPrice)}</p>
          </div>
        ))}
      </Section>
      <Section title="查看OCR原文"><pre className="ocr-text">{invoice.ocrText || '无 OCR 内容'}</pre></Section>
    </Page>
  );
}

function HomeDashboardPage() {
  const [dashboard, setDashboard] = useState(null);
  const session = getAuthSession();
  const isAdmin = isAdminRole(session?.user?.role || '');
  useLocalReload(() => localDb.getDashboardMetrics().then(setDashboard));

  return (
    <Page title="InvoicePriceTracker" subtitle="采购数据库、供应商数据库、历史价格数据库">
      <Section title="采购仪表盘">
        <div className="metric-grid">
          <Metric label="已确认采购金额" value={money(dashboard?.confirmedPurchaseAmount ?? dashboard?.totalPurchaseAmount)} />
          <Metric label="待确认采购金额" value={money(dashboard?.pendingPurchaseAmount)} to="/invoices?filter=pending" />
          <Metric label="异常发票金额" value={money(dashboard?.abnormalInvoiceAmount)} to="/invoices?filter=abnormal" />
          <Metric label="本月已确认金额" value={money(dashboard?.monthConfirmedAmount ?? dashboard?.monthPurchaseAmount)} />
          <Metric label="本月待确认金额" value={money(dashboard?.monthPendingAmount)} to="/invoices?filter=pending" />
          <Metric label="已确认发票数量" value={dashboard?.confirmedInvoiceCount ?? dashboard?.monthInvoiceCount ?? 0} />
          <Metric label="本月新增供应商" value={dashboard?.monthNewSupplierCount ?? 0} />
          <Metric label="赠品总价值" value={money(dashboard?.giftValueTotal)} />
          <Metric label="折扣总金额" value={money(dashboard?.discountTotal)} />
          <Metric label="异常发票数量" value={dashboard?.abnormalInvoiceCount ?? 0} to="/invoices?filter=abnormal" />
          <Metric label="待确认发票数量" value={dashboard?.pendingInvoiceCount ?? 0} to="/invoices?filter=pending" />
        </div>
      </Section>
      <Section title="采购中心">
        <ActionLink to="/invoices/new" icon={<Camera />} title="发票扫描" subtitle="拍照或相册上传，后台识别并保存" />
        <ActionLink to="/invoices" icon={<FileText />} title="发票列表" subtitle="按日期查看所有历史发票" />
        <ActionLink to="/supplier-center" icon={<Building2 />} title="供应商查询" subtitle="搜索供应商、电话、联系人、发票号和商品名" />
        <ActionLink to="/products" icon={<PackageSearch />} title="商品价格查询" subtitle="查看商品历史价格和供应商对比" />
        <ActionLink to="/analytics" icon={<BarChart3 />} title="采购分析" subtitle="排名、月度采购、最低价和价格趋势" />
      </Section>
      <Section title="识别与管理">
        <ActionLink to="/invoices/batch" icon={<Upload />} title="批量导入发票" subtitle="多张图片队列识别" />
        <ActionLink to="/recognition-tasks" icon={<RefreshCw />} title="识别记录/任务列表" subtitle="查看后台 AI 识别状态和历史结果" />
        <ActionLink to="/suppliers" icon={<Building2 />} title="供应商管理" subtitle="维护供应商和模板" />
        {isAdmin && <ActionLink to="/settings" icon={<UserPlus />} title="成员管理" subtitle="管理员直接创建、停用和重置成员账号" />}
        <ActionLink to="/settings" icon={<Settings />} title="设置/导出" subtitle="查看本地统计、导出云端 CSV/Excel" />
      </Section>
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
  const [editingPromoGroups, setEditingPromoGroups] = useState(false);
  const [detailMessage, setDetailMessage] = useState('');
  const [operation, setOperation] = useState('');

  const loadDetail = () => localDb.getInvoice(id).then(setDetail);
  useLocalReload(loadDetail, [id]);

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

  async function savePromoGroups(nextItems) {
    setOperation('save-promo');
    try {
      const updated = await localDb.updateInvoiceItems(id, nextItems, detail?.items || []);
      setDetail(updated);
      setEditingPromoGroups(false);
      setDetailMessage('✓ 赠品分摊已保存');
      markSyncPending();
    } catch (error) {
      alert(`操作失败：${error.message || '保存分摊失败'}`);
    } finally {
      setOperation('');
    }
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
    setOperation(status === 'ABNORMAL_HANDLED' ? 'handle-abnormal' : 'confirm-invoice');
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

  if (!detail) return <Page title="发票详情"><EmptyState text="未找到发票" /></Page>;

  const { invoice, items, discounts = [], mergedInvoices = [] } = detail;
  console.log('Invoice image fields', {
    imageUrl: invoice.imageUrl || '',
    imagePath: invoice.imagePath || '',
    imageId: invoice.imageId || ''
  });
  const giftSummary = summarizeGiftAccounting(items);
  const promoGroups = summarizePromoGroups(items);
  const finalSavedResult = { invoice, items, discounts, mergedInvoices };
  return (
    <Page title="发票详情" action={<div className="row-actions"><button type="button" onClick={() => setEditingInvoice(true)}>编辑发票</button><button className="danger-button" onClick={remove}><Trash2 size={16} />删除</button></div>}>
      {detailMessage && <p className="success-text">{detailMessage}</p>}
      {(isPendingInvoice(invoice) || isAbnormalInvoice(invoice)) && (
        <Section title="处理状态">
          {isPendingInvoice(invoice) && <p className="status-badge pending">待确认发票</p>}
          {isAbnormalInvoice(invoice) && <p className="status-badge abnormal">异常发票</p>}
          {isAbnormalInvoice(invoice) && (
            <p className="warning-text">异常原因：{invoice.recognitionWarnings || '商品明细总额与发票总额不一致'}{Number(invoice.totalDifference || 0) > 0.05 ? `，差额：${money(invoice.totalDifference)}` : ''}</p>
          )}
          <div className="row-actions">
            <button className="primary-button success-button" type="button" disabled={operation === 'confirm-invoice'} onClick={() => confirmInvoice('CONFIRMED')}>
              {operation === 'confirm-invoice' ? '处理中...' : '确认发票'}
            </button>
            {invoice.duplicateStatus === 'possible' && <button className="danger-button" type="button" disabled={operation === 'mark-duplicate'} onClick={markDuplicate}>{operation === 'mark-duplicate' ? '标记中...' : '标记重复'}</button>}
            {invoice.duplicateStatus === 'possible' && <button className="primary-button success-button" type="button" disabled={operation === 'keep-independent'} onClick={keepIndependent}>{operation === 'keep-independent' ? '处理中...' : '保留为独立发票'}</button>}
            {isAbnormalInvoice(invoice) && <button className="secondary-button" type="button" onClick={() => setEditingInvoice(true)}>编辑发票</button>}
            {isAbnormalInvoice(invoice) && <button className="secondary-button" type="button" disabled={!items.length} onClick={() => items[0] && setEditingItem(items[0])}>编辑商品明细</button>}
            {isAbnormalInvoice(invoice) && <button className="primary-button success-button" type="button" disabled={operation === 'confirm-invoice'} onClick={() => confirmInvoice('CONFIRMED')}>{operation === 'confirm-invoice' ? '处理中...' : '确认无误'}</button>}
          </div>
        </Section>
      )}
      <Section title="发票信息">
        <Info label="供应商" value={invoice.supplierName || '未命名供应商'} />
        <Info label="发票号" value={invoice.invoiceNo || '-'} />
        <Info label="日期" value={invoice.invoiceDate || '-'} />
        <Info label="总金额" value={money(invoice.totalAmount)} />
        <Info label="页码" value={invoice.pageCount ? `${invoice.pageNumber || '-'} / ${invoice.pageCount}` : (invoice.pageNumber || '-')} />
        <Info label="发票版式" value={invoice.invoiceLayoutType || 'normal_invoice'} />
        <Info label="多页合并" value={Number(invoice.isMergedInvoice || 0) ? '是' : '否'} />
        <Info label="AI/OCR 来源" value={sourceLabel(invoice.recognitionSource)} />
        <Info label="usedTemplate" value={recognitionTask?.usedTemplate || recognitionTask?.result?.usedTemplate ? "yes" : "no"} />
        <Info label="usedCorrection" value={items.some((item) => Number(item.correctedByUser || 0)) ? "yes" : "no"} />
        <Info label="confidence" value={recognitionTask?.result?.parsed?.confidence ?? recognitionTask?.result?.confidence ?? "-"} />
        <Info label="重复状态" value={duplicateStatusLabel(invoice.duplicateStatus)} />
        <Info label="发票状态" value={invoice.status || '-'} />
        <Info label="同步状态" value={statusText(invoice.syncStatus)} />
      </Section>
      {invoice.recognitionWarnings && <Section title="识别警告"><p className="warning-text">{invoice.recognitionWarnings}</p></Section>}
      {giftSummary.freeQty > 0 && (
        <Section title="赠品核算">
          <Info label="收费数量" value={numberText(giftSummary.chargedQty)} />
          <Info label="免费数量" value={numberText(giftSummary.freeQty)} />
          <Info label="实际数量" value={numberText(giftSummary.totalQty)} />
          <Info label="发票金额" value={money(giftSummary.invoiceAmount)} />
          <Info label="原始单价" value={money(giftSummary.originalUnitCost)} />
          <Info label="实际成本" value={money(giftSummary.effectiveUnitCost)} />
          <button className="secondary-button" type="button" onClick={() => setEditingPromoGroups(true)}>编辑分摊组</button>
        </Section>
      )}
      {promoGroups.length > 0 && (
        <Section title="赠品分摊组">
          <button className="secondary-button" type="button" onClick={() => setEditingPromoGroups(true)}>人工分摊</button>
          {promoGroups.map((group) => (
            <div className="detail-item" key={group.id}>
              <strong>{group.name}</strong>
              <p>规则：{group.rule || '-'}</p>
              <p>收费数量 {numberText(group.chargedQty)} · 免费数量 {numberText(group.freeQty)} · 实际数量 {numberText(group.actualQty)}</p>
              <p>发票金额 {money(group.invoiceAmount)} · 原始单价 {money(group.originalUnitCost)} · 实际摊薄成本 {money(group.effectiveUnitCost)}</p>
            </div>
          ))}
        </Section>
      )}
      {discounts.length > 0 && (
        <Section title="折扣">
          {discounts.map((discount) => (
            <div className="detail-item" key={discount.id}>
              <strong>{discount.discountName}</strong>
              <p>金额 {money(discount.amount)} · 类型 {discount.discountType || 'unknown'}</p>
              <p>{discount.appliedToProductIds ? `已关联商品：${discount.appliedToProductIds}` : '未确定关联商品，请人工分配折扣'}</p>
            </div>
          ))}
        </Section>
      )}
      <Section title="查看原图">
        <InvoiceImageViewer invoice={invoice} onUpdated={loadDetail} />
      </Section>
      {mergedInvoices.length > 0 && (
        <Section title="合并页面原图">
          {mergedInvoices.map((mergedInvoice, index) => (
            <div className="detail-item" key={mergedInvoice.id}>
              <strong>页面 {index + 2} · {mergedInvoice.invoiceNo || '-'}</strong>
              <InvoiceImageViewer invoice={mergedInvoice} onUpdated={loadDetail} />
            </div>
          ))}
        </Section>
      )}
      <Section title="商品明细">
        {items.map((item) => (
          <div className="detail-item" key={item.id}>
            <div className="split"><strong>{item.productNameOriginal}</strong><button type="button" onClick={() => setEditingItem(item)}>编辑</button></div>
            <p>标准名：{item.productNameNormalized || '-'}</p>
            <p>数量 {numberText(item.quantity)} {item.unit} · 原单价 {money(item.unitPrice)} · 总价 {money(item.totalPrice)}</p>
            <p>是否赠品：{Number(item.isFreeItem || 0) ? `是（${item.freeReason || '免费行'}）` : '否'} · 收费数量 {numberText(item.chargedQty)} · 免费数量 {numberText(item.freeQty)} · 实际数量 {numberText(item.totalQty)}</p>
            <p>分摊组：{item.promoGroupName || '-'} · {item.promoGroupRule || '-'}</p>
            <p>原始单价 {money(item.originalUnitCost || item.unitPrice)} · 实际摊薄成本 {money(item.effectiveUnitCost || item.unitPrice)} · 折后实际成本 {money(item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice)}</p>
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
      {editingItem && (
        <InvoiceItemEditDialog
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={saveEditedItem}
        />
      )}
      {editingInvoice && (
        <InvoiceEditDialog
          invoice={invoice}
          onClose={() => setEditingInvoice(false)}
          onSave={saveInvoiceFields}
        />
      )}
      {editingPromoGroups && (
        <PromoAllocationDialog
          items={items}
          onClose={() => setEditingPromoGroups(false)}
          onSave={savePromoGroups}
        />
      )}
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
    invoiceDate: normalizeDateInput(invoice.invoiceDate) || '',
    totalAmount: Number(invoice.totalAmount || 0),
    subtotal: Number(invoice.subtotal || invoice.totalAmount || 0),
    tax: Number(invoice.tax || 0),
    recognitionWarnings: invoice.recognitionWarnings || ''
  }));

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({
        supplierName: form.supplierName,
        supplierNameChinese: form.supplierNameChinese,
        supplierNameEnglish: form.supplierNameEnglish,
        supplierDisplayName: form.supplierDisplayName,
        invoiceNo: form.invoiceNo,
        invoiceDate: normalizeDateInput(form.invoiceDate) || '',
        totalAmount: Number(form.totalAmount || 0),
        subtotal: Number(form.subtotal || form.totalAmount || 0),
        tax: Number(form.tax || 0),
        recognitionWarnings: form.recognitionWarnings
      });
    } catch (error) {
      alert(`保存失败：${error.message || '未知错误'}`);
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
        <label className="field"><span>Subtotal</span><input type="number" value={form.subtotal} onChange={(event) => update('subtotal', event.target.value)} /></label>
        <label className="field"><span>Tax</span><input type="number" value={form.tax} onChange={(event) => update('tax', event.target.value)} /></label>
      </div>
      <label className="field"><span>识别警告</span><textarea rows="3" value={form.recognitionWarnings} onChange={(event) => update('recognitionWarnings', event.target.value)} /></label>
      <div className="dialog-actions sticky-dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button success-button" type="button" disabled={saving} onClick={save}>{saving ? '处理中...' : '保存发票'}</button>
      </div>
    </Dialog>
  );
}

function InvoiceItemEditDialog({ item, onClose, onSave }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
    ...emptyItem(),
    ...item,
    nameCn: item.nameCn || '',
    nameEn: item.nameEn || '',
    spec: item.spec || '',
    quantity: Number(item.quantity || 0),
    unitPrice: Number(item.unitPrice || 0),
    totalPrice: Number(item.totalPrice || 0),
    isFreeItem: Boolean(Number(item.isFreeItem || 0)),
    participatesInGiftAllocation: Boolean(Number(item.participatesInGiftAllocation || 0))
  }));

  function update(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'quantity' || field === 'unitPrice') {
        next.totalPrice = Number(next.quantity || 0) * Number(next.unitPrice || 0);
      }
      if (field === 'chargedQty' || field === 'freeQty') {
        next.actualQty = Number(next.chargedQty || 0) + Number(next.freeQty || 0);
        next.totalQty = next.actualQty;
      }
      if (field === 'totalPrice' || field === 'quantity' || field === 'unitPrice' || field === 'chargedQty' || field === 'freeQty') {
        const actualQty = Number(next.actualQty || next.totalQty || next.quantity || 0);
        next.effectiveUnitCost = actualQty > 0 ? Number(next.totalPrice || 0) / actualQty : 0;
      }
      return next;
    });
  }

  async function save() {
    const name = form.productNameOriginal || [form.nameCn, form.nameEn].filter(Boolean).join(' ');
    setSaving(true);
    try {
      await onSave({
        ...form,
        productNameOriginal: name,
        productNameNormalized: form.productNameNormalized || name,
        quantity: Number(form.quantity || 0),
        unitPrice: Number(form.unitPrice || 0),
        totalPrice: Number(form.totalPrice || 0),
        chargedQty: Number(form.chargedQty || 0),
        freeQty: Number(form.freeQty || 0),
        actualQty: Number(form.actualQty || form.totalQty || form.quantity || 0),
        totalQty: Number(form.actualQty || form.totalQty || form.quantity || 0),
        effectiveUnitCost: Number(form.effectiveUnitCost || 0),
        isFreeItem: form.isFreeItem ? 1 : 0,
        participatesInGiftAllocation: form.participatesInGiftAllocation ? 1 : 0,
        correctedByUser: 1
      });
    } catch (error) {
      alert(`保存失败：${error.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }

  const calculatedTotal = Number(form.quantity || 0) * Number(form.unitPrice || 0);
  const mismatch = Math.abs(calculatedTotal - Number(form.totalPrice || 0)) > 0.01;

  return (
    <Dialog title="编辑商品明细" onClose={onClose}>
      <div className="item-editor">
        <label className="field"><span>商品名称</span><input value={form.productNameOriginal || ''} onChange={(event) => update('productNameOriginal', event.target.value)} /></label>
        <label className="field"><span>品牌</span><input value={form.brand || ''} onChange={(event) => update('brand', event.target.value)} /></label>
        <label className="field"><span>规格</span><input value={form.spec || ''} onChange={(event) => update('spec', event.target.value)} /></label>
        <div className="grid-2">
          <label className="field"><span>数量</span><input type="number" value={form.quantity || 0} onChange={(event) => update('quantity', event.target.value)} /></label>
          <label className="field"><span>单价</span><input type="number" value={form.unitPrice || 0} onChange={(event) => update('unitPrice', event.target.value)} /></label>
          <label className="field"><span>金额</span><input type="number" value={form.totalPrice || 0} onChange={(event) => update('totalPrice', event.target.value)} /></label>
          <label className="field"><span>收费数量</span><input type="number" value={form.chargedQty || 0} onChange={(event) => update('chargedQty', event.target.value)} /></label>
          <label className="field"><span>免费数量</span><input type="number" value={form.freeQty || 0} onChange={(event) => update('freeQty', event.target.value)} /></label>
          <label className="field"><span>实际数量</span><input type="number" value={form.actualQty || form.totalQty || 0} onChange={(event) => update('actualQty', event.target.value)} /></label>
          <label className="field"><span>实际摊薄成本</span><input type="number" value={Number(form.effectiveUnitCost || 0).toFixed(2)} onChange={(event) => update('effectiveUnitCost', event.target.value)} /></label>
        </div>
        {mismatch && <p className="warning-text">总价与 数量 × 单价 不一致，计算值：{money(calculatedTotal)}。允许保存。</p>}
        <SwitchField label="是否赠品" checked={Boolean(form.isFreeItem)} onChange={(checked) => update('isFreeItem', checked)} />
        <SwitchField label="参与赠品分摊" checked={Boolean(form.participatesInGiftAllocation)} onChange={(checked) => update('participatesInGiftAllocation', checked)} />
        <label className="field"><span>备注</span><input value={form.notes || ''} onChange={(event) => update('notes', event.target.value)} /></label>
        <CollapsibleSection title="高级信息">
          <label className="field"><span>标准名</span><input value={form.productNameNormalized || ''} onChange={(event) => update('productNameNormalized', event.target.value)} /></label>
          <label className="field"><span>单位</span><input value={form.unit || ''} onChange={(event) => update('unit', event.target.value)} /></label>
          <label className="field"><span>分摊组 ID</span><input value={form.promoGroupId || ''} onChange={(event) => update('promoGroupId', event.target.value)} /></label>
          <label className="field"><span>分摊组名称</span><input value={form.promoGroupName || ''} onChange={(event) => update('promoGroupName', event.target.value)} /></label>
          <SwitchField label="候选行不保存" checked={Boolean(form.candidateOnly)} onChange={(checked) => update('candidateOnly', checked)} />
          <SwitchField label="圈选" checked={Boolean(form.isCircled)} onChange={(checked) => update('isCircled', checked)} />
          <SwitchField label="勾选" checked={Boolean(form.isChecked)} onChange={(checked) => update('isChecked', checked)} />
        </CollapsibleSection>
      </div>
      <div className="dialog-actions sticky-dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button success-button" type="button" disabled={saving} onClick={save}>{saving ? '处理中...' : '保存商品'}</button>
      </div>
    </Dialog>
  );
}

function PromoAllocationDialog({ items, onClose, onSave }) {
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState(() => items.map((item) => ({
    ...item,
    participatesInGiftAllocation: Boolean(Number(item.participatesInGiftAllocation || 0) || item.promoGroupId || item.isFreeItem),
    promoGroupName: item.promoGroupName || 'Manual Promo Group',
    chargedQty: Number(item.chargedQty || 0),
    freeQty: Number(item.freeQty || 0),
    actualQty: Number(item.actualQty || item.totalQty || item.quantity || 0),
    originalUnitCost: Number(item.originalUnitCost || item.unitPrice || 0),
    effectiveUnitCost: Number(item.effectiveUnitCost || item.unitPrice || 0)
  })));

  function updateRow(idValue, field, value) {
    setRows((current) => current.map((row) => {
      if (row.id !== idValue) return row;
      const next = { ...row, [field]: value };
      if (field === 'chargedQty' || field === 'freeQty') {
        next.actualQty = Number(next.chargedQty || 0) + Number(next.freeQty || 0);
      }
      if (field === 'totalPrice' || field === 'chargedQty' || field === 'freeQty' || field === 'actualQty') {
        const actualQty = Number(next.actualQty || 0);
        next.effectiveUnitCost = actualQty > 0 ? Number(next.totalPrice || 0) / actualQty : 0;
      }
      return next;
    }));
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(rows.map((row) => {
        const groupName = String(row.promoGroupName || '').trim();
        const participates = Boolean(row.participatesInGiftAllocation);
        return {
          ...row,
          promoGroupId: participates ? groupName.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-') : '',
          promoGroupName: participates ? groupName : '',
          promoGroupRule: participates ? 'manual allocation' : '',
          participatesInGiftAllocation: participates ? 1 : 0,
          chargedQty: Number(row.chargedQty || 0),
          freeQty: Number(row.freeQty || 0),
          totalQty: Number(row.actualQty || 0),
          actualQty: Number(row.actualQty || 0),
          originalUnitCost: Number(row.originalUnitCost || 0),
          effectiveUnitCost: Number(row.effectiveUnitCost || 0),
          manualCostOverride: 1,
          correctedByUser: 1
        };
      }));
    } catch (error) {
      alert(`操作失败：${error.message || '保存分摊失败'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="编辑赠品分摊组" onClose={onClose}>
      <div className="card-list">
        {rows.map((row) => (
          <div className="detail-item" key={row.id}>
            <strong>{row.productNameOriginal || row.rawName}</strong>
            <SwitchField label="加入分摊组" checked={Boolean(row.participatesInGiftAllocation)} onChange={(checked) => updateRow(row.id, 'participatesInGiftAllocation', checked)} />
            <label className="field"><span>分摊组名称</span><input value={row.promoGroupName || ''} onChange={(event) => updateRow(row.id, 'promoGroupName', event.target.value)} /></label>
            <div className="grid-2">
              <label className="field"><span>收费数量</span><input type="number" value={row.chargedQty || 0} onChange={(event) => updateRow(row.id, 'chargedQty', event.target.value)} /></label>
              <label className="field"><span>免费数量</span><input type="number" value={row.freeQty || 0} onChange={(event) => updateRow(row.id, 'freeQty', event.target.value)} /></label>
              <label className="field"><span>实际数量</span><input type="number" value={row.actualQty || 0} onChange={(event) => updateRow(row.id, 'actualQty', event.target.value)} /></label>
              <label className="field"><span>发票金额</span><input type="number" value={row.totalPrice || 0} onChange={(event) => updateRow(row.id, 'totalPrice', event.target.value)} /></label>
              <label className="field"><span>原始单价</span><input type="number" value={row.originalUnitCost || 0} onChange={(event) => updateRow(row.id, 'originalUnitCost', event.target.value)} /></label>
              <label className="field"><span>实际摊薄成本</span><input type="number" value={row.effectiveUnitCost || 0} onChange={(event) => updateRow(row.id, 'effectiveUnitCost', event.target.value)} /></label>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-actions sticky-dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button success-button" type="button" disabled={saving} onClick={save}>{saving ? '保存中...' : '保存分摊'}</button>
      </div>
    </Dialog>
  );
}

function ProductSearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  useLocalReload(() => localDb.searchProducts(q).then(setResults), [q]);

  async function search(event) {
    event?.preventDefault();
    setSearched(true);
    setResults(await localDb.searchProducts(q));
  }

  return (
    <Page title="商品价格查询" subtitle="查询优先读取本地 IndexedDB">
      <form className="search-bar" onSubmit={search}>
        <input placeholder="输入商品名称" value={q} onChange={(event) => setQ(event.target.value)} />
        <button><Search size={18} />搜索</button>
      </form>
      {!q.trim() && <p className="hint">默认显示最近 20 个购买商品。</p>}
      {searched && results.length === 0 && <EmptyState text="暂无结果" />}
      <div className="card-list">
        {results.map((item) => (
          <Link className="row-card" to={`/products/${encodeURIComponent(item.standardName)}`} key={item.standardName}>
            <div>
              <h3>{item.standardName}</h3>
              <p>最近 {money(item.recentPrice)} · 最低 {money(item.minPrice)} · 最高 {money(item.maxPrice)}</p>
              <p>均价 {money(item.averagePrice)} · 最近供应商 {item.recentSupplierName || '-'} · 最近采购 {item.recentPurchaseDate} · {item.recordCount} 条</p>
              {item.pendingCount > 0 && <p className="warning-text">{item.pendingCount} 条价格来自待确认/异常发票</p>}
            </div>
            <ChevronRight />
          </Link>
        ))}
      </div>
    </Page>
  );
}

function ProductDetailPage() {
  const { name } = useParams();
  const decoded = decodeURIComponent(name);
  const [records, setRecords] = useState([]);
  const [supplierCompare, setSupplierCompare] = useState([]);

  useLocalReload(async () => {
    setRecords(await localDb.getProduct(decoded));
    setSupplierCompare(await localDb.compareProductSuppliers(decoded));
  }, [decoded]);

  return (
    <Page title="商品详情" subtitle={decoded}>
      <Section title="供应商价格对比">
        {supplierCompare.length === 0 && <EmptyState text="暂无供应商价格记录" />}
        {supplierCompare.map((row) => (
          <div className="detail-item" key={row.supplierId}>
            <div className="split"><strong>{row.supplierName}</strong><strong>{money(row.minPrice)}</strong></div>
            <p>最近价格 {money(row.recentPrice)} · 最低价格 {money(row.minPrice)} · 最近采购 {row.recentPurchaseDate || '-'}</p>
            <p>采购记录 {row.recordCount} 条</p>
          </div>
        ))}
      </Section>
      <Section title="采购记录">
        {records.length === 0 && <EmptyState text="暂无采购记录" />}
        {records.map((record) => (
          <div className="detail-item" key={record.id}>
            <div className="split"><strong>{record.invoiceDate}</strong><strong>{money(record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice)}</strong></div>
            <p>{record.supplierName || '未命名供应商'}</p>
            <p>原始名：{record.productNameOriginal}</p>
            <p>原始单价 {money(record.unitPrice)} · 实际摊薄成本 {money(record.effectiveUnitCost || record.unitPrice)} · 折后实际成本 {money(record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice)}</p>
            <p>数量 {record.quantity} {record.unit} · 总价 {money(record.totalPrice)} · 赠品数量 {numberText(record.freeQty || 0)} · 折扣 {money(record.discountAmount || 0)} · 是否赠品 {Number(record.isFreeItem || 0) ? '是' : '否'} · 发票号 {record.invoiceNo || '-'}</p>
            <p>分摊组：{record.promoGroupName || '-'} · {record.promoGroupRule || '-'}</p>
            {record.invoiceRecordId && <Link className="secondary-button" to={`/invoices/${encodeURIComponent(record.invoiceRecordId)}`}>查看发票/图片</Link>}
          </div>
        ))}
      </Section>
    </Page>
  );
}

function SupplierCenterPage() {
  const [q, setQ] = useState('');
  const [suppliers, setSuppliers] = useState([]);

  const load = () => localDb.getSupplierCenter(q).then(setSuppliers);
  useLocalReload(load, [q]);

  return (
    <Page title="供应商查询中心" subtitle="按供应商、电话、联系人、发票号、商品名称搜索">
      <form className="search-bar" onSubmit={(event) => event.preventDefault()}>
        <input placeholder="输入供应商/电话/联系人/发票号/商品名" value={q} onChange={(event) => setQ(event.target.value)} />
        <button type="button"><Search size={18} />搜索</button>
      </form>
      <div className="card-list">
        {suppliers.length === 0 && <EmptyState text="暂无供应商采购数据" />}
        {suppliers.map((supplier) => (
          <Link className="row-card" to={`/suppliers/${encodeURIComponent(supplier.id)}`} key={supplier.id}>
            <div>
              <h3>{supplier.supplierDisplayName || supplier.displayName || supplier.name || '未命名供应商'}</h3>
              <p>累计采购 {money(supplier.totalPurchaseAmount)} · 发票 {supplier.invoiceCount} 张 · SKU {supplier.skuCount}</p>
              <p>最近采购 {supplier.recentPurchaseDate || '-'} · 最近金额 {money(supplier.recentPurchaseAmount)}</p>
              <p>赠品数量 {numberText(supplier.freeQtyTotal)} · 折扣 {money(supplier.discountTotal)} · 异常 {supplier.abnormalInvoiceCount}</p>
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
  const [editing, setEditing] = useState(null);

  const load = () => localDb.getSupplierDetail(id).then(setDetail);
  useLocalReload(load, [id]);

  async function saveSupplier(data) {
    await localDb.saveSupplier(data);
    setEditing(null);
    markSyncPending();
    load();
  }

  if (!detail) return <Page title="供应商详情"><EmptyState text="未找到供应商" /></Page>;
  const { supplier, stats } = detail;
  return (
    <Page title="供应商详情" subtitle={supplier.supplierDisplayName || supplier.displayName || supplier.name || '未命名供应商'} action={<button type="button" onClick={() => setEditing(supplier)}>编辑供应商</button>}>
      <Section title="基本信息">
        <Info label="中文公司名" value={supplier.supplierNameChinese || '-'} />
        <Info label="英文公司名" value={supplier.supplierNameEnglish || '-'} />
        <Info label="供应商名称" value={supplier.supplierDisplayName || supplier.displayName || supplier.name || '-'} />
        <Info label="联系人" value={supplier.contactName || '-'} />
        <Info label="电话" value={supplier.phone || '-'} />
        <Info label="地址" value={supplier.address || '-'} />
        <Info label="备注" value={supplier.notes || '-'} />
      </Section>
      <Section title="统计信息">
        <Info label="总采购金额" value={money(stats.totalPurchaseAmount)} />
        <Info label="总采购数量" value={numberText(stats.totalPurchaseQty)} />
        <Info label="总发票数量" value={stats.invoiceCount} />
        <Info label="平均订单金额" value={money(stats.averageOrderAmount)} />
        <Info label="最近采购日期" value={stats.recentPurchaseDate || '-'} />
        <Info label="最近采购金额" value={money(stats.recentPurchaseAmount)} />
      </Section>
      <Section title="供应商采购管理">
        <ActionLink to={`/suppliers/${encodeURIComponent(id)}/invoices`} icon={<FileText />} title="历史发票" subtitle="筛选并查看该供应商所有发票" />
        <ActionLink to={`/suppliers/${encodeURIComponent(id)}/products`} icon={<ShoppingCart />} title="采购商品" subtitle="查看该供应商商品价格、次数、数量" />
      </Section>
      {editing && <SupplierDialog supplier={editing} onClose={() => setEditing(null)} onSave={saveSupplier} />}
    </Page>
  );
}

function SupplierProductsPage() {
  const { id } = useParams();
  const [sortBy, setSortBy] = useState('recent');
  const [rows, setRows] = useState([]);

  useLocalReload(() => localDb.getSupplierProducts(id, sortBy).then(setRows), [id, sortBy]);

  return (
    <Page title="供应商采购商品">
      <Section title="排序">
        <div className="segmented-control">
          {[
            ['recent', '最近采购'],
            ['minPrice', '最低价'],
            ['maxPrice', '最高价'],
            ['count', '采购次数'],
            ['quantity', '采购数量']
          ].map(([value, label]) => (
            <button key={value} className={sortBy === value ? 'active' : ''} onClick={() => setSortBy(value)}>{label}</button>
          ))}
        </div>
      </Section>
      <Section title="采购商品">
        {rows.length === 0 && <EmptyState text="暂无采购商品" />}
        {rows.map((row) => (
          <div className="detail-item" key={row.productKey}>
            <div className="split"><strong>{row.productName}</strong><strong>{money(row.recentPrice)}</strong></div>
            <p>最低 {money(row.minPrice)} · 最高 {money(row.maxPrice)} · 平均 {money(row.averagePrice)}</p>
            <p>采购次数 {row.purchaseCount} · 总数量 {numberText(row.totalQty)} · 最近采购 {row.recentPurchaseDate || '-'}</p>
          </div>
        ))}
      </Section>
    </Page>
  );
}

function PurchaseAnalysisPage() {
  const [analytics, setAnalytics] = useState({ supplierRanking: [], productRanking: [], monthly: [], lowestPrices: [] });

  useLocalReload(() => localDb.getPurchaseAnalytics().then(setAnalytics));

  const priceTrendRows = analytics.lowestPrices.slice(0, 8);

  return (
    <Page title="采购分析" subtitle="从本地 IndexedDB 汇总采购金额、商品数量、月度趋势和历史最低价">
      {analytics.pendingOrAbnormalCount > 0 && analytics.supplierRanking.length === 0 && (
        <Section title="需要先处理发票">
          <p className="warning-text">当前有 {analytics.pendingOrAbnormalCount} 张待确认/异常发票，确认后会进入正式采购分析。</p>
          <div className="row-actions">
            <Link className="secondary-button" to="/invoices?filter=pending">查看待确认发票</Link>
            <Link className="secondary-button" to="/invoices?filter=abnormal">查看异常发票</Link>
          </div>
        </Section>
      )}
      <Section title="供应商采购排名">
        {analytics.supplierRanking.length === 0 && <EmptyState text="暂无供应商采购数据" />}
        {analytics.supplierRanking.slice(0, 20).map((row) => (
          <div className="detail-item" key={row.supplierName}>
            <div className="split"><strong>{row.supplierName}</strong><strong>{money(row.amount)}</strong></div>
            <p>采购次数 {row.count} · 平均订单金额 {money(row.averageOrderAmount)}</p>
          </div>
        ))}
      </Section>
      <Section title="商品采购排名">
        {analytics.productRanking.length === 0 && <EmptyState text="暂无商品采购数据" />}
        {analytics.productRanking.slice(0, 20).map((row) => (
          <div className="detail-item" key={row.productName}>
            <div className="split"><strong>{row.productName}</strong><strong>{money(row.amount)}</strong></div>
            <p>采购数量 {numberText(row.quantity)}</p>
          </div>
        ))}
      </Section>
      <Section title="月度采购分析">
        {analytics.monthly.length === 0 && <EmptyState text="暂无月度数据" />}
        {analytics.monthly.map((row) => (
          <div className="detail-item" key={row.month}>
            <div className="split"><strong>{row.month}</strong><strong>{money(row.amount)}</strong></div>
            <p>采购数量 {numberText(row.quantity)}</p>
          </div>
        ))}
      </Section>
      <Section title="价格趋势图">
        {priceTrendRows.length === 0 && <EmptyState text="暂无价格趋势数据" />}
        <div className="trend-list">
          {priceTrendRows.map((row) => (
            <div className="trend-row" key={`${row.productName}-${row.invoiceDate}`}>
              <span>{row.productName}</span>
              <strong>{money(row.price)}</strong>
            </div>
          ))}
        </div>
      </Section>
      <Section title="最低采购价分析">
        {analytics.lowestPrices.length === 0 && <EmptyState text="暂无最低价数据" />}
        {analytics.lowestPrices.slice(0, 30).map((row) => (
          <div className="detail-item" key={`${row.productName}-${row.invoiceId}`}>
            <div className="split"><strong>{row.productName}</strong><strong>{money(row.price)}</strong></div>
            <p>{row.supplierName} · {row.invoiceDate || '-'} · 发票 {row.invoiceNo || '-'}</p>
            {row.invoiceId && <Link className="secondary-button" to={`/invoices/${encodeURIComponent(row.invoiceId)}`}>查看发票</Link>}
          </div>
        ))}
      </Section>
    </Page>
  );
}

function SupplierPage() {
  const [suppliers, setSuppliers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [templateSupplier, setTemplateSupplier] = useState(null);
  const [mergeSupplier, setMergeSupplier] = useState(null);
  const [message, setMessage] = useState('');

  const load = () => localDb.getSuppliers().then(setSuppliers);
  useLocalReload(load);

  async function saveSupplier(data) {
    await localDb.saveSupplier(data);
    setEditing(null);
    markSyncPending();
    load();
  }

  async function deleteSupplier(supplier) {
    if (!confirm(`删除供应商「${supplier.supplierDisplayName || supplier.displayName || supplier.name}」？`)) return;
    await localDb.deleteSupplier(supplier);
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
              <h3>{supplier.supplierDisplayName || supplier.displayName || supplier.name || '未命名供应商'}</h3>
              <p>{supplier.phone || '无电话'} · {supplier.email || '无邮箱'} · {statusText(supplier.syncStatus)}</p>
            </div>
            <div className="row-actions">
              <Link to={`/suppliers/${encodeURIComponent(supplier.id)}`}>详情</Link>
              <Link to={`/suppliers/${encodeURIComponent(supplier.id)}/invoices`}>历史发票</Link>
              <button onClick={() => setMergeSupplier(supplier)}>合并</button>
              <button onClick={() => setTemplateSupplier(supplier)}>模板</button>
              <button onClick={() => setEditing(supplier)}>编辑</button>
              <button className="text-danger" onClick={() => deleteSupplier(supplier)}>删除</button>
            </div>
          </div>
        ))}
      </div>
      {editing && <SupplierDialog supplier={editing} onClose={() => setEditing(null)} onSave={saveSupplier} />}
      {templateSupplier && <TemplateDialog supplier={templateSupplier} onClose={() => setTemplateSupplier(null)} />}
      {mergeSupplier && <MergeSupplierDialog supplier={mergeSupplier} suppliers={suppliers} onClose={() => setMergeSupplier(null)} onMerged={() => { setMergeSupplier(null); load(); }} />}
    </Page>
  );
}

function MergeSupplierDialog({ supplier, suppliers, onClose, onMerged }) {
  const [targetId, setTargetId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const candidates = suppliers.filter((entry) => entry.id !== supplier.id);

  async function merge() {
    if (!targetId) {
      setMessage('请选择目标供应商');
      return;
    }
    setLoading(true);
    setMessage('合并中...');
    try {
      if (navigator.onLine) {
        await api.mergeSupplier(supplier.id, targetId);
      } else {
        await localDb.mergeSuppliers(supplier.id, targetId);
      }
      markSyncPending();
      setMessage('合并成功');
      onMerged?.();
    } catch (error) {
      setMessage(error.message || '合并失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog title="合并供应商" onClose={onClose}>
      <Section title="源供应商">
        <Info label="名称" value={supplier.supplierDisplayName || supplier.displayName || supplier.name || '-'} />
        <Info label="标准名" value={supplier.normalizedName || '-'} />
      </Section>
      <Section title="目标供应商">
        <label className="field">
          <span>合并到</span>
          <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <option value="">请选择目标供应商</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.supplierDisplayName || candidate.displayName || candidate.name}</option>
            ))}
          </select>
        </label>
        {message && <p className={message.includes('失败') ? 'error' : 'hint'}>{message}</p>}
      </Section>
      <div className="dialog-actions">
        <button className="secondary-button" disabled={loading} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={loading || !targetId} onClick={merge}>{loading ? '合并中...' : '确认合并'}</button>
      </div>
    </Dialog>
  );
}

function SupplierInvoiceHistoryPage() {
  const { id } = useParams();
  const [filters, setFilters] = useState({ dateFrom: '', dateTo: '', invoiceNo: '', totalAmount: '', amountMin: '', amountMax: '', hasGifts: false, hasDiscounts: false, hasWarnings: false, isMultipage: false });
  const [rows, setRows] = useState([]);
  const [supplier, setSupplier] = useState(null);

  const load = async () => {
    const suppliers = await localDb.getSuppliers();
    const found = suppliers.find((entry) => [entry.id, entry.localId, entry.serverId].includes(id));
    setSupplier(found || null);
    setRows(await localDb.getSupplierInvoices(id, filters));
  };
  useLocalReload(load, [id, JSON.stringify(filters)]);

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
  }
  const historyStats = {
    invoiceCount: rows.length,
    totalAmount: rows.reduce((sum, invoice) => sum + Number(invoice.totalAmount || 0), 0),
    recentDate: rows[0]?.invoiceDate || ''
  };

  return (
    <Page title="历史发票" subtitle={supplier?.supplierDisplayName || supplier?.displayName || supplier?.name || '供应商'}>
      <Section title="汇总">
        <Info label="发票数量" value={historyStats.invoiceCount} />
        <Info label="累计采购金额" value={money(historyStats.totalAmount)} />
        <Info label="最近采购时间" value={historyStats.recentDate || '-'} />
      </Section>
      <Section title="筛选">
        <div className="grid-2">
          <label className="field"><span>开始日期</span><input type="date" value={filters.dateFrom} onChange={(event) => updateFilter('dateFrom', event.target.value)} /></label>
          <label className="field"><span>结束日期</span><input type="date" value={filters.dateTo} onChange={(event) => updateFilter('dateTo', event.target.value)} /></label>
          <label className="field"><span>发票号</span><input value={filters.invoiceNo} onChange={(event) => updateFilter('invoiceNo', event.target.value)} /></label>
          <label className="field"><span>总金额</span><input type="number" value={filters.totalAmount} onChange={(event) => updateFilter('totalAmount', event.target.value)} /></label>
          <label className="field"><span>最低金额</span><input type="number" value={filters.amountMin} onChange={(event) => updateFilter('amountMin', event.target.value)} /></label>
          <label className="field"><span>最高金额</span><input type="number" value={filters.amountMax} onChange={(event) => updateFilter('amountMax', event.target.value)} /></label>
        </div>
        <div className="row-actions">
          <label><input type="checkbox" checked={filters.hasGifts} onChange={(event) => updateFilter('hasGifts', event.target.checked)} /> 有赠品</label>
          <label><input type="checkbox" checked={filters.hasDiscounts} onChange={(event) => updateFilter('hasDiscounts', event.target.checked)} /> 有折扣</label>
          <label><input type="checkbox" checked={filters.hasWarnings} onChange={(event) => updateFilter('hasWarnings', event.target.checked)} /> 有异常</label>
          <label><input type="checkbox" checked={filters.isMultipage} onChange={(event) => updateFilter('isMultipage', event.target.checked)} /> 多页发票</label>
          <button className="secondary-button" type="button" onClick={() => api.downloadSupplierInvoicesCsv(id, filters)}>导出 CSV</button>
          <button className="secondary-button" type="button" onClick={() => api.downloadSupplierInvoicesExcel(id, filters)}>导出 Excel</button>
        </div>
      </Section>
      <Section title="发票">
        {rows.length === 0 && <EmptyState text="暂无历史发票" />}
        <div className="card-list">
          {rows.map((invoice) => (
            <Link className="row-card" to={`/invoices/${encodeURIComponent(invoice.id)}`} key={invoice.id}>
              <div>
                <h3>{invoice.invoiceNo || '无发票号'}</h3>
                <p>{invoice.invoiceDate || '-'} · {money(invoice.totalAmount)} · {invoice.itemCount || 0} 行</p>
                <p>{invoice.hasGifts ? '有赠品 · ' : ''}{invoice.hasDiscounts ? '有折扣 · ' : ''}{invoice.isMultipage ? '多页发票 · ' : ''}{duplicateStatusLabel(invoice.duplicateStatus)}</p>
              </div>
              <ChevronRight />
            </Link>
          ))}
        </div>
      </Section>
    </Page>
  );
}

function AccountConnectionPage() {
  const session = getAuthSession();
  const [keyword, setKeyword] = useState('');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [sent, setSent] = useState([]);
  const [received, setReceived] = useState([]);
  const [loading, setLoading] = useState(false);

  async function loadRequests() {
    if (!session?.token) return;
    const [sentData, receivedData] = await Promise.all([
      api.getSentConnections(),
      api.getReceivedConnections()
    ]);
    setSent(sentData.requests || []);
    setReceived(receivedData.requests || []);
  }

  useEffect(() => {
    loadRequests().catch((error) => setNotice(error.message || '读取账户连接记录失败'));
  }, [session?.token]);

  async function searchUsers(event) {
    event.preventDefault();
    setNotice('');
    if (!keyword.trim()) return;
    setLoading(true);
    try {
      const data = await api.searchUsers(keyword.trim());
      setSearchResults(data.users || []);
    } catch (error) {
      setNotice(error.message || '搜索账户失败');
    } finally {
      setLoading(false);
    }
  }

  async function requestConnection(targetUserId) {
    setNotice('');
    try {
      await api.requestAccountConnection({ targetUserId, message });
      setNotice('连接申请已发送');
      setMessage('');
      await loadRequests();
    } catch (error) {
      setNotice(error.message || '发送连接申请失败');
    }
  }

  async function decide(id, action) {
    setNotice('');
    try {
      if (action === 'approve') await api.approveConnection(id);
      else await api.rejectConnection(id);
      setNotice(action === 'approve' ? '已同意连接申请' : '已拒绝连接申请');
      await loadRequests();
    } catch (error) {
      setNotice(error.message || '处理申请失败');
    }
  }

  if (!session?.token) {
    return (
      <Page title="账户连接" subtitle="搜索账户并建立连接关系">
        <p className="warning-text">请先登录后再使用账户连接功能。</p>
      </Page>
    );
  }

  return (
    <Page title="账户连接" subtitle="搜索其他账户，发送或处理连接申请">
      {notice && <p className={notice.includes('失败') || notice.includes('未配置') || notice.includes('错误') ? 'error' : 'success-text'}>{notice}</p>}
      <Section title="搜索账户">
        <form className="toolbar" onSubmit={searchUsers}>
          <input placeholder="邮箱、用户名、公司名" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          <button className="primary-button" disabled={loading}>{loading ? '搜索中...' : '搜索'}</button>
        </form>
        <label className="field"><span>申请备注</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} /></label>
        <div className="card-list">
          {searchResults.map((user) => (
            <div className="row-card" key={user.id}>
              <div>
                <h3>{user.companyName || user.username}</h3>
                <p>{user.username} · {user.email}</p>
              </div>
              <button type="button" onClick={() => requestConnection(user.id)}>申请连接</button>
            </div>
          ))}
          {searchResults.length === 0 && <EmptyState text="请输入关键词搜索账户" />}
        </div>
      </Section>

      <Section title="我发出的申请">
        <ConnectionList requests={sent} direction="sent" />
      </Section>

      <Section title="收到的申请">
        <ConnectionList requests={received} direction="received" onDecide={decide} />
      </Section>
    </Page>
  );
}

function ConnectionList({ requests, direction, onDecide }) {
  if (!requests.length) return <EmptyState text="暂无记录" />;
  return (
    <div className="card-list">
      {requests.map((request) => {
        const other = direction === 'sent' ? request.target : request.requester;
        return (
          <div className="row-card" key={request.id}>
            <div>
              <h3>{other?.companyName || other?.username || '未知账户'}</h3>
              <p>{other?.username || ''} · {other?.email || ''}</p>
              {request.message && <p>{request.message}</p>}
              <p>状态：{connectionStatusLabel(request.status)} · {request.createdAt ? new Date(request.createdAt).toLocaleString() : ''}</p>
            </div>
            {direction === 'received' && request.status === 'pending' && (
              <div className="row-actions">
                <button type="button" onClick={() => onDecide(request.id, 'approve')}>同意</button>
                <button type="button" onClick={() => onDecide(request.id, 'reject')}>拒绝</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function connectionStatusLabel(status) {
  if (status === 'approved') return '已同意';
  if (status === 'rejected') return '已拒绝';
  return '待处理';
}

function MemberManagementPanel() {
  const [members, setMembers] = useState([]);
  const [limits, setLimits] = useState({});
  const [editingMember, setEditingMember] = useState(null);
  const [resetMember, setResetMember] = useState(null);
  const [message, setMessage] = useState('');
  const session = getAuthSession();

  async function loadMembers() {
    const data = await api.getMembers();
    setMembers(data.members || []);
    setLimits(data.limits || {});
  }

  useEffect(() => {
    loadMembers().catch((error) => setMessage(error.message || '读取成员失败'));
  }, []);

  async function saveMember(form) {
    try {
      if (form.id) await api.updateMember(form.id, form);
      else await api.createMember(form);
      setEditingMember(null);
      setMessage('成员已保存');
      await loadMembers();
    } catch (error) {
      setMessage(error.message || '保存成员失败');
    }
  }

  async function resetPassword(member, password) {
    try {
      await api.resetMemberPassword(member.id, password);
      setResetMember(null);
      setMessage('密码已重置');
    } catch (error) {
      setMessage(error.message || '重置密码失败');
    }
  }

  async function toggleStatus(member) {
    try {
      if (member.status === 'disabled') await api.enableMember(member.id);
      else await api.disableMember(member.id);
      await loadMembers();
    } catch (error) {
      setMessage(error.message || '状态修改失败');
    }
  }

  async function deleteMember(member) {
    if (!confirm(`确认删除或停用成员 ${member.email}？`)) return;
    try {
      await api.deleteMember(member.id);
      setMessage('成员已删除');
      await loadMembers();
    } catch (error) {
      setMessage(error.message || '删除成员失败');
    }
  }

  return (
    <Section title="成员管理">
      <div className="row-actions">
        <button className="primary-button" type="button" onClick={() => setEditingMember({ role: 'sales', status: 'active' })}>新增成员</button>
      </div>
      <p className="hint">管理员直接创建成员账号，把邮箱和初始密码发给成员。管理员上限 {limits.maxAdminUsers ?? '-'}，销售员上限 {limits.maxSalesUsers ?? '-'}。</p>
      {message && <p className={message.includes('失败') || message.includes('不能') ? 'error' : 'success-text'}>{message}</p>}
      <div className="card-list">
        {members.map((member) => {
          const isSelf = member.id === session?.user?.id;
          return (
            <div className="row-card" key={member.id}>
              <div>
                <h3>{member.name || member.email}</h3>
                <p>{member.email} · {memberRoleLabel(member.role)} · {memberStatusLabel(member.status)}</p>
                <p>最后登录：{member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString() : '-'} · 创建：{member.createdAt ? new Date(member.createdAt).toLocaleString() : '-'}</p>
              </div>
              <div className="row-actions">
                <button type="button" onClick={() => setEditingMember(member)}>编辑</button>
                <button type="button" onClick={() => setResetMember(member)}>重置密码</button>
                <button type="button" disabled={isSelf || member.role === 'super_admin'} onClick={() => toggleStatus(member)}>{member.status === 'disabled' ? '启用' : '禁用'}</button>
                <button type="button" className="text-danger" disabled={isSelf || member.role === 'super_admin'} onClick={() => deleteMember(member)}>删除</button>
              </div>
            </div>
          );
        })}
        {members.length === 0 && <EmptyState text="暂无成员" />}
      </div>
      {editingMember && (
        <MemberDialog
          member={editingMember}
          onClose={() => setEditingMember(null)}
          onSave={saveMember}
        />
      )}
      {resetMember && (
        <ResetPasswordDialog
          member={resetMember}
          onClose={() => setResetMember(null)}
          onSave={(password) => resetPassword(resetMember, password)}
        />
      )}
    </Section>
  );
}

function MemberDialog({ member, onClose, onSave }) {
  const isSuperAdmin = member.role === 'super_admin';
  const [form, setForm] = useState({
    id: member.id || '',
    name: member.name || '',
    email: member.email || '',
    password: '',
    role: isSuperAdmin ? 'super_admin' : (member.role || 'sales'),
    status: member.status || 'active',
    phone: member.phone || '',
    note: member.note || ''
  });
  return (
    <Dialog title={form.id ? '编辑成员' : '新增成员'} onClose={onClose}>
      <label className="field"><span>姓名</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label className="field"><span>邮箱</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
      {!form.id && <label className="field"><span>初始密码</span><input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>}
      <label className="field"><span>角色</span><select value={form.role} disabled={isSuperAdmin} onChange={(event) => setForm({ ...form, role: event.target.value })}>{isSuperAdmin && <option value="super_admin">超级管理员</option>}<option value="sales">销售员</option><option value="admin">管理员</option></select></label>
      <label className="field"><span>状态</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="active">启用</option><option value="disabled">禁用</option></select></label>
      <label className="field"><span>电话</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label className="field"><span>备注</span><textarea rows="2" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
      <button className="primary-button" type="button" onClick={() => onSave(form)}>保存</button>
    </Dialog>
  );
}

function ResetPasswordDialog({ member, onClose, onSave }) {
  const [password, setPassword] = useState('');
  return (
    <Dialog title={`重置密码 · ${member.email}`} onClose={onClose}>
      <label className="field"><span>新密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="primary-button" type="button" onClick={() => onSave(password)}>保存新密码</button>
    </Dialog>
  );
}

function memberRoleLabel(role) {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'admin') return '管理员';
  return '销售员';
}

function memberStatusLabel(status) {
  return status === 'disabled' ? '已禁用' : '启用';
}

function SettingsPage() {
  const [stats, setStats] = useState({});
  const [syncMessage, setSyncMessage] = useState('');
  const [cloudStatus, setCloudStatus] = useState(null);
  const [syncSnapshot, setSyncSnapshot] = useState(null);
  const [syncPrefs, setSyncPrefs] = useState({ autoSync: true, wifiOnly: false, allowCellular: false });
  const session = getAuthSession();
  const isAdmin = isAdminRole(session?.user?.role || '');
  const loadSyncCenter = async () => {
    const [snapshot, preferences] = await Promise.all([getSyncSnapshot(), getSyncPreferences()]);
    setSyncSnapshot(snapshot);
    setSyncPrefs(preferences);
  };
  const load = () => Promise.all([localDb.getStats().then(setStats), loadSyncCenter()]);
  useLocalReload(load);

  useEffect(() => {
    if (!navigator.onLine) return;
    api.syncStatus().then(setCloudStatus).catch(() => setCloudStatus(null));
  }, []);

  async function updateSyncPreference(patch) {
    const next = await setSyncPreferences({ ...syncPrefs, ...patch });
    setSyncPrefs(next);
    await loadSyncCenter();
  }

  async function clearData() {
    if (!confirm('确认清空本地测试数据并同步删除到云端？')) return;
    await localDb.softDeleteAll();
    markSyncPending();
    load();
  }

  async function runSyncNow() {
    setSyncMessage('正在同步...');
    const snapshot = await syncNow({ force: true, reason: 'manual' });
    setSyncMessage(snapshot.lastError ? `同步失败：${snapshot.lastError}` : '同步完成');
    api.syncStatus().then(setCloudStatus).catch(() => {});
    load();
  }

  async function restoreFromCloud() {
    setSyncMessage('正在从云端恢复...');
    const snapshot = await pullFromCloud({ full: true });
    setSyncMessage(snapshot.lastError ? `恢复失败：${snapshot.lastError}` : '云端资料已恢复到本机');
    api.syncStatus().then(setCloudStatus).catch(() => {});
    load();
  }

  async function clearCacheAndRestore() {
    if (!confirm('这只会清空本机 IndexedDB 缓存，不会删除云端数据。确认重新拉取云端资料？')) return;
    setSyncMessage('正在清空本地缓存并重新拉取...');
    const snapshot = await resetLocalCacheAndPull();
    setSyncMessage(snapshot.lastError ? `重新拉取失败：${snapshot.lastError}` : '已清空本地缓存并从云端重新拉取');
    api.syncStatus().then(setCloudStatus).catch(() => {});
    load();
  }

  async function cleanupSyncedCache() {
    const removed = await localDb.cleanupSyncedDeletedCache();
    setSyncMessage(`已清理 ${removed} 条已同步删除缓存`);
    load();
  }

  return (
    <Page title="设置/导出">
      <Section title="账户">
        <Info label="当前公司" value={session?.company?.name || session?.user?.companyName || '-'} />
        <Info label="当前用户" value={session?.user?.username || session?.user?.email || session?.user?.name || '-'} />
        <button className="secondary-button" type="button" onClick={() => setAuthSession(null)}>退出到登录/注册页面</button>
        <p className="hint">退出会清除本机保存的 token、user 和 company 信息。</p>
      </Section>
      {isAdmin && <MemberManagementPanel />}
      <Section title="同步">
        <div className="grid-2">
          <Info label="同步状态" value={syncSnapshot?.label || '-'} />
          <Info label="待同步总数" value={syncSnapshot?.pendingCount ?? 0} />
          <Info label="最后同步时间" value={syncSnapshot?.lastSyncAt || '-'} />
          <Info label="网络类型" value={syncSnapshot?.connection?.type || syncSnapshot?.connection?.effectiveType || 'unknown'} />
          <Info label="待同步发票" value={syncSnapshot?.pendingByTable?.invoices ?? 0} />
          <Info label="待同步商品明细" value={syncSnapshot?.pendingByTable?.invoice_items ?? 0} />
          <Info label="待同步商品" value={syncSnapshot?.pendingByTable?.products ?? 0} />
          <Info label="待同步价格历史" value={syncSnapshot?.pendingByTable?.price_history ?? 0} />
          <Info label="待同步供应商" value={syncSnapshot?.pendingByTable?.suppliers ?? 0} />
          <Info label="待同步模板" value={syncSnapshot?.pendingByTable?.supplier_templates ?? 0} />
        </div>
        <SwitchField label="自动同步" checked={Boolean(syncPrefs.autoSync)} onChange={(checked) => updateSyncPreference({ autoSync: checked })} />
        <SwitchField label="仅 WiFi 同步" checked={Boolean(syncPrefs.wifiOnly)} onChange={(checked) => updateSyncPreference({ wifiOnly: checked, allowCellular: checked ? false : syncPrefs.allowCellular })} />
        <SwitchField label="允许蜂窝网络同步" checked={Boolean(syncPrefs.allowCellular)} onChange={(checked) => updateSyncPreference({ allowCellular: checked, wifiOnly: checked ? false : syncPrefs.wifiOnly })} />
        <div className="row-actions">
          <button className="primary-button" type="button" onClick={runSyncNow}><RefreshCw size={16} />立即同步</button>
          <button className="secondary-button" type="button" onClick={restoreFromCloud}>从云端恢复</button>
          <button className="secondary-button" type="button" onClick={cleanupSyncedCache}>清理已同步缓存</button>
          <button className="secondary-button" type="button" onClick={clearCacheAndRestore}>清空本地缓存后重新拉取</button>
        </div>
        {syncMessage && <p className={syncMessage.includes('失败') ? 'error' : 'success-text'}>{syncMessage}</p>}
        {cloudStatus && (
          <div className="grid-2">
            <Info label="云端同步库" value={cloudStatus.backend || '-'} />
            <Info label="云端发票" value={cloudStatus.counts?.invoices ?? 0} />
            <Info label="云端供应商" value={cloudStatus.counts?.suppliers ?? 0} />
            <Info label="云端价格历史" value={cloudStatus.counts?.price_history ?? 0} />
          </div>
        )}
        <p className="hint">所有新增、修改和删除都会先写入本机 IndexedDB；联网后自动同步到云端。</p>
      </Section>
      <Section title="导出">
        <button className="primary-button" type="button" onClick={() => api.downloadExportCsv()}><Upload size={18} />导出云端 CSV</button>
        <button className="secondary-button" type="button" onClick={() => api.downloadExportExcel()}><Upload size={18} />导出云端 Excel</button>
        <p className="hint">CSV 导出来自后端云端数据库；离线时请先同步后再导出。</p>
      </Section>
      <Section title="本地数据库统计">
        <Info label="供应商" value={stats.suppliers ?? 0} />
        <Info label="鍙戠エ" value={stats.invoices ?? 0} />
        <Info label="商品明细" value={stats.invoice_items ?? 0} />
        <Info label="商品" value={stats.products ?? 0} />
        <Info label="价格历史" value={stats.price_history ?? 0} />
        <Info label="供应商模板" value={stats.supplier_templates ?? 0} />
      </Section>
      <Section title="测试数据">
        <button className="danger-button" onClick={clearData}><Trash2 size={16} />清空测试数据</button>
      </Section>
    </Page>
  );
}

function SupplierDialog({ supplier, onClose, onSave }) {
  const [form, setForm] = useState(supplier);
  return (
    <Dialog title="编辑供应商" onClose={onClose}>
      {['supplierNameChinese', 'supplierNameEnglish', 'supplierDisplayName', 'name', 'displayName', 'normalizedName', 'aliases', 'contactName', 'phone', 'email', 'address', 'notes'].map((field) => (
        <label className="field" key={field}>
          <span>{({ supplierNameChinese: '中文公司名', supplierNameEnglish: '英文公司名', supplierDisplayName: '显示名称', name: '名称', displayName: '旧显示名称', normalizedName: '标准化名称', aliases: '别名', contactName: '联系人', phone: '电话', email: '邮箱', address: '地址', notes: '备注' })[field]}</span>
          <input value={form[field] || ''} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />
        </label>
      ))}
      <button className="primary-button" onClick={() => onSave(form)}>保存</button>
    </Dialog>
  );
}

function TemplateDialog({ supplier, onClose }) {
  const [template, setTemplate] = useState(emptyTemplate(supplier.supplierDisplayName || supplier.displayName || supplier.name));

  useEffect(() => {
    localDb.getTemplate(supplier.id).then((data) => setTemplate(data || emptyTemplate(supplier.supplierDisplayName || supplier.displayName || supplier.name)));
  }, [supplier]);

  async function save() {
    await localDb.saveTemplate(supplier.id, template);
    markSyncPending();
    onClose();
  }

  return (
    <Dialog title={`${supplier.supplierDisplayName || supplier.displayName || supplier.name} · 识别模板`} onClose={onClose}>
      {['supplierNameKeywords', 'invoiceNoKeywords', 'dateKeywords', 'itemTableStartKeywords', 'itemTableEndKeywords'].map((field) => (
        <label className="field" key={field}>
          <span>{field}</span>
          <textarea rows="2" value={template[field] || ''} onChange={(event) => setTemplate({ ...template, [field]: event.target.value })} />
        </label>
      ))}
      <div className="grid-2">
        {['itemNameColumnIndex', 'quantityColumnIndex', 'unitColumnIndex', 'unitPriceColumnIndex', 'totalPriceColumnIndex'].map((field) => (
          <label className="field" key={field}>
            <span>{field}</span>
            <input type="number" value={template[field] ?? 0} onChange={(event) => setTemplate({ ...template, [field]: Number(event.target.value) })} />
          </label>
        ))}
      </div>
      <label className="field"><span>备注</span><textarea rows="2" value={template.notes || ''} onChange={(event) => setTemplate({ ...template, notes: event.target.value })} /></label>
      <button className="primary-button" onClick={save}>保存模板</button>
    </Dialog>
  );
}

function Page({ title, subtitle, action, children }) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}

function Section({ title, children }) {
  return <section className="section"><h2>{title}</h2>{children}</section>;
}

function CollapsibleSection({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="section">
      <button type="button" className="collapsible-toggle" onClick={() => setOpen((value) => !value)}>
        <span>{title}</span>
        <span>{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="collapsible-content">{children}</div>}
    </section>
  );
}

function ActionLink({ to, icon, title, subtitle }) {
  return (
    <Link className="action-row" to={to}>
      <span className="action-icon">{icon}</span>
      <span><strong>{title}</strong><small>{subtitle}</small></span>
      <ChevronRight />
    </Link>
  );
}

function InvoiceImageViewer({ invoice, onUpdated }) {
  const fileInputRef = useRef(null);
  const [imageUrl, setImageUrl] = useState('');
  const [diagnostic, setDiagnostic] = useState({
    source: 'Unknown',
    size: 0,
    status: '检查中',
    message: ''
  });
  const [uploading, setUploading] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    let objectUrl = '';
    let cancelled = false;

    async function resolveImage() {
      const imagePath = invoice?.imagePath || '';
      const rawImageUrl = invoice?.imageUrl || '';
      const imageId = invoice?.imageId || '';
      if (!imagePath && !rawImageUrl && !imageId) {
        setImageUrl('');
        setDiagnostic({ source: 'Unknown', size: 0, status: '缺失', message: '图片不存在' });
        return;
      }

      if (String(imagePath).startsWith('blob:')) {
        setImageUrl('');
        setDiagnostic({ source: 'Local', size: 0, status: '缺失', message: 'Blob URL 已失效，请重新上传图片。' });
        return;
      }

      if (String(imagePath).startsWith('indexeddb:') || imageId) {
        const image = await localDb.getInvoiceImage(invoice);
        if (cancelled) return;
        if (!image?.imageBlob) {
          setImageUrl('');
          setDiagnostic({ source: 'IndexedDB', size: 0, status: '缺失', message: '图片不存在' });
          return;
        }
        objectUrl = URL.createObjectURL(image.imageBlob);
        setImageUrl(objectUrl);
        setDiagnostic({
          source: 'IndexedDB',
          size: image.size || image.imageBlob.size || 0,
          status: '正常',
          message: ''
        });
        return;
      }

      const resolvedUrl = api.fileUrl(imagePath || rawImageUrl || '');
      setImageUrl(resolvedUrl);
      setDiagnostic({
        source: /^https?:\/\//.test(resolvedUrl) || String(imagePath).startsWith('/uploads') ? 'Server' : 'Local',
        size: 0,
        status: '加载中',
        message: ''
      });
    }

    resolveImage().catch((error) => {
      if (!cancelled) {
        console.error('Invoice image resolve failed', error);
        setImageUrl('');
        setDiagnostic({ source: 'Unknown', size: 0, status: '损坏', message: error.message || '图片读取失败' });
      }
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [invoice]);

  async function rebindImage(file) {
    if (!file) return;
    setUploading(true);
    try {
      if (navigator.onLine) {
        const data = new FormData();
        data.append('image', file);
        const result = await api.uploadInvoiceImage(invoice.id, data);
        await localDb.updateInvoiceImageFields(invoice.id, {
          imagePath: result.imagePath,
          imageId: '',
          imageUrl: ''
        });
        markSyncPending();
      } else {
        const image = await localDb.saveInvoiceImage({ invoiceId: invoice.id, file, source: 'IndexedDB' });
        await localDb.updateInvoiceImageFields(invoice.id, {
          imagePath: `indexeddb:${image.id}`,
          imageId: image.id,
          imageUrl: ''
        });
      }
      await onUpdated?.();
    } catch (error) {
      console.error('Invoice image rebind failed', error);
      setDiagnostic((current) => ({
        ...current,
        status: '缺失',
        message: error.message || '图片保存失败，请重新上传。'
      }));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      {imageUrl ? (
        <button type="button" className="image-open-button" onClick={() => setFullScreen(true)}>
          <img
            className="invoice-image"
            src={imageUrl}
            alt="发票原图"
            onLoad={() => setDiagnostic((current) => ({ ...current, status: '正常', message: '' }))}
            onError={() => {
              console.error('Invoice image load failed', imageUrl);
              setImageUrl('');
              setDiagnostic((current) => ({
                ...current,
                status: current.source === 'Server' ? '缺失' : '损坏',
                message: current.source === 'Server' ? '图片已丢失' : '图片损坏'
              }));
            }}
          />
        </button>
      ) : (
        <EmptyState text={diagnostic.message || '图片不存在'} />
      )}
      <div className="image-diagnostics">
        <Info label="图片来源" value={diagnostic.source} />
        <Info label="图片大小" value={diagnostic.size ? formatBytes(diagnostic.size) : '-'} />
        <Info label="图片状态" value={diagnostic.status} />
        {diagnostic.message && <p className="error">{diagnostic.message}</p>}
        <button type="button" className="secondary-button" onClick={() => setShowDebug((value) => !value)}>
          {showDebug ? '隐藏调试信息' : '显示调试信息'}
        </button>
        {showDebug && (
          <div className="debug-fields">
            <Info label="invoice.imageUrl" value={invoice.imageUrl || '-'} />
            <Info label="invoice.imagePath" value={invoice.imagePath || '-'} />
            <Info label="invoice.imageId" value={invoice.imageId || '-'} />
          </div>
        )}
      </div>
      <div className="row-actions">
        {imageUrl && <button className="secondary-button" type="button" onClick={() => setFullScreen(true)}>查看原图</button>}
        <button className="secondary-button" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? '上传中...' : '重新上传图片'}
        </button>
        <input
          ref={fileInputRef}
          className="hidden-file-input"
          type="file"
          accept="image/*"
          onChange={(event) => {
            rebindImage(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
      {fullScreen && imageUrl && (
        <div className="image-fullscreen" role="dialog" aria-modal="true">
          <div className="image-fullscreen-toolbar">
            <span>{invoice.pageCount ? `Page ${invoice.pageNumber || 1} / ${invoice.pageCount}` : '发票原图'}</span>
            <button type="button" onClick={() => setFullScreen(false)}>关闭</button>
          </div>
          <div className="image-fullscreen-scroll">
            <img src={imageUrl} alt="发票原图全屏预览" />
          </div>
        </div>
      )}
    </div>
  );
}
function Info({ label, value }) {
  return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>;
}

function Metric({ label, value, to }) {
  const content = <><span>{label}</span><strong>{value}</strong></>;
  if (to) return <Link className="metric-card metric-link" to={to}>{content}</Link>;
  return <div className="metric-card">{content}</div>;
}

function SwitchField({ label, checked, onChange }) {
  return (
    <label className="switch-field">
      <span>{label}</span>
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
  return <div className="empty-state">{text}</div>;
}

function Dialog({ title, onClose, children }) {
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog">
        <div className="dialog-header"><h2>{title}</h2><button onClick={onClose}>关闭</button></div>
        {children}
      </div>
    </div>
  );
}

function BottomNav() {
  const items = [
    ['/', Home, '首页'],
    ['/invoices', FileText, '发票'],
    ['/supplier-center', Building2, '采购'],
    ['/products', Search, '查询'],
    ['/analytics', BarChart3, '分析'],
    ['/settings', Settings, '设置']
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

function useLocalReload(loader, deps = []) {
  useEffect(() => {
    let cancelled = false;
    const run = () => Promise.resolve(loader()).catch(() => {}).then(() => undefined);
    const guardedRun = () => {
      if (!cancelled) run();
    };
    guardedRun();
    window.addEventListener('local-db-change', guardedRun);
    window.addEventListener('sync-state-change', guardedRun);
    return () => {
      cancelled = true;
      window.removeEventListener('local-db-change', guardedRun);
      window.removeEventListener('sync-state-change', guardedRun);
    };
  }, deps);
}

function statusText(status) {
  if (status === 'pending') return '待同步';
  if (status === 'deleted') return '待删除同步';
  if (status === 'conflict') return '需要人工确认';
  return '已同步';
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
  if (['duplicate', 'confirmed'].includes(String(invoice.duplicateStatus || '').toLowerCase())) return '重复';
  if (String(invoice.status || '').toLowerCase() === 'duplicate') return '重复';
  if (isConfirmedInvoice(invoice)) return '已确认';
  if (isAbnormalInvoice(invoice)) return '异常';
  if (isPendingInvoice(invoice)) return '待确认';
  if (String(invoice.status || '').toLowerCase() === 'merged') return '已合并';
  return invoice.status || '正常';
}

function isAdminRole(role) {
  return ['admin', 'super_admin'].includes(String(role || '').toLowerCase());
}

function sourceLabel(source) {
  if (source === 'template') return '妯℃澘';
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
  if (entry.status === 'recognizing') return '🔄 识别中';
  if (entry.status === 'failed') return '❌ 失败';
  if (entry.status === 'success' && entry.autoMerged) return '✅ 已自动合并';
  if (entry.status === 'success' && (entry.duplicateStatus === 'confirmed' || entry.isDuplicate)) return '重复发票';
  if (entry.status === 'success' && entry.duplicateStatus === 'possible') return '疑似重复，请确认';
  if (entry.status === 'success' && entry.sameInvoiceGroup) return '同发票号不同金额，可能是多页/同批次';
  if (entry.status === 'success') return '✅ 已完成';
  return '⏳ 等待中';
}

function taskStatusToEntryStatus(status) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'failed';
  if (status === 'processing') return 'recognizing';
  return 'pending';
}

function recognitionTaskStatusText(status) {
  if (status === 'waiting' || status === 'pending') return '⏳ 等待中';
  if (status === 'processing') return '🔄 识别中';
  if (status === 'completed') return '✅ 已完成';
  if (status === 'failed') return '❌ 失败';
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
        notes.set(item.entry.id, `杩炵画鍙戠エ鍙凤細${first} - ${last}`);
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
      name: item.promoGroupName || '需要人工确认分摊组',
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
    .filter((group) => group.freeQty > 0 || group.name === '需要人工确认分摊组')
    .map((group) => ({
      ...group,
      originalUnitCost: group.chargedQty > 0 ? group.invoiceAmount / group.chargedQty : 0,
      effectiveUnitCost: group.actualQty > 0 ? group.invoiceAmount / group.actualQty : 0
    }));
}
