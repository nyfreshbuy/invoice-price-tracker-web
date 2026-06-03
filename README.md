# InvoicePriceTracker Web PWA

This is the PWA version of InvoicePriceTracker.

## Structure

- `frontend/`: React + Vite + PWA
- `backend/`: Node.js + Express API
- Local development database: SQLite
- Render production database: PostgreSQL through `DATABASE_URL`

## Current High-Priority Behavior

- Recognition tasks use a single-worker queue. Only one invoice image is processed at a time.
- New uploaded tasks start as `waiting`, then move to `processing`, `completed`, or `failed`.
- Batch controls are available: pause, continue, and cancel remaining waiting tasks.
- Failed tasks support retry, image re-upload, and manual entry.
- Original uploaded images remain under `UPLOAD_DIR` and can be viewed from the task list.
- Testing can skip login with `AUTO_LOGIN=true` on the backend and `VITE_AUTO_LOGIN=true` on the frontend.
- Template strategy: match `invoice_templates` from `supplierHint` or filename first; if matched, use template parsing and do not call AI Vision.
- If no template is matched, AI Vision is used and the successful result updates/creates a supplier template.
- AI product names preserve Chinese and English through `nameCn`, `nameEn`, and `standardName`.
- Confirmed invoices can be saved through “确认并学习”. This saves the invoice and updates supplier templates, product aliases, product learning rules, price history, corrections, and price anomaly records.
- Product learning maps raw recognized names to standard names and reuses them on later recognition.
- Price learning stores supplier/product price history and flags prices more than 30% away from historical average.
- Recognition corrections store before/after field changes so repeated mistakes can be fixed automatically over time.
- True duplicate requires same supplier, same invoice number, same total amount, and highly similar item details.
- Same-batch multi-page invoices are merged automatically when supplier and invoice number match but page totals/items differ.
- Invoice bottom/page total is the source of truth. Item sum is stored as `calculatedTotal` for validation only.

## Current Testing Mode

The project currently supports `DEMO_NO_AUTH` mode for testing.

- Frontend skips login when `VITE_DEMO_NO_AUTH=true`
- Backend allows requests without `Authorization` when `DEMO_NO_AUTH=true`
- Default company: `demo-company` / `测试公司`
- Default user: `demo-user` / `demo`
- IndexedDB records are written under `demo-company`
- Sync, invoice, supplier, OCR, AI invoice, and recognition task APIs use `demo-company` when no token is provided
- Login and registration code is still present and can be restored later

To restore normal login:

```text
# backend
DEMO_NO_AUTH=false

# frontend
VITE_DEMO_NO_AUTH=false
```

## Background Invoice Recognition

Invoice image recognition now runs as a backend task, so the frontend page does not need to stay open.

Flow:

1. Frontend uploads an image to `POST /api/invoice-recognition/tasks`.
2. Backend saves the original image under `UPLOAD_DIR`.
3. Backend creates a recognition task and immediately returns `taskId`.
4. Backend runs OCR/template/AI Vision asynchronously.
5. Frontend polls task status and can show historical task records.
6. When recognition completes, backend saves the recognized invoice and items to the database.
7. Failed tasks keep their error message and can be retried.

Task statuses:

- `pending`
- `processing`
- `completed`
- `failed`

Recognition task APIs:

```text
POST /api/invoice-recognition/tasks
GET /api/invoice-recognition/tasks
GET /api/invoice-recognition/tasks/:id
POST /api/invoice-recognition/tasks/:id/retry
POST /api/invoice-recognition/tasks/:id/force-save
POST /api/invoice-recognition/tasks/:id/decision
POST /api/invoice-recognition/batches/:batchId/pause
POST /api/invoice-recognition/batches/:batchId/resume
POST /api/invoice-recognition/batches/:batchId/cancel
```

The frontend includes a task history page:

```text
/recognition-tasks
```

## Sync Model

