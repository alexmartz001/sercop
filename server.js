const http = require('node:http');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const { createIntegrations } = require('./integrations');

const PORT = process.env.NVG_PORT || 3210;
const HOST = process.env.NVG_HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.NVG_TOKEN || '';
const DB_FILE = process.env.NVG_DB || path.join(__dirname, 'radar.db');

// -- Seguridad (config por entorno) ---------------------------------
// NVG_AUTH=off desactiva la autenticación por completo (solo para desarrollo).
const AUTH_ENABLED = String(process.env.NVG_AUTH || 'on').toLowerCase() !== 'off';
const AUTH_USER = process.env.NVG_AUTH_USER || 'admin';
const AUTH_PASS = process.env.NVG_AUTH_PASS || '';
const SESSION_TTL_HOURS = Math.max(1, Math.min(720, Number(process.env.NVG_SESSION_HOURS) || 12));
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const TRUST_PROXY = String(process.env.NVG_TRUST_PROXY || '1') !== '0';
const FORCE_SECURE_COOKIES = String(process.env.NVG_SECURE_COOKIES || '').toLowerCase() === '1';
const HSTS_ENABLED = String(process.env.NVG_HSTS || '1') !== '0';
// Restauración de la base completa (POST /api/db). Es una operación destructiva;
// pon NVG_ALLOW_RESTORE=0 en producción si no usas "Restaurar copia".
const ALLOW_RESTORE = String(process.env.NVG_ALLOW_RESTORE || '1') !== '0';
const MAX_JSON_BYTES = Math.max(64 * 1024, (Number(process.env.NVG_MAX_JSON_MB) || 4) * 1024 * 1024);
const MAX_UPLOAD_BYTES = Math.max(1024 * 1024, (Number(process.env.NVG_MAX_UPLOAD_MB) || 256) * 1024 * 1024);
const SESSION_COOKIE = auth.SESSION_COOKIE;

// Limitadores (ventana deslizante en memoria).
const API_RATE_MAX = Math.max(30, Number(process.env.NVG_RATE_LIMIT_PER_MIN) || 240);
let apiLimiter;
let loginIpLimiter;
let loginUserLimiter;
function initLimiters(){
  const store = (typeof db !== 'undefined' && db) ? new auth.RateLimitStore(db) : null;
  apiLimiter = new auth.RateLimiter({ windowMs: 60 * 1000, max: API_RATE_MAX, blockMs: 60 * 1000, name: 'api', store });
  loginIpLimiter = new auth.RateLimiter({ windowMs: 15 * 60 * 1000, max: 10, blockMs: 15 * 60 * 1000, name: 'login_ip', store });
  loginUserLimiter = new auth.RateLimiter({ windowMs: 15 * 60 * 1000, max: 5, blockMs: 15 * 60 * 1000, name: 'login_user', store });
}
const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.png':'image/png',
  '.ico':'image/x-icon',
  '.db':'application/x-sqlite3'
};
const SERCOP_API = 'https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/api';
const SERCOP_PUBLIC = 'https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/ocds';
const BID_API = 'https://data.iadb.org/api/action/datastore_search';
const BID_RESOURCE = 'dfa0c412-6570-4375-9ee1-267bdb39070e';
const UNDP_SEARCH_URL = 'https://procurement-notices.undp.org/search.cfm';
const UNDP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NVG/11 (+local radar)';
const NCO_BASE = 'https://www.compraspublicas.gob.ec/ProcesoContratacion/compras/NCO';
const NCO_LIST_URL = `${NCO_BASE}/NCORetornaRegistros.cpe?lot=1`;
const NCO_DETAIL_BASE = `${NCO_BASE}/NCORegistroDetalle.cpe`;
const PAGE_SIZE = 20;
const MAX_PAGES = 5;
const PAGE_DELAY = 1200;
const TERM_DELAY = 2000;
const MAX_RETRIES = 3;
const EXTERNAL_FETCH_DELAY = Number(process.env.NVG_FETCH_DELAY_MS) || 750;
const DETAIL_CONCURRENCY = 8;
const PLANNING_CONCURRENCY = 5;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MONITOR_INTERVAL = 5 * 60 * 1000;
let ExcelJS = null;

