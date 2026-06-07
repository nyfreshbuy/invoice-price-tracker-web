const OCR_CORRECTIONS = [
  [/干页豆腐/g, '千页豆腐'],
  [/仟页豆腐/g, '千页豆腐'],
  [/龍眼/g, '龙眼'],
  [/鳳梨/g, '凤梨'],
  [/蘋果/g, '苹果'],
  [/\bITO\s+EN\b/gi, 'ITOEN'],
  [/\bI\s*T\s*O\s*E\s*N\b/gi, 'ITOEN']
];

const TRADITIONAL_TO_SIMPLIFIED = new Map(Object.entries({
  萬: '万',
  與: '与',
  東: '东',
  絲: '丝',
  丟: '丢',
  兩: '两',
  嚴: '严',
  喪: '丧',
  個: '个',
  臨: '临',
  為: '为',
  麼: '么',
  義: '义',
  烏: '乌',
  樂: '乐',
  喬: '乔',
  習: '习',
  鄉: '乡',
  書: '书',
  買: '买',
  亂: '乱',
  爭: '争',
  於: '于',
  雲: '云',
  亞: '亚',
  產: '产',
  畝: '亩',
  親: '亲',
  褻: '亵',
  億: '亿',
  僅: '仅',
  從: '从',
  倉: '仓',
  儀: '仪',
  價: '价',
  眾: '众',
  優: '优',
  會: '会',
  傘: '伞',
  傳: '传',
  傷: '伤',
  倫: '伦',
  偉: '伟',
  側: '侧',
  偵: '侦',
  俠: '侠',
  僥: '侥',
  僑: '侨',
  儈: '侩',
  儂: '侬',
  侶: '侣',
  俁: '俣',
  係: '系',
  俔: '伣',
  俠: '侠',
  倀: '伥',
  倆: '俩',
  倉: '仓',
  個: '个',
  們: '们',
  倖: '幸',
  倣: '仿',
  倫: '伦',
  偉: '伟',
  側: '侧',
  偵: '侦',
  偽: '伪',
  傑: '杰',
  傖: '伧',
  傘: '伞',
  備: '备',
  傭: '佣',
  傯: '偬',
  傳: '传',
  傴: '伛',
  債: '债',
  傷: '伤',
  傾: '倾',
  僂: '偻',
  僅: '仅',
  僉: '佥',
  僑: '侨',
  僕: '仆',
  僞: '伪',
  僥: '侥',
  僨: '偾',
  僱: '雇',
  價: '价',
  儀: '仪',
  儂: '侬',
  億: '亿',
  儈: '侩',
  儉: '俭',
  儐: '傧',
  儔: '俦',
  儕: '侪',
  儘: '尽',
  償: '偿',
  優: '优',
  儲: '储',
  儷: '俪',
  儺: '傩',
  兒: '儿',
  兌: '兑',
  內: '内',
  兩: '两',
  冊: '册',
  冪: '幂',
  凍: '冻',
  淨: '净',
  凱: '凯',
  別: '别',
  刪: '删',
  則: '则',
  剋: '克',
  剎: '刹',
  剗: '刬',
  剛: '刚',
  剝: '剥',
  剮: '剐',
  創: '创',
  劃: '划',
  劇: '剧',
  劉: '刘',
  劊: '刽',
  劌: '刿',
  劍: '剑',
  劑: '剂',
  勁: '劲',
  動: '动',
  務: '务',
  勛: '勋',
  勝: '胜',
  勞: '劳',
  勢: '势',
  勩: '勚',
  勱: '劢',
  勵: '励',
  勸: '劝',
  勻: '匀',
  匭: '匦',
  匯: '汇',
  匱: '匮',
  區: '区',
  協: '协',
  單: '单',
  賣: '卖',
  盧: '卢',
  鹵: '卤',
  衛: '卫',
  卻: '却',
  廠: '厂',
  廳: '厅',
  歷: '历',
  厲: '厉',
  壓: '压',
  厭: '厌',
  厙: '厍',
  厠: '厕',
  參: '参',
  雙: '双',
  發: '发',
  變: '变',
  疊: '叠',
  葉: '叶',
  號: '号',
  後: '后',
  噸: '吨',
  聽: '听',
  啟: '启',
  吳: '吴',
  吶: '呐',
  呂: '吕',
  嗎: '吗',
  嚇: '吓',
  呆: '呆',
  呎: '尺',
  咼: '呙',
  員: '员',
  唄: '呗',
  唚: '吣',
  問: '问',
  啞: '哑',
  啟: '启',
  啢: '唡',
  喚: '唤',
  喪: '丧',
  喫: '吃',
  喬: '乔',
  單: '单',
  喲: '哟',
  嗆: '呛',
  嗇: '啬',
  嗊: '唝',
  嗎: '吗',
  嗚: '呜',
  嗩: '唢',
  嗶: '哔',
  嘆: '叹',
  嘍: '喽',
  嘔: '呕',
  嘖: '啧',
  嘗: '尝',
  嘜: '唛',
  嘩: '哗',
  嘮: '唠',
  嘯: '啸',
  嘰: '叽',
  嘵: '哓',
  嘸: '呒',
  嘽: '啴',
  嘿: '嘿',
  噁: '恶',
  噓: '嘘',
  噝: '咝',
  噠: '哒',
  噥: '哝',
  噦: '哕',
  噯: '嗳',
  噲: '哙',
  噴: '喷',
  噸: '吨',
  噹: '当',
  嚀: '咛',
  嚇: '吓',
  嚌: '哜',
  嚐: '尝',
  嚕: '噜',
  嚙: '啮',
  嚥: '咽',
  嚦: '呖',
  嚨: '咙',
  嚮: '向',
  嚳: '喾',
  嚴: '严',
  囂: '嚣',
  囅: '冁',
  囉: '啰',
  囌: '苏',
  囑: '嘱',
  圍: '围',
  園: '园',
  圓: '圆',
  圖: '图',
  團: '团',
  國: '国',
  壇: '坛',
  壓: '压',
  壘: '垒',
  壙: '圹',
  壚: '垆',
  壞: '坏',
  壟: '垄',
  壠: '垅',
  壢: '坜',
  壩: '坝',
  壯: '壮',
  壺: '壶',
  壼: '壸',
  壽: '寿',
  夠: '够',
  夢: '梦',
  夾: '夹',
  奐: '奂',
  奧: '奥',
  奩: '奁',
  奪: '夺',
  奮: '奋',
  奼: '姹',
  妝: '妆',
  姍: '姗',
  姦: '奸',
  娛: '娱',
  婁: '娄',
  婦: '妇',
  媽: '妈',
  媧: '娲',
  嫋: '袅',
  嫗: '妪',
  嫵: '妩',
  嬈: '娆',
  嬋: '婵',
  嬌: '娇',
  嬙: '嫱',
  嬡: '嫒',
  嬤: '嬷',
  孫: '孙',
  學: '学',
  孿: '孪',
  寧: '宁',
  寶: '宝',
  實: '实',
  寵: '宠',
  審: '审',
  寫: '写',
  將: '将',
  專: '专',
  尋: '寻',
  對: '对',
  導: '导',
  尷: '尴',
  屆: '届',
  屍: '尸',
  屓: '屃',
  屜: '屉',
  屢: '屡',
  層: '层',
  屬: '属',
  岡: '冈',
  峴: '岘',
  島: '岛',
  峽: '峡',
  崍: '崃',
  崑: '昆',
  崗: '岗',
  崙: '仑',
  崢: '峥',
  嵐: '岚',
  嶁: '嵝',
  嶄: '崭',
  嶇: '岖',
  嶗: '崂',
  嶠: '峤',
  嶧: '峄',
  嶮: '崄',
  嶴: '岙',
  嶸: '嵘',
  嶺: '岭',
  嶼: '屿',
  巋: '岿',
  巒: '峦',
  巔: '巅'
}));

