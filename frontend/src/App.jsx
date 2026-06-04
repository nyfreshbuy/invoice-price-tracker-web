import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import {
  Building2,
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
  Trash2,
  Upload
} from 'lucide-react';
import { api, getAuthSession, setAuthSession } from './api.js';
import { generateId, localDb, today } from './localDb.js';
import { getSyncSnapshot, startAutoSync, syncNow } from './syncService.js';

const emptyItem = () => ({
  productNameOriginal: '',
  productNameNormalized: '',
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
  isFreeItem: false,
  isDiscountLine: false,
  freeReason: '',
  notes: ''
});

const emptySupplier = {
  name: '',
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
  const [syncState, setSyncState] = useState({ label: '已同步', pendingCount: 0, online: navigator.onLine, syncing: false });

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
    const refreshAuth = () => setAuthState(getAuthSession());
    window.addEventListener('auth-change', refreshAuth);
    return () => window.removeEventListener('auth-change', refreshAuth);
  }, []);

  async function handleSyncNow() {
    setSyncState(await syncNow());
  }

  function handleLogout() {
    setAuthSession(null);
  }

  if (!authSession) {
    return <AuthPage onAuthenticated={setAuthState} />;
  }

  return (
    <div className="app-shell">
      <SyncBar state={syncState} session={authSession} onSyncNow={handleSyncNow} onLogout={handleLogout} />
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/invoices" element={<InvoiceListPage />} />
          <Route path="/invoices/new" element={<InvoiceFormPage />} />
          <Route path="/invoices/batch" element={<BatchImportPage />} />
          <Route path="/recognition-tasks" element={<RecognitionTaskListPage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPageWithGifts />} />
          <Route path="/products" element={<ProductSearchPage />} />
          <Route path="/products/:name" element={<ProductDetailPage />} />
          <Route path="/suppliers" element={<SupplierPage />} />
          <Route path="/suppliers/:id/invoices" element={<SupplierInvoiceHistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <BottomNav />
    </div>
  );
}

function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ companyName: '', name: '', email: '', password: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const session = mode === 'register'
        ? await api.register(form)
        : await api.login({ email: form.email, password: form.password });
      setAuthSession(session);
      onAuthenticated(session);
      window.dispatchEvent(new Event('auth-change'));
      syncNow();
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
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册门店</button>
        </div>
        {mode === 'register' && (
          <>
            <label className="field"><span>公司/门店名称</span><input value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} /></label>
            <label className="field"><span>姓名</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          </>
        )}
        <label className="field"><span>邮箱</span><input type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="field"><span>密码</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        {message && <p className="error">{message}</p>}
        <button className="primary-button" disabled={loading}>{loading ? '处理中...' : mode === 'login' ? '登录' : '注册并进入'}</button>
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
        <ActionLink to="/settings" icon={<Settings />} title="设置/导出" subtitle="查看本地统计、导出云端 CSV" />
      </Section>
    </Page>
  );
}

