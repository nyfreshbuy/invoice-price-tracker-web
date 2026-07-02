import { gb18030ReverseMap } from './gb18030ReverseMap.js';

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

const knownMojibakeReplacements = new Map([
  ['澶勭悊涓?..', '处理中...'],
  ['澶勭悊涓...', '处理中...'],
  ['缁х画璇嗗埆', '继续识别'],
  ['鏆傚仠璇嗗埆', '暂停识别'],
  ['鍙栨秷鍓╀綑璇嗗埆', '取消剩余识别'],
  ['鏀惰捣', '收起'],
  ['灞曞紑', '展开'],
  ['娴嬭瘯鍏徃', '测试公司'],
  ['鐧诲綍宸插け鏁堬紝璇烽噸鏂扮櫥褰曘€?', '登录已失效，请重新登录。'],
  ['姝ｅ湪鍚庡彴楠岃瘉鐧诲綍鐘舵€侊紝涓嶅奖鍝嶆湰鍦版暟鎹煡鐪嬨€?', '正在后台验证登录状态，不影响本地数据查看。'],
  ['褰撳墠绂荤嚎锛屽凡杩涘叆绂荤嚎妯″紡銆?', '当前离线，已进入离线模式。'],
  ['鏈嶅姟鍣ㄥ惎鍔ㄤ腑锛岃绋嶅悗閲嶈瘯銆?', '服务器启动中，请稍后重试。'],
  ['闇€瑕佷汉宸ョ‘璁ゅ垎鎽婄粍', '需要人工确认分摊组']
]);

const cjkOrPrivateUsePattern = /[\u3400-\u9fff\ue000-\uf8ff]/;
const privateUsePattern = /[\ue000-\uf8ff]/g;
const replacementPattern = /\uFFFD|\?/g;
const commonMojibakePattern = /[鈧€鏃鏈鍚屾澶辫触鐧诲綍娴嬭瘯閸鐠婢濞閻瑜绱缁閺鎬淇濆瓨鍙栨秷绠＄悊閿鍞绂佸惎闇瑕汉宸ョ]/g;

function hexToBytes(hex) {
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return bytes;
}

function decodeUnicodeEscapes(value) {
  if (typeof value !== 'string' || !/\\u[0-9a-fA-F]{4}/.test(value)) return value;
  let output = value;
  for (let i = 0; i < 3 && /\\u[0-9a-fA-F]{4}/.test(output); i += 1) {
    output = output.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return output;
}

function decodeGb18030Mojibake(value) {
  const bytes = [];
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
      continue;
    }
    const mapped = gb18030ReverseMap[codePoint.toString(16)];
    if (!mapped) return value;
    bytes.push(...hexToBytes(mapped));
  }
  return utf8Decoder.decode(Uint8Array.from(bytes));
}

function decodeLatin1Mojibake(value) {
  try {
    const bytes = Uint8Array.from([...value].map((char) => char.charCodeAt(0) & 0xff));
    return utf8Decoder.decode(bytes);
  } catch {
    return value;
  }
}

function textScore(value) {
  const text = String(value || '');
  const replacementChars = (text.match(replacementPattern) || []).length * 8;
  const privateUse = (text.match(privateUsePattern) || []).length * 10;
  const commonMojibake = (text.match(commonMojibakePattern) || []).length * 3;
  const mojibakePunctuation = (text.match(/[〉〈]/g) || []).length * 4;
  const unicodeEscapes = (text.match(/\\u[0-9a-fA-F]{4}/g) || []).length * 10;
  const highCjk = [...text].filter((char) => {
    const codePoint = char.codePointAt(0);
    return codePoint >= 0x9000 && codePoint <= 0x9fff;
  }).length * 1.2;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const ascii = (text.match(/[A-Za-z0-9]/g) || []).length;
  return replacementChars + privateUse + commonMojibake + mojibakePunctuation + unicodeEscapes + highCjk - cjk * 0.2 - ascii * 0.02;
}

