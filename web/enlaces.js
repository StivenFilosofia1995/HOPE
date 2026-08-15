/* ===========================================================================
   HOPE — sala de enlaces.

   Redacta las peticiones de conectividad y las deja listas para enviar. El
   envío lo hace la persona desde su propio correo, a propósito: ver la nota
   de diseño en backend/enlaces.py.

   Todo lo que se escribe aquí (nombre, teléfono, a quién ya se le escribió)
   vive SOLO en este navegador. No hay cuenta, no hay base de datos y el
   servidor no guarda nada de esto: solo recibe los datos del remitente el
   instante que tarda en firmar las cartas, y los devuelve dentro del texto.
   =========================================================================== */

'use strict';

const BASES = ['/api', 'http://127.0.0.1:8000/api'];
const CLAVE_REMITENTE = 'hope.remitente.v1';
const CLAVE_MARCAS = 'hope.enlaces.marcas.v1';

const S = { base: null, directorio: null, cartas: null, evidencia: null };

const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('es-CO');

// ── Arranque ────────────────────────────────────────────────────────────────

iniciar().catch((e) => {
  console.error(e);
  toast('No se pudo iniciar: ' + e.message, true);
});

async function iniciar() {
  cargarRemitente();
  conectar();

  S.base = await elegirBase();
  if (!S.base) {
    $('#evidencia').innerHTML =
      '<p class="fallo">No hay backend respondiendo. Esta vista necesita el ' +
      'servidor de HOPE porque reúne varias fuentes a la vez y algunas no se ' +
      'pueden consultar desde el navegador. Levántalo con ' +
      '<code>uvicorn backend.main:app</code> o abre la versión desplegada.</p>';
    $('#btn-generar').disabled = true;
    return;
  }

  // Las dos en paralelo: el directorio es estático y la evidencia tarda unos
  // segundos, no hay razón para encadenarlas.
  const [dir] = await Promise.all([cargarDirectorio(), cargarEvidencia()]);
  if (dir) pintarGrupos(dir);
}

async function elegirBase() {
  for (const b of BASES) {
    try {
      const r = await fetch(`${b}/salud`, { cache: 'no-store' });
      if (r.ok) return b;
    } catch (_) { /* se prueba la siguiente */ }
  }
  return null;
}

// ── Evidencia en vivo ───────────────────────────────────────────────────────

async function cargarEvidencia() {
  try {
    const d = await (await fetch(`${S.base}/mapa/lugares`)).json();
    S.evidencia = d;
    pintarEvidencia(d);
  } catch (e) {
    $('#evidencia').innerHTML =
      `<p class="fallo">No se pudo medir ahora mismo (${escapar(e.message)}). ` +
      'Las cartas se pueden escribir igual, pero irán sin cifras — y una ' +
      'petición sin datos dentro es mucho más fácil de archivar.</p>';
  }
}

function pintarEvidencia(d) {
  const r = d.resumen || {};
  const cifras = [
    ['alarma', r.puntos_ciegos, 'pueblos que temblaron fuerte y <b>nadie ha medido</b>'],
    ['alarma', r.poblacion_en_puntos_ciegos, 'personas viven en esos pueblos'],
    ['aviso', (r.por_clase || {}).sin_luz || 0, 'pueblos con pérdida de luz medida por satélite'],
    ['', r.lugares, 'poblados evaluados uno por uno'],
    ['', r.poblacion_expuesta, 'personas dentro de la zona sacudida'],
    ['', r.medidos_localmente, 'con medición <b>local</b> (el resto es promedio o nada)'],
  ];
  $('#evidencia').innerHTML = cifras.map(([cl, n, txt]) =>
    `<div class="cifra ${cl}"><b>${nf.format(n || 0)}</b><span>${txt}</span></div>`).join('');

  // Los fallos de fuente se dicen. Una carta que promete cifras que no se
  // pudieron medir se cae en cuanto alguien la revisa.
  const f = d.fallos || {};
  const claves = Object.keys(f);
  $('#evidencia-fallos').innerHTML = claves.length
    ? `<div class="fallo"><strong>Ojo:</strong> ${claves.length} fuente(s) no ` +
      `respondieron en esta consulta (${claves.map(escapar).join(', ')}). Las ` +
      'cartas se escriben con lo que sí se midió y no rellenan el hueco con ' +
      'estimaciones — pero conviene reintentar antes de enviarlas.</div>'
    : '';
}

// ── Directorio ──────────────────────────────────────────────────────────────

async function cargarDirectorio() {
  try {
    const d = await (await fetch(`${S.base}/enlaces/destinatarios`)).json();
    S.directorio = d;
    return d;
  } catch (e) {
    toast('No se pudo cargar el directorio: ' + e.message, true);
    return null;
  }
}

const ETQ_PIDE = {
  via_estado: ['via', 'solo lo pide el Estado'],
  via_organizacion: ['via', 'vía organización verificada'],
};

