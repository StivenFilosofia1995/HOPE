/* ===========================================================================
   HOPE — Mapa base del sismo M7.4 Chocó (10 ago 2026)
   ---------------------------------------------------------------------------
   Dos cosas en un solo archivo estático:
     1. Visualización del sismo (epicentro, réplicas en vivo, intensidad, ciudades).
     2. Capa editable de reportes: capturar, filtrar, exportar, importar.

   La capa de reportes habla con un backend FastAPI si lo encuentra; si no,
   guarda en localStorage. Así el mapa sirve solo, sin servidor, y el día que
   se levante el backend no hay que tocar el frontend.
   =========================================================================== */

'use strict';

// ── Configuración ───────────────────────────────────────────────────────────

const CFG = {
  // Se prueban en orden. El primero que responda /salud gana.
  basesApi: ['/api', 'http://127.0.0.1:8000/api'],
  claveLocal: 'hope.reportes.v1',
  // Ventana de consulta de réplicas al catálogo del USGS.
  replicas: {
    url: 'https://earthquake.usgs.gov/fdsnws/event/1/query',
    bbox: { minlat: 3.2, maxlat: 6.5, minlon: -77.8, maxlon: -74.6 },
    magMin: 2.5,
    desde: '2026-08-10',
  },
  detalleEvento: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=',
};

const TIPOS = {
  rescate:        { etiqueta: 'Personas atrapadas / rescate', color: '#ff3b30' },
  salud:          { etiqueta: 'Heridos / atención médica',    color: '#ff6b6b' },
  estructural:    { etiqueta: 'Daño estructural',             color: '#ff9500' },
  refugio:        { etiqueta: 'Albergue / refugio',           color: '#ffd60a' },
  agua:           { etiqueta: 'Agua potable',                 color: '#4da3ff' },
  alimentos:      { etiqueta: 'Alimentos',                    color: '#34c759' },
  vias:           { etiqueta: 'Vía bloqueada / acceso',       color: '#af52de' },
  servicios:      { etiqueta: 'Energía / comunicaciones',     color: '#5ac8fa' },
  enlace:         { etiqueta: 'Enlace satelital (Starlink)',  color: '#00d4ff' },
  recurso:        { etiqueta: 'Recurso disponible (ayuda)',   color: '#30d158' },
  otro:           { etiqueta: 'Otro',                         color: '#98a2b3' },
};

const PRIORIDADES = {
  critica: { etiqueta: 'Crítica — vidas en riesgo ahora', color: '#ff3b30', radio: 11 },
  alta:    { etiqueta: 'Alta',                            color: '#ff9500', radio: 9  },
  media:   { etiqueta: 'Media',                           color: '#ffd60a', radio: 7  },
  baja:    { etiqueta: 'Baja / informativo',              color: '#34c759', radio: 6  },
};

const ESTADOS = {
  nuevo:       { etiqueta: 'Nuevo (sin verificar)' },
  verificado:  { etiqueta: 'Verificado' },
  en_atencion: { etiqueta: 'En atención' },
  atendido:    { etiqueta: 'Atendido' },
  descartado:  { etiqueta: 'Descartado / duplicado' },
};

const FUENTES = {
  llamada:  { etiqueta: 'Llamada telefónica' },
  whatsapp: { etiqueta: 'WhatsApp / mensaje' },
  terreno:  { etiqueta: 'Observación en terreno' },
  radio:    { etiqueta: 'Radio / red de socorro' },
  redes:    { etiqueta: 'Redes sociales (baja confianza)' },
  oficial:  { etiqueta: 'Fuente oficial (UNGRD, CMGRD, Cruz Roja)' },
  otro:     { etiqueta: 'Otra' },
};

// Clases de corte de internet. `punto_ciego` tiene color propio y llamativo a
// propósito: es el caso peligroso — daño confirmado por el sismo pero sin señal
// medible, casi siempre porque no hay infraestructura que medir. Si se pintara
// igual que "sin señal" desaparecería justo la zona que más necesita un enlace.
const CLASES_CORTE = {
  colapso_medido:      { etiqueta: 'Colapso medido',        color: '#ff3b30' },
  degradacion_fuerte:  { etiqueta: 'Degradación fuerte',    color: '#ff9500' },
  punto_ciego:         { etiqueta: 'Punto ciego (sin red que medir)', color: '#c77dff' },
  degradacion_leve:    { etiqueta: 'Degradación leve',      color: '#ffd60a' },
  sin_senal:           { etiqueta: 'Sin señal de corte',    color: '#34c759' },
};

// Escala de intensidad instrumental del USGS.
const COLORES_MMI = {
  1: '#ffffff', 2: '#bfccff', 3: '#a0e6ff', 4: '#80ffff', 5: '#7aff93',
  6: '#ffff00', 7: '#ffc800', 8: '#ff9100', 9: '#ff0000', 10: '#c80000',
};

// ── Estado global ───────────────────────────────────────────────────────────

const S = {
  mapa: null,
  evento: null,
  ciudades: null,
  reportes: [],
  capas: {},
  marcadores: new Map(),   // id de reporte -> marcador
  modoAgregar: false,
  editando: null,          // id del reporte en edición, o null si es nuevo
  coordsPendientes: null,
};

const nf = new Intl.NumberFormat('es-CO');
const $ = (sel) => document.querySelector(sel);

// ── Arranque ────────────────────────────────────────────────────────────────

iniciar().catch((e) => {
  console.error(e);
  toast('No se pudo iniciar el mapa: ' + e.message, true);
});

async function iniciar() {
  crearMapa();
  poblarSelects();
  conectarUI();

  const [evento, ciudades] = await Promise.all([
    cargarJSON('data/evento.json'),
    cargarJSON('data/ciudades.json'),
  ]);
  S.evento = evento;
  S.ciudades = ciudades;

  pintarFichaEvento();
  // El control de capas primero: crea los contadores que las capas van llenando.
  construirControlCapas();
  construirLeyenda();
  capaEpicentro();
  capaCiudades();

  // Estas tres son de red y pueden fallar sin tumbar el mapa.
  cargarReplicas();
  cargarIntensidad();

  await Almacen.iniciar();
  await recargarReportes();
  cargarCortes();          // depende de Almacen: sabe si hay backend o no
  cargarSismosRecientes(); // idem
  cargarClima();           // idem
  cargarSondasRipe();      // idem

  conectarUIZonas();
  iniciarZonas();          // Supabase: zonas y aportes en tiempo real

  iniciarAutoRefresco();
}

// ── Auto-refresco: mantiene alimentadas las capas que no son push (Supabase
// ya empuja zonas/aportes solo). Cada RITMO_MS se vuelve a pedir a las fuentes
// en vivo; nada se inventa entre medias.

const RITMO_MS = 5 * 60 * 1000;

function iniciarAutoRefresco() {
  marcarActualizado();
  setInterval(async () => {
    await Promise.allSettled([
      cargarReplicas(),
      cargarCortes(),
      cargarSismosRecientes(),
      cargarClima(),
      cargarSondasRipe(),
    ]);
    marcarActualizado();
  }, RITMO_MS);
}

