/* ===========================================================================
   HOPE — municipios, uno por uno.

   La lista completa que hace falta para sustentar una petición: todos los
   municipios con sacudida modelada, agrupados por departamento, con su
   energía y su conectividad.

   Va TODO el listado, también lo que está bien. Una tabla de la que faltan
   municipios no sustenta nada, porque quien la recibe no puede distinguir
   «no está» de «está bien».
   =========================================================================== */

'use strict';

const BASES = ['/api', 'http://127.0.0.1:8000/api'];
const S = { base: null, datos: null };

const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('es-CO');

const CLASE = {
  sin_luz_y_sin_red:  { et: 'Sin luz y sin red', color: '#e03131' },
  sin_luz:            { et: 'Sin luz',           color: '#e03131' },
  sin_red:            { et: 'Sin red',           color: '#f59f00' },
  punto_ciego:        { et: 'Nadie lo ha medido', color: '#9c36b5' },
  solo_heredado:      { et: 'Solo el promedio del depto.', color: '#748ffc' },
  medido_sin_novedad: { et: 'Medido, sin novedad', color: '#2f9e44' },
  fuera_del_area:     { et: 'Fuera del área sacudida', color: '#495057' },
};

const CERTEZA = {
  no_aplica: { et: '—', tit: 'El USGS no modeló sacudida aquí: no hay nada que medir' },
  local:    { et: 'local',    tit: 'Se midió en este municipio' },
  heredada: { et: 'heredada', tit: 'Solo se conoce el promedio de su departamento' },
  ninguna:  { et: 'ninguna',  tit: 'Nadie lo ha medido' },
};

const NECESITA = {
  ENERGIA: 'Planta y combustible',
  RED: 'Cuadrilla o enlace',
  ENERGIA_Y_RED: 'Energía y enlace',
  ENLACE: 'Enlace autónomo',
};

iniciar().catch((e) => {
  console.error(e);
  toast('No se pudo iniciar: ' + e.message, true);
});

async function iniciar() {
  conectar();
  S.base = await elegirBase();
  if (!S.base) {
    $('#resumen').innerHTML =
      '<p class="fallo">No hay backend respondiendo. Esta vista cruza cuatro ' +
      'fuentes y necesita el servidor de HOPE.</p>';
    return;
  }
  await cargar();
}

async function elegirBase() {
  for (const b of BASES) {
    try {
      const r = await fetch(`${b}/salud`, { cache: 'no-store' });
      if (r.ok) return b;
    } catch (_) { /* siguiente */ }
  }
  return null;
}

function conectar() {
  $('#f-mmi').onchange = cargar;
  $('#f-depto').onchange = pintar;
  $('#f-atender').onchange = pintar;
}

async function cargar() {
  const mmi = $('#f-mmi').value;
  $('#departamentos').innerHTML = '<p class="cargando">Midiendo los municipios…</p>';
  try {
    const d = await (await fetch(`${S.base}/mapa/municipios?mmi_min=${mmi}`)).json();
    S.datos = d;
    $('#btn-csv').href = `${S.base}/mapa/municipios.csv?mmi_min=${mmi}`;
    pintarResumen(d);
    llenarSelectorDepto(d);
    pintar();
  } catch (e) {
    $('#departamentos').innerHTML =
      `<p class="fallo">No se pudo medir: ${escapar(e.message)}</p>`;
  }
}

function pintarResumen(d) {
  const r = d.resumen;
  const cifras = [
    ['', r.lugares, 'municipios con sacudida modelada'],
    ['', r.departamentos, 'departamentos'],
    ['alarma', r.puntos_ciegos, 'sin <b>ninguna</b> medición'],
    ['alarma', r.poblacion_en_puntos_ciegos, 'personas en esos municipios'],
    ['aviso', (r.por_clase || {}).sin_luz || 0, 'con pérdida de luz medida'],
    ['', r.medidos_localmente, 'con medición <b>local</b>'],
  ];
  $('#resumen').innerHTML = cifras.map(([cl, n, t]) =>
    `<div class="cifra ${cl}"><b>${nf.format(n || 0)}</b><span>${t}</span></div>`).join('');

  const claves = Object.keys(d.fallos || {});
  $('#fallos').innerHTML = claves.length
    ? `<div class="fallo"><strong>Ojo:</strong> no respondieron ${claves.map(escapar).join(', ')}. ` +
      'Lo que sí se midió va igual; el hueco no se rellena con estimaciones.</div>'
    : '';

  // Los umbrales de la capa de luz y su tasa de error, dichos en la cara.
  const dv = d.deriva_luz || {};
  const nota = $('#nota-umbrales');
  if (nota && dv.umbral_sin_luz_pct != null) {
    nota.innerHTML =
      `Los umbrales de energía no son números redondos: salen del propio ruido ` +
      `de la medida. «Sin luz» exige caer por debajo de ${dv.umbral_sin_luz_pct}% ` +
      `y «poca luz» por debajo de ${dv.umbral_poca_luz_pct}%, que son los ` +
      `percentiles 2 y 10 de ${dv.poblados_de_control} municipios de control ` +
      `donde el sismo no rompió nada. <b>Eso fija la tasa de error: de cada 100 ` +
      `marcados «sin luz», unos 2 lo estarán por ruido.</b> Antes se usaba un ` +
      `umbral fijo de −35% que habría marcado como apagado al 3% del grupo de ` +
      `control — decenas de municipios sin daño.`;
  }
}

