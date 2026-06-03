import fs from 'node:fs';
import { normalizeInvoiceResult, defaultTemplateCandidate } from './invoiceTemplateService.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export async function recognizeInvoiceWithAI(imagePath, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

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
              'Extract this supplier invoice into strict JSON.',
              'Do not save anything. Return only JSON matching the requested schema.',
              'Use the invoice Total as totalAmount. Do not overwrite it with item sum.',
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
    invoiceNo: '',
    invoiceDate: '',
    totalAmount: 0,
    items: [
      { code: '', name: '', size: '', quantity: 0, unitPrice: 0, amount: 0 }
    ],
    templateCandidate: {
      supplierKeywords: [],
      tableHeaderKeywords: [],
      columns: [
        { name: 'code', keywords: ['Code', 'Item'] },
        { name: 'name', keywords: ['Description', 'Name'] },
        { name: 'size', keywords: ['Size', 'Pack'] },
        { name: 'unitPrice', keywords: ['Unit Price', 'Price'] },
        { name: 'amount', keywords: ['Amount', 'Total'] }
      ]
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
