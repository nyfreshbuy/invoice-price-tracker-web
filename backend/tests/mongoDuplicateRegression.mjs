import assert from 'node:assert/strict';
import { __test__ } from '../src/services/mongoSyncStore.js';

function matchesCondition(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    if ('$in' in condition) return condition.$in.includes(value);
    if ('$nin' in condition) return !condition.$nin.includes(value);
    if ('$gte' in condition && Number(value || 0) < Number(condition.$gte)) return false;
    if ('$lte' in condition && Number(value || 0) > Number(condition.$lte)) return false;
    if ('$gte' in condition || '$lte' in condition) return true;
    return Object.entries(condition).every(([key, nested]) => matchesCondition(value?.[key], nested));
  }
  return value === condition;
}

function matchesQuery(record, query = {}) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') return condition.some((entry) => matchesQuery(record, entry));
    return matchesCondition(record[key], condition);
  });
}

function createCollection(records = []) {
  return {
    find(query = {}) {
      const result = records.filter((record) => matchesQuery(record, query));
      return {
        limit() {
          return this;
        },
        sort() {
          return this;
        },
        async toArray() {
          return result;
        }
      };
    },
    async findOne(query = {}) {
      return records.find((record) => matchesQuery(record, query)) || null;
    }
  };
}

function createMockDb({ invoices = [], invoiceItems = [] } = {}) {
  return {
    collection(name) {
      if (name === 'invoices') return createCollection(invoices);
      if (name === 'invoice_items') return createCollection(invoiceItems);
      return createCollection([]);
    }
  };
}

const companyId = 'mongo-company';

async function detect({ invoices, invoiceItems, incoming, changes = {} }) {
  return __test__.findMongoDuplicateInvoice(
    createMockDb({ invoices, invoiceItems }),
    { companyId, deletedAt: null, ...incoming },
    companyId,
    { changes }
  );
}

let result = await detect({
  invoices: [{
    id: 'abc-existing',
    serverId: 'abc-existing',
    companyId,
    supplierName: 'ABC Trading Inc.',
    invoiceNo: 'M-100',
    invoiceDate: '2026-06-18',
    totalAmount: 10,
    deletedAt: null
  }],
  invoiceItems: [{
    id: 'abc-item',
    companyId,
    invoiceId: 'abc-existing',
    productNameOriginal: 'Apple',
    productNameNormalized: 'apple',
    quantity: 1,
    totalPrice: 10,
    deletedAt: null
  }],
  incoming: {
    id: 'abc-incoming',
    supplierName: 'abc trading inc',
    invoiceNo: 'M-100',
    invoiceDate: '2026-06-18',
    totalAmount: 10
  },
  changes: {
    invoice_items: [{
      id: 'abc-incoming-item',
      invoiceId: 'abc-incoming',
      productNameOriginal: 'Apple',
      productNameNormalized: 'apple',
      quantity: 1,
      totalPrice: 10
    }]
  }
});
assert.equal(result?.status, 'duplicate');
assert.equal(result.invoice.id, 'abc-existing');

result = await detect({
  invoices: [{
    id: 'diff-existing',
    companyId,
    supplierName: 'ABC Trading Inc.',
    invoiceNo: 'M-200',
    invoiceDate: '2026-06-18',
    totalAmount: 10,
    deletedAt: null
  }],
  invoiceItems: [{
    id: 'diff-item',
    companyId,
    invoiceId: 'diff-existing',
    productNameOriginal: 'Apple',
    productNameNormalized: 'apple',
    quantity: 1,
    totalPrice: 10,
    deletedAt: null
  }],
  incoming: {
    id: 'diff-incoming',
    supplierName: 'abc trading inc',
    invoiceNo: 'M-200',
    invoiceDate: '2026-06-18',
    totalAmount: 10
  },
  changes: {
    invoice_items: [{
      id: 'diff-incoming-item',
      invoiceId: 'diff-incoming',
      productNameOriginal: 'Banana',
      productNameNormalized: 'banana',
      quantity: 1,
      totalPrice: 10
    }]
  }
});
assert.equal(result?.status, 'possible');
assert.equal(result.invoice.id, 'diff-existing');

result = await detect({
  invoices: [{
    id: 'batch-existing',
    companyId,
    supplierName: 'ABC Trading Inc.',
    invoiceNo: 'M-300',
    invoiceDate: '2026-06-18',
    totalAmount: 10,
    batchId: 'batch-1',
    deletedAt: null
  }],
  invoiceItems: [{
    id: 'batch-item',
    companyId,
    invoiceId: 'batch-existing',
    productNameOriginal: 'Apple',
    productNameNormalized: 'apple',
    quantity: 1,
    totalPrice: 10,
    deletedAt: null
  }],
  incoming: {
    id: 'batch-incoming',
    supplierName: 'ABC Trading Inc.',
    invoiceNo: 'M-300',
    invoiceDate: '2026-06-19',
    totalAmount: 10,
    batchId: 'batch-1'
  },
  changes: {
    invoice_items: [{
      id: 'batch-incoming-item',
      invoiceId: 'batch-incoming',
      productNameOriginal: 'Pear',
      productNameNormalized: 'pear',
      quantity: 1,
      totalPrice: 10
    }]
  }
});
assert.equal(result?.status, 'possible');
assert.equal(result.invoice.id, 'batch-existing');

result = await detect({
  invoices: [{
    id: 'group-existing',
    companyId,
    supplierName: 'ABC Trading Inc.',
    invoiceNo: 'M-400',
    invoiceDate: '2026-06-18',
    totalAmount: 10,
    invoiceGroupKey: 'group-1',
    deletedAt: null
  }],
  invoiceItems: [{
    id: 'group-item',
    companyId,
    invoiceId: 'group-existing',
    productNameOriginal: 'Apple',
    productNameNormalized: 'apple',
    quantity: 1,
    totalPrice: 10,
    deletedAt: null
  }],
  incoming: {
    id: 'group-incoming',
    supplierName: 'ABC Trading Inc.',
    invoiceNo: 'M-400',
    invoiceDate: '2026-06-18',
    totalAmount: 10,
    invoiceGroupKey: 'group-1'
  },
  changes: {
    invoice_items: [{
      id: 'group-incoming-item',
      invoiceId: 'group-incoming',
      productNameOriginal: 'Pear',
      productNameNormalized: 'pear',
      quantity: 1,
      totalPrice: 10
    }]
  }
});
assert.equal(result?.status, 'possible');
assert.equal(result.invoice.id, 'group-existing');

result = await detect({
  invoices: [{
    id: 'hash-existing',
    companyId,
    supplierName: 'Other Supplier',
    invoiceNo: '',
    invoiceDate: '2026-06-18',
    totalAmount: 10,
    sourceHash: 'same-image-hash',
    deletedAt: null
  }],
  invoiceItems: [],
  incoming: {
    id: 'hash-incoming',
    supplierName: 'Different Supplier',
    invoiceNo: '',
    invoiceDate: '2026-06-18',
    totalAmount: 10,
    imageHash: 'same-image-hash'
  },
  changes: { invoice_items: [] }
});
assert.equal(result?.status, 'duplicate');
assert.equal(result.invoice.id, 'hash-existing');

console.log(JSON.stringify({
  ok: true,
  mode: 'mock Mongo duplicate detection',
  supplierNormalizedName: true,
  itemSignatureDifferentBecomesPossible: true,
  batchIdCandidate: true,
  sameInvoiceGroupCandidate: true,
  imageHashSourceHashDuplicate: true,
  atlasIntegrationVerified: false
}, null, 2));
