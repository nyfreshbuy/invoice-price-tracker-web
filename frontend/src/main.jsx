import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './styles.css';
import { sanitizeAuthStorage } from './api.js';

sanitizeAuthStorage();
if ('caches' in window) {
  caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key.startsWith('invoice-price-tracker-') && key !== 'invoice-price-tracker-auth-required-v4')
      .map((key) => caches.delete(key))))
    .catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'AUTH_REQUIRED_VERSION_ACTIVE') {
        sanitizeAuthStorage();
        if ('caches' in window) {
          caches.keys()
            .then((keys) => Promise.all(keys
              .filter((key) => key.startsWith('invoice-price-tracker-') && key !== 'invoice-price-tracker-auth-required-v4')
              .map((key) => caches.delete(key))))
            .catch(() => {});
        }
      }
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('/service-worker.js').then((registration) => {
      registration.update();
    }).catch((error) => {
      console.warn('Service worker registration failed', error);
    });
  });
}
