import http from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';

function bodyFromRawResponse(raw) {
  const marker = '\r\n\r\n';
  const index = raw.indexOf(marker);
  return index >= 0 ? raw.slice(index + marker.length) : raw;
}

function parseStatus(raw) {
  const match = raw.match(/^HTTP\/1\.\d\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function invoke(method, url, body) {
  const requestBody = body === undefined ? '' : JSON.stringify(body);
  const chunks = [];
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  socket.remoteAddress = '127.0.0.1';

  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    origin: 'http://localhost:5173',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(requestBody)
  };
  req.socket = socket;
  req.connection = socket;

  const res = new http.ServerResponse(req);
  res.assignSocket(socket);

  const done = new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
    socket.on('error', reject);
  });

  app.handle(req, res);
  queueMicrotask(() => {
    if (requestBody) req.emit('data', Buffer.from(requestBody));
    req.emit('end');
  });
  await done;

  const raw = Buffer.concat(chunks).toString('utf8');
  const text = bodyFromRawResponse(raw);
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: parseStatus(raw), data, text };
}

async function json(method, url, body) {
  const response = await invoke(method, url, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${url} failed: ${response.status} ${response.text}`);
  }
  return response.data;
}

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `auth-regression-${suffix}@example.com`;
const username = `auth-user-${suffix}`;
const password = 'auth-pass-123';

const registered = await json('POST', '/api/auth/register', {
  username,
  email: `  ${email.toUpperCase()}  `,
  password,
  companyName: `Auth Regression ${suffix}`
});
assert.equal(registered.success, true);
assert.equal(registered.user.email, email);

const duplicate = await invoke('POST', '/api/auth/register', {
  username: `${username}-2`,
  email,
  password,
  companyName: `Auth Regression Duplicate ${suffix}`
});
assert.equal(duplicate.status, 409);
assert.match(duplicate.data.error || '', /邮箱|Email/i);

const loginByEmail = await json('POST', '/api/auth/login', {
  login: ` ${email.toUpperCase()} `,
  password
});
assert.ok(loginByEmail.token);
assert.equal(loginByEmail.user.email, email);

const loginByUsername = await json('POST', '/api/auth/login', {
  login: username,
  password
});
assert.ok(loginByUsername.token);
assert.equal(loginByUsername.user.email, email);

const wrongPassword = await invoke('POST', '/api/auth/login', {
  login: email,
  password: 'wrong-password'
});
assert.equal(wrongPassword.status, 401);

console.log(JSON.stringify({
  ok: true,
  email,
  duplicateStatus: duplicate.status,
  loginByEmail: Boolean(loginByEmail.token),
  loginByUsername: Boolean(loginByUsername.token)
}, null, 2));
