# Radar de Oportunidades SERCOP

Servidor Node.js sin framework (solo `better-sqlite3`, `exceljs`, `nodemailer`)
que consulta APIs y portales públicos de contratación (SERCOP, BID, PNUD, NCO,
PAC) y guarda resultados, pipeline comercial y planes en SQLite. Incluye login,
sesiones, *hardening* HTTP y **integraciones salientes** con CRM (webhook),
Telegram y
Microsoft 365 / Outlook (Microsoft Graph).

La auditoría de seguridad está en [`AUDITORIA.md`](./AUDITORIA.md).

---

## 1. Requisitos

- **Node.js 24.22.1** o posterior (LTS con los parches del 21 de octubre de 2026). La imagen de despliegue fija `node:24.22.1-bookworm-slim`. El envío por Graph usa `fetch` nativo.
- Un **volumen persistente** para la base de datos SQLite (`NVG_DB`).

## 2. Arranque rápido

```bash
npm install
cp .env.example .env      # ajusta los valores
npm start                 # node server.js
```

En el primer arranque, si no defines `NVG_AUTH_PASS` (mínimo 10 caracteres),
**no se genera una contraseña oculta**. Abre `/login` y define la del
administrador. Si un despliegue anterior había creado una clave que nadie
llegó a usar, ese arranque también abre `/login` para definirla; los radares
y el resto de la base se conservan.

Desarrollo sin autenticación (¡no exponer a Internet!):

```bash
NVG_AUTH=off npm start
```

### Pruebas

```bash
npm test
```

## 3. Despliegue en OpenShip (edge proxy con TLS)

El dominio libre `soce.opsh.io` va en `openship.json` asignado al puerto **3210**,
el mismo que publica el contenedor. OpenShip registra la ruta solo si ese
contenedor sigue **en ejecución** y tiene publicado el 3210. El proceso abre
el puerto antes de SQLite y reintenta si el volumen aún no se puede escribir,
para no dejar el dominio en «El enrutamiento del dominio necesita atención».

1. **Escucha detrás del proxy**: `NVG_HOST=0.0.0.0`. Si OpenShip inyecta `PORT`
   y no hay `NVG_HOST`, el servidor escucha en `0.0.0.0` en ese puerto.
2. El edge **debe reenviar** `X-Forwarded-For` y `X-Forwarded-Proto: https`.
   Con eso se activan automáticamente la cookie `Secure` y HSTS.
3. Define **`NVG_AUTH_PASS`** como secreto de la plataforma (mínimo 10 caracteres)
   o déjalo vacío y crea la clave en `/login` al abrir el sitio. Una clave más
   corta se ignora: el proceso no inventa otra ni la imprime en los logs.
4. **Persistencia**: `NVG_DB=/app/data/radar.db` con el volumen
   `radar-data:/app/data`. El proceso crea el directorio si el volumen aún no
   está montado, para no morir antes de escuchar.
5. No despliegues `*.db`, `*.log` ni `.env` (ya están en `.gitignore`).
6. Healthcheck sugerido: `GET /api/auth/session` (público, siempre responde).
7. Si no usas el botón **Restaurar copia**, define **`NVG_ALLOW_RESTORE=0`**
   para deshabilitar la restauración completa de la BD (`POST /api/db` → 403).

Tras el despliegue, en Dominios el hostname `soce.opsh.io` debe seguir en el
puerto 3210. Si el aviso de enrutamiento continúa, reintenta el enrutamiento
desde esa pestaña: el dominio ya verificado no se vuelve a comprobar solo.

> **Timeouts:** `requestTimeout`/socket se dejan abiertos porque `/api/search`
> usa **SSE** (conexión larga). `headersTimeout` es de 20 s (slowloris).

---

## 4. Integración con Microsoft Dynamics (webhook configurable)

El radar **no se acopla a un CRM concreto**: envía un `POST` JSON firmado a la
URL que configures. Funciona igual con **Microsoft Dynamics + Power Automate**,
Logic Apps, Zapier, n8n o un endpoint propio.

### 4.1 Configuración

