import fs from 'node:fs';
import Tesseract from 'tesseract.js';
import {
  findTemplateByOcrText,
  findTemplateBySupplierHint,
  hashImageFile,
  markTemplateFailure,
  markTemplateSuccess,
  normalizeInvoiceDate,
  parseWithTemplate,
  saveOrUpdateTemplateFromResult
} from './invoiceTemplateService.js';
import { recognizeInvoiceWithAI } from './aiInvoiceService.js';
import { buildSupplierDisplayName, splitSupplierNameParts } from './supplierNormalizationService.js';

export async function recognizeInvoice(file, options = {}) {
  const companyId = options.companyId || '';
  if (!companyId) throw new Error('Missing authenticated companyId');
  const imageBuffer = fs.readFileSync(file.path);
  const sampleImageHash = hashImageFile(imageBuffer);
  const imagePath = `/uploads/${file.filename}`;
  const supplierHint = [options.supplierHint, file.originalname].filter(Boolean).join(' ');

  let ocrText = '';
  let ocrLanguage = '';
  const hintedTemplate = await findTemplateBySupplierHint(supplierHint, companyId);
  if (hintedTemplate && hintedTemplate.failCount < 3) {
    const ocr = await runPlainOcr(file.path);
    ocrText = ocr.ocrText;
    ocrLanguage = ocr.ocrLanguage;
    const templated = parseWithTemplate(ocrText, hintedTemplate);
    if (templated.success) {
      await markTemplateSuccess(hintedTemplate.id, companyId);
      return responsePayload({
        source: 'template',
        imagePath,
        ocrText,
        result: templated.result,
        template: hintedTemplate,
        sampleImageHash,
        ocrLanguage
      });
    }
    await markTemplateFailure(hintedTemplate.id, companyId);
  }

  try {
    const aiResult = await recognizeInvoiceWithAI(file.path, { mimeType: file.mimetype });
    const learnedTemplate = await saveOrUpdateTemplateFromResult(aiResult, sampleImageHash, companyId);
    return responsePayload({
      source: 'ai',
      imagePath,
      ocrText,
      result: aiResult,
      template: learnedTemplate,
      sampleImageHash,
      ocrLanguage
    });
  } catch (error) {
    const ocr = ocrText ? { ocrText, ocrLanguage } : await runPlainOcr(file.path);
    ocrText = ocr.ocrText;
    ocrLanguage = ocr.ocrLanguage;

    const template = await findTemplateByOcrText(ocrText, companyId);
    if (template && template.failCount < 3) {
      const templated = parseWithTemplate(ocrText, template);
      if (templated.success) {
        await markTemplateSuccess(template.id, companyId);
        return responsePayload({
          source: 'template',
          imagePath,
          ocrText,
          result: templated.result,
          template,
          sampleImageHash,
          ocrLanguage
        });
      }
      await markTemplateFailure(template.id, companyId);
    }

    return responsePayload({
      source: 'plain_ocr',
      imagePath,
      ocrText,
      result: parsePlainOcrFallback(ocrText, error),
      template: null,
      sampleImageHash,
      ocrLanguage
    });
  }
}

export async function runPlainOcr(imagePath) {
  const ocrLanguage = process.env.OCR_LANG || 'eng+chi_sim';
  const result = await Tesseract.recognize(imagePath, ocrLanguage, {
    logger: (message) => {
      if (message.status) {
        console.log(`[ocr] ${message.status} ${Math.round((message.progress || 0) * 100)}%`);
      }
    }
  });
  return { ocrText: result.data?.text || '', ocrLanguage };
}