function InvoiceListPage() {
  const [items, setItems] = useState([]);
  useLocalReload(() => localDb.getInvoices().then(setItems));

  return (
    <Page title="发票列表" action={<div className="row-actions"><Link className="icon-button" to="/invoices/batch"><Upload size={18} />批量</Link><Link className="icon-button" to="/invoices/new"><Plus size={18} />新增</Link></div>}>
      {items.length === 0 && <EmptyState text="暂无发票" />}
      <div className="card-list">
        {items.map((invoice) => (
          <Link className="row-card" to={`/invoices/${invoice.id}`} key={invoice.id}>
            <div>
              <h3>{invoice.supplierName || '未命名供应商'}</h3>
              <p>日期 {invoice.invoiceDate || '-'} · 金额 {money(invoice.totalAmount)}</p>
              <p>{statusText(invoice.syncStatus)}{invoice.invoiceNo ? ` · 发票号 ${invoice.invoiceNo}` : ''}</p>
            </div>
            <ChevronRight />
          </Link>
        ))}
      </div>
    </Page>
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

  useLocalReload(() => localDb.getInvoices().then(setExistingInvoices));

  const analyzedEntries = useMemo(() => analyzeBatchEntries(entries, existingInvoices), [entries, existingInvoices]);
  const groupedEntries = useMemo(() => groupBySupplier(analyzedEntries), [analyzedEntries]);
  const successfulEntries = analyzedEntries.filter((entry) => entry.status === 'success');
  const nonDuplicateEntries = successfulEntries.filter((entry) => !entry.isDuplicate);
  const sameInvoiceGroupEntries = successfulEntries.filter((entry) => entry.sameInvoiceGroup && !entry.isDuplicate);
  const possibleDuplicateEntries = successfulEntries.filter((entry) => entry.duplicateStatus === 'possible' && !entry.isDuplicate);
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
        if (tasks.some((task) => task.status === 'completed')) syncNow();
      } catch (error) {
        console.error('Refresh recognition tasks failed:', error);
      }
    }
    refreshTasks();
    const timer = window.setInterval(refreshTasks, 3000);
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
    syncNow();
    navigate('/recognition-tasks');
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
        <Info label="可保存" value={nonDuplicateEntries.length} />
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
                  <p>发票号：{entry.parsed.invoiceNo || '-'}</p>
                  <p>日期：{entry.parsed.invoiceDate || '-'} · 金额：{money(entry.parsed.totalAmount || entry.itemTotal)}</p>
                  <p>识别来源：{entry.result.recognitionSource || sourceLabel(entry.result.source)} · 商品 {entry.parsed.items?.length || 0} 行</p>
                  {(entry.duplicateStatus === 'confirmed' || entry.isDuplicate) && <p className="error">检测到重复发票：{entry.duplicateReason}</p>}
                  {entry.duplicateStatus === 'possible' && !entry.isDuplicate && <p className="warning-text">{entry.possibleDuplicateReason || '疑似重复，请确认。'}</p>}
                  {entry.sameInvoiceGroup && !entry.isDuplicate && <p className="warning-text">{entry.sameInvoiceGroupReason}</p>}
                  {entry.sequenceNote && <p className="hint">{entry.sequenceNote}</p>}
                </>
              )}
              {entry.status === 'failed' && <p className="error">{entry.error}</p>}
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

  async function load() {
    try {
      const data = await api.getRecognitionTasks();
      setTasks(data);
      if (data.some((task) => task.status === 'completed')) syncNow();
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
    const timer = window.setInterval(run, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function retry(taskId) {
    try {
      await api.retryRecognitionTask(taskId);
      setMessage('已重新加入后台识别队列');
      load();
    } catch (error) {
      setMessage(error.message || '重新识别失败');
    }
  }

  async function forceSave(taskId) {
    try {
      await api.forceSaveRecognitionTask(taskId);
      setMessage('已强制保存该识别结果');
      syncNow();
      load();
    } catch (error) {
      setMessage(error.message || '强制保存失败');
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
    try {
      await api.decideRecognitionTask(taskId, action);
      setMessage(action === 'merge' ? '已确认合并。' : action === 'duplicate' ? '已标记为重复。' : '已保留为独立发票。');
      syncNow();
      load();
    } catch (error) {
      setMessage(error.message || '人工确认失败');
    }
  }

  return (
    <Page title="识别记录/任务列表" action={<Link className="icon-button" to="/invoices/new"><Plus size={18} />新增</Link>}>
      {message && <p className="error">{message}</p>}
      {tasks.length === 0 && <EmptyState text="暂无识别任务" />}
      <div className="card-list">
        {tasks.map((task) => (
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
              {task.result?.duplicateCheck?.sameInvoiceGroup && !task.result?.duplicateCheck?.isDuplicate && <p className="warning-text">{task.result.duplicateCheck.sameInvoiceGroupReason}</p>}
              {task.error && <p className="error">{task.error}</p>}
            </div>
            <div className="row-actions">
              {task.invoiceId && <Link className="icon-button" to={`/invoices/${task.invoiceId}`}>发票</Link>}
              {task.status === 'failed' && <button onClick={() => retry(task.id)}>重新识别</button>}
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
              {task.status === 'completed' && task.result?.duplicateCheck?.isDuplicate && !task.invoiceId && <button onClick={() => forceSave(task.id)}>强制保存</button>}
              {task.status === 'completed' && task.result?.duplicateCheck?.sameInvoiceGroup && (
                <>
                  <button onClick={() => decideTask(task.id, 'merge')}>合并</button>
                  <button onClick={() => decideTask(task.id, 'duplicate')}>标记重复</button>
                  <button onClick={() => decideTask(task.id, 'independent')}>保留为独立发票</button>
                </>
              )}
            </div>
          </div>
        ))}
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
    supplierName: '',
    invoiceNo: '',
    invoiceDate: today(),
    totalAmount: 0,
    ocrText: '',
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
          syncNow();
        }
        if (task.status === 'failed') {
          setMessage(task.error || '识别失败');
        }
      } catch (error) {
        if (!cancelled) setMessage(error.message || '读取识别任务失败');
      }
    }
    refreshTask();
    const timer = window.setInterval(refreshTask, 3000);
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
      invoiceDate: normalizeDateInput(result.parsed?.invoiceDate) || current.invoiceDate,
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
    if (recognitionTask?.status === 'completed' && recognitionTask.invoiceId) {
      await syncNow();
      navigate(`/invoices/${recognitionTask.invoiceId}`);
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      if (navigator.onLine) {
        const result = await api.confirmAndLearnInvoice({
          finalInvoice: form,
          beforeResult: recognitionTask?.result?.parsed || null,
          invoiceTemplateId: recognitionTask?.result?.templateId || '',
          sampleImageHash: recognitionTask?.result?.sampleImageHash || ''
        });
        if (result.priceAnomalies?.length) {
          setMessage(`已保存并学习，但发现 ${result.priceAnomalies.length} 个价格异常，请检查。`);
        }
        await syncNow();
      } else {
        await localDb.createInvoice(form);
        syncNow();
      }
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
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.name} />)}
          </datalist>
        </label>
        <label className="field"><span>发票号</span><input value={form.invoiceNo} onChange={(event) => setForm({ ...form, invoiceNo: event.target.value })} /></label>
        <label className="field"><span>发票日期</span><input type="date" value={form.invoiceDate} onChange={(event) => setForm({ ...form, invoiceDate: event.target.value })} /></label>
        <label className="field"><span>发票总金额</span><input type="number" value={form.totalAmount} onChange={(event) => setForm({ ...form, totalAmount: event.target.value })} /></label>
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
              <label className="field"><span>是否赠品</span><input type="checkbox" checked={Boolean(item.isFreeItem)} onChange={(event) => updateItem(index, 'isFreeItem', event.target.checked)} /></label>
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
    syncNow();
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
      {invoice.imagePath && <Section title="发票图片"><img className="invoice-image" src={invoice.imagePath} alt="发票" /></Section>}
      <Section title="商品明细">
        {items.map((item) => (
          <div className="detail-item" key={item.id}>
            <strong>{item.productNameOriginal}</strong>
            <p>标准名：{item.productNameNormalized || '-'}</p>
            <p>数量 {item.quantity} {item.unit} · 单价 {money(item.unitPrice)} · 总价 {money(item.totalPrice)}</p>
          </div>
        ))}
      </Section>
      <Section title="OCR 原文"><pre className="ocr-text">{invoice.ocrText || '无 OCR 内容'}</pre></Section>
    </Page>
  );
}

