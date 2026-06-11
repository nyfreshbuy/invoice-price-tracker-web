const traditionalCharMap = new Map(Object.entries({
  '\u95a9': '\u95fd',
  '\u570b': '\u56fd',
  '\u969b': '\u9645',
  '\u8cbf': '\u8d38',
  '\u9032': '\u8fdb',
  '\u83ef': '\u534e',
  '\u6771': '\u4e1c',
  '\u7522': '\u4ea7',
  '\u696d': '\u4e1a',
  '\u842c': '\u4e07',
  '\u767c': '\u53d1',
  '\u9580': '\u95e8',
  '\u9f8d': '\u9f99',
  '\u8ca8': '\u8d27',
  '\u8ce3': '\u5356',
  '\u8cb7': '\u4e70'
}));

const englishLegalSuffixes = new Set([
  'INC',
  'INC.',
  'INCORPORATED',
  'CO',
  'CO.',
  'COMPANY',
  'LTD',
  'LTD.',
  'LIMITED',
  'LLC',
  'CORP',
  'CORP.',
  'CORPORATION'
]);

const englishLegalSuffixDisplay = {
  INC: 'Inc.',
  'INC.': 'Inc.',
  INCORPORATED: 'Inc.',
  CO: 'Co.',
  'CO.': 'Co.',
  COMPANY: 'Company',
  LTD: 'Ltd.',
  'LTD.': 'Ltd.',
  LIMITED: 'Ltd.',
  LLC: 'LLC',
  CORP: 'Corp.',
  'CORP.': 'Corp.',
  CORPORATION: 'Corp.'
};

const englishNormalizeSuffixPattern = /\b(INC|INC\.|INCORPORATED|CO|CO\.|COMPANY|LTD|LTD\.|LIMITED|LLC|CORP|CORP\.|CORPORATION|INTERNATIONAL|TRADING|IMPORT|EXPORT)\b/g;
const chineseNormalizeSuffixPattern = /(\u80a1\u4efd\u6709\u9650\u516c\u53f8|\u6709\u9650\u8d23\u4efb\u516c\u53f8|\u6709\u9650\u516c\u53f8|\u516c\u53f8|\u80a1\u4efd|\u570b\u969b|\u56fd\u9645|\u8cbf\u6613|\u8d38\u6613|\u9032\u51fa\u53e3|\u8fdb\u51fa\u53e3|\u5546\u884c|\u4f01\u4e1a|\u4f01\u696d)$/g;

