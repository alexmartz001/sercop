'use strict';

// Lee las pestañas públicas de un proceso en el portal del SOCE. Sirve para lo
// que OCDS no siempre trae: presupuesto, CPC, fechas y pliegos.
//
// El identificador lo aporta el usuario con el enlace del proceso: la búsqueda
// del portal tiene captcha y aquí no se automatiza, ni se recorren identificadores.
// Este módulo no hace peticiones.

const BASE = 'https://www.compraspublicas.gob.ec/ProcesoContratacion/compras';
const PESTANAS = {descripcion: 1, fechas: 2, productos: 3, archivos: 6};

const ENTIDADES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", raquo: '»', laquo: '«',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü'
};

function texto(html){
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (todo, nombre) => ENTIDADES[nombre] ?? todo)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizar(valor){
  return String(valor || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function monto(valor){
  const limpio = String(valor || '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const numero = Number(limpio);
  return limpio && Number.isFinite(numero) ? numero : null;
}

// Acepta el enlace del portal o el identificador solo.
function idDesdeTexto(entrada){
  const limpio = String(entrada || '').trim();
  if(!limpio) return null;
  let candidato = limpio;
  if(/^https?:\/\//i.test(limpio)){
    let url;
    try { url = new URL(limpio); } catch(_){ return null; }
    if(!/(^|\.)compraspublicas\.gob\.ec$/i.test(url.hostname)) return null;
    candidato = url.searchParams.get('idSoliCompra') || url.searchParams.get('id') || '';
  }
  candidato = candidato.replace(/,+$/, '');
  return /^[A-Za-z0-9_-]{1,80}$/.test(candidato) ? candidato : null;
}

function urlPestana(id, pestana){
  return `${BASE}/ProcesoContratacion/tab.php?tab=${pestana}&id=${encodeURIComponent(id)},`;
}

function urlFicha(id){
  return `${BASE}/PC/informacionProcesoContratacion2.cpe?idSoliCompra=${encodeURIComponent(id)},`;
}

function esBloqueo(html){
  return /Application Firewall|Your request has been blocked/i.test(String(html || ''));
}

function filasEncabezadas(html){
  return [...String(html || '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(([, clave, valor]) => [texto(clave).replace(/:$/, '').trim(), texto(valor)]);
}

function parsearDescripcion(html){
  const campos = new Map(filasEncabezadas(html).map(([clave, valor]) => [normalizar(clave), valor]));
  const presupuesto = [...campos.entries()].find(([clave]) => clave.startsWith('presupuesto referencial'));
  // El correo del funcionario encargado no se conserva: el reporte no lo necesita.
  return {
    entidad: campos.get('entidad') || '',
    objeto: campos.get('objeto de proceso') || '',
    codigo: campos.get('codigo') || '',
    tipoCompra: campos.get('tipo compra') || '',
    presupuesto: presupuesto ? monto(presupuesto[1]) : null,
    modalidad: (campos.get('tipo de contratacion') || '').replace(/[\s-]+$/, ''),
    formaPago: campos.get('forma de pago') || '',
    tipoAdjudicacion: campos.get('tipo de adjudicacion') || '',
    plazoEntrega: campos.get('plazo de entrega') || '',
    vigenciaOferta: campos.get('vigencia de oferta') || '',
    estado: campos.get('estado del proceso') || '',
    descripcion: campos.get('descripcion') || ''
  };
}

// El portal publica la hora de Ecuador sin zona.
function fechaIso(valor){
  const m = String(valor || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  return m ? `${m[1]}T${m[2]}-05:00` : null;
}

function parsearFechas(html){
  return filasEncabezadas(html)
    .map(([etapa, valor]) => ({etapa, fecha: fechaIso(valor)}))
    .filter(fila => fila.etapa && fila.fecha);
}

// El semáforo reconoce estas etapas por nombre; las demás quedan como las publica el portal.
function etapaOperativa(nombre){
  const clave = normalizar(nombre);
  if(/limite de preguntas/.test(clave)) return 'Preguntas';
  if(/limite entrega ofertas/.test(clave)) return 'Entrega de ofertas';
  return nombre;
}

function parsearProductos(html){
  const lotes = [];
  const items = [];
  for(const [, fila] of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)(?=<tr[^>]*>|<\/tbody>|<\/table>)/gi)){
    const lote = texto(fila).match(/^Lote\s+(\d+)\s*-\s*Cpc:\s*(\d+)\s*\/\s*(.*?)(?:\s+\/\s+\(|\s+Umbral VAE|$)/i);
    if(lote){
      lotes.push({numero: Number(lote[1]), cpc: lote[2], descripcion: lote[3].trim()});
      continue;
    }
    const celdas = [...fila.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => texto(m[1]));
    if(celdas.length === 6 && /^\d{5,}$/.test(celdas[0])){
      items.push({
        codigo: celdas[0],
        descripcion: celdas[1],
        cantidad: monto(celdas[2]),
        unidad: celdas[3],
        unitario: monto(celdas[4]),
        subtotal: monto(celdas[5])
      });
    }
  }
  return {lotes, items};
}

function parsearArchivos(html){
  const fuente = String(html || '');
  const archivos = [];
  const vistos = new Set();
  // La página abre un <div align="left"> externo sin cerrar: vale el último antes del enlace.
  const patron = /<div align="left">((?:(?!<div align="left">)[\s\S])*?)<\/div>[\s\S]*?href=(['"])\.\.\/PC\/bajarArchivo\.cpe\?Archivo=([A-Za-z0-9_=-]+,?)\2/gi;
  for(const [, nombre, , token] of fuente.matchAll(patron)){
    if(vistos.has(token)) continue;
    vistos.add(token);
    archivos.push({titulo: texto(nombre) || 'Documento', url: `${BASE}/PC/bajarArchivo.cpe?Archivo=${token}`});
  }
  return archivos;
}

// El código del portal debe aparecer en el ocid, para no asociar un proceso ajeno.
function codigoCoincide(ocid, codigo){
  const limpio = String(codigo || '').trim().toUpperCase();
  return !!limpio && String(ocid || '').toUpperCase().includes(`-${limpio}-`);
}

function cpcsDe(productos){
  const claves = new Set();
  for(const lote of productos?.lotes || []) if(lote.cpc?.length >= 5) claves.add(lote.cpc);
  for(const item of productos?.items || []) if(item.codigo?.length >= 5) claves.add(item.codigo);
  return [...claves];
}

// OCDS manda; el portal solo llena lo que falta.
function completarObjetivo(ocid, objetivo, portal){
  const base = objetivo || {ocid, titulo: '', texto: '', entidad: '', modalidad: '', fecha: '', cpcs: [], referencial: null, adjudicado: null, oferentes: null, proveedores: [], bajaPct: null};
  const lotes = (portal.productos?.lotes || []).map(lote => lote.descripcion).join(' ');
  const textoPortal = `${portal.objeto || ''} ${lotes}`.trim().slice(0, 1000);
  return {
    ...base,
    titulo: base.titulo || String(portal.objeto || '').slice(0, 300),
    texto: base.texto || textoPortal,
    entidad: base.entidad || portal.entidad || '',
    modalidad: base.modalidad || portal.modalidad || '',
    cpcs: base.cpcs?.length ? base.cpcs : cpcsDe(portal.productos),
    referencial: base.referencial ?? portal.presupuesto ?? null
  };
}

module.exports = {
  PESTANAS,
  idDesdeTexto,
  urlPestana,
  urlFicha,
  esBloqueo,
  parsearDescripcion,
  parsearFechas,
  etapaOperativa,
  parsearProductos,
  parsearArchivos,
  codigoCoincide,
  cpcsDe,
  completarObjetivo
};
