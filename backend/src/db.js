import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.resolve(__dirname, '..', '.env'));

const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const usingPostgres = Boolean(process.env.DATABASE_URL);

let sqliteDb = null;
let pgPool = null;

if (!usingPostgres) {
  sqliteDb = new Database(path.join(dataDir, 'invoice-price-tracker.sqlite'));
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
}

export const db = sqliteDb;

export const syncTables = [
  'purchase_batches',
  'suppliers',
  'invoices',
  'invoice_items',
  'products',
  'price_history',
  'invoice_discounts',
  'gift_allocation_rules',
  'supplier_templates',
  'product_aliases',
  'product_learning_rules',
  'recognition_corrections',
  'price_anomalies'
];

export const tableColumns = {
  purchase_batches: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'batchName', 'supplierCount', 'invoiceCount', 'totalAmount', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  import_sessions: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'sessionName', 'sourceType', 'fileCount', 'groupCount', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_groups: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'importSessionId', 'supplierId', 'supplierName', 'invoiceNo', 'invoiceDate', 'confidence', 'reason', 'status', 'pageIds', 'pageCount', 'totalAmount', 'aiSupplierNameCandidate', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_pages: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'importSessionId', 'invoiceGroupId', 'invoiceId', 'pageIndex', 'pageNumber', 'pageCount', 'originalFileName', 'originalFilePath', 'archiveFilePath', 'archiveFolder', 'fileHash', 'fileSize', 'imageId', 'imagePath', 'mimeType', 'lightOcrText', 'lightOcrJson', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_image_resources: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'invoiceId', 'originalFileName', 'localImageKey', 'cloudImageUrl', 'storageType', 'imageStatus', 'fileSize', 'mimeType', 'errorReason', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  suppliers: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'name', 'displayName', 'supplierNameChinese', 'supplierNameEnglish', 'supplierDisplayName', 'normalizedName', 'aliases', 'contactName', 'phone', 'email', 'address', 'notes', 'templateIds', 'suspectedDuplicateOf', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoices: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'batchId', 'scanBatchId', 'importSessionId', 'invoiceGroupId', 'supplierId', 'invoiceNo', 'invoiceDate', 'pageNumber', 'pageCount', 'invoiceGroupKey', 'isMergedInvoice', 'isMultiPage', 'mergedInvoiceIds', 'invoiceLayoutType', 'imagePath', 'imageHash', 'originalFilePath', 'archiveFilePath', 'fileHash', 'archiveStatus', 'archiveFolder', 'invoiceMonth', 'ocrText', 'ocrTextHash', 'subtotal', 'tax', 'totalAmount', 'calculatedTotal', 'totalDifference', 'duplicateStatus', 'duplicateOfInvoiceId', 'recognitionSource', 'recognitionWarnings', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_items: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'invoiceId', 'supplierId', 'productId', 'rawName', 'nameCn', 'nameEn', 'spec', 'productNameOriginal', 'productNameNormalized', 'normalizedName', 'nameConfidence', 'nameQualityStatus', 'nameQualityReason', 'rawOcrLine', 'itemRecognitionSource', 'category', 'quantity', 'unit', 'unitPrice', 'totalPrice', 'chargedQty', 'freeQty', 'totalQty', 'actualQty', 'originalUnitCost', 'effectiveUnitCost', 'discountAmount', 'discountedEffectiveUnitCost', 'promoGroupId', 'promoGroupName', 'promoGroupRule', 'participatesInGiftAllocation', 'isFreeItem', 'isDiscountLine', 'candidateOnly', 'correctedByUser', 'isHandwrittenQuantity', 'isHandwrittenPrice', 'isHandwrittenAmount', 'isCircled', 'isChecked', 'freeReason', 'invoiceDate', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  products: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'name', 'normalizedName', 'category', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  price_history: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'productId', 'invoiceId', 'invoiceItemId', 'supplierId', 'productName', 'productNameOriginal', 'productNameNormalized', 'normalizedName', 'originalName', 'itemName', 'name', 'nameCn', 'nameEn', 'price', 'quantity', 'unit', 'invoiceDate', 'invoiceNo', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_discounts: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'invoiceId', 'supplierId', 'discountName', 'amount', 'discountType', 'appliedToProductIds', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  gift_allocation_rules: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'supplierId', 'ruleKey', 'productNames', 'promoGroupName', 'promoGroupRule', 'chargedQty', 'freeQty', 'actualQty', 'invoiceAmount', 'originalUnitCost', 'effectiveUnitCost', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  supplier_templates: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'supplierId', 'supplierNameKeywords', 'invoiceNoKeywords', 'dateKeywords', 'itemTableStartKeywords', 'itemTableEndKeywords', 'itemNameColumnIndex', 'quantityColumnIndex', 'unitColumnIndex', 'unitPriceColumnIndex', 'totalPriceColumnIndex', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  product_aliases: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'keyword', 'aliasName', 'normalizedAlias', 'standardName', 'category', 'productId', 'supplierId', 'rawName', 'nameCn', 'nameEn', 'barcode', 'spec', 'unit', 'minPrice', 'maxPrice', 'avgPrice', 'occurrenceCount', 'confidence', 'createdByUser', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  product_learning_rules: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'rawName', 'nameCn', 'nameEn', 'standardName', 'barcode', 'spec', 'unit', 'supplierId', 'productId', 'minPrice', 'maxPrice', 'avgPrice', 'occurrenceCount', 'confidence', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  recognition_corrections: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'fieldName', 'beforeValue', 'afterValue', 'supplierId', 'invoiceTemplateId', 'invoiceId', 'invoiceItemId', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  price_anomalies: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'version', 'supplierId', 'productId', 'invoiceId', 'invoiceItemId', 'unitPrice', 'averagePrice', 'deviationPercent', 'invoiceDate', 'invoiceNo', 'status', 'message', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_recognition_tasks: ['id', 'companyId', 'batchId', 'importSessionId', 'invoiceGroupId', 'invoicePageId', 'supplierHint', 'status', 'imagePath', 'filePath', 'originalName', 'mimeType', 'fileSize', 'source', 'recognitionSource', 'ocrLanguage', 'usedTemplate', 'usedAI', 'invoiceId', 'resultJson', 'error', 'retryCount', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'deviceId'],
  invoice_templates: ['id', 'companyId', 'supplierName', 'invoiceLayoutType', 'supplierKeywords', 'tableHeaderKeywords', 'columns', 'totalKeywords', 'invoiceNoKeywords', 'dateKeywords', 'tableRegion', 'handwrittenRegions', 'sampleImageHash', 'successCount', 'failCount', 'lastUsedAt', 'accuracyScore', 'isActive', 'createdAt', 'updatedAt'],
  companies: ['id', 'name', 'maxAdminUsers', 'maxSalesUsers', 'createdAt', 'updatedAt'],
  users: ['id', 'companyId', 'username', 'email', 'passwordHash', 'name', 'role', 'status', 'phone', 'note', 'lastLoginAt', 'createdAt', 'updatedAt'],
  company_invitations: ['id', 'company_id', 'email', 'role', 'token', 'status', 'created_by', 'created_at', 'accepted_at', 'expires_at']
};

