import {
  migrate,
  nowIso,
  queryAll,
  run,
  syncTables,
  tableColumns
} from '../src/db.js';

function normalizeArg(arg = '') {
  return String(arg).replace(/^–+/, '--');
}

function parseArgs(argv) {
  const normalized = argv.map(normalizeArg);
  const options = { fix: false, companyId: '' };
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === '--fix') options.fix = true;
    if (arg === '--company-id') options.companyId = normalized[index + 1] || '';
    if (arg.startsWith('--company-id=')) options.companyId = arg.slice('--company-id='.length);
  }
  return options;
}

function active(record = {}) {
  return !record.deletedAt && !['deleted', 'inactive'].includes(String(record.status || '').toLowerCase());
}

function activeInvoice(record = {}) {
  return active(record) && !['merged', 'hidden'].includes(String(record.status || '').toLowerCase());
}

function idsFor(record = {}) {
  return [record.id, record.localId, record.serverId].filter(Boolean);
}

function sameCompany(left, right) {
  return (left || null) === (right || null);
}

function amountKey(value) {
  return Number(value || 0).toFixed(2);
}

function itemName(item = {}) {
  return String(item.productNameOriginal || item.normalizedName || item.productNameNormalized || item.rawName || '').trim();
}

function repeatedSupplierName(value = '') {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  const upper = text.toUpperCase();
  const words = upper.split(' ');
  if (words.length < 4 || words.length % 2 !== 0) return false;
  const half = words.length / 2;
  return words.slice(0, half).join(' ') === words.slice(half).join(' ');
}

async function loadTables() {
  const tables = {};
  const tableNames = [...new Set([
    'suppliers',
    'invoices',
    'invoice_items',
    'invoice_discounts',
    'products',
    'price_history',
    'purchase_batches',
    'supplier_templates',
    'invoice_recognition_tasks',
    'invoice_templates',
    ...syncTables
  ])];
  for (const table of tableNames) {
    tables[table] = await queryAll(`SELECT * FROM "${table}"`);
  }
  return tables;
}

function buildInvoiceItemMap(items) {
  const map = new Map();
  for (const item of items) {
    for (const id of idsFor(item)) map.set(`${item.companyId ?? '__NULL__'}:${id}`, item);
  }
  return map;
}

function buildInvoiceMap(invoices) {
  const map = new Map();
  for (const invoice of invoices) {
    for (const id of idsFor(invoice)) map.set(`${invoice.companyId ?? '__NULL__'}:${id}`, invoice);
  }
  return map;
}

function linkedItems(invoice, items) {
  const invoiceIds = new Set(idsFor(invoice));
  return items.filter((item) => sameCompany(item.companyId, invoice.companyId) && invoiceIds.has(item.invoiceId));
}

function linkedDiscounts(invoice, discounts) {
  const invoiceIds = new Set(idsFor(invoice));
  return discounts.filter((discount) => sameCompany(discount.companyId, invoice.companyId) && invoiceIds.has(discount.invoiceId));
}