function llenarSelectorDepto(d) {
  const sel = $('#f-depto');
  const actual = sel.value;
  sel.innerHTML = '<option value="">todos los departamentos</option>' +
    d.departamentos.map((g) =>
      `<option value="${escapar(g.departamento)}">${escapar(g.departamento)} ` +
      `(${g.total})</option>`).join('');
  sel.value = actual;
}

function pintar() {
  if (!S.datos) return;
  const filtroDepto = $('#f-depto').value;
  const soloAtender = $('#f-atender').checked;
  const cont = $('#departamentos');
  cont.innerHTML = '';

  const grupos = S.datos.departamentos.filter(
    (g) => !filtroDepto || g.departamento === filtroDepto);

  if (!grupos.length) {
    cont.innerHTML = '<p class="hint">Nada que mostrar con estos filtros.</p>';
    return;
  }

  grupos.forEach((g) => {
    const munis = soloAtender
      ? g.municipios.filter((m) => m.necesita)
      : g.municipios;
    if (!munis.length) return;
    cont.appendChild(tarjetaDepto(g, munis, soloAtender));
  });
}

function tarjetaDepto(g, munis, filtrado) {
  const el = document.createElement('section');
  el.className = 'depto';

  const red = g.red || {};
  const redTxt = red.clase
    ? `Red del departamento: <b>${escapar(red.clase.replace(/_/g, ' '))}</b>` +
      (red.delta_acceso_pct != null
        ? ` · acceso ${red.delta_acceso_pct}%, troncal ${red.delta_troncal_pct ?? 's/d'}%`
        : '')
    : 'Red del departamento: sin medición de IODA en esta ventana.';

  el.innerHTML = `
    <div class="depto-head">
      <h2>${escapar(g.departamento)}</h2>
      <div class="depto-cifras">
        <span><b>${g.total}</b> municipios</span>
        <span><b>${g.con_sacudida}</b> con sacudida modelada</span>
        <span class="${g.por_atender ? 'aten' : ''}"><b>${g.por_atender}</b> por atender</span>
        <span><b>${nf.format(g.poblacion)}</b> hab. en cabeceras</span>
        <span>máx. <b>MMI ${g.mmi_max.toFixed(1)}</b></span>
      </div>
      <p class="hint">${redTxt}</p>
    </div>
    <div class="tabla-envoltura">
      <table class="tabla-muni">
        <thead><tr>
          <th>Municipio</th><th>Hab.</th><th>MMI</th>
          <th>Energía</th><th>Red</th><th>Certeza</th><th>Qué necesita</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    ${filtrado && munis.length < g.total
      ? `<p class="hint">Se ocultaron ${g.total - munis.length} municipios sin novedad.</p>`
      : ''}`;

  const tb = el.querySelector('tbody');
  munis.forEach((m) => tb.appendChild(filaMuni(m, g)));
  return el;
}

function filaMuni(m, g) {
  const tr = document.createElement('tr');
  const c = CLASE[m.clase] || {};
  const luz = m.luz || {};
  const red = m.red_departamento || {};
  const cert = CERTEZA[m.certeza] || {};

  // Energía: se distingue «midió y está mal» de «no se pudo medir», de «no hay
  // dónde medir» y de «no hay nada que medir porque aquí no tembló». Las cuatro
  // se ven distintas porque significan cosas distintas.
  let energia;
  if (m.clase === 'fuera_del_area') {
    energia = '<span class="nd" title="El USGS no modeló sacudida aquí">—</span>';
  } else if (luz.utilizable) {
    energia = luz.clase === 'sin_luz' || luz.clase === 'poca_luz'
      ? `<span class="mal">${luz.cambio_pct}%</span>`
      : `<span class="bien">${luz.cambio_pct > 0 ? '+' : ''}${luz.cambio_pct}%</span>`;
  } else if (luz.clase === 'sin_punto') {
    energia = '<span class="nd" title="No se conoce el casco urbano: no hay dónde medir">sin punto</span>';
  } else {
    energia = '<span class="nd" title="Se midió pero el número no concluye">no concluye</span>';
  }

  const redTxt = red.clase
    ? `<span title="Dato del departamento ${escapar(g.departamento)}, no de este municipio">` +
      `${escapar(red.clase.replace(/_/g, ' '))}</span>`
    : '<span class="nd">sin dato</span>';

  const nombre = escapar(m.nombre) +
    (m.nombre_poblado ? ` <small>(${escapar(m.nombre_poblado)})</small>` : '');

  tr.innerHTML = `
    <td class="nom"><span class="punto" style="background:${c.color || '#666'}"
      title="${escapar(c.et || m.clase)}"></span>${nombre}</td>
    <td class="num">${m.poblacion ? nf.format(m.poblacion) : '—'}</td>
    <td class="num">${m.mmi === null ? '<span class="nd">—</span>' : m.mmi.toFixed(1)}</td>
    <td>${energia}</td>
    <td>${redTxt}</td>
    <td><span class="cert cert-${m.certeza}" title="${escapar(cert.tit || '')}">${escapar(cert.et || m.certeza)}</span></td>
    <td>${m.necesita ? `<b>${escapar(NECESITA[m.necesita] || m.necesita)}</b>` : '—'}</td>`;
  tr.title = m.necesita_texto || (m.luz && m.luz.lectura) || '';
  return tr;
}

function escapar(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

let tToast;
function toast(txt, esError) {
  const el = $('#toast');
  el.textContent = txt;
  el.className = 'toast' + (esError ? ' err' : '');
  el.hidden = false;
  clearTimeout(tToast);
  tToast = setTimeout(() => { el.hidden = true; }, esError ? 6000 : 3000);
}