// -- Integraciones salientes (webhook + correo/recordatorios) -------
const integrations = createIntegrations({ env: process.env, log: console });
const sendMail = (...args) => integrations.sendMail(...args);
const sendWebhook = (...args) => integrations.sendWebhook(...args);
function mailStatus(){ return integrations.status(); }
const reminded = new Set();
function daysLabel(d){ if(d===0) return 'hoy'; if(d===1) return '1 día'; return `${d} días`; }
function sercopPublicUrl(ocid){ return `${SERCOP_PUBLIC}/${encodeURIComponent(ocid)}`; }
function buildAlertsHtml(rows){
  const items = rows.slice(0,50).map(r =>
    `<tr><td>${r.type === 'pac_matched' ? '<b>PAC ✓</b> ' : ''}${String(r.buyer).replace(/</g,'&lt;')}</td><td><a href="${sercopPublicUrl(r.ocid)}">${String(r.title).replace(/</g,'&lt;')}</a></td></tr>`).join('');
  return `<h3>Nuevos procesos detectados</h3><table border="1" cellpadding="6"><tr><th>Entidad</th><th>Proceso</th></tr>${items}</table>`;
}
async function sendClosingReminders(){
  const st = mailStatus();
  const rows = dbAll("SELECT ocid, entidad, titulo, cierre, valor FROM pipeline WHERE cierre IS NOT NULL AND cierre != ''");
  const today = new Date(); today.setHours(0,0,0,0);
  const due = [];
  for(const r of rows){
    const d = new Date(String(r.cierre).slice(0,10) + 'T00:00:00');
    if(isNaN(d.getTime())) continue;
    const days = Math.round((d - today) / 86400000);
    if(days < 0 || days > 3) continue;
    const key = `${r.ocid}|${d.toISOString().slice(0,10)}`;
    if(reminded.has(key)) continue;
    reminded.add(key);
    due.push({...r, days, date:d});
  }
  if(!due.length) return;
  const rowsHtml = due.map(r =>
    `<tr><td>${String(r.entidad||'').replace(/</g,'&lt;')}</td><td><a href="${sercopPublicUrl(r.ocid)}">${String(r.titulo||r.ocid).replace(/</g,'&lt;')}</a></td><td>${r.cierre}</td><td>${daysLabel(r.days)}</td></tr>`).join('');
  const html = `<h3>Recordatorios de cierre</h3><table border="1" cellpadding="6"><tr><th>Entidad</th><th>Proceso</th><th>Cierre</th><th>Quedan</th></tr>${rowsHtml}</table>`;
  const subject = `[NVG] ${due.length} ${due.length===1?'cierre pronto':'cierres próximos'}`;
  if(st.email) await sendMail(subject, html);
  // Webhook por cada recordatorio (Dynamics / Power Automate).
  for(const r of due){
    await sendWebhook('reminder', {
      ocid: r.ocid, entidad: r.entidad || '', titulo: r.titulo || r.ocid,
      cierre: r.cierre, dias: r.days, valor: r.valor || null,
      url: sercopPublicUrl(r.ocid), destinatarios: st.to
    });
    // Recordatorio de calendario en Outlook/M365 (opcional).
    if(st.calendar){
      const start = new Date(r.date); start.setHours(8, 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const iso = dt => dt.toISOString().slice(0, 19);
      await integrations.createCalendarReminder({
        subject: `[NVG] Cierre ${r.cierre}: ${String(r.titulo || r.ocid).slice(0, 120)}`,
        html: `<p>El proceso cierra en ${daysLabel(r.days)}.</p><p><a href="${sercopPublicUrl(r.ocid)}">Ver en SERCOP</a></p>`,
        startISO: iso(start), endISO: iso(end)
      });
    }
  }
}

let db;
function initDB(){
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS radares(
    id TEXT PRIMARY KEY, nombre TEXT, year INTEGER, search TEXT,
    buyer TEXT, supplier TEXT, source TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS procesos(
    ocid TEXT PRIMARY KEY, radar_ids TEXT, source TEXT, title TEXT,
    description TEXT, buyer_name TEXT, date TEXT, modalidad TEXT,
    raw_json TEXT, detail_json TEXT, detail_updated_at TEXT,
    first_seen_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS seen(ocid TEXT, radar_id TEXT, PRIMARY KEY(ocid, radar_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS dismissed(
    ocid TEXT, radar_id TEXT, reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(ocid, radar_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline(
    ocid TEXT PRIMARY KEY, status TEXT, notas TEXT, entidad TEXT,
    titulo TEXT, modalidad TEXT, etapa_label TEXT, valor TEXT,
    cierre TEXT, publicado TEXT, actualizado TEXT, cpcs TEXT,
    source TEXT, created_at TEXT DEFAULT (datetime('now')),
    etiquetas TEXT, fecha_presentacion TEXT, monto_oferta TEXT,
    competidores TEXT, contacto TEXT, snapshot TEXT, snapshot_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS api_cache(url TEXT PRIMARY KEY, response TEXT, fetched_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS alerts(
    id INTEGER PRIMARY KEY AUTOINCREMENT, radar_id TEXT, ocid TEXT, title TEXT,
    buyer_name TEXT, alert_type TEXT, created_at TEXT DEFAULT (datetime('now')),
    read INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS entity_follows(
    entity_name TEXT, entity_id TEXT, radar_ids TEXT, year INTEGER,
    PRIMARY KEY(entity_name, year))`);
  db.exec(`CREATE TABLE IF NOT EXISTS monitor_state(
    id TEXT PRIMARY KEY, last_run TEXT)`);
  try { db.exec("ALTER TABLE radares ADD COLUMN cpcs TEXT"); } catch(e){}
  try { db.exec("ALTER TABLE radares ADD COLUMN monitor INTEGER DEFAULT 0"); } catch(e){}
  try { db.exec("ALTER TABLE radares ADD COLUMN monitor_interval INTEGER DEFAULT 60"); } catch(e){}
  try { db.exec("ALTER TABLE pipeline ADD COLUMN etiquetas TEXT"); } catch(e){}
  try { db.exec("ALTER TABLE pipeline ADD COLUMN fecha_presentacion TEXT"); } catch(e){}
  try { db.exec("ALTER TABLE pipeline ADD COLUMN monto_oferta TEXT"); } catch(e){}
  try { db.exec("ALTER TABLE pipeline ADD COLUMN competidores TEXT"); } catch(e){}
  try { db.exec("ALTER TABLE pipeline ADD COLUMN contacto TEXT"); } catch(e){}
  try { db.exec("ALTER TABLE pipeline ADD COLUMN snapshot TEXT"); } catch(e){}
  try { db.exec("ALTER TABLE pipeline ADD COLUMN snapshot_at TEXT"); } catch(e){}
  db.exec(`CREATE TABLE IF NOT EXISTS entidades(
    entity_id TEXT PRIMARY KEY, name TEXT, source TEXT,
    updated_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS pac_plans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entidad_id TEXT, entidad TEXT, year INTEGER,
    partida TEXT, cpc TEXT, tipo_producto TEXT, tipo_regimen TEXT,
    tipo_presupuesto TEXT, fondo_bid TEXT, catalogo_electronico TEXT,
    procedimiento TEXT, descripcion TEXT, cantidad REAL, unidad TEXT,
    costo_unitario REAL, valor_total REAL, periodo TEXT,
    estado TEXT DEFAULT 'pendiente',
    ocid TEXT, notas TEXT, status TEXT, etiquetas TEXT, radar_ids TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(entidad_id, year, partida, cpc))`);
  console.log(`  Database: ${DB_FILE} (WAL mode)`);
  auth.initSchema(db);
  try{ initLimiters(); }catch(_){}
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function getExcelJS(){
  if(!ExcelJS) ExcelJS = require('exceljs');
  return ExcelJS;
}

function stripHtml(s){
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fixEncoding(s){
  if(typeof s !== 'string') return s;
  try {
    const bytes = Buffer.from(s, 'latin1');
    const decoded = bytes.toString('utf-8');
    if(decoded !== s && !decoded.includes('\uFFFD')) return decoded;
  } catch(_){}
  return s.replace(/\u00c3\u201a/g,'').replace(/\u00c2\u00b7/g,' · ').replace(/\u00e2\u20ac\u201d/g,'-').replace(/\u00e2\u0153\u201c/g,'OK');
}

function httpError(statusCode, message){
  const err = new Error(message || `HTTP ${statusCode}`);
  err.statusCode = statusCode;
  return err;
}

function collectBody(req, maxBytes = MAX_JSON_BYTES){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => { if(done) return; done = true; reject(err); };
    req.on('data', c => {
      if(done) return; // ignora el resto del cuerpo si ya se superó el tope
      size += c.length;
      if(size > maxBytes){ fail(httpError(413, 'carga demasiado grande')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if(done) return; done = true; resolve(Buffer.concat(chunks)); });
    req.on('error', fail);
    req.on('aborted', () => fail(httpError(400, 'conexión abortada')));
  });
}

// Descarga el cuerpo a un archivo con tope de tamaño (evita OOM en backups).
function collectBodyToFile(req, dest, maxBytes = MAX_UPLOAD_BYTES){
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    let size = 0;
    let done = false;
    const cleanup = () => { try{ fs.unlinkSync(dest); }catch(_){} };
    const fail = (err) => {
      if(done) return; done = true;
      try{ stream.destroy(); }catch(_){}
      cleanup();
      reject(err);
    };
    req.on('data', c => {
      if(done) return;
      size += c.length;
      if(size > maxBytes){ fail(httpError(413, 'archivo demasiado grande')); return; }
      if(!stream.write(c)){ try{ req.pause(); }catch(_){} }
    });
    stream.on('drain', () => { if(!done){ try{ req.resume(); }catch(_){} } });
    req.on('end', () => { if(done) return; stream.end(() => { if(done) return; done = true; resolve(size); }); });
    req.on('error', fail);
    req.on('aborted', () => fail(httpError(400, 'conexión abortada')));
    stream.on('error', fail);
  });
}

function parseUrl(req){
  const u = new URL(req.url, `http://localhost:${PORT}`);
  return { pathname: u.pathname, params: Object.fromEntries(u.searchParams) };
}

function json(res, code, data){
  const body = JSON.stringify(data);
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(body);
}

function allowedOrigin(origin){
  const o = typeof origin === 'string' ? origin.trim() : '';
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) ? o : '';
}

function cors(res, origin){
  const aOrigin = allowedOrigin(origin);
  if(aOrigin){ res.setHeader('Access-Control-Allow-Origin', aOrigin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Credentials','false');
}

// -- Cabeceras de seguridad e identificación de cliente --------------
function isSecureRequest(req){
  if(req.socket && req.socket.encrypted) return true;
  if(TRUST_PROXY){
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if(proto === 'https') return true;
  }
  return false;
}

function clientIp(req){
  if(TRUST_PROXY){
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if(xff) return xff.slice(0, 64);
  }
  return String((req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}

function applySecurityHeaders(req, res, nonce){
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Los scripts solo pueden ejecutarse desde el propio origen o con el nonce de
  // la petición (no se permite 'unsafe-inline' en script-src). Los estilos se
  // dejan con 'unsafe-inline' por los atributos style= dinámicos del frontend
  // (riesgo bajo: no permiten ejecutar código; ver AUDITORIA.md B4).
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '));
  if(HSTS_ENABLED && isSecureRequest(req)){
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function setSessionCookie(req, res, token, maxAgeMs){
  res.setHeader('Set-Cookie', auth.serializeCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor(maxAgeMs / 1000),
    httpOnly: true,
    secure: FORCE_SECURE_COOKIES || isSecureRequest(req),
    sameSite: 'Strict'
  }));
}

function clearSessionCookie(req, res){
  res.setHeader('Set-Cookie', auth.serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: FORCE_SECURE_COOKIES || isSecureRequest(req),
    sameSite: 'Strict'
  }));
}

// Comparación en tiempo constante del token heredado (NVG_TOKEN), si existe.
function tokenAuthorized(req, params){
  if(!AUTH_TOKEN) return false;
  const header = String(req.headers['authorization'] || '');
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : '';
  const fromQuery = String((params && params.token) || '');
  const provided = fromHeader || fromQuery;
  if(!provided || provided.length !== AUTH_TOKEN.length) return false;
  let diff = 0;
  for(let i = 0; i < AUTH_TOKEN.length; i++) diff |= AUTH_TOKEN.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Resuelve la identidad de la petición: sesión (cookie) o token heredado.
function authenticate(req, params){
  if(!AUTH_ENABLED) return {ok:true, via:'disabled', user:{username:'dev', role:'admin'}};
  if(tokenAuthorized(req, params)) return {ok:true, via:'token', user:{username:'token', role:'admin'}};
  const raw = auth.readCookie(req, SESSION_COOKIE);
  if(raw){
    const sess = auth.getSession(db, raw);
    if(sess) return {ok:true, via:'session', user:sess.user, csrf:sess.csrf};
  }
  return {ok:false};
}

// CSRF solo aplica a mutaciones autenticadas por cookie de sesión.
function csrfValid(req, authResult){
  if(authResult.via !== 'session') return true;
  if(SAFE_METHODS.has(req.method)) return true;
  const sent = String(req.headers['x-csrf-token'] || '');
  return !!sent && auth.constantTimeEqual(sent, authResult.csrf || '');
}

// Sirve un archivo estático. Para HTML inyecta el nonce de la petición en los
// bloques <script> (la CSP ya no permite 'unsafe-inline' en script-src).
function serveFile(res, fp, nonce){
  fs.readFile(fp, (err, data) => {
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp).toLowerCase();
    let body = data;
    if(nonce && ext === '.html'){
      const html = String(data);
      const injected = html.replace(/<script(?![^>]*\bnonce=)(?![^>]*\bsrc=)(\s*)>/g, `<script nonce="${nonce}"$1>`);
      body = Buffer.from(injected, 'utf8');
    }
    res.writeHead(200, {'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':'no-cache'});
    res.end(body);
  });
}

// -- DB Helpers ------------------------------------------------------
function dbAll(sql, params=[]){
  return db.prepare(sql).all(...params).map(r => ({...r}));
}

function dbGet(sql, params=[]){
  const row = db.prepare(sql).get(...params);
  return row ? {...row} : null;
}

function dbRun(sql, params=[]){
  return db.prepare(sql).run(...params);
}

// -- SERCOP API Client ----------------------------------------------
let fetchGate = Promise.resolve();
async function waitForExternalFetchSlot(){
  const slot = fetchGate.then(() => sleep(EXTERNAL_FETCH_DELAY));
  fetchGate = slot.catch(() => {});
  await slot;
}

async function fetchWithRetry(url, opts={}, retries=MAX_RETRIES){
  const okStatuses = Array.isArray(opts.okStatuses) ? opts.okStatuses : [];
  const fetchOpts = {...opts};
  delete fetchOpts.okStatuses;
  for(let attempt = 0; attempt <= retries; attempt++){
    await waitForExternalFetchSlot();
    const resp = await fetch(url, fetchOpts);
    if(resp.status === 429 && attempt < retries){
      const wait = Math.min(2000 * Math.pow(2, attempt), 15000) + Math.floor(Math.random() * 500);
      console.warn(`  429 rate limit, waiting ${wait}ms (attempt ${attempt+1}/${retries})`);
      await sleep(wait);
      continue;
    }
    if(okStatuses.includes(resp.status)) return resp;
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  }
}

function getCached(url){
  const row = dbGet("SELECT response, fetched_at FROM api_cache WHERE url = ?", [url]);
  if(!row) return null;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if(age < CACHE_TTL) return row.response;
  dbRun("DELETE FROM api_cache WHERE url = ?", [url]);
  return null;
}

function setCache(url, response){
  dbRun("INSERT OR REPLACE INTO api_cache(url, response, fetched_at) VALUES(?,?, datetime('now'))", [url, response]);
}

async function fetchCached(url, opts, force){
  if(!force){
    const cached = getCached(url);
    if(cached) return JSON.parse(cached);
  }
  const resp = await fetchWithRetry(url, opts);
  const text = await resp.text();
  setCache(url, text);
  return JSON.parse(text);
}

const normTxt = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const sourceOf = radar => String(radar?.source || 'sercop').toLowerCase();
const wantsSource = (radar, source) => {
  const src = sourceOf(radar);
  if(src === 'todas') return true;
  if(source === 'sercop') return src === 'sercop' || src === 'ambos';
  if(source === 'bid') return src === 'bid' || src === 'ambos';
  return src === source;
};
const SEARCH_STOP_WORDS = new Set(['con','del','desde','el','en','la','las','los','para','por','una','uno','y']);
const splitRadarTerms = value => String(value || '').split(',').map(t => t.trim()).filter(t => t.length >= 2);
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termTokens(term){
  return normTxt(term)
    .split(/[^a-z0-9]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !SEARCH_STOP_WORDS.has(t));
}

function textContainsTerm(text, term){
  const haystack = normTxt(text);
  const phrase = normTxt(term).trim().replace(/\s+/g, ' ');
  if(!phrase) return true;
  const phraseRe = new RegExp(`(^|[^a-z0-9])${escapeRe(phrase).replace(/\\ /g, '\\s+')}([^a-z0-9]|$)`);
  if(phraseRe.test(haystack)) return true;
  const tokens = termTokens(term);
  if(!tokens.length) return haystack.includes(phrase);
  return tokens.every(token => new RegExp(`(^|[^a-z0-9])${escapeRe(token)}([^a-z0-9]|$)`).test(haystack));
}

function rowSearchText(row){
  const detailItems = Array.isArray(row?._detail?.items) ? row._detail.items : [];
  const rowItems = Array.isArray(row?.items) ? row.items : [];
  const itemFields = [...rowItems, ...detailItems].flatMap(it => [
    it?.name, it?.description, it?.classification?.id,
    ...(Array.isArray(it?.additionalClassifications) ? it.additionalClassifications.map(c => c?.id) : [])
  ]);
  return [
    row?.title, row?.description,
    row?.buyerName, row?.buyer_name, row?.entidad,
    row?.buyer?.name, row?.buyer?.identifier?.legalName,
    row?.internal_type, row?.method, row?.modalidad,
    row?.procurementMethodDetails, row?.tender?.procurementMethod,
    ...itemFields
  ].filter(Boolean).join(' | ');
}

function termMatchesRow(row, term){
  return textContainsTerm(rowSearchText(row), term);
}

function ncoMatchesTerm(row, term){
  return textContainsTerm([row?.title, row?.modalidad, row?.internal_type].filter(Boolean).join(' | '), term);
}

function rowMatchesRadar(row, radar){
  if(!radar || !row) return true;
  const src = String(row?.source || 'SERCOP').toLowerCase();
  if(!wantsSource(radar, src)) return false;
  const terms = splitRadarTerms(radar.search);
  if(!terms.length) return true;
  return terms.some(term => src === 'nco' ? ncoMatchesTerm(row, term) : termMatchesRow(row, term));
}

async function fetchSERCOPAllPages(term, year, buyer, supplier, onProgress, force){
  let page = 1, pages = 1;
  const out = [];
  let lastData = null;
  do{
    const params = new URLSearchParams({year, search:term, page});
    if(buyer) params.set('buyer', buyer);
    if(supplier) params.set('supplier', supplier);
    lastData = await fetchCached(`${SERCOP_API}/search_ocds?${params.toString()}`, undefined, force);
    const rows = Array.isArray(lastData?.data) ? lastData.data : (Array.isArray(lastData) ? lastData : []);
    out.push(...rows);
    pages = Number(lastData?.pages || lastData?.total_pages || 1) || 1;
    if(onProgress) onProgress({type:'page', term, page, pages, count:out.length});
    page++;
    if(page <= pages && page <= MAX_PAGES) await sleep(PAGE_DELAY);
  } while(page <= pages && page <= MAX_PAGES);
  const relevant = out.filter(r => termMatchesRow(r, term));
  const seen = new Set();
  const deduped = relevant.filter(r => {
    const k = String(r?.ocid || JSON.stringify([r?.title, r?.buyer, r?.date]));
    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {out: deduped, truncated: pages > MAX_PAGES, totalAvailable: deduped.length};
}

async function fetchSERCOPByCPC(cpcCode, year, buyer, onProgress, force){
  let page = 1, pages = 1;
  const out = [];
  let lastData = null;
  do{
    const params = new URLSearchParams({year, search:cpcCode, page});
    if(buyer) params.set('buyer', buyer);
    lastData = await fetchCached(`${SERCOP_API}/search_ocds?${params.toString()}`, undefined, force);
    const rows = Array.isArray(lastData?.data) ? lastData.data : (Array.isArray(lastData) ? lastData : []);
    const filtered = rows.filter(row => {
      const items = Array.isArray(row?.items) ? row.items : [];
      return items.some(it => {
        const classId = it?.classification?.id || '';
        const addClass = Array.isArray(it?.additionalClassifications) ? it.additionalClassifications.map(c => c.id) : [];
        return classId === cpcCode || addClass.includes(cpcCode);
      });
    });
    out.push(...filtered);
    pages = Number(lastData?.pages || lastData?.total_pages || 1) || 1;
    if(onProgress) onProgress({type:'page', term:`CPC ${cpcCode}`, page, pages, count:out.length});
    page++;
    if(page <= pages && page <= MAX_PAGES) await sleep(PAGE_DELAY);
  } while(page <= pages && page <= MAX_PAGES);
  const realTotal = Number(lastData?.total || lastData?.count || 0) || 0;
  const seen = new Set();
  const deduped = out.filter(r => {
    const k = String(r?.ocid || JSON.stringify([r?.title, r?.buyer, r?.date]));
    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {out: deduped, truncated: pages > MAX_PAGES, totalAvailable: pages > MAX_PAGES ? (realTotal || pages * PAGE_SIZE) : deduped.length};
}

async function fetchBIDProjects(term, year){
  const params = {resource_id:BID_RESOURCE, limit:'100', q:term, filters:JSON.stringify({cntry_cd:'EC'})};
  const url = `${BID_API}?${new URLSearchParams(params)}`;
  const resp = await fetchWithRetry(url, {okStatuses:[409]});
  if(resp.status === 409){
    console.log(`  BID sin resultados compatibles para "${term}" (HTTP 409)`);
    return [];
  }
  const data = await resp.json();
  if(data?.success === false) throw new Error(data?.error?.message || `BID rejected "${term}"`);
  const records = Array.isArray(data?.result?.records) ? data.result.records : [];
  return records
    .filter(x => { if(!year) return true; const y = String(x?.apprvl_dt||'').slice(0,4); return !y || Number(y) <= Number(year); })
    .map(x => {
      const code = String(x.oper_num || x._id || ('BID-'+Math.random())).trim();
      const amount = Number(x.orig_apprvd_useq_amnt || x.totl_cost_orig || 0);
      const status = String(x.publc_sts_nm || x.sts_cd || 'Sin dato');
      const isActive = /implement|active|prepar/i.test(status);
      const projectUrl = `https://www.iadb.org/es/proyecto/${encodeURIComponent(code)}`;
      return {
        ocid: `BID-${code}`, source:'BID',
        date: String(x.apprvl_dt||'').slice(0,10),
        buyerName: `BID · ${String(x.cntry_nm||'Ecuador')}`,
        title: String(x.oper_nm || code),
        description: String(x.objtv||''),
        internal_type: String(x.opertyp_nm || x.modality_nm || 'Proyecto BID'),
        bidCode: code, externalUrl: projectUrl,
        _detail: {
          tags: isActive ? ['planning'] : ['contract'],
          modalidad: String(x.modality_nm || x.opertyp_nm || 'Proyecto BID'),
          value: amount ? {amount, currency:'USD'} : null,
          cpcs: [String(x.sector_cd||''), String(x.subsector_cd||'')].filter(Boolean),
          supplierNames: [], closeDate: null,
          publicationDate: String(x.apprvl_dt||'').slice(0,10),
          lastUpdateDate: String(x.apprvl_dt||'').slice(0,10),
          items: [],
          docs: [{url:projectUrl,title:'Ficha del proyecto'}],
          status, tendersCount:0, awardsCount:0,
          contractsCount:isActive?0:1, planningsCount:isActive?1:0,
          rawReleaseCount:isActive?1:1
      }
    };
  })
  .filter(row => termMatchesRow(row, term));
}

function ncoDetailUrl(row){
  const href = String(row?.url || '').match(/href=['"]?([^'">\s]+)/i)?.[1] || '';
  if(!href) return 'https://www.compraspublicas.gob.ec/ProcesoContratacion/compras/NCO/FrmNCOListado.cpe';
  return new URL(href.replace(/&amp;/g, '&'), NCO_DETAIL_BASE).toString();
}

function normalizeNCORow(row, term){
  const code = String(row?.codigo_contratacion || row?.tcom_necesidad_contratacion_id || '').trim();
  if(!code) return null;
  const title = fixEncoding(String(row?.objeto_contratacion || code).trim());
  const buyer = fixEncoding(String(row?.razon_social || stripHtml(row?.url) || '').trim());
  const closeDate = String(row?.fecha_limite_propuesta || '').trim();
  const publicationDate = String(row?.fecha_publicacion || '').trim();
  const contact = stripHtml(fixEncoding(row?.contacto || row?.funcionario_encargado || ''));
  const externalUrl = ncoDetailUrl(row);
  return {
    ocid: code,
    source: 'NCO',
    title,
    description: [
      row?.tipo_necesidad ? `Tipo: ${fixEncoding(row.tipo_necesidad)}` : '',
      row?.estado ? `Estado: ${fixEncoding(row.estado)}` : '',
      row?.provincia ? `Ubicación: ${fixEncoding(row.provincia)}` : '',
      contact ? `Contacto: ${contact}` : '',
      row?.direccion_entrega ? `Entrega: ${fixEncoding(row.direccion_entrega)}` : ''
    ].filter(Boolean).join(' · '),
    buyerName: buyer,
    buyer_name: buyer,
    date: publicationDate,
    modalidad: fixEncoding(String(row?.tipo_necesidad || 'Necesidad de contratación')),
    internal_type: fixEncoding(String(row?.tipo_necesidad || 'Necesidad de contratación')),
    externalUrl,
    term,
    _detail: {
      tags: ['planning'],
      modalidad: fixEncoding(String(row?.tipo_necesidad || 'Necesidad de contratación')),
      value: null,
      cpcs: [],
      supplierNames: [],
      publicationDate,
      lastUpdateDate: null,
      closeDate,
      docs: [{url: externalUrl, title: code}],
      items: [],
      status: fixEncoding(String(row?.estado || '')),
      tendersCount: 0,
      awardsCount: 0,
      contractsCount: 0,
      planningsCount: 1,
      rawReleaseCount: 1
    }
  };
}

async function fetchNCONeeds(term, year, buyer){
  const q = String(term || '').trim();
  if(q.length < 5) return {out: [], totalAvailable: 0, skipped: true};
  const body = new URLSearchParams({
    draw: '1',
    start: '0',
    length: '50',
    'search[value]': q,
    'search[regex]': 'false',
    'order[0][column]': '1',
    'order[0][dir]': 'desc'
  });
  [
    'tipo_necesidad','codigo_contratacion','fecha_publicacion','provincia','objeto_contratacion',
    'estado','fecha_limite_propuesta','url','direccion_entrega','contacto'
  ].forEach((name, i) => {
    body.set(`columns[${i}][data]`, name);
    body.set(`columns[${i}][searchable]`, 'true');
    body.set(`columns[${i}][orderable]`, i === 1 ? 'true' : 'false');
    body.set(`columns[${i}][search][value]`, '');
    body.set(`columns[${i}][search][regex]`, 'false');
  });
  body.set('columns[5][search][value]', '384');
  const resp = await fetchWithRetry(NCO_LIST_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
    body: body.toString()
  });
  const data = await resp.json();
  const now = new Date();
  const rows = Array.isArray(data?.data) ? data.data : [];
  const normalized = rows.map(r => normalizeNCORow(r, q)).filter(Boolean).filter(r => {
    if(year && !String(r.date || '').startsWith(String(year))) return false;
    if(buyer && !normTxt(r.buyerName).includes(normTxt(buyer))) return false;
    if(!ncoMatchesTerm(r, q)) return false;
    const close = new Date(String(r._detail.closeDate || '').replace(' ', 'T'));
    return Number.isNaN(close.getTime()) || close >= now;
  }).slice(0, 50);
  return {out: normalized, totalAvailable: Number(data?.iTotalDisplayRecords || normalized.length) || normalized.length};
}

// -- PAC Scraper (Plan Anual de Contrataciones) ---------------------
const PAC_BASE = 'https://www.compraspublicas.gob.ec/ProcesoContratacion/compras';
const PAC_FORM_URL = `${PAC_BASE}/PC/buscarPACe.cpe`;
const PAC_QUERY_URL = `${PAC_BASE}/exe/consultarPACe_exe.php`;
const PAC_ENTITY_URL = `${PAC_BASE}/PC/buscarEntidad.cpe?op=0`;

function decodeHtmlEntities(s){
  return s.replace(/&nbsp;/g,' ').replace(/&aacute;/g,'á').replace(/&eacute;/g,'é')
    .replace(/&iacute;/g,'í').replace(/&oacute;/g,'ó').replace(/&uacute;/g,'ú')
    .replace(/&ntilde;/g,'ñ').replace(/&Aacute;/g,'Á').replace(/&Eacute;/g,'É')
    .replace(/&Iacute;/g,'Í').replace(/&Oacute;/g,'Ó').replace(/&Uacute;/g,'Ú')
    .replace(/&Ntilde;/g,'Ñ').replace(/&#\d+;/g,'');
}

async function getPACSession(){
  const resp = await fetch(PAC_FORM_URL, {redirect:'follow'});
  const html = await resp.text();
  const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  const cookies = setCookies.map(c => c.split(';')[0]).join('; ');
  return {csrf: csrfMatch ? csrfMatch[1] : '', cookies};
}

async function searchPACEntities(query){
  const session = await getPACSession();
  const resp = await fetch(PAC_ENTITY_URL, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':session.cookies},
    body:`txtEmpresa=${encodeURIComponent(query)}`
  });
  const html = await resp.text();
  const pattern = /SetSelectedItem\((\d+),'([^']+)'/g;
  let m;
  const entities = new Map();
  while((m = pattern.exec(html)) !== null){
    const id = m[1];
    const name = fixEncoding(decodeHtmlEntities(m[2]));
    if(!entities.has(id)) entities.set(id, {id, name});
  }
  return [...entities.values()];
}

async function fetchPACItems(entityId, entityName, year){
  const session = await getPACSession();
  const body = new URLSearchParams({
    csrf_token: session.csrf,
    txtEntidadContratante: entityName,
    cmbEntidad: String(entityId),
    cmbAnio: '',
    cmbNombre: '',
    txtAnio: String(year),
    txtAdquisicionId: '',
    trx: ''
  });
  const resp = await fetch(PAC_QUERY_URL, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':session.cookies},
    body: body.toString()
  });
  const pacHtml = await resp.text();

  const totalMatch = pacHtml.match(/\$\s*([\d,]+\.\d{4})/);
  const totalValue = totalMatch ? totalMatch[1] : '0.00';

  const rowPattern = /<tr class=filaElemento2>([\s\S]*?)<\/tr>/g;
  let match;
  const items = [];

  while((match = rowPattern.exec(pacHtml)) !== null){
    const tdPattern = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tdMatch;
    const cells = [];
    while((tdMatch = tdPattern.exec(match[1])) !== null){
      cells.push(
        fixEncoding(
          decodeHtmlEntities(tdMatch[1].replace(/<br\s*\/?>/g,' ').replace(/<[^>]+>/g,''))
            .replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim()
        )
      );
    }
    if(cells.length >= 16 && /^\d{9}$/.test(cells[2])){
      const costoRaw = cells[13].replace(/,/g,'');
      const totalRaw = cells[14].replace(/,/g,'');
      items.push({
        partida: cells[0],
        presupuesto: cells[1].trim(),
        cpc: cells[2],
        tipoProducto: cells[3],
        tipoRegimen: cells[4],
        fondoBID: cells[5],
        tipoPresupuesto: cells[6],
        catElectronico: cells[8],
        procedimiento: cells[9],
        descripcion: cells[10],
        cantidad: cells[11],
        unidadMedida: cells[12],
        costoUnitario: parseFloat(costoRaw) || 0,
        valorTotal: parseFloat(totalRaw) || 0,
        periodo: cells[15]
      });
    }
  }

  return {items, totalBudget: totalValue, itemCount: items.length};
}

// -- PAC Cross-Reference --------------------------------------------
async function pacXRef(radarId, entityId, year, entityName){
  const radar = dbGet("SELECT * FROM radares WHERE id=?", [radarId]);
  if(!radar) return {error:'radar not found'};
  const procs = dbAll(
    "SELECT ocid, title, description, buyer_name, date, modalidad, raw_json FROM procesos WHERE ',' || radar_ids || ',' LIKE '%,' || ? || ',%'",
    [radarId]
  );
  const pacResult = entityId
    ? await fetchPACItems(String(entityId), entityName || radar.nombre || '', year)
    : {items: [], totalBudget:'0.00', itemCount:0};
  const pacItems = pacResult.items || [];
  const buyerNeedle = String(entityName || '').toLowerCase();
  const matches = [];
  const unmatched = [];
  for(const pac of pacItems){
    let found = false;
    for(const proc of procs){
      const det = getDetail(proc.ocid) || {};
      if(!(det.cpcs||[]).map(String).includes(String(pac.cpc))) continue;
      if(buyerNeedle && !String(proc.buyer_name||'').toLowerCase().includes(buyerNeedle)) continue;
      found = true;
      matches.push({
        cpc: pac.cpc,
        pacDescription: pac.descripcion,
        pacValor: pac.valorTotal,
        ocid: proc.ocid,
        secopTitle: proc.title || proc.ocid,
        secopUrl: sercopPublicUrl(proc.ocid)
      });
      break;
    }
    if(!found){
      unmatched.push({cpc: pac.cpc, descripcion: pac.descripcion, partida: pac.partida, valorTotal: pac.valorTotal});
    }
  }
  return {totalPac: pacItems.length, matched: matches.length, totalBudget: pacResult.totalBudget, items: pacItems, matches, unmatched, processCount: procs.length};
}

// -- UNDP / PNUD Ecuador (scraping de avisos públicos sin API key) --
function parseUNDPDate(dayMonYear){
  if(!dayMonYear) return null;
  const m = String(dayMonYear).trim().match(/^(\d{1,2})-([A-Za-z\u00C0-\u024F]{3})[.-]?/);
  if(!m) return null;
  const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const mo = months[String(m[2]).toLowerCase().slice(0,3)];
  if(!mo) return null;
  const year = 2000 + (Number(String(dayMonYear).match(/(\d{2})$/)?.[1] || 0) || 0);
  const d = new Date(Date.UTC(year, mo-1, Number(m[1])));
  if(Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}

function decodeUNDPHtml(s){
  if(typeof s !== 'string') return '';
  return s.replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
}

async function fetchUNDPNotices(term, year){
  const tYear = Number(year) || new Date().getFullYear();
  const body = new URLSearchParams({
    date_from1: `${tYear}-01-01`,
    date_to1: `${tYear}-12-31`,
    cur_title: term || '',
    cur_notice_id: '',
    cur_agency: 'Ecuador',
    cur_sm_id: ''
  }).toString();
  let html = '';
  for(let attempt = 0; attempt <= MAX_RETRIES; attempt++){
    try{
      const resp = await fetch(UNDP_SEARCH_URL, {
        method:'POST',
        headers:{
          'Content-Type':'application/x-www-form-urlencoded',
          'User-Agent': UNDP_USER_AGENT,
          'Referer': UNDP_SEARCH_URL
        },
        body
      });
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      html = await resp.text();
      break;
    }catch(e){
      if(attempt === MAX_RETRIES) throw e;
      await sleep(1200 * Math.pow(2, attempt));
    }
  }
  const blocks = [];
  const rowRe = /<a\s+href="view_negotiation\.cfm\?nego_id=(\d+)"\s+class="vacanciesTableLink vacanciesTable__row">([\s\S]*?)<\/a>/g;
  let m;
  while((m = rowRe.exec(html)) !== null) blocks.push({negoId: m[1], inner: m[2]});
  const rows = [];
  for(const block of blocks){
    const cellLabel = /<div class="vacanciesTable__cell__label">\s*([^<]+?)\s*<\/div>\s*<span>(?:<nobr>)?([\s\S]*?)(?:<\/nobr>)?<\/span>/g;
    const cells = {};
    let cm;
    while((cm = cellLabel.exec(block.inner)) !== null){
      cells[decodeUNDPHtml(cm[1]).toLowerCase()] = decodeUNDPHtml(cm[2]);
    }
    const title = cells['title'] || cells['procurement process'] || '';
    const refNo = cells['ref no'] || String(block.negoId);
    const process = cells['procurement process'] || cells['process'] || '—';
    const posted = parseUNDPDate(cells['posted']);
    const deadline = parseUNDPDate(cells['deadline']);
    if(!title) continue;
    const noticeUrl = `https://procurement-notices.undp.org/view_negotiation.cfm?nego_id=${block.negoId}`;
    rows.push({
      ocid: `UNDP-${refNo || block.negoId}`,
      source: 'UNDP',
      title: fixEncoding(title),
      description: fixEncoding(title),
      date: posted || '',
      internal_type: process,
      buyerName: 'PNUD Ecuador (UNDP-ECU)',
      externalUrl: noticeUrl,
      negoId: block.negoId,
      _detail: {
        tags: ['tender'],
        modalidad: process,
        value: null,
        cpcs: [],
        supplierNames: [],
        closeDate: deadline,
        publicationDate: posted,
        lastUpdateDate: posted,
        items: [],
        docs: [{url: noticeUrl, title: title.slice(0, 120)}],
        status: 'active',
        tendersCount: 1, awardsCount: 0, contractsCount: 0, planningsCount: 0, rawReleaseCount: 1
      }
    });
  }
  return rows
    .filter(r => /ECU/i.test(r.ocid) || /ECUADOR/i.test(r.title))
    .filter(r => termMatchesRow(r, term));
}

// -- Enriquecimiento F6: título/entidad reales en búsquedas SERCOP --
function rememberEntity(entityId, name){
  if(!entityId || !name) return;
  const clean = fixEncoding(String(name)).replace(/[\u0000-\u001f\u007f]/g,'').trim();
  if(!clean) return;
  dbRun("INSERT OR REPLACE INTO entidades(entity_id, name) VALUES(?,?)", [String(entityId), clean]);
}

function needBuyerFix(label){
  const s = String(label || '').replace(/[\u0000-\u001f\u007f]/g,'').trim();
  if(!s || s === '—') return true;
  return false;
}

async function entityNameById(entityId){
  entityId = String(entityId || '').trim();
  if(!entityId) return '';
  const cached = dbGet("SELECT name FROM entidades WHERE entity_id=?", [entityId]);
  if(cached) return cached.name;
  try{
    const found = await searchPACEntities(entityId);
    let hit = found.find(e => String(e.id) === entityId && e.name) || found[0];
    if(!hit) hit = null;
    if(hit){
      rememberEntity(entityId, hit.name);
      return hit.name;
    }
  }catch(_){}
  return '';
}

// -- Planificador PAC/POA (anticipación de compras) -----------------
function cpcsOfProcess(pr){
  const set = new Set();
  try{
    const det = pr.detail_json ? JSON.parse(pr.detail_json) : null;
    if(det && Array.isArray(det.cpcs)) det.cpcs.forEach(c => set.add(String(c)));
  }catch(_){}
  try{
    const raw = pr.raw_json ? JSON.parse(pr.raw_json) : null;
    const items = Array.isArray(raw?.items) ? raw.items : [];
    for(const it of items){
      if(it?.classification?.id) set.add(String(it.classification.id));
      if(Array.isArray(it?.additionalClassifications)) for(const c of it.additionalClassifications) if(c?.id) set.add(String(c.id));
    }
    if(raw?.buyer?.identifier?.id) pr.__buyerId = raw.buyer.identifier.id;
  }catch(_){}
  return [...set];
}

function normName(s){
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}

function entidadLike(planEntidad, buyerName){
  const p = normName(planEntidad);
  const b = normName(buyerName);
  if(!p || !b) return false;
  if(p.length >= 8 && b.includes(p)) return true;
  if(b.length >= 8 && p.includes(b)) return true;
  const pw = new Set(p.split(' ').filter(w => w.length >= 8));
  if(!pw.size) return false;
  for(const w of pw) if(b.includes(w)) return true;
  return false;
}

function findPlanMatches(item){
  const cpc = String(item.cpc || '');
  const out = [];
  if(!cpc) return out;
  const rows = dbAll("SELECT ocid, title, buyer_name, date, detail_json, raw_json FROM procesos");
  const eager = dbAll("SELECT entity_id, name, radar_ids FROM entity_follows");
  for(const pr of rows){
    const cpcs = cpcsOfProcess(pr);
    if(!cpcs.includes(cpc)) continue;
    const buyerId = pr.__buyerId || null;
    let buyerName = String(pr.buyer_name || '');
    if(buyerId){
      const known = dbGet("SELECT name FROM entidades WHERE entity_id=?", [String(buyerId)]);
      if(known?.name) buyerName = known.name;
    }
    const coincidesEntidad = (buyerId && String(item.entidad_id) === String(buyerId)) || entidadLike(item.entidad, buyerName);
    if(!coincidesEntidad) continue;
    let det = null;
    try{ det = pr.detail_json ? JSON.parse(pr.detail_json) : null; }catch(_){}
    const tags = det?.tags || [];
    const estado = (tags.includes('contract') || tags.includes('award')) ? 'adjudicado' : 'publicado';
    out.push({
      ocid: pr.ocid,
      titulo: pr.title || pr.ocid,
      buyerName,
      url: sercopPublicUrl(pr.ocid),
      valor: det?.value?.amount || null,
      tags,
      estado
    });
    if(out.length >= 1) break;
  }
  return out;
}

function marketCpcMap(){
  const map = new Map();
  const rows = dbAll("SELECT ocid, title, buyer_name, date, detail_json FROM procesos");
  for(const r of rows){
    if(!r.detail_json) continue;
    let d;
    try{ d = JSON.parse(r.detail_json); }catch(_){ continue; }
    (d.cpcs||[]).map(String).forEach(c => {
      const cell = map.get(c) || {cpc:c, procesos:0, valor:0, min:Infinity, max:0, adjudicado:0};
      const valor = Number(d.value?.amount) || 0;
      cell.procesos++;
      cell.valor += valor;
      if(valor > 0){ cell.min = Math.min(cell.min, valor); cell.max = Math.max(cell.max, valor); }
      if(Array.isArray(d.supplierNames) && d.supplierNames.length) cell.adjudicado++;
      map.set(c, cell);
    });
  }
  return map;
}

function getPlanRows(filters = {}){
  const cpc = String(filters.cpc || '').trim();
  const entidad = String(filters.entidad || '').trim().toLowerCase();
  const texto = String(filters.texto || '').trim().toLowerCase();
  const year = String(filters.year || '').trim();
  const estado = String(filters.estado || '').trim();
  let sql = "SELECT * FROM pac_plans WHERE 1=1";
  const args = [];
  if(cpc){ sql += " AND cpc LIKE ?"; args.push(`%${cpc}%`); }
  if(entidad){ sql += " AND lower(entidad) LIKE ?"; args.push(`%${entidad}%`); }
  if(texto){ sql += " AND lower(descripcion || ' ' || cpc || ' ' || partida || ' ' || procedimiento || ' ' || entidad) LIKE ?"; args.push(`%${texto}%`); }
  if(year){ sql += " AND year=?"; args.push(Number(year)); }
  if(estado){ sql += " AND estado=?"; args.push(estado); }
  sql += " ORDER BY year DESC, valor_total DESC";
  const rows = dbAll(sql, args);
  const cpcs = marketCpcMap();
  return rows.map(r => {
    const item = {...r};
    try{ item.etiquetas = r.etiquetas ? JSON.parse(r.etiquetas) : []; }catch(_){ item.etiquetas = []; }
    const m = cpcs.get(String(item.cpc));
    item.mercado = m ? {procesos:m.procesos, promedio:m.procesos ? Math.round(m.valor/m.procesos*100)/100 : 0, min:Number.isFinite(m.min)?m.min:null, max:m.max, valor:m.valor} : null;
    const matched = findPlanMatches(item);
    if(!matched.length && item.estado === 'pendiente'){
      // nada publicado aún
    }
    if(matched.length){
      const best = matched[0];
      item.estado = best.estado;
      item.ocid = best.ocid;
      item.process = best;
    }
    item.coincidencias = matched.length;
    return item;
  });
}

function savePlanFromEntity(entityId, entityName, year, radarIds){
  return new Promise(async (resolve, reject) => {
    try{
      const result = await fetchPACItems(String(entityId), entityName || '', Number(year) || new Date().getFullYear());
      const rIds = Array.isArray(radarIds) ? radarIds.map(String).filter(Boolean).join(',') : '';
      let saved = 0;
      const stmt = db.prepare(`INSERT OR IGNORE INTO pac_plans(
        entidad_id, entidad, year, partida, cpc, tipo_producto, tipo_regimen,
        tipo_presupuesto, fondo_bid, catalogo_electronico, procedimiento, descripcion,
        cantidad, unidad, costo_unitario, valor_total, periodo, radar_ids)
        VALUES(@entidad_id,@entidad,@year,@partida,@cpc,@tipoProducto,@tipoRegimen,
        @tipoPresupuesto,@fondoBID,@catElectronico,@procedimiento,@descripcion,
        @cantidad,@unidadMedida,@costoUnitario,@valorTotal,@periodo,@rIds)`);
      for(const it of (result.items || [])){
        rememberEntity(entityId, entityName);
        const run = stmt.run({
          entidad_id:String(entityId), entidad:entityName, year:Number(year)||new Date().getFullYear(),
          partida:String(it.partida||''), cpc:String(it.cpc||''),
          tipoProducto:String(it.tipoProducto||''), tipoRegimen:String(it.tipoRegimen||''),
          tipoPresupuesto:String(it.tipoPresupuesto||''), fondoBID:String(it.fondoBID||''),
          catElectronico:String(it.catElectronico||''), procedimiento:String(it.procedimiento||''),
          descripcion:String(it.descripcion||''),
          cantidad:Number(it.cantidad)||0, unidadMedida:String(it.unidadMedida||''),
          costoUnitario:Number(it.costoUnitario)||0, valorTotal:Number(it.valorTotal)||0,
          periodo:String(it.periodo||''), rIds
        });
        if(run.changes) saved++;
      }
      resolve({saved, total: (result.items||[]).length, totalBudget: result.totalBudget, entityId:String(entityId), entityName, year:Number(year)||new Date().getFullYear()});
    }catch(e){ reject(e); }
  });
}

function updatePlanItem(id, patch){
  const sets = [], args = [];
  const fields = {estado:'estado', notas:'notas', status:'status', ocid:'ocid'};
  for(const k of Object.keys(fields)){
    if(patch[k] !== undefined){ sets.push(`${fields[k]}=?`); args.push(patch[k]); }
  }
  if(patch.etiquetas !== undefined){
    sets.push('etiquetas=?'); args.push(JSON.stringify(Array.isArray(patch.etiquetas) ? patch.etiquetas : []));
  }
  sets.push('updated_at=datetime(\'now\')');
  args.push(id);
  if(sets.length) dbRun(`UPDATE pac_plans SET ${sets.join(', ')} WHERE id=?`, args);
  return dbGet("SELECT * FROM pac_plans WHERE id=?", [id]);
}

function rowCpcs(row){
  const set = new Set();
  const items = Array.isArray(row?.items) ? row.items : [];
  for(const it of items){
    if(it?.classification?.id) set.add(String(it.classification.id));
    if(Array.isArray(it?.additionalClassifications)) for(const c of it.additionalClassifications) if(c?.id) set.add(String(c.id));
  }
  return [...set];
}

function planMatchesRow(radarId, row){
  const rowCpcs_ = rowCpcs(row);
  const items = dbAll("SELECT * FROM pac_plans WHERE radar_ids LIKE ?", [`%${radarId}%`]);
  for(const p of items){
    if(!rowCpcs_.includes(String(p.cpc))) continue;
    const buyer = fixEncoding(getBuyerLabel(row));
    if(entidadLike(p.entidad, buyer)) return p;
  }
  return null;
}

// -- Batch Detail Fetch ---------------------------------------------
async function fetchDetailBatch(ocids){
  const results = {};
  for(let i = 0; i < ocids.length; i += DETAIL_CONCURRENCY){
    const chunk = ocids.slice(i, i + DETAIL_CONCURRENCY);
    const batch = await Promise.all(chunk.map(async ocid => {
      try {
        const det = await fetchDetail(ocid);
        return {ocid, detail:det};
      } catch(e){
        return {ocid, error:e.message};
      }
    }));
    for(const r of batch){ results[r.ocid] = r.detail || null; if(r.detail) saveDetail(r.ocid, r.detail); }
  }
  return results;
}

// -- Alerts ---------------------------------------------------------
function getAlerts(radarId, unreadOnly){
  let sql = "SELECT id, radar_id, ocid, title, buyer_name, alert_type, created_at, read FROM alerts";
  const args = [];
  if(radarId){ sql += " WHERE radar_id=?"; args.push(radarId); }
  if(unreadOnly){ sql += (radarId ? " AND" : " WHERE") + " read=0"; }
  sql += " ORDER BY created_at DESC LIMIT 200";
  return dbAll(sql, args);
}

function markAlertsRead(radarId){
  dbRun("UPDATE alerts SET read=1 WHERE radar_id=? AND read=0", [radarId]);
}

// -- Entity Follow --------------------------------------------------
function listEntityFollows(){
  return dbAll("SELECT entity_name, entity_id, radar_ids, year FROM entity_follows ORDER BY entity_name");
}

function followEntity(entityName, entityId, radarIds, year){
  dbRun("INSERT OR REPLACE INTO entity_follows(entity_name, entity_id, radar_ids, year) VALUES(?,?,?,?)",
    [entityName, entityId||'', radarIds||'', year||new Date().getFullYear()]);
}

function unfollowEntity(entityName){
  dbRun("DELETE FROM entity_follows WHERE entity_name=?", [entityName]);
}

// -- Background Monitor ---------------------------------------------
async function runMonitor(){
  const radars = dbAll("SELECT * FROM radares WHERE monitor=1");
  const newAlertRows = [];
  for(const radar of radars){
    const interval = Math.max(5, Number(radar.monitor_interval)||60) * 60 * 1000;
    const state = dbGet("SELECT last_run FROM monitor_state WHERE id=?", [radar.id]);
    const last = state ? new Date(state.last_run).getTime() : 0;
    if(Date.now() - last < interval){
      console.log(`  [Monitor] ${radar.nombre}: dentro de su intervalo (${Math.round(interval/60000)} min), saltado`);
      continue;
    }
    console.log(`  [Monitor] Running: ${radar.nombre}`);
    const terms = splitRadarTerms(radar.search);
    const cpcCodes = splitRadarTerms(radar.cpcs);
    const seenSet = new Set(getSeen(radar.id));
    const allResults = new Map();
    for(const term of terms){
      if(wantsSource(radar, 'undp')){
        try {
          const rows = await fetchUNDPNotices(term, radar.year);
          for(const raw of rows){
            const row = normalizeSearchRow(raw, term);
            if(row && !allResults.has(row.ocid)) allResults.set(row.ocid, row);
          }
        } catch(e){ console.error(`  [Monitor] UNDP error (${term}):`, e.message); }
      }
      if(wantsSource(radar, 'nco')){
        try {
          const {out} = await fetchNCONeeds(term, radar.year, radar.buyer);
          for(const row of out) if(row && !allResults.has(row.ocid)) allResults.set(row.ocid, row);
        } catch(e){ console.error(`  [Monitor] NCO error (${term}):`, e.message); }
      }
      if(wantsSource(radar, 'sercop')){
        try {
          const {out} = await fetchSERCOPAllPages(term, radar.year, radar.buyer, radar.supplier, null, true);
          for(const raw of out){
            const row = normalizeSearchRow(raw, term);
            if(row && !allResults.has(row.ocid)) allResults.set(row.ocid, row);
          }
        } catch(e){ console.error(`  [Monitor] SERCOP error (${term}):`, e.message); }
      }
      if(wantsSource(radar, 'bid')){
        try {
          const rows = await fetchBIDProjects(term, radar.year);
          for(const row of rows) if(row?.ocid && !allResults.has(row.ocid)) allResults.set(row.ocid, row);
        } catch(e){ console.error(`  [Monitor] BID error (${term}):`, e.message); }
      }
      await sleep(TERM_DELAY);
    }
    for(const cpc of cpcCodes){
      if(!wantsSource(radar, 'sercop')) continue;
      try {
        const {out} = await fetchSERCOPByCPC(cpc, radar.year, radar.buyer, null, true);
        for(const raw of out){
          const row = normalizeSearchRow(raw, `CPC ${cpc}`);
          if(row && !allResults.has(row.ocid)) allResults.set(row.ocid, row);
        }
      } catch(e){ console.error(`  [Monitor] CPC error (${cpc}):`, e.message); }
      await sleep(TERM_DELAY);
    }
    for(const [ocid, row] of allResults){
      if(!seenSet.has(ocid)){
        saveProcess(row, radar.id);
        if(row?._detail) saveDetail(ocid, row._detail);
        markSeen(radar.id, [ocid]);
        const planItem = planMatchesRow(radar.id, row);
        const alertType = planItem ? 'pac_matched' : 'new_result';
        const title = planItem ? `PAC OK ${planItem.descripcion || planItem.partida}` : getRowTitle(row);
        dbRun("INSERT INTO alerts(radar_id, ocid, title, buyer_name, alert_type) VALUES(?,?,?,?,?)",
          [radar.id, ocid, title, getBuyerLabel(row), alertType]);
        if(planItem){
          dbRun("UPDATE pac_plans SET estado='publicado', ocid=?, updated_at=datetime('now') WHERE id=? AND estado='pendiente'", [ocid, planItem.id]);
        }
        console.log(`  [Monitor] New alert: ${ocid} - ${title}`);
        newAlertRows.push({radar:radar.nombre, ocid, title, buyer:getBuyerLabel(row), type:alertType});
      }
    }
    dbRun("INSERT OR REPLACE INTO monitor_state(id, last_run) VALUES(?, datetime('now'))", [radar.id]);
  }
  if(newAlertRows.length){
    const st = mailStatus();
    if(st.email) await sendMail(`[NVG] ${newAlertRows.length} nuevos procesos`, buildAlertsHtml(newAlertRows));
    for(const a of newAlertRows){
      await sendWebhook('alert', {
        radar: a.radar, ocid: a.ocid, titulo: a.title, entidad: a.buyer,
        tipo: a.type, url: sercopPublicUrl(a.ocid), destinatarios: st.to
      });
    }
  }
  try{ await detectPipelineChanges(false); }
  catch(e){ console.error('[Monitor] change detection error:', e.message); }
  await sendClosingReminders();
}


let monitorTimer = null;
function startMonitor(){
  if(monitorTimer) return;
  monitorTimer = setInterval(async () => {
    try { await runMonitor(); }
    catch(e){ console.error('[Monitor] Error:', e.message); }
  }, MONITOR_INTERVAL);
  console.log(`  Monitor started (interval: ${MONITOR_INTERVAL/1000}s)`);
}

// -- OCDS Record Parsing (server-side) ------------------------------
function firstNonEmpty(...vals){ return vals.find(v => v !== undefined && v !== null && String(v).trim() !== ''); }
function validDateValue(v){ if(!v) return null; const d=new Date(v); return Number.isNaN(d.getTime())?null:{raw:String(v),time:d.getTime()}; }
function earliestDate(values){ return values.map(validDateValue).filter(Boolean).sort((a,b)=>a.time-b.time)[0]?.raw||null; }
function latestDate(values){ return values.map(validDateValue).filter(Boolean).sort((a,b)=>b.time-a.time)[0]?.raw||null; }

function collectReleases(payload){
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const releases = [];
  records.forEach(r => { if(r?.compiledRelease) releases.push(r.compiledRelease); if(Array.isArray(r?.releases)) releases.push(...r.releases); });
  if(payload?.compiledRelease) releases.push(payload.compiledRelease);
  if(Array.isArray(payload?.releases)) releases.push(...payload.releases);
  if(payload?.ocid && (payload?.tender || payload?.planning || payload?.awards)) releases.push(payload);
  return releases.filter(Boolean);
}

function mergeDetail(payload){
  const releases = collectReleases(payload);
  const tenders = releases.map(r=>r.tender).filter(Boolean);
  const plannings = releases.map(r=>r.planning).filter(Boolean);
  const awards = releases.flatMap(r => Array.isArray(r.awards)?r.awards:(r.award?[r.award]:[]));
  const contracts = releases.flatMap(r => Array.isArray(r.contracts)?r.contracts:(r.contract?[r.contract]:[]));
  const tags = [...new Set(releases.flatMap(r => Array.isArray(r.tag)?r.tag:[]))];
  const latestTender = tenders[tenders.length-1] || {};
  const allItems = tenders.flatMap(t=>Array.isArray(t.items)?t.items:[]).concat(plannings.flatMap(p=>Array.isArray(p.items)?p.items:[]));
  const allDocs = releases.flatMap(r=>Array.isArray(r.documents)?r.documents:[]).concat(tenders.flatMap(t=>Array.isArray(t.documents)?t.documents:[])).concat(plannings.flatMap(p=>Array.isArray(p.documents)?p.documents:[])).concat(awards.flatMap(a=>Array.isArray(a.documents)?a.documents:[])).concat(contracts.flatMap(c=>Array.isArray(c.documents)?c.documents:[]));
  const modality = firstNonEmpty(...tenders.slice().reverse().flatMap(t=>[t.procurementMethodDetails,t.procurementMethod]), '—');
  const values = [...tenders.slice().reverse().map(t=>t.value), ...plannings.slice().reverse().map(p=>p.budget?.amount||p.budget), ...awards.slice().reverse().map(a=>a.value), ...contracts.slice().reverse().map(c=>c.value)].filter(v=>v&&(v.amount!==undefined||typeof v==='number'));
  const rawValue = values[0] || null;
  const value = typeof rawValue==='number'?{amount:rawValue,currency:'USD'}:rawValue;
  const cpcs = [...new Set(allItems.flatMap(it=>[it?.classification?.id, ...(Array.isArray(it?.additionalClassifications)?it.additionalClassifications.map(c=>c.id):[])]).filter(Boolean).map(String))];
  const supplierNames = [...new Set(awards.flatMap(a=>(a.suppliers||[]).map(s=>firstNonEmpty(s.name,s.identifier?.legalName,s.identifier?.id))).filter(Boolean))];
  const releaseDates = releases.flatMap(r=>[r.datePublished,r.publishedDate,r.releaseDate,r.date]);
  const tenderPublishDates = tenders.flatMap(t=>[t.datePublished,t.tenderPeriod?.startDate]);
  const publicationDate = earliestDate([...releaseDates,...tenderPublishDates]);
  const lastUpdateDate = latestDate([...releaseDates,...tenderPublishDates]);
  const closeDate = latestDate(tenders.map(t=>t.tenderPeriod?.endDate));
  const docs = [...new Map(allDocs.filter(d=>d?.url).map(d=>[d.url,d])).values()];
  const status = firstNonEmpty(latestTender.status, awards.at(-1)?.status, contracts.at(-1)?.status);
  const items = allItems.map(it => ({
    name: it?.name || it?.description || '',
    description: it?.description || '',
    quantity: it?.quantity,
    unit: it?.unit,
    unitName: it?.unit?.name || it?.unitName || '',
    classification: it?.classification,
    additionalClassifications: it?.additionalClassifications
  }));
  if(!tags.length){
    if(contracts.length) tags.push('contract');
    else if(awards.length) tags.push('award');
    else if(tenders.length) tags.push('tender');
    else if(plannings.length) tags.push('planning');
  }
  return {tags, modalidad:modality, value, cpcs, supplierNames, publicationDate, lastUpdateDate, closeDate, docs, items, status,
    rawReleaseCount:releases.length, tendersCount:tenders.length, awardsCount:awards.length, contractsCount:contracts.length, planningsCount:plannings.length};
}

function getRowTitle(row){ return fixEncoding(String(firstNonEmpty(row?.title, row?.tender?.title, row?.description, row?.ocid) ?? '—')); }
function getRowDescription(row){ return fixEncoding(String(firstNonEmpty(row?.description, row?.tender?.description) ?? '')); }
function getRowDate(row){ return String(firstNonEmpty(row?.datePublished, row?.publishedDate, row?.releaseDate, row?.date, row?.tender?.datePublished, row?.tender?.tenderPeriod?.startDate) ?? ''); }
function getRowModality(row){ return String(firstNonEmpty(row?.internal_type, row?.procurementMethodDetails, row?.tender?.procurementMethodDetails, row?.tender?.procurementMethod, row?.method) ?? '—'); }
function getBuyerLabel(row){ return fixEncoding(String(firstNonEmpty(row?.buyerName, row?.buyer_name, row?.buyer?.name, row?.entidad, row?.buyer?.identifier?.legalName, row?.buyer?.identifier?.id, row?.buyerId) ?? '—')); }

const OCDS_MODALITY_RE = /^(SIE|CPC|LICO|CE|CO|ICQ|SNCP|SGP|ICAP|CGUV|AP)-/;
function procCodeTail(ocid){
  const s = String(ocid||'');
  const m = s.match(/^ocds-[^-]+-[^-]+-(.+)$/);
  return m ? m[1] : s;
}

function normalizeSearchRow(row, term){
  if(!row || typeof row !== 'object') return null;
  let ocid = String(row.ocid ?? row.id ?? '').trim();
  if(!ocid){
    // Fallback estable: elimina duplicados entre páginas y radares.
    let h = 5381;
    const seed = JSON.stringify([term, getRowTitle(row), getRowDescription(row), getBuyerLabel(row), getRowDate(row)]);
    for(const ch of seed) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    ocid = `synthetic_${term}_${h.toString(36)}`;
  }
  row.ocid = ocid;
  row.source = row.source || 'SERCOP';
  const title = String(row.title ?? '').trim();
  const desc = String(row.description ?? '').trim();
  const tail = procCodeTail(ocid);
  const titleIsCode = !title || title === ocid || title === tail || OCDS_MODALITY_RE.test(title);
  if(titleIsCode && desc && desc.length > 8) row.title = desc.slice(0, 160);
  return row;
}

// -- Route Handlers --------------------------------------------------

// Radares
function listRadares(){ return dbAll("SELECT id, nombre, year, search, buyer, supplier, source, created_at, cpcs, monitor, monitor_interval FROM radares ORDER BY created_at"); }

function createRadar(r){
  dbRun("INSERT OR REPLACE INTO radares(id, nombre, year, search, buyer, supplier, source, cpcs, monitor, monitor_interval) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [r.id, r.nombre, r.year, r.search, r.buyer||'', r.supplier||'', r.source||'sercop', r.cpcs||'', r.monitor?1:0, r.monitor_interval||60]);
  return r;
}

function updateRadar(id, r){
  dbRun("UPDATE radares SET nombre=?, year=?, search=?, buyer=?, supplier=?, source=?, cpcs=?, monitor=?, monitor_interval=? WHERE id=?",
    [r.nombre, r.year, r.search, r.buyer||'', r.supplier||'', r.source||'sercop', r.cpcs||'', r.monitor?1:0, r.monitor_interval||60, id]);
  return dbGet("SELECT * FROM radares WHERE id=?", [id]);
}

function deleteRadar(id){
  dbRun("DELETE FROM radares WHERE id=?", [id]);
  dbRun("DELETE FROM seen WHERE radar_id=?", [id]);
}

// Seen
function getSeen(radarId){
  return dbAll("SELECT ocid FROM seen WHERE radar_id=?", [radarId]).map(r=>r.ocid);
}

function markSeen(radarId, ocids){
  const stmt = db.prepare("INSERT OR IGNORE INTO seen(ocid, radar_id) VALUES(?,?)");
  for(const ocid of ocids) stmt.run(ocid, radarId);
}

function dismissProcess(radarId, ocid, reason){
  dbRun("INSERT OR REPLACE INTO dismissed(ocid, radar_id, reason) VALUES(?,?,?)", [ocid, radarId, reason || 'No relevante']);
}

function isDismissed(radarId, ocid){
  return !!dbGet("SELECT 1 FROM dismissed WHERE radar_id=? AND ocid=?", [radarId, ocid]);
}

// Processes
function getProcessesForRadar(radarId){
  const radar = dbGet("SELECT * FROM radares WHERE id=?", [radarId]);
  return dbAll(
    "SELECT ocid, source, title, description, buyer_name, date, modalidad, raw_json FROM procesos WHERE ',' || radar_ids || ',' LIKE '%,' || ? || ',%'",
    [radarId]
  ).filter(row => {
    if(isDismissed(radarId, row.ocid)) return false;
    let raw = null;
    try { raw = row.raw_json ? JSON.parse(row.raw_json) : null; } catch(_e) {}
    const candidate = {...(raw || {}), ...row};
    return rowMatchesRadar(candidate, radar);
  });
}

function saveProcess(row, radarId){
  const radar = dbGet("SELECT * FROM radares WHERE id=?", [radarId]);
  if(!rowMatchesRadar(row, radar)) return false;
  if(isDismissed(radarId, row.ocid)) return false;
  const existing = dbGet("SELECT radar_ids FROM procesos WHERE ocid=?", [row.ocid||'']);
  let radarIds = [radarId];
  if(existing?.radar_ids) radarIds = [...new Set([...existing.radar_ids.split(','), radarId])];
  dbRun("INSERT OR REPLACE INTO procesos(ocid, radar_ids, source, title, description, buyer_name, date, modalidad, raw_json) VALUES(?,?,?,?,?,?,?,?,?)",
    [row.ocid, radarIds.join(','), row.source||'SERCOP', getRowTitle(row), getRowDescription(row), getBuyerLabel(row), getRowDate(row), getRowModality(row), JSON.stringify(row)]);
  return true;
}

function saveDetail(ocid, det){
  dbRun("UPDATE procesos SET detail_json=?, detail_updated_at=datetime('now') WHERE ocid=?", [JSON.stringify(det), ocid]);
}

function getDetail(ocid){
  const row = dbGet("SELECT detail_json FROM procesos WHERE ocid=?", [ocid]);
  return row?.detail_json ? JSON.parse(row.detail_json) : null;
}

function getProcessRow(ocid){
  return dbGet("SELECT * FROM procesos WHERE ocid=?", [ocid]);
}

// Pipeline
function getPipeline(){
  const rows = dbAll("SELECT ocid, status, notas, entidad, titulo, modalidad, etapa_label, valor, cierre, publicado, actualizado, cpcs, etiquetas, source, fecha_presentacion, monto_oferta, competidores, contacto FROM pipeline");
  const out = {};
  rows.forEach(r => {
    let cpcs = [], etiquetas = [];
    try { cpcs = r.cpcs ? JSON.parse(r.cpcs) : []; } catch(_){ cpcs = []; }
    try { etiquetas = r.etiquetas ? JSON.parse(r.etiquetas) : []; } catch(_){ etiquetas = []; }
    out[r.ocid] = { status:r.status, notas:r.notas, entidad:r.entidad, titulo:r.titulo, modalidad:r.modalidad,
      etapaLabel:r.etapa_label, valor:r.valor, cierre:r.cierre, publicado:r.publicado, actualizado:r.actualizado,
      cpcs, etiquetas, source:r.source, fechaPresentacion:r.fecha_presentacion || null,
      montoOferta:r.monto_oferta || null, competidores:r.competidores || null, contacto:r.contacto || null };
  });
  return out;
}

function savePipelineEntry(ocid, p){
  dbRun(`INSERT INTO pipeline(ocid, status, notas, entidad, titulo, modalidad, etapa_label, valor, cierre, publicado, actualizado, cpcs, etiquetas, source, fecha_presentacion, monto_oferta, competidores, contacto)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ocid) DO UPDATE SET
      status=excluded.status, notas=excluded.notas, entidad=excluded.entidad, titulo=excluded.titulo,
      modalidad=excluded.modalidad, etapa_label=excluded.etapa_label, valor=excluded.valor, cierre=excluded.cierre,
      publicado=excluded.publicado, actualizado=excluded.actualizado, cpcs=excluded.cpcs, etiquetas=excluded.etiquetas,
      source=excluded.source, fecha_presentacion=excluded.fecha_presentacion, monto_oferta=excluded.monto_oferta,
      competidores=excluded.competidores, contacto=excluded.contacto,
      snapshot=COALESCE(excluded.snapshot, pipeline.snapshot), snapshot_at=COALESCE(excluded.snapshot_at, pipeline.snapshot_at)`,
    [ocid, p.status, p.notas, p.entidad, p.titulo, p.modalidad, p.etapaLabel, p.valor, p.cierre, p.publicado, p.actualizado,
     JSON.stringify(Array.isArray(p.cpcs) ? p.cpcs : []), JSON.stringify(Array.isArray(p.etiquetas) ? p.etiquetas : []), p.source || 'SERCOP',
     p.fechaPresentacion || null, p.montoOferta || null, p.competidores || null, p.contacto || null]);
}

function deletePipelineEntry(ocid){
  dbRun("DELETE FROM pipeline WHERE ocid=?", [ocid]);
}

// -- Detección de cambios en procesos seguidos ------------------------
function fmtAmt(n){
  const v = Number(n);
  if(!(n !== null && n !== undefined && isFinite(v))) return null;
  return v.toLocaleString('en-US', {style:'currency', currency:'USD', maximumFractionDigits:2});
}
function stageLabelOf(d){
  const status = String(d?.status || '').toLowerCase();
  if(/cancel|unsuccessful|withdrawn|desierto|cancelado/.test(status)) return 'Cancelado / desierto';
  if(d?.contractsCount > 0) return 'Contratado';
  if(d?.awardsCount > 0) return 'Adjudicado';
  if(d?.tendersCount > 0){ if(/complete|closed/.test(status)) return 'Oferta cerrada'; return 'Recepción de ofertas'; }
  if(d?.planningsCount > 0) return 'Planificación';
  const tags = d?.tags || [];
  if(tags.includes('contract')) return 'Contratado';
  if(tags.includes('award')) return 'Adjudicado';
  if(tags.includes('tender')) return 'En oferta';
  if(tags.includes('planning')) return 'Planificación';
  return 'sin datos';
}
function detailSignature(det){
  const docs = (det?.docs || []).map(d => d?.url || '').filter(Boolean).sort();
  return {
    closeDate: det?.closeDate || null,
    status: det?.status || null,
    valueAmount: det?.value?.amount ?? null,
    stageLabel: stageLabelOf(det),
    docsCount: docs.length,
    docsHash: docs.join('|'),
    tagsStr: (det?.tags || []).slice().sort().join(',')
  };
}
const CHANGES_COOLDOWN = 6 * 60 * 60 * 1000;
function alertChangeExists(ocid, summary){
  return !!dbGet("SELECT id FROM alerts WHERE ocid=? AND alert_type='change' AND title=? ORDER BY created_at DESC LIMIT 1", [ocid, summary]);
}
async function detectPipelineChanges(force){
  const state = dbGet("SELECT last_run FROM monitor_state WHERE id='__changes__'");
  const last = state ? new Date(state.last_run).getTime() : 0;
  if(!force && Date.now() - last < CHANGES_COOLDOWN) return 0;
  const rows = dbAll("SELECT ocid, snapshot FROM pipeline");
  let changed = 0;
  const changedList = [];
  for(const r of rows){
    try{
      const det = await fetchDetail(r.ocid, true);
      if(!det) continue;
      const snap = detailSignature(det);
      const oldSnap = r.snapshot ? JSON.parse(r.snapshot) : null;
      if(!oldSnap){
        dbRun("UPDATE pipeline SET snapshot=?, snapshot_at=datetime('now') WHERE ocid=?", [JSON.stringify(snap), r.ocid]);
        continue;
      }
      const changes = [];
      if(oldSnap.closeDate !== snap.closeDate) changes.push(`Cierre: ${oldSnap.closeDate||'?'} -> ${snap.closeDate||'?'}`);
      if(String(oldSnap.valueAmount ?? '') !== String(snap.valueAmount ?? '')) changes.push(`Valor: ${fmtAmt(oldSnap.valueAmount)||'?'} -> ${fmtAmt(snap.valueAmount)||'?'}`);
      if(oldSnap.status !== snap.status) changes.push(`Estado: ${oldSnap.status||'?'} -> ${snap.status||'?'}`);
      if(oldSnap.docsCount !== snap.docsCount) changes.push(`Documentos: ${oldSnap.docsCount} -> ${snap.docsCount}`);
      if(oldSnap.stageLabel !== snap.stageLabel) changes.push(`Etapa: ${oldSnap.stageLabel} -> ${snap.stageLabel}`);
      if(changes.length){
        const summary = changes.join(' · ');
        const proc = dbGet("SELECT entidad FROM pipeline WHERE ocid=?", [r.ocid]);
        if(!alertChangeExists(r.ocid, summary)){
          dbRun("INSERT INTO alerts(radar_id, ocid, title, buyer_name, alert_type) VALUES('',?,?,?, 'change')",
            [r.ocid, summary.slice(0, 300), proc?.entidad || '']);
          changed++;
          console.log(`  [Cambios] ${r.ocid}: ${summary}`);
          changedList.push({ ocid: r.ocid, summary, entidad: proc?.entidad || '' });
        }
        dbRun(`UPDATE pipeline SET cierre=COALESCE(?,cierre), etapa_label=COALESCE(?,etapa_label),
          valor=COALESCE(?,valor), actualizado=datetime('now'), snapshot=?, snapshot_at=datetime('now') WHERE ocid=?`,
          [snap.closeDate || null, snap.stageLabel || null, fmtAmt(snap.valueAmount) || null, JSON.stringify(snap), r.ocid]);
      } else {
        dbRun("UPDATE pipeline SET snapshot=?, snapshot_at=datetime('now') WHERE ocid=?", [JSON.stringify(snap), r.ocid]);
      }
    }catch(e){ console.error(`  [Cambios] error ${r.ocid}:`, e.message); }
  }
  dbRun("INSERT OR REPLACE INTO monitor_state(id, last_run) VALUES('__changes__', datetime('now'))");
  const st = mailStatus();
  for(const c of changedList){
    await sendWebhook('change', {
      ocid: c.ocid, resumen: c.summary, entidad: c.entidad,
      url: sercopPublicUrl(c.ocid), destinatarios: st.to
    });
  }
  return changed;
}

// DB stats
function getStats(){
  const procCount = dbGet("SELECT COUNT(*) as n FROM procesos")?.n || 0;
  const radarCount = dbGet("SELECT COUNT(*) as n FROM radares")?.n || 0;
  const cacheCount = dbGet("SELECT COUNT(*) as n FROM api_cache")?.n || 0;
  const alertCount = dbGet("SELECT COUNT(*) as n FROM alerts WHERE read=0")?.n || 0;
  return {radarCount, procCount, cacheCount, alertCount};
}

// -- Mercado (agregación local de detalles OCDS) ---------------------
function getMercado(year, cpc, entidad){
  const rows = dbAll("SELECT ocid, title, buyer_name, date, detail_json, raw_json FROM procesos");
  const entidades = new Map(), proveedores = new Map(), cpcs = new Map(), adjudicaciones = [];
  let conDetalle = 0;
  for(const r of rows){
    let d = null;
    if(r.detail_json){ try { d = JSON.parse(r.detail_json); } catch(_){} }
    if(!d){
      let raw = null;
      try { raw = r.raw_json ? JSON.parse(r.raw_json) : null; } catch(_){}
      if(!raw) continue;
      const amount = Number(firstNonEmpty(raw.amount, raw.budget, raw.tender?.value?.amount) ?? 0);
      d = {
        publicationDate: String(firstNonEmpty(raw.publicationDate, raw.date, raw.year) ?? ''),
        cpcs: Array.isArray(raw.cpcs) ? raw.cpcs : [],
        supplierNames: Array.isArray(raw.suppliers)
          ? raw.suppliers.map(s => String(firstNonEmpty(s?.name, s?.identifier?.legalName, s?.identifier?.id) ?? '')).filter(Boolean)
          : [],
        value: amount > 0 ? {amount, currency:'USD'} : null,
        modalidad: String(firstNonEmpty(raw.modalidad, raw.internal_type) ?? '')
      };
    }
    conDetalle++;
    const pub = String(d.publicationDate || r.date || '');
    if(year && !pub.startsWith(String(year))) continue;
    const detCpcs = (d.cpcs||[]).map(String);
    if(cpc && !detCpcs.some(x => x.includes(String(cpc)))) continue;
    const buyer = String(r.buyer_name || '—');
    if(entidad && !buyer.toLowerCase().includes(String(entidad).toLowerCase())) continue;
    const valor = Number(d.value?.amount) || 0;
    const suppliers = Array.isArray(d.supplierNames) ? d.supplierNames : [];
    const ent = entidades.get(buyer) || {entidad:buyer, procesos:0, valor:0, adjudicado:0};
    ent.procesos++; ent.valor += valor; if(suppliers.length) ent.adjudicado++;
    entidades.set(buyer, ent);
    if(suppliers.length && valor > 0){
      adjudicaciones.push({ocid:r.ocid, titulo:String(r.title || r.ocid), entidad:buyer, proveedores:suppliers, valor,
        fecha:pub, cpcs:detCpcs, modalidad:String(d.modalidad||'')});
    }
    for(const s of suppliers){
      const key = String(s).trim() || '(sin nombre)';
      const p = proveedores.get(key) || {proveedor:key, procesos:0, valor:0};
      p.procesos++; p.valor += valor;
      proveedores.set(key, p);
    }
    for(const c of detCpcs){
      const cell = cpcs.get(c) || {cpc:c, procesos:0, valor:0, min:Infinity, max:0, adjudicado:0};
      cell.procesos++; cell.valor += valor;
      if(valor > 0){ cell.min = Math.min(cell.min, valor); cell.max = Math.max(cell.max, valor); }
      if(suppliers.length) cell.adjudicado++;
      cpcs.set(c, cell);
    }
  }
  const fin = m => [...m.values()].map(x => ({...x, promedio: x.procesos ? Math.round(x.valor/x.procesos*100)/100 : 0}));
  return {
    totalProcesos: conDetalle,
    totalAdjudicado: [...entidades.values()].reduce((s,e) => s+e.adjudicado, 0),
    totalProveedores: proveedores.size,
    entidades: fin(entidades).sort((a,b) => b.valor-a.valor).slice(0,15),
    proveedores: fin(proveedores).sort((a,b) => b.valor-a.valor).slice(0,15),
    cpcs: fin(cpcs).map(c => ({...c, min:Number.isFinite(c.min) ? c.min : 0})).sort((a,b) => b.valor-a.valor).slice(0,50),
    adjudicaciones: adjudicaciones.sort((a,b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0,150)
  };
}

// -- SSE Search ------------------------------------------------------
let enrichBudget = 0;

const OCDS_SIBLING_PREFIXES = ['SIE','LICO','CE','CO','ICQ','CPC','SNCP','SGP','ICAP','AP'];
const OCDS_SIBLING_CACHE = new Map();

// Algunos procesos existen en SERCOP con varios prefijos OCDS (SIE/CPC/LICO/CE…)
// sobre el mismo código (ej. GADMLA-2026-003-91040). Unas variantes vienen casi
// vacías y otras con título/descripción completos. Esto devuelve el ocid "hermano"
// con más información para el mismo proceso.
const OCDS_OCID_RE = /^ocds-[^-]+-([^-]+)-(.+)$/;
async function resolveSiblingRecord(ocid){
  if(OCDS_SIBLING_CACHE.has(ocid)) return OCDS_SIBLING_CACHE.get(ocid);
  const m = String(ocid||'').match(OCDS_OCID_RE);
  let best = null;
  if(m){
    const cur = m[1], tail = m[2];
    for(const prefix of [cur, ...OCDS_SIBLING_PREFIXES]){
      if(prefix === cur) continue;
      const sib = `ocds-5wno2w-${prefix}-${tail}`;
      try{
        const resp = await fetchWithRetry(`${SERCOP_API}/record?ocid=${encodeURIComponent(sib)}`, {headers:{'Accept':'application/json'}});
        const data = await resp.json();
        const releases = collectReleases(data);
        if(!releases.length) continue;
        if(releases.some(r => r?.tender && (r.tender.title || r.tender.description))){ best = sib; break; }
        if(!best) best = sib;
      }catch(_){}
    }
  }
  OCDS_SIBLING_CACHE.set(ocid, best);
  return best;
}

async function crossResolveProcess(row){
  try{
    const sib = await resolveSiblingRecord(String(row?.ocid||''));
    if(!sib || sib === String(row?.ocid||'')) return null;
    const resp = await fetchWithRetry(`${SERCOP_API}/record?ocid=${encodeURIComponent(sib)}`, {headers:{'Accept':'application/json'}});
    const data = await resp.json();
    const releases = collectReleases(data);
    for(let i = releases.length-1; i>=0; i--){
      const r = releases[i];
      const d = String(firstNonEmpty(r?.tender?.description, r?.planning?.description, r?.planning?.identifier?.description) ?? '').trim();
      if(d) return {title:'', description:d, ocid:sib};
      const t = String(firstNonEmpty(r?.tender?.title, r?.planning?.title) ?? '').trim();
      if(t && t !== sib && !/^[A-Z]{2,6}(-|$)/.test(t)) return {title:t, description:'', ocid:sib};
    }
  }catch(_){}
  return null;
}

function scheduleEnrich(row, send){
  enrichBudget--;
  if(enrichBudget <= 0) return;
  (async () => {
    try{
      const corr = {};
      const origTitle = getRowTitle(row);
      const titleIsOcid = String(origTitle) === String(row?.ocid || '');
      const hopefullyReal = String(firstNonEmpty(row?.tender?.title, row?.description) ?? '');
      if(titleIsOcid && hopefullyReal){
        corr.title = hopefullyReal;
      } else if(titleIsOcid){
        const meta = await crossResolveProcess(row);
        if(meta){
          if(meta.description){
            row.description = meta.description;
            corr.title = meta.description.slice(0, 200);
            corr.description = meta.description;
          } else if(meta.title){
            corr.title = meta.title;
          }
        }
      }
      const origBuyer = getBuyerLabel(row);
      let buyer = origBuyer;
      if(needBuyerFix(buyer)){
        const ruc = String(firstNonEmpty(row?.buyer?.identifier?.id, row?.buyerId, row?.buyer?.id) ?? '').trim();
        if(ruc){
          const name = await entityNameById(ruc);
          if(name){ buyer = name; corr.buyerName = name; }
        }
      }
      if(!Object.keys(corr).length) return;
      row.title = corr.title || row.title;
      row.buyerName = corr.buyerName || row.buyerName;
      try{
        if(dbGet("SELECT ocid FROM procesos WHERE ocid=?", [row.ocid])){
          dbRun("UPDATE procesos SET title=?, buyer_name=?, description=COALESCE(?, description) WHERE ocid=?",
            [row.title, row.buyerName||origBuyer, corr.description || row.description || null, row.ocid]);
        }
      }catch(_){}
      send('result_update', {ocid:row.ocid, title:row.title, description:corr.description || '', buyerName:corr.buyerName || ''});
    }catch(_){}
  })();
}

async function handleSearch(req, res, params){
  const radarId = params.radarId;
  if(!radarId){ json(res, 400, {error:'radarId required'}); return; }

  const radar = dbGet("SELECT * FROM radares WHERE id=?", [radarId]);
  if(!radar){ json(res, 404, {error:'radar not found'}); return; }

  const aOrigin = allowedOrigin(req.headers.origin);
  const sseHeaders = {
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive'
  };
  if(aOrigin) sseHeaders['Access-Control-Allow-Origin'] = aOrigin;
  res.writeHead(200, sseHeaders);

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const terms = splitRadarTerms(radar.search);
  const cpcCodes = splitRadarTerms(radar.cpcs);
  if(!terms.length && !cpcCodes.length){ send('error_msg', {message:'No hay palabras clave validas'}); res.end(); return; }

  send('start', {terms, cpcCodes, year:radar.year, source:radar.source});

  const merged = new Map();
  const sourceErrors = [];
  const seenTails = new Map();

  function mergeSERCOPRow(row, radarId, send){
    const tail = procCodeTail(row.ocid);
    if(tail){
      const prevOcid = seenTails.get(tail);
      if(prevOcid){
        const prev = merged.get(prevOcid);
        const newHasMeta = row.title && row.title !== row.ocid;
        const prevHasMeta = prev && prev.title && prev.title !== prev.ocid;
        if(newHasMeta && !prevHasMeta){
          merged.delete(prevOcid);
          merged.set(row.ocid, row);
          seenTails.set(tail, row.ocid);
          return true;
        }
        return false; // variante ya mostrada (mismo proceso)
      }
      seenTails.set(tail, row.ocid);
    }
    saveProcess(row, radarId);
    if(!merged.has(row.ocid)){ merged.set(row.ocid, row); send('result', row); }
    return true;
  }

  try {
    enrichBudget = 40;
    for(let ti = 0; ti < terms.length; ti++){
      const term = terms[ti];
      send('term_start', {term, index:ti, total:terms.length + cpcCodes.length});

      if(wantsSource(radar, 'undp')){
        try {
          const undpRows = await fetchUNDPNotices(term, radar.year);
          for(const raw of undpRows){
            const row = normalizeSearchRow(raw, term);
            if(!row) continue;
            saveProcess(row, radarId);
            if(!merged.has(row.ocid)){ merged.set(row.ocid, row); send('result', row); }
          }
        } catch(e){
          console.error(`  UNDP error (${term}):`, e.message);
          sourceErrors.push(`UNDP (${term}): ${e.message}`);
        }
      }

      if(wantsSource(radar, 'nco')){
        try {
          const {out, totalAvailable, skipped} = await fetchNCONeeds(term, radar.year, radar.buyer);
          if(skipped) send('warning', {message:`"${term}": NCO requiere minimo 5 caracteres`});
          if(out.length && totalAvailable > out.length) send('warning', {message:`"${term}": NCO devolvio ${totalAvailable} coincidencias; mostrando ${out.length} relevantes vigentes del ano configurado`});
          for(const row of out){
            saveProcess(row, radarId);
            if(row?._detail) saveDetail(row.ocid, row._detail);
            if(row?.ocid && !merged.has(row.ocid)){ merged.set(row.ocid, row); send('result', row); }
          }
        } catch(e){
          console.error(`  NCO error (${term}):`, e.message);
          sourceErrors.push(`NCO (${term}): ${e.message}`);
        }
      }

      if(wantsSource(radar, 'sercop')){
        try {
          const {out, truncated, totalAvailable} = await fetchSERCOPAllPages(term, radar.year, radar.buyer, radar.supplier, (prog) => send('progress', prog), true);
          if(truncated) send('warning', {message:`"${term}": mostrando primeras ${MAX_PAGES} paginas de resultados`, totalAvailable});
          for(const raw of out){
            const row = normalizeSearchRow(raw, term);
            if(!row) continue;
            saveProcess(row, radarId);
            scheduleEnrich(row, send);
            if(!merged.has(row.ocid)){ merged.set(row.ocid, row); send('result', row); }
          }
        } catch(e){
          console.error(`  SERCOP error (${term}):`, e.message);
          sourceErrors.push(`SERCOP (${term}): ${e.message}`);
        }
      }

      if(wantsSource(radar, 'bid')){
        try {
          const bidRows = await fetchBIDProjects(term, radar.year);
          for(const row of bidRows){
            saveProcess(row, radarId);
            if(row?.ocid && !merged.has(row.ocid)){ merged.set(row.ocid, row); send('result', row); }
          }
        } catch(e){
          console.error(`  BID error (${term}):`, e.message);
          sourceErrors.push(`BID (${term}): ${e.message}`);
        }
      }

      send('term_done', {term, count: merged.size});
      if(ti < terms.length - 1 || cpcCodes.length) await sleep(TERM_DELAY);
    }

    for(let ci = 0; ci < cpcCodes.length; ci++){
      const cpc = cpcCodes[ci];
      const idx = terms.length + ci;
      send('term_start', {term:`CPC ${cpc}`, index:idx, total:terms.length + cpcCodes.length});

      if(wantsSource(radar, 'sercop')){
        try {
          const {out, truncated, totalAvailable} = await fetchSERCOPByCPC(cpc, radar.year, radar.buyer, (prog) => send('progress', prog), true);
          if(truncated) send('warning', {message:`"CPC ${cpc}": mostrando primeras ${MAX_PAGES} paginas de resultados`, totalAvailable});
          for(const raw of out){
            const row = normalizeSearchRow(raw, `CPC ${cpc}`);
            if(!row) continue;
            saveProcess(row, radarId);
            scheduleEnrich(row, send);
            if(!merged.has(row.ocid)){ merged.set(row.ocid, row); send('result', row); }
          }
        } catch(e){
          console.error(`  SERCOP CPC error (${cpc}):`, e.message);
          sourceErrors.push(`SERCOP CPC (${cpc}): ${e.message}`);
        }
      }

      send('term_done', {term:`CPC ${cpc}`, count: merged.size});
      if(ci < cpcCodes.length - 1) await sleep(TERM_DELAY);
    }

    const results = [...merged.values()].filter(Boolean).sort((a,b) => String(getRowDate(b)).localeCompare(String(getRowDate(a))));
    send('done', {
      total: results.length,
      totalAvailable: results.length,
      warnings: sourceErrors.length ? [`Errores: ${sourceErrors.join(' · ')}`] : []
    });
  } catch(e){
    send('error_msg', {message: e.message});
  }

  res.end();
}

// -- Detail fetch (server-side) --------------------------------------
async function fetchDetail(ocid, force){
  if(!force){
    const cached = getDetail(ocid);
    if(cached) return cached;
  }

  const row = getProcessRow(ocid);
  if(!force){
    if(row?.detail_json){
      const det = JSON.parse(row.detail_json);
      return det;
    }
    if(row?.raw_json){
      try{
        const raw = JSON.parse(row.raw_json);
        if(raw?._detail){
          saveDetail(ocid, raw._detail);
          return raw._detail;
        }
      }catch(_){}
    }
  }
  if(row?.source && String(row.source).toUpperCase() !== 'SERCOP') return null;

  const resp = await fetchWithRetry(`${SERCOP_API}/record?ocid=${encodeURIComponent(ocid)}`, {headers:{'Accept':'application/json'}});
  const data = await resp.json();
  let det = mergeDetail(data);
  if(!det.tendersCount && !det.awardsCount && !det.contractsCount){
    const sib = await resolveSiblingRecord(ocid);
    if(sib && sib !== ocid){
      try{
        const sresp = await fetchWithRetry(`${SERCOP_API}/record?ocid=${encodeURIComponent(sib)}`, {headers:{'Accept':'application/json'}});
        const sdata = await sresp.json();
        const sdet = mergeDetail(sdata);
        if(sdet.tendersCount || sdet.awardsCount || sdet.contractsCount){
          sdet.siblingOcid = sib;
          det = sdet;
          const sReleases = collectReleases(sdata);
          for(let i = sReleases.length-1; i>=0; i--){
            const sDesc = String(firstNonEmpty(sReleases[i]?.tender?.description, sReleases[i]?.planning?.description, sReleases[i]?.planning?.identifier?.description) ?? '').trim();
            if(sDesc){
              try{
                dbRun("UPDATE procesos SET title=?, description=COALESCE(?, description) WHERE ocid=?", [sDesc.slice(0,200), sDesc, ocid]);
              }catch(_){}
              break;
            }
          }
        }
      }catch(_){}
    }
  }
  saveDetail(ocid, det);
  return det;
}

// -- Autenticación (endpoints) ---------------------------------------
async function handleLogin(req, res){
  if(!AUTH_ENABLED) return json(res, 200, {ok:true, authDisabled:true});
  const ip = clientIp(req);
  const ipRl = loginIpLimiter.hit(ip);
  if(!ipRl.allowed){
    res.setHeader('Retry-After', String(Math.ceil(ipRl.retryAfterMs / 1000)));
    return json(res, 429, {error:'demasiados intentos, espera un momento', retryAfterMs: ipRl.retryAfterMs});
  }
  let body;
  try{ body = JSON.parse((await collectBody(req)).toString('utf8') || '{}'); }
  catch(e){ return json(res, 400, {error:'cuerpo inválido'}); }
  const username = String(body.username || '').trim().slice(0, 64);
  const password = String(body.password || '');
  if(!username || !password) return json(res, 400, {error:'usuario y contraseña requeridos'});

  const userKey = `${ip}|${username.toLowerCase()}`;
  const userRl = loginUserLimiter.hit(userKey);
  if(!userRl.allowed){
    res.setHeader('Retry-After', String(Math.ceil(userRl.retryAfterMs / 1000)));
    return json(res, 429, {error:'cuenta temporalmente bloqueada', retryAfterMs: userRl.retryAfterMs});
  }

  const user = await auth.authenticate(db, username, password);
  if(!user){
    auth.recordLoginEvent(db, username, ip, false);
    console.warn(`  [Auth] login fallido usuario="${username}" ip=${ip}`);
    return json(res, 401, {error:'usuario o contraseña incorrectos'});
  }
  loginIpLimiter.reset(ip);
  loginUserLimiter.reset(userKey);
  auth.recordLoginEvent(db, user.username, ip, true);
  const {token, csrf, expiresAt} = auth.createSession(db, user.id, {
    ip, userAgent: req.headers['user-agent'] || '', ttlMs: SESSION_TTL_MS
  });
  setSessionCookie(req, res, token, SESSION_TTL_MS);
  console.log(`  [Auth] sesión iniciada usuario="${user.username}" ip=${ip}`);
  return json(res, 200, {ok:true, user:{id:user.id, username:user.username, role:user.role}, csrf, expiresAt});
}

async function handleChangePassword(req, res, authResult){
  if(!AUTH_ENABLED) return json(res, 200, {ok:true});
  if(authResult.via !== 'session') return json(res, 400, {error:'disponible solo con sesión iniciada'});
  let body;
  try{ body = JSON.parse((await collectBody(req)).toString('utf8') || '{}'); }
  catch(e){ return json(res, 400, {error:'cuerpo inválido'}); }
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  const user = auth.getUserById(db, authResult.user.id);
  if(!user) return json(res, 401, {error:'no autorizado'});
  if(!(await auth.verifyPassword(current, user.pass_hash))) return json(res, 400, {error:'contraseña actual incorrecta'});
  if(next.length < auth.MIN_PASSWORD_LEN) return json(res, 400, {error:`la nueva contraseña debe tener al menos ${auth.MIN_PASSWORD_LEN} caracteres`});
  await auth.setPassword(db, user.id, next);
  // setPassword invalida las sesiones; recreamos la actual para no desconectar.
  const {token, csrf, expiresAt} = auth.createSession(db, user.id, {
    ip: clientIp(req), userAgent: req.headers['user-agent'] || '', ttlMs: SESSION_TTL_MS
  });
  setSessionCookie(req, res, token, SESSION_TTL_MS);
  auth.recordLoginEvent(db, user.username, clientIp(req), true);
  return json(res, 200, {ok:true, csrf, expiresAt});
}

// -- HTTP Server -----------------------------------------------------
const server = http.createServer(async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.nonce = nonce;
  applySecurityHeaders(req, res, nonce);
  cors(res, req.headers.origin);
  if(req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }

  const {pathname, params} = parseUrl(req);

  try {
    // -- Público: página de login y endpoints de autenticación ----
    if(pathname === '/login' || pathname === '/login.html'){
      return serveFile(res, path.join(__dirname, 'login.html'), nonce);
    }
    if(pathname === '/api/auth/login' && req.method === 'POST'){
      return await handleLogin(req, res);
    }
    if(pathname === '/api/auth/session' && req.method === 'GET'){
      const a = authenticate(req, params);
      if(!a.ok) return json(res, 200, {authenticated:false});
      return json(res, 200, {authenticated:true, user:a.user, csrf:a.csrf || null, authDisabled: a.via === 'disabled'});
    }

    // -- Limitador global de API ----------------------------------
    if(pathname.startsWith('/api/')){
      const rl = apiLimiter.hit(clientIp(req));
      if(!rl.allowed){
        res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
        return json(res, 429, {error:'demasiadas peticiones, inténtalo más tarde'});
      }
    }

    // -- Autenticación del resto de /api/* ------------------------
    let authResult = {ok:true, via:'public'};
    if(pathname.startsWith('/api/')){
      authResult = authenticate(req, params);
      if(!authResult.ok) return json(res, 401, {error:'no autorizado'});
      if(!csrfValid(req, authResult)) return json(res, 403, {error:'CSRF inválido'});
    }

    if(pathname === '/api/auth/logout' && req.method === 'POST'){
      auth.deleteSession(db, auth.readCookie(req, SESSION_COOKIE));
      clearSessionCookie(req, res);
      return json(res, 200, {ok:true});
    }
    if(pathname === '/api/auth/change-password' && req.method === 'POST'){
      return await handleChangePassword(req, res, authResult);
    }

    // -- Static files --
    if(pathname === '/' || pathname === '/sercop.html'){
      return serveFile(res, path.join(__dirname, 'sercop.html'), nonce);
    }

    // -- Favicon --
    if(pathname === '/favicon.ico'){
      res.writeHead(204);
      return res.end();
    }

    // -- DB backup download/upload --
    if(pathname === '/api/db'){
      if(req.method === 'GET'){
        try {
          const tmp = path.join(path.dirname(DB_FILE), 'radar.backup.tmp');
          try { fs.unlinkSync(tmp); } catch(_){}
          await db.backup(tmp);
          const data = fs.readFileSync(tmp);
          try { fs.unlinkSync(tmp); } catch(_){}
          res.writeHead(200, {'Content-Type':'application/x-sqlite3','Content-Length':data.length,'Cache-Control':'no-store'});
          res.end(data);
        } catch(e){ console.error('/api/db backup error:', e.message); json(res, 500, {error:'no se pudo generar la copia'}); }
        return;
      }
      if(req.method === 'POST'){
        if(!ALLOW_RESTORE) return json(res, 403, {error:'restauración deshabilitada (NVG_ALLOW_RESTORE=0)'});
        const tmp = DB_FILE + '.tmp';
        try {
          const size = await collectBodyToFile(req, tmp, MAX_UPLOAD_BYTES);
          // Valida el archivo ANTES de tocar la base en uso.
          let check = null;
          try {
            check = new Database(tmp, {readonly:true});
            const row = check.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get();
            if(!row) throw new Error('no es una base SQLite válida');
          } catch(e){
            if(check){ try{ check.close(); }catch(_){} check = null; }
            try { fs.unlinkSync(tmp); } catch(_){}
            return json(res, 400, {error:'backup inválido'});
          }
          if(check){ check.close(); check = null; }
          try { db.close(); } catch(_){}
          for(const f of [DB_FILE, DB_FILE+'-wal', DB_FILE+'-shm']){
            try { fs.unlinkSync(f); } catch(_){}
          }
          fs.renameSync(tmp, DB_FILE);
          initDB();
          return json(res, 200, {ok:true, size});
        } catch(e){
          try { fs.unlinkSync(tmp); } catch(_){}
          try { initDB(); } catch(_){}
          const code = e && e.statusCode ? e.statusCode : 500;
          return json(res, code, {error: code === 413 ? 'archivo demasiado grande' : 'no se pudo restaurar la copia'});
        }
      }
    }

    // -- Stats --
    if(pathname === '/api/stats' && req.method === 'GET'){
      return json(res, 200, getStats());
    }
    if(pathname === '/api/config' && req.method === 'GET'){
      return json(res, 200, mailStatus());
    }
    if(pathname === '/api/integrations/test' && req.method === 'POST'){
      const st = mailStatus();
      const result = { ok: true, mail: false, webhook: false, provider: st.provider };
      let body = {};
      try{ body = JSON.parse((await collectBody(req)).toString('utf8') || '{}'); }catch(_){}
      const doMail = body.mail !== false;
      const doWebhook = body.webhook !== false;
      if(doMail){
        if(st.email){
          result.mail = await sendMail('[NVG] Prueba de integración',
            '<p>Prueba de envío del Radar SERCOP.</p><p>Si recibes este correo, la integración de Microsoft 365 / Outlook funciona.</p>');
        } else result.mail = false;
      }
      if(doWebhook){
        result.webhook = await sendWebhook('test', {
          mensaje: 'Prueba de webhook desde el Radar SERCOP',
          estado: 'ok', prueba: true
        });
      }
      return json(res, 200, result);
    }
    if(pathname === '/api/mercado' && req.method === 'GET'){
      return json(res, 200, getMercado(params.year || '', params.cpc || '', params.entidad || ''));
    }

    // -- Radares --
    if(pathname === '/api/radares'){
      if(req.method === 'GET') return json(res, 200, listRadares());
      if(req.method === 'POST'){
        const body = JSON.parse(await collectBody(req));
        return json(res, 201, createRadar(body));
      }
    }

    const resultsMatch = pathname.match(/^\/api\/radares\/(.+)\/results$/);
    if(resultsMatch){
      const id = decodeURIComponent(resultsMatch[1]);
      if(req.method === 'GET') return json(res, 200, getProcessesForRadar(id));
    }

    const radarMatch = pathname.match(/^\/api\/radares\/(.+)$/);
    if(radarMatch){
      const id = decodeURIComponent(radarMatch[1]);
      if(req.method === 'PUT'){
        const body = JSON.parse(await collectBody(req));
        return json(res, 200, updateRadar(id, body));
      }
      if(req.method === 'DELETE'){
        deleteRadar(id);
        return json(res, 200, {ok:true});
      }
    }

    // -- Seen --
    const seenMatch = pathname.match(/^\/api\/seen\/(.+)$/);
    if(seenMatch){
      const radarId = decodeURIComponent(seenMatch[1]);
      if(req.method === 'GET') return json(res, 200, getSeen(radarId));
      if(req.method === 'POST'){
        const body = JSON.parse(await collectBody(req));
        markSeen(radarId, body.ocids || []);
        return json(res, 200, {ok:true});
      }
    }

    const dismissMatch = pathname.match(/^\/api\/dismiss\/(.+)\/(.+)$/);
    if(dismissMatch){
      const radarId = decodeURIComponent(dismissMatch[1]);
      const ocid = decodeURIComponent(dismissMatch[2]);
      if(req.method === 'POST'){
        const body = JSON.parse(await collectBody(req).catch(() => '{}'));
        dismissProcess(radarId, ocid, body.reason || 'No relevante');
        return json(res, 200, {ok:true});
      }
    }

    // -- Pipeline --
    if(pathname === '/api/pipeline' && req.method === 'GET'){
      return json(res, 200, getPipeline());
    }

    if(pathname === '/api/pipeline/refresh' && req.method === 'POST'){
      const changed = await detectPipelineChanges(true);
      return json(res, 200, {ok:true, changed});
    }

    const pipelineMatch = pathname.match(/^\/api\/pipeline\/(.+)$/);
    if(pipelineMatch){
      const ocid = decodeURIComponent(pipelineMatch[1]);
      if(req.method === 'POST'){
        const body = JSON.parse(await collectBody(req));
        savePipelineEntry(ocid, body);
        return json(res, 200, {ok:true});
      }
      if(req.method === 'DELETE'){
        deletePipelineEntry(ocid);
        return json(res, 200, {ok:true});
      }
    }

    // -- Search (SSE) --
    if(pathname === '/api/search' && req.method === 'GET'){
      return await handleSearch(req, res, params);
    }

    // -- Detail --
    if(pathname === '/api/nco' && req.method === 'GET'){
      const q = String(params.q || '').trim();
      if(q.length < 5) return json(res, 400, {error:'q must be 5+ chars'});
      const result = await fetchNCONeeds(q, params.year || '', params.buyer || '');
      return json(res, 200, result);
    }

    const detailMatch = pathname.match(/^\/api\/detail\/(.+)$/);
    if(detailMatch){
      const ocid = decodeURIComponent(detailMatch[1]);
      if(req.method === 'GET'){
        const det = await fetchDetail(ocid);
        if(det) saveDetail(ocid, det);
        return json(res, 200, det);
      }
    }

    // -- Exportar a Excel (.xlsx) --
    if(pathname === '/api/xlsx' && req.method === 'POST'){
      try{
        const body = JSON.parse(await collectBody(req));
        const filename = String(body.filename || 'export').replace(/\.xlsx$/i, '') + '.xlsx';
        const sheets = Array.isArray(body.sheets) ? body.sheets : [];
        const wb = new (getExcelJS().Workbook)();
        for(const sheet of sheets){
          const ws = wb.addWorksheet(String(sheet.name || 'Hoja').slice(0, 31));
          const headers = Array.isArray(sheet.headers) ? sheet.headers.map(String) : [];
          const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
          if(headers.length){
            ws.columns = headers.map(h => ({header: h, key: h, width: Math.min(40, Math.max(10, String(h).length + 6))}));
            ws.getRow(1).font = {bold: true, color: {argb: 'FFFFFFFF'}};
            ws.getRow(1).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF0C8C82'}};
            ws.views = [{state: 'frozen', ySplit: 1}];
          }
          for(const r of rows) ws.addRow(Array.isArray(r) ? r : [r]);
        }
        const buf = await wb.xlsx.writeBuffer();
        const out = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        res.writeHead(200, {
          'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Length': out.length,
          'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g,'_')}"`
        });
        res.end(out);
      }catch(e){
        console.error('/api/xlsx error:', e.message);
        try{ json(res, 500, {error:'no se pudo generar el Excel'}); }catch(_){}
      }
      return;
    }

    // -- Cache clear --
    if(pathname === '/api/cache' && req.method === 'DELETE'){
      dbRun("DELETE FROM api_cache");
      return json(res, 200, {ok:true});
    }

    // -- PAC (Plan Anual de Contrataciones) --
    if(pathname === '/api/pac/entities' && req.method === 'GET'){
      const q = params.q || '';
      if(q.length < 2) return json(res, 400, {error:'q must be 2+ chars'});
      let entities = [];
      try {
        entities = await searchPACEntities(q);
      } catch(e) {
        console.warn(`PAC entities unavailable (${q}): ${e.message}`);
      }
      return json(res, 200, entities);
    }

    if(pathname === '/api/pac/items' && req.method === 'GET'){
      const entityId = params.entityId;
      const entityName = params.entityName || '';
      const year = params.year || new Date().getFullYear();
      if(!entityId) return json(res, 400, {error:'entityId required'});
      const result = await fetchPACItems(entityId, entityName, year);
      return json(res, 200, result);
    }

    if(pathname === '/api/pac/xref' && req.method === 'GET'){
      const radarId = params.radarId;
      const year = params.year || new Date().getFullYear();
      if(!radarId) return json(res, 400, {error:'radarId required'});
      const result = await pacXRef(radarId, params.entityId, year, params.entityName);
      return json(res, 200, result);
    }

    // -- Planificador PAC/POA --
    if(pathname === '/api/pac/plan' && req.method === 'POST'){
      const body = JSON.parse(await collectBody(req));
      const {entityId, entityName, year, radarIds} = body;
      if(!entityId) return json(res, 400, {error:'entityId required'});
      try{
        const result = await savePlanFromEntity(entityId, entityName, year || new Date().getFullYear(), radarIds || []);
        return json(res, 200, result);
      }catch(e){ return json(res, 500, {error:'no se pudo guardar el PAC: ' + e.message}); }
    }

    if(pathname === '/api/pac/plan' && req.method === 'GET'){
      return json(res, 200, getPlanRows(params));
    }

    if(pathname === '/api/pac/plan-clear' && req.method === 'DELETE'){
      const entityId = params.entityId;
      const year = params.year ? Number(params.year) : null;
      if(entityId){
        if(year) dbRun("DELETE FROM pac_plans WHERE entidad_id=? AND year=?", [entityId, year]);
        else dbRun("DELETE FROM pac_plans WHERE entidad_id=?", [entityId]);
      } else if(year){
        dbRun("DELETE FROM pac_plans WHERE year=?", [year]);
      } else {
        dbRun("DELETE FROM pac_plans");
      }
      return json(res, 200, {ok:true});
    }

    const planMatch = pathname.match(/^\/api\/pac\/plan\/(\d+)$/);
    if(planMatch){
      const id = Number(planMatch[1]);
      if(req.method === 'POST'){
        const body = JSON.parse(await collectBody(req));
        const item = updatePlanItem(id, body);
        return json(res, 200, item || {ok:false});
      }
      if(req.method === 'DELETE'){
        dbRun("DELETE FROM pac_plans WHERE id=?", [id]);
        return json(res, 200, {ok:true});
      }
    }

    // -- Global Search / Entity name (F6) --
    if(pathname === '/api/global-search' && req.method === 'GET'){
      const q = params.q || '';
      if(q.trim().length < 1) return json(res, 200, {procesos:[], pac:[], total:0});
      const like = `%${q.trim()}%`;
      const procesos = dbAll(`SELECT ocid, source, title, description, buyer_name, date, modalidad FROM procesos
        WHERE ocid LIKE ? OR title LIKE ? OR description LIKE ? OR buyer_name LIKE ? OR modalidad LIKE ?
        ORDER BY date DESC LIMIT 120`, [like, like, like, like, like]);
      const pac = dbAll(`SELECT id, entidad, entidad_id, year, cpc, partida, descripcion, procedimiento,
        valor_total, estado, ocid FROM pac_plans
        WHERE entidad LIKE ? OR cpc LIKE ? OR descripcion LIKE ? OR partida LIKE ? OR procedimiento LIKE ?
        ORDER BY year DESC, valor_total DESC LIMIT 120`, [like, like, like, like, like]);
      return json(res, 200, {procesos, pac, total: procesos.length + pac.length});
    }

    if(pathname === '/api/entity-name' && req.method === 'GET'){
      const name = await entityNameById(params.ruc || '');
      return json(res, 200, {ruc: params.ruc || '', name});
    }

    // -- Alerts --
    if(pathname === '/api/alerts'){
      if(req.method === 'GET'){
        const unreadOnly = params.unread === '1';
        return json(res, 200, getAlerts(params.radarId || '', unreadOnly));
      }
      if(req.method === 'POST' && params.radarId){
        const body = JSON.parse(await collectBody(req));
        if(body.action === 'read'){
          markAlertsRead(params.radarId);
          return json(res, 200, {ok:true});
        }
      }
      return json(res, 400, {error:'radarId required'});
    }

    if(pathname === '/api/alerts/read' && req.method === 'POST'){
      const radarId = params.radarId;
      if(!radarId) return json(res, 400, {error:'radarId required'});
      markAlertsRead(radarId);
      return json(res, 200, {ok:true});
    }

    // -- Detail Batch --
    if(pathname === '/api/detail-batch' && req.method === 'GET'){
      const ocidsParam = params.ocids || '';
      const ocids = ocidsParam.split(',').map(s=>s.trim()).filter(Boolean);
      if(!ocids.length) return json(res, 400, {error:'ocids required'});
      const result = await fetchDetailBatch(ocids);
      return json(res, 200, result);
    }

    // -- Entity Search --
    if(pathname === '/api/entity-search' && req.method === 'GET'){
      const q = params.q || '';
      const year = params.year || '';
      let sql = "SELECT ocid, source, title, description, buyer_name, date, modalidad FROM procesos WHERE buyer_name LIKE ?";
      const args = [`%${q}%`];
      if(year){ sql += " AND date LIKE ?"; args.push(`${year}%`); }
      sql += " ORDER BY date DESC LIMIT 100";
      return json(res, 200, dbAll(sql, args));
    }

    // -- Entity Live (oportunidades en vivo por entidad) --
    if(pathname === '/api/entity-live' && req.method === 'GET'){
      const q = (params.q || '').trim();
      const year = params.year || String(new Date().getFullYear());
      const term = (params.term || '').trim();
      if(!q) return json(res, 400, {error:'q (entidad) required'});
      let {out, totalAvailable} = {out:[], totalAvailable:0};
      try{
        const r = await fetchSERCOPAllPages(term, year, q, undefined, undefined, true);
        out = r.out; totalAvailable = r.totalAvailable;
      }catch(e){
        return json(res, 502, {error:'SERCOP no respondio: '+e.message});
      }
      const rows = out.map(raw => {
        const row = normalizeSearchRow(raw, term || q);
        if(!row) return null;
        return {
          ocid: row.ocid,
          title: getRowTitle(row),
          description: getRowDescription(row),
          buyer: getBuyerLabel(row),
          date: getRowDate(row),
          modalidad: getRowModality(row),
          valor: firstNonEmpty(row.amount, row.budget, row.tender?.value?.amount) ?? null,
          source: row.source || 'SERCOP'
        };
      }).filter(Boolean);
      return json(res, 200, {count: rows.length, totalAvailable, term, year, buyer:q, rows});
    }

    // -- Entity Follow --
    if(pathname === '/api/entity-follow'){
      if(req.method === 'GET') return json(res, 200, listEntityFollows());
      if(req.method === 'POST'){
        const body = JSON.parse(await collectBody(req));
        followEntity(body.entity_name, body.entity_id, body.radar_ids, body.year);
        return json(res, 200, {ok:true});
      }
    }

    const unfollowMatch = pathname.match(/^\/api\/entity-follow\/(.+)$/);
    if(unfollowMatch){
      const name = decodeURIComponent(unfollowMatch[1]);
      if(req.method === 'DELETE'){
        unfollowEntity(name);
        return json(res, 200, {ok:true});
      }
    }

    // -- 404 --
    json(res, 404, {error:'Not found'});

  } catch(e){
    if(!res.headersSent){
      if(e instanceof SyntaxError) return json(res, 400, {error:'JSON inválido'});
      if(e && e.statusCode) return json(res, e.statusCode, {error: e.statusCode === 413 ? 'carga demasiado grande' : 'solicitud inválida'});
    }
    console.error('Server error:', e);
    if(!res.headersSent) json(res, 500, {error:'error interno del servidor'});
    else res.end();
  }
});

// Bootstrap de credenciales. Si no hay usuarios y no se definió NVG_AUTH_PASS,
// se genera una contraseña aleatoria y se muestra UNA vez en la consola.
async function bootstrapAuth(){
  if(!AUTH_ENABLED){
    console.warn('  ⚠  AUTENTICACIÓN DESACTIVADA (NVG_AUTH=off). No expongas esto a Internet.');
    return;
  }
  if(auth.countUsers(db) === 0){
    const password = AUTH_PASS || auth.randomToken(9).replace(/[-_]/g, '').slice(0, 14);
    await auth.createUser(db, AUTH_USER, password, 'admin');
    if(AUTH_PASS){
      console.log(`  Autenticación: usuario "${AUTH_USER}" creado desde NVG_AUTH_PASS.`);
    } else {
      console.log('\n  ┌──────────────────────────────────────────────────────────┐');
      console.log('  │  Usuario y contraseña iniciales (cámbialos al entrar)     │');
      console.log('  └──────────────────────────────────────────────────────────┘');
      console.log(`     Usuario:    ${AUTH_USER}`);
      console.log(`     Contraseña: ${password}`);
      console.log('     Guárdala ahora: no se volverá a mostrar.\n');
    }
  } else if(AUTH_PASS){
    // Permite fijar/rotar la contraseña del administrador por entorno.
    const existing = auth.getUserByName(db, AUTH_USER);
    if(existing && !(await auth.verifyPassword(AUTH_PASS, existing.pass_hash))){
      await auth.setPassword(db, existing.id, AUTH_PASS);
      console.log(`  Autenticación: contraseña de "${AUTH_USER}" actualizada desde NVG_AUTH_PASS.`);
    }
  }
}

initDB();
bootstrapAuth().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Radar SERCOP v11 — http://${HOST}:${PORT}`);
    console.log(`  Database: ${DB_FILE}`);
    if(AUTH_ENABLED){
      console.log('  Seguridad: login por sesión activo (cookie HttpOnly + CSRF + rate limit).');
      if(AUTH_TOKEN) console.log('  Seguridad: además acepta token de API (NVG_TOKEN) para scripts.');
    }
    const ist = integrations.status();
    if(ist.email){
      const prov = ist.provider === 'graph' ? 'Microsoft Graph (M365/Outlook)' : 'SMTP';
      console.log(`  Integración correo: ${prov} → ${ist.to.join(', ')}${ist.calendar ? ' (+ recordatorios de calendario)' : ''}`);
    } else {
      console.log('  Integración correo: no configurada (Graph o MAIL_*).');
    }
    if(ist.webhook){
      console.log(`  Integración webhook: activa (eventos: ${ist.webhookEvents.join(', ')}).`);
    }
    if(!ALLOW_RESTORE){
      console.log('  Seguridad: restauración de BD deshabilitada (NVG_ALLOW_RESTORE=0).');
    } else if(AUTH_ENABLED){
      console.log('  Aviso: la restauración de BD está habilitada (NVG_ALLOW_RESTORE=1). Ponla a 0 si no la usas.');
    }
    if(HOST === '127.0.0.1') console.log('  Acceso: solo equipo local (configura NVG_HOST para exponer)');
    else console.log(`  Acceso: expuesto en ${HOST} — asegúrate de estar detrás del proxy con TLS.`);
    console.log('');
    startMonitor();
  });
}).catch(e => {
  console.error('No se pudo inicializar la autenticación:', e.message);
  process.exit(1);
});

// Protecciones de red (slowloris / conexiones colgadas).
server.headersTimeout = 20000;
server.requestTimeout = 0; // 0 = sin corte de peticiones largas (necesario para SSE /api/search).
server.keepAliveTimeout = 65000;
server.timeout = 0;        // sin timeout de inactividad de socket (streams SSE abiertos).