function auditData(tables) {
  const suppliers = tables.suppliers || [];
  const invoices = tables.invoices || [];
  const items = tables.invoice_items || [];
  const discounts = tables.invoice_discounts || [];
  const products = tables.products || [];
  const priceHistory = tables.price_history || [];
  const activeInvoices = invoices.filter(activeInvoice);
  const activeItems = items.filter(active);
  const invoiceMap = buildInvoiceMap(invoices);
  const itemMap = buildInvoiceItemMap(items);

  const duplicateMap = new Map();
  for (const invoice of activeInvoices) {
    const key = [
      invoice.companyId ?? '__NULL__',
      invoice.supplierId || '',
      String(invoice.invoiceNo || '').trim().toLowerCase(),
      String(invoice.invoiceDate || '').slice(0, 10),
      amountKey(invoice.totalAmount)
    ].join('|');
    const list = duplicateMap.get(key) || [];
    list.push(invoice);
    duplicateMap.set(key, list);
  }
  const duplicateInvoices = [...duplicateMap.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      key: [group[0].supplierId || '', group[0].invoiceNo || '', group[0].invoiceDate || '', amountKey(group[0].totalAmount)].join('|'),
      count: group.length,
      ids: group.map((invoice) => invoice.id),
      invoiceNo: group[0].invoiceNo || '',
      invoiceDate: group[0].invoiceDate || '',
      totalAmount: Number(group[0].totalAmount || 0)
    }));

  const amountMismatchInvoices = [];
  const emptyItemInvoices = [];
  for (const invoice of activeInvoices) {
    const invoiceItems = linkedItems(invoice, activeItems)
      .filter((item) => !Number(item.isDiscountLine || 0) && !Number(item.candidateOnly || 0));
    const invoiceDiscounts = linkedDiscounts(invoice, discounts.filter(active));
    const itemTotal = invoiceItems.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
    const discountTotal = invoiceDiscounts.reduce((sum, discount) => sum + Number(discount.amount || 0), 0);
    const expectedTotal = itemTotal + discountTotal;
    const difference = Math.abs(Number(invoice.totalAmount || 0) - expectedTotal);
    if (invoiceItems.length === 0) {
      emptyItemInvoices.push({ id: invoice.id, companyId: invoice.companyId, invoiceNo: invoice.invoiceNo || '', totalAmount: Number(invoice.totalAmount || 0) });
    } else if (difference > 0.05) {
      amountMismatchInvoices.push({
        id: invoice.id,
        companyId: invoice.companyId,
        invoiceNo: invoice.invoiceNo || '',
        totalAmount: Number(invoice.totalAmount || 0),
        itemTotal,
        discountTotal,
        expectedTotal,
        difference
      });
    }
  }

  const activePriceRows = priceHistory.filter((row) => !row.deletedAt && !['deleted', 'inactive'].includes(String(row.status || '').toLowerCase()));
  const orphanPriceHistory = activePriceRows.filter((row) => {
    const item = itemMap.get(`${row.companyId ?? '__NULL__'}:${row.invoiceItemId || ''}`);
    const invoiceByField = row.invoiceId ? invoiceMap.get(`${row.companyId ?? '__NULL__'}:${row.invoiceId}`) : null;
    const invoiceByItem = item?.invoiceId ? invoiceMap.get(`${item.companyId ?? '__NULL__'}:${item.invoiceId}`) : null;
    const invoice = invoiceByField || invoiceByItem;
    return !item || !active(item) || (invoice && !activeInvoice(invoice));
  }).map((row) => ({
    id: row.id,
    companyId: row.companyId,
    invoiceId: row.invoiceId || '',
    invoiceItemId: row.invoiceItemId || '',
    invoiceNo: row.invoiceNo || '',
    price: Number(row.price || 0)
  }));

  const priceGroups = new Map();
  for (const row of activePriceRows) {
    const key = [
      row.companyId ?? '__NULL__',
      row.productId || '',
      row.invoiceId || '',
      row.invoiceItemId || '',
      row.supplierId || '',
      row.invoiceNo || '',
      row.invoiceDate || '',
      Number(row.price || 0).toFixed(4)
    ].join('|');
    const list = priceGroups.get(key) || [];
    list.push(row);
    priceGroups.set(key, list);
  }
  const duplicatePriceHistory = [...priceGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      count: group.length,
      keepId: group[0].id,
      duplicateIds: group.slice(1).map((row) => row.id),
      invoiceNo: group[0].invoiceNo || '',
      price: Number(group[0].price || 0)
    }));

  const companyTables = [...new Set([...syncTables, 'invoice_recognition_tasks', 'invoice_templates'].filter((table) => tableColumns[table]?.includes('companyId')))];
  const nullCompanyData = companyTables.map((table) => ({
    table,
    count: (tables[table] || []).filter((row) => row.companyId === null || row.companyId === undefined || row.companyId === '').length
  })).filter((entry) => entry.count > 0);

  const supplierNormalizedGroups = new Map();
  for (const supplier of suppliers.filter(active)) {
    const key = String(supplier.normalizedName || '').trim();
    if (!key) continue;
    const list = supplierNormalizedGroups.get(key) || [];
    list.push(supplier);
    supplierNormalizedGroups.set(key, list);
  }
  const supplierDuplicateSuspects = [
    ...[...supplierNormalizedGroups.values()].filter((group) => group.length > 1).map((group) => ({
      reason: 'same_normalizedName',
      normalizedName: group[0].normalizedName,
      ids: group.map((supplier) => supplier.id),
      names: group.map((supplier) => supplier.supplierDisplayName || supplier.displayName || supplier.name || '')
    })),
    ...suppliers.filter(active).filter((supplier) => repeatedSupplierName(supplier.supplierDisplayName || supplier.displayName || supplier.name || '')).map((supplier) => ({
      reason: 'repeated_display_name',
      ids: [supplier.id],
      names: [supplier.supplierDisplayName || supplier.displayName || supplier.name || '']
    }))
  ];

  const productGroups = new Map();
  for (const product of products.filter(active)) {
    const key = String(product.normalizedName || '').trim();
    if (!key) continue;
    const list = productGroups.get(key) || [];
    list.push(product);
    productGroups.set(key, list);
  }
  const productDuplicateSuspects = [...productGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      normalizedName: group[0].normalizedName,
      ids: group.map((product) => product.id),
      names: group.map((product) => product.name || '')
    }));

  const suspiciousOcrItems = activeItems.filter((item) => {
    const name = itemName(item);
    const lower = name.toLowerCase();
    return !name
      || /�|鍥|娴|绋|璁|鐨|渚|搴/.test(name)
      || lower.includes('discount') && !Number(item.isDiscountLine || 0)
      || name.includes('折扣') && !Number(item.isDiscountLine || 0)
      || (Number(item.totalPrice || 0) < 0 && !Number(item.isDiscountLine || 0))
      || (Number(item.unitPrice || 0) < 0 && !Number(item.isDiscountLine || 0))
      || (Number(item.totalPrice || 0) === 0 && Number(item.unitPrice || 0) === 0 && !Number(item.isFreeItem || 0) && !Number(item.isDiscountLine || 0))
      || name.length > 140;
  }).map((item) => ({
    id: item.id,
    invoiceId: item.invoiceId,
    name: itemName(item),
    totalPrice: Number(item.totalPrice || 0),
    unitPrice: Number(item.unitPrice || 0),
    isFreeItem: Number(item.isFreeItem || 0),
    isDiscountLine: Number(item.isDiscountLine || 0)
  }));

  const needsReview = [
    ...duplicateInvoices.map((entry) => ({ type: 'duplicateInvoice', ...entry })),
    ...amountMismatchInvoices.map((entry) => ({ type: 'amountMismatch', ...entry })),
    ...supplierDuplicateSuspects.map((entry) => ({ type: 'supplierDuplicateSuspect', ...entry })),
    ...productDuplicateSuspects.map((entry) => ({ type: 'productDuplicateSuspect', ...entry })),
    ...suspiciousOcrItems.map((entry) => ({ type: 'suspiciousOcrItem', ...entry }))
  ];

  return {
    duplicateInvoices,
    amountMismatchInvoices,
    emptyItemInvoices,
    orphanPriceHistory,
    duplicatePriceHistory,
    nullCompanyData,
    supplierDuplicateSuspects,
    productDuplicateSuspects,
    suspiciousOcrItems,
    needsReview
  };
}

