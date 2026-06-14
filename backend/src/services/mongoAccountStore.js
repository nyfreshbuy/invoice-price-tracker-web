import { MongoClient } from 'mongodb';

let clientPromise = null;
let activeMongoUri = '';
let indexesReady = false;
let connectionState = 'disconnected';
let lastConnectionError = '';

export function isMongoAuthConfigured() {
  return Boolean(getMongoUri());
}

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGO_URL || '';
}

function getMongoDbName() {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  try {
    const pathname = new URL(getMongoUri()).pathname.replace(/^\//, '');
    return pathname || 'invoice_price_tracker';
  } catch {
    return 'invoice_price_tracker';
  }
}

function getMongoHost() {
  try {
    return new URL(getMongoUri()).host || '';
  } catch {
    return '';
  }
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id || user._id,
    username: user.username || '',
    email: user.email || '',
    role: user.role || 'user',
    companyName: user.companyName || '',
    companyId: user.companyId || '',
    name: user.name || user.username || ''
  };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getClient() {
  const mongoUri = getMongoUri();
  if (!mongoUri) {
    throw new Error('MongoDB is not configured. Set MONGODB_URI.');
  }
  if (!clientPromise || activeMongoUri !== mongoUri) {
    console.info('[mongo] connecting to MongoDB');
    connectionState = 'connecting';
    lastConnectionError = '';
    const client = new MongoClient(mongoUri, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 15000
    });
    client.on?.('close', () => {
      connectionState = 'disconnected';
      console.warn('[mongo] disconnected');
    });
    client.on?.('error', (error) => {
      connectionState = 'error';
      lastConnectionError = error?.message || String(error);
      console.error('[mongo] error:', error?.stack || error);
    });
    clientPromise = client.connect()
      .then((connectedClient) => {
        connectionState = 'connected';
        lastConnectionError = '';
        console.info('[mongo] connected');
        return connectedClient;
      })
      .catch((error) => {
        connectionState = 'error';
        lastConnectionError = error?.message || String(error);
        console.error('[mongo] connection failed:', error?.stack || error);
        clientPromise = null;
        activeMongoUri = '';
        indexesReady = false;
        throw error;
      });
    activeMongoUri = mongoUri;
    indexesReady = false;
  }
  return clientPromise;
}

export function getMongoConnectionSnapshot() {
  return {
    mongoConfigured: Boolean(getMongoUri()),
    mongoConnected: connectionState === 'connected',
    status: connectionState,
    databaseName: getMongoDbName(),
    host: getMongoHost(),
    lastError: lastConnectionError
  };
}

export async function getMongoDebugStatus() {
  const snapshot = getMongoConnectionSnapshot();
  if (!snapshot.mongoConfigured) return snapshot;
  try {
    const db = await getMongoDb();
    await db.command({ ping: 1 });
    connectionState = 'connected';
    lastConnectionError = '';
    return { ...getMongoConnectionSnapshot(), mongoConnected: true, status: 'connected' };
  } catch (error) {
    connectionState = 'error';
    lastConnectionError = error?.message || String(error);
    console.error('[mongo] debug ping failed:', error?.stack || error);
    return { ...getMongoConnectionSnapshot(), mongoConnected: false, status: 'error' };
  }
}

export async function getMongoDb() {
  const client = await getClient();
  const db = client.db(getMongoDbName());
  if (!indexesReady) {
    console.info('[mongo] ensuring indexes');
    await Promise.all([
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('users').createIndex({ username: 1 }, { unique: true }),
      db.collection('users').createIndex({ companyName: 'text', username: 'text', email: 'text' }),
      db.collection('account_connections').createIndex({ requesterUserId: 1, targetUserId: 1 }),
      db.collection('account_connections').createIndex({ targetUserId: 1, status: 1 }),
      db.collection('companies').createIndex({ id: 1 }, { unique: true }),
      db.collection('company_invitations').createIndex({ token: 1 }, { unique: true }),
      db.collection('company_invitations').createIndex({ company_id: 1, created_at: -1 }),
      db.collection('company_invitations').createIndex({ email: 1, status: 1 })
    ]);
    indexesReady = true;
    console.info('[mongo] indexes ready');
  }
  return db;
}

