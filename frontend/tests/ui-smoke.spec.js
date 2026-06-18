import { expect, test } from '@playwright/test';

const company = { id: 'ui-company', name: 'UI Smoke Company' };
const user = { id: 'ui-user', username: 'ui-admin', email: 'ui@example.com', role: 'admin', companyId: company.id };
const authSession = { token: 'ui-smoke-token', user, company };
const corsHeaders = { 'access-control-allow-origin': '*' };

const stores = [
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
  'price_anomalies',
  'invoice_images',
  'meta'
];

const tinyPng = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 248, 15, 0, 1,
  1, 1, 0, 24, 221, 141, 176, 0, 0, 0, 0, 73, 69, 78, 68, 174,
  66, 96, 130
]);

async function fulfillJson(route, data, status = 200) {
  await route.fulfill({
    status,
    headers: corsHeaders,
    contentType: 'application/json',
    body: JSON.stringify(data)
  });
}

function mockRecognitionTasks() {
  return [
    {
      id: 'task-failed',
      status: 'failed',
      originalName: 'failed-invoice.png',
      createdAt: '2026-06-18T10:00:00.000Z',
      error: 'Mock OCR failed',
      imagePath: '/uploads/missing-task.png'
    },
    {
      id: 'task-review',
      status: 'completed',
      invoiceId: 'inv-pending',
      originalName: 'pending-invoice.png',
      createdAt: '2026-06-18T10:05:00.000Z',
      result: {
        recognitionSource: 'ai',
        parsed: {
          supplierName: 'Smoke Supplier',
          invoiceNo: 'SM-100',
          totalAmount: 35,
          totalDifference: 0
        },
        duplicateCheck: {
          sameInvoiceGroup: true,
          sameInvoiceGroupReason: 'Mock possible multi-page invoice'
        }
      }
    }
  ];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((session) => {
    localStorage.setItem('authToken', session.token);
    localStorage.setItem('invoicePriceTrackerAuth', JSON.stringify(session));
  }, authSession);

  await page.route('**/api/auth/me**', (route) => fulfillJson(route, { user, company }));
  await page.route('**/api/sync/status**', (route) => fulfillJson(route, { backend: 'mock', counts: { invoices: 4, suppliers: 1, price_history: 1 } }));
  await page.route('**/api/sync/pull**', (route) => fulfillJson(route, { backend: 'mock', serverTime: new Date().toISOString(), data: {} }));
  await page.route('**/api/sync/push**', (route) => fulfillJson(route, { backend: 'mock', results: [] }));
  await page.route(/.*\/api\/invoice-recognition\/tasks\/[^/]+\/retry$/, (route) => fulfillJson(route, { success: true }));
  await page.route(/.*\/api\/invoice-recognition\/tasks\/[^/]+\/decision$/, (route) => fulfillJson(route, { success: true }));
  await page.route(/.*\/api\/invoice-recognition\/batches\/[^/]+\/pause$/, (route) => fulfillJson(route, { success: true }));
  await page.route(/.*\/api\/invoice-recognition\/batches\/[^/]+\/resume$/, (route) => fulfillJson(route, { success: true }));
  await page.route(/.*\/api\/invoice-recognition\/batches\/[^/]+\/cancel$/, (route) => fulfillJson(route, { success: true }));
  await page.route(/.*\/api\/invoice-recognition\/tasks(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      const id = `task-${Date.now()}`;
      await fulfillJson(route, {
        taskId: id,
        task: {
          id,
          status: 'pending',
          originalName: 'upload.png',
          createdAt: new Date().toISOString()
        }
      });
      return;
    }
    await fulfillJson(route, mockRecognitionTasks());
  });
  await page.route('**/api/invoices/*/merge', (route) => fulfillJson(route, { success: true, invoiceId: 'inv-pending', message: 'Mock merge succeeded' }));
  await page.route('**/api/admin/members**', (route) => fulfillJson(route, []));
  await page.route('**/uploads/**', (route) => route.fulfill({ status: 404, body: 'missing' }));
});