async function softDeletePriceHistoryRows(ids, reason) {
  if (!ids.length) return 0;
  const timestamp = nowIso();
  let changed = 0;
  for (const id of ids) {
    const result = await run(`
      UPDATE "price_history"
      SET "deletedAt" = ?,
          "updatedAt" = ?,
          "status" = 'deleted',
          "syncStatus" = 'deleted'
      WHERE "id" = ? AND "deletedAt" IS NULL
    `, [timestamp, timestamp, id]);
    changed += Number(result?.changes || result?.rowCount || 0);
  }
  return { reason, changed, ids };
}

async function fixNullCompanyData(companyId) {
  if (!companyId) return [];
  const timestamp = nowIso();
  const results = [];
  const companyTables = [...new Set([...syncTables, 'invoice_recognition_tasks', 'invoice_templates'].filter((table) => tableColumns[table]?.includes('companyId')))];
  for (const table of companyTables) {
    const result = await run(`
      UPDATE "${table}"
      SET "companyId" = ?,
          "updatedAt" = COALESCE("updatedAt", ?)
      WHERE "companyId" IS NULL OR "companyId" = ''
    `, [companyId, timestamp]);
    const changed = Number(result?.changes || result?.rowCount || 0);
    if (changed > 0) results.push({ table, changed });
  }
  return results;
}

async function runAudit() {
  const options = parseArgs(process.argv.slice(2));
  await migrate();
  let tables = await loadTables();
  let report = auditData(tables);
  const fixes = [];

  if (options.fix) {
    fixes.push(await softDeletePriceHistoryRows(report.orphanPriceHistory.map((row) => row.id), 'orphanPriceHistory'));
    const duplicateIds = report.duplicatePriceHistory.flatMap((group) => group.duplicateIds);
    fixes.push(await softDeletePriceHistoryRows(duplicateIds, 'duplicatePriceHistory'));
    if (options.companyId) fixes.push({ reason: 'nullCompanyData', results: await fixNullCompanyData(options.companyId) });
    tables = await loadTables();
    report = auditData(tables);
  }

  const summary = Object.fromEntries(Object.entries(report).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]));
  const output = {
    ok: true,
    mode: options.fix ? 'fix' : 'dry-run',
    companyId: options.companyId || '',
    summary,
    fixes: fixes.filter(Boolean),
    ...report
  };
  console.log(JSON.stringify(output, null, 2));
}

runAudit().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.stack || error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
