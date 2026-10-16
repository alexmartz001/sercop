const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('./auth');
const { createIntegrations } = require('./integrations');

const TEST_DB = path.join(__dirname, 'test_radar.db');
const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = Number(process.env.TEST_STARTUP_TIMEOUT_MS) || 15000;

// Clean up test DB before/after
function cleanDB(){ 
  for(const f of ['test_radar.db','test_radar.db-wal','test_radar.db-shm']){ 
    const p = path.join(__dirname, f); 
    if(fs.existsSync(p)) fs.unlinkSync(p); 
  }
}

function apiStream(path, timeoutMs = 170000){
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(url, {method:'GET'}, res => {
      const chunks = [];
      const timer = setTimeout(() => { req.destroy(new Error('stream timeout')); }, timeoutMs);
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()});
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseSSE(body){
  const events = [];
  for(const block of String(body || '').split('\n\n')){
    let event = 'message';
    const dataLines = [];
    for(const line of block.split('\n')){
      if(line.startsWith('event:')) event = line.slice(6).trim();
      else if(line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if(!dataLines.length) continue;
    const raw = dataLines.join('');
    try{ events.push({event, data: JSON.parse(raw)}); }
    catch{ events.push({event, data: raw}); }
  }
  return events;
}

function api(path, opts={}){
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(url, {method: opts.method||'GET', headers:{'Content-Type':'application/json', ...opts.headers}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body, raw: Buffer.concat(chunks), json: () => { try{return JSON.parse(body)}catch(e){return null} } });
      });
    });
    req.on('error', reject);
    if(opts.body){
      if(Buffer.isBuffer(opts.body)) req.write(opts.body);
      else req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    }
    req.end();
  });
}

let server;
let DB_PATH;