function marcarActualizado() {
  const el = $('#ultima-actualizacion');
  if (el) el.textContent = 'actualizado ' + new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

// ── Mapa y capas base ───────────────────────────────────────────────────────

function crearMapa() {
  S.mapa = L.map('mapa', { zoomControl: true, minZoom: 4, maxZoom: 18 });

  // Encuadre inicial: que se vean juntos el epicentro y las cuatro ciudades
  // con daño reportado. Un mapa que abre centrado en el epicentro deja Cali
  // fuera de pantalla, y Cali es donde está la mayor parte de la gente.
  S.mapa.fitBounds(L.latLngBounds([
    [5.85, -77.10],   // arriba-izquierda: pasa Quibdó
    [3.20, -75.30],   // abajo-derecha: pasa Cali y Manizales
  ]), { padding: [20, 20] });

  const atribOSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const bases = {
    'Oscuro (CARTO)': L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { attribution: atribOSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 20 }),
    'Claro (CARTO)': L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      { attribution: atribOSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 20 }),
    'OpenStreetMap': L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: atribOSM, maxZoom: 19 }),
    'Relieve (OpenTopoMap)': L.tileLayer(
      'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      { attribution: atribOSM + ', <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17 }),
  };
  // OpenStreetMap por defecto: es el que más gente reconoce. Las otras tres
  // quedan disponibles en el selector de capas, arriba a la derecha.
  bases['OpenStreetMap'].addTo(S.mapa);
  L.control.layers(bases, null, { position: 'topright' }).addTo(S.mapa);

  S.capas = {
    intensidad: L.layerGroup(),
    anillos:    L.layerGroup(),
    cortes:     L.layerGroup(),
    energia:    L.layerGroup(),
    replicas:   L.layerGroup(),
    ciudades:   L.layerGroup(),
    epicentro:  L.layerGroup(),
    zonas:      L.layerGroup(),
    aportes:    L.layerGroup(),
    reportes:   L.layerGroup(),
    sismos:     L.layerGroup(),
    sondas:     L.layerGroup(),
  };
  // El orden de adición define el apilamiento: lo que la gente reporta va
  // arriba de todo, porque es lo que se viene a mirar.
  Object.values(S.capas).forEach((c) => c.addTo(S.mapa));

  S.mapa.on('click', (e) => {
    if (clicMapaZonas(e)) return;      // zonas y aportes tienen prioridad
    if (!S.modoAgregar) return;
    abrirFormulario(null, [e.latlng.lat, e.latlng.lng]);
    activarModoAgregar(false);
  });
}

// ── Capa: epicentro y anillos de distancia ──────────────────────────────────

