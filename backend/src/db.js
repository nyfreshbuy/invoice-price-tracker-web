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
  'supplier_templates'
];

export const tableColumns = {
  purchase_batches: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'batchName', 'supplierCount', 'invoiceCount', 'totalAmount', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  suppliers: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'name', 'phone', 'email', 'address', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoices: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'batchId', 'supplierId', 'invoiceNo', 'invoiceDate', 'imagePath', 'ocrText', 'totalAmount', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_items: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'invoiceId', 'supplierId', 'productNameOriginal', 'productNameNormalized', 'category', 'quantity', 'unit', 'unitPrice', 'totalPrice', 'invoiceDate', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  products: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'name', 'normalizedName', 'category', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  price_history: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'productId', 'invoiceItemId', 'supplierId', 'price', 'quantity', 'unit', 'invoiceDate', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  supplier_templates: ['id', 'companyId', 'localId', 'serverId', 'syncStatus', 'supplierId', 'supplierNameKeywords', 'invoiceNoKeywords', 'dateKeywords', 'itemTableStartKeywords', 'itemTableEndKeywords', 'itemNameColumnIndex', 'quantityColumnIndex', 'unitColumnIndex', 'unitPriceColumnIndex', 'totalPriceColumnIndex', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
  invoice_templates: ['id', 'companyId', 'supplierName', 'supplierKeywords', 'tableHeaderKeywords', 'columns', 'totalKeywords', 'invoiceNoKeywords', 'dateKeywords', 'sampleImageHash', 'successCount', 'failCount', 'lastUsedAt', 'isActive', 'createdAt', 'updatedAt'],
  companies: ['id', 'name', 'createdAt', 'updatedAt'],
  users: ['id', 'companyId', 'email', 'passwordHash', 'name', 'createdAt', 'updatedAt']
};

const numericColumns = new Set([
  'supplierCount',
  'invoiceCount',
  'totalAmount',
  'quantity',
  'unitPrice',
  'totalPrice',
  'price',
  'itemNameColumnIndex',
  'quantityColumnIndex',
  'unitColumnIndex',
  'unitPriceColumnIndex',
  'totalPriceColumnIndex',
  'successCount',
  'failCount',
  'isActive'
]);

const integerColumns = new Set([
  'supplierCount',
  'invoiceCount',
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

function createTableSql(table, columns, postgres = false) {
  const defs = columns.map((column) => {
    const type = postgres ? pgColumnType(column) : columnType(column);
    return `${quoteIdentifier(column)} ${type}${column === 'id' ? ' PRIMARY KEY' : ''}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${quoteTable(table)} (${defs.join(', ')});`;
}

function hasSqliteColumn(table, column) {
  return sqliteDb.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().some((entry) => entry.name === column);
}

async function ensureColumn(table, column) {
  if (usingPostgres) {
    await execute(`ALTER TABLE ${quoteTable(table)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column)} ${pgColumnType(column)};`);
    return;
  }
  if (!hasSqliteColumn(table, column)) {
    sqliteDb.exec(`ALTER TABLE ${quoteTable(table)} ADD COLUMN ${quoteIdentifier(column)} ${columnType(column)};`);
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

  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_suppliers_company')} ON ${quoteTable('suppliers')} (${quoteIdentifier('companyId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_company_date')} ON ${quoteTable('invoices')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('invoiceDate')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoices_batch')} ON ${quoteTable('invoices')} (${quoteIdentifier('batchId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_company_product_original')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('productNameOriginal')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_company_product_normalized')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('productNameNormalized')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_items_invoice')} ON ${quoteTable('invoice_items')} (${quoteIdentifier('invoiceId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_supplier_templates_supplier')} ON ${quoteTable('supplier_templates')} (${quoteIdentifier('supplierId')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_templates_company_supplier')} ON ${quoteTable('invoice_templates')} (${quoteIdentifier('companyId')}, ${quoteIdentifier('supplierName')});`);
  await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_invoice_templates_active')} ON ${quoteTable('invoice_templates')} (${quoteIdentifier('isActive')});`);
  await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier('idx_users_email_unique')} ON ${quoteTable('users')} (LOWER(${quoteIdentifier('email')}));`);
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
