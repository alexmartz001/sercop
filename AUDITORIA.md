# Auditoría de seguridad y endurecimiento — Radar de Oportunidades SERCOP

Fecha: 2026-10-14
Alcance: `server.js`, `sercop.html`, `auth.js`, `login.html`, `package.json`, `test.js`
Objetivo: exponer el sistema en Internet (OpenShip, detrás del edge proxy con TLS).

---

## 1. Resumen ejecutivo

El sistema es un servidor HTTP Node.js sin framework (solo `better-sqlite3`,
`exceljs`, `nodemailer`) que consulta APIs y portales públicos de contratación
(SERCOP, BID, PNUD, NCO, PAC) y guarda resultados, pipeline comercial y planes
en SQLite. La lógica de negocio es **sólida**: todas las consultas están
parametrizadas (sin inyección SQL) y no hay manejo de rutas con entrada del
usuario (sin *path traversal*).

El problema principal era de **exposición**: la autenticación era un único token
compartido y **opcional**; si no se definía `NVG_TOKEN`, la API quedaba
completamente abierta. No había login, sesiones, CSRF, límites de tamaño ni
raticos de fuerza bruta.

Se implementó una **capa de autenticación por sesión** (usuario/contraseña con
scrypt, cookie `HttpOnly`/`SameSite=Strict`, CSRF, rate limiting) y un conjunto
de **controles de endurecimiento** (cabeceras de seguridad, CSP con *nonce*,
topes de tamaño, ventanas de tiempo, mensajes de error genéricos). También se
**corrigieron todos los hallazgos residuales** (B1 escapado del frontend, B4 CSP
sin `unsafe-inline` en scripts, B5 limitador persistente) y se añadió la
**integración saliente** con Microsoft Dynamics (webhook) y Microsoft 365 /
Outlook (Microsoft Graph). Los **66 tests pasan**.

---

## 2. Hallazgos

Severidad: Crítico / Alto / Medio / Bajo · Estado: ✅ Remediado · 🟡 Mitigado · ⚠️ Recomendación

| # | Sev. | Hallazgo | Estado |
|---|------|----------|--------|
| C1 | Crítico | Autenticación **opcional y desactivada por defecto**: sin `NVG_TOKEN`, `isAuthorized()` devolvía `true` para toda la API (`/api/db`, escritura, scraping, etc.). | ✅ Login por sesión obligatorio por defecto (`NVG_AUTH=on`). |
| C2 | Alto | Sin protección contra **fuerza bruta** de credenciales. | ✅ Límite por IP y por usuario + bloqueo temporal (429). |
| C3 | Alto | Operaciones de escritura sin **CSRF** una vez usadas cookies de sesión. | ✅ Token CSRF por sesión (`X-CSRF-Token`) + `SameSite=Strict`. |
| C4 | Alto | **Sin límite de tamaño de cuerpo**: `collectBody` acumulaba sin tope y `POST /api/db` volcaba a disco sin límite → DoS por RAM/disco. | ✅ Tope JSON 4 MB y subida 256 MB, con escritura en streaming. |
| M1 | Medio | Token aceptado por `?token=` → se filtra a logs, historial y `Referer`. | 🟡 El frontend ya **no** propaga el token por URL; se conserva solo para scripts que definan `NVG_TOKEN`. |
| M2 | Medio | Sin **cabeceras de seguridad** (CSP, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, HSTS). | ✅ Añadidas. |
| M3 | Medio | Sin *rate limiting* general → abuso de endpoints que hacen *scraping* con tu IP. | ✅ Limitador global de API (configurable). |
| M4 | Medio | Mensajes de error internos devueltos al cliente (p. ej. resto de la copia de BD). | ✅ Mensajes genéricos; detalle solo en el log del servidor. |
| M5 | Medio | `POST /api/db` reemplaza la BD completa (primitiva destructiva). | ✅ Validación previa + tope de tamaño + requiere sesión, y **se puede desactivar** con `NVG_ALLOW_RESTORE=0` (403). |
| M6 | Medio | Cookie de sesión inexistente/sin flags. | ✅ `HttpOnly`, `SameSite=Strict`, `Secure` condicional. |
| M7 | Bajo | CORS permitía varios métodos hacia orígenes *localhost*. | ✅ Se mantiene restringido a localhost + `Vary: Origin`. |
| M8 | Bajo | Sin *timeouts* de red (slowloris). | 🟡 `headersTimeout=20s`; el *timeout* de petición se deja abierto por SSE (ver §5). |
| B1 | Bajo | XSS en el frontend: `innerHTML` con datos de terceros; la mayoría usa `esc()` pero quedaban campos sin escapar. | ✅ Todos los campos escapados (`esc`/`safeHref`) y **handlers inline eliminados**. |
| B2 | Bajo | `/api/config` expone destinatarios de correo. | 🟡 Ahora requiere sesión. |
| B3 | Bajo | Respaldos `.db` y `*.log` en la carpeta de la app. | ⚠️ Añadido `.gitignore`; no se sirven por HTTP. No subirlos al despliegue. |
| B4 | Bajo | CSP necesita `'unsafe-inline'` (arquitectura de archivo único con handlers inline). | ✅ `script-src 'self' 'nonce-…'` sin `unsafe-inline`; 64 handlers inline migrados a delegación. `style-src` conserva `'unsafe-inline'` (solo atributos `style=`, sin ejecución de código). |
| B5 | Bajo | El bloqueo por intentos fallidos es en memoria (se reinicia con el proceso). | ✅ Estado persistido en SQLite (tabla `rate_limits`); sobrevive al reinicio. |