function responsePayload({ source, imagePath, ocrText, result, template, sampleImageHash, ocrLanguage }) {
  const recognitionSource = source === 'template' ? '妯℃澘' : source === 'ai' ? 'AI Vision' : 'OCR';
  const usedTemplate = source === 'template';
  const usedAI = source === 'ai';
  const invoiceItems = Array.isArray(result.items) ? result.items : [];
  const supplierParts = splitSupplierNameParts(result.supplierName || '');
  const supplierNameChinese = result.supplierNameChinese || supplierParts.supplierNameChinese;
  const supplierNameEnglish = result.supplierNameEnglish || supplierParts.supplierNameEnglish;
  const calculatedTotal = invoiceItems.reduce((sum, item) => sum + Number(item.totalPrice || item.amount || 0), 0);
  const invoiceTotal = Number(result.totalAmount || 0);
  const totalDifference = invoiceTotal > 0 ? Math.abs(calculatedTotal - invoiceTotal) : 0;
  const warnings = [...(result.warnings || [])];
  if (invoiceTotal > 0 && totalDifference > 0.05) {
    warnings.push('Item total does not match invoice total. Manual review required.');
  }

  const parsed = {
    supplierName: buildSupplierDisplayName({
      supplierNameChinese,
      supplierNameEnglish,
      displayName: result.supplierName || ''
    }),
    supplierNameChinese,
    supplierNameEnglish,
    invoiceNo: result.invoiceNo,
    invoiceDate: normalizeInvoiceDate(result.invoiceDate),
    pageNumber: Number(result.pageNumber || 0),
    pageCount: Number(result.pageCount || 0),
    invoiceGroupKey: result.invoiceGroupKey || '',
    invoiceLayoutType: result.invoiceLayoutType || 'normal_invoice',
    totalAmount: result.totalAmount,
    invoiceTotal,
    calculatedTotal,
    totalDifference,
    supplierConfidence: Number(result.supplierConfidence ?? result.confidence ?? (result.supplierName ? 0.8 : 0.35)),
    invoiceNoConfidence: Number(result.invoiceNoConfidence ?? result.confidence ?? (result.invoiceNo ? 0.8 : 0.35)),
    dateConfidence: Number(result.dateConfidence ?? result.confidence ?? (result.invoiceDate ? 0.8 : 0.35)),
    itemConfidence: Number(result.itemConfidence ?? result.confidence ?? (invoiceItems.length ? 0.75 : 0.25)),
    priceConfidence: Number(result.priceConfidence ?? (totalDifference > 0.05 ? 0.45 : 0.85)),
    items: invoiceItems.map((item) => {
      const displayName = item.name || [item.nameCn, item.nameEn].filter(Boolean).join(' ');
      const standardName = item.standardName || displayName;
      const normalizedName = item.normalizedName || standardName.trim().toLowerCase();
      return {
        nameCn: item.nameCn || '',
        nameEn: item.nameEn || '',
        name: standardName,
        standardName,
        normalizedName,
        barcode: item.barcode || '',
        spec: item.spec || '',
        productNameOriginal: standardName,
        productNameNormalized: normalizedName,
        category: '',
        quantity: item.qty || 0,
        qty: item.qty || 0,
        unit: item.unit || item.spec || '',
        unitPrice: item.unitPrice || 0,
        totalPrice: item.totalPrice || 0,
        isFreeItem: Boolean(item.isFreeItem) || Number(item.unitPrice || 0) === 0 || Number(item.totalPrice || 0) === 0,
        freeReason: item.freeReason || ((Number(item.unitPrice || 0) === 0 || Number(item.totalPrice || 0) === 0) ? 'free item' : ''),
        candidateOnly: Boolean(item.candidateOnly),
        isHandwrittenQuantity: Boolean(item.isHandwrittenQuantity),
        isHandwrittenPrice: Boolean(item.isHandwrittenPrice),
        isHandwrittenAmount: Boolean(item.isHandwrittenAmount),
        isCircled: Boolean(item.isCircled),
        isChecked: Boolean(item.isChecked),
        notes: ''
      };
    }),
    templateCandidate: result.templateCandidate,
    confidence: result.confidence,
    warnings
  };

  return {
    success: true,
    source,
    recognitionSource,
    ocrLanguage,
    usedTemplate,
    usedAI,
    imagePath,
    ocrText,
    parsed,
    aiResult: result,
    templateId: template?.id || null,
    sampleImageHash,
    message: source === 'template' ? 'Template parsed invoice' : source === 'ai' ? 'AI Vision parsed invoice' : 'OCR fallback parsed invoice'
  };
}