export function toHalfWidth(value = '') {
  return String(value)
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

export function traditionalToSimplified(value = '') {
  return [...String(value)].map((char) => traditionalCharMap.get(char) || char).join('');
}

function normalizeEnglishToken(token = '') {
  return String(token || '').replace(/[^\w&.'-]/g, '').toUpperCase();
}

function titleCaseEnglishCompany(value = '') {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const upper = normalizeEnglishToken(word);
      if (!upper) return '';
      if (englishLegalSuffixes.has(upper)) return englishLegalSuffixDisplay[upper] || upper;
      if (upper.length <= 2) return upper;
      return `${upper.slice(0, 1)}${upper.slice(1).toLowerCase()}`;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\bInc\b\.?/g, 'Inc.')
    .replace(/\bCo\b\.?/g, 'Co.')
    .replace(/\bCorp\b\.?/g, 'Corp.')
    .replace(/\bLtd\b\.?/g, 'Ltd.');
}

function collapseRepeatedWordSequence(words = []) {
  const clean = words.map(normalizeEnglishToken).filter(Boolean);
  if (clean.length < 2) return clean;

  for (let size = 1; size <= Math.floor(clean.length / 2); size += 1) {
    const base = clean.slice(0, size);
    let repeated = true;
    for (let index = size; index < clean.length; index += 1) {
      if (clean[index] !== base[index % size]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return base;
  }

  const output = [];
  for (const word of clean) {
    if (output[output.length - 1] === word) continue;
    output.push(word);
  }
  return output;
}

export function cleanSupplierEnglishName(value = '') {
  const normalized = toHalfWidth(value)
    .replace(/[^A-Za-z0-9&.'\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[A-Za-z]/.test(normalized)) return '';
  return titleCaseEnglishCompany(collapseRepeatedWordSequence(normalized.split(/\s+/)).join(' '));
}

export function splitSupplierNameParts(value = '') {
  const raw = traditionalToSimplified(toHalfWidth(value));
  const supplierNameChinese = raw.match(/[\u3400-\u9fff]+/g)?.join('').trim() || '';
  const supplierNameEnglish = cleanSupplierEnglishName(raw.match(/[A-Za-z][A-Za-z0-9&.,'\-\s]+/g)?.join(' ') || '');
  return { supplierNameChinese, supplierNameEnglish };
}

export function buildSupplierDisplayName({ supplierNameChinese = '', supplierNameEnglish = '', supplierDisplayName = '', displayName = '', name = '' } = {}) {
  const fallbackParts = splitSupplierNameParts(supplierDisplayName || displayName || name);
  const chinese = String(supplierNameChinese || fallbackParts.supplierNameChinese || '').trim();
  const english = cleanSupplierEnglishName(supplierNameEnglish || fallbackParts.supplierNameEnglish || '');
  const fallback = cleanSupplierEnglishName(supplierDisplayName || displayName || name) || String(supplierDisplayName || displayName || name || '').trim();
  return [chinese, english].filter(Boolean).join(' ') || fallback;
}

export function supplierAliasesFromName(value = '') {
  const raw = String(value || '').trim();
  const simplified = traditionalToSimplified(toHalfWidth(raw));
  const { supplierNameChinese, supplierNameEnglish } = splitSupplierNameParts(simplified);
  return [...new Set([raw, simplified, supplierNameChinese, supplierNameEnglish].map((entry) => String(entry || '').trim()).filter(Boolean))];
}

export function normalizeSupplierName(value = '') {
  const simplified = traditionalToSimplified(toHalfWidth(value)).toUpperCase();
  const withoutChineseSuffix = simplified.replace(chineseNormalizeSuffixPattern, '');
  const withoutEnglishSuffix = withoutChineseSuffix.replace(englishNormalizeSuffixPattern, ' ');
  const compact = withoutEnglishSuffix
    .replace(/[^\u3400-\u9fffA-Z0-9]+/g, '')
    .replace(/\u80a1\u4efd\u6709\u9650\u516c\u53f8|\u6709\u9650\u516c\u53f8|\u516c\u53f8|\u80a1\u4efd/g, '');
  return compact || simplified.replace(/[^\u3400-\u9fffA-Z0-9]+/g, '');
}

export function displaySupplierName(existing = {}, incomingName = '') {
  const mergedInput = [
    existing.supplierNameChinese,
    existing.supplierNameEnglish,
    existing.supplierDisplayName,
    existing.displayName,
    existing.name,
    incomingName
  ].filter(Boolean).join(' ');
  const parts = splitSupplierNameParts(mergedInput);
  return buildSupplierDisplayName({
    supplierNameChinese: existing.supplierNameChinese || parts.supplierNameChinese,
    supplierNameEnglish: existing.supplierNameEnglish || parts.supplierNameEnglish,
    supplierDisplayName: existing.supplierDisplayName,
    displayName: incomingName || existing.displayName || existing.name || ''
  });
}

export function parseAliases(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value || '').split('|').map((entry) => entry.trim()).filter(Boolean);
  }
}

export function mergeAliases(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : parseAliases(value)).map((entry) => String(entry || '').trim()).filter(Boolean))];
}

export function levenshtein(a = '', b = '') {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let last = i - 1;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = previous[j];
      previous[j] = left[i - 1] === right[j - 1]
        ? last
        : Math.min(last + 1, previous[j] + 1, previous[j - 1] + 1);
      last = current;
    }
  }
  return previous[right.length];
}

export function supplierSimilarity(a = '', b = '') {
  const left = normalizeSupplierName(a);
  const right = normalizeSupplierName(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export function isSupplierDuplicateCandidate(a = {}, b = {}) {
  const leftName = a.supplierDisplayName || a.displayName || a.name || '';
  const rightName = b.supplierDisplayName || b.displayName || b.name || '';
  const leftNormalized = a.normalizedName || normalizeSupplierName(leftName);
  const rightNormalized = b.normalizedName || normalizeSupplierName(rightName);
  if (leftNormalized && rightNormalized && leftNormalized === rightNormalized) return true;
  if (a.phone && b.phone && a.phone === b.phone) return true;
  if (a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase()) return true;
  if (a.address && b.address && normalizeSupplierName(a.address) === normalizeSupplierName(b.address)) return true;
  return supplierSimilarity(leftNormalized || leftName, rightNormalized || rightName) > 0.85;
}