### Aspectos positivos verificados

- **SQL parametrizado** en todo el código; la única SQL dinámica (`updatePlanItem`)
  usa una lista blanca fija de columnas.
- **Sin *path traversal***: `serveFile` solo se usa con rutas fijas del propio proyecto.
- Comparación del token en **tiempo constante** (`timingSafeEqual` manual).
- CORS restringido a orígenes locales.
- Escucha por defecto en `127.0.0.1` (no expone sin configuración explícita).

---

## 3. Qué se implementó

### Autenticación (`auth.js`, `login.html`, rutas `/api/auth/*`)

- **Login usuario/contraseña** con `scrypt` (sal aleatoria por usuario, N=16384,
  ejecución asíncrona para no bloquear el event loop).
- **Sesiones** persistidas en SQLite. Al cliente se le entrega un token aleatorio
  de 256 bits; en la BD se guarda su **SHA-256** (un volcado de la BD no permite
  suplantar sesiones).
- **Cookie** `nvg_session`: `HttpOnly`, `SameSite=Strict`, `Secure` cuando la
  petición es HTTPS (o si `NVG_SECURE_COOKIES=1`).
- **CSRF** por sesión: las mutaciones (POST/PUT/DELETE) con sesión requieren la
  cabecera `X-CSRF-Token`.
- **Bootstrap** en el primer arranque: si no hay usuarios, crea el admin desde
  `NVG_AUTH_USER`/`NVG_AUTH_PASS`, o **genera una contraseña aleatoria y la
  muestra una sola vez** en la consola.
- Endpoints: `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/session`, `POST /api/auth/change-password`.

### Endurecimiento

- **Cabeceras de seguridad** en todas las respuestas: `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-*` y HSTS
  bajo HTTPS.
- **CSP con *nonce* por petición**: `script-src 'self' 'nonce-<aleatorio>'`, **sin**
  `'unsafe-inline'`. El servidor genera un nonce por respuesta y lo inyecta en el
  `<script>` de `sercop.html`/`login.html` al servir el HTML. `style-src` conserva
  `'unsafe-inline'` (solo atributos `style=`, no ejecuta código). Cualquier
  `<script>` o handler inline inyectado queda bloqueado por el navegador.
- **Rate limiting** persistente: global de API (240/min por IP, configurable) y
  específico de login (10/IP y 5/usuario en 15 min, con bloqueo). El estado se
  guarda en SQLite (tabla `rate_limits`), por lo que **sobrevive al reinicio** (B5).
- **Topes de cuerpo** y **subida en streaming** para el respaldo `.db`.
- **Manejo de errores** genérico hacia el cliente; detalle solo en consola.
- **Timeouts**: `headersTimeout` 20 s, `keepAliveTimeout` 65 s.
- **Sin caché** de respuestas de API (`Cache-Control: no-store`).

### Frontend (`sercop.html`)

- Comprueba la sesión al cargar (`/api/auth/session`) y **redirige a `/login`** si
  no está autenticado.
- Todas las llamadas usan `credentials: 'same-origin'` y envían `X-CSRF-Token`.
- Botón **Salir** y nombre de usuario en la cabecera.
- Ya **no** propaga el token por la URL.
- **Sin handlers inline** (B1+B4): los 64 `onclick`/`onchange`/`onmousedown` se
  migraron a un **sistema de acciones delegadas**. Cada elemento lleva
  `data-act="acción"` + argumentos en `data-*` (siempre escapados con `esc()`),
  y un único listener en fase de captura sobre `document` los despacha. Para
  replicar `event.stopPropagation()`, los elementos con `data-stop` (o con
  `data-act`) detienen la propagación en captura. Las acciones se enrutan por
  tipo de evento (`click`, `change`, `mousedown`) mediante `ACTIONS` +
  `MOUSEDOWN_ACTIONS`/`CHANGE_ACTIONS`, evitando disparos duplicados.
