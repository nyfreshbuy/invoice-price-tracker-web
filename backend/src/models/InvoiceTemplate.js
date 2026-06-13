import { id, nowIso } from '../db.js';

export function createInvoiceTemplate(input = {}) {
  const timestamp = nowIso();
  return {
    id: input.id || id(),
    companyId: input.companyId || '',
    supplierName: input.supplierName || '',
    invoiceLayoutType: input.invoiceLayoutType || 'normal_invoice',
    supplierKeywords: JSON.stringify(input.supplierKeywords || []),
    tableHeaderKeywords: JSON.stringify(input.tableHeaderKeywords || []),
    columns: JSON.stringify(input.columns || []),
    totalKeywords: JSON.stringify(input.totalKeywords || ['total', 'amount', '合计', '总计']),
    invoiceNoKeywords: JSON.stringify(input.invoiceNoKeywords || ['invoice no', 'invoice #', '发票号', '单号']),
    dateKeywords: JSON.stringify(input.dateKeywords || ['date', 'invoice date', '日期']),
    tableRegion: JSON.stringify(input.tableRegion || {}),
    handwrittenRegions: JSON.stringify(input.handwrittenRegions || []),
    sampleImageHash: input.sampleImageHash || '',
    successCount: Number(input.successCount || 0),
    failCount: Number(input.failCount || 0),
    lastUsedAt: input.lastUsedAt || null,
    accuracyScore: Number(input.accuracyScore ?? 0.75),
    isActive: input.isActive === false ? 0 : 1,
    createdAt: input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp
  };
}

export function parseInvoiceTemplate(row) {
  if (!row) return null;
  return {
    ...row,
    supplierKeywords: parseJson(row.supplierKeywords, []),
    tableHeaderKeywords: parseJson(row.tableHeaderKeywords, []),
    columns: parseJson(row.columns, []),
    totalKeywords: parseJson(row.totalKeywords, []),
    invoiceNoKeywords: parseJson(row.invoiceNoKeywords, []),
    dateKeywords: parseJson(row.dateKeywords, []),
    tableRegion: parseJson(row.tableRegion, {}),
    handwrittenRegions: parseJson(row.handwrittenRegions, []),
    accuracyScore: Number(row.accuracyScore ?? 0.75),
    isActive: Boolean(row.isActive)
  };
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