```env
NVG_WEBHOOK_URL=https://prod-00.westus.logic.azure.com/workflows/.../triggers/manual/paths/invoke?api-version=...
NVG_WEBHOOK_SECRET=una-clave-larga-y-aleatoria
# NVG_WEBHOOK_BEARER=token-opcional
NVG_WEBHOOK_EVENTS=alert,change,reminder      # eventos a enviar
NVG_WEBHOOK_TIMEOUT_MS=10000
```

### 4.2 Cuerpo del POST

```json
{
  "event": "alert",
  "source": "nvg-radar",
  "at": "2026-10-14T15:04:05.123Z",
  "data": { "...": "según el evento" }
}
```

Cabeceras:

| Cabecera | Cuándo | Valor |
|----------|--------|-------|
| `Content-Type` | siempre | `application/json` |
| `User-Agent` | siempre | `NVG-Radar/11` |
| `X-NVG-Signature` | si `NVG_WEBHOOK_SECRET` | `sha256=<HMAC-SHA256 hex del cuerpo>` |
| `Authorization` | si `NVG_WEBHOOK_BEARER` | `Bearer <token>` |

### 4.3 Eventos

| `event` | Se dispara | `data` (resumen) |
|---------|-----------|------------------|
| `alert` | El monitor encuentra procesos nuevos | `{ count, procesos[] }` |
| `change` | Cambia la etapa de un proceso seguido | `{ cambios[] }` |
| `reminder` | Un proceso está por cerrar | `{ procesoS, cierre, ... }` |
| `test` | Prueba manual (`/api/integrations/test`) | `{ mensaje, estado, prueba }` |

### 4.4 Verificación de la firma (recomendado en el receptor)

El receptor debe recalcular el HMAC sobre el **cuerpo crudo** y comparar en
tiempo constante. Ejemplo en Node/Power Automate (expresión):

```js
const crypto = require('node:crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', process.env.NVG_WEBHOOK_SECRET)
  .update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-nvg-signature']));
```

En **Power Automate**: usa el disparador *"When an HTTP request is received"*,
añade una condición que compare `headers['x-nvg-signature']` con
`sha256(concat(...))` del cuerpo; luego crea/actualiza el registro en Dynamics
(*Create a record*, *Update a record*) o envía una notificación.


## 4bis. Notificaciones por Telegram (Bot API)

Además del webhook, el radar puede enviar los mismos eventos a **Telegram**
(alertas de nuevos procesos, cambios de etapa y recordatorios de cierre).

### Configuración

