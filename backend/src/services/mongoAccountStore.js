import { MongoClient } from 'mongodb';

let clientPromise = null;
let activeMongoUri = '';
let indexesReady = false;

export function isMongoAuthConfigured() {
  return Boolean(getMongoUri());
}

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGO_URL || '';
}

function getMongoDbName() {
  return process.env.MONGODB_DB || 'invoice_price_tracker';
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
    const client = new MongoClient(mongoUri);
    clientPromise = client.connect();
    activeMongoUri = mongoUri;
    indexesReady = false;
  }
  return clientPromise;
}

export async function getMongoDb() {
  const client = await getClient();
  const db = client.db(getMongoDbName());
  if (!indexesReady) {
    await Promise.all([
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('users').createIndex({ username: 1 }, { unique: true }),
      db.collection('users').createIndex({ companyName: 'text', username: 'text', email: 'text' }),
      db.collection('account_connections').createIndex({ requesterUserId: 1, targetUserId: 1 }),
      db.collection('account_connections').createIndex({ targetUserId: 1, status: 1 })
    ]);
    indexesReady = true;
  }
  return db;
}

export async function createMongoUser({ id, username, email, passwordHash, role = 'user', companyName, companyId, name }) {
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
  return user;
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

export async function findMongoUserById(userId) {
  const db = await getMongoDb();
  return db.collection('users').findOne({ id: String(userId || '') });
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

export function toPublicMongoUser(user) {
  return publicUser(user);
}