function capaEpicentro() {
  const ev = S.evento.evento;
  const pos = [ev.lat, ev.lon];

  const icono = L.divIcon({
    className: 'epicentro-icono',
    html: '<div class="pulso"></div><div class="nucleo"></div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });

  L.marker(pos, { icon: icono, zIndexOffset: 500 })
    .bindPopup(`
      <h3>Epicentro · M${ev.magnitud}</h3>
      <div>${escapar(ev.lugar_es)}</div>
      <dl>
        <dt>Profundidad</dt><dd>${ev.profundidad_km} km</dd>
        <dt>Hora local</dt><dd>${escapar(ev.tiempo_local)}</dd>
        <dt>Alerta PAGER</dt><dd>${ev.alerta_pager.toUpperCase()}</dd>
        <dt>Intensidad máx.</dt><dd>MMI ${ev.mmi_max}</dd>
        <dt>Coordenadas</dt><dd>${ev.lat}, ${ev.lon}</dd>
      </dl>
      <a class="btn btn-sec" href="${ev.url_usgs}" target="_blank" rel="noopener">Ficha USGS</a>
    `, { maxWidth: 320 })
    .addTo(S.capas.epicentro);

  // Anillos de referencia: dan escala de distancia sin necesidad de medir.
  [50, 100, 200, 300].forEach((km) => {
    L.circle(pos, {
      radius: km * 1000,
      color: '#ff3b30', weight: 1, opacity: 0.35,
      fillOpacity: 0.02, dashArray: '4 6', interactive: false,
    }).addTo(S.capas.anillos);

    L.marker(destino(pos, km, 0), {
      interactive: false,
      icon: L.divIcon({ className: 'etiqueta-ciudad', html: `${km} km`, iconSize: [46, 14] }),
    }).addTo(S.capas.anillos);
  });
}

/** Punto a `km` de distancia y `rumbo` grados desde un origen [lat, lon]. */
function destino([lat, lon], km, rumbo) {
  const R = 6371, d = km / R;
  const b = rumbo * Math.PI / 180, la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la),
                              Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
}

/** Distancia en km entre dos puntos [lat, lon] (haversine). */
function distanciaKm([la1, lo1], [la2, lo2]) {
  const R = 6371, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 +
            Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Capa: ciudades de referencia ────────────────────────────────────────────

function capaCiudades() {
  const ev = S.evento.evento;
  const relev = { epicentro: '#ff3b30', alta: '#ff9500', media: '#ffd60a', baja: '#5ac8fa' };

  S.ciudades.ciudades.forEach((c) => {
    const d = distanciaKm([ev.lat, ev.lon], [c.lat, c.lon]);
    const color = relev[c.relevancia] || '#98a2b3';
    const r = c.poblacion_aprox > 1e6 ? 9 : c.poblacion_aprox > 2e5 ? 7 : 5;

    L.circleMarker([c.lat, c.lon], {
      radius: r, color, weight: 2, fillColor: color, fillOpacity: 0.25,
    }).bindPopup(`
      <h3>${escapar(c.nombre)}</h3>
      <div>${escapar(c.departamento)}</div>
      <dl>
        <dt>Distancia al epicentro</dt><dd>${Math.round(d)} km</dd>
        <dt>Población aprox.</dt><dd>${nf.format(c.poblacion_aprox)}</dd>
      </dl>
      <div style="margin-top:8px">${escapar(c.danos_prensa)}</div>
      ${c.verificado ? '' : '<span class="no-verificado">⚠ Sin verificar — fuente: prensa de las primeras horas.</span>'}
    `, { maxWidth: 300 }).addTo(S.capas.ciudades);

    if (c.relevancia === 'alta' || c.relevancia === 'epicentro') {
      L.marker([c.lat, c.lon], {
        interactive: false,
        icon: L.divIcon({
          className: 'etiqueta-ciudad',
          html: escapar(c.nombre),
          iconSize: [120, 14],
          iconAnchor: [-8, 7],
        }),
      }).addTo(S.capas.ciudades);
    }
  });
  actualizarCuenta('ciudades', S.ciudades.ciudades.length);
}

// ── Capa: réplicas en vivo desde el catálogo del USGS ───────────────────────

async function cargarReplicas() {
  const b = CFG.replicas.bbox;
  const url = `${CFG.replicas.url}?format=geojson&starttime=${CFG.replicas.desde}` +
              `&minlatitude=${b.minlat}&maxlatitude=${b.maxlat}` +
              `&minlongitude=${b.minlon}&maxlongitude=${b.maxlon}` +
              `&minmagnitude=${CFG.replicas.magMin}&orderby=time`;
  try {
    const gj = await cargarJSON(url);
    const ahora = Date.now();
    let n = 0;

    gj.features.forEach((f) => {
      if (f.id === S.evento.evento.id_usgs) return;   // el principal ya está pintado
      const [lon, lat, prof] = f.geometry.coordinates;
      const m = f.properties.mag ?? 0;
      const horas = (ahora - f.properties.time) / 36e5;
      const opac = horas < 24 ? 0.85 : horas < 72 ? 0.55 : 0.3;

      L.circleMarker([lat, lon], {
        radius: Math.max(3, m * 2.2),
        color: '#ffd60a', weight: 1.2, opacity: opac,
        fillColor: '#ffd60a', fillOpacity: opac * 0.35,
      }).bindPopup(`
        <h3>Réplica M${m.toFixed(1)}</h3>
        <div>${escapar(f.properties.place || '')}</div>
        <dl>
          <dt>Hora local</dt><dd>${fechaLocal(f.properties.time)}</dd>
          <dt>Profundidad</dt><dd>${prof != null ? prof.toFixed(1) + ' km' : 's/d'}</dd>
        </dl>
      `).addTo(S.capas.replicas);
      n++;
    });

    actualizarCuenta('replicas', n);
    nota(`Réplicas: ${n} eventos M≥${CFG.replicas.magMin} en el catálogo USGS. ` +
         `El SGC cataloga muchas más (su red local detecta magnitudes menores).`);
  } catch (e) {
    actualizarCuenta('replicas', '—');
    nota('No se pudieron cargar las réplicas del USGS (¿sin conexión?).', true);
  }
}

// ── Capa: contornos de intensidad (ShakeMap) ────────────────────────────────

async function cargarIntensidad() {
  let url = S.evento.shakemap.contornos_mmi;

  // La URL del producto lleva versión con timestamp: si el USGS publica una
  // revisión del ShakeMap, la fija queda obsoleta. Se resuelve la vigente.
  try {
    const det = await cargarJSON(CFG.detalleEvento + S.evento.evento.id_usgs);
    const sm = det.properties?.products?.shakemap?.[0];
    const vigente = sm?.contents?.['download/cont_mi.json']?.url;
    if (vigente) url = vigente;
  } catch (_) { /* se usa la de respaldo */ }

  try {
    const gj = await cargarJSON(url);
    L.geoJSON(gj, {
      style: (f) => ({
        color: f.properties.color || COLORES_MMI[Math.round(f.properties.value)] || '#888',
        weight: f.properties.weight || 2,
        opacity: 0.9,
        fill: false,
      }),
      onEachFeature: (f, capa) => {
        const v = f.properties.value;
        capa.bindTooltip(`MMI ${v} — ${descripcionMMI(v)}`, { sticky: true });
      },
    }).addTo(S.capas.intensidad);
    actualizarCuenta('intensidad', gj.features.length);
  } catch (e) {
    actualizarCuenta('intensidad', '—');
    nota('No se cargaron los contornos de intensidad del ShakeMap.', true);
  }
}

function descripcionMMI(v) {
  const n = Math.round(v);
  return ({
    1: 'no sentido', 2: 'muy débil', 3: 'débil', 4: 'ligero', 5: 'moderado',
    6: 'fuerte', 7: 'muy fuerte', 8: 'severo', 9: 'violento', 10: 'extremo',
  })[n] || 's/d';
}

// ── Capa: sismicidad reciente en Colombia (USGS, ventana rodante) ───────────
//
// Distinta de "réplicas": esa mira fijo alrededor del epicentro desde el 10 de
// agosto. Esta ventana se mueve con el reloj y cubre todo el país, así que
// puede avisar de un sismo nuevo sin relación con el del Chocó. Pasa por el
// backend para compartir caché entre pestañas, igual que cortes/energía.

async function cargarSismosRecientes() {
  S.capas.sismos.clearLayers();
  if (Almacen.modo !== 'api') {
    $('#sismos-recientes').innerHTML =
      '<p class="hint">Necesita el backend para consultar el catálogo USGS con caché compartida.</p>';
    actualizarCuenta('sismos', '—');
    return;
  }
  try {
    const d = await cargarJSON(`${Almacen.base}/sismos/recientes?dias=7&mag_min=3`);
    d.sismos.forEach((s) => {
      if (s.lat == null || s.lon == null) return;
      L.circleMarker([s.lat, s.lon], {
        radius: Math.max(4, (s.magnitud || 3) * 2),
        color: '#ff6b6b', weight: 1.5, opacity: 0.85,
        fillColor: '#ff6b6b', fillOpacity: 0.3,
      }).bindPopup(`
        <h3>M${(s.magnitud ?? 0).toFixed(1)}</h3>
        <div>${escapar(s.lugar || '')}</div>
        <dl>
          <dt>Hora local</dt><dd>${fechaLocal(s.hora_iso)}</dd>
          <dt>Profundidad</dt><dd>${s.profundidad_km != null ? s.profundidad_km.toFixed(1) + ' km' : 's/d'}</dd>
        </dl>
        ${s.url ? `<a class="btn btn-sec" href="${s.url}" target="_blank" rel="noopener">Ficha USGS</a>` : ''}
      `).addTo(S.capas.sismos);
    });
    actualizarCuenta('sismos', d.total);
    pintarPanelSismos(d);
  } catch (e) {
    actualizarCuenta('sismos', '—');
    $('#sismos-nota').textContent = 'No se pudo consultar USGS: ' + e.message;
  }
}

function pintarPanelSismos(d) {
  const cont = $('#sismos-recientes');
  cont.innerHTML = '';
  if (!d.sismos.length) {
    cont.innerHTML = '<p class="hint">Sin sismos M≥' + d.mag_min + ' en los últimos ' + d.dias + ' días.</p>';
  }
  d.sismos.slice(0, 6).forEach((s) => {
    const fila = document.createElement('div');
    fila.className = 'zona';
    fila.innerHTML = `
      <div class="fila">
        <span class="tit">M${(s.magnitud ?? 0).toFixed(1)} — ${escapar(s.lugar || 's/d')}</span>
      </div>
      <div class="fila"><span class="met">${fechaLocal(s.hora_iso)}</span></div>`;
    fila.onclick = () => { if (s.lat != null) S.mapa.setView([s.lat, s.lon], 8); };
    cont.appendChild(fila);
  });
  $('#sismos-nota').textContent =
    `${d.fuente} · consultado ${fechaCorta(d.consultado)}.`;
}

// ── Capa: sondas RIPE Atlas — puntos individuales, no promedios ────────────────
//
// Cada sonda es un dispositivo real en una casa u oficina. Verde = conectada
// ahora mismo (prueba de que ahí SÍ hay internet). Roja = se desconectó
// DESPUÉS del sismo (posible corte real, no ruido viejo). Son decenas de
// puntos, no un censo: que falte una sonda no significa que no haya problema.

async function cargarSondasRipe() {
  S.capas.sondas.clearLayers();
  if (Almacen.modo !== 'api') {
    actualizarCuenta('sondas', '—');
    return;
  }
  try {
    const d = await cargarJSON(`${Almacen.base}/cortes/sondas`);
    d.sondas.forEach((s) => {
      const activa = s.clase === 'activa';
      const color = activa ? '#30d158' : '#ff3b30';
      L.circleMarker([s.lat, s.lon], {
        radius: s.es_ancla ? 7 : 5,
        color, weight: 1.5,
        fillColor: color, fillOpacity: 0.75,
      }).bindPopup(`
        <h3>${activa ? '🟢 Sonda conectada' : '🔴 Sonda desconectada'}</h3>
        <div>${escapar(s.descripcion || 'Sin descripción')}</div>
        <dl>
          <dt>Estado</dt><dd>${escapar(s.estado)}</dd>
          <dt>Desde</dt><dd>${fechaLocal(s.desde_iso)}</dd>
          ${s.asn ? `<dt>ASN</dt><dd>AS${s.asn}</dd>` : ''}
        </dl>
        <div class="hint">Punto real (sonda RIPE Atlas), no un promedio de zona.</div>
      `).addTo(S.capas.sondas);
    });
    actualizarCuenta('sondas', d.total);
  } catch (e) {
    actualizarCuenta('sondas', '—');
  }
}

// ── Panel: clima en zonas afectadas (Open-Meteo) ────────────────────────────
//
// No es una capa geoespacial nueva en el mapa: es contexto operativo (lluvia
// dificulta el acceso vial). Se muestra como panel, igual que energía.

async function cargarClima() {
  if (Almacen.modo !== 'api') {
    $('#clima-zonas').innerHTML =
      '<p class="hint">Necesita el backend para consultar Open-Meteo con caché compartida.</p>';
    return;
  }
  try {
    const d = await cargarJSON(`${Almacen.base}/clima`);
    pintarPanelClima(d);
  } catch (e) {
    $('#clima-nota').textContent = 'No se pudo consultar Open-Meteo: ' + e.message;
  }
}

function pintarPanelClima(d) {
  const cont = $('#clima-zonas');
  cont.innerHTML = d.zonas.map((z) => {
    if (z.error) {
      return `<div class="leyenda-fila"><span>${escapar(z.nombre)}</span>
              <span style="margin-left:auto;color:var(--texto-2)">s/d</span></div>`;
    }
    const prob = z.prob_lluvia_24h_max ?? 0;
    const color = prob >= 70 ? 'var(--critica)' : prob >= 40 ? 'var(--alta)' : 'var(--texto-2)';
    return `<div class="leyenda-fila">
      <span>${escapar(z.nombre)}</span>
      <span style="margin-left:auto;font-variant-numeric:tabular-nums">
        ${z.precipitacion_actual_mm ?? 0} mm ahora
        <b style="color:${color}">· ${prob}% prob. 24h</b>
      </span>
    </div>`;
  }).join('');
  $('#clima-nota').textContent = `${d.fuente} · consultado ${fechaCorta(d.consultado)}. ${d.nota}`;
}

// ── Capas: cortes de internet (IODA) y de energía (XM) ──────────────────────
//
// Ambas pasan por el backend: XM solo acepta POST y no manda CORS, y así queda
// una caché compartida en vez de una por pestaña. Sin backend, estas capas
// simplemente no se dibujan y se dice por qué.

async function cargarCortes() {
  S.capas.cortes.clearLayers();
  S.capas.energia.clearLayers();
  $('#prioridad').innerHTML = '<p class="hint">Consultando IODA y XM…</p>';
  $('#energia-resumen').innerHTML = '';
  $('#cortes-nota').textContent = '';

  if (Almacen.modo !== 'api') {
    $('#prioridad').innerHTML =
      '<p class="hint">Estas capas necesitan el backend. Levanta ' +
      '<code>uvicorn backend.main:app --port 8000</code> y recarga.</p>';
    actualizarCuenta('cortes', '—');
    actualizarCuenta('energia', '—');
    return;
  }

  const horas = $('#f-ventana').value;
  try {
    const [prio, energia] = await Promise.all([
      cargarJSON(`${Almacen.base}/cortes/prioridad?horas=${horas}`),
      cargarJSON(`${Almacen.base}/cortes/energia?dias=20`).catch(() => null),
    ]);
    S.prioridad = prio;
    pintarCapaCortes(prio);
    pintarPanelPrioridad(prio);
    if (energia) { pintarCapaEnergia(energia); pintarPanelEnergia(energia); }
    else { actualizarCuenta('energia', '—'); }
  } catch (e) {
    $('#prioridad').innerHTML =
      `<p class="hint err">No se pudieron leer las fuentes: ${escapar(e.message)}</p>`;
    actualizarCuenta('cortes', '—');
  }
}

/** Radio proporcional al score. El score de IODA abarca 9 órdenes de magnitud
 *  (de 55 a 11.900 millones), así que se usa escala logarítmica: lineal haría
 *  que todo menos Valle del Cauca fuera un punto invisible. */
function radioCorte(score) {
  if (!score || score <= 0) return 9;
  return Math.max(9, Math.min(46, 7 + Math.log10(score) * 4.2));
}

// ── Iconos pedagógicos (SVG en línea, sin depender de fuentes externas) ────
// Mismo símbolo en el mapa y en la leyenda: arcos de wifi (tachados si hay
// corte, con "?" si es punto ciego) y rayo tachado para energía no entregada.
// Así se entiende de un vistazo sin tener que leer el popup.

function svgWifi(color, estado) {
  const debil = estado === 'corte' ? .5 : 1;
  const tachado = estado === 'corte'
    ? `<line x1="3" y1="21" x2="21" y2="3" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>`
    : '';
  const duda = estado === 'duda'
    ? `<text x="12" y="12.8" text-anchor="middle" font-size="9" font-weight="700" fill="${color}">?</text>`
    : '';
  return `<svg viewBox="0 0 24 24" width="100%" height="100%">
    <circle cx="12" cy="19" r="1.7" fill="${color}"/>
    <path d="M7 15.2a7.3 7.3 0 0 1 10 0" fill="none" stroke="${color}" stroke-width="2.1" stroke-linecap="round"/>
    <path d="M3.3 11a12.4 12.4 0 0 1 17.4 0" fill="none" stroke="${color}" stroke-width="2.1"
          stroke-linecap="round" opacity="${debil}"/>
    ${tachado}${duda}
  </svg>`;
}

function svgRayoCorte(color) {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%">
    <path d="M13 2 5 14h5.5l-1 8L19 10h-5.5l-.5-8Z" fill="${color}"/>
    <line x1="3" y1="21" x2="21" y2="3" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
  </svg>`;
}

function iconoGlifo(svgHtml, px) {
  return L.divIcon({
    className: 'icono-glifo',
    html: `<div class="glifo-fondo">${svgHtml}</div>`,
    iconSize: [px, px],
    iconAnchor: [px / 2, px / 2],
  });
}

function pintarCapaCortes(prio) {
  prio.zonas.forEach((z) => {
    const c = CLASES_CORTE[z.clase] || CLASES_CORTE.sin_senal;
    const ciego = z.clase === 'punto_ciego';
    const cortado = z.clase === 'colapso_medido' || z.clase === 'degradacion_fuerte' ||
                    z.clase === 'degradacion_leve';

    L.circleMarker([z.lat, z.lon], {
      radius: radioCorte(z.score),
      color: c.color,
      weight: ciego ? 3 : 2,
      // El punto ciego va con borde punteado y relleno casi nulo: la forma
      // dice "aquí no estamos midiendo", no "aquí no pasa nada".
      dashArray: ciego ? '5 4' : null,
      fillColor: c.color,
      fillOpacity: ciego ? 0.06 : 0.28,
    }).bindPopup(popupCorte(z), { maxWidth: 330 })
      .on('popupopen', () => {
        const b = document.getElementById('ev-' + z.codigo);
        if (b) b.onclick = () => verEventosCorte(z.codigo);
      })
      .addTo(S.capas.cortes);

    // Icono encima del círculo: wifi normal, tachado o con "?". No es
    // interactivo — el clic y el popup siguen siendo del círculo de abajo.
    L.marker([z.lat, z.lon], {
      icon: iconoGlifo(svgWifi(c.color, ciego ? 'duda' : cortado ? 'corte' : 'ok'), 20),
      interactive: false,
      keyboard: false,
    }).addTo(S.capas.cortes);
  });
  actualizarCuenta('cortes', prio.zonas.length);
}

function popupCorte(z) {
  const c = CLASES_CORTE[z.clase] || CLASES_CORTE.sin_senal;
  const en = z.energia;
  return `
    <h3>${escapar(z.nombre)}</h3>
    <div style="color:${c.color};font-weight:600">${escapar(c.etiqueta)}</div>
    <div class="hint">Promedio de TODO el departamento — no indica el
      municipio o barrio exacto. Para puntos concretos, ver capa «Sondas de
      red (RIPE Atlas)».</div>
    <dl>
      <dt>Score IODA</dt><dd>${z.score ? nf.format(Math.round(z.score)) : '0'}</dd>
      <dt>Eventos de corte</dt><dd>${z.eventos}</dd>
      ${z.afectado_sismo ? '<dt>Sismo</dt><dd>daño reportado</dd>' : ''}
      ${en ? `<dt>Energía no entregada</dt><dd>${nf.format(Math.round(en.pico_kwh))} kWh</dd>
              <dt>Sobre su línea base</dt><dd>${en.veces_sobre_base ? '×' + en.veces_sobre_base : 's/d'}</dd>` : ''}
    </dl>
    <div style="margin-top:8px">${escapar(z.lectura)}</div>
    <button class="btn btn-sec" id="ev-${z.codigo}">Ver eventos con hora</button>
  `;
}

function pintarCapaEnergia(energia) {
  let n = 0;
  energia.areas.forEach((a) => {
    if (!a.lat || !a.pico_kwh) return;
    // Rayo tachado: mismo lenguaje visual que "sin internet", para energía.
    const lado = Math.max(18, Math.min(40, Math.log10(a.pico_kwh) * 5 + 6));
    L.marker([a.lat, a.lon], {
      icon: L.divIcon({
        className: 'marca-energia',
        html: `<div class="glifo-fondo">${svgRayoCorte('#00d4ff')}</div>`,
        iconSize: [lado, lado],
        iconAnchor: [lado / 2, lado / 2],
      }),
    }).bindPopup(`
      <h3>${escapar(a.area)}</h3>
      <dl>
        <dt>Pico sin entregar</dt><dd>${nf.format(Math.round(a.pico_kwh))} kWh</dd>
        <dt>Fecha del pico</dt><dd>${escapar(a.pico_fecha || 's/d')}</dd>
        <dt>Línea base diaria</dt><dd>${nf.format(Math.round(a.linea_base_kwh))} kWh</dd>
        <dt>Veces sobre la base</dt><dd>${a.veces_sobre_base ? '×' + a.veces_sobre_base : 's/d'}</dd>
      </dl>
      <div style="margin-top:8px">Cubre: ${escapar(a.departamentos.join(', ') || 's/d')}</div>
      <span class="no-verificado">Área operativa de XM, no división política.
        No atribuir el corte a un municipio concreto.</span>
    `, { maxWidth: 320 }).addTo(S.capas.energia);
    n++;
  });
  actualizarCuenta('energia', n);
}

function pintarPanelPrioridad(prio) {
  const cont = $('#prioridad');
  cont.innerHTML = '';

  prio.zonas.slice(0, 8).forEach((z) => {
    const c = CLASES_CORTE[z.clase] || CLASES_CORTE.sin_senal;
    const fila = document.createElement('div');
    fila.className = 'zona';
    fila.style.borderLeftColor = c.color;
    fila.innerHTML = `
      <div class="fila">
        <span class="tit">${escapar(z.nombre)}</span>
        <span class="met" style="color:${c.color}">${escapar(c.etiqueta)}</span>
      </div>
      <div class="fila">
        <span class="met">score ${z.score ? nf.format(Math.round(z.score)) : '0'}
          · ${z.eventos} evento${z.eventos === 1 ? '' : 's'}</span>
        ${z.energia && z.energia.veces_sobre_base
          ? `<span class="met">luz ×${z.energia.veces_sobre_base}</span>` : ''}
      </div>`;
    fila.onclick = () => {
      S.mapa.setView([z.lat, z.lon], 8);
      S.capas.cortes.eachLayer((l) => {
        if (l.getLatLng && Math.abs(l.getLatLng().lat - z.lat) < 1e-9) l.openPopup();
      });
    };
    cont.appendChild(fila);
  });

  const av = document.createElement('p');
  av.className = 'hint';
  av.textContent = prio.advertencia;
  cont.appendChild(av);

  if (prio.error_energia) {
    const e = document.createElement('p');
    e.className = 'hint err';
    e.textContent = 'XM no respondió: ' + prio.error_energia;
    cont.appendChild(e);
  }
}

function pintarPanelEnergia(energia) {
  const top = energia.areas.filter((a) => a.pico_kwh > 0).slice(0, 3);
  if (!top.length) { $('#energia-resumen').innerHTML = ''; return; }
  $('#energia-resumen').innerHTML =
    '<div class="leyenda-titulo">Energía no entregada — pico</div>' +
    top.map((a) => `
      <div class="leyenda-fila">
        <span>${escapar(a.area.replace('AREA ', ''))}</span>
        <span style="margin-left:auto;font-variant-numeric:tabular-nums">
          ${nf.format(Math.round(a.pico_kwh))} kWh
          ${a.veces_sobre_base ? `<b style="color:var(--critica)">×${a.veces_sobre_base}</b>` : ''}
        </span>
      </div>`).join('');
  $('#cortes-nota').textContent =
    `${energia.fuente} · ${energia.metrica} · consultado ${fechaCorta(energia.consultado)}. ` +
    energia.nota_mapeo;
}

async function verEventosCorte(codigo) {
  try {
    const horas = $('#f-ventana').value;
    const d = await cargarJSON(`${Almacen.base}/cortes/internet/${codigo}?horas=${horas}`);
    if (!d.eventos.length) { toast(`${d.nombre}: sin eventos en la ventana.`); return; }
    const lineas = d.eventos.slice(0, 8).map((e) =>
      `· ${fechaLocal(e.inicio_iso)} — ${e.duracion_h} h — ${e.fuente_medicion} — score ${nf.format(Math.round(e.score))}`);
    alert(`${d.nombre} — ${d.total} eventos de corte\n` +
          `(hora local de Colombia)\n\n${lineas.join('\n')}`);
  } catch (e) {
    toast('No se pudieron leer los eventos: ' + e.message, true);
  }
}

// ── Almacenamiento de reportes: API si existe, si no localStorage ───────────

const Almacen = {
  modo: 'local',
  base: null,

  async iniciar() {
    for (const base of CFG.basesApi) {
      try {
        const r = await fetch(`${base}/salud`, { method: 'GET' });
        if (r.ok) { this.modo = 'api'; this.base = base; break; }
      } catch (_) { /* siguiente candidato */ }
    }
    const badge = $('#badge-origen');
    badge.textContent = this.modo === 'api' ? 'API + SQLite' : 'solo este navegador';
    badge.className = 'badge ' + this.modo;
    badge.title = this.modo === 'api'
      ? `Guardando en el backend (${this.base}). Los datos son compartidos.`
      : 'Backend no encontrado. Los reportes viven en localStorage de este navegador y no los ve nadie más. Exporta para no perderlos.';
  },

  async listar() {
    if (this.modo === 'api') {
      const gj = await cargarJSON(`${this.base}/reportes`);
      return gj.features.map(deFeature);
    }
    try { return JSON.parse(localStorage.getItem(CFG.claveLocal) || '[]'); }
    catch (_) { return []; }
  },

  async crear(r) {
    if (this.modo === 'api') {
      return await pedir(`${this.base}/reportes`, 'POST', r);
    }
    r.id = 'loc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    r.creado_en = new Date().toISOString();
    r.actualizado_en = r.creado_en;
    const todos = await this.listar();
    todos.push(r);
    this._guardarLocal(todos);
    return r;
  },

  async actualizar(id, r) {
    if (this.modo === 'api') {
      return await pedir(`${this.base}/reportes/${encodeURIComponent(id)}`, 'PUT', r);
    }
    const todos = await this.listar();
    const i = todos.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('Reporte no encontrado');
    todos[i] = { ...todos[i], ...r, id, actualizado_en: new Date().toISOString() };
    this._guardarLocal(todos);
    return todos[i];
  },

  async eliminar(id) {
    if (this.modo === 'api') {
      await pedir(`${this.base}/reportes/${encodeURIComponent(id)}`, 'DELETE');
      return;
    }
    this._guardarLocal((await this.listar()).filter((x) => x.id !== id));
  },

  async crearVarios(lista) {
    for (const r of lista) await this.crear(r);
  },

  _guardarLocal(todos) {
    try {
      localStorage.setItem(CFG.claveLocal, JSON.stringify(todos));
    } catch (e) {
      toast('No se pudo guardar: almacenamiento del navegador lleno. Exporta y limpia.', true);
      throw e;
    }
  },
};

// ── Reportes: pintado, lista y filtros ──────────────────────────────────────

async function recargarReportes() {
  try {
    S.reportes = await Almacen.listar();
  } catch (e) {
    toast('Error al leer los reportes: ' + e.message, true);
    S.reportes = [];
  }
  pintarReportes();
}

function reportesFiltrados() {
  const ft = $('#f-tipo').value, fp = $('#f-prioridad').value, fe = $('#f-estado').value;
  return S.reportes.filter((r) =>
    (!ft || r.tipo === ft) && (!fp || r.prioridad === fp) && (!fe || r.estado === fe));
}

function pintarReportes() {
  S.capas.reportes.clearLayers();
  S.marcadores.clear();

  const lista = reportesFiltrados();

  lista.forEach((r) => {
    const p = PRIORIDADES[r.prioridad] || PRIORIDADES.media;
    const t = TIPOS[r.tipo] || TIPOS.otro;
    const cerrado = r.estado === 'atendido' || r.estado === 'descartado';

    const m = L.circleMarker([r.lat, r.lon], {
      radius: p.radio,
      color: cerrado ? '#5b6577' : p.color,
      weight: 2.5,
      fillColor: t.color,
      fillOpacity: cerrado ? 0.15 : 0.7,
      opacity: cerrado ? 0.5 : 1,
      dashArray: r.verificado ? null : '3 3',
    }).bindPopup(popupReporte(r), { maxWidth: 300 });

    m.on('popupopen', () => {
      const b = document.getElementById('editar-' + cssId(r.id));
      if (b) b.onclick = () => { S.mapa.closePopup(); abrirFormulario(r.id); };
    });

    m.addTo(S.capas.reportes);
    S.marcadores.set(r.id, m);
  });

  $('#conteo-reportes').textContent = lista.length === S.reportes.length
    ? String(S.reportes.length)
    : `${lista.length} / ${S.reportes.length}`;
  actualizarCuenta('reportes', lista.length);
  pintarLista(lista);
}

function popupReporte(r) {
  const t = TIPOS[r.tipo] || TIPOS.otro;
  const p = PRIORIDADES[r.prioridad] || PRIORIDADES.media;
  const dist = Math.round(distanciaKm([S.evento.evento.lat, S.evento.evento.lon], [r.lat, r.lon]));
  return `
    <h3>${escapar(t.etiqueta)}</h3>
    <dl>
      <dt>Prioridad</dt><dd style="color:${p.color}">${escapar(p.etiqueta.split('—')[0].trim())}</dd>
      <dt>Estado</dt><dd>${escapar((ESTADOS[r.estado] || {}).etiqueta || r.estado)}</dd>
      ${r.municipio ? `<dt>Lugar</dt><dd>${escapar(r.municipio)}</dd>` : ''}
      ${r.personas ? `<dt>Personas</dt><dd>${nf.format(r.personas)}</dd>` : ''}
      <dt>Fuente</dt><dd>${escapar((FUENTES[r.fuente] || {}).etiqueta || r.fuente || 's/d')}</dd>
      <dt>Al epicentro</dt><dd>${dist} km</dd>
      <dt>Registrado</dt><dd>${fechaLocal(r.creado_en)}</dd>
    </dl>
    ${r.descripcion ? `<div style="margin-top:8px">${escapar(r.descripcion)}</div>` : ''}
    ${r.verificado ? '' : '<span class="no-verificado">⚠ Sin verificar</span>'}
    ${enlaceWaze(r.lat, r.lon)}
    <button class="btn btn-sec" id="editar-${cssId(r.id)}">Editar</button>
  `;
}

function pintarLista(lista) {
  const ul = $('#lista-reportes');
  ul.innerHTML = '';

  if (!lista.length) {
    const li = document.createElement('li');
    li.className = 'vacio';
    li.style.border = '0';
    li.style.cursor = 'default';
    li.textContent = S.reportes.length
      ? 'Ningún reporte coincide con los filtros.'
      : 'Sin reportes todavía. Usa «Agregar reporte en el mapa».';
    ul.appendChild(li);
    return;
  }

  const orden = { critica: 0, alta: 1, media: 2, baja: 3 };
  [...lista]
    .sort((a, b) => (orden[a.prioridad] ?? 9) - (orden[b.prioridad] ?? 9) ||
                    String(b.creado_en).localeCompare(String(a.creado_en)))
    .forEach((r) => {
      const p = PRIORIDADES[r.prioridad] || PRIORIDADES.media;
      const t = TIPOS[r.tipo] || TIPOS.otro;
      const li = document.createElement('li');
      li.style.borderLeftColor = p.color;
      li.innerHTML = `
        <div class="fila">
          <span class="tit">${escapar(t.etiqueta)}</span>
          <span class="met">${escapar(r.municipio || '')}</span>
        </div>
        <div class="fila">
          <span class="met">${escapar((ESTADOS[r.estado] || {}).etiqueta || r.estado)}${
            r.personas ? ' · ' + nf.format(r.personas) + ' pers.' : ''}${
            r.verificado ? '' : ' · sin verificar'}</span>
          <span class="met">${fechaCorta(r.creado_en)}</span>
        </div>
        ${r.descripcion ? `<div class="desc">${escapar(r.descripcion)}</div>` : ''}`;
      li.onclick = () => {
        S.mapa.setView([r.lat, r.lon], Math.max(S.mapa.getZoom(), 12));
        S.marcadores.get(r.id)?.openPopup();
      };
      ul.appendChild(li);
    });
}

// ── Formulario ──────────────────────────────────────────────────────────────

function abrirFormulario(id, coords) {
  S.editando = id;
  const f = $('#form-reporte');
  f.reset();

  if (id) {
    const r = S.reportes.find((x) => x.id === id);
    if (!r) return;
    S.coordsPendientes = [r.lat, r.lon];
    $('#form-titulo').textContent = 'Editar reporte';
    f.tipo.value = r.tipo;
    f.prioridad.value = r.prioridad;
    f.estado.value = r.estado;
    f.municipio.value = r.municipio || '';
    f.personas.value = r.personas || '';
    f.descripcion.value = r.descripcion || '';
    f.fuente.value = r.fuente || 'llamada';
    f.contacto.value = r.contacto || '';
    f.verificado.checked = !!r.verificado;
    $('#btn-eliminar').hidden = false;
  } else {
    S.coordsPendientes = coords;
    $('#form-titulo').textContent = 'Nuevo reporte';
    f.tipo.value = 'rescate';
    f.prioridad.value = 'alta';
    f.estado.value = 'nuevo';
    f.fuente.value = 'llamada';
    $('#btn-eliminar').hidden = true;
  }

  const [lat, lon] = S.coordsPendientes;
  $('#form-coords').textContent = `Ubicación: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  $('#modal-reporte').hidden = false;
  f.tipo.focus();
}

function cerrarFormulario() {
  $('#modal-reporte').hidden = true;
  S.editando = null;
  S.coordsPendientes = null;
}

async function guardarFormulario(ev) {
  ev.preventDefault();
  const f = $('#form-reporte');
  const [lat, lon] = S.coordsPendientes;

  const datos = {
    lat, lon,
    tipo: f.tipo.value,
    prioridad: f.prioridad.value,
    estado: f.estado.value,
    municipio: f.municipio.value.trim(),
    personas: parseInt(f.personas.value, 10) || 0,
    descripcion: f.descripcion.value.trim(),
    fuente: f.fuente.value,
    contacto: f.contacto.value.trim(),
    verificado: f.verificado.checked,
  };

  try {
    if (S.editando) {
      await Almacen.actualizar(S.editando, datos);
      toast('Reporte actualizado.');
    } else {
      await Almacen.crear(datos);
      toast('Reporte guardado.');
    }
    cerrarFormulario();
    await recargarReportes();
  } catch (e) {
    toast('No se pudo guardar: ' + e.message, true);
  }
}

async function eliminarActual() {
  if (!S.editando) return;
  if (!confirm('¿Eliminar este reporte? No se puede deshacer.')) return;
  try {
    await Almacen.eliminar(S.editando);
    cerrarFormulario();
    await recargarReportes();
    toast('Reporte eliminado.');
  } catch (e) {
    toast('No se pudo eliminar: ' + e.message, true);
  }
}

// ── Exportar / importar ─────────────────────────────────────────────────────

function aFeature(r, conContacto) {
  const props = {
    id: r.id, tipo: r.tipo, prioridad: r.prioridad, estado: r.estado,
    municipio: r.municipio || '', personas: r.personas || 0,
    descripcion: r.descripcion || '', fuente: r.fuente || '',
    verificado: !!r.verificado, creado_en: r.creado_en || '',
    actualizado_en: r.actualizado_en || '',
  };
  if (conContacto) props.contacto = r.contacto || '';
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(r.lon), Number(r.lat)] },
    properties: props,
  };
}