before(async () => {
  cleanDB();
  // Patch DB_PATH before requiring server
  process.env.TEST_DB = TEST_DB;
  process.env.TEST_PORT = PORT;
  // We need to modify server.js to accept env vars, or just require it
  // Since server.js listens on PORT and uses DB_FILE, let's just use env
  // Actually server.js uses const. Let's just use a subprocess approach.
  // Simpler: require and test via the exported API
  // Even simpler: fork server with env vars
  
  const { fork } = require('node:child_process');
  server = fork(path.join(__dirname, 'server.js'), [], {
    env: { ...process.env, NVG_PORT: PORT, NVG_DB: TEST_DB, NVG_AUTH: 'off' },
    stdio: 'pipe'
  });
  
  // Wait for server to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), STARTUP_TIMEOUT_MS);
    server.stdout.on('data', (data) => {
      if(data.toString().includes(':' + PORT)){
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
  DB_PATH = TEST_DB;
});

after(async () => {
  if(server){
    const p = new Promise(resolve => { server.on('exit', resolve); server.kill(); });
    await Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
  }
  cleanDB();
});

describe('Server API', () => {

  it('GET /api/stats returns empty counts', async () => {
    const r = await api('/api/stats');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.radarCount, 0);
    assert.equal(d.procCount, 0);
  });

  it('POST /api/radares creates a radar', async () => {
    const radar = {id:'r_test', nombre:'Test', year:2025, search:'firewall', buyer:'', supplier:'', source:'sercop'};
    const r = await api('/api/radares', {method:'POST', body:radar});
    assert.equal(r.status, 201);
    assert.equal(r.json().id, 'r_test');
  });

  it('GET /api/radares lists radars', async () => {
    const r = await api('/api/radares');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.length, 1);
    assert.equal(d[0].nombre, 'Test');
  });

  it('PUT /api/radares/:id updates a radar', async () => {
    const r = await api('/api/radares/r_test', {method:'PUT', body:{nombre:'Updated', year:2025, search:'firewall', buyer:'', supplier:'', source:'sercop'}});
    assert.equal(r.status, 200);
    assert.equal(r.json().nombre, 'Updated');
  });

  it('GET /api/seen/:id returns empty for new radar', async () => {
    const r = await api('/api/seen/r_test');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), []);
  });

  it('POST /api/seen/:id marks ocids as seen', async () => {
    const r = await api('/api/seen/r_test', {method:'POST', body:{ocids:['oc-1','oc-2']}});
    assert.equal(r.status, 200);
    const r2 = await api('/api/seen/r_test');
    assert.deepEqual(r2.json().sort(), ['oc-1','oc-2']);
  });

  // Create a second radar for cross-cutting tests
  it('POST /api/radares creates second radar', async () => {
    const radar = {id:'r_test2', nombre:'Test 2', year:2025, search:'software', buyer:'', supplier:'', source:'sercop'};
    const r = await api('/api/radares', {method:'POST', body:radar});
    assert.equal(r.status, 201);
  });

  it('GET /api/pipeline returns empty initially', async () => {
    const r = await api('/api/pipeline');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), {});
  });

  it('POST /api/pipeline/:id creates entry', async () => {
    const entry = {status:'Nuevo interés', notas:'', entidad:'Entidad', titulo:'Proceso', modalidad:'Licitación', etapaLabel:'Ofertas', valor:'$1000', cierre:'2025-12-31', publicado:'2025-01-01', actualizado:'2025-01-01', cpcs:[], source:'SERCOP', etiquetas:[{name:'urgencia', color:'#DC2626'}], proveedores:['CASA S.A.']};
    const r = await api('/api/pipeline/oc-test', {method:'POST', body:entry});
    assert.equal(r.status, 200);
    const r2 = await api('/api/pipeline');
    assert.ok(r2.json()['oc-test']);
    assert.equal(r2.json()['oc-test'].status, 'Nuevo interés');
    assert.deepEqual(r2.json()['oc-test'].etiquetas, [{name:'urgencia', color:'#DC2626'}]);
  });

  it('GET /api/mercado returns aggregation contract', async () => {
    const r = await api('/api/mercado');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(typeof d.totalProcesos, 'number');
    assert.equal(typeof d.totalAdjudicado, 'number');
    assert.equal(typeof d.totalProveedores, 'number');
    assert.ok(Array.isArray(d.entidades));
    assert.ok(Array.isArray(d.proveedores));
    assert.ok(Array.isArray(d.cpcs));
    assert.ok(Array.isArray(d.adjudicaciones));
    if(d.entidades.length) assert.ok('entidad' in d.entidades[0] && 'valor' in d.entidades[0]);
    if(d.cpcs.length) assert.ok('promedio' in d.cpcs[0]);
    // Filters validate without throwing
    const rf = await api('/api/mercado?year=2999&cpc=999999&entidad=nonexistent');
    assert.equal(rf.status, 200);
  });

  it('GET /api/config exposes mail status', async () => {
    const r = await api('/api/config');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json().email, 'boolean');
    assert.ok(Array.isArray(r.json().to));
  });

  it('DELETE /api/pipeline/:id removes entry', async () => {
    const r = await api('/api/pipeline/oc-test', {method:'DELETE'});
    assert.equal(r.status, 200);
    const r2 = await api('/api/pipeline');
    assert.deepEqual(r2.json(), {});
  });

  it('POST pipeline persists CRM offer fields', async () => {
    const entry = {status:'Oferta presentada', notas:'', entidad:'Entidad', titulo:'Proceso', modalidad:'Licitación', etapaLabel:'Ofertas', valor:'$5000', cierre:'2025-12-31', publicado:'2025-01-01', actualizado:'2025-01-01', cpcs:[], source:'SERCOP', etiquetas:[], fechaPresentacion:'2025-12-20', montoOferta:'5200', competidores:'Empresa A', contacto:'persona@empresa.com'};
    const r = await api('/api/pipeline/oc-crm', {method:'POST', body:entry});
    assert.equal(r.status, 200);
    const r2 = await api('/api/pipeline');
    const got = r2.json()['oc-crm'];
    assert.equal(got.status, 'Oferta presentada');
    assert.equal(got.fechaPresentacion, '2025-12-20');
    assert.equal(got.montoOferta, '5200');
    assert.equal(got.competidores, 'Empresa A');
    assert.equal(got.contacto, 'persona@empresa.com');
    const r3 = await api('/api/pipeline/oc-crm', {method:'DELETE'});
    assert.equal(r3.status, 200);
  });

  it('POST /api/pipeline/refresh responds with empty pipeline (no network)', async () => {
    const r = await api('/api/pipeline/refresh', {method:'POST'});
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.ok, true);
    assert.equal(typeof d.changed, 'number');
  });

  it('GET /api/entity-live validates query input', async () => {
    const empty = await api('/api/entity-live?q=&year=2026');
    assert.equal(empty.status, 400);
    const missing = await api('/api/entity-live?year=2026');
    assert.equal(missing.status, 400);
    const shortTerm = await api('/api/entity-live?q=Municipio&year=2026&term=ab');
    assert.equal(shortTerm.status, 400);
    const shortBuyer = await api('/api/entity-live?q=EP&year=2026&term=agua');
    assert.equal(shortBuyer.status, 400);
  });

  it('GET /api/nco validates query input', async () => {
    const r = await api('/api/nco?q=abc');
    assert.equal(r.status, 400);
  });

  it('DELETE /api/radares/:id deletes radar and seen', async () => {
    const r = await api('/api/radares/r_test', {method:'DELETE'});
    assert.equal(r.status, 200);
    const r2 = await api('/api/radares');
    const remaining = r2.json().filter(r => r.id !== 'r_test2');
    assert.equal(remaining.length, 0);
  });

  // Clean up second radar
  it('Cleanup: delete second radar', async () => {
    const r = await api('/api/radares/r_test2', {method:'DELETE'});
    assert.equal(r.status, 200);
  });

  it('GET /api/db returns valid sqlite file', async () => {
    const r = await api('/api/db');
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 0);
    // Check SQLite magic header "SQLite format 3\0"
    assert.ok(r.body.startsWith('SQLite format 3'));
  });

  it('GET / serves HTML', async () => {
    const r = await api('/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('Radar de Oportunidades'));
    // CSP: los scripts solo por nonce (sin 'unsafe-inline') y nonce en el HTML.
    const csp = r.headers['content-security-policy'] || '';
    assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'script-src no debe permitir unsafe-inline');
    const m = r.body.match(/<script nonce="([^"]+)">/);
    assert.ok(m, 'el HTML debe incluir un <script nonce="…">');
    assert.ok(csp.includes(m[1]), 'el nonce del HTML debe coincidir con el de la CSP');
    assert.ok(r.body.includes('data-act="switch-tab"'), 'los handlers inline deben migrarse a data-act');
    assert.ok(!/\son(click|change|mousedown|mouseover|mouseout)="/.test(r.body), 'no debe quedar ningún handler inline en atributos');
    assert.ok(!/\son(click|change|mousedown)='/.test(r.body), 'no debe quedar ningún handler inline con comilla simple');
  });

  it('Stats reflect DB changes', async () => {
    // Create another radar to verify count
    await api('/api/radares', {method:'POST', body:{id:'r_stats', nombre:'Stats Test', year:2025, search:'test', buyer:'', supplier:'', source:'sercop'}});
    const r = await api('/api/stats');
    const d = r.json();
    assert.ok(d.radarCount >= 1);
    assert.ok(d.cacheCount >= 0);
    assert.equal(typeof d.alertCount, 'number');
    // Clean up
    await api('/api/radares/r_stats', {method:'DELETE'});
  });

  it('POST /api/alerts/read marks alerts as read', async () => {
    const r = await api('/api/alerts/read?radarId=r_test2', {method:'POST'});
    assert.equal(r.status, 200);
  });

  it('GET /api/alerts returns alerts for radar', async () => {
    const r = await api('/api/alerts?radarId=r_test2');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json()));
  });

  it('GET /api/detail-batch returns empty for unknown ocids', async () => {
    const r = await api('/api/detail-batch?ocids=nonexistent');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.ok(typeof d === 'object');
  });

  it('GET /api/entity-search returns array', async () => {
    const r = await api('/api/entity-search?q=test');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json()));
  });

  it('GET /api/entity-follow returns array', async () => {
    const r = await api('/api/entity-follow');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json()));
  });

  it('POST /api/entity-follow creates follow', async () => {
    const r = await api('/api/entity-follow', {method:'POST', body:{entity_name:'Test Entity', entity_id:'999', radar_ids:'r_test2', year:2025}});
    assert.equal(r.status, 200);
    const list = await api('/api/entity-follow');
    const follows = list.json();
    assert.ok(follows.some(f => f.entity_name === 'Test Entity'));
  });

  it('DELETE /api/entity-follow/:name removes follow', async () => {
    const r = await api('/api/entity-follow/Test%20Entity', {method:'DELETE'});
    assert.equal(r.status, 200);
  });

  it('Radar with monitor and cpcs fields', async () => {
    const radar = {id:'r_mon', nombre:'Monitor Test', year:2025, search:'firewall', cpcs:'839530013', source:'sercop', monitor:true, monitor_interval:10};
    const r = await api('/api/radares', {method:'POST', body:radar});
    assert.equal(r.status, 201);
    const list = await api('/api/radares');
    const found = list.json().find(r => r.id === 'r_mon');
    assert.ok(found);
    assert.equal(found.cpcs, '839530013');
    assert.equal(found.monitor, 1);
    // Update
    await api('/api/radares/r_mon', {method:'PUT', body:{...radar, monitor:false}});
    const updated = await api('/api/radares');
    const found2 = updated.json().find(r => r.id === 'r_mon');
    assert.equal(found2.monitor, 0);
    // Clean up
    await api('/api/radares/r_mon', {method:'DELETE'});
  });

  it('Radar supports all sources option', async () => {
    const radar = {id:'r_all', nombre:'All Sources', year:2026, search:'seguridad', source:'todas'};
    const r = await api('/api/radares', {method:'POST', body:radar});
    assert.equal(r.status, 201);
    const list = await api('/api/radares');
    const found = list.json().find(r => r.id === 'r_all');
    assert.equal(found.source, 'todas');
    await api('/api/radares/r_all', {method:'DELETE'});
  });

  it('GET /api/alerts returns alerts without radarId', async () => {
    const r = await api('/api/alerts');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json()));
  });

  it('GET /api/pac/xref returns contract shape', async () => {
    await api('/api/radares', {method:'POST', body:{id:'r_xref', nombre:'Xref Test', year:2025, search:'firewall', buyer:'', supplier:'', source:'sercop'}});
    try{
      const r = await api('/api/pac/xref?radarId=r_xref&year=2025');
      assert.equal(r.status, 200);
      const d = r.json();
      assert.equal(d.error, undefined);
      assert.equal(typeof d.totalPac, 'number');
      assert.equal(typeof d.matched, 'number');
      assert.ok(Array.isArray(d.matches));
      assert.ok(Array.isArray(d.unmatched));
    } finally {
      await api('/api/radares/r_xref', {method:'DELETE'});
    }
  });

  it('POST /api/db rejects invalid backups and keeps server alive', async () => {
    const bad = await api('/api/db', {method:'POST', body:Buffer.from('esto no es una base sqlite')});
    assert.equal(bad.status, 400);
    const alive = await api('/api/stats');
    assert.equal(alive.status, 200);
  });

  it('POST /api/db restores a valid backup', async () => {
    const backup = await api('/api/db');
    assert.equal(backup.status, 200);
    assert.ok(backup.raw.slice(0,15).toString('latin1').startsWith('SQLite format 3'));
    const r = await api('/api/db', {method:'POST', body:backup.raw});
    assert.equal(r.status, 200);
    assert.equal(r.json().ok, true);
    const stats = await api('/api/stats');
    assert.equal(stats.status, 200);
  });

  it('GET /api/pac/entities returns entities', async () => {
    const r = await api('/api/pac/entities?q=banco');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json()));
  });

  it('GET /api/pac/plan returns plan rows shape', async () => {
    const r = await api('/api/pac/plan');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json()));
  });

  it('POST /api/pac/plan requires entityId', async () => {
    const r = await api('/api/pac/plan', {method:'POST', body:{year:2026}});
    assert.equal(r.status, 400);
  });

  it('POST /api/pac/plan/:id returns ok:false for unknown id', async () => {
    const r = await api('/api/pac/plan/9999', {method:'POST', body:{estado:'publicado'}});
    assert.equal(r.status, 200);
    assert.equal(r.json().ok, false);
  });

  it('GET /api/pac/plan supports filters', async () => {
    const r = await api('/api/pac/plan?year=2026&estado=pendiente&cpc=8395');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json()));
  });

  it('GET /api/global-search returns shape', async () => {
    const r = await api('/api/global-search?q=test');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.ok(Array.isArray(d.procesos));
    assert.ok(Array.isArray(d.pac));
    assert.equal(typeof d.total, 'number');
    const empty = await api('/api/global-search');
    assert.equal(empty.status, 200);
    assert.equal(empty.json().total, 0);
  });

  it('GET /api/entity-name validates ruc', async () => {
    const r = await api('/api/entity-name');
    assert.equal(r.status, 200);
    assert.equal(r.json().name, '');
  });

  it('DELETE /api/pac/plan-clear works', async () => {
    const r = await api('/api/pac/plan-clear', {method:'DELETE'});
    assert.equal(r.status, 200);
    assert.equal(r.json().ok, true);
    const list = await api('/api/pac/plan');
    assert.equal(list.status, 200);
  });

  it('SERCOP no consulta palabras o años fuera del contrato', async () => {
    const id = 'r_sercop_contract';
    const created = await api('/api/radares', {method:'POST', body:{
      id, nombre:'Contrato', year:2099, source:'sercop', buyer:'EP', supplier:'AB', search:'ab,agua'
    }});
    assert.equal(created.status, 201);
    const r = await apiStream(`/api/search?radarId=${encodeURIComponent(id)}`, 15000);
    assert.equal(r.status, 200);
    const events = parseSSE(r.body);
    const done = events.find(e => e.event === 'done');
    assert.ok(done, 'la búsqueda debe cerrar sin llamar al portal');
    const warnings = events.filter(e => e.event === 'warning').map(e => e.data?.message || '').join(' ');
    assert.match(warnings, /al menos 3 caracteres/);
    assert.match(warnings, /solo admite años/);
    assert.equal(done.data.total, 0);
    assert.equal((events.filter(e => e.event === 'result')).length, 0);
    const deleted = await api(`/api/radares/${id}`, {method:'DELETE'});
    assert.equal(deleted.status, 200);
  });

  it('búsqueda SERCOP sigue cuando una IP del portal no responde', {timeout: 90000}, async () => {
    const id = 'r_sercop_live';
    const created = await api('/api/radares', {method:'POST', body:{
      id, nombre:'LOPDP', year:2026, source:'sercop', buyer:'', supplier:'',
      search:'LOPDP'
    }});
    assert.equal(created.status, 201);
    const r = await apiStream(`/api/search?radarId=${encodeURIComponent(id)}`);
    assert.equal(r.status, 200);
    const events = parseSSE(r.body);
    const done = events.find(e => e.event === 'done');
    assert.ok(done, 'la búsqueda debe emitir done');
    const warnings = (done.data.warnings || []).join(' ');
    assert.equal(warnings.includes('fetch failed'), false, warnings);
    assert.equal(/conexión fallida|HTTP 429/.test(warnings), false, warnings);
    assert.ok(done.data.total > 0, 'SERCOP debe devolver procesos para esas palabras');
    const rows = events.filter(e => e.event === 'result').map(e => e.data);
    assert.ok(rows.some(row => row && row.buyerName && row.buyerName !== '—'), 'search_ocds trae la entidad en buyer o buyerName');
    const deleted = await api(`/api/radares/${id}`, {method:'DELETE'});
    assert.equal(deleted.status, 200);
  });

  it('todas las fuentes muestra los procesos SERCOP de Hacking Etico y LOPDP', {timeout: 170000}, async () => {
    const id = 'r_todas_live';
    const created = await api('/api/radares', {method:'POST', body:{
      id, nombre:'Seguridad', year:2026, source:'todas', buyer:'', supplier:'',
      search:'Hacking Etico, LOPDP'
    }});
    assert.equal(created.status, 201);
    const r = await apiStream(`/api/search?radarId=${encodeURIComponent(id)}`);
    assert.equal(r.status, 200);
    const events = parseSSE(r.body);
    const done = events.find(e => e.event === 'done');
    assert.ok(done, 'la búsqueda debe emitir done');
    assert.ok(done.data.total >= 2, `se esperaban al menos 2 procesos, llegaron ${done.data.total}`);
    const rows = events.filter(e => e.event === 'result').map(e => e.data);
    const blob = rows.map(row => [row?.buyerName, row?.title, row?.description, row?.ocid].filter(Boolean).join(' ')).join('\n');
    assert.match(blob, /Yachay|LOPDP/i);
    assert.match(blob, /EL[EÉ]CTRICA QUITO|AGUAPEN|HACKING/i);
    const firstResult = r.body.indexOf('event: result');
    const firstSlow = r.body.search(/event: warning|NCO error|UNDP error/);
    assert.ok(firstResult > 0, 'debe haber eventos result');
    if(firstSlow > 0) assert.ok(firstResult < firstSlow, 'SERCOP tiene que llegar antes de las fuentes lentas');
    const saved = await api(`/api/radares/${encodeURIComponent(id)}/results`);
    assert.equal(saved.status, 200);
    assert.ok(saved.json().length >= 2, 'los procesos deben quedar guardados en el radar');
    const deleted = await api(`/api/radares/${id}`, {method:'DELETE'});
    assert.equal(deleted.status, 200);
  });

});