- **Escapado sistemático**: todo dato de terceros pasa por `esc()`; los `href` por
  `safeHref()` (solo `http(s)`, neutraliza `javascript:`/`data:`). El antiguo
  helper `jsArg()` (footgun en atributos con comillas dobles) se eliminó.
- **No hay `<script>` adicionales ni HTML intermedio controlable por el usuario**;
  el `<script>` de la página recibe un *nonce* inyectado por el servidor.

### Integraciones salientes (`integrations.js`)

- **Webhook configurable** (Microsoft Dynamics u otro CRM): `POST` a
  `NVG_WEBHOOK_URL` con cuerpo `{event, source:'nvg-radar', at, data}` y firma
  `X-NVG-Signature: sha256=<HMAC-SHA256>` (`NVG_WEBHOOK_SECRET`) más un `Bearer`
  opcional (`NVG_WEBHOOK_BEARER`). Se puede filtrar por eventos con
  `NVG_WEBHOOK_EVENTS` (`alert,change,reminder`, por defecto).
- **Correo por Microsoft Graph** (Microsoft 365 / Outlook, OAuth2 *app-only*):
  token por *client credentials* y envío vía `/users/{sender}/sendMail`; guarda
  copia en Enviados si `GRAPH_SAVE_TO_SENT=1`. Alternativa por **SMTP**
  (`MAIL_PROVIDER=smtp`) o `auto` (Graph si hay credenciales, si no SMTP).
- **Recordatorios de calendario** opcionales (`GRAPH_CALENDAR=1`): crea eventos en
  el calendario del remitente con recordatorio (`GRAPH_REMINDER_MINUTES`).
- **Eventos** emitidos: `alert` (procesos nuevos), `change` (cambios de etapa en
  el pipeline), `reminder` (cierres próximos), `test` (prueba manual).
- **Prueba manual**: `POST /api/integrations/test` (autenticado) devuelve
  `{ok, mail, webhook, provider}` sin esperar al monitor.

### Compatibilidad

- Se conserva el modo **token de API** (`Authorization: Bearer` / `?token=`) solo
  si se define `NVG_TOKEN`, para scripts. No es necesario en producción.
- `NVG_AUTH=off` desactiva la autenticación (solo desarrollo; avisa en consola).

---

## 4. Configuración

Ver `.env.example`. Variables principales:

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `NVG_AUTH` | `on` | `off` desactiva la autenticación (solo desarrollo). |
| `NVG_AUTH_USER` | `admin` | Usuario administrador. |
| `NVG_AUTH_PASS` | *(vacío)* | Contraseña (mín. 10). Si se define, se fija/rota al arrancar. |
| `NVG_SESSION_HOURS` | `12` | Duración de la sesión. |
| `NVG_RATE_LIMIT_PER_MIN` | `240` | Peticiones API/minuto por IP. |
| `NVG_MAX_JSON_MB` | `4` | Tope de cuerpo JSON. |
| `NVG_MAX_UPLOAD_MB` | `256` | Tope de subida de respaldo. |
| `NVG_TRUST_PROXY` | `1` | Confía en `X-Forwarded-*` del proxy. |
| `NVG_ALLOW_RESTORE` | `1` | `0` deshabilita la restauración de BD (`POST /api/db` → 403). |
| `NVG_SECURE_COOKIES` | `0` | Fuerza `Secure` aunque no se detecte HTTPS. |
| `NVG_HSTS` | `1` | Envía HSTS bajo HTTPS. |
| `NVG_TOKEN` | *(vacío)* | Token de API heredado (opcional). |

