# InvoicePriceTracker iOS Packaging

This project packages the existing React/Vite PWA as an iOS app with Capacitor. The business logic remains in the web app; the iOS project is a native wrapper around the built `dist/` app.

## Current Status

- Existing root `InvoicePriceTracker.xcodeproj`: old Swift iOS project, not the PWA wrapper.
- PWA wrapper config: `frontend/capacitor.config.json`.
- Bundle ID configured for the wrapper: `com.nyfreshbuy.invoicepricetracker`.
- App name: `InvoicePriceTracker`.
- Web directory: `dist`.

## PWA Requirements Checked

- Manifest: `public/manifest.webmanifest`
- Service worker: `public/service-worker.js`
- Icons: `public/icons/icon-192.png`, `public/icons/icon-512.png`
- Mobile viewport and safe-area support: `index.html` and app CSS
- Login state: stored in browser storage and validated through `GET /api/auth/me`
- Offline open: app shell and public support/legal pages are cached
- Camera/photo upload: existing file inputs remain available inside the iOS WebView

## App Store Public Pages

These pages are included under `public/` and should be deployed with the frontend:

- `/support.html`
- `/privacy.html`
- `/terms.html`
- `/download.html`

Use these URLs in App Store Connect after Render deploys the frontend.

## Generate the iOS Wrapper

Run from `web-pwa/frontend`:

```bash
npm install
npm run ios:init
```

This creates:

```text
frontend/ios/App/App.xcworkspace
```

After the first generation, use:

```bash
npm run ios:sync
npm run ios:open
```

## Xcode Configuration Checklist

Open `frontend/ios/App/App.xcworkspace` in Xcode.

Required checks before TestFlight/App Store:

- Signing Team: your Apple Developer Team
- Bundle Identifier: `com.nyfreshbuy.invoicepricetracker` or your final App Store bundle ID
- Display Name: `InvoicePriceTracker`
- Deployment Target: iOS 15 or newer is recommended
- AppIcon: replace generated icons with production assets if needed
- Launch Screen: Capacitor default launch screen is acceptable for TestFlight; customize before public release if desired
- Camera permission:
  - `NSCameraUsageDescription`: `Take invoice photos for recognition.`
- Photo library permission:
  - `NSPhotoLibraryUsageDescription`: `Select invoice images from your photo library.`
  - `NSPhotoLibraryAddUsageDescription`: `Save invoice images selected or captured in the app.`
- Network:
  - API must use HTTPS
  - `VITE_API_BASE_URL` should point to the Render backend before building

## Production Build Environment

Create `frontend/.env.production` locally or configure CI:

```text
VITE_API_BASE_URL=https://invoice-backend-8stb.onrender.com
```

Then:

```bash
npm run ios:sync
```

## Archive and Upload

In Xcode:

1. Select `Any iOS Device (arm64)`.
2. Product > Archive.
3. Validate App.
4. Distribute App > App Store Connect > Upload.

Yes, after each web change that should ship in the iOS app, you need to run:

```bash
npm run ios:sync
```

Then Archive again in Xcode and upload a new build.

## Image Storage Policy

Current behavior:

- Structured invoice data, items, products, suppliers, templates, and price history sync to cloud.
- Original invoice images remain local by default to control cloud storage cost.

Future migration feature:

- User explicitly uploads local images to temporary cloud storage.
- New phone downloads images.
- Cloud temporary images are deleted automatically after migration.
- This can be implemented as a paid feature later.