export function looksMojibake(value) {
  if (typeof value !== 'string' || !value) return false;
  if (/\\u[0-9a-fA-F]{4}/.test(value)) return true;
  if ([...knownMojibakeReplacements.keys()].some((bad) => value.includes(bad))) return true;
  if (privateUsePattern.test(value)) {
    privateUsePattern.lastIndex = 0;
    return true;
  }
  privateUsePattern.lastIndex = 0;
  const commonCount = (value.match(commonMojibakePattern) || []).length;
  const punctuationCount = (value.match(/[〉〈]/g) || []).length;
  const highCjkCount = [...value].filter((char) => {
    const codePoint = char.codePointAt(0);
    return codePoint >= 0x9000 && codePoint <= 0x9fff;
  }).length;
  return commonCount >= 2 || (punctuationCount > 0 && highCjkCount > 0);
}

export function repairTextEncoding(value) {
  if (typeof value !== 'string' || !value) return value;
  let replaced = decodeUnicodeEscapes(value);
  for (const [bad, good] of knownMojibakeReplacements.entries()) {
    replaced = replaced.split(bad).join(good);
  }

  if (!cjkOrPrivateUsePattern.test(replaced) || !looksMojibake(replaced)) return replaced;
  const candidates = [
    replaced,
    decodeGb18030Mojibake(replaced),
    decodeLatin1Mojibake(replaced)
  ];
  return candidates.sort((a, b) => textScore(a) - textScore(b))[0];
}

export function repairRecordEncoding(value, seen = new WeakSet()) {
  if (typeof value === 'string') return repairTextEncoding(value);
  if (!value || typeof value !== 'object') return value;
  if ((typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof File !== 'undefined' && value instanceof File)
    || value instanceof Date) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((entry) => {
      const next = repairRecordEncoding(entry, seen);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? output : value;
  }
  let changed = false;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = repairRecordEncoding(entry, seen);
    output[key] = next;
    if (next !== entry) changed = true;
  }
  return changed ? output : value;
}

export function hasEncodingDamage(value) {
  if (typeof value === 'string') return repairTextEncoding(value) !== value;
  if (!value || typeof value !== 'object') return false;
  if ((typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof File !== 'undefined' && value instanceof File)
    || value instanceof Date) return false;
  if (Array.isArray(value)) return value.some(hasEncodingDamage);
  return Object.values(value).some(hasEncodingDamage);
}

function makeIndexedDbSafe(value, seen = new WeakSet()) {
  if (typeof value === 'string') return repairTextEncoding(value);
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (!value || typeof value !== 'object') return value;
  if ((typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof File !== 'undefined' && value instanceof File)
    || value instanceof Date
    || value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => makeIndexedDbSafe(entry, seen));
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = makeIndexedDbSafe(entry, seen);
  return output;
}

function installIndexedDbPutGuard() {
  if (typeof IDBObjectStore === 'undefined' || IDBObjectStore.prototype.__invoiceSafePutInstalled) return;
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patchedPut(value, key) {
    try {
      return originalPut.call(this, makeIndexedDbSafe(value), key);
    } catch (error) {
      console.warn('[indexeddb] sanitized put failed, retrying minimal record', error);
      if (value && typeof value === 'object' && value.id) {
        return originalPut.call(this, makeIndexedDbSafe({ ...value, syncStatus: value.syncStatus || 'synced', syncNote: `sanitized after put error: ${error?.message || error}` }), key);
      }
      throw error;
    }
  };
  Object.defineProperty(IDBObjectStore.prototype, '__invoiceSafePutInstalled', { value: true });
}

function repairVisibleTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const current = node.nodeValue || '';
  if (!current || (!/\\u[0-9a-fA-F]{4}/.test(current) && !looksMojibake(current))) return;
  const next = repairTextEncoding(current);
  if (next !== current) node.nodeValue = next;
}

function repairVisibleText(root = document.body) {
  if (!root || typeof document === 'undefined') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(repairVisibleTextNode);
}

function installVisibleTextRepair() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__invoiceVisibleTextRepairInstalled) return;
  window.__invoiceVisibleTextRepairInstalled = true;
  const schedule = () => window.requestAnimationFrame(() => repairVisibleText());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
  else schedule();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes?.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) repairVisibleTextNode(node);
        else if (node.nodeType === Node.ELEMENT_NODE) repairVisibleText(node);
      });
      if (mutation.type === 'characterData') repairVisibleTextNode(mutation.target);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

installIndexedDbPutGuard();
installVisibleTextRepair();