1. Crea un bot con [@BotFather](https://t.me/BotFather) → obtén el token
   (formato `123456789:AA...`).
2. Obtén el chat ID:
   - Usuario: escribe al bot y visita
     `https://api.telegram.org/bot<TOKEN>/getUpdates` → `message.chat.id`.
   - Grupo/canal: añade el bot como miembro/administrador y usa el ID
     (`-100…` para canales/supergrupos) o el `@nombreusuario` del canal público.

```env
TELEGRAM_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=-1001234567890        # admite varios separados por coma
# TELEGRAM_EVENTS=alert,change,reminder,test   # eventos a notificar
# TELEGRAM_DISABLE_PREVIEW=1                     # sin vista previa de enlaces (por defecto 1)
# TELEGRAM_SILENT=0                              # 1 = mensajes sin sonido
# TELEGRAM_TIMEOUT_MS=10000
```

Los mensajes se envían en formato HTML con escape seguro (entidad, título,
OCID, enlace al proceso en SERCOP y días restantes en recordatorios). Si no se
configura el bot, la integración queda inactiva sin afectar al resto.

Prueba manual: `POST /api/integrations/test` con cuerpo `{ "telegram": true }`
(o `{}` para probar correo + webhook + Telegram a la vez); la respuesta
incluye `"telegram": true/false`.
---

## 5. Correo y recordatorios por Microsoft 365 / Outlook (Microsoft Graph)

El envío recomendado usa **Microsoft Graph con OAuth2 *app-only*** (client
credentials). El correo sale del buzón configurado como remitente.

### 5.1 Registrar la aplicación en Azure AD

1. **Azure Portal → Microsoft Entra ID → App registrations → New registration.**
2. Anota **Directory (tenant) ID** y **Application (client) ID**.
3. **Certificates & secrets → New client secret**: copia el valor
   (`GRAPH_CLIENT_SECRET`).
4. **API permissions → Add a permission → Microsoft Graph → Application
   permissions**:
   - `Mail.Send` — enviar correo.
   - `Calendars.ReadWrite` — solo si usarás recordatorios (`GRAPH_CALENDAR=1`).
   - Pulsa **Grant admin consent** (lo requiere un administrador del tenant).
5. (Opcional, recomendado) **Application Access Policy** para restringir el
   envío a un buzón concreto:
   ```powershell
   New-ApplicationAccessPolicy -AppId <CLIENT_ID> -PolicyScopeGroupId <BUZON> -AccessRight RestrictAccess
   ```

### 5.2 Configuración

```env
MAIL_PROVIDER=graph
GRAPH_TENANT_ID=<tenant-id>
GRAPH_CLIENT_ID=<client-id>
GRAPH_CLIENT_SECRET=<client-secret>
GRAPH_SENDER=radar@tudominio.com
MAIL_TO=comercial@tudominio.com,compras@tudominio.com
GRAPH_SAVE_TO_SENT=0
GRAPH_CALENDAR=1                 # recordatorios de calendario
GRAPH_TIMEZONE=America/Guayaquil
GRAPH_REMINDER_MINUTES=60
```

### 5.3 Alternativa por SMTP

```env
MAIL_PROVIDER=smtp
MAIL_HOST=smtp.office365.com
MAIL_PORT=587
MAIL_USER=radar@tudominio.com
MAIL_PASS=<contraseña-o-app-password>
MAIL_SECURE=0
MAIL_FROM=radar@tudominio.com
MAIL_TO=comercial@tudominio.com
```

`MAIL_PROVIDER=auto` (por defecto) usa **Graph** si hay credenciales; si no,
**SMTP**.

### 5.4 Recordatorios de calendario

Con `GRAPH_CALENDAR=1`, cuando un proceso está por cerrar se crea un **evento con
alarma** (`reminderMinutesBeforeStart`) en el calendario del buzón remitente
(`GRAPH_REMINDER_MINUTES`, 60 por defecto), categorizado como `NVG Radar`.

---

## 6. Probar las integraciones

Endpoint autenticado (POST):

```bash
curl -X POST https://tu-dominio/api/integrations/test \
     -H "Cookie: nvg_session=..." -H "X-CSRF-Token: ..."
```

Respuesta:

```json
{ "ok": true, "mail": true, "webhook": true, "telegram": true, "provider": "graph" }
```

- `mail`/`webhook`/`telegram`: `true` si el envío se realizó.
- `provider`: `graph` | `smtp` | `none`.
- Puedes desactivar cualquiera con `{"mail":false}`, `{"webhook":false}` o `{"telegram":false}`.
- `GET /api/config` devuelve el estado (destinatarios, proveedor, si hay webhook
  y qué eventos envía).

---

## 7. Estructura

| Archivo | Rol |
|---------|-----|
| `server.js` | Servidor HTTP, rutas, auth, monitor, planificador. |
| `auth.js` | scrypt, sesiones, CSRF y limitador **persistente** (SQLite). |
| `integrations.js` | Webhook (HMAC) + Telegram (Bot API) + Microsoft Graph (correo/calendario) + SMTP. |
| `sercop.html` | Panel (acciones delegadas por `data-act`, sin handlers inline). |
| `login.html` | Página de login. |
| `test.js` | 66 pruebas (API, sesión, limitador, integraciones, Graph). |
| `AUDITORIA.md` | Auditoría de seguridad y decisiones. |
| `.env.example` | Todas las variables de entorno documentadas. |

## 8. Endurecimiento (resumen)

- Login por sesión obligatorio (`NVG_AUTH=on`); scrypt + cookie `HttpOnly`/`SameSite=Strict`.
- CSRF por sesión (`X-CSRF-Token`) en las mutaciones.
- **CSP** con `script-src 'self' 'nonce-…'` y **sin handlers inline**; los `href` se validan (solo `http(s)`).
- Rate limiting global y de login **persistido en SQLite**.
- Topes de tamaño de cuerpo/subida, mensajes de error genéricos y sin caché de API.

Detalles y riesgos residuales: [`AUDITORIA.md`](./AUDITORIA.md).
