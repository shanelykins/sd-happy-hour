const http = require('http');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const PORT = Number(process.env.PORT || 3456);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const HAPPY_HOURS_FILE = path.join(DATA_DIR, 'happy-hours.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const sessions = new Map();

const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/submit.html', { file: 'submit.html', type: 'text/html; charset=utf-8' }],
  ['/login.html', { file: 'login.html', type: 'text/html; charset=utf-8' }],
  ['/account.html', { file: 'account.html', type: 'text/html; charset=utf-8' }],
  ['/list.html', { file: 'list.html', type: 'text/html; charset=utf-8' }],
  ['/admin.html', { file: 'admin.html', type: 'text/html; charset=utf-8' }]
]);

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map(cookie => cookie.trim())
      .filter(Boolean)
      .map(cookie => {
        const index = cookie.indexOf('=');
        return index === -1 ? [cookie, ''] : [cookie.slice(0, index), decodeURIComponent(cookie.slice(index + 1))];
      })
  );
}

function getSession(req) {
  const sessionId = parseCookies(req).sdhh_session;
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return { id: sessionId, ...session };
}

function createSession(res, sessionData) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const maxAgeSeconds = 60 * 60 * 8;
  sessions.set(sessionId, {
    ...sessionData,
    createdAt: Date.now(),
    expiresAt: Date.now() + maxAgeSeconds * 1000
  });
  res.setHeader('Set-Cookie', `sdhh_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`);
}

