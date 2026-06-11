import fs from 'node:fs';
import { normalizeInvoiceResult, defaultTemplateCandidate } from './invoiceTemplateService.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export async function recognizeInvoiceWithAI(imagePath, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const mimeType = options.mimeType || 'image/jpeg';
  const imageUrl = `data:${mimeType};base64,${imageBase64}`;

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Extract this supplier invoice into strict JSON. Return only JSON.',
              'Do not save anything.',
              'Product names are critical:',
              'Supplier names are critical:',
              '- Extract supplierNameChinese and supplierNameEnglish separately.',
              '- Do not repeat the same English company name. If the invoice shows the same English company name multiple times, return it once.',
              '- Set supplierName to supplierNameChinese + " " + supplierNameEnglish, using only available parts.',
              '- Do not extract English only.',
              '- Preserve the original Chinese text exactly as printed.',
              '- Do not translate Chinese into English.',
              '- Do not translate English into Chinese.',
              '- If one product has Chinese and English on adjacent lines, return both in the same item.',
              '- Preserve Chinese flavor, size, pack, and specification text inside Chinese parentheses.',
              '- If only English exists, set nameCn to an empty string.',
              '- If only Chinese exists, set nameEn to an empty string.',
              '- Set standardName to "nameCn nameEn" when both exist, otherwise the available original name.',
              '- Set name to the same value as standardName.',
              '- Set normalizedName to standardName trimmed and lowercased for English letters, without removing Chinese.',
              'Example:',
              'Invoice item lines:',
              '卡奇锅巴（香辣味）',
              'K.Q. Rice Chips',
              'Must return:',
              JSON.stringify({
                nameCn: '卡奇锅巴（香辣味）',
                nameEn: 'K.Q. Rice Chips',
                standardName: '卡奇锅巴（香辣味） K.Q. Rice Chips',
                name: '卡奇锅巴（香辣味） K.Q. Rice Chips',
                normalizedName: '卡奇锅巴（香辣味） k.q. rice chips'
              }),
              'Return invoiceDate as yyyy-MM-dd. For US supplier invoices, parse MM/DD/YYYY as month/day/year, so 06/01/2026 must be 2026-06-01. If date confidence is low, leave invoiceDate empty and add a warning.',
              'Date priority must be: Invoice Date first, then Delivery Date, then OCR/scan time. Never inherit the date from a previous invoice.',
              'Use the invoice bottom Total as totalAmount. Do not overwrite it with the item sum.',
              'Item totals are only for validation.',
              'If the invoice has a page total, put it in totalAmount for that page.',
              'Do not infer pageNumber/pageCount from photo viewer overlays, upload order, filenames, or preview counters. Return pageNumber/pageCount only when the invoice OCR text contains an explicit invoice PAGE field.',
              'Set invoiceGroupKey to supplierName + invoiceNo + totalAmount when possible.',
              'Detect invoiceLayoutType as one of: normal_invoice, printed_catalog_handwritten, multi_page, mixed.',
              'For printed catalog handwritten forms, do not return every catalog item as a purchased item.',
              'For printed catalog handwritten forms, return only rows with handwritten quantity, handwritten price, handwritten amount, circled item, or checked item.',
              'For catalog rows that are visible but not purchased, set candidateOnly=true. They will not be saved.',
              'For each item, return isHandwrittenQuantity, isHandwrittenPrice, isHandwrittenAmount, isCircled, isChecked when visible.',
              'Detect discount rows separately by name containing discount, rebate, promotion, 折扣, or negative amount/unit price.',
              'If unsure, add warnings and lower confidence.',
              'Schema:',
              JSON.stringify(invoiceJsonShape())
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: imageUrl,
            detail: 'high'
          }
        ]
      }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI Vision request failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  const parsed = parseJsonFromText(text);
  return normalizeInvoiceResult({
    ...parsed,
    templateCandidate: parsed.templateCandidate || defaultTemplateCandidate(parsed.supplierName || '')
  });
}

function invoiceJsonShape() {
  return {
    supplierName: '',
    supplierNameChinese: '',
    supplierNameEnglish: '',
    invoiceNo: '',
    invoiceDate: '',
    pageNumber: 0,
    pageCount: 0,
    invoiceGroupKey: '',
    invoiceLayoutType: 'normal_invoice',
    totalAmount: 0,
    items: [
      {
        nameCn: '',
        nameEn: '',
        standardName: '',
        name: '',
        normalizedName: '',
        barcode: '',
        spec: '',
        qty: 0,
        unit: '',
        unitPrice: 0,
        totalPrice: 0,
        candidateOnly: false,
        isHandwrittenQuantity: false,
        isHandwrittenPrice: false,
        isHandwrittenAmount: false,
        isCircled: false,
        isChecked: false
      }
    ],
    templateCandidate: {
      supplierKeywords: [],
      invoiceLayoutType: 'normal_invoice',
      tableHeaderKeywords: [],
      columns: [
        { name: 'barcode', keywords: ['Code', 'Barcode', 'Item'] },
        { name: 'nameCn', keywords: ['Chinese Name', '中文品名'] },
        { name: 'nameEn', keywords: ['Description', 'Name', 'Product'] },
        { name: 'standardName', keywords: ['Description', 'Name'] },
        { name: 'spec', keywords: ['Size', 'Pack', 'Spec'] },
        { name: 'qty', keywords: ['Qty', 'Quantity'] },
        { name: 'unitPrice', keywords: ['Unit Price', 'Price'] },
        { name: 'totalPrice', keywords: ['Amount', 'Total'] }
      ],
      tableRegion: {},
      handwrittenRegions: []
    },
    confidence: 0,
    warnings: []
  };
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const output of data.output || []) {
    for (const content of output.content || []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text);
      if (content.type === 'text' && content.text) chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI Vision response did not contain JSON');
    return JSON.parse(match[0]);
  }
}