function deFeature(f) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  return {
    id: p.id, lat, lon,
    tipo: p.tipo || 'otro',
    prioridad: p.prioridad || 'media',
    estado: p.estado || 'nuevo',
    municipio: p.municipio || '',
    personas: Number(p.personas) || 0,
    descripcion: p.descripcion || '',
    fuente: p.fuente || 'otro',
    contacto: p.contacto || '',
    verificado: !!p.verificado,
    creado_en: p.creado_en || '',
    actualizado_en: p.actualizado_en || '',
  };
}

function exportarGeoJSON() {
  const conContacto = $('#chk-contacto').checked;
  const lista = reportesFiltrados();
  const gj = {
    type: 'FeatureCollection',
    metadata: {
      generado_por: 'HOPE — mapa base sismo M7.4 Chocó',
      generado_en: new Date().toISOString(),
      evento_usgs: S.evento.evento.id_usgs,
      total: lista.length,
      contacto_incluido: conContacto,
      advertencia: 'Reportes ciudadanos. El campo "verificado" indica si una fuente ' +
                   'confiable lo confirmó. Los no verificados NO deben tratarse como hechos.',
    },
    features: lista.map((r) => aFeature(r, conContacto)),
  };
  descargar(JSON.stringify(gj, null, 2), `hope_reportes_${selloTiempo()}.geojson`,
            'application/geo+json');
  toast(`${lista.length} reportes exportados.`);
}

