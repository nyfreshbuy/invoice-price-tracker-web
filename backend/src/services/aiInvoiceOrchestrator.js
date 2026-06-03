import fs from 'node:fs';
import Tesseract from 'tesseract.js';
import {
  findTemplateByOcrText,
  hashImageFile,
  markTemplateFailure,
  markTemplateSuccess,
  normalizeInvoiceDate,
  parseWithTemplate,
  saveOrUpdateTemplateFromResult
} from './invoiceTemplateService.js';
import { recognizeInvoiceWithAI } from './aiInvoiceService.js';

export async function recognizeInvoice(file, options = {}) {
  const companyId = options.companyId || 'default';
  const imageBuffer = fs.readFileSync(file.path);
  const sampleImageHash = hashImageFile(imageBuffer);
  const imagePath = `/uploads/${file.filename}`;

  const ocr = await runPlainOcr(file.path);
  const ocrLanguage = ocr.ocrLanguage;
  const template = await findTemplateByOcrText(ocr.ocrText, companyId);
  if (template && template.failCount < 3) {
    const templated = parseWithTemplate(ocr.ocrText, template);
    if (templated.success) {
      await markTemplateSuccess(template.id, companyId);
      return responsePayload({
        source: 'template',
        imagePath,
        ocrText: ocr.ocrText,
        result: templated.result,
        template,
        sampleImageHash,
        ocrLanguage
      });
    }
    await markTemplateFailure(template.id, companyId);
  }

  let aiResult;
  let learnedTemplate;
  try {
    aiResult = await recognizeInvoiceWithAI(file.path, { mimeType: file.mimetype });
    learnedTemplate = await saveOrUpdateTemplateFromResult(aiResult, sampleImageHash, companyId);
  } catch (error) {
    const fallbackResult = parsePlainOcrFallback(ocr.ocrText, error);
    return responsePayload({
      source: 'plain_ocr',
      imagePath,
      ocrText: ocr.ocrText,
      result: fallbackResult,
      template: null,
      sampleImageHash,
      ocrLanguage
    });
  }

  return responsePayload({
    source: 'ai',
    imagePath,
    ocrText: ocr.ocrText,
    result: aiResult,
    template: learnedTemplate,
    sampleImageHash,
    ocrLanguage
  });
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
  const recognitionSource = source === 'template' ? '模板' : source === 'ai' ? 'AI Vision' : 'OCR';
  const usedTemplate = source === 'template';
  const usedAI = source === 'ai';
  const parsed = {
    supplierName: result.supplierName,
    invoiceNo: result.invoiceNo,
    invoiceDate: normalizeInvoiceDate(result.invoiceDate),
    totalAmount: result.totalAmount,
    items: result.items.map((item) => {
      const displayName = item.name || [item.nameCn, item.nameEn].filter(Boolean).join(' ');
      const normalizedName = item.normalizedName || displayName.trim().toLowerCase();
      return {
        nameCn: item.nameCn || '',
        nameEn: item.nameEn || '',
        name: displayName,
        normalizedName,
        barcode: item.barcode || '',
        spec: item.spec || '',
        productNameOriginal: displayName,
        productNameNormalized: normalizedName,
        category: '',
        quantity: item.qty || 0,
        qty: item.qty || 0,
        unit: item.unit || item.spec || '',
        unitPrice: item.unitPrice || 0,
        totalPrice: item.totalPrice || 0,
        notes: ''
      };
    }),
    templateCandidate: result.templateCandidate,
    confidence: result.confidence,
    warnings: result.warnings
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
    message: source === 'template' ? 'Template OCR parsed invoice' : 'AI Vision parsed invoice'
  };
}

function parsePlainOcrFallback(ocrText, aiError) {
  const lines = String(ocrText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const supplierName = lines.find((line) => /company|market|inc|公司|商行|供应/.test(line.toLowerCase())) || '';
  const items = [];

  for (const line of lines) {
    if (/total|subtotal|tax|invoice|date|合计|总计|小计|税|发票|日期/.test(line.toLowerCase())) continue;
    const numbers = line.match(/\d+(?:\.\d+)?/g) || [];
    if (numbers.length < 2) continue;
    const firstNumberIndex = line.search(/\d+(?:\.\d+)?/);
    const name = line.slice(0, firstNumberIndex).replace(/[|,，]/g, ' ').trim();
    if (!name || name.length < 2) continue;
    const amount = Number(numbers[numbers.length - 1]);
    const unitPrice = Number(numbers[numbers.length - 2]);
    const quantity = numbers.length >= 3 ? Number(numbers[numbers.length - 3]) : (unitPrice > 0 ? amount / unitPrice : 0);
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

  return {
    supplierName,
    invoiceNo: '',
    invoiceDate: '',
    totalAmount: 0,
    items,
    templateCandidate: {
      supplierKeywords: supplierName ? [supplierName] : [],
      tableHeaderKeywords: [],
      columns: []
    },
    confidence: items.length ? 0.45 : 0.2,
    warnings: [`AI Vision fallback was not used: ${aiError?.message || aiError || 'unknown error'}`]
  };
}
