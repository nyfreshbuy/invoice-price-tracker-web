# InvoicePriceTracker Web PWA

This is the PWA version of InvoicePriceTracker.

## Structure

- `frontend/`: React + Vite + PWA
- `backend/`: Node.js + Express API
- Local development database: SQLite
- Render production database: PostgreSQL through `DATABASE_URL`

## Public Multi-User Version

The app now supports:

- User registration and login
- Company/store isolation through `companyId`
- IndexedDB local-first writes
- Offline pending changes
- Automatic sync after reconnecting
- Render Static Site frontend
- Render Web Service backend
- PostgreSQL cloud database on Render
- AI Vision calls only from the backend

OpenAI keys must only be configured in backend environment variables. Never put `OPENAI_API_KEY` in the frontend.

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

The backend ignores client-provided `companyId` for authorization decisions. `/api/sync/push` and `/api/sync/pull` use the logged-in user's token and only read/write that user's company data.

Supported sync tables:

- `purchase_batches`
- `suppliers`
- `invoices`
- `invoice_items`
- `products`
- `price_history`
- `supplier_templates`

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
DATABASE_URL=PostgreSQL连接地址
OPENAI_API_KEY=你的 OpenAI Key
OPENAI_MODEL=gpt-4.1-mini
CORS_ORIGIN=https://前端地址.onrender.com
DATA_DIR=/var/data
UPLOAD_DIR=/var/data/uploads
AUTH_SECRET=生成一个长随机字符串
```

`DATABASE_URL` controls database mode:

- Missing: SQLite
- Present: PostgreSQL

## Frontend Environment Variables

Render Static Site:

```text
VITE_API_BASE_URL=https://后端地址.onrender.com
```

## Render Deployment

Deploy the backend first, then the frontend.

### 1. PostgreSQL

Create a Render PostgreSQL database and copy its internal or external connection string into the backend `DATABASE_URL`.

### 2. Backend: Render Web Service

- Root Directory: `web-pwa/backend`
- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

Environment variables:

```text
DATABASE_URL=PostgreSQL连接地址
OPENAI_API_KEY=你的 OpenAI Key
OPENAI_MODEL=gpt-4.1-mini
CORS_ORIGIN=https://your-frontend-name.onrender.com
DATA_DIR=/var/data
UPLOAD_DIR=/var/data/uploads
AUTH_SECRET=生成一个长随机字符串
```

Optional Render Disk:

```text
/var/data
```

The disk is useful for uploaded invoice images. PostgreSQL stores the business data.

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