function exportarCSV() {
  const conContacto = $('#chk-contacto').checked;
  const lista = reportesFiltrados();
  const cols = ['id', 'lat', 'lon', 'tipo', 'prioridad', 'estado', 'municipio',
                'personas', 'descripcion', 'fuente', 'verificado', 'creado_en',
                'actualizado_en', ...(conContacto ? ['contacto'] : [])];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const filas = [cols.join(','), ...lista.map((r) => cols.map((c) => esc(r[c])).join(','))];
  // BOM para que Excel en Windows lea bien las tildes.
  descargar('﻿' + filas.join('\r\n'), `hope_reportes_${selloTiempo()}.csv`,
            'text/csv;charset=utf-8');
  toast(`${lista.length} reportes exportados a CSV.`);
}

async function importarGeoJSON(archivo) {
  try {
    const gj = JSON.parse(await archivo.text());
    const feats = (gj.type === 'FeatureCollection' ? gj.features : [gj])
      .filter((f) => f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates));
    if (!feats.length) throw new Error('El archivo no contiene puntos GeoJSON.');

    const nuevos = feats.map(deFeature).map(({ id, ...r }) => r);  // ids nuevos
    await Almacen.crearVarios(nuevos);
    await recargarReportes();
    toast(`${nuevos.length} reportes importados.`);
  } catch (e) {
    toast('No se pudo importar: ' + e.message, true);
  }
}

