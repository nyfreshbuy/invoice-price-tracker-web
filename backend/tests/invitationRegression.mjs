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
const adminEmail = `invite-admin-${suffix}@example.com`;
const memberEmail = `invite-member-${suffix}@example.com`;
const password = 'invite-pass';

const register = await json('POST', '/api/auth/register', {
  username: `invite-admin-${suffix}`,
  email: adminEmail,
  password,
  companyName: `Invite Regression ${suffix}`
}, { auth: false });
assert.equal(register.success, true);

const session = await json('POST', '/api/auth/login', { login: adminEmail, password }, { auth: false });
authToken = session.token;
assert.equal(session.user.role, 'admin');

const created = await json('POST', '/api/invitations', { email: memberEmail, role: 'user' });
assert.equal(created.success, true);
assert.ok(created.invitation.token);
assert.ok(created.invitation.inviteLink.includes(`/invite/${created.invitation.token}`));

const list = await json('GET', '/api/invitations');
assert.ok(list.invitations.some((entry) => entry.email === memberEmail));

const preview = await json('GET', `/api/invitations/${created.invitation.token}`, undefined, { auth: false });
assert.equal(preview.invitation.email, memberEmail);
assert.equal(preview.invitation.status, 'pending');

const accepted = await json('POST', '/api/invitations/accept', {
  token: created.invitation.token,
  username: `invite-member-${suffix}`,
  password
}, { auth: false });
assert.equal(accepted.success, true);
assert.equal(accepted.user.email, memberEmail);
assert.equal(accepted.user.companyId, session.user.companyId);

console.log(JSON.stringify({
  ok: true,
  invitationStatus: preview.invitation.status,
  acceptedUser: accepted.user.email,
  companyId: accepted.user.companyId
}, null, 2));