const numericColumns = new Set([
  'supplierCount',
  'invoiceCount',
  'fileCount',
  'groupCount',
  'totalAmount',
  'calculatedTotal',
  'totalDifference',
  'subtotal',
  'tax',
  'quantity',
  'unitPrice',
  'totalPrice',
  'chargedQty',
  'freeQty',
  'totalQty',
  'actualQty',
  'originalUnitCost',
  'effectiveUnitCost',
  'discountAmount',
  'discountedEffectiveUnitCost',
  'isFreeItem',
  'isDiscountLine',
  'participatesInGiftAllocation',
  'correctedByUser',
  'amount',
  'pageNumber',
  'pageCount',
  'pageIndex',
  'isMergedInvoice',
  'isMultiPage',
  'price',
  'minPrice',
  'maxPrice',
  'avgPrice',
  'averagePrice',
  'deviationPercent',
  'unitPrice',
  'occurrenceCount',
  'confidence',
  'nameConfidence',
  'accuracyScore',
  'fileSize',
  'usedTemplate',
  'usedAI',
  'retryCount',
  'itemNameColumnIndex',
  'quantityColumnIndex',
  'unitColumnIndex',
  'unitPriceColumnIndex',
  'totalPriceColumnIndex',
  'successCount',
  'failCount',
  'occurrenceCount',
  'version',
  'isActive'
]);

