/* ===========================================================================
   HOPE — zonas y aportes sobre Supabase, con actualización en tiempo real.

   Dos objetos y una regla:
     · ZONA   — un lugar que NECESITA algo (buscar personas, energía, internet…)
     · APORTE — alguien que OFRECE algo (Starlink, generador, panel solar…)
     · Ningún dato personal viaja por aquí. Los contactos van a `contactos`,
       tabla que el rol anónimo puede escribir pero jamás leer. Ver schema.sql.

   El tiempo real es una suscripción de Postgres: cuando alguien inserta una
   zona en Cali, aparece en la pantalla de todos los demás sin recargar.
   =========================================================================== */

'use strict';

const ZONA_TIPOS = {
  buscar_personas: { etiqueta: 'Buscar personas',        color: '#ff3b30', icono: '🔴' },
  sin_energia:     { etiqueta: 'Sin energía',            color: '#ff9500', icono: '🟠' },
  sin_internet:    { etiqueta: 'Sin internet',           color: '#4da3ff', icono: '🔵' },
  infraestructura: { etiqueta: 'Infraestructura por revisar', color: '#af52de', icono: '🟣' },
  albergue:        { etiqueta: 'Albergue activo',        color: '#34c759', icono: '🟢' },
  salud:           { etiqueta: 'Atención médica',        color: '#ff6b6b', icono: '🔴' },
  agua_alimentos:  { etiqueta: 'Agua y alimentos',       color: '#5ac8fa', icono: '🔵' },
  via_bloqueada:   { etiqueta: 'Vía bloqueada',          color: '#ffd60a', icono: '🟡' },
  punto_donacion:  { etiqueta: 'Punto de donación',      color: '#2dd4bf', icono: '🎁' },
  otro:            { etiqueta: 'Otro',                   color: '#98a2b3', icono: '⚪' },
};

const ZONA_ESTADOS = {
  nuevo:       'Sin confirmar',
  verificado:  'Verificado',
  en_atencion: 'En atención',
  resuelto:    'Resuelto',
  descartado:  'Descartado',
};

const URGENCIAS = {
  1: { etiqueta: 'Crítica', color: '#ff3b30' },
  2: { etiqueta: 'Alta',    color: '#ff9500' },
  3: { etiqueta: 'Media',   color: '#ffd60a' },
  4: { etiqueta: 'Baja',    color: '#34c759' },
};

const APORTE_TIPOS = {
  starlink:         { etiqueta: 'Starlink',            icono: '📡' },
  generador:        { etiqueta: 'Generador eléctrico', icono: '⚡' },
  panel_solar:      { etiqueta: 'Panel solar',         icono: '☀️' },
  bateria:          { etiqueta: 'Batería',             icono: '🔋' },
  internet_movil:   { etiqueta: 'Internet móvil',      icono: '📶' },
  combustible:      { etiqueta: 'Combustible',         icono: '⛽' },
  transporte:       { etiqueta: 'Transporte',          icono: '🚚' },
  personal_tecnico: { etiqueta: 'Personal técnico',    icono: '🔧' },
  otro:             { etiqueta: 'Otro',                icono: '📦' },
};

const APORTE_ESTADOS = {
  ofrecido:  'Ofrecido',
  asignado:  'Asignado',
  en_camino: 'En camino',
  instalado: 'Instalado',
  retirado:  'Retirado',
};

// ── Estado ──────────────────────────────────────────────────────────────────

const Z = {
  sb: null,
  conectado: false,
  motivo: '',
  zonas: [],
  aportes: [],
  marcadores: new Map(),
  canal: null,
  modo: null,        // 'zona' | 'aporte' | null — qué se está ubicando en el mapa
  coords: null,
};

// ── Arranque ────────────────────────────────────────────────────────────────

async function iniciarZonas() {
  try {
    const cfg = await cargarJSON(rutaApi('/config'));
    if (!cfg.configurado) {
      Z.motivo = 'Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY.';
      return estadoDesconectado();
    }
    if (typeof window.supabase?.createClient !== 'function') {
      Z.motivo = 'No cargó la librería de Supabase (¿sin internet?).';
      return estadoDesconectado();
    }

    Z.sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key, {
      realtime: { params: { eventsPerSecond: 5 } },
    });

    await recargarZonas();
    await recargarAportes();
    suscribirTiempoReal();
    Z.conectado = true;
    marcarConexion('en vivo', true);
  } catch (e) {
    Z.motivo = e.message || String(e);
    estadoDesconectado();
  }
}