function parseMoneyFromLine(line = '') {
  const matches = String(line).match(/-?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\$?\s*\d+(?:\.\d+)?/g) || [];
  if (!matches.length) return 0;
  const value = matches[matches.length - 1].replace(/[$,\s]/g, '');
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseInvoiceNoFromOcr(lines = []) {
  const patterns = [
    /\b(?:invoice\s*(?:#|no\.?|number)?|inv\s*(?:#|no\.?)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]*)/i,
    /(?:\u53d1\u7968\u53f7|\u55ae\u865f|\u5355\u53f7)\s*[:#\uff1a-]?\s*([A-Z0-9][A-Z0-9._/-]*)/i
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = String(line).match(pattern);
      if (match?.[1] && !/^(no|number|date|total)$/i.test(match[1])) return match[1].trim();
    }
  }
  return '';
}

function parseTotalAmountFromOcr(lines = []) {
  const totalPatterns = [/\bgrand\s+total\b/i, /\bamount\s+due\b/i, /\btotal\b/i, /\u5408\u8ba1|\u7e3d\u8a08|\u603b\u8ba1|\u61c9\u4ed8\u91d1\u984d|\u5e94\u4ed8\u91d1\u989d/];
  const skipPatterns = /\b(subtotal|tax|balance\s+forward)\b|\u5c0f\u8ba1|\u7a05|\u7a0e/i;
  for (const line of [...lines].reverse()) {
    if (!totalPatterns.some((pattern) => pattern.test(line))) continue;
    if (skipPatterns.test(line) && !/\bgrand\s+total\b|\bamount\s+due\b|\u61c9\u4ed8|\u5e94\u4ed8/i.test(line)) continue;
    const amount = parseMoneyFromLine(line);
    if (amount > 0) return amount;
  }
  return 0;
}

function parsePlainOcrFallback(ocrText, aiError) {
  const lines = String(ocrText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const supplierName = lines.find((line) => /company|market|inc|\u516c\u53f8|\u5546\u884c|\u4f9b\u5e94/i.test(line)) || '';
  const items = [];
  const invoiceNo = parseInvoiceNoFromOcr(lines);
  const totalAmount = parseTotalAmountFromOcr(lines);

  for (const line of lines) {
    if (/total|subtotal|tax|invoice|date|\u5408\u8ba1|\u603b\u8ba1|\u5c0f\u8ba1|\u53d1\u7968|\u65e5\u671f/i.test(line)) continue;
    const numbers = line.match(/\d+(?:\.\d+)?/g) || [];
    if (numbers.length < 2) continue;
    const firstNumberIndex = line.search(/\d+(?:\.\d+)?/);
    const name = line.slice(0, firstNumberIndex).replace(/[|,]/g, ' ').trim();
    if (!name || name.length < 2) continue;
    const amount = Number(numbers[numbers.length - 1]);
    const unitPrice = Number(numbers[numbers.length - 2]);
    const quantity = numbers.length >= 3 ? Number(numbers[numbers.length - 3]) : (unitPrice > 0 ? amount / unitPrice : 0);
    items.push({
      nameCn: /[\u3400-\u9fff]/.test(name) ? name : '',
      nameEn: /[\u3400-\u9fff]/.test(name) ? '' : name,
      name,
      standardName: name,
      normalizedName: name.trim().toLowerCase(),
      barcode: '',
      spec: '',
      qty: quantity,
      unit: '',
      unitPrice,
      totalPrice: amount
    });
  }

  const calculatedTotal = items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  const warnings = [`AI Vision fallback was not used: ${aiError?.message || aiError || 'unknown error'}`];
  if (totalAmount > 0 && calculatedTotal > 0 && Math.abs(calculatedTotal - totalAmount) / totalAmount > 0.05) {
    warnings.push('OCR fallback total differs from item total by more than 5%; manual review required.');
  }

  return {
    supplierName,
    invoiceNo,
    invoiceDate: '',
    totalAmount,
    items,
    templateCandidate: {
      supplierKeywords: supplierName ? [supplierName] : [],
      tableHeaderKeywords: [],
      columns: []
    },
    confidence: items.length ? 0.45 : 0.2,
    warnings
  };
}