const integerColumns = new Set([
  'supplierCount',
  'invoiceCount',
  'fileCount',
  'groupCount',
  'isFreeItem',
  'isDiscountLine',
  'candidateOnly',
  'participatesInGiftAllocation',
  'correctedByUser',
  'isHandwrittenQuantity',
  'isHandwrittenPrice',
  'isHandwrittenAmount',
  'isCircled',
  'isChecked',
  'createdByUser',
  'pageNumber',
  'pageCount',
  'pageIndex',
  'isMergedInvoice',
  'isMultiPage',
  'candidateOnly',
  'isHandwrittenQuantity',
  'isHandwrittenPrice',
  'isHandwrittenAmount',
  'isCircled',
  'isChecked',
  'itemNameColumnIndex',
  'quantityColumnIndex',
  'unitColumnIndex',
  'unitPriceColumnIndex',
  'totalPriceColumnIndex',
  'successCount',
  'failCount',
  'isActive'
]);

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeProductName(value = '') {
  return value.trim().toLowerCase().replace(/\u3000/g, ' ').split(/\s+/).filter(Boolean).join(' ');
}

export function id() {
  return randomUUID();
}

export function isValidSyncTable(table) {
  return syncTables.includes(table);
}

export function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function quoteTable(table) {
  if (!Object.prototype.hasOwnProperty.call(tableColumns, table)) {
    throw new Error(`Invalid table: ${table}`);
  }
  return quoteIdentifier(table);
}

async function getPgPool() {
  if (!usingPostgres) return null;
  if (!pgPool) {
    const { Pool } = await import('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('render.com') || process.env.PGSSLMODE === 'require'
        ? { rejectUnauthorized: false }
        : undefined
    });
  }
  return pgPool;
}

function columnType(column) {
  if (integerColumns.has(column)) return 'INTEGER';
  if (numericColumns.has(column)) return 'REAL';
  return 'TEXT';
}

function pgColumnType(column) {
  if (integerColumns.has(column)) return 'INTEGER';
  if (numericColumns.has(column)) return 'DOUBLE PRECISION';
  return 'TEXT';
}

function columnDefault(table, column, postgres = false) {
  if (table === 'price_history' && column === 'status') return " DEFAULT 'active'";
  return '';
}

function columnDefinition(table, column, postgres = false) {
  const type = postgres ? pgColumnType(column) : columnType(column);
  return `${quoteIdentifier(column)} ${type}${columnDefault(table, column, postgres)}${column === 'id' ? ' PRIMARY KEY' : ''}`;
}

function createTableSql(table, columns, postgres = false) {
  const defs = columns.map((column) => columnDefinition(table, column, postgres));
  return `CREATE TABLE IF NOT EXISTS ${quoteTable(table)} (${defs.join(', ')});`;
}

function hasSqliteColumn(table, column) {
  return sqliteDb.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().some((entry) => entry.name === column);
}

function sqliteColumnInfo(table, column) {
  if (!sqliteDb) return null;
  return sqliteDb.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().find((entry) => entry.name === column) || null;
}

async function ensureColumn(table, column) {
  if (usingPostgres) {
    await execute(`ALTER TABLE ${quoteTable(table)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column)} ${pgColumnType(column)}${columnDefault(table, column, true)};`);
    return;
  }
  if (!hasSqliteColumn(table, column)) {
    sqliteDb.exec(`ALTER TABLE ${quoteTable(table)} ADD COLUMN ${columnDefinition(table, column, false)};`);
  }
}

function hasPriceHistoryStatusDefault() {
  const info = sqliteColumnInfo('price_history', 'status');
  return String(info?.dflt_value || '').replaceAll('"', "'").toLowerCase() === "'active'";
}