/** El backend puede estar en el mismo origen (Railway) o en localhost:8000. */
function rutaApi(sufijo) {
  return (Almacen.base || '/api') + sufijo;
}

function estadoDesconectado() {
  marcarConexion('sin conexión', false);
  const cont = document.querySelector('#lista-zonas');
  if (cont) {
    cont.innerHTML = `<li class="vacio">No se pudo conectar a la base compartida.<br>
      <span style="color:var(--texto-2)">${escapar(Z.motivo)}</span></li>`;
  }
}

function marcarConexion(txt, vivo) {
  const b = document.querySelector('#badge-vivo');
  if (!b) return;
  b.textContent = txt;
  b.className = 'badge ' + (vivo ? 'vivo' : 'muerto');
}

// ── Lectura ─────────────────────────────────────────────────────────────────

async function recargarZonas() {
  const { data, error } = await Z.sb
    .from('zonas').select('*')
    .not('estado', 'in', '("descartado")')
    .order('urgencia', { ascending: true })
    .order('creado_en', { ascending: false })
    .limit(2000);
  if (error) throw new Error('zonas: ' + error.message);
  Z.zonas = data || [];
  pintarZonas();
}

async function recargarAportes() {
  const { data, error } = await Z.sb
    .from('aportes').select('*')
    .order('creado_en', { ascending: false })
    .limit(1000);
  if (error) throw new Error('aportes: ' + error.message);
  Z.aportes = data || [];
  pintarAportes();
}

// ── Tiempo real ─────────────────────────────────────────────────────────────

function suscribirTiempoReal() {
  if (Z.canal) Z.sb.removeChannel(Z.canal);

  Z.canal = Z.sb.channel('hope-publico')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'zonas' }, (p) => {
      aplicarCambio(Z.zonas, p);
      pintarZonas();
      if (p.eventType === 'INSERT') {
        const t = ZONA_TIPOS[p.new.tipo] || ZONA_TIPOS.otro;
        toast(`Nueva zona: ${t.etiqueta} — ${p.new.municipio || 'sin municipio'}`);
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'aportes' }, (p) => {
      aplicarCambio(Z.aportes, p);
      pintarAportes();
      if (p.eventType === 'INSERT') {
        const t = APORTE_TIPOS[p.new.tipo] || APORTE_TIPOS.otro;
        toast(`Nuevo aporte: ${t.etiqueta}`);
      }
    })
    .subscribe((st) => {
      marcarConexion(st === 'SUBSCRIBED' ? 'en vivo' : st.toLowerCase(),
                     st === 'SUBSCRIBED');
    });
}

/** Aplica INSERT/UPDATE/DELETE sobre el arreglo local sin volver a consultar. */
function aplicarCambio(lista, p) {
  if (p.eventType === 'INSERT') {
    if (!lista.some((x) => x.id === p.new.id)) lista.unshift(p.new);
  } else if (p.eventType === 'UPDATE') {
    const i = lista.findIndex((x) => x.id === p.new.id);
    if (i >= 0) lista[i] = p.new; else lista.unshift(p.new);
  } else if (p.eventType === 'DELETE') {
    const i = lista.findIndex((x) => x.id === p.old.id);
    if (i >= 0) lista.splice(i, 1);
  }
}

// ── Pintado en el mapa ──────────────────────────────────────────────────────

function pintarZonas() {
  S.capas.zonas.clearLayers();
  Z.marcadores.clear();

  const filtro = document.querySelector('#f-zona-tipo')?.value || '';
  const visibles = Z.zonas.filter((z) => !filtro || z.tipo === filtro);

  visibles.forEach((z) => {
    const t = ZONA_TIPOS[z.tipo] || ZONA_TIPOS.otro;
    const u = URGENCIAS[z.urgencia] || URGENCIAS[2];
    const cerrada = z.estado === 'resuelto';

    // El radio es información que la persona reportó: cuánta área abarca el
    // problema. Se dibuja como círculo real en metros, no como símbolo.
    const area = L.circle([z.lat, z.lon], {
      radius: z.radio_m,
      color: t.color,
      weight: 2,
      opacity: cerrada ? 0.3 : 0.9,
      fillColor: t.color,
      fillOpacity: cerrada ? 0.04 : 0.16,
      dashArray: z.verificado ? null : '6 5',
    }).bindPopup(popupZona(z), { maxWidth: 320 });

    area.on('popupopen', () => {
      const b = document.getElementById('sumar-' + z.id);
      if (b) b.onclick = () => abrirFormAporte(z.id, [z.lat, z.lon]);
    });

    area.addTo(S.capas.zonas);
    Z.marcadores.set(z.id, area);

    // Punto central: sin él, un círculo de 50 m es invisible a zoom de país.
    L.circleMarker([z.lat, z.lon], {
      radius: 6, color: '#fff', weight: 1.5,
      fillColor: u.color, fillOpacity: cerrada ? 0.3 : 1,
    }).addTo(S.capas.zonas);
  });

  actualizarCuenta('zonas', visibles.length);
  pintarListaZonas(visibles);
  pintarResumenPublico();
}