async function seedLocalData(page) {
  await page.evaluate(async ({ stores: storeNames, company: seedCompany, pngBytes }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('InvoicePriceTrackerLocal', 9);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const storeName of storeNames) {
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    for (const storeName of storeNames) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }

    const now = new Date().toISOString();
    const records = {
      suppliers: [
        { id: 'supplier-smoke', companyId: seedCompany.id, name: 'Smoke Supplier', supplierDisplayName: 'Smoke Supplier', createdAt: now, updatedAt: now, syncStatus: 'synced' }
      ],
      invoices: [
        {
          id: 'inv-pending',
          companyId: seedCompany.id,
          supplierId: 'supplier-smoke',
          supplierName: 'Smoke Supplier',
          invoiceNo: 'SM-100',
          invoiceDate: '2026-06-18',
          totalAmount: 35,
          calculatedTotal: 35,
          totalDifference: 0,
          status: 'PENDING_REVIEW',
          duplicateStatus: 'possible',
          recognitionWarnings: 'POSSIBLE_MULTI_PAGE_OR_DUPLICATE',
          ocrText: 'Smoke OCR text',
          imagePath: 'indexeddb:img-pending',
          imageId: 'img-pending',
          recognitionSource: 'ai',
          createdAt: now,
          updatedAt: now,
          syncStatus: 'pending'
        },
        {
          id: 'inv-duplicate',
          companyId: seedCompany.id,
          supplierId: 'supplier-smoke',
          supplierName: 'Smoke Supplier',
          invoiceNo: 'SM-101',
          invoiceDate: '2026-06-18',
          totalAmount: 48,
          status: 'DUPLICATE',
          duplicateStatus: 'duplicate',
          duplicateOfInvoiceId: 'inv-pending',
          recognitionWarnings: 'DUPLICATE_INVOICE',
          createdAt: now,
          updatedAt: now,
          syncStatus: 'synced'
        },
        {
          id: 'inv-conflict',
          companyId: seedCompany.id,
          supplierId: 'supplier-smoke',
          supplierName: 'Smoke Supplier',
          invoiceNo: 'SM-102',
          invoiceDate: '2026-06-18',
          totalAmount: 20,
          status: 'PENDING_REVIEW',
          syncStatus: 'conflict',
          conflictRecord: JSON.stringify({ status: 'conflict', reason: 'Mock cloud conflict' }),
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'inv-abnormal',
          companyId: seedCompany.id,
          supplierId: 'supplier-smoke',
          supplierName: 'Smoke Supplier',
          invoiceNo: 'SM-103',
          invoiceDate: '2026-06-18',
          totalAmount: 99,
          calculatedTotal: 60,
          totalDifference: 39,
          status: 'ABNORMAL',
          recognitionWarnings: 'AMOUNT_MISMATCH',
          createdAt: now,
          updatedAt: now,
          syncStatus: 'synced'
        }
      ],
      invoice_items: [
        {
          id: 'item-pending-1',
          companyId: seedCompany.id,
          invoiceId: 'inv-pending',
          supplierId: 'supplier-smoke',
          productNameOriginal: 'Smoke Product',
          productNameNormalized: 'smoke product',
          quantity: 5,
          unit: 'case',
          unitPrice: 7,
          totalPrice: 35,
          invoiceDate: '2026-06-18',
          createdAt: now,
          updatedAt: now,
          syncStatus: 'pending'
        },
        {
          id: 'item-duplicate-1',
          companyId: seedCompany.id,
          invoiceId: 'inv-duplicate',
          supplierId: 'supplier-smoke',
          productNameOriginal: 'Duplicate Product',
          productNameNormalized: 'duplicate product',
          quantity: 6,
          unitPrice: 8,
          totalPrice: 48,
          invoiceDate: '2026-06-18',
          createdAt: now,
          updatedAt: now,
          syncStatus: 'synced'
        }
      ],
      invoice_images: [
        {
          id: 'img-pending',
          invoiceId: 'inv-pending',
          companyId: seedCompany.id,
          imageBlob: new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }),
          size: pngBytes.length,
          mimeType: 'image/png',
          createdAt: now
        }
      ],
      price_history: [
        {
          id: 'price-pending-1',
          companyId: seedCompany.id,
          productId: 'product-smoke',
          invoiceId: 'inv-pending',
          invoiceItemId: 'item-pending-1',
          supplierId: 'supplier-smoke',
          price: 7,
          quantity: 5,
          invoiceDate: '2026-06-18',
          invoiceNo: 'SM-100',
          status: 'pending_review',
          createdAt: now,
          updatedAt: now,
          syncStatus: 'pending'
        }
      ],
      meta: [
        { id: 'sync:autoSync', value: 'false', updatedAt: now }
      ]
    };

    for (const [storeName, rows] of Object.entries(records)) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const row of rows) store.put(row);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    db.close();
  }, { stores, company, pngBytes: Array.from(tinyPng) });
}

async function openSeeded(page, path = '/') {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/manifest.webmanifest');
  await seedLocalData(page);
  const seededInvoiceCount = await page.evaluate(async () => {
    const request = indexedDB.open('InvoicePriceTrackerLocal', 9);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolve, reject) => {
      const tx = db.transaction('invoices', 'readonly');
      const countRequest = tx.objectStore('invoices').count();
      countRequest.onsuccess = () => {
        const result = countRequest.result;
        db.close();
        resolve(result);
      };
      countRequest.onerror = () => reject(countRequest.error);
    });
  });
  expect(seededInvoiceCount).toBeGreaterThanOrEqual(4);
  await page.goto(path);
  await expect(page.locator('.page-header h1')).toBeVisible();
  expect(pageErrors).toEqual([]);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth - window.innerWidth,
    document.body.scrollWidth - window.innerWidth
  ));
  expect(overflow).toBeLessThanOrEqual(2);
}

