import fs from 'node:fs';
import crypto from 'node:crypto';
import Tesseract from 'tesseract.js';
import {
  findTemplateByOcrText,
  findTemplateBySupplierHint,
  markTemplateFailure,
  markTemplateSuccess,
  normalizeInvoiceDate,
  parseWithTemplate,
  saveOrUpdateTemplateFromResult
} from './invoiceTemplateService.js';
import { recognizeInvoiceWithAI } from './aiInvoiceService.js';
import { buildSupplierDisplayName, splitSupplierNameParts } from './supplierNormalizationService.js';

const OCR_IMAGE_MAX_EDGE = Number(process.env.OCR_IMAGE_MAX_EDGE || 1800);
const OCR_IMAGE_QUALITY = Number(process.env.OCR_IMAGE_QUALITY || 72);
let sharpLoader;

export async function recognizeInvoice(file, options = {}) {
  const companyId = options.companyId || '';
  if (!companyId) throw new Error('Missing authenticated companyId');

  const sampleImageHash = await hashFileStreaming(file.path);
  const imagePath = `/uploads/${file.filename}`;
  const supplierHint = [options.supplierHint, file.originalname].filter(Boolean).join(' ');
  const recognitionImage = await prepareRecognitionImage(file.path);
  const recognitionPath = recognitionImage.path;
  const recognitionMimeType = recognitionImage.mimeType || file.mimetype || 'image/jpeg';
  logMemory('recognition:start');

  try {
    let ocrText = '';
    let ocrLanguage = '';
    if (options.forceAI) {
      console.log('[AI VISION FORCED]', { companyId, supplierHint });
      const aiResult = await recognizeInvoiceWithAI(recognitionPath, { mimeType: recognitionMimeType });
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
    }
    const hintedTemplate = await findTemplateBySupplierHint(supplierHint, companyId);
    let templateMissReason = '';
    if (hintedTemplate && hintedTemplate.failCount < 3) {
      console.log('[TEMPLATE MATCH]', {
        companyId,
        stage: 'supplier_hint',
        supplierHint,
        templateId: hintedTemplate.id,
        templateName: hintedTemplate.supplierName || ''
      });
      const ocr = await safeRunPlainOcr(recognitionPath, {
        companyId,
        stage: 'supplier_hint_ocr',
        supplierHint,
        templateId: hintedTemplate.id,
        templateName: hintedTemplate.supplierName || ''
      });
      ocrText = ocr.ocrText;
      ocrLanguage = ocr.ocrLanguage;
      const templated = parseWithTemplate(ocrText, hintedTemplate);
      if (templated.success) {
        await markTemplateSuccess(hintedTemplate.id, companyId);
        try {
          console.log('[AI VISION ITEM OVERRIDE]', {
            companyId,
            stage: 'supplier_hint_template_success',
            templateId: hintedTemplate.id,
            templateName: hintedTemplate.supplierName || ''
          });
          const aiResult = await recognizeInvoiceWithAI(recognitionPath, { mimeType: recognitionMimeType });
          const mergedResult = mergeTemplateHeaderWithAiItems(templated.result, aiResult);
          const learnedTemplate = await saveOrUpdateTemplateFromResult(mergedResult, sampleImageHash, companyId);
          return responsePayload({
            source: 'ai',
            imagePath,
            ocrText,
            result: mergedResult,
            template: learnedTemplate || hintedTemplate,
            sampleImageHash,
            ocrLanguage
          });
        } catch (error) {
          console.warn('[AI VISION ITEM OVERRIDE FAILED]', {
            companyId,
            stage: 'supplier_hint_template_success',
            templateId: hintedTemplate.id,
            reason: error?.message || error
          });
        }
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
      templateMissReason = templated.error || 'supplier hint template parse failed';
      console.log('[TEMPLATE MISS]', {
        companyId,
        stage: 'supplier_hint_parse',
        supplierHint,
        templateId: hintedTemplate.id,
        templateName: hintedTemplate.supplierName || '',
        reason: templateMissReason
      });
      await markTemplateFailure(hintedTemplate.id, companyId);
    } else {
      templateMissReason = hintedTemplate ? 'template disabled after repeated failures' : 'no supplier hint template matched';
      console.log('[TEMPLATE MISS]', {
        companyId,
        stage: 'supplier_hint',
        supplierHint,
        templateId: hintedTemplate?.id || '',
        templateName: hintedTemplate?.supplierName || '',
        reason: templateMissReason
      });
    }

    if (!ocrText) {
      const ocr = await safeRunPlainOcr(recognitionPath, {
        companyId,
        stage: 'ocr_text_before_ai',
        supplierHint
      });
      ocrText = ocr.ocrText;
      ocrLanguage = ocr.ocrLanguage;
    }
    const textTemplate = ocrText ? await findTemplateByOcrText(ocrText, companyId) : null;
    if (textTemplate && textTemplate.failCount < 3) {
      console.log('[TEMPLATE MATCH]', {
        companyId,
        stage: 'ocr_text',
        supplierHint,
        templateId: textTemplate.id,
        templateName: textTemplate.supplierName || ''
      });
      const templated = parseWithTemplate(ocrText, textTemplate);
      if (templated.success) {
        await markTemplateSuccess(textTemplate.id, companyId);
        try {
          console.log('[AI VISION ITEM OVERRIDE]', {
            companyId,
            stage: 'ocr_text_template_success',
            templateId: textTemplate.id,
            templateName: textTemplate.supplierName || ''
          });
          const aiResult = await recognizeInvoiceWithAI(recognitionPath, { mimeType: recognitionMimeType });
          const mergedResult = mergeTemplateHeaderWithAiItems(templated.result, aiResult);
          const learnedTemplate = await saveOrUpdateTemplateFromResult(mergedResult, sampleImageHash, companyId);
          return responsePayload({
            source: 'ai',
            imagePath,
            ocrText,
            result: mergedResult,
            template: learnedTemplate || textTemplate,
            sampleImageHash,
            ocrLanguage
          });
        } catch (error) {
          console.warn('[AI VISION ITEM OVERRIDE FAILED]', {
            companyId,
            stage: 'ocr_text_template_success',
            templateId: textTemplate.id,
            reason: error?.message || error
          });
        }
        return responsePayload({
          source: 'template',
          imagePath,
          ocrText,
          result: templated.result,
          template: textTemplate,
          sampleImageHash,
          ocrLanguage
        });
      }
      templateMissReason = templated.error || 'ocr text template parse failed';
      console.log('[TEMPLATE MISS]', {
        companyId,
        stage: 'ocr_text_parse',
        supplierHint,
        templateId: textTemplate.id,
        templateName: textTemplate.supplierName || '',
        reason: templateMissReason
      });
      await markTemplateFailure(textTemplate.id, companyId);
    } else {
      const reason = textTemplate ? 'template disabled after repeated failures' : 'no OCR text template matched';
      templateMissReason = templateMissReason ? `${templateMissReason}; ${reason}` : reason;
      console.log('[TEMPLATE MISS]', {
        companyId,
        stage: 'ocr_text',
        supplierHint,
        templateId: textTemplate?.id || '',
        templateName: textTemplate?.supplierName || '',
        reason
      });
    }

    try {
      console.log('[AI VISION FALLBACK]', {
        companyId,
        supplierHint,
        reason: templateMissReason || 'template not available'
      });
      const aiResult = await recognizeInvoiceWithAI(recognitionPath, { mimeType: recognitionMimeType });
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
      const ocr = ocrText ? { ocrText, ocrLanguage } : await runPlainOcr(recognitionPath);
      ocrText = ocr.ocrText;
      ocrLanguage = ocr.ocrLanguage;

      const template = await findTemplateByOcrText(ocrText, companyId);
      if (template && template.failCount < 3) {
        console.log('[TEMPLATE MATCH]', {
          companyId,
          stage: 'ai_failure_ocr_text',
          supplierHint,
          templateId: template.id,
          templateName: template.supplierName || ''
        });
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
        console.log('[TEMPLATE MISS]', {
          companyId,
          stage: 'ai_failure_ocr_text_parse',
          supplierHint,
          templateId: template.id,
          templateName: template.supplierName || '',
          reason: templated.error || 'template parse failed after AI failure'
        });
        await markTemplateFailure(template.id, companyId);
      } else {
        console.log('[TEMPLATE MISS]', {
          companyId,
          stage: 'ai_failure_ocr_text',
          supplierHint,
          templateId: template?.id || '',
          templateName: template?.supplierName || '',
          reason: template ? 'template disabled after repeated failures' : 'no template matched after AI failure'
        });
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
  } finally {
    cleanupRecognitionImage(recognitionImage);
    logMemory('recognition:finish');
  }
}

export async function runPlainOcr(imagePath) {
  const ocrLanguage = process.env.OCR_LANG || 'eng+chi_sim';
  logMemory('ocr:start');
  let result = null;
  try {
    result = await Tesseract.recognize(imagePath, ocrLanguage, {
      logger: (message) => {
        if (message.status) {
          console.log(`[ocr] ${message.status} ${Math.round((message.progress || 0) * 100)}%`);
        }
      }
    });
    return { ocrText: result.data?.text || '', ocrLanguage };
  } finally {
    result = null;
    logMemory('ocr:finish');
  }
}

async function safeRunPlainOcr(imagePath, context = {}) {
  try {
    return await runPlainOcr(imagePath);
  } catch (error) {
    console.warn('[TEMPLATE MISS]', {
      companyId: context.companyId || '',
      stage: context.stage || 'ocr',
      supplierHint: context.supplierHint || '',
      templateId: context.templateId || '',
      templateName: context.templateName || '',
      reason: `OCR failed before template matching: ${error?.message || error}`
    });
    return { ocrText: '', ocrLanguage: process.env.OCR_LANG || 'eng+chi_sim', error };
  }
}

async function prepareRecognitionImage(imagePath) {
  const sharp = await loadSharp();
  if (!sharp) return { path: imagePath, mimeType: 'image/jpeg', temporary: false, optimized: false };

  const outputPath = `${imagePath}.recognition.jpg`;
  try {
    await sharp(imagePath, { limitInputPixels: 25000000 })
      .rotate()
      .resize({ width: OCR_IMAGE_MAX_EDGE, height: OCR_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .jpeg({ quality: OCR_IMAGE_QUALITY, mozjpeg: true })
      .toFile(outputPath);
    const inputSize = fs.existsSync(imagePath) ? fs.statSync(imagePath).size : 0;
    const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    console.log('[recognition-image] optimized', { inputSize, outputSize, maxEdge: OCR_IMAGE_MAX_EDGE, quality: OCR_IMAGE_QUALITY });
    return { path: outputPath, mimeType: 'image/jpeg', temporary: true, optimized: true };
  } catch (error) {
    console.warn('[recognition-image] optimize failed, using original', error?.message || error);
    cleanupRecognitionImage({ path: outputPath, temporary: true });
    return { path: imagePath, mimeType: 'image/jpeg', temporary: false, optimized: false };
  }
}

function cleanupRecognitionImage(image) {
  if (!image?.temporary || !image.path) return;
  try {
    if (fs.existsSync(image.path)) fs.unlinkSync(image.path);
  } catch (error) {
    console.warn('[recognition-image] cleanup failed', error?.message || error);
  }
}

async function loadSharp() {
  if (sharpLoader !== undefined) return sharpLoader;
  try {
    const mod = await import('sharp');
    sharpLoader = mod.default || mod;
  } catch {
    sharpLoader = null;
  }
  return sharpLoader;
}

function hashFileStreaming(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function logMemory(stage) {
  if (process.env.LOG_MEMORY !== 'true') return;
  const memory = process.memoryUsage();
  console.log('[memory]', stage, {
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapMb: Math.round(memory.heapUsed / 1024 / 1024),
    externalMb: Math.round(memory.external / 1024 / 1024)
  });
}

function responsePayload({ source, imagePath, ocrText, result, template, sampleImageHash, ocrLanguage }) {
  const recognitionSource = source === 'template' ? '模板' : source === 'ai' ? 'AI Vision' : 'OCR';
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
      const quality = evaluateProductNameQuality({
        ...item,
        name: standardName,
        standardName,
        normalizedName
      }, { source });
      return {
        nameCn: item.nameCn || '',
        nameEn: item.nameEn || '',
        name: standardName,
        standardName,
        normalizedName,
        barcode: item.barcode || '',
        spec: item.spec || '',
        rawOcrLine: item.rawOcrLine || item.ocrLine || '',
        itemConfidence: Number(item.itemConfidence ?? item.confidence ?? quality.confidence),
        nameConfidence: Number(item.itemConfidence ?? item.confidence ?? quality.confidence),
        nameQualityStatus: quality.ok ? 'trusted' : 'needs_review',
        nameQualityReason: quality.reasons.join(', '),
        itemRecognitionSource: source,
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
        candidateOnly: Boolean(item.candidateOnly) || !quality.ok,
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

function mergeTemplateHeaderWithAiItems(templateResult = {}, aiResult = {}) {
  return {
    ...templateResult,
    ...aiResult,
    supplierName: templateResult.supplierName || aiResult.supplierName || '',
    supplierNameChinese: templateResult.supplierNameChinese || aiResult.supplierNameChinese || '',
    supplierNameEnglish: templateResult.supplierNameEnglish || aiResult.supplierNameEnglish || '',
    invoiceNo: templateResult.invoiceNo || aiResult.invoiceNo || '',
    invoiceDate: templateResult.invoiceDate || aiResult.invoiceDate || '',
    totalAmount: Number(templateResult.totalAmount || 0) > 0 ? templateResult.totalAmount : aiResult.totalAmount,
    pageNumber: templateResult.pageNumber || aiResult.pageNumber || 0,
    pageCount: templateResult.pageCount || aiResult.pageCount || 0,
    invoiceGroupKey: templateResult.invoiceGroupKey || aiResult.invoiceGroupKey || '',
    invoiceLayoutType: templateResult.invoiceLayoutType || aiResult.invoiceLayoutType || 'normal_invoice',
    items: Array.isArray(aiResult.items) ? aiResult.items : [],
    warnings: [...(templateResult.warnings || []), ...(aiResult.warnings || []), 'Product items were extracted by AI Vision; template/OCR used only as header assistance.'],
    confidence: Math.max(Number(templateResult.confidence || 0), Number(aiResult.confidence || 0))
  };
}

function evaluateProductNameQuality(item = {}, context = {}) {
  const name = String(item.standardName || item.name || item.productNameOriginal || [item.nameCn, item.nameEn].filter(Boolean).join(' ') || '').trim();
  const confidence = Number(item.itemConfidence ?? item.confidence ?? (context.source === 'ai' ? 0.82 : 0.45));
  const reasons = [];
  if (!name) reasons.push('empty_name');
  if (confidence < 0.55) reasons.push('low_confidence');
  if (/={1,}|\*{2,}|\?{2,}|[_|]{3,}/.test(name)) reasons.push('symbol_noise');
  const compact = name.replace(/\s+/g, '');
  if (compact.length <= 2 && !/[\u3400-\u9fff]/.test(compact)) reasons.push('too_short');
  const symbolCount = (name.match(/[^A-Za-z0-9\u3400-\u9fff\s.&'’()\-/]/g) || []).length;
  if (name.length > 0 && symbolCount / name.length > 0.22) reasons.push('too_many_symbols');
  const alphaTokens = name.match(/[A-Za-z]+/g) || [];
  const shortAlphaTokens = alphaTokens.filter((token) => token.length <= 2).length;
  if (alphaTokens.length >= 3 && shortAlphaTokens / alphaTokens.length > 0.65) reasons.push('broken_english_tokens');
  if (/^[a-z]{1,4}\s*[=:-]?$/i.test(name)) reasons.push('ocr_fragment');
  if (context.source !== 'ai') reasons.push('not_ai_verified');
  return {
    ok: reasons.length === 0,
    confidence,
    reasons
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