function rebuildSqliteTable(table) {
  const columns = tableColumns[table];
  const tempTable = `_${table}_migration_${Date.now()}`;
  const existingColumns = sqliteDb.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((entry) => entry.name);
  const copyColumns = columns.filter((column) => existingColumns.includes(column));
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  try {
    sqliteDb.exec(`ALTER TABLE ${quoteTable(table)} RENAME TO ${quoteIdentifier(tempTable)}`);
    sqliteDb.exec(createTableSql(table, columns, false));
    if (copyColumns.length) {
      const columnList = copyColumns.map(quoteIdentifier).join(', ');
      sqliteDb.exec(`
        INSERT INTO ${quoteTable(table)} (${columnList})
        SELECT ${columnList}
        FROM ${quoteIdentifier(tempTable)}
      `);
    }
    sqliteDb.exec(`DROP TABLE ${quoteIdentifier(tempTable)}`);
  } finally {
    sqliteDb.exec('PRAGMA foreign_keys = ON');
  }
}

export async function migrate() {
  for (const [table, columns] of Object.entries(tableColumns)) {
    await execute(createTableSql(table, columns, usingPostgres));
  }

  for (const [table, columns] of Object.entries(tableColumns)) {
    for (const column of columns) {
      await ensureColumn(table, column);
    }
  }

  if (!usingPostgres && !hasPriceHistoryStatusDefault()) {
    rebuildSqliteTable('price_history');
  }

  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_suppliers_company')} ON ${quoteTable('suppliers')} (${quoteIdentifier('companyId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_import_sessions_company_created')} ON ${quoteTable('import_sessions')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('createdAt')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_groups_session')} ON ${quoteTable('invoice_groups')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('importSessionId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_pages_session')} ON ${quoteTable('invoice_pages')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('importSessionId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_pages_hash')} ON ${quoteTable('invoice_pages')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('fileHash')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_image_resources_invoice')} ON ${quoteTable('invoice_image_resources')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_company_date')} ON ${quoteTable('invoices')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceDate')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_batch')} ON ${quoteTable('invoices')} (${quoteIdentifier('batchId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_import_session')} ON ${quoteTable('invoices')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('importSessionId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_invoice_group')} ON ${quoteTable('invoices')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceGroupId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_archive')} ON ${quoteTable('invoices')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('archiveFolder')}, ${quoteIdentifier('invoiceMonth')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_group_key')} ON ${quoteTable('invoices')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceGroupKey')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_duplicate_status')} ON ${quoteTable('invoices')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('duplicateStatus')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_company_product_original')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('productNameOriginal')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_company_product_normalized')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('productNameNormalized')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_invoice')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('invoiceId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_product_id')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('productId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_promo_group')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('promoGroupId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_discounts_invoice')} ON ${quoteTable('invoice_discounts')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_price_history_invoice')} ON ${quoteTable('price_history')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_price_history_item')} ON ${quoteTable('price_history')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceItemId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_supplier_templates_supplier')} ON ${quoteTable('supplier_templates')} (${quoteIdentifier('supplierId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_product_aliases_company_keyword')} ON ${quoteTable('product_aliases')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('keyword')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_product_aliases_normalized_alias')} ON ${quoteTable('product_aliases')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('normalizedAlias')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_product_learning_company_raw')} ON ${quoteTable('product_learning_rules')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('rawName')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_recognition_corrections_company_field')} ON ${quoteTable('recognition_corrections')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('fieldName')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_price_anomalies_company_status')} ON ${quoteTable('price_anomalies')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('status')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_templates_company_supplier')} ON ${quoteTable('invoice_templates')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('supplierName')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_templates_active')} ON ${quoteTable('invoice_templates')} (${quoteIdentifier('isActive')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_recognition_tasks_company_status')} ON ${quoteTable('invoice_recognition_tasks')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('status')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_recognition_tasks_batch')} ON ${quoteTable('invoice_recognition_tasks')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('batchId')});`);
  await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier('idx_users_email_unique')} ON ${quoteTable('users')} (LOWER(${quoteIdentifier('email')}));`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_company_invitations_company')} ON ${quoteTable('company_invitations')} (${quoteIdentifier('company_id')});`);
  await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier('idx_company_invitations_token')} ON ${quoteTable('company_invitations')} (${quoteIdentifier('token')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_company_invitations_email_status')} ON ${quoteTable('company_invitations')} (${quoteIdentifier('email')}, ${quoteIdentifier('status')});`);

  await execute(`
    UPDATE ${quoteTable('price_history')}
    SET ${quoteIdentifier('status')} = 'active'
    WHERE ${quoteIdentifier('status')} IS NULL OR ${quoteIdentifier('status')} = ''
  `);
  await execute(`
    UPDATE ${quoteTable('price_history')}
    SET ${quoteIdentifier('invoiceId')} = (
      SELECT invoice_items.${quoteIdentifier('invoiceId')}
      FROM ${quoteTable('invoice_items')} invoice_items
      WHERE (invoice_items.${quoteIdentifier('companyId')} = ${quoteTable('price_history')}.${quoteIdentifier('companyId')}
             OR (invoice_items.${quoteIdentifier('companyId')} IS NULL AND ${quoteTable('price_history')}.${quoteIdentifier('companyId')} IS NULL))
        AND (${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('id')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('serverId')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('localId')})
      LIMIT 1
    )
    WHERE (${quoteIdentifier('invoiceId')} IS NULL OR ${quoteIdentifier('invoiceId')} = '')
      AND ${quoteIdentifier('invoiceItemId')} IS NOT NULL
      AND ${quoteIdentifier('invoiceItemId')} != ''
  `);
  await execute(`
    UPDATE ${quoteTable('price_history')}
    SET ${quoteIdentifier('productNameOriginal')} = (
      SELECT invoice_items.${quoteIdentifier('productNameOriginal')}
      FROM ${quoteTable('invoice_items')} invoice_items
      WHERE (invoice_items.${quoteIdentifier('companyId')} = ${quoteTable('price_history')}.${quoteIdentifier('companyId')}
             OR (invoice_items.${quoteIdentifier('companyId')} IS NULL AND ${quoteTable('price_history')}.${quoteIdentifier('companyId')} IS NULL))
        AND (${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('id')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('serverId')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('localId')})
      LIMIT 1
    )
    WHERE (${quoteIdentifier('productNameOriginal')} IS NULL OR ${quoteIdentifier('productNameOriginal')} = '')
      AND ${quoteIdentifier('invoiceItemId')} IS NOT NULL
      AND ${quoteIdentifier('invoiceItemId')} != ''
  `);
  await execute(`
    UPDATE ${quoteTable('price_history')}
    SET ${quoteIdentifier('productNameNormalized')} = (
      SELECT invoice_items.${quoteIdentifier('productNameNormalized')}
      FROM ${quoteTable('invoice_items')} invoice_items
      WHERE (invoice_items.${quoteIdentifier('companyId')} = ${quoteTable('price_history')}.${quoteIdentifier('companyId')}
             OR (invoice_items.${quoteIdentifier('companyId')} IS NULL AND ${quoteTable('price_history')}.${quoteIdentifier('companyId')} IS NULL))
        AND (${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('id')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('serverId')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('invoiceItemId')} = invoice_items.${quoteIdentifier('localId')})
      LIMIT 1
    )
    WHERE (${quoteIdentifier('productNameNormalized')} IS NULL OR ${quoteIdentifier('productNameNormalized')} = '')
      AND ${quoteIdentifier('invoiceItemId')} IS NOT NULL
      AND ${quoteIdentifier('invoiceItemId')} != ''
  `);
  await execute(`
    UPDATE ${quoteTable('price_history')}
    SET ${quoteIdentifier('productName')} = COALESCE(NULLIF(${quoteIdentifier('productNameOriginal')}, ''), NULLIF(${quoteIdentifier('productNameNormalized')}, ''), (
      SELECT products.${quoteIdentifier('name')}
      FROM ${quoteTable('products')} products
      WHERE (products.${quoteIdentifier('companyId')} = ${quoteTable('price_history')}.${quoteIdentifier('companyId')}
             OR (products.${quoteIdentifier('companyId')} IS NULL AND ${quoteTable('price_history')}.${quoteIdentifier('companyId')} IS NULL))
        AND (${quoteTable('price_history')}.${quoteIdentifier('productId')} = products.${quoteIdentifier('id')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('productId')} = products.${quoteIdentifier('serverId')}
             OR ${quoteTable('price_history')}.${quoteIdentifier('productId')} = products.${quoteIdentifier('localId')})
      LIMIT 1
    ))
    WHERE (${quoteIdentifier('productName')} IS NULL OR ${quoteIdentifier('productName')} = '')
  `);
  await execute(`
    UPDATE ${quoteTable('price_history')}
    SET ${quoteIdentifier('normalizedName')} = COALESCE(NULLIF(${quoteIdentifier('productNameNormalized')}, ''), NULLIF(${quoteIdentifier('productNameOriginal')}, ''), NULLIF(${quoteIdentifier('productName')}, '')),
        ${quoteIdentifier('originalName')} = COALESCE(NULLIF(${quoteIdentifier('productNameOriginal')}, ''), NULLIF(${quoteIdentifier('productName')}, '')),
        ${quoteIdentifier('itemName')} = COALESCE(NULLIF(${quoteIdentifier('productNameOriginal')}, ''), NULLIF(${quoteIdentifier('productName')}, '')),
        ${quoteIdentifier('name')} = COALESCE(NULLIF(${quoteIdentifier('productName')}, ''), NULLIF(${quoteIdentifier('productNameOriginal')}, ''), NULLIF(${quoteIdentifier('productNameNormalized')}, ''))
    WHERE (${quoteIdentifier('name')} IS NULL OR ${quoteIdentifier('name')} = '')
       OR (${quoteIdentifier('itemName')} IS NULL OR ${quoteIdentifier('itemName')} = '')
       OR (${quoteIdentifier('normalizedName')} IS NULL OR ${quoteIdentifier('normalizedName')} = '')
       OR (${quoteIdentifier('originalName')} IS NULL OR ${quoteIdentifier('originalName')} = '')
  `);
}

function convertPlaceholders(sql) {
  if (usingPostgres) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }
  return sql;
}

