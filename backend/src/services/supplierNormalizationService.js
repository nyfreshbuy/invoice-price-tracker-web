const traditionalMap = new Map(Object.entries({
  '閩': '闽',
  '國': '国',
  '際': '际',
  '貿': '贸',
  '進': '进',
  '齣': '出',
  '發': '发',
  '臺': '台',
  '灣': '湾',
  '華': '华',
  '東': '东',
  '廣': '广',
  '龍': '龙',
  '萬': '万',
  '聯': '联',
  '豐': '丰',
  '業': '业',
  '號': '号',
  '產': '产',
  '實': '实',
  '貿': '贸',
  '購': '购',
  '應': '应',
  '氣': '气'
}));

const companySuffixPattern = /\b(INC|INCORPORATED|CO|COMPANY|LTD|LIMITED|LLC|CORP|CORPORATION|INTERNATIONAL|TRADING|IMPORT|EXPORT)\b/g;
const chineseSuffixPattern = /(股份有限公司|有限责任公司|有限公司|公司|股份|国际|國際|贸易|貿易|进出口|進出口|商行|企业|企業)$/g;

export function toHalfWidth(value = '') {
  return String(value)
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

export function traditionalToSimplified(value = '') {
  return [...String(value)].map((char) => traditionalMap.get(char) || char).join('');
}

export function supplierAliasesFromName(value = '') {
  const raw = String(value || '').trim();
  const simplified = traditionalToSimplified(toHalfWidth(raw));
  const english = simplified.match(/[A-Za-z][A-Za-z0-9&.,'\-\s]+/g)?.join(' ').trim().toUpperCase() || '';
  const chinese = simplified.match(/[\u3400-\u9fff]+/g)?.join('').trim() || '';
  return [...new Set([raw, simplified, chinese, english].map((entry) => String(entry || '').trim()).filter(Boolean))];
}

export function normalizeSupplierName(value = '') {
  const simplified = traditionalToSimplified(toHalfWidth(value)).toUpperCase();
  const withoutChineseSuffix = simplified.replace(chineseSuffixPattern, '');
  const withoutEnglishSuffix = withoutChineseSuffix.replace(companySuffixPattern, ' ');
  const compact = withoutEnglishSuffix
    .replace(/[^\u3400-\u9fffA-Z0-9]+/g, '')
    .replace(/有限公司|股份有限公司|公司|股份/g, '');
  return compact || simplified.replace(/[^\u3400-\u9fffA-Z0-9]+/g, '');
}

export function displaySupplierName(existing = {}, incomingName = '') {
  const aliases = supplierAliasesFromName(incomingName || existing.displayName || existing.name || '');
  const all = [...supplierAliasesFromName(existing.displayName || existing.name || ''), ...aliases];
  const chinese = all.find((entry) => /[\u3400-\u9fff]/.test(entry)) || '';
  const english = all.find((entry) => /^[A-Z0-9&.,'\-\s]+$/.test(entry) && /[A-Z]/.test(entry)) || '';
  return [chinese, english].filter(Boolean).join(' ') || incomingName || existing.displayName || existing.name || '';
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
  const leftNormalized = a.normalizedName || normalizeSupplierName(a.name || a.displayName || '');
  const rightNormalized = b.normalizedName || normalizeSupplierName(b.name || b.displayName || '');
  if (leftNormalized && rightNormalized && leftNormalized === rightNormalized) return true;
  if (a.phone && b.phone && a.phone === b.phone) return true;
  if (a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase()) return true;
  if (a.address && b.address && normalizeSupplierName(a.address) === normalizeSupplierName(b.address)) return true;
  return supplierSimilarity(leftNormalized, rightNormalized) > 0.85;
}