function pintarGrupos(dir) {
  const cont = $('#grupos');
  cont.innerHTML = '';

  Object.entries(dir.grupos).forEach(([clave, g]) => {
    const dests = dir.destinatarios.filter((d) => d.grupo === clave);
    if (!dests.length) return;

    const h = document.createElement('h2');
    h.className = 'grupo-titulo';
    h.textContent = g.titulo;
    cont.appendChild(h);

    const p = document.createElement('p');
    p.className = 'grupo-porque';
    p.textContent = g.por_que;
    cont.appendChild(p);

    dests.forEach((d) => cont.appendChild(tarjetaDestinatario(d)));
  });
}

function tarjetaDestinatario(d) {
  const el = document.createElement('article');
  el.className = 'dest';
  el.id = 'dest-' + d.id;
  const marca = marcas()[d.id] || '';
  if (marca) el.dataset.marca = marca;

  const verificado = d.estado === 'verificado';
  const etqCanal = verificado
    ? '<span class="etq ok">correo verificado</span>'
    : '<span class="etq dudosa">sin correo público</span>';
  const etqPide = ETQ_PIDE[d.pide]
    ? `<span class="etq ${ETQ_PIDE[d.pide][0]}">${ETQ_PIDE[d.pide][1]}</span>`
    : '';

  const canalHTML = d.canal === 'correo'
    ? `<span class="canal">${escapar(d.valor)}${d.copia ? ' · copia: ' + escapar(d.copia) : ''}</span>`
    : `<a class="canal" href="${escapar(d.valor)}" target="_blank" rel="noopener">${escapar(d.valor)}</a>`;

  el.innerHTML = `
    <div class="dest-head">
      <div class="crece">
        <h3>${escapar(d.nombre)}${etqCanal}${etqPide}</h3>
        ${canalHTML}
        <p class="hint">${escapar(d.puede_dar)}</p>
      </div>
      <div class="marca-estado">
        <select title="En qué va esta petición">
          <option value="">sin enviar</option>
          <option value="enviado">enviado</option>
          <option value="respondio">respondió</option>
          <option value="comprometio">se comprometió</option>
          <option value="descartado">descartado</option>
        </select>
      </div>
    </div>
    ${d.clave ? `<p class="dest-clave">${escapar(d.clave)}</p>` : ''}
    <div class="dest-cuerpo" hidden>
      <p class="hint">La carta aparecerá aquí cuando pulses «Escribir todas las cartas».</p>
    </div>`;

  const sel = el.querySelector('select');
  sel.value = marca;
  sel.onchange = () => {
    const m = marcas();
    if (sel.value) m[d.id] = sel.value; else delete m[d.id];
    guardarMarcas(m);
    if (sel.value) el.dataset.marca = sel.value; else delete el.dataset.marca;
  };
  // El <select> vive dentro de la cabecera clicable: sin esto, elegir un
  // estado plegaría la carta que se está mirando.
  sel.onclick = (e) => e.stopPropagation();

  el.querySelector('.dest-head').onclick = () => {
    const c = el.querySelector('.dest-cuerpo');
    c.hidden = !c.hidden;
  };
  return el;
}

// ── Generar las cartas ──────────────────────────────────────────────────────

function conectar() {
  $('#form-remitente').addEventListener('input', guardarRemitente);
  $('#btn-generar').onclick = generar;
  $('#btn-zip').onclick = descargarZip;
}

function cuerpoPeticion() {
  const f = new FormData($('#form-remitente'));
  const g = (k) => (f.get(k) || '').toString().trim();
  return {
    remitente: {
      nombre: g('nombre'), cargo: g('cargo'), organizacion: g('organizacion'),
      ciudad: g('ciudad'), telefono: g('telefono'), correo: g('correo'),
    },
    url_mapa: g('url_mapa'),
  };
}

