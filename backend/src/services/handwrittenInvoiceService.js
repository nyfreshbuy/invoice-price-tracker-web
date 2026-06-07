const LAYOUT_TYPES = new Set(['normal_invoice', 'printed_catalog_handwritten', 'multi_page', 'mixed']);

export function normalizeLayoutType(value = '') {
  return LAYOUT_TYPES.has(value) ? value : 'normal_invoice';
}

export function detectInvoiceLayoutType(result = {}, ocrText = '') {
  const explicit = normalizeLayoutType(result.invoiceLayoutType || result.layoutType || '');
  if (explicit !== 'normal_invoice') return explicit;
  const text = String(ocrText || '').toLowerCase();
  const supplier = String(result.supplierName || '').toLowerCase();
  if (supplier.includes('grand yc')) return 'printed_catalog_handwritten';
  if (extractPageInfo({}, ocrText).pageCount > 1) return 'multi_page';
  if (/catalog|pre[\s-]?printed|handwritten|circle|checked|勾选|圈选|手写/i.test(text)) return 'printed_catalog_handwritten';
  return 'normal_invoice';
}

export function extractPageInfo(result = {}, ocrText = '') {
  const lines = String(ocrText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pageLine = lines.find((line) => /^(invoice\s+)?page\s*(no\.?|number|#|:)?\s*\d+\s*(of|\/)\s*\d+$/i.test(line)
    || /^page\s*(no\.?|number|#|:)\s*\d+$/i.test(line));
  const match = pageLine?.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
  return {
    pageNumber: Number(match?.[1] || 0),
    pageCount: Number(match?.[2] || 0)
  };
}

export function buildInvoiceGroupKey({ supplierName = '', invoiceNo = '', totalAmount = 0 } = {}) {
  return [supplierName, invoiceNo, Number(totalAmount || 0).toFixed(2)]
    .map((part) => String(part || '').trim().toLowerCase().replace(/[^a-z0-9\u3400-\u9fff.]+/g, ''))
    .filter(Boolean)
    .join('|');
}

export function shouldKeepPrintedCatalogItem(item = {}) {
  if (item.candidateOnly) return false;
  if (item.isCircled || item.isChecked) return true;
  if (item.isHandwrittenQuantity || item.isHandwrittenPrice || item.isHandwrittenAmount) return true;
  if (Number(item.totalPrice ?? item.amount ?? 0) > 0 && Number(item.qty ?? item.quantity ?? 0) > 0) return true;
  return false;
}

export function applyHandwrittenCatalogRules(result = {}, ocrText = '') {
  const layoutType = detectInvoiceLayoutType(result, ocrText);
  const page = extractPageInfo(result, ocrText);
  const items = Array.isArray(result.items) ? result.items : [];
  const filteredItems = layoutType === 'printed_catalog_handwritten'
    ? items.map((item) => ({ ...item, candidateOnly: !shouldKeepPrintedCatalogItem(item) })).filter((item) => !item.candidateOnly)
    : items.map((item) => ({ ...item, candidateOnly: Boolean(item.candidateOnly) }));

  return {
    ...result,
    ...page,
    invoiceLayoutType: layoutType,
    invoiceGroupKey: result.invoiceGroupKey || buildInvoiceGroupKey({
      supplierName: result.supplierName,
      invoiceNo: result.invoiceNo,
      totalAmount: result.totalAmount
    }),
    items: filteredItems,
    warnings: [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      ...(layoutType === 'printed_catalog_handwritten' && items.length !== filteredItems.length
        ? [`Printed catalog handwritten layout: filtered ${items.length - filteredItems.length} candidate-only rows.`]
        : [])
    ]
  };
}