// ── UI ──────────────────────────────────────────────────────────────────────

function poblarSelects() {
  const llenar = (sel, cat, vacio) => {
    const el = $(sel);
    if (vacio) el.innerHTML = `<option value="">${vacio}</option>`;
    Object.entries(cat).forEach(([k, v]) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = v.etiqueta;
      el.appendChild(o);
    });
  };
  llenar('#form-tipo', TIPOS);
  llenar('#form-prioridad', PRIORIDADES);
  llenar('#form-estado', ESTADOS);
  llenar('#form-fuente', FUENTES);
  llenar('#f-tipo', TIPOS, 'todos');
  llenar('#f-prioridad', PRIORIDADES, 'todas');
  llenar('#f-estado', ESTADOS, 'todos');
}

function conectarUI() {
  $('#btn-nuevo').onclick = () => activarModoAgregar(!S.modoAgregar);
  $('#btn-cancelar').onclick = cerrarFormulario;
  $('#btn-eliminar').onclick = eliminarActual;
  $('#form-reporte').onsubmit = guardarFormulario;
  $('#btn-exportar-geojson').onclick = exportarGeoJSON;
  $('#btn-exportar-csv').onclick = exportarCSV;
  $('#input-importar').onchange = (e) => {
    if (e.target.files[0]) importarGeoJSON(e.target.files[0]);
    e.target.value = '';
  };
  ['#f-tipo', '#f-prioridad', '#f-estado'].forEach((s) => { $(s).onchange = pintarReportes; });
  $('#f-ventana').onchange = cargarCortes;

  $('#btn-plegar').onclick = () => {
    document.body.classList.toggle('panel-plegado');
    setTimeout(() => S.mapa.invalidateSize(), 200);
  };

  $('#link-entrega').onclick = (e) => { e.preventDefault(); $('#modal-entrega').hidden = false; };
  document.querySelectorAll('.cerrar-modal').forEach((b) => {
    b.onclick = () => { $('#modal-entrega').hidden = true; };
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal-reporte').hidden) cerrarFormulario();
    else if (!$('#modal-entrega').hidden) $('#modal-entrega').hidden = true;
    else if (S.modoAgregar) activarModoAgregar(false);
  });
}