test('home and invoice list show pending duplicate and conflict entrances', async ({ page }) => {
  await openSeeded(page, '/');
  await expect(page.locator('a[href="/invoices?filter=pending"]').last()).toBeVisible();
  await expect(page.locator('a[href="/invoices?filter=duplicate"] strong')).toHaveText('1');
  await expect(page.locator('a[href="/invoices?filter=conflict"] strong')).toHaveText('1');

  await page.locator('a[href="/invoices?filter=duplicate"]').first().click();
  await expect(page).toHaveURL(/\/invoices\?filter=duplicate/);
  await expect(page.locator('.row-card').filter({ hasText: 'SM-101' })).toBeVisible();
  await expect(page.locator('.issue-reason').first()).toBeVisible();

  await page.goto('/invoices?filter=conflict');
  await expect(page.locator('.row-card').filter({ hasText: 'SM-102' })).toBeVisible();
  await expect(page.getByText('Mock cloud conflict')).toBeVisible();

  await page.goto('/invoices?filter=pending');
  await expect(page.locator('.row-card').filter({ hasText: 'SM-100' })).toBeVisible();
  await page.locator('a[href="/invoices/inv-pending"]').first().click();
  await expect(page).toHaveURL(/\/invoices\/inv-pending/);
  await expectNoHorizontalOverflow(page);
});

test('invoice detail supports image area collapsed AI JSON and item editing', async ({ page }) => {
  await openSeeded(page, '/invoices/inv-pending');
  await expect(page.locator('.status-row')).toBeVisible();
  await expect(page.locator('.image-diagnostics')).toBeVisible();
  await expect(page.getByText('Smoke OCR text')).toHaveCount(0);
  await expect(page.locator('.ocr-text').filter({ hasText: 'supplierName' })).toHaveCount(0);

  await page.locator('.collapsible-toggle').filter({ hasText: 'AI' }).click();
  await expect(page.locator('.ocr-text').filter({ hasText: 'Smoke Supplier' })).toBeVisible();

  const itemCard = page.locator('.detail-item').filter({ hasText: 'Smoke Product' }).first();
  await itemCard.locator('button').first().click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toBeVisible();
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill('Smoke Product Edited');
  await inputs.nth(3).fill('6');
  await inputs.nth(4).fill('7');
  await expect(inputs.nth(5)).toHaveValue('42');
  await dialog.locator('.switch-field button').nth(0).click();
  await dialog.locator('.switch-field button').nth(1).click();
  await dialog.locator('.switch-field button').nth(2).click();
  const saveButton = dialog.locator('.sticky-dialog-actions .primary-button');
  await expect(saveButton).toBeVisible();
  await saveButton.click();
  await expect(page.getByText('Smoke Product Edited')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('batch import task list and settings sync expose feedback states', async ({ page }) => {
  await openSeeded(page, '/invoices/batch');
  await expect(page.locator('input[type="file"][multiple]')).toHaveCount(1);

  await page.locator('input[type="file"][multiple]').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: Buffer.from(tinyPng) },
    { name: 'two.png', mimeType: 'image/png', buffer: Buffer.from(tinyPng) }
  ]);
  await expect(page.locator('.detail-item').filter({ hasText: 'one.png' })).toBeVisible();
  await expect(page.locator('.detail-item').filter({ hasText: 'two.png' })).toBeVisible();

  const batchControls = page.locator('.section').filter({ has: page.locator('input[type="file"][multiple]') }).locator('.row-actions button');
  await expect(batchControls).toHaveCount(3);
  await batchControls.nth(1).click();
  await expect(page.locator('.success-text, .error')).toBeVisible();
  await batchControls.nth(0).click();
  await expect(page.locator('.success-text, .error')).toBeVisible();
  await batchControls.nth(2).click();
  await expect(page.locator('.success-text, .error')).toBeVisible();

  await page.goto('/recognition-tasks');
  await expect(page.getByText('failed-invoice.png')).toBeVisible();
  await page.locator('.row-card').filter({ hasText: 'failed-invoice.png' }).locator('button').first().click();
  await expect(page.locator('.row-card').filter({ hasText: 'failed-invoice.png' }).locator('.success-text').first()).toBeVisible();

  await page.goto('/settings');
  await page.locator('main button:has(svg)').first().click();
  await expect(page.locator('.success-text, .error')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