async function generar() {
  const b = $('#btn-generar');
  b.disabled = true;
  b.textContent = 'Escribiendo…';
  $('#estado-generar').textContent = 'Consultando las fuentes y redactando…';

  try {
    const r = await fetch(`${S.base}/enlaces/cartas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpoPeticion()),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const d = await r.json();
    S.cartas = d.cartas;
    d.cartas.forEach(pintarCarta);
    $('#btn-zip').disabled = false;
    $('#estado-generar').textContent =
      `${d.cartas.length} cartas listas. Ábrelas, léelas y envíalas desde tu correo.`;
    toast(`${d.cartas.length} cartas escritas.`);
  } catch (e) {
    $('#estado-generar').textContent = '';
    toast('No se pudieron escribir: ' + e.message, true);
  } finally {
    b.disabled = false;
    b.textContent = 'Escribir todas las cartas';
  }
}

function pintarCarta(c) {
  const d = c.destinatario;
  const el = document.getElementById('dest-' + d.id);
  if (!el) return;
  const cont = el.querySelector('.dest-cuerpo');

  const idT = 'carta-' + d.id;
  cont.innerHTML = `
    <p class="hint"><strong>Asunto:</strong> ${escapar(c.asunto)}</p>
    <textarea class="carta-texto" id="${idT}" spellcheck="false"></textarea>
    <div class="carta-acciones"></div>
    ${c.enviable_directo ? '' :
      '<p class="hint">Esta organización no publica un correo que se haya podido ' +
      'verificar. Copia el texto y pégalo en su canal oficial, enlazado arriba. ' +
      'No se inventa una dirección: una carta a un correo adivinado no rebota, ' +
      'se pierde en silencio.</p>'}`;

  // El texto va por .value y no dentro del HTML: así ni las comillas ni los
  // signos < de la carta pueden romper el marcado ni inyectar nada.
  const ta = cont.querySelector('textarea');
  ta.value = c.cuerpo;

  const acc = cont.querySelector('.carta-acciones');

  const bCopiar = document.createElement('button');
  bCopiar.className = 'btn btn-primario';
  bCopiar.textContent = 'Copiar carta';
  bCopiar.onclick = () => copiar(ta, bCopiar);
  acc.appendChild(bCopiar);

  if (c.enviable_directo) {
    const a = document.createElement('a');
    a.className = 'btn btn-sec';
    a.textContent = 'Abrir en mi correo';
    // El cuerpo se toma del textarea, no de la respuesta: si la persona editó
    // la carta, se envía lo que está viendo, que es lo que firmó.
    a.onclick = () => {
      const cc = c.copia ? `&cc=${encodeURIComponent(c.copia)}` : '';
      a.href = `mailto:${encodeURIComponent(c.para)}` +
               `?subject=${encodeURIComponent(c.asunto)}${cc}` +
               `&body=${encodeURIComponent(ta.value)}`;
    };
    a.href = '#';
    acc.appendChild(a);
  } else if (d.valor) {
    const a = document.createElement('a');
    a.className = 'btn btn-sec';
    a.href = d.valor;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Abrir su canal oficial';
    acc.appendChild(a);
  }

  const bEml = document.createElement('button');
  bEml.className = 'btn btn-sec';
  bEml.textContent = 'Guardar .eml';
  bEml.onclick = () => descargarEml(c, ta.value);
  acc.appendChild(bEml);

  cont.hidden = false;
}

async function copiar(ta, boton) {
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch (_) {
    // En algunos navegadores de celular el portapapeles falla sin HTTPS. En vez
    // de dejar a la persona sin salida, se le selecciona el texto para que lo
    // copie a mano.
    ta.focus();
    ta.select();
    toast('Selecciónalo y cópialo a mano (Ctrl+C).', true);
    return;
  }
  const antes = boton.textContent;
  boton.textContent = 'Copiada ✓';
  setTimeout(() => { boton.textContent = antes; }, 1800);
}

/** Un .eml se abre con doble clic en Outlook, Thunderbird o Mail y llega con
 *  destinatario, asunto y cuerpo ya puestos. */
function descargarEml(c, cuerpo) {
  const rem = cuerpoPeticion().remitente;
  const cab = [
    rem.correo ? `From: ${rem.correo}` : '',
    c.para ? `To: ${c.para}` : '',
    c.copia ? `Cc: ${c.copia}` : '',
    `Subject: ${c.asunto}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '', '',
  ].filter((l) => l !== null).join('\r\n');
  descargar(cab + cuerpo, `hope_${c.destinatario.id}.eml`, 'message/rfc822');
}

async function descargarZip() {
  const b = $('#btn-zip');
  b.disabled = true;
  b.textContent = 'Preparando…';
  try {
    const r = await fetch(`${S.base}/enlaces/paquete.zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpoPeticion()),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hope_cartas.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Descargado. Arrastra los .eml a tu programa de correo.');
  } catch (e) {
    toast('No se pudo descargar: ' + e.message, true);
  } finally {
    b.disabled = false;
    b.textContent = 'Descargar todas (.eml para el correo)';
  }
}

// ── Persistencia local ──────────────────────────────────────────────────────

function cargarRemitente() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem(CLAVE_REMITENTE) || '{}'); } catch (_) {}
  const f = $('#form-remitente');
  Object.entries(d).forEach(([k, v]) => { if (f[k]) f[k].value = v; });
  avisoFirma();
}

function guardarRemitente() {
  const f = new FormData($('#form-remitente'));
  const d = {};
  f.forEach((v, k) => { d[k] = v; });
  try { localStorage.setItem(CLAVE_REMITENTE, JSON.stringify(d)); } catch (_) {}
  avisoFirma();
}

function avisoFirma() {
  const f = $('#form-remitente');
  const falta = [];
  if (!f.nombre.value.trim()) falta.push('tu nombre');
  if (!f.correo.value.trim()) falta.push('tu correo');
  if (!f.telefono.value.trim()) falta.push('un teléfono');
  $('#aviso-firma').textContent = falta.length
    ? 'Falta ' + falta.join(', ') + '. Las cartas se escriben igual, pero una ' +
      'petición sin forma de responderla casi nunca se contesta.'
    : 'Listo. Cada carta irá firmada con estos datos.';
}

function marcas() {
  try { return JSON.parse(localStorage.getItem(CLAVE_MARCAS) || '{}'); }
  catch (_) { return {}; }
}

function guardarMarcas(m) {
  try { localStorage.setItem(CLAVE_MARCAS, JSON.stringify(m)); } catch (_) {}
}

// ── Utilidades ──────────────────────────────────────────────────────────────

function descargar(texto, nombre, tipo) {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