function activarModoAgregar(activo) {
  S.modoAgregar = activo;
  document.body.classList.toggle('modo-agregar', activo);
  $('#hint-nuevo').hidden = !activo;
  $('#btn-nuevo').lastChild.textContent = activo
    ? ' Clic en el mapa… (Esc para salir)'
    : ' Agregar reporte en el mapa';
}

function construirControlCapas() {
  const defs = [
    ['zonas',      'Zonas reportadas',         '#ff3b30'],
    ['aportes',    'Recursos ofrecidos',       '#34c759'],
    ['reportes',   'Apuntes internos',         '#4da3ff'],
    ['cortes',     'Corte de internet (IODA)', '#c77dff'],
    ['energia',    'Energía no entregada (XM)','#00d4ff'],
    ['epicentro',  'Epicentro',                '#ff3b30'],
    ['replicas',   'Réplicas (USGS)',          '#ffd60a'],
    ['sismos',     'Sismos recientes (USGS)',  '#ff6b6b'],
    ['sondas',     'Sondas de red (RIPE Atlas)', '#30d158'],
    ['intensidad', 'Intensidad ShakeMap',      '#ff9100'],
    ['ciudades',   'Ciudades de referencia',   '#5ac8fa'],
    ['anillos',    'Anillos de distancia',     '#ff3b30'],
  ];
  const cont = $('#capas');
  defs.forEach(([clave, etiqueta, color]) => {
    const l = document.createElement('label');
    l.className = 'capa';
    l.innerHTML = `<input type="checkbox" checked data-capa="${clave}">
                   <span class="muestra" style="background:${color}"></span>
                   <span>${etiqueta}</span>
                   <span class="cuenta" id="cuenta-${clave}"></span>`;
    l.querySelector('input').onchange = (e) => {
      e.target.checked ? S.capas[clave].addTo(S.mapa) : S.mapa.removeLayer(S.capas[clave]);
    };
    cont.appendChild(l);
  });
}

