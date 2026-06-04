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

export async function recognizeInvoice(file, options = {}) {
  const companyId = options.companyId || 'default';
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
  const recognitionSource = source === 'template' ? '模板' : source === 'ai' ? 'AI Vision' : 'OCR';
  const usedTemplate = source === 'template';
  const usedAI = source === 'ai';
  const calculatedTotal = result.items.reduce((sum, item) => sum + Number(item.totalPrice || item.amount || 0), 0);
  const invoiceTotal = Number(result.totalAmount || 0);
  const totalDifference = invoiceTotal > 0 ? Math.abs(calculatedTotal - invoiceTotal) : 0;
  const warnings = [...(result.warnings || [])];
  if (invoiceTotal > 0 && totalDifference > 0.05) {
    warnings.push('商品明细与发票总额不一致，请检查。');
  }

  const parsed = {
    supplierName: result.supplierName,
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
    itemConfidence: Number(result.itemConfidence ?? result.confidence ?? (result.items.length ? 0.75 : 0.25)),
    priceConfidence: Number(result.priceConfidence ?? (totalDifference > 0.05 ? 0.45 : 0.85)),
    items: result.items.map((item) => {
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
        freeReason: item.freeReason || ((Number(item.unitPrice || 0) === 0 || Number(item.totalPrice || 0) === 0) ? '免费/赠品行' : ''),
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

function parsePlainOcrFallback(ocrText, aiError) {
  const lines = String(ocrText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const supplierName = lines.find((line) => /company|market|inc|公司|商行|供应/.test(line.toLowerCase())) || '';
  const items = [];

  for (const line of lines) {
    if (/total|subtotal|tax|invoice|date|合计|总计|小计|发票|日期/.test(line.toLowerCase())) continue;
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