function InvoiceDetailPageWithGifts() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);

  useLocalReload(() => localDb.getInvoice(id).then(setDetail), [id]);

  async function remove() {
    if (!confirm('确认删除这张发票？')) return;
    await localDb.deleteInvoice(id);
    syncNow();
    navigate('/invoices');
  }

  if (!detail) return <Page title="发票详情"><EmptyState text="未找到发票" /></Page>;

  const { invoice, items, discounts = [] } = detail;
  const giftSummary = summarizeGiftAccounting(items);
  const promoGroups = summarizePromoGroups(items);
  return (
    <Page title="发票详情" action={<button className="danger-button" onClick={remove}><Trash2 size={16} />删除</button>}>
      <Section title="发票信息">
        <Info label="供应商" value={invoice.supplierName || '未命名供应商'} />
        <Info label="发票号" value={invoice.invoiceNo || '-'} />
        <Info label="日期" value={invoice.invoiceDate || '-'} />
        <Info label="总金额" value={money(invoice.totalAmount)} />
        <Info label="AI/OCR 来源" value={sourceLabel(invoice.recognitionSource)} />
        <Info label="重复状态" value={duplicateStatusLabel(invoice.duplicateStatus)} />
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
        </Section>
      )}
      {promoGroups.length > 0 && (
        <Section title="赠品分摊组">
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
      {invoice.imagePath && <Section title="发票图片"><img className="invoice-image" src={invoice.imagePath} alt="发票" /></Section>}
      <Section title="商品明细">
        {items.map((item) => (
          <div className="detail-item" key={item.id}>
            <strong>{item.productNameOriginal}</strong>
            <p>标准名：{item.productNameNormalized || '-'}</p>
            <p>数量 {numberText(item.quantity)} {item.unit} · 原单价 {money(item.unitPrice)} · 总价 {money(item.totalPrice)}</p>
            <p>是否赠品：{Number(item.isFreeItem || 0) ? `是（${item.freeReason || '免费行'}）` : '否'} · 收费数量 {numberText(item.chargedQty)} · 免费数量 {numberText(item.freeQty)} · 实际数量 {numberText(item.totalQty)}</p>
            <p>分摊组：{item.promoGroupName || '-'} · {item.promoGroupRule || '-'}</p>
            <p>原始单价 {money(item.originalUnitCost || item.unitPrice)} · 实际摊薄成本 {money(item.effectiveUnitCost || item.unitPrice)} · 折后实际成本 {money(item.discountedEffectiveUnitCost || item.effectiveUnitCost || item.unitPrice)}</p>
          </div>
        ))}
      </Section>
      <Section title="OCR 原文"><pre className="ocr-text">{invoice.ocrText || '无 OCR 内容'}</pre></Section>
    </Page>
  );
}

function ProductSearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);

  async function search(event) {
    event?.preventDefault();
    setSearched(true);
    setResults(q.trim() ? await localDb.searchProducts(q) : []);
  }

  return (
    <Page title="商品价格查询" subtitle="查询优先读取本地 IndexedDB">
      <form className="search-bar" onSubmit={search}>
        <input placeholder="输入商品名称" value={q} onChange={(event) => setQ(event.target.value)} />
        <button><Search size={18} />搜索</button>
      </form>
      {searched && results.length === 0 && <EmptyState text="暂无结果" />}
      <div className="card-list">
        {results.map((item) => (
          <Link className="row-card" to={`/products/${encodeURIComponent(item.standardName)}`} key={item.standardName}>
            <div>
              <h3>{item.standardName}</h3>
              <p>最近 {money(item.recentPrice)} · 最低 {money(item.minPrice)} · 最高 {money(item.maxPrice)}</p>
              <p>均价 {money(item.averagePrice)} · 最近采购 {item.recentPurchaseDate} · {item.recordCount} 条</p>
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

  useLocalReload(() => localDb.getProduct(decoded).then(setRecords), [decoded]);

  return (
    <Page title="商品详情" subtitle={decoded}>
      <Section title="采购记录">
        {records.length === 0 && <EmptyState text="暂无采购记录" />}
        {records.map((record) => (
          <div className="detail-item" key={record.id}>
            <div className="split"><strong>{record.invoiceDate}</strong><strong>{money(record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice)}</strong></div>
            <p>{record.supplierName || '未命名供应商'}</p>
            <p>原始名：{record.productNameOriginal}</p>
            <p>原始单价 {money(record.unitPrice)} · 实际摊薄成本 {money(record.effectiveUnitCost || record.unitPrice)} · 折后实际成本 {money(record.discountedEffectiveUnitCost || record.effectiveUnitCost || record.unitPrice)}</p>
            <p>数量 {record.quantity} {record.unit} · 总价 {money(record.totalPrice)} · 是否赠品 {Number(record.isFreeItem || 0) ? '是' : '否'} · 发票号 {record.invoiceNo || '-'}</p>
            <p>分摊组：{record.promoGroupName || '-'} · {record.promoGroupRule || '-'}</p>
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

  const load = () => localDb.getSuppliers().then(setSuppliers);
  useLocalReload(load);

  async function saveSupplier(data) {
    await localDb.saveSupplier(data);
    setEditing(null);
    syncNow();
    load();
  }

  async function deleteSupplier(supplier) {
    if (!confirm(`删除供应商「${supplier.name}」？`)) return;
    await localDb.deleteSupplier(supplier);
    syncNow();
    load();
  }

  return (
    <Page title="供应商管理" action={<button className="icon-button" onClick={() => setEditing({ ...emptySupplier })}><Plus size={18} />新增</button>}>
      <div className="card-list">
        {suppliers.length === 0 && <EmptyState text="暂无供应商" />}
        {suppliers.map((supplier) => (
          <div className="row-card" key={supplier.id}>
            <div>
              <h3>{supplier.name || '未命名供应商'}</h3>
              <p>{supplier.phone || '无电话'} · {supplier.email || '无邮箱'} · {statusText(supplier.syncStatus)}</p>
            </div>
            <div className="row-actions">
              <Link to={`/suppliers/${encodeURIComponent(supplier.id)}/invoices`}>历史发票</Link>
              <button onClick={() => setTemplateSupplier(supplier)}>模板</button>
              <button onClick={() => setEditing(supplier)}>编辑</button>
              <button className="text-danger" onClick={() => deleteSupplier(supplier)}>删除</button>
            </div>
          </div>
        ))}
      </div>
      {editing && <SupplierDialog supplier={editing} onClose={() => setEditing(null)} onSave={saveSupplier} />}
      {templateSupplier && <TemplateDialog supplier={templateSupplier} onClose={() => setTemplateSupplier(null)} />}
    </Page>
  );
}

function SupplierInvoiceHistoryPage() {
  const { id } = useParams();
  const [filters, setFilters] = useState({ dateFrom: '', dateTo: '', invoiceNo: '', totalAmount: '', hasGifts: false, hasWarnings: false, isMultipage: false });
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

  return (
    <Page title="历史发票" subtitle={supplier?.name || '供应商'}>
      <Section title="筛选">
        <div className="grid-2">
          <label className="field"><span>开始日期</span><input type="date" value={filters.dateFrom} onChange={(event) => updateFilter('dateFrom', event.target.value)} /></label>
          <label className="field"><span>结束日期</span><input type="date" value={filters.dateTo} onChange={(event) => updateFilter('dateTo', event.target.value)} /></label>
          <label className="field"><span>发票号</span><input value={filters.invoiceNo} onChange={(event) => updateFilter('invoiceNo', event.target.value)} /></label>
          <label className="field"><span>总金额</span><input type="number" value={filters.totalAmount} onChange={(event) => updateFilter('totalAmount', event.target.value)} /></label>
        </div>
        <div className="row-actions">
          <label><input type="checkbox" checked={filters.hasGifts} onChange={(event) => updateFilter('hasGifts', event.target.checked)} /> 有赠品</label>
          <label><input type="checkbox" checked={filters.hasWarnings} onChange={(event) => updateFilter('hasWarnings', event.target.checked)} /> 有异常</label>
          <label><input type="checkbox" checked={filters.isMultipage} onChange={(event) => updateFilter('isMultipage', event.target.checked)} /> 多页发票</label>
          <a className="secondary-button" href={api.supplierInvoicesExportUrl(id, filters)}>导出 CSV</a>
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

function SettingsPage() {
  const [stats, setStats] = useState({});
  const load = () => localDb.getStats().then(setStats);
  useLocalReload(load);

  async function clearData() {
    if (!confirm('确认清空本地测试数据并同步删除到云端？')) return;
    await localDb.softDeleteAll();
    syncNow();
    load();
  }

  return (
    <Page title="设置/导出">
      <Section title="导出">
        <a className="primary-button" href={api.exportUrl()}><Upload size={18} />导出云端 CSV</a>
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
      {['name', 'phone', 'email', 'address', 'notes'].map((field) => (
        <label className="field" key={field}>
          <span>{({ name: '名称', phone: '电话', email: '邮箱', address: '地址', notes: '备注' })[field]}</span>
          <input value={form[field] || ''} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />
        </label>
      ))}
      <button className="primary-button" onClick={() => onSave(form)}>保存</button>
    </Dialog>
  );
}

function TemplateDialog({ supplier, onClose }) {
  const [template, setTemplate] = useState(emptyTemplate(supplier.name));

  useEffect(() => {
    localDb.getTemplate(supplier.id).then((data) => setTemplate(data || emptyTemplate(supplier.name)));
  }, [supplier]);

  async function save() {
    await localDb.saveTemplate(supplier.id, template);
    syncNow();
    onClose();
  }

  return (
    <Dialog title={`${supplier.name} · 识别模板`} onClose={onClose}>
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

function ActionLink({ to, icon, title, subtitle }) {
  return (
    <Link className="action-row" to={to}>
      <span className="action-icon">{icon}</span>
      <span><strong>{title}</strong><small>{subtitle}</small></span>
      <ChevronRight />
    </Link>
  );
}

function Info({ label, value }) {
  return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>;
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
    ['/products', Search, '查询'],
    ['/suppliers', Building2, '供应商'],
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
  if (status === 'conflict') return '鍐茬獊';
  return '已同步';
}

function sourceLabel(source) {
  if (source === 'template') return '妯℃澘';
  if (source === 'ai') return 'AI Vision';
  if (source === 'plain_ocr') return 'OCR';
  return 'OCR';
}

function duplicateStatusLabel(status) {
  if (status === 'confirmed') return '重复发票';
  if (status === 'possible') return '疑似重复，请确认';
  return '正常';
}

function batchStatusText(entry) {
  if (entry.status === 'recognizing') return '🔄 识别中';
  if (entry.status === 'failed') return '❌ 失败';
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

  if (!sameInvoiceNo) {
    if (sameAmount && similarItems && sameOrCloseDate) {
      result.duplicateStatus = 'possible';
      result.possibleDuplicateReason = `${sourceLabelText}: 发票号不同，只能标记疑似重复。`;
    }
    return result;
  }

  if (!sameOrCloseDate) {
    result.duplicateStatus = 'none';
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