The browser stores data in IndexedDB first. New, edited, and deleted records are marked with:

- `pending`
- `synced`
- `conflict`
- `deleted`

Every synced record includes:

- `companyId`
- `localId`
- `serverId`
- `deviceId`
- `syncStatus`
- `updatedAt`
- `deletedAt`

The backend ignores client-provided `companyId` for authorization decisions. `/api/sync/push` and `/api/sync/pull` use the authenticated user's company, or `demo-company` in `DEMO_NO_AUTH` mode.

Supported sync tables:

- `purchase_batches`
- `suppliers`
- `invoices`
- `invoice_items`
- `products`
- `price_history`
- `supplier_templates`

Recognition task history is stored in the backend table `invoice_recognition_tasks`.

## Run Locally

Backend:

```bash
cd backend
npm install
npm run dev
```

Without `DATABASE_URL`, the backend uses local SQLite:

```text
http://localhost:3000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

Local frontend default:

```text
VITE_API_BASE_URL=http://localhost:3000
```

For phone/iPad testing on the same network:

```text
VITE_API_BASE_URL=http://YOUR_COMPUTER_LAN_IP:3000
```

Then open:

```text
http://YOUR_COMPUTER_LAN_IP:5173
```

## Backend Environment Variables

Local SQLite development can run with no required env vars.

Render production should use:

```text
DATABASE_URL=PostgreSQL connection string
OPENAI_API_KEY=your OpenAI key
OPENAI_MODEL=gpt-4.1-mini
CORS_ORIGIN=https://your-frontend-name.onrender.com
DATA_DIR=/var/data
UPLOAD_DIR=/var/data/uploads
AUTH_SECRET=generate-a-long-random-secret
DEMO_NO_AUTH=true
```

`DATABASE_URL` controls database mode:

- Missing: SQLite
- Present: PostgreSQL

OpenAI keys must only be configured in backend environment variables. Never put `OPENAI_API_KEY` in the frontend.

## Frontend Environment Variables

Render Static Site:

```text
VITE_API_BASE_URL=https://your-backend-name.onrender.com
VITE_DEMO_NO_AUTH=true
```

## Render Deployment

Deploy the backend first, then the frontend.

### 1. PostgreSQL

Create a Render PostgreSQL database and copy its connection string into the backend `DATABASE_URL`.

### 2. Backend: Render Web Service

- Root Directory: `web-pwa/backend`
- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

Environment variables:

```text
DATABASE_URL=PostgreSQL connection string
OPENAI_API_KEY=your OpenAI key
OPENAI_MODEL=gpt-4.1-mini
CORS_ORIGIN=https://your-frontend-name.onrender.com
DATA_DIR=/var/data
UPLOAD_DIR=/var/data/uploads
AUTH_SECRET=generate-a-long-random-secret
DEMO_NO_AUTH=true
```

Optional Render Disk:

```text
/var/data
```

The disk is useful for uploaded invoice images. PostgreSQL stores the business data and recognition task history.

Health check:

```text
https://your-backend-name.onrender.com/api/health
```

### 3. Frontend: Render Static Site

- Root Directory: `web-pwa/frontend`
- Build Command: `npm install && npm run build`
- Publish Directory: `dist`

Environment variable:

```text
VITE_API_BASE_URL=https://your-backend-name.onrender.com
VITE_DEMO_NO_AUTH=true
```

After the frontend deploys, update backend:

```text
CORS_ORIGIN=https://your-frontend-name.onrender.com
```

Redeploy backend after changing CORS.

## PWA

The app includes:

- `frontend/public/manifest.webmanifest`
- `frontend/public/service-worker.js`
- `frontend/public/icons/icon-192.png`
- `frontend/public/icons/icon-512.png`
- PWA meta tags in `frontend/index.html`
- Service worker registration in `frontend/src/main.jsx`

Installed PWA behavior keeps using IndexedDB first. If the network is unavailable, edits remain local and sync after reconnecting.
