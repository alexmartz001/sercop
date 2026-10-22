'use strict';

// Normalización del registro OCDS publicado por
// https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/datos-abiertos/api
// El tablero no calcula estas etapas en el navegador: el worker las persiste.

const ACTIVE_SYNC_MS = 3 * 60 * 60 * 1000;
const CLOSED_SYNC_MS = 24 * 60 * 60 * 1000;
const GREEN_AFTER_MS = 48 * 60 * 60 * 1000;
const URGENT_WITHIN_MS = 24 * 60 * 60 * 1000;

const ETAPAS = ['Convocatoria', 'Preguntas y Respuestas', 'Calificación', 'Adjudicación', 'Finalizado'];

function extractRuc(value){
  const match = String(value || '').match(/(\d{10,13})/);
  return match ? match[1] : '';
}

function parseAmount(value){
  if(value == null || value === '') return null;
  if(typeof value === 'number') return Number.isFinite(value) ? value : null;
  if(typeof value === 'object'){
    if(value.amount != null) return parseAmount(value.amount);
    if(value.value != null) return parseAmount(value.value);
    return null;
  }
  const cleaned = String(value).trim().replace(/[^0-9,.-]/g, '');
  if(!cleaned) return null;
  let amount;
  if(cleaned.includes(',') && cleaned.includes('.')){
    if(cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) amount = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    else amount = parseFloat(cleaned.replace(/,/g, ''));
  } else if(cleaned.includes(',')){
    const parts = cleaned.split(',');
    amount = (parts[1] && parts[1].length !== 3) ? parseFloat(cleaned.replace(',', '.')) : parseFloat(cleaned.replace(/,/g, ''));
  } else amount = parseFloat(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function validTime(value){
  if(!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function latestIso(values){
  let best = null;
  let bestTime = -Infinity;
  for(const value of values){
    const time = validTime(value);
    if(time == null || time < bestTime) continue;
    bestTime = time;
    best = new Date(time).toISOString();
  }
  return best;
}

function partyBits(party){
  if(!party) return {nombre:'', ruc:''};
  if(typeof party === 'string') return {nombre: party.trim(), ruc: extractRuc(party)};
  const nombre = String(party.name || party.legalName || party.identifier?.legalName || '').trim();
  const ruc = extractRuc(party.id || party.identifier?.id || '');
  return {nombre, ruc};
}

function offerState(status){
  const text = String(status || '');
  if(/disqual|unsuccessful|descalif/i.test(text)) return 'Descalificado';
  if(/valid|qualified|active/i.test(text)) return 'Habilitado';
  return 'Participante';
}

function extractReleaseFacts(releases){
  const list = Array.isArray(releases) ? releases.filter(Boolean) : [];
  const tenders = list.map(release => release.tender).filter(Boolean);
  const plannings = list.map(release => release.planning).filter(Boolean);
  const awards = list.flatMap(release => Array.isArray(release.awards) ? release.awards : (release.award ? [release.award] : []));
  const contracts = list.flatMap(release => Array.isArray(release.contracts) ? release.contracts : (release.contract ? [release.contract] : []));
  const enquiryEnd = latestIso(tenders.map(tender => tender.enquiryPeriod?.endDate));
  const tenderClose = latestIso(tenders.map(tender => tender.tenderPeriod?.endDate));
  const auctionEnd = latestIso(list.flatMap(release => {
    const auctions = Array.isArray(release.auctions) ? release.auctions : [];
    return auctions.flatMap(auction => [
      auction?.period?.endDate,
      ...(Array.isArray(auction?.stages) ? auction.stages.flatMap(stage => (Array.isArray(stage?.rounds) ? stage.rounds.map(round => round?.period?.endDate) : [])) : [])
    ]);
  }));
  const closeDate = tenderClose || auctionEnd;
  const awardEnd = latestIso([
    ...tenders.map(tender => tender.awardPeriod?.endDate),
    ...awards.map(award => award.date)
  ]);
  const contractDate = latestIso(contracts.flatMap(contract => [contract.dateSigned, contract.period?.startDate]));
  const buyerId = String(list.map(release => release.buyer?.id || release.buyer?.identifier?.id).find(Boolean) || '');
  let partida = '';
  let budgetAmount = null;
  for(const planning of plannings){
    const budget = planning.budget || {};
    if(!partida) partida = String(budget.id || budget.description || budget.project || budget.projectID || '').trim();
    if(budgetAmount == null) budgetAmount = parseAmount(budget.amount != null ? budget.amount : budget);
  }
  if(budgetAmount == null){
    for(const tender of tenders){
      const amount = parseAmount(tender.value);
      if(amount != null){ budgetAmount = amount; break; }
    }
  }
  const participantes = [];
  const seen = new Set();
  const push = (item) => {
    const nombre = String(item.proveedor_nombre || '').trim();
    const ruc = extractRuc(item.proveedor_ruc);
    if(!nombre && !ruc) return;
    const key = `${ruc}|${nombre.toLowerCase()}|${item.estado_oferta}`;
    if(seen.has(key)) return;
    seen.add(key);
    participantes.push({
      proveedor_ruc: ruc,
      proveedor_nombre: nombre || ruc,
      estado_oferta: item.estado_oferta,
      monto_oferta: parseAmount(item.monto_oferta)
    });
  };
  for(const release of list){
    const details = release?.bids?.details;
    if(!Array.isArray(details)) continue;
    for(const bid of details){
      const tenderers = Array.isArray(bid.tenderers) ? bid.tenderers : [];
      for(const tenderer of tenderers){
        const bits = partyBits(tenderer);
        push({proveedor_nombre: bits.nombre, proveedor_ruc: bits.ruc, estado_oferta: offerState(bid.status), monto_oferta: bid.value});
      }
    }
  }
  for(const tender of tenders){
    const tenderers = Array.isArray(tender.tenderers) ? tender.tenderers : [];
    for(const tenderer of tenderers){
      const bits = partyBits(tenderer);
      push({proveedor_nombre: bits.nombre, proveedor_ruc: bits.ruc, estado_oferta: 'Participante', monto_oferta: null});
    }
  }
  for(const award of awards){
    const suppliers = Array.isArray(award.suppliers) ? award.suppliers : [];
    const estado = /disqual|unsuccessful|descalif/i.test(String(award.status || '')) ? 'Descalificado' : 'Adjudicado';
    for(const supplier of suppliers){
      const bits = partyBits(supplier);
      push({proveedor_nombre: bits.nombre, proveedor_ruc: bits.ruc, estado_oferta: estado, monto_oferta: award.value});
    }
  }
  const awarded = new Set(participantes.filter(item => item.estado_oferta === 'Adjudicado').map(item => item.proveedor_ruc || item.proveedor_nombre));
  return {
    enquiryEnd,
    closeDate,
    awardEnd,
    contractDate,
    buyerId,
    entidadRuc: extractRuc(buyerId),
    partida,
    budgetAmount,
    participantes: participantes.filter(item => item.estado_oferta !== 'Participante' || !awarded.has(item.proveedor_ruc || item.proveedor_nombre))
  };
}

function cronogramaFromFacts(facts, now){
  const moment = now || Date.now();
  const rows = [];
  const add = (nombre, fecha) => {
    const time = validTime(fecha);
    if(time == null) return;
    rows.push({
      etapa_nombre: nombre,
      fecha_limite: new Date(time).toISOString(),
      completada: time < moment
    });
  };
  add('Preguntas', facts?.enquiryEnd);
  add('Entrega de ofertas', facts?.closeDate);
  add('Adjudicación', facts?.awardEnd);
  add('Contrato', facts?.contractDate);
  return rows;
}

function operationalStage(facts, now){
  const moment = now || Date.now();
  const contracts = Number(facts?.contractsCount) || 0;
  const awards = Number(facts?.awardsCount) || 0;
  const tenders = Number(facts?.tendersCount) || 0;
  if(contracts > 0) return 'Finalizado';
  if(awards > 0) return 'Adjudicación';
  const enquiry = validTime(facts?.enquiryEnd);
  const tenderEnd = validTime(facts?.closeDate);
  if(enquiry != null && enquiry > moment) return 'Preguntas y Respuestas';
  if(tenderEnd != null && tenderEnd > moment) return 'Convocatoria';
  if(tenderEnd != null && tenderEnd <= moment) return 'Calificación';
  if(tenders > 0) return 'Convocatoria';
  return 'Convocatoria';
}

function stageFromStored(row, etapas, now){
  const byName = {};
  for(const etapa of etapas || []) byName[etapa.etapa_nombre] = etapa;
  return operationalStage({
    contractsCount: row?.contracts_count,
    awardsCount: row?.awards_count,
    tendersCount: row?.tenders_count,
    enquiryEnd: byName.Preguntas?.fecha_limite,
    closeDate: byName['Entrega de ofertas']?.fecha_limite
  }, now);
}

function semaphore(etapas, etapa, now){
  const moment = now || Date.now();
  if(etapa === 'Finalizado') return {color:'rojo', urgente:false, horas:null, fecha:null, label:'proceso cerrado'};
  if(etapa === 'Adjudicación') return {color:'rojo', urgente:false, horas:null, fecha:null, label:'adjudicado'};
  const relevant = etapa === 'Preguntas y Respuestas'
    ? ['Preguntas', 'Entrega de ofertas']
    : (etapa === 'Convocatoria' || etapa === 'Calificación')
      ? ['Entrega de ofertas', 'Preguntas']
      : null;
  const source = relevant ? (etapas || []).filter(item => relevant.includes(item.etapa_nombre)) : (etapas || []);
  const open = source
    .map(item => ({...item, time: validTime(item.fecha_limite)}))
    .filter(item => item.time != null && !item.completada && item.time >= moment)
    .sort((a, b) => a.time - b.time);
  if(!open.length){
    const published = (etapas || []).some(item => validTime(item.fecha_limite) != null);
    return {color:'rojo', urgente:false, horas: published ? 0 : null, fecha:null, label: published ? 'plazo vencido' : 'sin plazo publicado'};
  }
  const next = open[0];
  const remain = next.time - moment;
  const horas = Math.max(0, Math.round(remain / 3600000));
  if(remain > GREEN_AFTER_MS) return {color:'verde', urgente:false, horas, fecha: next.fecha_limite, label:'más de 48 h'};
  if(remain <= URGENT_WITHIN_MS) return {color:'amarillo', urgente:true, horas, fecha: next.fecha_limite, label:'menos de 24 h'};
  return {color:'amarillo', urgente:false, horas, fecha: next.fecha_limite, label:'menos de 48 h'};
}

function syncIntervalMs(etapa){
  if(etapa === 'Adjudicación' || etapa === 'Finalizado') return CLOSED_SYNC_MS;
  return ACTIVE_SYNC_MS;
}

function isSyncDue(row, now){
  const moment = now || Date.now();
  const synced = validTime(row?.synced_at);
  if(synced == null) return true;
  return moment - synced >= syncIntervalMs(row?.estado_actual);
}

module.exports = {
  ACTIVE_SYNC_MS,
  CLOSED_SYNC_MS,
  ETAPAS,
  extractRuc,
  parseAmount,
  extractReleaseFacts,
  cronogramaFromFacts,
  operationalStage,
  stageFromStored,
  semaphore,
  syncIntervalMs,
  isSyncDue
};
