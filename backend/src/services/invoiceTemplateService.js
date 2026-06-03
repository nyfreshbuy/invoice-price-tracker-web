import crypto from 'node:crypto';
import { nowIso, queryAll, queryGet, quoteIdentifier, quoteTable, run, upsertRecord } from '../db.js';
import { createInvoiceTemplate, parseInvoiceTemplate } from '../models/InvoiceTemplate.js';

export function hashImageFile(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function normalizeInvoiceResult(result = {}) {
  const items = Array.isArray(result.items) ? result.items : [];
  return {
    supplierName: result.supplierName || '',
    invoiceNo: result.invoiceNo || '',
    invoiceDate: normalizeInvoiceDate(result.invoiceDate),
    totalAmount: Number(result.totalAmount || 0),
    items: items.map(normalizeInvoiceItem),
    templateCandidate: result.templateCandidate || defaultTemplateCandidate(result.supplierName || ''),
    confidence: Number(result.confidence || 0),
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

export function normalizeInvoiceDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return formatDateParts(match[1], match[2], match[3]);

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return formatDateParts(match[3], match[1], match[2]);

  return '';
}

export function normalizeInvoiceItem(item = {}) {
  const nameCn = String(item.nameCn || '').trim();
  const nameEn = String(item.nameEn || '').trim();
  const legacyName = String(item.name || item.productNameOriginal || '').trim();
  const name = String(item.name || [nameCn, nameEn].filter(Boolean).join(' ') || legacyName).trim();
  const normalizedName = String(item.normalizedName || item.productNameNormalized || name).trim().toLowerCase();

  return {
    nameCn,
    nameEn,
    name,
    normalizedName,
    barcode: item.barcode || item.code || '',
    spec: item.spec || item.size || '',
    qty: Number(item.qty ?? item.quantity ?? 0),
    unit: item.unit || '',
    unitPrice: Number(item.unitPrice ?? item.price ?? 0),
    totalPrice: Number(item.totalPrice ?? item.amount ?? 0)
  };
}

function formatDateParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function defaultTemplateCandidate(supplierName) {
  return {
    supplierKeywords: supplierName ? [supplierName] : [],
    tableHeaderKeywords: ['Code', 'Item', 'Description', 'Name', 'Qty', 'Price', 'Amount', 'Total'],
    columns: [
      { name: 'barcode', keywords: ['Code', 'Barcode', 'Item'] },
      { name: 'nameCn', keywords: ['Chinese Name', '中文品名'] },
      { name: 'nameEn', keywords: ['Description', 'Name', 'Product'] },
      { name: 'name', keywords: ['Description', 'Name', 'Product'] },
      { name: 'spec', keywords: ['Size', 'Pack', 'Spec'] },
      { name: 'qty', keywords: ['Qty', 'Quantity'] },
      { name: 'unitPrice', keywords: ['Unit Price', 'Price'] },
      { name: 'totalPrice', keywords: ['Amount', 'Total'] }
    ]
  };
}

export async function findTemplateByOcrText(ocrText, companyId = 'default') {
  const templates = await queryAll(`
    SELECT * FROM ${quoteTable('invoice_templates')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('isActive')} = 1
    ORDER BY ${quoteIdentifier('successCount')} DESC, ${quoteIdentifier('updatedAt')} DESC
  `, [companyId]);
  const lowerText = String(ocrText || '').toLowerCase();
  for (const row of templates) {
    const template = parseInvoiceTemplate(row);
    const keywords = template.supplierKeywords || [];
    if (keywords.length > 0 && keywords.some((keyword) => lowerText.includes(String(keyword).toLowerCase()))) {
      return template;
    }
    if (template.supplierName && lowerText.includes(template.supplierName.toLowerCase())) {
      return template;
    }
  }
  return null;
}

export function parseWithTemplate(ocrText, template) {
  if (!template) {
    return { success: false, error: 'No template matched' };
  }

  const lines = String(ocrText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = findHeaderIndex(lines, template.tableHeaderKeywords);
  if (headerIndex === -1) {
    return { success: false, error: 'Template table header not found' };
  }

  const supplierName = template.supplierName || inferSupplierName(lines, template.supplierKeywords);
  const invoiceNo = findValueByKeywords(lines, template.invoiceNoKeywords);
  const invoiceDate = findDateByKeywords(lines, template.dateKeywords);
  const totalAmount = findAmountByKeywords(lines, template.totalKeywords);
  const items = parseItemLines(lines.slice(headerIndex + 1), totalAmount);
  const warnings = validateTotal(items, totalAmount);

  if (items.length === 0) {
    return { success: false, error: 'Template parsed zero items' };
  }

  return {
    success: true,
    result: normalizeInvoiceResult({
      supplierName,
      invoiceNo,
      invoiceDate,
      totalAmount,
      items,
      templateCandidate: {
        supplierKeywords: template.supplierKeywords,
        tableHeaderKeywords: template.tableHeaderKeywords,
        columns: template.columns
      },
      confidence: warnings.length ? 0.72 : 0.86,
      warnings
    })
  };
}

export async function saveOrUpdateTemplateFromResult(result, sampleImageHash, companyId = 'default') {
  const normalized = normalizeInvoiceResult(result);
  const candidate = normalized.templateCandidate || defaultTemplateCandidate(normalized.supplierName);
  const supplierName = normalized.supplierName || candidate.supplierKeywords?.[0] || '';
  if (!supplierName && !candidate.supplierKeywords?.length) return null;

  const existing = await queryGet(`
    SELECT * FROM ${quoteTable('invoice_templates')}
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('supplierName')} = ?
    ORDER BY ${quoteIdentifier('updatedAt')} DESC LIMIT 1
  `, [companyId, supplierName]);

  const now = nowIso();
  const template = createInvoiceTemplate({
    ...(existing || {}),
    companyId,
    supplierName,
    supplierKeywords: uniqueStrings([supplierName, ...(candidate.supplierKeywords || [])].filter(Boolean)),
    tableHeaderKeywords: uniqueStrings(candidate.tableHeaderKeywords || []),
    columns: candidate.columns || [],
    totalKeywords: existing ? parseInvoiceTemplate(existing).totalKeywords : ['total', 'amount', '合计', '总计'],
    invoiceNoKeywords: existing ? parseInvoiceTemplate(existing).invoiceNoKeywords : ['invoice no', 'invoice #', '发票号', '单号'],
    dateKeywords: existing ? parseInvoiceTemplate(existing).dateKeywords : ['date', 'invoice date', '日期'],
    sampleImageHash,
    successCount: Number(existing?.successCount || 0),
    failCount: Number(existing?.failCount || 0),
    lastUsedAt: now,
    isActive: true,
    updatedAt: now
  });

  await upsertRecord('invoice_templates', template);

  return parseInvoiceTemplate(template);
}

export async function markTemplateSuccess(templateId, companyId = 'default') {
  if (!templateId) return;
  await run(`
    UPDATE ${quoteTable('invoice_templates')}
    SET ${quoteIdentifier('successCount')} = ${quoteIdentifier('successCount')} + 1,
        ${quoteIdentifier('lastUsedAt')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [nowIso(), nowIso(), templateId, companyId]);
}

export async function markTemplateFailure(templateId, companyId = 'default') {
  if (!templateId) return;
  await run(`
    UPDATE ${quoteTable('invoice_templates')}
    SET ${quoteIdentifier('failCount')} = ${quoteIdentifier('failCount')} + 1,
        ${quoteIdentifier('isActive')} = CASE WHEN ${quoteIdentifier('failCount')} + 1 >= 3 AND ${quoteIdentifier('successCount')} = 0 THEN 0 ELSE ${quoteIdentifier('isActive')} END,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('id')} = ? AND ${quoteIdentifier('companyId')} = ?
  `, [nowIso(), templateId, companyId]);
}

function findHeaderIndex(lines, keywords = []) {
  const lowered = keywords.map((keyword) => String(keyword).toLowerCase());
  return lines.findIndex((line) => {
    const lowerLine = line.toLowerCase();
    return lowered.some((keyword) => lowerLine.includes(keyword));
  });
}

function inferSupplierName(lines, supplierKeywords = []) {
  return supplierKeywords.find(Boolean) || lines.find((line) => /company|market|inc|公司|商行|供应/.test(line.toLowerCase())) || '';
}

function findValueByKeywords(lines, keywords = []) {
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (keywords.some((keyword) => lowerLine.includes(String(keyword).toLowerCase()))) {
      return line.split(/[:：#]/).slice(1).join(':').trim() || line;
    }
  }
  return '';
}

function findDateByKeywords(lines, keywords = []) {
  const relevant = lines.find((line) => keywords.some((keyword) => line.toLowerCase().includes(String(keyword).toLowerCase()))) || lines.join(' ');
  const dateText = relevant.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}/)?.[0] || '';
  return normalizeInvoiceDate(dateText);
}

function findAmountByKeywords(lines, keywords = []) {
  for (const line of [...lines].reverse()) {
    const lowerLine = line.toLowerCase();
    if (keywords.some((keyword) => lowerLine.includes(String(keyword).toLowerCase()))) {
      const numbers = line.match(/\d+(?:\.\d+)?/g) || [];
      if (numbers.length) return Number(numbers[numbers.length - 1]);
    }
  }
  return 0;
}

function parseItemLines(lines, totalAmount) {
  const items = [];
  for (const line of lines) {
    if (/total|amount due|subtotal|tax|合计|总计|小计|税/.test(line.toLowerCase())) break;
    const numbers = line.match(/\d+(?:\.\d+)?/g) || [];
    if (numbers.length < 2) continue;
    const firstNumber = line.search(/\d+(?:\.\d+)?/);
    const name = line.slice(0, firstNumber).replace(/[|,，]/g, ' ').trim();
    if (!name || name.length < 2) continue;
    const amount = Number(numbers[numbers.length - 1]);
    const unitPrice = Number(numbers[numbers.length - 2]);
    const quantity = numbers.length >= 3 ? Number(numbers[numbers.length - 3]) : (unitPrice > 0 ? amount / unitPrice : 0);
    if (totalAmount > 0 && amount > totalAmount * 1.1) continue;
    items.push({
      nameCn: /[\u3400-\u9fff]/.test(name) ? name : '',
      nameEn: /[\u3400-\u9fff]/.test(name) ? '' : name,
      name,
      normalizedName: name.trim().toLowerCase(),
      barcode: '',
      spec: '',
      qty: quantity,
      unit: '',
      unitPrice,
      totalPrice: amount
    });
  }
  return items;
}

function validateTotal(items, totalAmount) {
  if (!totalAmount || items.length === 0) return [];
  const itemTotal = items.reduce((sum, item) => sum + Number(item.totalPrice ?? item.amount ?? 0), 0);
  const diffRatio = Math.abs(itemTotal - totalAmount) / totalAmount;
  return diffRatio > 0.05 ? [`Item total ${itemTotal.toFixed(2)} differs from invoice total ${totalAmount.toFixed(2)} by more than 5%.`] : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}
