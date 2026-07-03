import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './styles.css';
import { sanitizeAuthStorage } from './api.js';

sanitizeAuthStorage();
const ACTIVE_CACHE_NAME = 'invoice-price-tracker-utf8-v17';
const ACTIVE_CACHE_VERSION_KEY = 'invoice-price-tracker-cache-version';
if ('caches' in window) {
  caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key.startsWith('invoice-price-tracker-') && key !== ACTIVE_CACHE_NAME)
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
              .filter((key) => key.startsWith('invoice-price-tracker-') && key !== ACTIVE_CACHE_NAME)
              .map((key) => caches.delete(key))))
            .catch(() => {});
        }
        try {
          if (localStorage.getItem(ACTIVE_CACHE_VERSION_KEY) !== ACTIVE_CACHE_NAME) {
            localStorage.setItem(ACTIVE_CACHE_VERSION_KEY, ACTIVE_CACHE_NAME);
            window.location.reload();
          }
        } catch {
          window.location.reload();
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
