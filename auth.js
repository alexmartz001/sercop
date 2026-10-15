'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Capa de autenticación y utilidades de seguridad para el Radar SERCOP.
//
// · Contraseñas con scrypt (sal aleatoria por usuario, comparación constante).
// · Sesiones estatales guardadas en SQLite; al cliente solo se le entrega el
//   token crudo (en la BD se guarda su SHA-256, nunca el valor utilizable).
// · Token CSRF por sesión (double-submit mediante cabecera X-CSRF-Token).
// · Limitador de peticiones (ventana deslizante) para login y API.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('node:crypto');

const SESSION_COOKIE = 'nvg_session';
const MIN_PASSWORD_LEN = 10;

// Parámetros de scrypt (memoria ≈ 128·N·r = 16 MiB). Se ejecuta en modo async
// para no bloquear el event loop durante un intento de login.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

function b64url(buf){
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(bytes = 32){
  return b64url(crypto.randomBytes(bytes));
}

function sha256Hex(value){
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function constantTimeEqual(a, b){
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if(ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function scryptAsync(password, saltHex, params = SCRYPT){
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      Buffer.from(saltHex, 'hex'),
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

async function hashPassword(password, params = SCRYPT){
  const saltHex = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, saltHex, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${saltHex}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored){
  try{
    const parts = String(stored || '').split('$');
    if(parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltHex = parts[4];
    const expected = Buffer.from(parts[5], 'hex');
    if(!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !expected.length) return false;
    const derived = await scryptAsync(password, saltHex, { N, r, p, keylen: expected.length, maxmem: SCRYPT.maxmem });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }catch(_){
    return false;
  }
}

// ── Esquema ─────────────────────────────────────────────────────────────────
function initSchema(db){
  db.exec(`CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    password_changed_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions(
    sid TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    csrf TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS login_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    ip TEXT,
    ok INTEGER,
    created_at TEXT DEFAULT (datetime('now')))`);
  // Estado de los limitadores de peticiones. Persistir aquí hace que el bloqueo
  // por fuerza bruta sobreviva a un reinicio del proceso (antes se perdía).
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limits(
    limiter TEXT NOT NULL,
    key TEXT NOT NULL,
    bucket TEXT NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY(limiter, key))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_rate_limits_updated ON rate_limits(updated_ms)');
  try{ db.prepare("DELETE FROM login_events WHERE created_at < datetime('now','-30 days')").run(); }catch(_){}
  try{ db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(); }catch(_){}
  try{ db.prepare('DELETE FROM rate_limits WHERE updated_ms < ?').run(Date.now() - 24 * 60 * 60 * 1000); }catch(_){}
}

// ── Usuarios ────────────────────────────────────────────────────────────────
function countUsers(db){
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return row ? Number(row.n) : 0;
}

function getUserByName(db, username){
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username)) || null;
}

function getUserById(db, id){
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}

async function createUser(db, username, password, role = 'admin'){
  const user = String(username || '').trim();
  if(!user) throw new Error('usuario requerido');
  if(String(password || '').length < MIN_PASSWORD_LEN) throw new Error(`la contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres`);
  const passHash = await hashPassword(password);
  db.prepare('INSERT INTO users(username, pass_hash, role) VALUES(?,?,?)').run(user, passHash, role);
  return getUserByName(db, user);
}

async function setPassword(db, userId, password){
  if(String(password || '').length < MIN_PASSWORD_LEN) throw new Error(`la contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres`);
  const passHash = await hashPassword(password);
  db.prepare("UPDATE users SET pass_hash=?, updated_at=datetime('now'), password_changed_at=datetime('now') WHERE id=?").run(passHash, Number(userId));
  // Invalida todas las sesiones previas del usuario salvo la que se recreará.
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(Number(userId));
}

// ── Sesiones ────────────────────────────────────────────────────────────────
function createSession(db, userId, { ip = '', userAgent = '', ttlMs = 12 * 60 * 60 * 1000 } = {}){
  const token = randomToken(32);
  const sid = sha256Hex(token);
  const csrf = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(`INSERT INTO sessions(sid, user_id, csrf, expires_at, ip, user_agent)
    VALUES(?,?,?,?,?,?)`).run(sid, Number(userId), csrf, expiresAt, String(ip || '').slice(0, 64), String(userAgent || '').slice(0, 256));
  return { token, csrf, expiresAt };
}

function getSession(db, rawToken){
  if(!rawToken || String(rawToken).length < 32) return null;
  const sid = sha256Hex(rawToken);
  const row = db.prepare(`SELECT s.sid, s.user_id, s.csrf, s.expires_at, s.last_seen,
      u.username, u.role, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.sid = ?`).get(sid);
  if(!row) return null;
  if(row.disabled) return null;
  if(new Date(row.expires_at).getTime() <= Date.now()) return null;
  try{ db.prepare("UPDATE sessions SET last_seen=datetime('now') WHERE sid=?").run(sid); }catch(_){}
  return { user: { id: row.user_id, username: row.username, role: row.role }, csrf: row.csrf, expiresAt: row.expires_at };
}

function deleteSession(db, rawToken){
  if(!rawToken) return;
  const sid = sha256Hex(rawToken);
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

function deleteUserSessions(db, userId){
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
}

function recordLoginEvent(db, username, ip, ok){
  try{
    db.prepare('INSERT INTO login_events(username, ip, ok) VALUES(?,?,?)').run(String(username || '').slice(0, 64), String(ip || '').slice(0, 64), ok ? 1 : 0);
  }catch(_){}
}

async function authenticate(db, username, password){
  const user = getUserByName(db, username);
  if(!user){
    // Igualamos el costo temporal para no revelar si el usuario existe.
    await hashPassword(String(password || ''));
    return null;
  }
  if(user.disabled) return null;
  const ok = await verifyPassword(password, user.pass_hash);
  return ok ? user : null;
}

// ── Cookies ─────────────────────────────────────────────────────────────────
function parseCookies(header){
  const out = Object.create(null);
  const raw = String(header || '');
  if(!raw) return out;
  for(const part of raw.split(';')){
    const idx = part.indexOf('=');
    if(idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if(!key) continue;
    let value = part.slice(idx + 1).trim();
    if(value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try{ out[key] = decodeURIComponent(value); }catch(_){ out[key] = value; }
  }
  return out;
}

function readCookie(req, name){
  return parseCookies(req.headers && req.headers.cookie)[name] || '';
}

function serializeCookie(name, value, { maxAge, path = '/', httpOnly = true, secure = false, sameSite = 'Strict' } = {}){
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if(httpOnly) parts.push('HttpOnly');
  if(secure) parts.push('Secure');
  if(maxAge !== undefined && maxAge !== null) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  return parts.join('; ');
}

// ── Limitador de peticiones (ventana deslizante) ────────────────────────────
// El estado vive en memoria para velocidad; si se le pasa un `store` (SQLite),
// además se persiste en cada cambio para que un reinicio no borre los bloqueos.
class RateLimitStore {
  constructor(db){
    this.db = db;
    this.sel = db.prepare('SELECT bucket FROM rate_limits WHERE limiter=? AND key=?');
    this.ups = db.prepare(`INSERT INTO rate_limits(limiter,key,bucket,updated_ms) VALUES(?,?,?,?)
      ON CONFLICT(limiter,key) DO UPDATE SET bucket=excluded.bucket, updated_ms=excluded.updated_ms`);
    this.del = db.prepare('DELETE FROM rate_limits WHERE limiter=? AND key=?');
  }
  get(limiter, key){
    try{ const r = this.sel.get(limiter, key); return r ? r.bucket : null; }catch(_){ return null; }
  }
  set(limiter, key, bucket){
    try{ this.ups.run(limiter, key, bucket, Date.now()); }catch(_){}
  }
  remove(limiter, key){
    try{ this.del.run(limiter, key); }catch(_){}
  }
}

class RateLimiter {
  constructor({ windowMs, max, blockMs, name = 'limiter', store = null }){
    this.windowMs = windowMs;
    this.max = max;
    this.blockMs = blockMs;
    this.name = name;
    this.store = store;
    this.buckets = new Map();
    this.lastSweep = Date.now();
  }
  sweep(now){
    if(now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const horizon = now - (this.windowMs + this.blockMs);
    for(const [key, bucket] of this.buckets){
      if(bucket.until < now && (!bucket.hits.length || bucket.hits[bucket.hits.length - 1] < horizon)){
        this.buckets.delete(key);
        if(this.store) this.store.remove(this.name, key);
      }
    }
  }
  readBucket(key){
    if(this.buckets.has(key)) return this.buckets.get(key);
    let bucket = null;
    if(this.store){
      const raw = this.store.get(this.name, key);
      if(raw){ try{ bucket = JSON.parse(raw); }catch(_){ bucket = null; } }
    }
    if(!bucket || typeof bucket !== 'object' || !Array.isArray(bucket.hits)) bucket = { hits: [], until: 0 };
    this.buckets.set(key, bucket);
    return bucket;
  }
  persist(key, bucket){
    if(this.store) this.store.set(this.name, key, JSON.stringify(bucket));
  }
  // Registra un intento. Devuelve {allowed, retryAfterMs}.
  hit(key){
    const now = Date.now();
    this.sweep(now);
    const bucket = this.readBucket(key);
    if(bucket.until > now) return { allowed: false, retryAfterMs: bucket.until - now };
    bucket.hits = bucket.hits.filter(t => now - t < this.windowMs);
    bucket.hits.push(now);
    if(bucket.hits.length > this.max){
      bucket.until = now + this.blockMs;
      bucket.hits = [];
      this.persist(key, bucket);
      return { allowed: false, retryAfterMs: this.blockMs };
    }
    this.persist(key, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }
  reset(key){
    this.buckets.delete(key);
    if(this.store) this.store.remove(this.name, key);
  }
}

module.exports = {
  SESSION_COOKIE,
  MIN_PASSWORD_LEN,
  SCRYPT,
  randomToken,
  sha256Hex,
  constantTimeEqual,
  hashPassword,
  verifyPassword,
  initSchema,
  countUsers,
  getUserByName,
  getUserById,
  createUser,
  setPassword,
  authenticate,
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  recordLoginEvent,
  parseCookies,
  readCookie,
  serializeCookie,
  RateLimiter,
  RateLimitStore
};