export async function queryAll(sql, params = [], client = null) {
  if (usingPostgres) {
    const pool = client || await getPgPool();
    const result = await pool.query(convertPlaceholders(sql), params);
    return result.rows;
  }
  return sqliteDb.prepare(sql).all(...params);
}

export async function queryGet(sql, params = [], client = null) {
  if (usingPostgres) {
    const rows = await queryAll(sql, params, client);
    return rows[0] || null;
  }
  return sqliteDb.prepare(sql).get(...params) || null;
}

export async function execute(sql, params = [], client = null) {
  if (usingPostgres) {
    const pool = client || await getPgPool();
    return pool.query(convertPlaceholders(sql), params);
  }
  if (params.length) return sqliteDb.prepare(sql).run(...params);
  return sqliteDb.exec(sql);
}

export async function run(sql, params = [], client = null) {
  if (usingPostgres) {
    const pool = client || await getPgPool();
    return pool.query(convertPlaceholders(sql), params);
  }
  return sqliteDb.prepare(sql).run(...params);
}

export async function withTransaction(callback) {
  if (usingPostgres) {
    const pool = await getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return callback(null);
}

export function pickColumns(table, record) {
  return Object.fromEntries(tableColumns[table].map((column) => [column, record[column] ?? null]));
}

export async function upsertRecord(table, record, client = null) {
  const columns = tableColumns[table];
  if (!columns) throw new Error(`Invalid table: ${table}`);
  const clean = pickColumns(table, record);
  const placeholders = columns.map(() => '?').join(', ');
  const columnList = columns.map(quoteIdentifier).join(', ');
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
    .join(', ');
  const sql = `
    INSERT INTO ${quoteTable(table)} (${columnList})
    VALUES (${placeholders})
    ON CONFLICT (${quoteIdentifier('id')}) DO UPDATE SET ${updates}
  `;
  await run(sql, columns.map((column) => clean[column]), client);
  return clean;
}

export async function getByAnyId(table, value, companyId = '', client = null) {
  if (!value) return null;
  const companyClause = tableColumns[table].includes('companyId') ? ` AND ${quoteIdentifier('companyId')} = ?` : '';
  const params = [value, value, value];
  if (companyClause) params.push(companyId);
  return queryGet(`
    SELECT * FROM ${quoteTable(table)}
    WHERE (${quoteIdentifier('id')} = ? OR ${quoteIdentifier('serverId')} = ? OR ${quoteIdentifier('localId')} = ?)
    ${companyClause}
    LIMIT 1
  `, params, client);
}

export function rowToCsv(values) {
  return values.map((value) => {
    const text = String(value ?? '');
    const escaped = text.replaceAll('"', '""');
    return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
  }).join(',');
}