function clearSession(req, res) {
  const session = getSession(req);
  if (session) sessions.delete(session.id);
  res.setHeader('Set-Cookie', 'sdhh_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function cleanString(value) {
  return String(value || '').trim();
}

function cleanList(value) {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }
  return String(value || '')
    .split(/\n|,/)
    .map(cleanString)
    .filter(Boolean);
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateListing(input, { requireCoordinates = false } = {}) {
  const listing = {
    name: cleanString(input.name),
    neighborhood: cleanString(input.neighborhood),
    address: cleanString(input.address),
    lat: input.lat === '' || input.lat == null ? null : Number(input.lat),
    lng: input.lng === '' || input.lng == null ? null : Number(input.lng),
    days: cleanList(input.days),
    startTime: cleanString(input.startTime),
    endTime: cleanString(input.endTime),
    deals: cleanList(input.deals),
    vibe: cleanString(input.vibe),
    website: cleanString(input.website),
    verified: Boolean(input.verified),
    lastVerifiedAt: input.lastVerifiedAt || null,
    sourceUrl: cleanString(input.sourceUrl || input.website),
    dealTypes: cleanList(input.dealTypes),
    features: cleanList(input.features)
  };

  const errors = [];
  const validDays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  if (!listing.name) errors.push('Restaurant name is required.');
  if (!listing.neighborhood) errors.push('Neighborhood is required.');
  if (!listing.address) errors.push('Address is required.');
  if (!listing.website || !/^https?:\/\//i.test(listing.website)) errors.push('Website must start with http:// or https://.');
  if (!listing.sourceUrl || !/^https?:\/\//i.test(listing.sourceUrl)) errors.push('Source URL must start with http:// or https://.');
  if (!listing.days.length || listing.days.some(day => !validDays.has(day))) errors.push('Choose at least one valid day.');
  if (!isValidTime(listing.startTime)) errors.push('Start time must use HH:MM 24-hour format.');
  if (!isValidTime(listing.endTime)) errors.push('End time must use HH:MM 24-hour format.');
  if (!listing.deals.length) errors.push('Add at least one deal.');
  if (!listing.vibe) errors.push('Vibe is required.');
  if (!listing.dealTypes.length) errors.push('Choose at least one deal type.');
  if (!listing.features.length) errors.push('Choose at least one feature.');
  if (requireCoordinates && (!Number.isFinite(listing.lat) || !Number.isFinite(listing.lng))) {
    errors.push('Latitude and longitude are required before approval.');
  }
  if (Number.isFinite(listing.lat) && (listing.lat < -90 || listing.lat > 90)) errors.push('Latitude is invalid.');
  if (Number.isFinite(listing.lng) && (listing.lng < -180 || listing.lng > 180)) errors.push('Longitude is invalid.');

  return { listing, errors };
}

function validateSubmission(input) {
  const { listing, errors } = validateListing(input);
  const contact = {
    contactName: cleanString(input.contactName),
    contactEmail: cleanString(input.contactEmail),
    notes: cleanString(input.notes)
  };
  if (!contact.contactName) errors.push('Contact name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.contactEmail)) errors.push('A valid contact email is required.');
  return { listing, contact, errors };
}

function authorize(req, role) {
  const session = getSession(req);
  return Boolean(session && (!role || session.role === role));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user.passwordSalt || !user.passwordHash) return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    shareId: user.shareId,
    savedSpots: user.savedSpots || []
  };
}

function requireUser(req, res) {
  const session = getSession(req);
  if (!session || session.role !== 'user') {
    sendJson(res, 401, { errors: ['User login required.'] });
    return null;
  }
  return session;
}

async function serveStatic(res, pathname) {
  const route = staticFiles.get(pathname);
  if (!route) {
    sendText(res, 404, 'Not found');
    return;
  }

  const filePath = path.join(ROOT_DIR, route.file);
  if (!filePath.startsWith(ROOT_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': route.type,
      'Cache-Control': 'no-store'
    });
    res.end(content);
  } catch (err) {
    sendText(res, err.code === 'ENOENT' ? 404 : 500, err.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { errors: ['Invalid JSON body.'] });
      return;
    }

    const username = cleanString(body.username);
    const password = String(body.password || '');
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      sendJson(res, 401, { errors: ['Invalid username or password.'] });
      return;
    }

    createSession(res, { role: 'admin', username });
    sendJson(res, 200, { username });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    clearSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/me') {
    const session = getSession(req);
    const authenticated = Boolean(session && session.role === 'admin');
    sendJson(res, 200, { authenticated, username: authenticated ? session.username : null });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/account/register') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { errors: ['Invalid JSON body.'] });
      return;
    }

    const name = cleanString(body.name);
    const email = cleanString(body.email).toLowerCase();
    const password = String(body.password || '');
    const errors = [];
    if (!name) errors.push('Name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('A valid email is required.');
    if (password.length < 8) errors.push('Password must be at least 8 characters.');
    if (errors.length) {
      sendJson(res, 422, { errors });
      return;
    }

    const users = await readJson(USERS_FILE, []);
    if (users.some(user => user.email === email)) {
      sendJson(res, 409, { errors: ['An account already exists for that email.'] });
      return;
    }

    const passwordRecord = hashPassword(password);
    const now = new Date().toISOString();
    const user = {
      id: `user_${Date.now()}`,
      name,
      email,
      passwordSalt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      shareId: crypto.randomBytes(8).toString('hex'),
      savedSpots: [],
      createdAt: now,
      updatedAt: now
    };
    users.push(user);
    await writeJson(USERS_FILE, users);
    createSession(res, { role: 'user', userId: user.id });
    sendJson(res, 201, publicUser(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/account/login') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { errors: ['Invalid JSON body.'] });
      return;
    }

    const email = cleanString(body.email).toLowerCase();
    const password = String(body.password || '');
    const users = await readJson(USERS_FILE, []);
    const user = users.find(item => item.email === email);
    if (!user || !verifyPassword(password, user)) {
      sendJson(res, 401, { errors: ['Invalid email or password.'] });
      return;
    }

    createSession(res, { role: 'user', userId: user.id });
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/account/google') {
    if (!googleClient || !GOOGLE_CLIENT_ID) {
      sendJson(res, 503, { errors: ['Google login is not configured. Set GOOGLE_CLIENT_ID.'] });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { errors: ['Invalid JSON body.'] });
      return;
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: cleanString(body.credential),
        audience: GOOGLE_CLIENT_ID
      });
      payload = ticket.getPayload();
    } catch (err) {
      sendJson(res, 401, { errors: ['Google sign-in could not be verified.'] });
      return;
    }

    if (!payload?.email || !payload?.sub || payload.email_verified !== true) {
      sendJson(res, 401, { errors: ['Google account email must be verified.'] });
      return;
    }

    const users = await readJson(USERS_FILE, []);
    const email = payload.email.toLowerCase();
    const now = new Date().toISOString();
    let user = users.find(item => item.googleId === payload.sub || item.email === email);

    if (user) {
      user.googleId = payload.sub;
      user.name = cleanString(payload.name) || user.name;
      user.picture = cleanString(payload.picture);
      user.updatedAt = now;
    } else {
      user = {
        id: `user_${Date.now()}`,
        name: cleanString(payload.name) || email.split('@')[0],
        email,
        googleId: payload.sub,
        picture: cleanString(payload.picture),
        passwordSalt: null,
        passwordHash: null,
        shareId: crypto.randomBytes(8).toString('hex'),
        savedSpots: [],
        createdAt: now,
        updatedAt: now
      };
      users.push(user);
    }

    await writeJson(USERS_FILE, users);
    createSession(res, { role: 'user', userId: user.id });
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/account/logout') {
    clearSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/account/me') {
    const session = getSession(req);
    if (!session || session.role !== 'user') {
      sendJson(res, 200, { authenticated: false, user: null });
      return;
    }

    const users = await readJson(USERS_FILE, []);
    const user = users.find(item => item.id === session.userId);
    sendJson(res, 200, { authenticated: Boolean(user), user: user ? publicUser(user) : null });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, { googleClientId: GOOGLE_CLIENT_ID });
    return;
  }

  const accountSpotMatch = url.pathname.match(/^\/api\/account\/spots\/(\d+)$/);
  if (accountSpotMatch) {
    const session = requireUser(req, res);
    if (!session) return;

    const users = await readJson(USERS_FILE, []);
    const user = users.find(item => item.id === session.userId);
    if (!user) {
      sendJson(res, 404, { errors: ['User not found.'] });
      return;
    }

    const spotId = Number(accountSpotMatch[1]);
    const happyHours = await readJson(HAPPY_HOURS_FILE, []);
    if (!happyHours.some(spot => spot.id === spotId)) {
      sendJson(res, 404, { errors: ['Spot not found.'] });
      return;
    }

    if (req.method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { errors: ['Invalid JSON body.'] });
        return;
      }

      const status = cleanString(body.status || 'favorite');
      if (!['favorite', 'want-to-try', 'been-to'].includes(status)) {
        sendJson(res, 422, { errors: ['Status must be favorite, want-to-try, or been-to.'] });
        return;
      }

      const note = cleanString(body.note).slice(0, 500);
      const now = new Date().toISOString();
      user.savedSpots = user.savedSpots || [];
      const existing = user.savedSpots.find(item => item.spotId === spotId);
      if (existing) {
        existing.status = status;
        existing.note = note;
        existing.updatedAt = now;
      } else {
        user.savedSpots.unshift({ spotId, status, note, createdAt: now, updatedAt: now });
      }
      user.updatedAt = now;
      await writeJson(USERS_FILE, users);
      sendJson(res, 200, publicUser(user));
      return;
    }

    if (req.method === 'DELETE') {
      user.savedSpots = (user.savedSpots || []).filter(item => item.spotId !== spotId);
      user.updatedAt = new Date().toISOString();
      await writeJson(USERS_FILE, users);
      sendJson(res, 200, publicUser(user));
      return;
    }

    sendJson(res, 405, { errors: ['Method not allowed.'] });
    return;
  }

  const shareMatch = url.pathname.match(/^\/api\/shared-lists\/([^/]+)$/);
  if (req.method === 'GET' && shareMatch) {
    const users = await readJson(USERS_FILE, []);
    const user = users.find(item => item.shareId === shareMatch[1]);
    if (!user) {
      sendJson(res, 404, { errors: ['Shared list not found.'] });
      return;
    }

    const happyHours = await readJson(HAPPY_HOURS_FILE, []);
    const spots = (user.savedSpots || []).map(saved => ({
      ...saved,
      spot: happyHours.find(spot => spot.id === saved.spotId) || null
    })).filter(item => item.spot);
    sendJson(res, 200, { name: user.name, shareId: user.shareId, spots });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/happy-hours') {
    const happyHours = await readJson(HAPPY_HOURS_FILE, []);
    sendJson(res, 200, happyHours);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/submissions') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { errors: ['Invalid JSON body.'] });
      return;
    }

    const { listing, contact, errors } = validateSubmission(body);
    if (errors.length) {
      sendJson(res, 422, { errors });
      return;
    }

    const submissions = await readJson(SUBMISSIONS_FILE, []);
    const now = new Date().toISOString();
    const submission = {
      id: `sub_${Date.now()}`,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      contact,
      listing
    };
    submissions.unshift(submission);
    await writeJson(SUBMISSIONS_FILE, submissions);
    sendJson(res, 201, { id: submission.id, status: submission.status });
    return;
  }

  if (url.pathname === '/api/admin/submissions') {
    if (!authorize(req, 'admin')) {
      sendJson(res, 401, { errors: ['Admin login required.'] });
      return;
    }
    if (req.method === 'GET') {
      const submissions = await readJson(SUBMISSIONS_FILE, []);
      sendJson(res, 200, submissions);
      return;
    }
  }

  const adminMatch = url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)$/);
  if (adminMatch) {
    if (!authorize(req, 'admin')) {
      sendJson(res, 401, { errors: ['Admin login required.'] });
      return;
    }
    if (req.method !== 'PATCH') {
      sendJson(res, 405, { errors: ['Method not allowed.'] });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { errors: ['Invalid JSON body.'] });
      return;
    }

    const submissions = await readJson(SUBMISSIONS_FILE, []);
    const index = submissions.findIndex(item => item.id === adminMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { errors: ['Submission not found.'] });
      return;
    }

    const submission = submissions[index];
    const now = new Date().toISOString();
    const action = cleanString(body.action);

    if (action === 'deny') {
      submission.status = 'denied';
      submission.denialReason = cleanString(body.denialReason);
      submission.updatedAt = now;
      await writeJson(SUBMISSIONS_FILE, submissions);
      sendJson(res, 200, submission);
      return;
    }

    if (action === 'edit' || action === 'approve') {
      const { listing, errors } = validateListing(body.listing || submission.listing, { requireCoordinates: action === 'approve' });
      if (errors.length) {
        sendJson(res, 422, { errors });
        return;
      }

      submission.listing = listing;
      submission.updatedAt = now;

      if (action === 'approve') {
        const happyHours = await readJson(HAPPY_HOURS_FILE, []);
        const nextId = happyHours.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
        const approvedListing = {
          id: nextId,
          ...listing,
          verified: true,
          lastVerifiedAt: now.slice(0, 10)
        };
        happyHours.push(approvedListing);
        submission.status = 'approved';
        submission.approvedListingId = nextId;
        await writeJson(HAPPY_HOURS_FILE, happyHours);
      }

      await writeJson(SUBMISSIONS_FILE, submissions);
      sendJson(res, 200, submission);
      return;
    }

    sendJson(res, 400, { errors: ['Action must be edit, approve, or deny.'] });
    return;
  }

  sendJson(res, 404, { errors: ['API route not found.'] });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { errors: ['Server error.'] });
  }
});

server.listen(PORT, () => {
  console.log(`\n  SD Happy Hours is live!\n`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Admin:   http://localhost:${PORT}/admin.html`);
  console.log(`   Login:   ${ADMIN_USERNAME} / ${ADMIN_PASSWORD === 'password' ? 'password' : 'set by ADMIN_PASSWORD'}`);
  console.log(`\n   Press Ctrl+C to stop\n`);
});
