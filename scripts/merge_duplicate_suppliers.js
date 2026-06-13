import {
  migrate,
  nowIso,
  queryAll,
  quoteIdentifier,
  quoteTable,
  run,
  upsertRecord
} from '../backend/src/db.js';
import {
  displaySupplierName,
  isSupplierDuplicateCandidate,
  mergeAliases,
  normalizeSupplierName,
  supplierAliasesFromName
} from '../backend/src/services/supplierNormalizationService.js';

await migrate();

const companyId = process.argv[2];
if (!companyId) {
  console.error('Usage: node scripts/merge_duplicate_suppliers.js <companyId>');
  process.exit(1);
}
const suppliers = await queryAll(`
  SELECT * FROM ${quoteTable('suppliers')}
  WHERE ${quoteIdentifier('companyId')} = ?
    AND ${quoteIdentifier('deletedAt')} IS NULL
    AND COALESCE(${quoteIdentifier('status')}, 'active') != 'merged'
  ORDER BY ${quoteIdentifier('createdAt')} ASC
`, [companyId]);

const groups = new Map();
for (const supplier of suppliers) {
  const normalizedName = supplier.normalizedName || normalizeSupplierName(supplier.displayName || supplier.name || '');
  if (!normalizedName) continue;
  const group = groups.get(normalizedName) || [];
  group.push(supplier);
  groups.set(normalizedName, group);
}

const logs = [];

async function mergeSupplier(source, target, reason) {
  const timestamp = nowIso();
  const sourceIds = [source.id, source.serverId, source.localId].filter(Boolean);
  const targetId = target.serverId || target.id;
  const placeholders = sourceIds.map(() => '?').join(', ');
  const updatedTarget = {
    ...target,
    displayName: displaySupplierName(target, source.displayName || source.name || ''),
    normalizedName: target.normalizedName || normalizeSupplierName(target.displayName || target.name || ''),
    aliases: JSON.stringify(mergeAliases(target.aliases, source.aliases, supplierAliasesFromName(source.displayName || source.name || ''))),
    templateIds: JSON.stringify(mergeAliases(target.templateIds, source.templateIds)),
    updatedAt: timestamp
  };
  await upsertRecord('suppliers', updatedTarget);
  for (const table of ['invoices', 'invoice_items', 'invoice_discounts', 'price_history', 'product_aliases', 'product_learning_rules', 'recognition_corrections', 'price_anomalies', 'supplier_templates']) {
    await run(`
      UPDATE ${quoteTable(table)}
      SET ${quoteIdentifier('supplierId')} = ?, ${quoteIdentifier('updatedAt')} = ?
      WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('supplierId')} IN (${placeholders})
    `, [targetId, timestamp, companyId, ...sourceIds]);
  }
  await run(`
    UPDATE ${quoteTable('suppliers')}
    SET ${quoteIdentifier('status')} = 'merged',
        ${quoteIdentifier('suspectedDuplicateOf')} = ?,
        ${quoteIdentifier('deletedAt')} = ?,
        ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('id')} = ?
  `, [targetId, timestamp, timestamp, companyId, source.id]);
  logs.push(`MERGED ${source.id} -> ${targetId}: ${source.displayName || source.name} (${reason})`);
}

for (const [, group] of groups) {
  if (group.length < 2) continue;
  const [target, ...duplicates] = group.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const duplicate of duplicates) {
    await mergeSupplier(duplicate, target, 'same normalizedName');
  }
}

const refreshed = await queryAll(`
  SELECT * FROM ${quoteTable('suppliers')}
  WHERE ${quoteIdentifier('companyId')} = ?
    AND ${quoteIdentifier('deletedAt')} IS NULL
    AND COALESCE(${quoteIdentifier('status')}, 'active') != 'merged'
`, [companyId]);

for (const supplier of refreshed) {
  const duplicate = refreshed.find((candidate) => candidate.id !== supplier.id && isSupplierDuplicateCandidate(supplier, candidate));
  if (!duplicate) continue;
  await run(`
    UPDATE ${quoteTable('suppliers')}
    SET ${quoteIdentifier('suspectedDuplicateOf')} = ?, ${quoteIdentifier('updatedAt')} = ?
    WHERE ${quoteIdentifier('companyId')} = ? AND ${quoteIdentifier('id')} = ?
  `, [duplicate.serverId || duplicate.id, nowIso(), companyId, supplier.id]);
  logs.push(`SUSPECT ${supplier.id} -> ${duplicate.serverId || duplicate.id}: ${supplier.displayName || supplier.name}`);
}

console.log(logs.length ? logs.join('\n') : 'No duplicate suppliers found.');