function actualizarCuenta(clave, n) {
  const el = document.getElementById('cuenta-' + clave);
  if (el) el.textContent = n === '' ? '' : String(n);
}

function construirLeyenda() {
  const cont = $('#leyenda');
  const bloque = (titulo, filas) => {
    const h = document.createElement('div');
    h.className = 'leyenda-titulo';
    h.textContent = titulo;
    cont.appendChild(h);
    filas.forEach(([color, txt]) => {
      const d = document.createElement('div');
      d.className = 'leyenda-fila';
      d.innerHTML = `<span class="muestra" style="background:${color}"></span><span>${txt}</span>`;
      cont.appendChild(d);
    });
  };

  // Corte de internet: iconos en vez de solo color — mismo lenguaje que el mapa.
  const hIn = document.createElement('div');
  hIn.className = 'leyenda-titulo';
  hIn.textContent = 'Corte de internet (círculo = escala log del score)';
  cont.appendChild(hIn);
  [
    ['ok',    CLASES_CORTE.sin_senal.color,        'Con servicio — sin corte detectado'],
    ['corte', CLASES_CORTE.degradacion_leve.color, 'Corte detectado (leve a colapso)'],
    ['duda',  CLASES_CORTE.punto_ciego.color,      CLASES_CORTE.punto_ciego.etiqueta],
  ].forEach(([estado, color, txt]) => {
    const f = document.createElement('div');
    f.className = 'leyenda-fila';
    f.innerHTML = `<span class="muestra glifo">${svgWifi(color, estado)}</span><span>${txt}</span>`;
    cont.appendChild(f);
  });

  bloque('Prioridad del reporte (borde)',
    Object.values(PRIORIDADES).map((p) => [p.color, p.etiqueta]));
  bloque('Tipo de necesidad (relleno)',
    Object.values(TIPOS).map((t) => [t.color, t.etiqueta]));

  const h = document.createElement('div');
  h.className = 'leyenda-titulo';
  h.textContent = 'Intensidad Mercalli (MMI)';
  cont.appendChild(h);
  const escala = document.createElement('div');
  escala.className = 'escala-mmi';
  escala.innerHTML = Object.values(COLORES_MMI)
    .map((c) => `<span style="background:${c}"></span>`).join('');
  cont.appendChild(escala);
  const eti = document.createElement('div');
  eti.className = 'escala-etiquetas';
  eti.innerHTML = '<span>I no sentido</span><span>V moderado</span><span>X extremo</span>';
  cont.appendChild(eti);

  const filaEnergia = document.createElement('div');
  filaEnergia.className = 'leyenda-fila';
  filaEnergia.innerHTML = `<span class="muestra glifo">${svgRayoCorte('#00d4ff')}</span>` +
                          '<span>Rayo tachado = energía no entregada (área XM)</span>';
  cont.appendChild(filaEnergia);

  const nota = document.createElement('p');
  nota.className = 'hint';
  nota.textContent = 'Borde punteado = reporte sin verificar, o zona sin red que medir. ' +
                     'Relleno tenue = atendido o descartado.';
  cont.appendChild(nota);
}

function pintarFichaEvento() {
  const ev = S.evento.evento;
  const filas = [
    ['Magnitud', `M ${ev.magnitud} (${ev.tipo_magnitud})`, true],
    ['Epicentro', ev.lugar_es],
    ['Profundidad', `${ev.profundidad_km} km`],
    ['Fecha local', ev.tiempo_local],
    ['Alerta PAGER', ev.alerta_pager.toUpperCase(), true],
    ['Intensidad máx.', `MMI ${ev.mmi_max} (${descripcionMMI(ev.mmi_max)})`],
    ['Reportes «lo sentí»', nf.format(ev.reportes_sentido)],
  ];
  $('#ficha-evento').innerHTML = filas.map(([k, v, d]) =>
    `<dt>${k}</dt><dd class="${d ? 'destacado' : ''}">${escapar(String(v))}</dd>`).join('');

  $('#fuente-evento').innerHTML =
    `Fuente: <a href="${ev.url_usgs}" target="_blank" rel="noopener">USGS ${ev.id_usgs}</a>, ` +
    `consultado ${escapar(S.evento._meta.consultado)}. ` +
    `El SGC es la autoridad nacional y reporta profundidad entre 96 y 120,5 km; ` +
    `contrastar antes de cualquier uso oficial.`;
}

// ── Utilidades ──────────────────────────────────────────────────────────────

async function cargarJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

async function pedir(url, metodo, cuerpo) {
  const r = await fetch(url, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (!r.ok) {
    let det = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j.detail) det = JSON.stringify(j.detail); } catch (_) {}
    throw new Error(det);
  }
  return r.status === 204 ? null : r.json();
}

function descargar(texto, nombre, tipo) {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function selloTiempo() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
}

function fechaLocal(v) {
  if (!v) return 's/d';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
}

function fechaCorta(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleString('es-CO',
    { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapar(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

/** Los ids del backend pueden traer caracteres inválidos para un id de HTML. */
function cssId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function nota(txt, esError) {
  const el = $('#estado-carga');
  const p = document.createElement('div');
  if (esError) p.className = 'err';
  p.textContent = txt;
  el.appendChild(p);
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