### Integraciones (webhook + Microsoft 365)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `NVG_WEBHOOK_URL` | *(vacío)* | URL del webhook/CRM. Vacío desactiva el webhook. |
| `NVG_WEBHOOK_SECRET` | *(vacío)* | Secreto HMAC para firmar (`X-NVG-Signature`). |
| `NVG_WEBHOOK_BEARER` | *(vacío)* | `Authorization: Bearer` opcional. |
| `NVG_WEBHOOK_EVENTS` | `alert,change,reminder` | Eventos que disparan el webhook. |
| `NVG_WEBHOOK_TIMEOUT_MS` | `10000` | Timeout del webhook. |
| `MAIL_PROVIDER` | `auto` | `graph` \| `smtp` \| `auto`. |
| `GRAPH_TENANT_ID` | *(vacío)* | Tenant de Azure AD. |
| `GRAPH_CLIENT_ID` | *(vacío)* | App registration (client id). |
| `GRAPH_CLIENT_SECRET` | *(vacío)* | Secreto de la app. |
| `GRAPH_SENDER` | *(vacío)* | Buzón remitente (UPN). |
| `GRAPH_SAVE_TO_SENT` | `0` | Guarda copia en Enviados. |
| `GRAPH_CALENDAR` | `0` | Crea recordatorios de calendario. |
| `GRAPH_TIMEZONE` | `America/Guayaquil` | Zona para los eventos. |
| `GRAPH_REMINDER_MINUTES` | `60` | Antelación del recordatorio. |
| `MAIL_HOST/PORT/USER/PASS/FROM/TO/SECURE` | — | Alternativa SMTP. |

---

## 5. Despliegue en OpenShip (edge proxy)

1. **Escucha detrás del proxy**: `NVG_HOST=0.0.0.0`.
2. El edge **debe reenviar** `X-Forwarded-For` y `X-Forwarded-Proto: https`.
   Con eso se activan la cookie `Secure` y HSTS automáticamente.
3. Define **`NVG_AUTH_PASS`** como secreto en la plataforma (o toma la contraseña
   generada del primer arranque) y **cámbiala** desde el panel tras entrar.
4. **Persistencia**: `NVG_DB` debe apuntar a un volumen persistente.
5. No subas al despliegue `*.db`, `*.log` ni `.env` (ya están en `.gitignore`).
6. Healthcheck sugerido: `GET /api/auth/session` (público, siempre responde).

### Nota sobre timeouts

`requestTimeout` y `timeout` de socket se dejan abiertos porque `/api/search` usa
**SSE** (conexión larga). El `headersTimeout` de 20 s cubre el slowloris de
cabeceras. Si el proxy no impone límites de cuerpo/tiempo, considéralo.

---

## 6. Riesgos residuales y siguientes pasos

1. **`unsafe-inline` en `style-src`** (B4): los scripts ya no lo usan y no hay
   handlers inline; quedan ~140 atributos `style=` y bloques `<style>`. No
   ejecutan código, por lo que el riesgo es mínimo. Eliminarlo exigiría mover los
   estilos a clases.
2. **Auditoría de dependencias**: `npm audit` reporta avisos en dependencias
   transitivas de `exceljs` (`uuid` < 11.1.1). **No es explotable aquí**: el
   radar nunca invoca `uuid` con un buffer controlado por el usuario, y el arreglo
   exigiría degradar `exceljs` (`--force`). Revisar al actualizar `exceljs`.
3. Si se necesitan **varios usuarios con roles**, ampliar `users.role` y las
   comprobaciones por rol (el esquema ya lo soporta).
4. **Personal del CRM**: para escribir en Dynamics de forma nativa (no solo por
   webhook) habría que registrar una app en Azure AD con permisos de Dataverse y
   añadir un conector específico; el webhook firmado ya permite integraciones sin
   acoplar el radar a un CRM concreto.

---

## 7. Verificación

```
npm test
```

Resultado: **68/68 pruebas OK**, incluyendo:
- suite de API sin autenticación (`NVG_AUTH=off`),
- compatibilidad con token (`NVG_TOKEN`),
- sesión: login correcto/incorrecto, cookie endurecida, CSRF, cabeceras de
  seguridad (**CSP con *nonce* y sin `unsafe-inline` en scripts**), cambio de
  contraseña, tope de cuerpo (413), logout y rate limiting (429),
- **limitador persistente (B5)**: el bloqueo sobrevive al reinicio,
- **restauración de BD**: `POST /api/db` responde 403 con `NVG_ALLOW_RESTORE=0`,
- **integración webhook**: recepción local, verificación de firma HMAC y filtrado
  de eventos; **Microsoft Graph** con `fetch` simulado (token + sendMail +
  recordatorio de calendario).

Además se verificó el **frontend en un navegador real (Chrome headless vía CDP)**:
- carga del panel y render de la lista de radares,
- cambio de pestañas, apertura del formulario y edición de un radar
  (`data-act` con `data-id`) — todo por clics reales,
- `data-stop` detiene la propagación al elemento padre,
- la CSP **bloquea** un `onerror=` inline inyectado (prueba de que el *nonce*
  funciona),
- flujo de **login E2E** con `NVG_AUTH=on` (redirección a `/login`, rechazo de
  credenciales incorrectas, acceso al panel),
- **sin errores de consola**.
