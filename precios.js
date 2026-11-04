'use strict';

// Reporte de precios: cuánto se rebajó, respecto del referencial, en procesos
// comparables ya adjudicados. Se calcula solo con registros OCDS oficiales de
// datosabiertos.compraspublicas.gob.ec; este módulo no hace peticiones.

const { parseAmount, extractRuc } = require('./ocds');

const MIN_MUESTRA = 5;
const MAX_BAJA_PCT = 90; // Una rebaja mayor suele ser un error de carga del monto.
const MAX_SIMILARES = 8;
const MAX_PROVEEDORES = 5;

const PALABRAS_GENERICAS = new Set([
  'adquisicion', 'contratacion', 'servicio', 'servicios', 'compra', 'provision', 'suministro',
  'bienes', 'otros', 'otras', 'para', 'del', 'las', 'los', 'con', 'por', 'uso', 'una', 'uno',
  'institucion', 'entidad', 'nacional', 'provincia', 'canton', 'gobierno', 'direccion', 'posibles',
  'incidentes', 'plataforma', 'general', 'varios', 'varias', 'parte', 'partes', 'sercop'
]);

function normalizar(texto){
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function redondear(valor, decimales = 2){
  if(valor == null || !Number.isFinite(valor)) return null;
  const factor = 10 ** decimales;
  return Math.round(valor * factor) / factor;
}

function percentil(valores, p){
  const lista = valores.filter(Number.isFinite).sort((a, b) => a - b);
  if(!lista.length) return null;
  const posicion = (lista.length - 1) * p;
  const piso = Math.floor(posicion);
  const techo = Math.ceil(posicion);
  return lista[piso] + (lista[techo] - lista[piso]) * (posicion - piso);
}

function promedio(valores){
  const lista = valores.filter(Number.isFinite);
  return lista.length ? lista.reduce((suma, valor) => suma + valor, 0) / lista.length : null;
}

// SERCOP publica el mismo CPC como 512900011 y como 51290.00.1.
function claveCpc(codigo){
  return String(codigo || '').replace(/\D/g, '');
}

function cpcsDeItems(items){
  const claves = new Set();
  for(const item of items || []){
    const codigos = [item?.classification, ...(Array.isArray(item?.additionalClassifications) ? item.additionalClassifications : [])];
    for(const codigo of codigos){
      if(!codigo) continue;
      if(codigo.scheme && !/cpc/i.test(codigo.scheme)) continue;
      const clave = claveCpc(codigo.id);
      if(clave.length >= 5) claves.add(clave);
    }
  }
  return [...claves];
}

function valorDeItems(items){
  let total = 0;
  let conValor = 0;
  for(const item of items || []){
    const unitario = parseAmount(item?.unit?.value);
    const cantidad = Number(item?.quantity);
    if(unitario == null || !Number.isFinite(cantidad) || cantidad <= 0) continue;
    total += unitario * cantidad;
    conValor++;
  }
  return conValor ? total : null;
}

function esAdjudicacionVigente(award){
  return !/cancel|unsuccessful|disqual|descalif|desiert/i.test(String(award?.status || ''));
}

// Lee un registro OCDS y deja solo lo que el reporte necesita.
function comparableDeRegistro(ocid, releases){
  const lista = (Array.isArray(releases) ? releases : []).filter(Boolean);
  const tenders = lista.map(release => release.tender).filter(Boolean);
  const items = tenders.flatMap(tender => Array.isArray(tender.items) ? tender.items : []);
  const awards = lista.flatMap(release => Array.isArray(release.awards) ? release.awards : []).filter(esAdjudicacionVigente);
  const contracts = lista.flatMap(release => Array.isArray(release.contracts) ? release.contracts : []);
  const ultimo = tenders[tenders.length - 1] || {};
  const planning = lista.map(release => release.planning).find(Boolean) || {};

  // Con varios lotes, comparar el total del proceso contra una adjudicación
  // parcial inflaría la rebaja: se usa solo el valor de los ítems adjudicados.
  const idsAdjudicados = new Set(awards.flatMap(award => (Array.isArray(award.items) ? award.items : []).map(item => String(item?.id))));
  const itemsAdjudicados = items.filter(item => idsAdjudicados.has(String(item?.id)));
  const referencialItems = valorDeItems(itemsAdjudicados.length ? itemsAdjudicados : items);
  const referencialTotal = tenders.map(tender => parseAmount(tender.value)).find(valor => valor != null);
  const presupuestoPlan = parseAmount(planning.budget?.amount);
  const referencial = (itemsAdjudicados.length && referencialItems != null)
    ? referencialItems
    : (referencialTotal ?? referencialItems ?? presupuestoPlan ?? null);

  const montosAdjudicados = awards.map(award => parseAmount(award.value)).filter(valor => valor != null);
  const montosContratos = contracts.map(contract => parseAmount(contract.value)).filter(valor => valor != null);
  const adjudicado = montosAdjudicados.length
    ? montosAdjudicados.reduce((suma, valor) => suma + valor, 0)
    : (montosContratos.length ? montosContratos.reduce((suma, valor) => suma + valor, 0) : null);

  const proveedores = [];
  for(const award of awards){
    for(const supplier of Array.isArray(award.suppliers) ? award.suppliers : []){
      const nombre = String(supplier?.name || '').trim();
      if(nombre) proveedores.push({nombre, ruc: extractRuc(supplier?.id), monto: parseAmount(award.value)});
    }
  }
  const oferentes = Number(ultimo.numberOfTenderers);
  const baja = (referencial > 0 && adjudicado > 0) ? (1 - adjudicado / referencial) * 100 : null;
  const descripcion = String(ultimo.description || ultimo.title || planning.rationale || '').trim();
  const textoItems = [...new Set(items.flatMap(item => [
    item?.description,
    item?.classification?.description,
    ...(Array.isArray(item?.additionalClassifications) ? item.additionalClassifications.map(codigo => codigo?.description) : [])
  ]).filter(Boolean).map(String))].join(' ');

  return {
    ocid,
    titulo: descripcion.slice(0, 300),
    texto: `${descripcion} ${textoItems}`.trim().slice(0, 1000),
    entidad: String(lista.map(release => release.buyer?.name).find(Boolean) || ''),
    modalidad: String(ultimo.procurementMethodDetails || ultimo.procurementMethod || ''),
    fecha: String(awards.map(award => award.date).find(Boolean) || lista.map(release => release.date).find(Boolean) || ''),
    cpcs: cpcsDeItems(items),
    referencial: redondear(referencial),
    adjudicado: redondear(adjudicado),
    oferentes: Number.isFinite(oferentes) && oferentes > 0 ? oferentes : null,
    proveedores,
    bajaPct: redondear(baja)
  };
}

function esUtil(comparable){
  return comparable?.bajaPct != null && comparable.bajaPct >= 0 && comparable.bajaPct <= MAX_BAJA_PCT;
}

function terminosBusqueda(texto, limite = 3){
  const original = String(texto || '');
  // SERCOP suele publicar todo en mayúsculas: ahí no se distingue una sigla.
  const letras = original.replace(/[^\p{L}]/gu, '');
  const mayusculas = letras.replace(/[^\p{Lu}]/gu, '').length;
  const distingueSiglas = letras.length > 0 && mayusculas / letras.length < 0.5;
  const siglas = distingueSiglas ? (original.match(/\b[A-ZÁÉÍÓÚÑ]{3,6}\b/g) || []).map(normalizar) : [];
  const conteo = new Map();
  for(const palabra of normalizar(original).split(/[^a-z0-9]+/)){
    if(palabra.length < 5 || /^\d+$/.test(palabra) || PALABRAS_GENERICAS.has(palabra)) continue;
    conteo.set(palabra, (conteo.get(palabra) || 0) + 1);
  }
  const palabras = [...conteo.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([palabra]) => palabra);
  const siglasUtiles = siglas.filter(sigla => !PALABRAS_GENERICAS.has(sigla));
  return [...new Set([...siglasUtiles, ...palabras])].slice(0, limite);
}

// Elige el criterio más estricto que deje una muestra suficiente. El texto queda
// al final porque una coincidencia de palabras no garantiza el mismo producto.
function seleccionarComparables(objetivo, candidatos){
  const utiles = candidatos.filter(item => item.ocid !== objetivo.ocid && esUtil(item));
  const claves = new Set(objetivo.cpcs || []);
  const clases = new Set([...claves].map(clave => clave.slice(0, 5)));
  const exactos = utiles.filter(item => (item.cpcs || []).some(clave => claves.has(clave)));
  if(exactos.length >= MIN_MUESTRA) return {nivel: 'cpc', etiqueta: 'mismo código CPC', items: exactos};
  const misClase = utiles.filter(item => (item.cpcs || []).some(clave => clases.has(clave.slice(0, 5))));
  if(misClase.length) return {nivel: 'clase', etiqueta: 'misma clase CPC (5 dígitos)', items: misClase};
  return {nivel: 'texto', etiqueta: 'palabras parecidas, sin coincidencia de CPC', items: claves.size ? [] : utiles};
}

// Una contratación directa adjudica casi siempre al referencial: mezclarla con
// subastas competidas llevaría la rebaja mediana a cero sin que signifique nada.
function acotarPorModalidad(objetivo, items){
  const modalidad = normalizar(objetivo.modalidad);
  const misma = modalidad ? items.filter(item => normalizar(item.modalidad) === modalidad) : [];
  if(misma.length >= MIN_MUESTRA) return {items: misma, etiqueta: 'misma modalidad'};
  if(modalidad.includes('regimen especial')) return {items, etiqueta: 'todas las modalidades'};
  const competidos = items.filter(item => item.oferentes >= 2);
  if(competidos.length) return {items: competidos, etiqueta: 'procesos con dos o más oferentes'};
  return {items, etiqueta: 'todas las modalidades'};
}

function construirReporte(objetivo, candidatos, opciones = {}){
  const seleccion = seleccionarComparables(objetivo, candidatos);
  const acotados = acotarPorModalidad(objetivo, seleccion.items);
  const items = acotados.items;
  const bajas = items.map(item => item.bajaPct);
  const montos = items.map(item => item.adjudicado);
  const p25 = percentil(bajas, 0.25);
  const p50 = percentil(bajas, 0.5);
  const p75 = percentil(bajas, 0.75);
  const presupuesto = objetivo.referencial;
  const aMonto = pct => (presupuesto > 0 && pct != null) ? redondear(presupuesto * (1 - pct / 100)) : null;

  const mismaEntidad = items.filter(item => objetivo.entidad && normalizar(item.entidad) === normalizar(objetivo.entidad));
  const porProveedor = new Map();
  for(const item of items){
    for(const proveedor of item.proveedores || []){
      const clave = proveedor.ruc || normalizar(proveedor.nombre);
      const fila = porProveedor.get(clave) || {nombre: proveedor.nombre, ruc: proveedor.ruc, adjudicaciones: 0, monto: 0};
      fila.adjudicaciones++;
      fila.monto += proveedor.monto || 0;
      porProveedor.set(clave, fila);
    }
  }
  const distancia = item => presupuesto > 0 ? Math.abs((item.referencial || 0) - presupuesto) : -Date.parse(item.fecha || 0);

  return {
    ocid: objetivo.ocid,
    objeto: objetivo.titulo,
    entidad: objetivo.entidad,
    presupuesto: presupuesto ?? null,
    cpcs: objetivo.cpcs || [],
    criterio: {nivel: seleccion.nivel, etiqueta: `${seleccion.etiqueta}, ${acotados.etiqueta}`},
    muestra: items.length,
    suficiente: items.length >= MIN_MUESTRA,
    baja: items.length ? {p25: redondear(p25), p50: redondear(p50), p75: redondear(p75)} : null,
    rangoSugerido: (presupuesto > 0 && items.length) ? {desde: aMonto(p75), hasta: aMonto(p25), mediana: aMonto(p50)} : null,
    adjudicado: items.length ? {mediana: redondear(percentil(montos, 0.5)), promedio: redondear(promedio(montos))} : null,
    medianaOferentes: redondear(percentil(items.map(item => item.oferentes), 0.5), 1),
    entidadHistorial: mismaEntidad.length ? {procesos: mismaEntidad.length, medianaBaja: redondear(percentil(mismaEntidad.map(item => item.bajaPct), 0.5))} : null,
    proveedores: [...porProveedor.values()]
      .sort((a, b) => b.adjudicaciones - a.adjudicaciones || b.monto - a.monto)
      .slice(0, MAX_PROVEEDORES)
      .map(fila => ({...fila, monto: redondear(fila.monto)})),
    similares: [...items].sort((a, b) => distancia(a) - distancia(b)).slice(0, MAX_SIMILARES).map(item => ({
      ocid: item.ocid,
      titulo: item.titulo,
      entidad: item.entidad,
      fecha: item.fecha,
      referencial: item.referencial,
      adjudicado: item.adjudicado,
      bajaPct: item.bajaPct,
      oferentes: item.oferentes
    })),
    cobertura: {
      analizados: candidatos.length,
      pendientes: opciones.pendientes || 0,
      periodo: opciones.periodo || '',
      aviso: opciones.aviso || ''
    }
  };
}

module.exports = {
  MIN_MUESTRA,
  percentil,
  claveCpc,
  comparableDeRegistro,
  esUtil,
  terminosBusqueda,
  seleccionarComparables,
  construirReporte
};
