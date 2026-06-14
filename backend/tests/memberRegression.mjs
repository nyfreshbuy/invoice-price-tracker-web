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

let authToken = '';

async function invoke(method, url, body, options = {}) {
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
    'content-length': Buffer.byteLength(requestBody),
    ...(options.auth === false || !authToken ? {} : { authorization: `Bearer ${authToken}` })
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

async function json(method, url, body, options) {
  const response = await invoke(method, url, body, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${url} failed: ${response.status} ${response.text}`);
  }
  return response.data;
}

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const adminEmail = `member-admin-${suffix}@example.com`;
const memberEmail = `member-sales-${suffix}@example.com`;
const adminPassword = 'member-admin-pass';
const memberPassword = 'member-sales-pass';
const resetPassword = 'member-reset-pass';

await json('POST', '/api/auth/register', {
  username: `member-admin-${suffix}`,
  email: adminEmail,
  password: adminPassword,
  companyName: `Member Regression ${suffix}`
}, { auth: false });

const adminSession = await json('POST', '/api/auth/login', { login: adminEmail, password: adminPassword }, { auth: false });
authToken = adminSession.token;
assert.ok(['admin', 'super_admin'].includes(adminSession.user.role));

const created = await json('POST', '/api/admin/members', {
  name: 'Sales Member',
  email: memberEmail,
  password: memberPassword,
  role: 'sales',
  status: 'active',
  phone: '555-0100',
  note: 'regression'
});
assert.equal(created.member.email, memberEmail);
assert.equal(created.member.role, 'sales');

const list = await json('GET', '/api/admin/members');
assert.ok(list.members.some((member) => member.email === memberEmail));
assert.ok(list.members.some((member) => member.email === adminEmail));

const memberLogin = await json('POST', '/api/auth/login', { login: memberEmail, password: memberPassword }, { auth: false });
assert.ok(memberLogin.token);
authToken = memberLogin.token;
const forbidden = await invoke('GET', '/api/admin/members');
assert.equal(forbidden.status, 403);

authToken = adminSession.token;
const disabled = await json('POST', `/api/admin/members/${created.member.id}/disable`);
assert.equal(disabled.member.status, 'disabled');
const disabledLogin = await invoke('POST', '/api/auth/login', { login: memberEmail, password: memberPassword }, { auth: false });
assert.equal(disabledLogin.status, 403);

await json('POST', `/api/admin/members/${created.member.id}/enable`);
await json('POST', `/api/admin/members/${created.member.id}/reset-password`, { password: resetPassword });
const oldPasswordLogin = await invoke('POST', '/api/auth/login', { login: memberEmail, password: memberPassword }, { auth: false });
assert.equal(oldPasswordLogin.status, 401);
const resetLogin = await json('POST', '/api/auth/login', { login: memberEmail, password: resetPassword }, { auth: false });
assert.ok(resetLogin.token);

authToken = adminSession.token;
await json('PUT', `/api/admin/members/${created.member.id}`, {
  name: 'Sales Member Updated',
  email: memberEmail,
  role: 'admin',
  status: 'active',
  phone: '555-0101',
  note: 'updated'
});
const updatedList = await json('GET', '/api/admin/members');
assert.ok(updatedList.members.some((member) => member.email === memberEmail && member.role === 'admin'));

const selfDisable = await invoke('POST', `/api/admin/members/${adminSession.user.id}/disable`);
assert.equal(selfDisable.status, 400);

await json('DELETE', `/api/admin/members/${created.member.id}`);
const afterDelete = await json('GET', '/api/admin/members');
assert.ok(!afterDelete.members.some((member) => member.email === memberEmail));

console.log(JSON.stringify({
  ok: true,
  createdMember: memberEmail,
  memberLogin: Boolean(memberLogin.token),
  disabledLoginStatus: disabledLogin.status,
  resetLogin: Boolean(resetLogin.token)
}, null, 2));