describe('Auth (NVG_TOKEN)', () => {
  const TOKEN = 'test-super-secreto';
  const AUTH_PORT = 3212;
  const AUTH_BASE = `http://localhost:${AUTH_PORT}`;
  const AUTH_DB = path.join(__dirname, 'test_auth.db');
  let authServer;
  let authSrvReady = false;

  const aapi = (path, opts={}, token) => new Promise((resolve, reject) => {
    const headers = {'Content-Type':'application/json'};
    if(token) headers['Authorization'] = 'Bearer ' + token;
    const url = new URL(token && !opts.useQuery ? path : path, AUTH_BASE);
    if(opts.useQuery && token) url.searchParams.set('token', token);
    const req = http.request(url, {method: opts.method||'GET', headers}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body, json: () => { try{return JSON.parse(body)}catch(e){return null} } });
      });
    });
    req.on('error', reject);
    req.end();
  });

  before(async () => {
    for(const f of ['test_auth.db','test_auth.db-wal','test_auth.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
    const { fork } = require('node:child_process');
    authServer = fork(path.join(__dirname, 'server.js'), [], {
      env: { ...process.env, NVG_PORT: AUTH_PORT, NVG_DB: AUTH_DB, NVG_TOKEN: TOKEN },
      stdio: 'pipe'
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Auth server startup timeout')), STARTUP_TIMEOUT_MS);
      authServer.stdout.on('data', (data) => {
        if(data.toString().includes(':' + AUTH_PORT)){ clearTimeout(timeout); resolve(); }
      });
      authServer.on('error', e => { clearTimeout(timeout); reject(e); });
    });
    authSrvReady = true;
  });

  after(async () => {
    if(authServer){
      const p = new Promise(resolve => { authServer.on('exit', resolve); authServer.kill(); });
      await Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
    }
    for(const f of ['test_auth.db','test_auth.db-wal','test_auth.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('rejects /api/* without token (401)', async () => {
    const r = await aapi('/api/stats');
    assert.equal(r.status, 401);
  });

  it('accepts /api/* with Bearer token', async () => {
    const r = await aapi('/api/stats', {}, TOKEN);
    assert.equal(r.status, 200);
  });

  it('accepts /api/* with ?token= query param', async () => {
    const r = await aapi('/api/stats', {useQuery:true}, TOKEN);
    assert.equal(r.status, 200);
  });

  it('serves static / without token', async () => {
    const p = AUTH_BASE + '/';
    const r = await new Promise((resolve, reject) => {
      http.get(p, res => {
        const chunks=[];
        res.on('data', c=>chunks.push(c));
        res.on('end', ()=>resolve({status:res.statusCode}));
      }).on('error', reject);
    });
    assert.equal(r.status, 200);
  });

  it('protects /api/db write with token', async () => {
    const no = await aapi('/api/db', {method:'POST', body:Buffer.from('x')});
    assert.equal(no.status, 401);
  });
});

describe('Auth (sesión con cookie + CSRF)', () => {
  const USER = 'admin';
  const PASS = 'clave-super-larga-123';
  const SESS_PORT = 3214;
  const SESS_BASE = `http://localhost:${SESS_PORT}`;
  const SESS_DB = path.join(__dirname, 'test_session.db');
  let srv;
  let cookie = '';
  let csrf = '';

  const sapi = (path, opts = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, SESS_BASE);
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if(opts.cookie) headers['Cookie'] = opts.cookie;
    const req = http.request(url, { method: opts.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body, headers: res.headers, json: () => { try{ return JSON.parse(body); }catch(_){ return null; } } });
      });
    });
    req.on('error', reject);
    if(opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });

  function extractCookie(res){
    const set = res.headers['set-cookie'];
    if(!set || !set.length) return '';
    return set[0].split(';')[0];
  }

  before(async () => {
    for(const f of ['test_session.db','test_session.db-wal','test_session.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
    const { fork } = require('node:child_process');
    srv = fork(path.join(__dirname, 'server.js'), [], {
      env: { ...process.env, NVG_PORT: SESS_PORT, NVG_DB: SESS_DB, NVG_AUTH_USER: USER, NVG_AUTH_PASS: PASS, NVG_SECURE_COOKIES: '0' },
      stdio: 'pipe'
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Session server startup timeout')), STARTUP_TIMEOUT_MS);
      srv.stdout.on('data', d => { if(d.toString().includes(':' + SESS_PORT)){ clearTimeout(timeout); resolve(); } });
      srv.on('error', e => { clearTimeout(timeout); reject(e); });
    });
  });

  after(async () => {
    if(srv){
      const p = new Promise(resolve => { srv.on('exit', resolve); srv.kill(); });
      await Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
    }
    for(const f of ['test_session.db','test_session.db-wal','test_session.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('GET /login serves the login page', async () => {
    const r = await sapi('/login');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('Radar de Oportunidades'));
    assert.ok(r.body.includes('Definir acceso'));
  });

  it('GET /api/auth/session reports unauthenticated', async () => {
    const r = await sapi('/api/auth/session');
    assert.equal(r.status, 200);
    assert.equal(r.json().authenticated, false);
    assert.equal(r.json().setupRequired, false);
  });

  it('rejects /api/* without session (401)', async () => {
    const r = await sapi('/api/stats');
    assert.equal(r.status, 401);
  });

  it('rejects login with wrong password (401)', async () => {
    const r = await sapi('/api/auth/login', { method: 'POST', body: { username: USER, password: 'incorrecta' } });
    assert.equal(r.status, 401);
  });

  it('logs in with correct credentials and sets a hardened cookie', async () => {
    const r = await sapi('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
    assert.equal(r.status, 200);
    assert.equal(r.json().ok, true);
    csrf = r.json().csrf;
    assert.ok(csrf && csrf.length >= 32);
    const setCookie = (r.headers['set-cookie'] || [])[0] || '';
    assert.ok(/HttpOnly/i.test(setCookie));
    assert.ok(/SameSite=Strict/i.test(setCookie));
    cookie = extractCookie(r);
    assert.ok(cookie.startsWith('nvg_session='));
  });

  it('accepts /api/* with the session cookie', async () => {
    const r = await sapi('/api/stats', { cookie });
    assert.equal(r.status, 200);
  });

  it('includes security headers', async () => {
    const r = await sapi('/api/stats', { cookie });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.ok(r.headers['content-security-policy']);
    assert.match(r.headers['content-security-policy'], /script-src 'self' 'nonce-/);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('blocks session mutations without CSRF token (403)', async () => {
    const r = await sapi('/api/radares', { method: 'POST', cookie, body: { id: 'r_csrf', nombre: 'x', year: 2025, search: 'test', source: 'sercop' } });
    assert.equal(r.status, 403);
  });

  it('allows session mutations with CSRF token', async () => {
    const r = await sapi('/api/radares', { method: 'POST', cookie, headers: { 'X-CSRF-Token': csrf }, body: { id: 'r_csrf', nombre: 'CSRF ok', year: 2025, search: 'test', source: 'sercop' } });
    assert.equal(r.status, 201);
    const del = await sapi('/api/radares/r_csrf', { method: 'DELETE', cookie, headers: { 'X-CSRF-Token': csrf } });
    assert.equal(del.status, 200);
  });

  it('changes the password and invalidates the old one', async () => {
    const NEWPASS = 'otra-clave-larga-456';
    const THIRD = 'tercera-clave-7890';
    // El panel envía current/next; la API también acepta currentPassword/newPassword.
    const r = await sapi('/api/auth/change-password', { method: 'POST', cookie, headers: { 'X-CSRF-Token': csrf }, body: { current: PASS, next: NEWPASS } });
    assert.equal(r.status, 200);
    assert.equal(r.json().ok, true);
    const newCookie = extractCookie(r);
    assert.ok(newCookie);
    const newCsrf = r.json().csrf;
    const oldLogin = await sapi('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
    assert.equal(oldLogin.status, 401);
    const newLogin = await sapi('/api/auth/login', { method: 'POST', body: { username: USER, password: NEWPASS } });
    assert.equal(newLogin.status, 200);
    cookie = extractCookie(newLogin);
    csrf = newLogin.json().csrf;
    const again = await sapi('/api/auth/change-password', { method: 'POST', cookie, headers: { 'X-CSRF-Token': csrf }, body: { currentPassword: NEWPASS, newPassword: THIRD } });
    assert.equal(again.status, 200);
    const thirdLogin = await sapi('/api/auth/login', { method: 'POST', body: { username: USER, password: THIRD } });
    assert.equal(thirdLogin.status, 200);
    const stale = await sapi('/api/auth/login', { method: 'POST', body: { username: USER, password: NEWPASS } });
    assert.equal(stale.status, 401);
    cookie = extractCookie(thirdLogin);
    csrf = thirdLogin.json().csrf;
    assert.ok(cookie && csrf && newCsrf);
  });

  it('rejects oversized JSON bodies (413)', async () => {
    const big = { pad: 'x'.repeat(6 * 1024 * 1024) };
    const r = await sapi('/api/radares', { method: 'POST', cookie, headers: { 'X-CSRF-Token': csrf }, body: big });
    assert.equal(r.status, 413);
  });

  it('logs out and invalidates the session', async () => {
    const out = await sapi('/api/auth/logout', { method: 'POST', cookie, headers: { 'X-CSRF-Token': csrf } });
    assert.equal(out.status, 200);
    const after = await sapi('/api/stats', { cookie });
    assert.equal(after.status, 401);
  });

  it('rate-limits repeated failed logins (429)', async () => {
    let saw429 = false;
    for(let i = 0; i < 8; i++){
      const r = await sapi('/api/auth/login', { method: 'POST', body: { username: USER, password: 'mala' } });
      if(r.status === 429){ saw429 = true; break; }
    }
    assert.ok(saw429, 'se esperaba un 429 tras varios intentos fallidos');
  });
});

describe('Acceso inicial sin clave oculta', () => {
  const SETUP_PORT = 3217;
  const SETUP_BASE = `http://127.0.0.1:${SETUP_PORT}`;
  const SETUP_DB = path.join(__dirname, 'test_setup.db');
  const RECLAIM_PORT = 3218;
  const RECLAIM_BASE = `http://127.0.0.1:${RECLAIM_PORT}`;
  const RECLAIM_DB = path.join(__dirname, 'test_reclaim.db');
  const OLD_PASS = 'clave-original-oculta';
  const NEW_PASS = 'clave-definida-en-login';
  let setupSrv;
  let reclaimSrv;
  let setupLog = '';
  let reclaimLog = '';

  function httpJson(base, path, opts = {}){
    return new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if(opts.cookie) headers.Cookie = opts.cookie;
      const req = http.request(url, { method: opts.method || 'GET', headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            json: () => { try{ return JSON.parse(body); }catch(_){ return null; } }
          });
        });
      });
      req.on('error', reject);
      if(opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  }

  function startSrv(port, dbFile, extraEnv = {}){
    const { fork } = require('node:child_process');
    const chunks = [];
    const srv = fork(path.join(__dirname, 'server.js'), [], {
      env: {
        ...process.env,
        NVG_PORT: String(port),
        NVG_DB: dbFile,
        NVG_AUTH: 'on',
        NVG_AUTH_USER: 'admin',
        NVG_AUTH_PASS: '',
        NVG_SECURE_COOKIES: '0',
        NVG_HOST: '127.0.0.1',
        ...extraEnv
      },
      stdio: 'pipe'
    });
    srv.stdout.on('data', d => chunks.push(d.toString()));
    srv.stderr.on('data', d => chunks.push(d.toString()));
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('startup timeout '+port+'\n'+chunks.join(''))), STARTUP_TIMEOUT_MS);
      srv.stdout.on('data', d => {
        if(d.toString().includes(':' + port)){ clearTimeout(timeout); resolve(); }
      });
      srv.on('error', e => { clearTimeout(timeout); reject(e); });
    });
    return { srv, ready, log: () => chunks.join('') };
  }

  async function stopSrv(srv){
    if(!srv) return;
    const p = new Promise(resolve => { srv.on('exit', resolve); srv.kill(); });
    await Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
  }

  before(async () => {
    for(const f of ['test_setup.db','test_setup.db-wal','test_setup.db-shm','test_reclaim.db','test_reclaim.db-wal','test_reclaim.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
    const Database = require('better-sqlite3');
    const seeded = new Database(RECLAIM_DB);
    auth.initSchema(seeded);
    await auth.createUser(seeded, 'admin', OLD_PASS, 'admin', { claimed: false });
    seeded.exec(`CREATE TABLE IF NOT EXISTS radares(
      id TEXT PRIMARY KEY, nombre TEXT, year INTEGER, search TEXT,
      buyer TEXT, supplier TEXT, source TEXT,
      created_at TEXT DEFAULT (datetime('now')))`);
    seeded.prepare("INSERT INTO radares(id, nombre, year, search, source) VALUES('r1','Radar vivo',2026,'agua','sercop')").run();
    seeded.close();

    const setup = startSrv(SETUP_PORT, SETUP_DB, { NVG_AUTH_PASS: 'corta' });
    const reclaim = startSrv(RECLAIM_PORT, RECLAIM_DB);
    setupSrv = setup.srv;
    reclaimSrv = reclaim.srv;
    await Promise.all([setup.ready, reclaim.ready]);
    setupLog = setup.log();
    reclaimLog = reclaim.log();
  });

  after(async () => {
    await stopSrv(setupSrv);
    await stopSrv(reclaimSrv);
    for(const f of ['test_setup.db','test_setup.db-wal','test_setup.db-shm','test_reclaim.db','test_reclaim.db-wal','test_reclaim.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('defines the password on /login when the deploy did not provide one', async () => {
    assert.doesNotMatch(setupLog, /Contraseña:/);
    assert.match(setupLog, /no se generó otra clave/i);
    const session = await httpJson(SETUP_BASE, '/api/auth/session');
    assert.equal(session.json().setupRequired, true);
    assert.equal(session.json().suggestedUsername, 'admin');
    const login = await httpJson(SETUP_BASE, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'corta' } });
    assert.equal(login.status, 401);
    const page = await httpJson(SETUP_BASE, '/login');
    assert.equal(page.status, 200);
    assert.match(page.body, /Definir acceso/);
    const bad = await httpJson(SETUP_BASE, '/api/auth/setup', { method: 'POST', body: { username: 'admin', password: NEW_PASS, passwordConfirm: 'otra-distinta-12' } });
    assert.equal(bad.status, 400);
    const created = await httpJson(SETUP_BASE, '/api/auth/setup', { method: 'POST', body: { username: 'admin', password: NEW_PASS, passwordConfirm: NEW_PASS } });
    assert.equal(created.status, 200);
    assert.equal(created.json().ok, true);
    const setCookie = (created.headers['set-cookie'] || [])[0] || '';
    assert.match(setCookie, /nvg_session=/);
    const again = await httpJson(SETUP_BASE, '/api/auth/setup', { method: 'POST', body: { username: 'admin', password: NEW_PASS, passwordConfirm: NEW_PASS } });
    assert.equal(again.status, 409);
    const closed = await httpJson(SETUP_BASE, '/api/auth/session');
    assert.equal(closed.json().setupRequired, false);

    await stopSrv(setupSrv);
    const restarted = startSrv(SETUP_PORT, SETUP_DB);
    setupSrv = restarted.srv;
    await restarted.ready;
    const after = await httpJson(SETUP_BASE, '/api/auth/session');
    assert.equal(after.json().setupRequired, false);
    assert.equal(after.json().authenticated, false);
    const relogin = await httpJson(SETUP_BASE, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: NEW_PASS } });
    assert.equal(relogin.status, 200);
    const hidden = await httpJson(SETUP_BASE, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'corta' } });
    assert.equal(hidden.status, 401);
  });

  it('drops an unused generated password and keeps radar data', async () => {
    assert.match(reclaimLog, /No se generó una clave nueva/);
    assert.doesNotMatch(reclaimLog, new RegExp(OLD_PASS));
    const session = await httpJson(RECLAIM_BASE, '/api/auth/session');
    assert.equal(session.json().setupRequired, true);
    const oldLogin = await httpJson(RECLAIM_BASE, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: OLD_PASS } });
    assert.equal(oldLogin.status, 401);
    const created = await httpJson(RECLAIM_BASE, '/api/auth/setup', { method: 'POST', body: { username: 'admin', password: NEW_PASS, passwordConfirm: NEW_PASS } });
    assert.equal(created.status, 200);
    const cookie = ((created.headers['set-cookie'] || [])[0] || '').split(';')[0];
    const list = await httpJson(RECLAIM_BASE, '/api/radares', { cookie });
    assert.equal(list.status, 200);
    assert.match(list.body, /Radar vivo/);
  });
});

describe('Limitador persistente (B5)', () => {
  const Database = require('better-sqlite3');

  it('bloquea de forma persistente entre instancias (reinicio)', () => {
    const db = new Database(':memory:');
    auth.initSchema(db);
    const store = new auth.RateLimitStore(db);
    const mk = () => new auth.RateLimiter({ windowMs: 1000, max: 2, blockMs: 60000, name: 'unit', store });

    const l1 = mk();
    assert.equal(l1.hit('k').allowed, true);
    assert.equal(l1.hit('k').allowed, true);
    const blocked = l1.hit('k');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);

    // Simula un reinicio del proceso: nueva instancia, mismo almacén.
    const l2 = mk();
    const afterRestart = l2.hit('k');
    assert.equal(afterRestart.allowed, false, 'el bloqueo debe sobrevivir al reinicio');
    db.close();
  });

  it('reset() limpia el bloqueo también en el almacén', () => {
    const db = new Database(':memory:');
    auth.initSchema(db);
    const store = new auth.RateLimitStore(db);
    const l = new auth.RateLimiter({ windowMs: 1000, max: 1, blockMs: 60000, name: 'unit2', store });
    l.hit('k'); l.hit('k');
    assert.equal(l.hit('k').allowed, false);
    l.reset('k');
    const l2 = new auth.RateLimiter({ windowMs: 1000, max: 1, blockMs: 60000, name: 'unit2', store });
    assert.equal(l2.hit('k').allowed, true);
    db.close();
  });
});

describe('Integraciones (webhook + Graph)', () => {
  const INT_PORT = 3215;
  const INT_BASE = `http://localhost:${INT_PORT}`;
  const INT_DB = path.join(__dirname, 'test_integrations.db');
  const HOOK_SECRET = 'secreto-de-prueba';
  const TG_TOKEN = '123456:TEST-token-telegram';
  const TG_PORT = 32150;
  const TG_BASE = `http://127.0.0.1:${TG_PORT}`;
  let tgServer;
  let tgReceived = [];
  let srv;
  let hookServer;
  let hookPort;
  let received = [];

  const iapi = (path, opts = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, INT_BASE);
    const req = http.request(url, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body, json: () => { try { return JSON.parse(body); } catch (_) { return null; } } });
      });
    });
    req.on('error', reject);
    if(opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });

  before(async () => {
    for(const f of ['test_integrations.db','test_integrations.db-wal','test_integrations.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Receptor local de Telegram (falso Bot API) para validar la integración.
    process.env.TELEGRAM_API_BASE = TG_BASE;
    // Receptor local del webhook.
    hookServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, raw: Buffer.concat(chunks).toString() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise(resolve => hookServer.listen(0, '127.0.0.1', resolve));
    hookPort = hookServer.address().port;

    // Falso servidor de la Bot API de Telegram.
    tgServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        tgReceived.push({ url: req.url, body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { return {}; } })() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{\"ok\":true,\"result\":{}}');
      });
    });
    await new Promise(resolve => tgServer.listen(TG_PORT, '127.0.0.1', resolve));

    const { fork } = require('node:child_process');
    srv = fork(path.join(__dirname, 'server.js'), [], {
      env: {
        ...process.env, NVG_PORT: INT_PORT, NVG_DB: INT_DB, NVG_AUTH: 'off',
        NVG_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/hook`,
        NVG_WEBHOOK_SECRET: HOOK_SECRET,
        NVG_WEBHOOK_EVENTS: 'test,alert,change,reminder',
        TELEGRAM_BOT_TOKEN: TG_TOKEN,
        TELEGRAM_CHAT_ID: '-1001234567890',
        TELEGRAM_API_BASE: TG_BASE
      },
      stdio: 'pipe'
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Integrations server startup timeout')), STARTUP_TIMEOUT_MS);
      srv.stdout.on('data', d => { if(d.toString().includes(':' + INT_PORT)){ clearTimeout(timeout); resolve(); } });
      srv.on('error', e => { clearTimeout(timeout); reject(e); });
    });
  });

  after(async () => {
    if(srv){ const p = new Promise(resolve => { srv.on('exit', resolve); srv.kill(); }); await Promise.race([p, new Promise(r => setTimeout(r, 1500))]); }
    if(hookServer){ await new Promise(resolve => hookServer.close(resolve)); }
    if(tgServer){ await new Promise(resolve => tgServer.close(resolve)); }
    delete process.env.TELEGRAM_API_BASE;
    for(const f of ['test_integrations.db','test_integrations.db-wal','test_integrations.db-shm']){
      const p = path.join(__dirname, f);
      if(fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('GET /api/config expone el estado de integraciones', async () => {
    const r = await iapi('/api/config');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.webhook, true);
    assert.ok(Array.isArray(d.webhookEvents));
    assert.equal(d.telegram, true);
    assert.deepEqual(d.telegramChats, ['-1001234567890']);
    assert.equal(d.provider, 'none');
    assert.equal(d.email, false);
  });

  it('POST /api/integrations/test envía un webhook firmado', async () => {
    received = [];
    const r = await iapi('/api/integrations/test', { method: 'POST', body: { mail: false } });
    assert.equal(r.status, 200);
    assert.equal(r.json().ok, true);
    assert.equal(r.json().webhook, true);
    assert.equal(r.json().telegram, true);
    // Espera breve a que el receptor procese.
    for(let i = 0; i < 20 && !received.length; i++) await new Promise(res => setTimeout(res, 50));
    assert.equal(received.length, 1, 'se esperaba 1 webhook recibido');
    const { headers, raw } = received[0];
    const payload = JSON.parse(raw);
    assert.equal(payload.event, 'test');
    assert.equal(payload.source, 'nvg-radar');
    const expected = 'sha256=' + crypto.createHmac('sha256', HOOK_SECRET).update(raw).digest('hex');
    assert.equal(headers['x-nvg-signature'], expected);
  });

  it('POST /api/integrations/test envía un mensaje por Telegram (Bot API)', async () => {
    tgReceived = [];
    const r = await iapi('/api/integrations/test', { method: 'POST', body: { mail: false, webhook: false } });
    assert.equal(r.status, 200);
    assert.equal(r.json().telegram, true);
    for(let i = 0; i < 20 && !tgReceived.length; i++) await new Promise(res => setTimeout(res, 50));
    assert.equal(tgReceived.length, 1, 'se esperaba 1 mensaje Telegram recibido');
    const msg = tgReceived[0];
    assert.ok(msg.url.includes(`/bot${TG_TOKEN}/sendMessage`), 'debe usar la ruta de la Bot API con el token');
    assert.equal(msg.body.chat_id, '-1001234567890');
    assert.equal(msg.body.parse_mode, 'HTML');
    assert.ok(String(msg.body.text).includes('Prueba'), 'el texto debe provenir del evento test');
  });
});

describe('formatTelegramMessage (unidad)', () => {
  const { formatTelegramMessage } = require('./integrations');
  it('formatea alertas con escape HTML', () => {
    const t = formatTelegramMessage('alert', { ocid: 'OC-1', entidad: 'A <B>', titulo: 'Compra & más', tipo: 'pac_matched', url: 'https://x/1' });
    assert.ok(t.includes('Nuevo proceso'));
    assert.ok(t.includes('PAC ✓'));
    assert.ok(t.includes('A &lt;B&gt;'));
    assert.ok(t.includes('Compra &amp; m'));
    assert.ok(t.includes('<a href=\"https://x/1\">'));
  });
  it('formatea cambios y recordatorios', () => {
    assert.ok(formatTelegramMessage('change', { ocid: 'OC-2', resumen: 'etapa: calificada' }).includes('Cambio en proceso'));
    assert.ok(formatTelegramMessage('reminder', { ocid: 'OC-3', cierre: '2026-10-20', dias: 2 }).includes('Cierre próximo'));
    assert.ok(formatTelegramMessage('reminder', { ocid: 'OC-3', cierre: '2026-10-20', dias: 0 }).includes('hoy'));
  });
});

describe('Restauración de BD (NVG_ALLOW_RESTORE)', () => {
  const RST_PORT = 3216;
  const RST_BASE = `http://localhost:${RST_PORT}`;
  const RST_DB = path.join(__dirname, 'test_restore.db');
  let srv;

  const rapi = (path, opts = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, RST_BASE);
    const req = http.request(url, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body, json: () => { try { return JSON.parse(body); } catch (_) { return null; } } });
      });
    });
    req.on('error', reject);
    if(opts.body) req.write(opts.body);
    req.end();
  });

  before(async () => {
    for(const f of [RST_DB, RST_DB + '-wal', RST_DB + '-shm']){ if(fs.existsSync(f)) fs.unlinkSync(f); }
    const { fork } = require('node:child_process');
    srv = fork(path.join(__dirname, 'server.js'), [], {
      env: { ...process.env, NVG_PORT: RST_PORT, NVG_DB: RST_DB, NVG_AUTH: 'off', NVG_ALLOW_RESTORE: '0' },
      stdio: 'pipe'
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Restore server startup timeout')), STARTUP_TIMEOUT_MS);
      srv.stdout.on('data', d => { if(d.toString().includes(':' + RST_PORT)){ clearTimeout(timeout); resolve(); } });
      srv.on('error', e => { clearTimeout(timeout); reject(e); });
    });
  });

  after(async () => {
    if(srv){ const p = new Promise(resolve => { srv.on('exit', resolve); srv.kill(); }); await Promise.race([p, new Promise(r => setTimeout(r, 1500))]); }
    for(const f of [RST_DB, RST_DB + '-wal', RST_DB + '-shm']){ if(fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('rechaza POST /api/db con 403 cuando NVG_ALLOW_RESTORE=0', async () => {
    const r = await rapi('/api/db', { method: 'POST', body: Buffer.from('no importa el contenido') });
    assert.equal(r.status, 403);
    assert.match(r.json().error, /deshabilitada/);
  });

  it('sigue permitiendo GET /api/db (descargar copia)', async () => {
    const r = await rapi('/api/db');
    assert.equal(r.status, 200);
    assert.ok(r.body.startsWith('SQLite format 3'));
  });
});

describe('Correo por Microsoft Graph (unitario, fetch simulado)', () => {
  const originalFetch = global.fetch;
  const silent = { log(){}, error(){} };

  after(() => { global.fetch = originalFetch; });

  it('obtiene token de aplicación y envía el correo', async () => {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if(String(url).includes('login.microsoftonline.com')){
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123', expires_in: 3600 }) };
      }
      return { ok: true, status: 202, text: async () => '' };
    };
    const integ = createIntegrations({
      env: {
        MAIL_PROVIDER: 'graph', GRAPH_TENANT_ID: 'tenant', GRAPH_CLIENT_ID: 'client',
        GRAPH_CLIENT_SECRET: 'secret', GRAPH_SENDER: 'alertas@empresa.com', MAIL_TO: 'compras@empresa.com'
      },
      log: silent
    });
    assert.equal(integ.status().provider, 'graph');
    assert.equal(integ.status().email, true);

    const ok = await integ.sendMail('Asunto de prueba', '<p>Hola</p>');
    assert.equal(ok, true);

    const tokenCall = calls.find(c => c.url.includes('login.microsoftonline.com'));
    assert.ok(tokenCall, 'debe pedir token a Entra ID');
    assert.ok(tokenCall.opts.body.toString().includes('grant_type=client_credentials'));

    const mailCall = calls.find(c => c.url.includes('/sendMail'));
    assert.ok(mailCall, 'debe llamar a sendMail');
    assert.match(mailCall.url, /\/users\/alertas%40empresa\.com\/sendMail$/);
    assert.equal(mailCall.opts.headers.Authorization, 'Bearer tok-123');
    const payload = JSON.parse(mailCall.opts.body);
    assert.equal(payload.message.subject, 'Asunto de prueba');
    assert.equal(payload.message.toRecipients[0].emailAddress.address, 'compras@empresa.com');
  });

  it('crea recordatorios de calendario cuando GRAPH_CALENDAR=1', async () => {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if(String(url).includes('login.microsoftonline.com')){
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      }
      return { ok: true, status: 201, text: async () => '' };
    };
    const integ = createIntegrations({
      env: {
        MAIL_PROVIDER: 'graph', GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's',
        GRAPH_SENDER: 'alertas@empresa.com', MAIL_TO: 'compras@empresa.com', GRAPH_CALENDAR: '1',
        GRAPH_TIMEZONE: 'America/Guayaquil'
      },
      log: silent
    });
    assert.equal(integ.status().calendar, true);
    const ok = await integ.createCalendarReminder({
      subject: 'Cierre', html: '<p>x</p>', startISO: '2026-11-01T08:00:00', endISO: '2026-11-01T08:30:00'
    });
    assert.equal(ok, true);
    const ev = calls.find(c => c.url.includes('/events'));
    assert.ok(ev, 'debe crear un evento');
    const payload = JSON.parse(ev.opts.body);
    assert.equal(payload.isReminderOn, true);
    assert.equal(payload.start.timeZone, 'America/Guayaquil');
    assert.equal(payload.reminderMinutesBeforeStart, 60);
  });
});


