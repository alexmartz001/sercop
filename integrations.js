'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Integraciones salientes del Radar SERCOP:
//
//  · Webhook configurable (compatible con Microsoft Dynamics / Power Automate):
//    se hace POST de un JSON firmado (HMAC-SHA256) a NVG_WEBHOOK_URL cuando
//    ocurren eventos (nuevos procesos, cambios de pipeline, recordatorios…).
//
//  · Correo y recordatorios por Microsoft 365 / Outlook:
//      - Microsoft Graph (OAuth2 client credentials, app-only) — recomendado.
//      - SMTP (nodemailer) como alternativa.
//      - Recordatorios de calendario opcionales vía Graph (eventos con alarma).
//
// Todo es opcional: si no hay configuración, las funciones devuelven false sin
// romper el servidor.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('node:crypto');

const pick = (env, ...names) => {
  for(const n of names){ const v = env[n]; if(v !== undefined && v !== null && String(v) !== '') return String(v); }
  return '';
};
const bool = (v, def = false) => (v === undefined || v === null || v === '') ? def : /^(1|true|on|yes|si|sí)$/i.test(String(v));
const num = (v, def) => {
  if(v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const listOf = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

function buildConfig(env){
  const mailFrom = pick(env, 'MAIL_FROM', 'GRAPH_SENDER');
  const cfg = {
    mail: {
      provider: pick(env, 'MAIL_PROVIDER').toLowerCase() || (pick(env, 'GRAPH_CLIENT_ID') ? 'graph' : 'smtp'),
      from: mailFrom,
      to: listOf(pick(env, 'MAIL_TO')),
      smtp: {
        host: pick(env, 'MAIL_HOST'),
        port: num(pick(env, 'MAIL_PORT'), 587),
        user: pick(env, 'MAIL_USER'),
        pass: pick(env, 'MAIL_PASS'),
        secure: bool(pick(env, 'MAIL_SECURE'), false)
      },
      graph: {
        tenant: pick(env, 'GRAPH_TENANT_ID', 'MAIL_TENANT_ID'),
        clientId: pick(env, 'GRAPH_CLIENT_ID'),
        clientSecret: pick(env, 'GRAPH_CLIENT_SECRET'),
        sender: pick(env, 'GRAPH_SENDER', 'MAIL_FROM'),
        saveToSent: bool(pick(env, 'GRAPH_SAVE_TO_SENT'), false),
        calendar: bool(pick(env, 'GRAPH_CALENDAR'), false),
        timezone: pick(env, 'GRAPH_TIMEZONE') || 'America/Guayaquil',
        reminderMinutes: Math.max(0, num(pick(env, 'GRAPH_REMINDER_MINUTES'), 60))
      }
    },
    webhook: {
      url: pick(env, 'NVG_WEBHOOK_URL'),
      secret: pick(env, 'NVG_WEBHOOK_SECRET'),
      bearer: pick(env, 'NVG_WEBHOOK_BEARER'),
      events: listOf(pick(env, 'NVG_WEBHOOK_EVENTS') || 'alert,change,reminder').map(s => s.toLowerCase()),
      timeoutMs: Math.max(1000, num(pick(env, 'NVG_WEBHOOK_TIMEOUT_MS'), 10000))
    }
  };
  cfg.mail.graphReady = cfg.mail.provider === 'graph'
    && !!(cfg.mail.graph.tenant && cfg.mail.graph.clientId && cfg.mail.graph.clientSecret && cfg.mail.graph.sender);
  cfg.mail.smtpReady = !!(cfg.mail.smtp.host && cfg.mail.from && cfg.mail.to.length);
  cfg.webhook.ready = !!cfg.webhook.url;
  return cfg;
}

function createIntegrations({ env = process.env, log = console } = {}){
  const cfg = buildConfig(env);

  // ── SMTP (nodemailer, carga diferida) ──────────────────────────────────────
  let smtpTransport = null;
  if(cfg.mail.smtpReady && !cfg.mail.graphReady){
    try{
      const nodemailer = require('nodemailer');
      smtpTransport = nodemailer.createTransport({
        host: cfg.mail.smtp.host,
        port: cfg.mail.smtp.port,
        secure: cfg.mail.smtp.secure,
        auth: cfg.mail.smtp.user ? { user: cfg.mail.smtp.user, pass: cfg.mail.smtp.pass } : undefined
      });
    }catch(e){ log.error('  [Mail] sin soporte SMTP:', e.message); }
  }

  // ── Token de Microsoft Graph (cacheado) ────────────────────────────────────
  let graphTokenCache = { value: '', exp: 0 };
  async function graphAccessToken(){
    if(graphTokenCache.value && Date.now() < graphTokenCache.exp - 60 * 1000) return graphTokenCache.value;
    const { tenant, clientId, clientSecret } = cfg.mail.graph;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await resp.json().catch(() => ({}));
    if(!resp.ok || !data.access_token){
      throw new Error(data.error_description || data.error || `Graph token HTTP ${resp.status}`);
    }
    graphTokenCache = { value: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return graphTokenCache.value;
  }

  async function graphFetch(pathname, options = {}){
    const token = await graphAccessToken();
    const resp = await fetch(`https://graph.microsoft.com/v1.0${pathname}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if(!resp.ok){
      const detail = await resp.text().catch(() => '');
      throw new Error(`Graph HTTP ${resp.status}: ${detail.slice(0, 300)}`);
    }
    return resp;
  }

  // ── Envío de correo ────────────────────────────────────────────────────────
  function htmlToText(html){ return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

  async function sendGraphMail(subject, html, text){
    const message = {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: cfg.mail.to.map(a => ({ emailAddress: { address: a } }))
    };
    try{
      await graphFetch(`/users/${encodeURIComponent(cfg.mail.graph.sender)}/sendMail`, {
        method: 'POST',
        body: JSON.stringify({ message, saveToSentItems: cfg.mail.graph.saveToSent })
      });
      log.log(`  [Graph] correo enviado: ${subject}`);
      return true;
    }catch(e){
      log.error('  [Graph] error al enviar:', e.message);
      return false;
    }
  }

  async function sendSmtpMail(subject, html, text){
    if(!smtpTransport){
      log.log(`  [Mail] desactivado (configura Graph o MAIL_HOST/MAIL_FROM/MAIL_TO): ${subject}`);
      return false;
    }
    try{
      await smtpTransport.sendMail({ from: cfg.mail.from, to: cfg.mail.to, subject, html, text: text || htmlToText(html) });
      log.log(`  [Mail] enviado: ${subject}`);
      return true;
    }catch(e){ log.error('  [Mail] error:', e.message); return false; }
  }

  async function sendMail(subject, html, text){
    if(cfg.mail.graphReady) return sendGraphMail(subject, html, text);
    return sendSmtpMail(subject, html, text);
  }

  // ── Recordatorio de calendario (Microsoft 365 / Outlook) ───────────────────
  // Crea un evento con alarma en el calendario del buzón remitente.
  async function createCalendarReminder({ subject, html, startISO, endISO, minutes }){
    if(!cfg.mail.graphReady || !cfg.mail.graph.calendar) return false;
    const tz = cfg.mail.graph.timezone;
    const start = String(startISO || '').replace(/Z$/, '');
    const end = String(endISO || startISO || '').replace(/Z$/, '');
    if(!start) return false;
    const event = {
      subject,
      body: { contentType: 'HTML', content: html },
      start: { dateTime: start, timeZone: tz },
      end: { dateTime: end || start, timeZone: tz },
      isReminderOn: true,
      reminderMinutesBeforeStart: Number.isFinite(minutes) ? minutes : cfg.mail.graph.reminderMinutes,
      categories: ['NVG Radar']
    };
    try{
      await graphFetch(`/users/${encodeURIComponent(cfg.mail.graph.sender)}/events`, {
        method: 'POST',
        body: JSON.stringify(event)
      });
      log.log(`  [Graph] recordatorio creado: ${subject}`);
      return true;
    }catch(e){
      log.error('  [Graph] error al crear recordatorio:', e.message);
      return false;
    }
  }

  // ── Webhook saliente (Dynamics / Power Automate) ───────────────────────────
  function sign(secret, body){ return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`; }

  async function sendWebhook(event, data){
    if(!cfg.webhook.ready) return false;
    if(!cfg.webhook.events.includes(String(event).toLowerCase())) return false;
    const body = JSON.stringify({
      event,
      source: 'nvg-radar',
      at: new Date().toISOString(),
      data: data || {}
    });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'NVG-Radar/11' };
    if(cfg.webhook.secret) headers['X-NVG-Signature'] = sign(cfg.webhook.secret, body);
    if(cfg.webhook.bearer) headers['Authorization'] = `Bearer ${cfg.webhook.bearer}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.webhook.timeoutMs);
    try{
      const resp = await fetch(cfg.webhook.url, { method: 'POST', headers, body, signal: ctrl.signal });
      log.log(`  [Webhook] ${event} -> HTTP ${resp.status}`);
      return resp.ok;
    }catch(e){
      log.error(`  [Webhook] error ${event}:`, e.message);
      return false;
    }finally{
      clearTimeout(timer);
    }
  }

  // ── Estado ─────────────────────────────────────────────────────────────────
  function status(){
    return {
      email: cfg.mail.graphReady || !!smtpTransport,
      provider: cfg.mail.graphReady ? 'graph' : (smtpTransport ? 'smtp' : 'none'),
      calendar: !!(cfg.mail.graphReady && cfg.mail.graph.calendar),
      to: cfg.mail.to,
      webhook: cfg.webhook.ready,
      webhookEvents: cfg.webhook.events
    };
  }

  return { config: cfg, sendMail, sendWebhook, createCalendarReminder, status, graphAccessToken, htmlToText };
}

module.exports = { createIntegrations, buildConfig };