export async function createMongoUser({ id, username, email, passwordHash, role = 'user', companyName, companyId, name }) {
  console.info('[mongo] create user start', { email, username, companyName });
  const db = await getMongoDb();
  const now = new Date().toISOString();
  const user = {
    _id: id,
    id,
    username: String(username || '').trim(),
    email: String(email || '').trim().toLowerCase(),
    passwordHash,
    role,
    companyName: String(companyName || '').trim(),
    companyId: companyId || id,
    name: String(name || username || '').trim(),
    connectedUserIds: [],
    createdAt: now,
    updatedAt: now
  };
  await db.collection('users').insertOne(user);
  await db.collection('companies').updateOne(
    { id: user.companyId },
    {
      $setOnInsert: {
        _id: user.companyId,
        id: user.companyId,
        name: user.companyName || companyName || '',
        createdAt: now
      },
      $set: { updatedAt: now }
    },
    { upsert: true }
  );
  console.info('[mongo] create user success', { userId: user.id, companyId: user.companyId });
  return user;
}

export async function findMongoCompanyById(companyId) {
  const db = await getMongoDb();
  return db.collection('companies').findOne({ id: String(companyId || '') });
}

export async function findMongoUserByLogin(login) {
  const db = await getMongoDb();
  const value = String(login || '').trim();
  if (!value) return null;
  return db.collection('users').findOne({
    $or: [
      { email: value.toLowerCase() },
      { username: value },
      { username: { $regex: `^${escapeRegex(value)}$`, $options: 'i' } }
    ]
  });
}

export async function findMongoUserByEmail(email) {
  const db = await getMongoDb();
  return db.collection('users').findOne({ email: String(email || '').trim().toLowerCase() });
}

export async function findMongoUserById(userId) {
  const db = await getMongoDb();
  return db.collection('users').findOne({ id: String(userId || '') });
}

export async function updateMongoUserFromLegacy({ email, passwordHash, companyId, companyName, role = 'admin', name }) {
  const db = await getMongoDb();
  const now = new Date().toISOString();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const existing = await db.collection('users').findOne({ email: normalizedEmail });
  if (!existing) return null;
  const update = {
    passwordHash,
    companyId,
    companyName: companyName || existing.companyName || '',
    role: role || existing.role || 'admin',
    name: name || existing.name || existing.username || '',
    updatedAt: now
  };
  await db.collection('users').updateOne({ id: existing.id }, { $set: update });
  await db.collection('companies').updateOne(
    { id: companyId },
    {
      $setOnInsert: {
        _id: companyId,
        id: companyId,
        name: companyName || '',
        createdAt: now
      },
      $set: { updatedAt: now }
    },
    { upsert: true }
  );
  return { ...existing, ...update };
}

export async function searchMongoUsers(keyword, currentUserId) {
  const db = await getMongoDb();
  const value = String(keyword || '').trim();
  if (!value) return [];
  const regex = new RegExp(escapeRegex(value), 'i');
  const users = await db.collection('users')
    .find({
      id: { $ne: currentUserId },
      $or: [
        { email: regex },
        { username: regex },
        { companyName: regex }
      ]
    })
    .limit(20)
    .toArray();
  return users.map(publicUser);
}

export async function createConnectionRequest({ id, requesterUserId, targetUserId, message }) {
  const db = await getMongoDb();
  if (requesterUserId === targetUserId) {
    const error = new Error('不能申请连接自己的账户');
    error.statusCode = 400;
    throw error;
  }
  const target = await findMongoUserById(targetUserId);
  if (!target) {
    const error = new Error('目标账户不存在');
    error.statusCode = 404;
    throw error;
  }
  const existing = await db.collection('account_connections').findOne({
    status: { $in: ['pending', 'approved'] },
    $or: [
      { requesterUserId, targetUserId },
      { requesterUserId: targetUserId, targetUserId: requesterUserId }
    ]
  });
  if (existing) {
    const error = new Error(existing.status === 'pending' ? '已发送过待处理申请' : '账户已经连接');
    error.statusCode = 409;
    throw error;
  }
  const now = new Date().toISOString();
  const request = {
    _id: id,
    id,
    requesterUserId,
    targetUserId,
    status: 'pending',
    message: String(message || '').trim(),
    createdAt: now,
    updatedAt: now,
    approvedAt: null
  };
  await db.collection('account_connections').insertOne(request);
  return hydrateConnection(request);
}

async function hydrateConnection(connection) {
  const [requester, target] = await Promise.all([
    findMongoUserById(connection.requesterUserId),
    findMongoUserById(connection.targetUserId)
  ]);
  return {
    id: connection.id || connection._id,
    requesterUserId: connection.requesterUserId,
    targetUserId: connection.targetUserId,
    status: connection.status,
    message: connection.message || '',
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    approvedAt: connection.approvedAt || null,
    requester: publicUser(requester),
    target: publicUser(target)
  };
}

export async function listSentConnections(userId) {
  const db = await getMongoDb();
  const rows = await db.collection('account_connections')
    .find({ requesterUserId: userId })
    .sort({ createdAt: -1 })
    .toArray();
  return Promise.all(rows.map(hydrateConnection));
}