export function toSimplified(value = '') {
  return String(value || '').split('').map((char) => TRADITIONAL_TO_SIMPLIFIED.get(char) || char).join('');
}

export function normalizeUnitText(value = '') {
  return String(value || '')
    .replace(/(\d+)\.0+\s*(FZ|OZ|ML|G|KG|LB|L)\b/gi, '$1$2')
    .replace(/(\d+\.\d*?[1-9])0+\s*(FZ|OZ|ML|G|KG|LB|L)\b/gi, '$1$2')
    .replace(/(\d+(?:\.\d+)?)\s*(FL\s*OZ|FLOZ|FZ|OZ|ML|G|KG|LB|L)\b/gi, (_, number, unit) => `${Number(number)}${unit.toUpperCase().replace(/\s+/g, '').replace('FLOZ', 'FZ').replace('FLOZ', 'FZ')}`)
    .replace(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(FZ|OZ|ML|G|KG|LB|L|CT|PC|PCS|PK)\b/gi, (_, count, size, unit) => `${count}X${Number(size)}${unit.toUpperCase()}`)
    .replace(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(FZ|OZ|ML|G|KG|LB|L)\b/gi, (_, count, size, unit) => `${count}/${Number(size)}${unit.toUpperCase()}`);
}

export function normalizeProductNameAdvanced(value = '') {
  let text = toSimplified(String(value || '').trim());
  for (const [pattern, replacement] of OCR_CORRECTIONS) {
    text = text.replace(pattern, replacement);
  }
  text = normalizeUnitText(text);
  return text
    .toLowerCase()
    .replace(/[，,。；;：:｜|()[\]{}【】"'“”‘’]/g, ' ')
    .replace(/\s*([xX])\s*/g, 'X')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function displayStandardName(item = {}) {
  const joined = [item.nameCn, item.nameEn].filter(Boolean).join(' ').trim();
  return String(item.standardName || item.normalizedName || item.productNameNormalized || item.name || joined || item.productNameOriginal || item.rawName || '').trim();
}

export function displayRawName(item = {}) {
  const joined = [item.nameCn, item.nameEn].filter(Boolean).join(' ').trim();
  return String(item.rawName || item.productNameOriginal || item.name || joined || item.standardName || '').trim();
}

export function detectDiscountLine(item = {}) {
  const name = String(item.name || item.productNameOriginal || item.rawName || item.standardName || '').toLowerCase();
  const amount = Number(item.totalPrice ?? item.amount ?? 0);
  const unitPrice = Number(item.unitPrice ?? item.priceEach ?? item.price ?? 0);
  const code = String(item.code || item.barcode || '').trim();
  return name.includes('discount') || name.includes('折扣') || amount < 0 || unitPrice < 0 || (!code && amount < 0);
}

export function discountTypeFor(item = {}, productItems = []) {
  const name = normalizeProductNameAdvanced(item.name || item.productNameOriginal || item.rawName || '');
  if (!name) return { discountType: 'unknown', appliedToProductIds: '' };
  const brandToken = name.split(/\s+/).find((token) => token && token !== 'discount' && token !== '折扣') || '';
  if (!brandToken) return { discountType: 'invoice_level', appliedToProductIds: '' };
  const matches = productItems.filter((product) => normalizeProductNameAdvanced(displayStandardName(product) || displayRawName(product)).includes(brandToken));
  if (matches.length === 1) return { discountType: 'item_level', appliedToProductIds: matches.map((entry) => entry.id || entry.serverId || entry.localId || '').filter(Boolean).join(',') };
  if (matches.length > 1) return { discountType: 'brand_level', appliedToProductIds: matches.map((entry) => entry.id || entry.serverId || entry.localId || '').filter(Boolean).join(',') };
  return { discountType: 'invoice_level', appliedToProductIds: '' };
}

function firstBrandToken(text = '') {
  const normalized = normalizeProductNameAdvanced(text).toUpperCase();
  const tokens = normalized.split(/[^A-Z0-9\u4e00-\u9fff]+/).filter(Boolean);
  return tokens.find((token) => !/^\d/.test(token) && !['PET', 'CAN', 'BTL', 'BOTTLE', 'CASE', 'CS', 'PK', 'PACK'].includes(token)) || '';
}

function packagingTokens(text = '') {
  const normalized = normalizeUnitText(toSimplified(text)).toUpperCase();
  const tokens = [];
  const packageMatch = normalized.match(/\b(PET|CAN|BTL|BOTTLE|JAR|BAG|BOX|TIN)\b/);
  if (packageMatch) tokens.push(packageMatch[1]);
  const countSizeMatch = normalized.match(/\b\d+\/\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L)\b/) || normalized.match(/\b\d+X\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L|CT|PC|PCS|PK)\b/);
  if (countSizeMatch) tokens.push(countSizeMatch[0]);
  const looseSizeMatch = normalized.match(/\b\d+(?:\.\d+)?(?:FZ|OZ|ML|G|KG|LB|L)\b/);
  if (!countSizeMatch && looseSizeMatch) tokens.push(looseSizeMatch[0]);
  return tokens;
}

export function promoGroupCandidate(item = {}) {
  const source = [displayStandardName(item), displayRawName(item), item.spec, item.unit].filter(Boolean).join(' ');
  const brand = firstBrandToken(source);
  const specs = packagingTokens(source);
  const normalizedProductName = normalizeProductNameAdvanced(displayStandardName(item) || displayRawName(item));
  if (!brand || !normalizedProductName || specs.length === 0) {
    return {
      key: '',
      name: '需要人工确认分摊组',
      rule: 'uncertain: missing brand, product name, or package/spec'
    };
  }
  return {
    key: `${brand}|${normalizedProductName}|${specs.join('|')}`,
    name: `${brand} ${specs.join(' ')}`,
    rule: 'same brand + same normalized product + same spec/package'
  };
}