function popupZona(z) {
  const t = ZONA_TIPOS[z.tipo] || ZONA_TIPOS.otro;
  const u = URGENCIAS[z.urgencia] || URGENCIAS[2];
  const apoyos = Z.aportes.filter((a) => a.zona_id === z.id);
  return `
    <h3>${t.icono} ${escapar(t.etiqueta)}</h3>
    <div style="font-weight:600">${escapar(z.titulo)}</div>
    <dl>
      <dt>Urgencia</dt><dd style="color:${u.color}">${u.etiqueta}</dd>
      <dt>Estado</dt><dd>${escapar(ZONA_ESTADOS[z.estado] || z.estado)}</dd>
      ${z.municipio ? `<dt>Municipio</dt><dd>${escapar(z.municipio)}</dd>` : ''}
      ${z.personas_estimadas ? `<dt>Personas</dt><dd>${nf.format(z.personas_estimadas)}</dd>` : ''}
      <dt>Radio</dt><dd>${z.radio_m >= 1000 ? (z.radio_m / 1000) + ' km' : z.radio_m + ' m'}</dd>
      <dt>Reportado</dt><dd>${fechaLocal(z.creado_en)}</dd>
    </dl>
    ${z.descripcion ? `<div style="margin-top:8px">${escapar(z.descripcion)}</div>` : ''}
    ${z.verificado
      ? `<div style="margin-top:6px;color:#34c759">✓ Verificado${
          z.verificado_por ? ' por ' + escapar(z.verificado_por) : ''}</div>`
      : '<span class="no-verificado">⚠ Sin verificar. Reporte ciudadano, no confirmado.</span>'}
    ${apoyos.length
      ? `<div style="margin-top:8px">Aportes asignados: ${apoyos.map((a) =>
          (APORTE_TIPOS[a.tipo] || APORTE_TIPOS.otro).icono).join(' ')}</div>`
      : ''}
    ${enlaceContacto(z.contacto_publico)}
    ${enlaceWaze(z.lat, z.lon)}
    <button class="btn btn-primario" id="sumar-${z.id}">Aportar a esta zona</button>
  `;
}