export async function listReceivedConnections(userId) {
  const db = await getMongoDb();
  const rows = await db.collection('account_connections')
    .find({ targetUserId: userId })
    .sort({ createdAt: -1 })
    .toArray();
  return Promise.all(rows.map(hydrateConnection));
}

export async function decideConnection(connectionId, targetUserId, status) {
  const db = await getMongoDb();
  const connection = await db.collection('account_connections').findOne({ id: connectionId });
  if (!connection) {
    const error = new Error('申请记录不存在');
    error.statusCode = 404;
    throw error;
  }
  if (connection.targetUserId !== targetUserId) {
    const error = new Error('只有被申请人可以处理该申请');
    error.statusCode = 403;
    throw error;
  }
  if (connection.status !== 'pending') {
    const error = new Error('该申请已经处理过');
    error.statusCode = 409;
    throw error;
  }
  const now = new Date().toISOString();
  const update = {
    status,
    updatedAt: now,
    approvedAt: status === 'approved' ? now : null
  };
  await db.collection('account_connections').updateOne({ id: connectionId }, { $set: update });
  if (status === 'approved') {
    await Promise.all([
      db.collection('users').updateOne({ id: connection.requesterUserId }, { $addToSet: { connectedUserIds: connection.targetUserId }, $set: { updatedAt: now } }),
      db.collection('users').updateOne({ id: connection.targetUserId }, { $addToSet: { connectedUserIds: connection.requesterUserId }, $set: { updatedAt: now } })
    ]);
  }
  return hydrateConnection({ ...connection, ...update });
}

export async function createMongoInvitation({ id, companyId, companyName, email, role, token, createdBy, expiresAt }) {
  const db = await getMongoDb();
  const now = new Date().toISOString();
  const invitation = {
    _id: id,
    id,
    company_id: companyId,
    companyId,
    companyName: companyName || '',
    email: String(email || '').trim().toLowerCase(),
    role: role === 'admin' ? 'admin' : 'user',
    token,
    status: 'pending',
    created_by: createdBy,
    createdBy,
    created_at: now,
    createdAt: now,
    accepted_at: '',
    acceptedAt: '',
    expires_at: expiresAt,
    expiresAt
  };
  await db.collection('company_invitations').insertOne(invitation);
  return invitation;
}

export async function listMongoInvitations(companyId) {
  const db = await getMongoDb();
  return db.collection('company_invitations')
    .find({ company_id: companyId })
    .sort({ created_at: -1 })
    .toArray();
}

export async function findMongoInvitationByToken(token) {
  const db = await getMongoDb();
  return db.collection('company_invitations').findOne({ token: String(token || '') });
}

export async function expireMongoInvitation(invitationId) {
  const db = await getMongoDb();
  await db.collection('company_invitations').updateOne(
    { id: invitationId },
    { $set: { status: 'expired', updatedAt: new Date().toISOString() } }
  );
}

export async function acceptMongoInvitation({ invitation, userId, username, passwordHash }) {
  const db = await getMongoDb();
  const now = new Date().toISOString();
  const email = String(invitation.email || '').trim().toLowerCase();
  let user = await db.collection('users').findOne({ email });
  if (!user) {
    user = {
      _id: userId,
      id: userId,
      username: String(username || email).trim(),
      email,
      passwordHash,
      role: invitation.role || 'user',
      companyName: invitation.companyName || '',
      companyId: invitation.company_id || invitation.companyId,
      name: String(username || email).trim(),
      connectedUserIds: [],
      createdAt: now,
      updatedAt: now
    };
    await db.collection('users').insertOne(user);
  } else {
    await db.collection('users').updateOne(
      { id: user.id },
      {
        $set: {
          companyId: invitation.company_id || invitation.companyId,
          companyName: invitation.companyName || user.companyName || '',
          role: invitation.role || 'user',
          updatedAt: now
        }
      }
    );
    user = { ...user, companyId: invitation.company_id || invitation.companyId, companyName: invitation.companyName || user.companyName || '', role: invitation.role || 'user', updatedAt: now };
  }
  await db.collection('companies').updateOne(
    { id: invitation.company_id || invitation.companyId },
    {
      $setOnInsert: {
        _id: invitation.company_id || invitation.companyId,
        id: invitation.company_id || invitation.companyId,
        name: invitation.companyName || '',
        createdAt: now
      },
      $set: { updatedAt: now }
    },
    { upsert: true }
  );
  await db.collection('company_invitations').updateOne(
    { id: invitation.id },
    { $set: { status: 'accepted', accepted_at: now, acceptedAt: now, updatedAt: now } }
  );
  return user;
}

export function toPublicMongoUser(user) {
  return publicUser(user);
}
