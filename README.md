# InvoicePriceTracker Web PWA

This is the PWA version of InvoicePriceTracker.

## Structure

- `frontend/`: React + Vite + PWA
- `backend/`: Node.js + Express API
- Local development database: SQLite
- Render production cloud sync/account database: MongoDB Atlas through `MONGODB_URI`

## Current High-Priority Behavior

- Recognition tasks use a single-worker queue. Only one invoice image is processed at a time.
- New uploaded tasks start as `waiting`, then move to `processing`, `completed`, or `failed`.
- Batch controls are available: pause, continue, and cancel remaining waiting tasks.
- Failed tasks support retry, image re-upload, and manual entry.
- Original uploaded images remain under `UPLOAD_DIR` and can be viewed from the task list.
- Authentication is required. The frontend must have a valid JWT token and backend business APIs require `Authorization: Bearer <token>`.
- Template strategy: match `invoice_templates` from `supplierHint` or filename first; if matched, use template parsing and do not call AI Vision.
- If no template is matched, AI Vision is used and the successful result updates/creates a supplier template.
- AI product names preserve Chinese and English through `nameCn`, `nameEn`, and `standardName`.
- Confirmed invoices can be saved through “确认并学习”. This saves the invoice and updates supplier templates, product aliases, product learning rules, price history, corrections, and price anomaly records.
- Product learning maps raw recognized names to standard names and reuses them on later recognition.
- Price learning stores supplier/product price history and flags prices more than 30% away from historical average.
- Recognition corrections store before/after field changes so repeated mistakes can be fixed automatically over time.
- Free/gift invoice lines are tracked with charged quantity, free quantity, total quantity, original unit cost, and effective unit cost. Lines with `priceEach=0` or `amount=0` are treated as free items and used to dilute the actual purchase cost.
- True duplicate requires same supplier, same invoice number, same total amount, and highly similar item details.
- Same-batch multi-page invoices are merged automatically when supplier and invoice number match but page totals/items differ.
- Invoice bottom/page total is the source of truth. Item sum is stored as `calculatedTotal` for validation only.

## Authentication

- No valid token: frontend shows the login/register page.
- Valid token: frontend calls `GET /api/auth/me` and uses the returned user/company.
- Business APIs reject requests without `Authorization: Bearer <token>`.
- All business data is scoped to the company returned by `GET /api/auth/me`.

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
- `version`
- `updatedAt`
- `deletedAt`

The backend ignores client-provided `companyId` for authorization decisions. `/api/sync/push` and `/api/sync/pull` use only the authenticated user's company.

Supported sync tables:

- `purchase_batches`
- `suppliers`
- `invoices`
- `invoice_items`
- `products`
- `price_history`
- `invoice_discounts`
- `gift_allocation_rules`
- `supplier_templates`
- `product_aliases`
- `product_learning_rules`
- `recognition_corrections`
- `price_anomalies`

Recognition task history is stored in the backend table `invoice_recognition_tasks`.
When `MONGODB_URI` is configured, `/api/sync/push`, `/api/sync/pull`, and `/api/sync/status` use MongoDB Atlas and filter every collection by the JWT `companyId`. Local SQLite remains available for development and tests.

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

User registration, login, invitations, account connection requests, and sync data use MongoDB when `MONGODB_URI` is configured. SQLite remains the no-config local fallback.

Render production should use:

```text
MONGODB_URI=MongoDB Atlas connection string
MONGODB_DB=invoice_price_tracker
OPENAI_API_KEY=your OpenAI key
OPENAI_MODEL=gpt-4.1-mini
CORS_ORIGIN=https://your-frontend-name.onrender.com
DATA_DIR=/var/data
UPLOAD_DIR=/var/data/uploads
AUTH_SECRET=generate-a-long-random-secret
```

Startup logs should include:

```text
[database] mode: MongoDB
[sync] enabled (MongoDB)
```

`DATABASE_URL` is optional and only keeps the older PostgreSQL/SQL fallback available. If `MONGODB_URI` is present, sync endpoints use MongoDB unless `USE_MONGO_SYNC=false`.
Mongo authentication is enabled by default when `MONGODB_URI` is present. To force local SQL auth for development, set `AUTH_STORE=sqlite` or `USE_MONGO_AUTH=false`.

OpenAI keys must only be configured in backend environment variables. Never put `OPENAI_API_KEY` in the frontend.

## iOS App Packaging

The current iOS packaging strategy is to wrap the existing PWA with Capacitor. This keeps the React/Vite PWA codebase and does not rewrite the app in Swift.

Frontend files added for App Store/TestFlight readiness:

- `frontend/capacitor.config.json`
- `frontend/IOS_PACKAGING.md`
- `frontend/public/support.html`
- `frontend/public/privacy.html`
- `frontend/public/terms.html`
- `frontend/public/download.html`

The repository root also contains an older `InvoicePriceTracker.xcodeproj`. That project is not the current PWA wrapper. For the PWA-based iOS app, generate the Capacitor project from `web-pwa/frontend`:

```bash
cd frontend
npm install
npm run ios:init
```

After the first generation:

```bash
npm run ios:sync
npm run ios:open
```

Before building for TestFlight/App Store, set:

```text
VITE_API_BASE_URL=https://invoice-backend-8stb.onrender.com
```

Then run `npm run ios:sync`, open `frontend/ios/App/App.xcworkspace`, configure signing, verify camera/photo privacy strings, Archive, and upload through Xcode.

Invoice images remain local by default. Cloud sync uploads structured invoice/product/supplier data, not original invoice images. A future paid migration feature can temporarily upload local images so a new phone can download them and then delete the temporary cloud copies.

Account connection APIs require a real JWT login token. Registration is always available on the login page.

```text
# backend
MONGODB_URI=your MongoDB connection string
AUTH_SECRET=generate-a-long-random-secret
```

Account APIs:

```text
POST /api/auth/register
POST /api/auth/login
GET /api/users/search?keyword=
POST /api/account-connections/request
GET /api/account-connections/sent
GET /api/account-connections/received
POST /api/account-connections/:id/approve
POST /api/account-connections/:id/reject
```

## Frontend Environment Variables

Render Static Site:

```text
VITE_API_BASE_URL=https://your-backend-name.onrender.com
```

## Render Deployment

Deploy the backend first, then the frontend.

### 1. MongoDB Atlas

Create a MongoDB Atlas database and copy its connection string into the backend `MONGODB_URI`.

### 2. Backend: Render Web Service

- Root Directory: `web-pwa/backend`
- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

Environment variables:

```text
MONGODB_URI=MongoDB Atlas connection string
MONGODB_DB=invoice_price_tracker
OPENAI_API_KEY=your OpenAI key
OPENAI_MODEL=gpt-4.1-mini
CORS_ORIGIN=https://your-frontend-name.onrender.com
DATA_DIR=/var/data
UPLOAD_DIR=/var/data/uploads
AUTH_SECRET=generate-a-long-random-secret
```

Optional Render Disk:

```text
/var/data
```

The disk is useful for uploaded invoice images. MongoDB stores users, invitations, account relationships, and synchronized invoice/business records. SQLite is still used when MongoDB is not configured for local development.

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
```

Single-page app routes such as `/invite/:token` require a Render rewrite fallback.
If you use the committed `render.yaml`, this is already configured:

```yaml
routes:
  - type: rewrite
    source: /*
    destination: /index.html
```

If you manage the existing Static Site manually in the Render Dashboard, add:

```text
Source: /*
Destination: /index.html
Action: Rewrite
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