function pintarAportes() {
  S.capas.aportes.clearLayers();
  let n = 0;
  Z.aportes.forEach((a) => {
    if (a.lat == null || a.lon == null) return;
    const t = APORTE_TIPOS[a.tipo] || APORTE_TIPOS.otro;
    L.marker([a.lat, a.lon], {
      icon: L.divIcon({
        className: 'marca-aporte',
        html: `<div title="${escapar(t.etiqueta)}">${t.icono}</div>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      }),
    }).bindPopup(`
      <h3>${t.icono} ${escapar(t.etiqueta)}</h3>
      <div style="font-weight:600">${escapar(a.titulo)}</div>
      <dl>
        <dt>Estado</dt><dd>${escapar(APORTE_ESTADOS[a.estado] || a.estado)}</dd>
        <dt>Cantidad</dt><dd>${a.cantidad}</dd>
        ${a.organizacion ? `<dt>Quién</dt><dd>${escapar(a.organizacion)}</dd>` : ''}
        ${a.municipio_base ? `<dt>Base</dt><dd>${escapar(a.municipio_base)}</dd>` : ''}
        <dt>Ofrecido</dt><dd>${fechaLocal(a.creado_en)}</dd>
      </dl>
      ${a.descripcion ? `<div style="margin-top:8px">${escapar(a.descripcion)}</div>` : ''}
      ${enlaceContacto(a.contacto_publico)}
      ${enlaceWaze(a.lat, a.lon)}
    `, { maxWidth: 300 }).addTo(S.capas.aportes);
    n++;
  });
  actualizarCuenta('aportes', n);
  pintarListaAportes();
}

// ── Paneles ─────────────────────────────────────────────────────────────────

/** Botón de contacto directo, solo si la persona lo dejó explícitamente
 *  público. Si parece teléfono abre WhatsApp; si parece correo, un mailto;
 *  si no, se muestra como texto (puede ser un usuario de red social). */
function enlaceContacto(valor) {
  const v = (valor || '').trim();
  if (!v) return '';
  const soloDigitos = v.replace(/\D/g, '');
  const pareceTelefono = soloDigitos.length >= 7 && /^[+\d][\d\s()+-]*$/.test(v);
  if (pareceTelefono) {
    return `<a class="btn btn-primario" href="https://wa.me/${soloDigitos}" ` +
           `target="_blank" rel="noopener">📲 Escribir por WhatsApp</a>`;
  }
  if (v.includes('@') && !v.includes(' ')) {
    return `<a class="btn btn-sec" href="mailto:${encodeURIComponent(v)}">✉ ${escapar(v)}</a>`;
  }
  return `<div class="hint">Contacto: <strong>${escapar(v)}</strong></div>`;
}

/** Abre Waze ya centrado y listo para navegar a ese punto. Es el enlace
 *  universal oficial de Waze (waze.com/ul): sin API key, sin app instalada
 *  cae solo a la versión web. Mismo botón para zonas, aportes y apuntes. */
function enlaceWaze(lat, lon) {
  if (lat == null || lon == null) return '';
  return `<a class="btn btn-sec" href="https://waze.com/ul?ll=${lat},${lon}&navigate=yes" ` +
         'target="_blank" rel="noopener">🚗 Ir con Waze</a>';
}

/** Resumen en lenguaje llano: es lo que se ve de un vistazo y lo que sirve
 *  para una captura de pantalla en Instagram. */
function pintarResumenPublico() {
  const cont = document.querySelector('#resumen-publico');
  if (!cont) return;

  const activas = Z.zonas.filter((z) => z.estado !== 'resuelto' && z.estado !== 'descartado');
  const porTipo = {};
  activas.forEach((z) => {
    porTipo[z.tipo] = porTipo[z.tipo] || { n: 0, personas: 0 };
    porTipo[z.tipo].n++;
    porTipo[z.tipo].personas += z.personas_estimadas || 0;
  });

  const orden = ['buscar_personas', 'sin_energia', 'sin_internet', 'infraestructura',
                 'salud', 'agua_alimentos', 'via_bloqueada', 'albergue', 'punto_donacion', 'otro'];
  const filas = orden.filter((k) => porTipo[k]).map((k) => {
    const t = ZONA_TIPOS[k];
    const d = porTipo[k];
    return `<div class="res-fila" data-tipo="${k}">
      <span class="res-ico">${t.icono}</span>
      <span class="res-txt">${escapar(t.etiqueta)}</span>
      <span class="res-num">${d.n}${d.personas ? ` · ${nf.format(d.personas)} pers.` : ''}</span>
    </div>`;
  });

  cont.innerHTML = filas.length
    ? filas.join('')
    : '<p class="hint">Todavía no hay zonas reportadas. Sé el primero: usa «Reportar zona».</p>';

  cont.querySelectorAll('.res-fila').forEach((el) => {
    el.onclick = () => {
      const sel = document.querySelector('#f-zona-tipo');
      sel.value = sel.value === el.dataset.tipo ? '' : el.dataset.tipo;
      pintarZonas();
    };
  });

  const sinVerificar = activas.filter((z) => !z.verificado).length;
  const nota = document.querySelector('#resumen-nota');
  if (nota) {
    nota.textContent = activas.length
      ? `${activas.length} zonas activas · ${sinVerificar} sin verificar todavía.`
      : '';
  }
}

function pintarListaZonas(visibles) {
  const ul = document.querySelector('#lista-zonas');
  if (!ul) return;
  ul.innerHTML = '';
  if (!visibles.length) {
    ul.innerHTML = '<li class="vacio">Sin zonas para ese filtro.</li>';
    return;
  }
  visibles.slice(0, 60).forEach((z) => {
    const t = ZONA_TIPOS[z.tipo] || ZONA_TIPOS.otro;
    const u = URGENCIAS[z.urgencia] || URGENCIAS[2];
    const li = document.createElement('li');
    li.style.borderLeftColor = u.color;
    li.innerHTML = `
      <div class="fila">
        <span class="tit">${t.icono} ${escapar(z.titulo)}</span>
        <span class="met">${escapar(z.municipio || '')}</span>
      </div>
      <div class="fila">
        <span class="met">${escapar(t.etiqueta)} · ${u.etiqueta}${
          z.verificado ? ' · ✓' : ' · sin verificar'}</span>
        <span class="met">${fechaCorta(z.creado_en)}</span>
      </div>`;
    li.onclick = () => {
      S.mapa.setView([z.lat, z.lon], 13);
      Z.marcadores.get(z.id)?.openPopup();
    };
    ul.appendChild(li);
  });
}

function pintarListaAportes() {
  const cont = document.querySelector('#lista-aportes');
  if (!cont) return;
  const porTipo = {};
  Z.aportes.filter((a) => a.estado !== 'retirado')
    .forEach((a) => { porTipo[a.tipo] = (porTipo[a.tipo] || 0) + a.cantidad; });
  const claves = Object.keys(porTipo);
  cont.innerHTML = claves.length
    ? claves.map((k) => {
        const t = APORTE_TIPOS[k] || APORTE_TIPOS.otro;
        return `<span class="chip">${t.icono} ${escapar(t.etiqueta)} <b>${porTipo[k]}</b></span>`;
      }).join('')
    : '<p class="hint">Nadie ha ofrecido recursos todavía.</p>';
}

// ── Escritura ───────────────────────────────────────────────────────────────

function activarUbicar(modo) {
  Z.modo = Z.modo === modo ? null : modo;
  document.body.classList.toggle('modo-agregar', !!Z.modo);
  const hint = document.querySelector('#hint-ubicar');
  if (hint) {
    hint.hidden = !Z.modo;
    hint.textContent = Z.modo === 'zona'
      ? 'Toca en el mapa el lugar de la zona. Esc para cancelar.'
      : 'Toca en el mapa dónde está tu aporte. Esc para cancelar.';
  }
  document.querySelector('#btn-zona')?.classList.toggle('activo', Z.modo === 'zona');
  document.querySelector('#btn-aporte')?.classList.toggle('activo', Z.modo === 'aporte');
}

function clicMapaZonas(e) {
  if (!Z.modo) return false;
  const coords = [e.latlng.lat, e.latlng.lng];
  const modo = Z.modo;
  activarUbicar(null);
  if (modo === 'zona') abrirFormZona(coords);
  else abrirFormAporte(null, coords);
  return true;
}

function abrirFormZona(coords) {
  if (!Z.conectado) { toast('Sin conexión a la base compartida.', true); return; }
  Z.coords = coords;
  const f = document.querySelector('#form-zona');
  f.reset();
  f.radio_m.value = 500;
  f.urgencia.value = 2;
  document.querySelector('#zona-coords').textContent =
    `Ubicación: ${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`;
  document.querySelector('#modal-zona').hidden = false;
  f.titulo.focus();
}

function abrirFormAporte(zonaId, coords) {
  if (!Z.conectado) { toast('Sin conexión a la base compartida.', true); return; }
  S.mapa.closePopup();
  Z.coords = coords;
  const f = document.querySelector('#form-aporte');
  f.reset();
  f.dataset.zonaId = zonaId || '';
  document.querySelector('#aporte-coords').textContent = coords
    ? `Ubicación: ${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`
    : 'Sin ubicación específica';
  document.querySelector('#aporte-destino').textContent = zonaId
    ? 'Aporte dirigido a la zona seleccionada.'
    : 'Aporte general, sin zona asignada.';
  document.querySelector('#modal-aporte').hidden = false;
  f.titulo.focus();
}

async function guardarZona(ev) {
  ev.preventDefault();
  const f = ev.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;

  const fila = {
    tipo: f.tipo.value,
    titulo: f.titulo.value.trim(),
    descripcion: f.descripcion.value.trim(),
    municipio: f.municipio.value.trim(),
    departamento: f.departamento.value.trim(),
    lat: Z.coords[0],
    lon: Z.coords[1],
    radio_m: parseInt(f.radio_m.value, 10) || 500,
    personas_estimadas: parseInt(f.personas.value, 10) || 0,
    urgencia: parseInt(f.urgencia.value, 10) || 2,
    contacto_publico: (f.contacto_publico?.value || '').trim(),
    // verificado y estado los fija la política de RLS; mandarlos explícitos
    // deja claro que no se está intentando colar un registro pre-verificado.
    verificado: false,
    estado: 'nuevo',
  };

  try {
    const data = await insertarConRespaldo('zonas', fila);
    await guardarContacto({ zona_id: data.id }, f);
    document.querySelector('#modal-zona').hidden = true;
    toast('Zona publicada. Ya la ven todos.');
  } catch (e) {
    toast('No se pudo guardar: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function guardarAporte(ev) {
  ev.preventDefault();
  const f = ev.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;

  const fila = {
    tipo: f.tipo.value,
    titulo: f.titulo.value.trim(),
    descripcion: f.descripcion.value.trim(),
    cantidad: parseInt(f.cantidad.value, 10) || 1,
    organizacion: f.organizacion.value.trim(),
    municipio_base: f.municipio_base.value.trim(),
    lat: Z.coords ? Z.coords[0] : null,
    lon: Z.coords ? Z.coords[1] : null,
    zona_id: f.dataset.zonaId || null,
    contacto_publico: (f.contacto_publico?.value || '').trim(),
    estado: 'ofrecido',
  };

  try {
    const data = await insertarConRespaldo('aportes', fila);
    await guardarContacto({ aporte_id: data.id }, f);
    document.querySelector('#modal-aporte').hidden = true;
    toast('Aporte publicado. Gracias.');
  } catch (e) {
    toast('No se pudo guardar: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/** Inserta y, si la base todavía no tiene `contacto_publico` (falta re-correr
 *  supabase/schema.sql), reintenta sin ese campo en vez de perder todo el
 *  registro: el punto en el mapa vale más que el contacto de contacto rápido. */
async function insertarConRespaldo(tabla, fila) {
  let { data, error } = await Z.sb.from(tabla).insert(fila).select().single();
  if (error && 'contacto_publico' in fila && /contacto_publico/i.test(error.message)) {
    const { contacto_publico, ...sinContacto } = fila;
    ({ data, error } = await Z.sb.from(tabla).insert(sinContacto).select().single());
    if (!error) {
      toast('Publicado, pero falta actualizar la base para el contacto público ' +
            '(re-correr supabase/schema.sql).', true);
    }
  }
  if (error) throw new Error(error.message);
  return data;
}

/** El contacto va a su propia tabla, que nadie puede leer con la anon key.
 *  Si esta inserción falla, la zona o el aporte YA quedaron publicados: es la
 *  prioridad correcta — el punto en el mapa vale más que el teléfono. */
async function guardarContacto(ref, f) {
  const nombre = (f.contacto_nombre?.value || '').trim();
  const telefono = (f.contacto_telefono?.value || '').trim();
  if (!nombre && !telefono) return;
  const { error } = await Z.sb.from('contactos').insert({ ...ref, nombre, telefono });
  if (error) console.warn('contacto no guardado:', error.message);
}

// ── Cableado ────────────────────────────────────────────────────────────────

function conectarUIZonas() {
  document.querySelector('#btn-zona').onclick = () => activarUbicar('zona');
  document.querySelector('#btn-aporte').onclick = () => activarUbicar('aporte');
  document.querySelector('#form-zona').onsubmit = guardarZona;
  document.querySelector('#form-aporte').onsubmit = guardarAporte;
  document.querySelector('#f-zona-tipo').onchange = pintarZonas;

  document.querySelectorAll('[data-cerrar]').forEach((b) => {
    b.onclick = () => { document.querySelector(b.dataset.cerrar).hidden = true; };
  });

  // Poblar selectores
  const llenar = (sel, cat, etiquetar) => {
    const el = document.querySelector(sel);
    if (!el) return;
    Object.entries(cat).forEach(([k, v]) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = etiquetar(v);
      el.appendChild(o);
    });
  };
  llenar('#zona-tipo', ZONA_TIPOS, (v) => `${v.icono} ${v.etiqueta}`);
  llenar('#f-zona-tipo', ZONA_TIPOS, (v) => v.etiqueta);
  llenar('#aporte-tipo', APORTE_TIPOS, (v) => `${v.icono} ${v.etiqueta}`);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (Z.modo) activarUbicar(null);
    ['#modal-zona', '#modal-aporte'].forEach((s) => {
      const m = document.querySelector(s);
      if (m && !m.hidden) m.hidden = true;
    });
  });
}
