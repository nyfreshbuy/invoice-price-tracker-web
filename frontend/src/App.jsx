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
import { localDb, today } from './localDb.js';
import { getSyncSnapshot, startAutoSync, syncNow } from './syncService.js';

const emptyItem = () => ({
  productNameOriginal: '',
  productNameNormalized: '',
  category: '',
  quantity: 0,
  unit: '',
  unitPrice: 0,
  totalPrice: 0,
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
  invoiceNoKeywords: '发票号,单号,票号',
  dateKeywords: '日期,开票日期',
  itemTableStartKeywords: '品名,商品,名称',
  itemTableEndKeywords: '合计,总计',
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

  if (!authSession?.token) {
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
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/products" element={<ProductSearchPage />} />
          <Route path="/products/:name" element={<ProductDetailPage />} />
          <Route path="/suppliers" element={<SupplierPage />} />
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
        <ActionLink to="/invoices/new" icon={<Camera />} title="新增发票" subtitle="先保存到本机，联网后自动同步云端" />
        <ActionLink to="/invoices/batch" icon={<Upload />} title="批量导入发票" subtitle="多张图片批量 OCR/AI 识别并生成采购批次" />
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

  useLocalReload(() => localDb.getInvoices().then(setExistingInvoices));

  const analyzedEntries = useMemo(() => analyzeBatchEntries(entries, existingInvoices), [entries, existingInvoices]);
  const groupedEntries = useMemo(() => groupBySupplier(analyzedEntries), [analyzedEntries]);
  const successfulEntries = analyzedEntries.filter((entry) => entry.status === 'success');
  const nonDuplicateEntries = successfulEntries.filter((entry) => !entry.isDuplicate);

  function updateEntry(id, patch) {
    setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  async function handleFilesSelected(files) {
    const fileList = Array.from(files || []);
    if (fileList.length === 0) return;
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
      try {
        const result = await api.ocrUpload(data);
        console.log('Batch OCR result:', entry.fileName, result);
        if (result.success === false) {
          updateEntry(entry.id, { status: 'failed', result, error: result.error || '识别失败' });
        } else {
          updateEntry(entry.id, { status: 'success', result, error: '' });
        }
      } catch (error) {
        console.error('Batch OCR failed:', entry.fileName, error);
        updateEntry(entry.id, { status: 'failed', error: error.message || '识别失败' });
      }
    }
  }

  async function saveBatch() {
    if (nonDuplicateEntries.length === 0) {
      setMessage('没有可保存的非重复发票。');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const supplierNames = new Set(nonDuplicateEntries.map((entry) => entry.parsed.supplierName || '未命名供应商'));
      const totalAmount = nonDuplicateEntries.reduce((sum, entry) => sum + Number(entry.parsed.totalAmount || entry.itemTotal || 0), 0);
      const batch = await localDb.createPurchaseBatch({
        batchName: `采购批次 ${new Date().toLocaleString()}`,
        supplierCount: supplierNames.size,
        invoiceCount: nonDuplicateEntries.length,
        totalAmount
      });

      for (const entry of nonDuplicateEntries) {
        await localDb.createInvoice({
          batchId: batch.id,
          supplierName: entry.parsed.supplierName || '未命名供应商',
          invoiceNo: entry.parsed.invoiceNo || '',
          invoiceDate: entry.parsed.invoiceDate || today(),
          totalAmount: Number(entry.parsed.totalAmount || entry.itemTotal || 0),
          imagePath: entry.result.imagePath || '',
          ocrText: entry.result.ocrText || '',
          items: (entry.parsed.items || []).map((item) => ({
            productNameOriginal: displayInvoiceItemName(item),
            productNameNormalized: displayInvoiceItemNormalizedName(item),
            category: item.category || '',
            quantity: Number(item.quantity ?? item.qty ?? 0),
            unit: item.unit || item.spec || item.size || '',
            unitPrice: Number(item.unitPrice || 0),
            totalPrice: Number(item.totalPrice ?? item.amount ?? 0),
            notes: item.notes || ''
          }))
        });
      }
      syncNow();
      navigate('/invoices');
    } catch (error) {
      setMessage(error.message || '保存批次失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page title="批量导入发票" subtitle="一次选择多张图片，批量 OCR/AI 识别并创建采购批次">
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
      </Section>

      <Section title="识别结果汇总">
        <Info label="已选择" value={entries.length} />
        <Info label="识别成功" value={successfulEntries.length} />
        <Info label="重复发票" value={analyzedEntries.filter((entry) => entry.isDuplicate).length} />
        <Info label="可保存" value={nonDuplicateEntries.length} />
      </Section>

      {Object.entries(groupedEntries).map(([supplierName, supplierEntries]) => (
        <Section key={supplierName} title={`供应商：${supplierName}`}>
          {supplierEntries.map((entry) => (
            <div className="detail-item" key={entry.id}>
              <div className="split">
                <strong>{entry.fileName}</strong>
                <strong>{batchStatusText(entry)}</strong>
              </div>
              <img className="invoice-preview" src={entry.previewUrl} alt={entry.fileName} />
              {entry.status === 'success' && (
                <>
                  <p>发票号：{entry.parsed.invoiceNo || '-'}</p>
                  <p>日期：{entry.parsed.invoiceDate || '-'} · 金额：{money(entry.parsed.totalAmount || entry.itemTotal)}</p>
                  <p>识别来源：{entry.result.recognitionSource || sourceLabel(entry.result.source)} · 商品 {entry.parsed.items?.length || 0} 行</p>
                  {entry.isDuplicate && <p className="error">检测到重复发票：{entry.duplicateReason}</p>}
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
        <button className="primary-button" disabled={saving || nonDuplicateEntries.length === 0} onClick={saveBatch}>
          <Save size={18} />{saving ? '保存中...' : '确认保存采购批次'}
        </button>
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
  const itemTotal = useMemo(() => form.items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0), [form.items]);
  const total = Number(form.totalAmount || 0) > 0 ? Number(form.totalAmount) : itemTotal;

  useLocalReload(() => localDb.getSuppliers().then(setSuppliers));

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  function updateItem(index, field, value) {
    setForm((current) => {
      const items = [...current.items];
      const next = { ...items[index], [field]: value };
      if (field === 'quantity' || field === 'unitPrice') {
        next.totalPrice = Number(next.quantity || 0) * Number(next.unitPrice || 0);
      }
      items[index] = next;
      return { ...current, items };
    });
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
    try {
      const result = await api.ocrUpload(data);
      console.log('OCR result:', result);
      if (result.success === false) {
        const errorMessage = result.error || 'OCR 识别失败';
        setOcrStatus(`识别失败：${errorMessage}｜识别来源：${result.recognitionSource || sourceLabel(result.source)}`);
        setMessage(errorMessage);
        return;
      }
      const parsedItems = Array.isArray(result.parsed?.items) ? result.parsed.items.map(normalizeParsedItemForForm) : [];
      const recognitionSource = result.recognitionSource || sourceLabel(result.source);
      setForm((current) => ({
        ...current,
        supplierName: result.parsed?.supplierName || current.supplierName,
        invoiceNo: result.parsed?.invoiceNo || current.invoiceNo,
        invoiceDate: normalizeDateInput(result.parsed?.invoiceDate) || current.invoiceDate,
        totalAmount: Number(result.parsed?.totalAmount || current.totalAmount || 0),
        imagePath: result.imagePath || current.imagePath,
        ocrText: result.ocrText || result.message || '',
        items: parsedItems.length > 0 ? parsedItems : current.items
      }));
      setOcrStatus(result.ocrText ? `识别成功｜识别来源：${recognitionSource}` : `识别失败：${result.message || 'OCR 未识别到文字'}｜识别来源：${recognitionSource}`);
      if (!result.ocrText) {
        setMessage(result.message || 'OCR 未识别到文字，请手动录入。');
      }
    } catch (error) {
      console.error('OCR failed:', error);
      setOcrStatus(`识别失败：${error.message || '未知错误'}｜识别来源：OCR`);
      setMessage(error.message);
    }
  }

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      await localDb.createInvoice(form);
      syncNow();
      navigate('/invoices');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page title="新增发票" subtitle="第一阶段允许手动录入；OCR 接口已预留">
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
              <label className="field"><span>备注</span><input value={item.notes} onChange={(event) => updateItem(index, 'notes', event.target.value)} /></label>
            </div>
          </div>
        ))}
        <button className="secondary-button" onClick={() => setForm({ ...form, items: [...form.items, emptyItem()] })}><Plus size={16} />新增行</button>
      </Section>

      {message && <p className="error">{message}</p>}
      <div className="sticky-actions">
        <button className="primary-button" disabled={saving} onClick={save}><Save size={18} />{saving ? '保存中...' : '保存到本机'}</button>
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
            <div className="split"><strong>{record.invoiceDate}</strong><strong>{money(record.unitPrice)}</strong></div>
            <p>{record.supplierName || '未命名供应商'}</p>
            <p>原始名：{record.productNameOriginal}</p>
            <p>数量 {record.quantity} {record.unit} · 总价 {money(record.totalPrice)} · 发票号 {record.invoiceNo || '-'}</p>
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
        <p className="hint">CSV 导出来自后端云端 SQLite；离线时请先同步后再导出。</p>
      </Section>
      <Section title="本地数据库统计">
        <Info label="供应商" value={stats.suppliers ?? 0} />
        <Info label="发票" value={stats.invoices ?? 0} />
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
  if (status === 'conflict') return '冲突';
  return '已同步';
}

function sourceLabel(source) {
  if (source === 'template') return '模板';
  if (source === 'ai') return 'AI Vision';
  if (source === 'plain_ocr') return 'OCR';
  return 'OCR';
}

function batchStatusText(entry) {
  if (entry.status === 'recognizing') return '识别中';
  if (entry.status === 'failed') return '识别失败';
  if (entry.status === 'success' && entry.isDuplicate) return '重复发票';
  if (entry.status === 'success') return '识别成功';
  return '待识别';
}

function groupBySupplier(entries) {
  return entries.reduce((groups, entry) => {
    const supplierName = entry.parsed?.supplierName || '未识别供应商';
    groups[supplierName] = groups[supplierName] || [];
    groups[supplierName].push(entry);
    return groups;
  }, {});
}

function analyzeBatchEntries(entries, existingInvoices = []) {
  const seenInBatch = new Map();
  const analyzed = entries.map((entry) => {
    const parsed = normalizeParsedInvoice(entry.result?.parsed);
    const itemTotal = totalFromItems(parsed.items);
    const invoiceKey = normalizedKey(parsed.invoiceNo);
    const supplierKey = normalizedKey(parsed.supplierName);
    let isDuplicate = false;
    let duplicateReason = '';

    if (entry.status === 'success' && invoiceKey) {
      const supplierRecognized = supplierKey && parsed.supplierName !== '未识别供应商';
      const existing = existingInvoices.find((invoice) => {
        const sameInvoiceNo = normalizedKey(invoice.invoiceNo) === invoiceKey;
        const sameSupplier = !supplierRecognized || normalizedKey(invoice.supplierName) === supplierKey;
        return sameInvoiceNo && sameSupplier;
      });

      if (existing) {
        isDuplicate = true;
        duplicateReason = `本地已有同供应商同发票号：${existing.invoiceNo}`;
      }

      const batchKey = `${supplierKey}|${invoiceKey}`;
      if (seenInBatch.has(batchKey)) {
        isDuplicate = true;
        duplicateReason = `本次选择中已出现同供应商同发票号：${parsed.invoiceNo}`;
      } else {
        seenInBatch.set(batchKey, entry.id);
      }
    }

    return {
      ...entry,
      parsed,
      itemTotal,
      isDuplicate,
      duplicateReason,
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
        notes.set(item.entry.id, `连续发票号：${first} - ${last}`);
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
