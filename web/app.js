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
  pintarDiagramaRed();
  // El control de capas primero: crea los contadores que las capas van llenando.
  construirControlCapas();
  construirLeyenda();
  capaEpicentro();
  capaCiudades();

  // Estas tres son de red y pueden fallar sin tumbar el mapa.
  cargarReplicas();
  cargarIntensidad();
  cargarImpacto();

  await Almacen.iniciar();
  await cargarConfigEscritura();
  await recargarReportes();

  // Lo primero de la capa de datos es el pulso en vivo: es la razón de ser del
  // mapa. Lo demás llena el contexto detrás.
  cargarPulso();           // depende de Almacen: sabe si hay backend o no
  cargarOperadores();
  cargarLugares();
  cargarLuces();
  cargarCortes();
  cargarRadarCF();
  cargarSismosRecientes();
  cargarClima();
  cargarSondasRipe();

  conectarUIZonas();
  iniciarZonas();          // Supabase: zonas y aportes en tiempo real

  iniciarAutoRefresco();
}

// ── Auto-refresco: mantiene alimentadas las capas que no son push (Supabase
// ya empuja zonas/aportes solo). Cada RITMO_MS se vuelve a pedir a las fuentes
// en vivo; nada se inventa entre medias.

const RITMO_MS = 5 * 60 * 1000;

// El pulso va aparte y más rápido: IODA publica series nuevas cada 5-10 min y
// es lo único de este mapa que responde a la pregunta "¿y ahora?". El resto
// (score acumulado, XM, clima) cambia en horas o días y no gana nada con ir
// más seguido — solo gastaría cuota de las fuentes.
const RITMO_PULSO_MS = 2 * 60 * 1000;

function iniciarAutoRefresco() {
  marcarActualizado();

  setInterval(async () => {
    await Promise.allSettled([cargarPulso(), cargarOperadores()]);
    marcarActualizado();
  }, RITMO_PULSO_MS);

  setInterval(async () => {
    await Promise.allSettled([
      cargarReplicas(),
      cargarCortes(),
      cargarRadarCF(),
      cargarLugares(),
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
    // Las luces de satélite van primero de todas: son una imagen de fondo y
    // cualquier otra cosa tiene que quedar por encima para poder leerse.
    luces:      L.layerGroup(),
    mancha:     L.layerGroup(),
    intensidad: L.layerGroup(),
    anillos:    L.layerGroup(),
    impacto:    L.layerGroup(),
    pulso:      L.layerGroup(),
    luzMun:     L.layerGroup(),
    // Los puntos ciegos van en capa propia y por encima: son los que hay que
    // ver primero y los únicos que se pueden apagar sin perder lo demás.
    ciegos:     L.layerGroup(),
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

  // Primero la MANCHA rellena, debajo de los contornos. Las líneas solas se
  // leen como curvas de nivel de un mapa topográfico y no comunican «aquí
  // tembló fuerte»; la mancha sí, de un vistazo y sin leyenda.
  cargarManchaIntensidad();

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

/* La mancha de sacudida del USGS, rellena y georreferenciada.
   ───────────────────────────────────────────────────────────────────────────
   El ShakeMap publica `intensity_overlay.png` junto a un world file `.pngw`
   con la escala y la esquina noroeste. Con esos seis números se calculan los
   límites exactos y la imagen se coloca sobre el mapa sin deformarla.

   Es la zona roja mejor fundamentada que puede tener este mapa: no es una
   estimación de HOPE, es el modelo de sacudida del USGS, revisado 233 veces
   desde el sismo. */
async function cargarManchaIntensidad() {
  try {
    const det = await cargarJSON(CFG.detalleEvento + S.evento.evento.id_usgs);
    const sm = det.properties?.products?.shakemap?.[0];
    const png = sm?.contents?.['download/intensity_overlay.png']?.url;
    const pgw = sm?.contents?.['download/intensity_overlay.pngw']?.url;
    if (!png || !pgw) return;

    // World file: [escala_x, rot, rot, escala_y (negativa), x_centro_NO, y_centro_NO]
    const w = (await (await fetch(pgw)).text()).trim().split(/\s+/).map(Number);
    if (w.length < 6 || !w[0]) return;
    const [ex, , , ey, x0, y0] = w;

    // Hace falta el tamaño en píxeles para saber dónde termina la imagen.
    const dim = await new Promise((ok, no) => {
      const i = new Image();
      i.onload = () => ok([i.naturalWidth, i.naturalHeight]);
      i.onerror = no;
      i.src = png;
    });
    const oeste = x0 - ex / 2, norte = y0 - ey / 2;
    const este = oeste + dim[0] * ex, sur = norte + dim[1] * ey;

    L.imageOverlay(png, [[sur, oeste], [norte, este]], {
      opacity: 0.42,     // deja leer los nombres de los pueblos por debajo
      interactive: false,
      attribution: 'Sacudida: <a href="https://earthquake.usgs.gov/">USGS ShakeMap</a>',
    }).addTo(S.capas.mancha);
    actualizarCuenta('mancha', 'USGS');
  } catch (_) {
    actualizarCuenta('mancha', '—');
  }
}

/* ── Zonas rojas: daños reportados por la prensa ──────────────────────────
   Las fuentes instrumentales del mapa miden infraestructura, no personas. Tres
   días después del sismo la red ya se había recuperado y el mapa se veía
   vacío, mientras la prensa reportaba 190 muertos. Esa capa faltaba.

   Va separada y rotulada como PRENSA a propósito. Un dato de periódico y una
   medida de satélite no valen lo mismo, y mezclarlos en el mismo símbolo haría
   que el mapa mintiera sobre su propia certeza. */

const NIVEL_IMPACTO = {
  critico: { color: '#c92a2a', op: 0.42, et: 'Impacto crítico' },
  alto:    { color: '#e8590c', op: 0.32, et: 'Impacto alto' },
  medio:   { color: '#f08c00', op: 0.22, et: 'Afectación reportada' },
};

async function cargarImpacto() {
  try {
    const [d, limites] = await Promise.all([cargarJSON('data/impacto.json'), cargarLimites()]);
    S.impacto = d;
    S.capas.impacto.clearLayers();

    d.zonas.forEach((z) => {
      const n = NIVEL_IMPACTO[z.nivel] || NIVEL_IMPACTO.medio;
      const forma = limites.get(z.codigo);
      if (forma) {
        L.geoJSON(forma, {
          style: { color: n.color, weight: 2.5, opacity: 0.95,
                   fillColor: n.color, fillOpacity: n.op },
        }).bindTooltip(`<b>${escapar(z.nombre)}</b><br>${escapar(z.resumen)}`, { sticky: true })
          .bindPopup(popupImpacto(z, n, d), { maxWidth: 340 })
          .addTo(S.capas.impacto);
      }
      // Chincheta con la cifra que manda. Es lo que se ve sin abrir nada.
      const cifra = z.muertos ? `${z.muertos} muertos`
                  : z.heridos ? `${z.heridos} heridos`
                  : 'afectado';
      L.marker([z.lat, z.lon], {
        icon: L.divIcon({
          className: 'marca-impacto',
          html: `<div class="chapa" style="--c:${n.color}">
                   <b>${escapar(z.foco)}</b><span>${escapar(cifra)}</span></div>`,
          iconSize: [0, 0], iconAnchor: [0, 0],
        }),
      }).bindPopup(popupImpacto(z, n, d), { maxWidth: 340 }).addTo(S.capas.impacto);
    });

    actualizarCuenta('impacto', d.zonas.length);
    pintarPanelImpacto(d);
  } catch (e) {
    const c = $('#impacto-resumen');
    if (c) c.innerHTML = `<p class="hint err">No se pudo leer: ${escapar(e.message)}</p>`;
  }
}

function popupImpacto(z, n, d) {
  const cifras = [
    z.muertos ? `<dt>Muertos</dt><dd>${nf.format(z.muertos)}</dd>` : '',
    z.heridos ? `<dt>Heridos</dt><dd>${nf.format(z.heridos)}</dd>` : '',
    z.viviendas_afectadas ? `<dt>Viviendas afectadas</dt><dd>${nf.format(z.viviendas_afectadas)}</dd>` : '',
  ].join('');
  return `
    <h3>${escapar(z.foco)} — ${escapar(z.nombre)}</h3>
    <div style="color:${n.color};font-weight:600">${escapar(n.et)}</div>
    ${cifras ? `<dl style="margin-top:8px">${cifras}</dl>` : ''}
    <div style="margin-top:8px">${escapar(z.detalle)}</div>
    <div class="no-verificado" style="margin-top:8px">
      Reporte de PRENSA, no una medida ni una cifra oficial verificada.
      ${escapar(z.fuente)}, corte ${escapar(String(z.fecha_corte).slice(0, 10))}.
      <a href="${escapar(z.url)}" target="_blank" rel="noopener">Ver la fuente</a>
    </div>`;
}

function pintarPanelImpacto(d) {
  const cont = $('#impacto-resumen');
  if (!cont) return;
  const nac = d.nacional;
  cont.innerHTML = `
    <div class="impacto-nacional">
      <b>${nf.format(nac.muertos)} muertos · ${nf.format(nac.heridos)} heridos</b>
      <span>en todo el país, corte del ${escapar(nac.fecha_corte)} según
        ${escapar(nac.fuente)}. Dos días antes iban
        ${nf.format(nac.corte_anterior.muertos)}: las cifras estaban subiendo.</span>
    </div>` +
    d.zonas.map((z) => {
      const n = NIVEL_IMPACTO[z.nivel] || NIVEL_IMPACTO.medio;
      const cifra = z.muertos ? `${nf.format(z.muertos)} muertos`
                  : z.heridos ? `${nf.format(z.heridos)} heridos` : 'sin cifras';
      return `<div class="fila-impacto" data-cod="${z.codigo}">
        <span class="punto" style="background:${n.color}"></span>
        <span class="nom"><b>${escapar(z.foco)}</b> · ${escapar(z.nombre)}</span>
        <span class="cif">${escapar(cifra)}</span>
      </div>`;
    }).join('') +
    `<p class="hint">Recogido de prensa el ${escapar(d._meta.recogido)}.
      ${escapar(d._meta.advertencia)}</p>`;

  cont.querySelectorAll('.fila-impacto').forEach((f) => {
    f.onclick = () => {
      const z = d.zonas.find((x) => String(x.codigo) === f.dataset.cod);
      if (z) S.mapa.setView([z.lat, z.lon], 9);
    };
  });
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
    S.sondas = d;                       // evidencia de respaldo si IODA se cae
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
    repintarSiFaltanMediciones();
  } catch (e) {
    actualizarCuenta('sondas', '—');
  }
}

/* Las fuentes cargan en paralelo y no en orden. Si IODA ya falló y las sondas
   llegan después, el panel tiene que rehacerse para incluirlas: si no, la
   evidencia que sí tenemos queda fuera de la pantalla por una carrera.

   Basta con que UNA zona esté sin medición: es justo esa tarjeta la que tiene
   un hueco que las sondas pueden llenar. */
function repintarSiFaltanMediciones() {
  const cont = $('#pulso-operadores');
  if (cont && S.operadores && S.operadores.operadores.some((o) => o.clase === 'sin_medicion')) {
    pintarOperadores(S.operadores, cont);
  }
  if (!S.pulso || !S.pulso.zonas) return;
  if (!S.pulso.zonas.some((z) => z.clase === 'sin_medicion')) return;
  pintarPulso(S.pulso);
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

/* ═══════════════════════════════════════════════════════════════════════════
   PULSO EN VIVO — la vista principal
   ───────────────────────────────────────────────────────────────────────────
   Pide `/cortes/vivo`, que compara cada zona contra su propio nivel de hace 7
   días usando dos señales de IODA: acceso (última milla) y troncal (rutas BGP).

   La regla de lectura que gobierna todo este bloque: los porcentajes son
   DESVIACIONES, no proporciones de población. Se escribe "−30% vs. normal" y
   nunca "30% sin internet", porque lo segundo sería falso y llevaría a
   dimensionar mal una respuesta.
   ═══════════════════════════════════════════════════════════════════════════ */

// Cada clase trae color, símbolo y una etiqueta corta. `ultima_milla_caida`
// va en el color de energía y no en el de red a propósito: aunque la mida una
// fuente de internet, lo que hace falta ahí es una planta eléctrica.
/* Cada clase se dice dos veces: en cristiano para cualquiera que abra el mapa,
   y en técnico para quien vaya a tomar una decisión con esto.

   `titular` responde «¿qué pasa aquí?» sin jerga y sin números.
   `explica`  responde «¿y eso qué significa para mí?».
   `et`       es la etiqueta técnica, que queda en el detalle plegado.

   La regla de escritura: nada de «degradación», «última milla», «troncal» ni
   porcentajes en el nivel de arriba. Si una frase necesita que ya sepas cómo
   funciona una red, va abajo. */
const CLASES_PULSO = {
  troncal_caido: {
    titular: 'Se cayó el internet de la zona',
    explica: 'Se dañó la conexión grande que le trae internet a toda la región. ' +
             'No es falta de luz: hay que reparar la red o llevar internet por satélite.',
    et: 'Troncal caído', color: '#ff3b30', ico: '⛔', falta: 'red',
  },
  ultima_milla_caida: {
    titular: 'Hay internet en la región, pero no llega a las casas',
    explica: 'Los cables grandes están bien. Lo que no responde son los equipos ' +
             'de las casas y los barrios, y eso casi siempre pasa porque no hay luz: ' +
             'sin electricidad el módem no prende. Aquí lo que hace falta es energía.',
    et: 'Última milla caída', color: '#ff9f0a', ico: '🔌', falta: 'energia',
  },
  troncal_degradado: {
    titular: 'El internet de la zona está fallando',
    explica: 'La conexión grande de la región está funcionando a medias. Si sigue ' +
             'bajando, se convierte en un corte completo.',
    et: 'Troncal degradado', color: '#ff6b6b', ico: '⚠️', falta: 'red',
  },
  ultima_milla_degradada: {
    titular: 'Le está llegando peor de lo normal a las casas',
    explica: 'Los cables grandes están bien, pero muchos equipos de casas y barrios ' +
             'no contestan. Suele ser luz que se va y vuelve.',
    et: 'Acceso degradado', color: '#ffd60a', ico: '🔌', falta: 'energia',
  },
  muestra_chica: {
    titular: 'Aquí casi no hay con qué medir',
    explica: 'Ojo: esto NO quiere decir que esté bien. Quiere decir que en esta zona ' +
             'hay tan poco internet instalado que no alcanzamos a notar si falla. ' +
             'Suele ser peor que una zona con problemas medidos.',
    et: 'Muestra insuficiente', color: '#c77dff', ico: '❓', falta: null,
  },
  degradacion_leve: {
    titular: 'Un poco peor que un día normal',
    explica: 'La diferencia es pequeña y puede ser variación del día a día. Sirve ' +
             'como aviso si sigue bajando en las próximas horas.',
    et: 'Variación leve', color: '#ffd60a', ico: '〰️', falta: null,
  },
  recuperando: {
    titular: 'Mejorando',
    explica: 'Hay más red respondiendo que hace una semana. Suele ser señal de que ' +
             'están restableciendo el servicio.',
    et: 'Recuperando', color: '#30d158', ico: '📈', falta: null,
  },
  normal: {
    titular: 'Funcionando normal',
    explica: 'La red anda como un día cualquiera. No descarta problemas de una casa ' +
             'o una cuadra: esto mira departamentos enteros.',
    et: 'Normal', color: '#34c759', ico: '✓', falta: null,
  },
  sin_medicion: {
    titular: 'No hay datos de esta zona',
    explica: 'La fuente no está respondiendo ahora. No significa que esté bien ni ' +
             'que esté mal: significa que no sabemos.',
    et: 'Sin medición', color: '#98a2b3', ico: '—', falta: null,
  },
};

async function cargarPulso() {
  const cont = $('#pulso-zonas');
  const horas = Number($('#f-pulso')?.value || 3);
  if (!S.pulso) cont.innerHTML = '<p class="hint">Consultando IODA…</p>';
  try {
    // Sin backend se consulta IODA directo: manda CORS abierto. Así el mapa
    // sirve subido a cualquier hosting estático, que en una emergencia es la
    // diferencia entre que alguien lo use y que no.
    const d = Almacen.modo === 'api'
      ? await cargarJSON(`${Almacen.base}/cortes/vivo?horas=${horas}`)
      : await pulsoVivoNavegador(horas);
    S.pulso = d;
    await pintarCapaPulso(d);   // primero el mapa: la lista enlaza a sus polígonos
    pintarPulso(d);
  } catch (e) {
    cont.innerHTML = `<p class="hint err">No se pudo leer IODA: ${escapar(e.message)}</p>`;
  }
}

function pintarPulso(d) {
  const r = d.resumen;
  // El titular cambia según lo que haya. Cuando no hay degradación se dice
  // así de claro, en vez de dejar un panel vacío que se lee como "falla".
  //
  // Medido y no medido NO se suman. El titular se calcula sobre las zonas que
  // de verdad tienen medición: si no se cuentan aparte, ocho tarjetas que
  // dicen «no hay datos» quedan coronadas por un «las 8 zonas están como un
  // día normal», que es exactamente lo contrario de lo que pasa.
  const medidas  = d.zonas.filter((z) => z.clase !== 'sin_medicion');
  const sinMedir = d.zonas.filter((z) => z.clase === 'sin_medicion');
  const hayAlgo = r.con_degradacion > 0;
  const ciegas = d.zonas.filter((z) => z.clase === 'muestra_chica').length;

  // Caso feo y real: la fuente no respondió para ninguna zona. Aquí no se
  // puede decir nada del país, solo de nosotros mismos, y hay que decirlo con
  // el motivo técnico a la vista para que sea arreglable.
  if (!medidas.length) {
    const motivo = d.fallo_fuente || (sinMedir[0] && sinMedir[0].diagnostico) || '';
    $('#pulso-resumen').innerHTML = `
      <div class="pulso-titular sinmedir">
        <b>No pudimos medir ninguna zona</b>
        <span class="firma-ciega">Esto NO quiere decir que no haya internet: quiere
          decir que la fuente no nos contestó. No se puede concluir nada de este
          vacío — confirmar por radio o en terreno.</span>
        ${respaldoIndependiente()}
        ${motivo ? `<span class="motivo-fallo">Motivo técnico: ${escapar(motivo)}</span>` : ''}
      </div>`;
    return pintarFilasPulso(d);
  }

  $('#pulso-resumen').innerHTML = `
    <div class="pulso-titular ${hayAlgo ? 'alerta' : 'calma'}">
      <b>${hayAlgo
            ? `${r.con_degradacion} de ${medidas.length} zonas están peor que un día normal`
            : `Las ${medidas.length} zonas medidas están como un día normal`}</b>
      ${d.rancio
        ? `<span class="firma-ciega">⏱ La fuente no responde ahora mismo. Esto es la
             última medición buena, de ${fechaCorta(d.medido_en || d.consultado)}.
             No es el estado de este minuto.</span>`
        : ''}
      ${sinMedir.length > 0
        ? `<span class="firma-ciega">⚠ ${sinMedir.length} zona${sinMedir.length === 1 ? '' : 's'}
             sin medición: la fuente no contestó por ${sinMedir.length === 1 ? 'ella' : 'ellas'}.
             No están incluidas en la cuenta de arriba.</span>`
        : ''}
      ${r.firma_de_apagon > 0
        ? `<span class="firma-energia">🔌 En ${r.firma_de_apagon} de ellas el problema
             parece ser falta de luz, no falta de internet</span>`
        : ''}
      ${ciegas > 0
        ? `<span class="firma-ciega">❓ ${ciegas} zona${ciegas === 1 ? '' : 's'} sin
             forma de medir. Eso no es estar bien: es no saber.</span>`
        : ''}
    </div>`;

  pintarFilasPulso(d);
}

/* Cuando IODA cae, la pregunta «¿hay internet y hay luz?» NO se queda sin
   respuesta: hay dos fuentes que no pasan por IODA y que se consultan igual.

     · RIPE Atlas — sondas físicas con coordenadas propias. Una sonda que
       responde es prueba de que EN ESE PUNTO hay internet ahora mismo. Son
       decenas en todo el país, así que prueban dónde SÍ hay, no dónde no.
     · VIIRS/Black Marble — luz nocturna por municipio, medida por satélite.
       No necesita que la red del país esté en pie para dar su respuesta.

   Verificado el 2026-08-13, con IODA rechazando conexiones: RIPE Atlas
   contestó en 2,7 s y GIBS en 17,6 s. Dejar la pantalla vacía teniendo esto
   cargado sería tirar la única evidencia disponible. */
function respaldoIndependiente() {
  const trozos = [];

  if (S.sondas && Array.isArray(S.sondas.sondas)) {
    const activas = S.sondas.sondas.filter((s) => s.clase === 'activa').length;
    const caidas = S.sondas.sondas.length - activas;
    if (activas || caidas) {
      trozos.push(
        `<b>${activas} sonda${activas === 1 ? '' : 's'} física${activas === 1 ? '' : 's'} ` +
        `respondiendo</b> en el país${caidas ? ` y ${caidas} caída${caidas === 1 ? '' : 's'} desde el sismo` : ''}. ` +
        'Son puntos exactos y no dependen de IODA: mira la capa de sondas en el mapa.');
    }
  }

  // La capa pueblo por pueblo es independiente de IODA: sacudida y población
  // salen de sismómetros y la luz de un satélite. Cuando IODA se cae, esto es
  // lo único que sigue diciendo algo, y decirlo evita el «no sabemos nada».
  if (S.lugares && Array.isArray(S.lugares.lugares)) {
    const r = S.lugares.resumen || {};
    const bajaron = (r.por_clase || {}).sin_luz || 0;
    trozos.push(bajaron
      ? `<b>La luz por satélite sí se midió:</b> ${bajaron} poblado${bajaron === 1 ? '' : 's'} ` +
        'con pérdida de luz nocturna, ya descontada la deriva del satélite.'
      : '<b>La luz por satélite sí se midió</b> y no marca pérdidas apreciables.');
    if (r.puntos_ciegos) {
      trozos.push(`<b>${r.puntos_ciegos} poblados siguen sin ninguna medición</b> ` +
        `(${nf.format(r.poblacion_en_puntos_ciegos)} personas). Eso no cambia ` +
        'porque IODA vuelva: son sitios que nadie ha mirado.');
    }
  }

  if (!trozos.length) return '';
  return `<span class="respaldo-vivo">Lo que sí sabemos por otras fuentes:<br>${trozos.join('<br>')}</span>`;
}

/** Las tarjetas y el pie. Va aparte del titular porque cuando la fuente falla
 *  entera el titular es otro, pero las tarjetas se pintan igual. */
function pintarFilasPulso(d) {
  const cont = $('#pulso-zonas');
  cont.innerHTML = d.zonas.map(filaPulso).join('');

  // Tocar una tarjeta lleva el mapa a ese departamento. Sin esto, la lista y
  // el mapa son dos cosas separadas y hay que buscar a ojo dónde queda cada
  // nombre — que es justo lo que no se puede pedir en una emergencia.
  cont.querySelectorAll('.pulso-fila').forEach((art, i) => {
    art.addEventListener('click', (ev) => {
      if (ev.target.closest('summary, details')) return;   // abrir el detalle no mueve el mapa
      const capa = S.poligonos && S.poligonos.get(d.zonas[i].codigo);
      if (!capa) return;
      S.mapa.fitBounds(capa.getBounds(), { padding: [30, 30] });
      capa.openPopup();
    });
  });
  $('#pulso-nota').innerHTML =
    `${escapar(d.fuente)} · ventana de ${d.ventana_horas} h contra ${escapar(d.comparado_contra)} ·
     consultado ${fechaCorta(d.consultado)}` +
    (d.sin_backend
      ? '<br><b>Modo sin servidor:</b> internet se consulta directo a IODA desde ' +
        'este navegador. Funciona, pero no hay capa de energía de XM — esa sí ' +
        'necesita el backend de HOPE.'
      : '');
}

/* Lo mismo que `sondasDeZona`, pero por operador: las sondas declaran el ASN
   por el que salen a internet. «3 sondas de este operador respondiendo» no es
   la curva que da IODA, pero responde la pregunta de la sección —¿es la zona o
   es el proveedor?— con aparatos reales en vez de con un guion. */
function sondasDeOperador(asn) {
  const lista = S.sondas && S.sondas.sondas;
  if (!lista) return '';
  const suyas = lista.filter((s) => s.asn === asn);
  if (!suyas.length) return '';
  const vivas = suyas.filter((s) => s.clase === 'activa').length;
  const caidas = suyas.length - vivas;
  if (!vivas && caidas) {
    return `<span class="op-sondas caida" title="${caidas} sonda(s) de este operador se ` +
           `desconectaron tras el sismo y no han vuelto">${caidas}🔴</span>`;
  }
  return `<span class="op-sondas viva" title="${vivas} sonda(s) física(s) de este operador ` +
         `responden ahora mismo${caidas ? `; ${caidas} caída(s) desde el sismo` : ''}">${vivas}🟢` +
         `${caidas ? ` ${caidas}🔴` : ''}</span>`;
}

/* Una zona sin medición de IODA no tiene por qué quedarse en blanco: las
   sondas RIPE Atlas son otra fuente, con otro dueño y otra máquina, y una
   sonda conectada es la prueba más dura que hay de que EN ESE PUNTO hay
   internet ahora mismo — es un aparato físico hablando con RIPE en este
   momento, no una estimación.

   Cuando tampoco hay sondas se dice igual de claro. «Sin forma de medir aquí»
   es información: le dice a quien coordina que ese punto necesita una
   confirmación humana, y evita que el silencio se lea como calma. */
function sondasDeZona(codigo) {
  const porDep = S.sondas && S.sondas.por_departamento;
  if (!porDep) return '';
  const s = porDep[String(codigo)];

  if (!s || (!s.conectadas && !s.caidas_tras_sismo)) {
    return `<p class="sondas-zona vacia">Sin sondas de medición en este departamento:
      aquí no hay ningún punto que podamos comprobar. Hace falta confirmación
      por radio o en terreno.</p>`;
  }

  const partes = [];
  if (s.conectadas) {
    partes.push(`<b>${s.conectadas} sonda${s.conectadas === 1 ? '' : 's'} física${s.conectadas === 1 ? '' : 's'}
      respondiendo aquí ahora mismo</b>: en ${s.conectadas === 1 ? 'ese punto' : 'esos puntos'} sí hay internet.`);
  }
  if (s.caidas_tras_sismo) {
    partes.push(`<b>${s.caidas_tras_sismo} sonda${s.caidas_tras_sismo === 1 ? '' : 's'} caída${s.caidas_tras_sismo === 1 ? '' : 's'}
      desde el sismo</b>: ahí se perdió la conexión y no ha vuelto.`);
  }
  return `<p class="sondas-zona ${s.conectadas ? 'viva' : 'caida'}">${partes.join(' ')}
    <span class="hint">Medido por RIPE Atlas, que no depende de la fuente que falló.
    Son pocos puntos: no cubren el departamento entero.</span></p>`;
}

/* La tarjeta va en dos niveles. Arriba, lo que cualquiera necesita: qué pasa y
   qué significa. Abajo, plegado, lo técnico para quien vaya a actuar.

   Los números NO van arriba a propósito. Un «−16,5%» de titular se lee como
   «el 16% está sin internet», que es falso, y no hay pie de página que
   deshaga esa primera impresión. */
function filaPulso(z) {
  const c = CLASES_PULSO[z.clase] || CLASES_PULSO.sin_medicion;
  const a = z.acceso || {}, t = z.troncal || {};
  const dudoso = a.muestra_suficiente === false;

  const QUE_FALTA = {
    energia: ['Lo que hace falta aquí es ENERGÍA',
              'Una planta eléctrica y combustible. Mandar una cuadrilla de ' +
              'internet no arreglaría nada.'],
    red:     ['Lo que hace falta aquí es RED',
              'Una cuadrilla del operador o un enlace satelital. No se arregla ' +
              'con una planta eléctrica.'],
  }[c.falta];

  return `
    <article class="pulso-fila" style="--c:${c.color}">
      <header>
        <span class="ico" aria-hidden="true">${c.ico}</span>
        <b class="nombre">${escapar(z.nombre)}</b>
        ${tendenciaHTML(z.tendencia)}
      </header>

      <p class="titular-zona">${escapar(c.titular)}</p>
      <p class="explica-zona">${escapar(c.explica)}</p>
      ${z.clase === 'sin_medicion' ? sondasDeZona(z.codigo) : ''}

      ${QUE_FALTA ? `
        <div class="que-falta falta-${c.falta}">
          <b>${escapar(QUE_FALTA[0])}</b>
          <span>${escapar(QUE_FALTA[1])}</span>
        </div>` : ''}

      <details class="detalle-zona">
        <summary>Ver los números</summary>
        <div class="barras">
          <div class="barra" title="La conexión de las casas y los barrios">
            <span class="rot">casas</span>
            ${chispa(a.serie, c.color)}
            <span class="delta ${claseDelta(a.delta_pct)}">${fmtDelta(a.delta_pct)}${dudoso ? ' *' : ''}</span>
          </div>
          <div class="barra" title="Los cables grandes que conectan la región">
            <span class="rot">cables</span>
            ${chispa(t.serie, '#5ac8fa')}
            <span class="delta ${claseDelta(t.delta_pct)}">${fmtDelta(t.delta_pct)}</span>
          </div>
        </div>
        <p class="hint">Comparado con esta misma hora hace 7 días.
          Clasificación técnica: <b>${escapar(c.et)}</b>.</p>
        <p class="diag">${escapar(z.diagnostico || '')}</p>
        ${z.accion ? `<p class="diag">${escapar(z.accion)}</p>` : ''}
        ${dudoso ? '<p class="hint">* Muestra demasiado pequeña para que el ' +
                   'porcentaje sea concluyente.</p>' : ''}
      </details>
    </article>`;
}

/* Diagrama de los dos modos de falla. Es SVG en línea, sin librerías ni
   imágenes: tiene que verse aunque la conexión esté mala, que es exactamente
   la situación de quien más lo necesita.

   Enseña una sola idea, la que hace entendible el resto del panel: la cadena
   tiene dos eslabones y se rompe en sitios distintos según sea apagón o daño
   de red. Se dibujan los dos casos lado a lado porque la comparación es la
   lección; un solo diagrama no la transmite. */
function pintarDiagramaRed() {
  const cont = $('#diagrama-red');
  if (!cont) return;

  // La cadena tiene tres eslabones. Lo que enseña el dibujo es que se rompe en
  // un sitio DISTINTO según la causa, y que por eso se pueden distinguir sin
  // ir hasta allá. Las dos escenas solo se diferencian en dónde va la X: esa
  // diferencia es toda la lección.
  const ESLABONES = [
    { x: 6,   icono: '🌐', etiqueta: 'internet' },
    { x: 68,  icono: '🗼', etiqueta: 'red de la zona' },
    { x: 130, icono: '🏠', etiqueta: 'tu casa' },
  ];
  const ENLACES = [57, 119];   // puntos medios entre eslabón 0-1 y 1-2

  const escena = (titulo, color, apagados, corte, pie) => {
    const eslabon = ({ x, icono, etiqueta }, i) => `
      <g opacity="${apagados.includes(i) ? 0.3 : 1}">
        <rect x="${x}" y="14" width="48" height="34" rx="7" fill="#1e2430"
              stroke="${apagados.includes(i) ? color : '#3d4657'}" stroke-width="1.2"/>
        <text x="${x + 24}" y="36" text-anchor="middle" font-size="17">${icono}</text>
      </g>
      <text x="${x + 24}" y="61" text-anchor="middle" font-size="7.5"
            fill="${apagados.includes(i) ? color : '#99a2b3'}">${etiqueta}</text>`;

    const xc = ENLACES[corte];
    return `
      <figure class="escena">
        <figcaption style="color:${color}">${titulo}</figcaption>
        <svg viewBox="0 0 202 68" width="100%" role="img" aria-label="${titulo}">
          <line x1="54" y1="31" x2="66" y2="31" stroke="#3d4657" stroke-width="2"/>
          <line x1="116" y1="31" x2="128" y2="31" stroke="#3d4657" stroke-width="2"/>
          ${ESLABONES.map(eslabon).join('')}
          <line x1="${xc - 7}" y1="24" x2="${xc + 7}" y2="38" stroke="${color}"
                stroke-width="2.8" stroke-linecap="round"/>
          <line x1="${xc - 7}" y1="38" x2="${xc + 7}" y2="24" stroke="${color}"
                stroke-width="2.8" stroke-linecap="round"/>
        </svg>
        <p>${pie}</p>
      </figure>`;
  };

  cont.innerHTML =
    // Apagón: el internet llega hasta la zona, se corta al entrar a la casa.
    escena('Se fue la luz', '#ff9f0a', [2], 1,
           'El internet llega hasta la zona, pero sin electricidad el módem de tu ' +
           'casa no prende. Hace falta <b>energía</b>.') +
    // Daño de red: se corta antes, y la zona entera queda por fuera.
    escena('Se dañó la red', '#ff3b30', [1, 2], 0,
           'Se rompió la conexión que le trae internet a toda la región. Aunque ' +
           'tengas luz, no llega nada. Hace falta <b>reparar la red</b>.');
}

/** Una zona -30% y estable lleva horas así, y probablemente ya la están
 *  atendiendo. Una zona -30% y cayendo se está apagando mientras alguien mira
 *  la pantalla. Es la diferencia entre mirar y actuar, así que va visible. */
function tendenciaHTML(t) {
  const T = {
    empeorando: ['▼', 'empeorando', 'mal'],
    mejorando:  ['▲', 'mejorando',  'bien'],
    estable:    ['=', 'estable',    ''],
  }[t];
  if (!T) return '';
  return `<span class="tend ${T[2]}" title="Tendencia dentro de la ventana: ${T[1]}">
            ${T[0]} ${T[1]}</span>`;
}

function fmtDelta(v) {
  if (v === null || v === undefined) return 's/d';
  return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
}

function claseDelta(v) {
  if (v === null || v === undefined) return '';
  if (v <= -20) return 'mal';
  if (v <= -8) return 'ojo';
  if (v >= 8) return 'bien';
  return '';
}

/** Sparkline en SVG, sin librerías. Escala al min/max de la propia serie:
 *  lo que interesa es la FORMA (¿está cayendo ahora?), no el valor absoluto,
 *  que ya sale como porcentaje al lado. */
function chispa(serie, color) {
  const s = (serie || []).filter((v) => typeof v === 'number');
  if (s.length < 3) return '<svg class="chispa" viewBox="0 0 100 24"></svg>';
  const min = Math.min(...s), max = Math.max(...s);
  const rango = max - min || 1;
  const pts = s.map((v, i) =>
    `${(i / (s.length - 1) * 100).toFixed(1)},${(22 - (v - min) / rango * 20).toFixed(1)}`
  ).join(' ');
  return `<svg class="chispa" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* El pulso se pinta sobre el DEPARTAMENTO ENTERO, con su borde real.
   ───────────────────────────────────────────────────────────────────────────
   Antes esto era un círculo centrado en un par de coordenadas escritas a mano
   y con el radio proporcional a la caída. Ese círculo no correspondía a nada:
   ni al borde del departamento, ni al alcance del corte. Y el ojo lee un
   círculo en un mapa como «el problema está aquí dentro», así que afirmaba una
   precisión que el dato no tiene.

   IODA mide por departamento completo y para Colombia no se puede bajar de
   ahí. El polígono dice exactamente eso: en algún punto de esta área, y no
   sabemos dónde. Es más honesto y además más útil, porque se ve qué municipios
   caen dentro. */

async function cargarLimites() {
  if (S.limites) return S.limites;
  try {
    const g = await cargarJSON('data/departamentos.geojson');
    S.limites = new Map(g.features.map((f) => [f.properties.codigo, f]));
  } catch (e) {
    S.limites = new Map();   // sin límites se sigue, solo que sin polígonos
  }
  return S.limites;
}

async function pintarCapaPulso(d) {
  const limites = await cargarLimites();
  S.capas.pulso.clearLayers();
  S.poligonos = new Map();
  let n = 0;

  d.zonas.forEach((z) => {
    const forma = limites.get(z.codigo);
    if (!forma) return;
    const c = CLASES_PULSO[z.clase] || CLASES_PULSO.sin_medicion;
    const tranquila = z.clase === 'normal' || z.clase === 'sin_medicion';
    const dudosa = z.clase === 'muestra_chica';

    const capa = L.geoJSON(forma, {
      attribution: 'Límites: <a href="https://www.geoboundaries.org/">geoBoundaries</a> / OpenStreetMap',
      style: {
        color: c.color,
        // Las zonas normales van casi transparentes: tienen que verse para que
        // se sepa que SÍ se están midiendo, sin taparle el mapa a lo urgente.
        weight: tranquila ? 1 : 2,
        opacity: tranquila ? 0.5 : 0.95,
        // Borde punteado en la zona sin muestra suficiente: la forma dice
        // «no estamos midiendo bien aquí», no «aquí no pasa nada».
        dashArray: dudosa ? '6 5' : null,
        fillColor: c.color,
        // Relleno muy bajo: la mancha del USGS y las zonas rojas de danos
        // ya ocupan el fondo. Si esta capa tambien rellena fuerte, los
        // colores se mezclan y no se distingue ninguna.
        fillOpacity: tranquila ? 0.04 : dudosa ? 0.07 : 0.12,
      },
    })
      .bindTooltip(`<b>${escapar(z.nombre)}</b><br>${escapar(c.titular)}`,
                   { sticky: true })
      .bindPopup(popupPulso(z, c), { maxWidth: 320 })
      .addTo(S.capas.pulso);

    S.poligonos.set(z.codigo, capa);

    // Icono en el centro del polígono. No es una afirmación de dónde está el
    // corte —eso no se sabe— sino la ETIQUETA del departamento entero, igual
    // que el nombre de un país va escrito en su centro.
    if (!tranquila) {
      const nivel = { troncal_caido: 'sin', ultima_milla_caida: 'sin',
                      troncal_degradado: 'poca', ultima_milla_degradada: 'poca',
                      degradacion_leve: 'poca', muestra_chica: 'duda' }[z.clase];
      if (nivel) {
        L.marker(capa.getBounds().getCenter(),
                 { icon: marcaEstado('red', nivel, z.nombre) })
          .bindPopup(popupPulso(z, c), { maxWidth: 320 })
          .addTo(S.capas.pulso);
      }
      n++;
    }
  });

  actualizarCuenta('pulso', n);
}

function popupPulso(z, c) {
  const a = z.acceso || {}, t = z.troncal || {};
  return `
    <h3>${escapar(z.nombre)}</h3>
    <div style="color:${c.color};font-weight:600">${c.ico} ${escapar(c.titular)}</div>
    <div style="margin-top:6px">${escapar(c.explica)}</div>
    <dl style="margin-top:8px">
      <dt>Casas y barrios</dt><dd>${fmtDelta(a.delta_pct)}</dd>
      <dt>Cables de la región</dt><dd>${fmtDelta(t.delta_pct)}</dd>
    </dl>
    <div class="hint" style="margin-top:8px">Comparado con esta misma hora hace
      7 días. El dato es del <b>departamento completo</b>: no dice en qué
      municipio ni en qué barrio. Para puntos exactos, mira la capa «Sondas de
      red» o los reportes de la gente.</div>
  `;
}

/* ── Parte de situación: sacar los datos de la pantalla ────────────────────
   La restricción de todo el proyecto es que datos sin canal hacia quien ejecuta
   el rescate no le llegan a nadie. Un GeoJSON no se lee en un celular de
   madrugada; un mensaje de WhatsApp sí.

   Con backend se pide `/api/informe`, que además cruza XM. Sin backend se
   arma aquí mismo con lo que ya está en pantalla, diciendo qué falta. */

async function generarParte() {
  const horas = Number($('#f-pulso')?.value || 3);
  if (Almacen.modo === 'api') {
    const r = await fetch(
      `${Almacen.base}/informe?horas=${horas}&url_mapa=${encodeURIComponent(location.href)}`);
    if (!r.ok) throw new Error('El backend no pudo generar el parte');
    return r.text();
  }
  return parteDesdePantalla(S.pulso, horas);
}

function parteDesdePantalla(p, horas) {
  if (!p) throw new Error('Todavía no hay datos cargados');
  const L = [];
  const f = new Date().toLocaleString('es-CO',
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  L.push('HOPE · PARTE DE RED');
  L.push(`${f} hora local`);
  L.push('Sismo M7.4 Chocó 10-ago-2026 · evento USGS us6000tjl2');
  L.push('');
  L.push(`ESTADO: ${p.resumen.con_degradacion} de ${p.resumen.zonas_medidas} zonas ` +
         'por debajo de su nivel normal.');
  L.push('');

  const graves = p.zonas.filter((z) => ['troncal_caido', 'ultima_milla_caida',
    'troncal_degradado', 'ultima_milla_degradada'].includes(z.clase));
  const ciegas = p.zonas.filter((z) => z.clase === 'muestra_chica');
  const resto = p.zonas.filter((z) => ['normal', 'recuperando', 'degradacion_leve'].includes(z.clase));

  const FL = { empeorando: '(empeorando)', mejorando: '(mejorando)', estable: '(estable)' };

  if (graves.length) {
    graves.forEach((z) => {
      L.push(`[!] ${z.nombre.toUpperCase()} — acceso ${z.acceso.delta_pct}% ` +
             `${FL[z.tendencia] || ''}`.trim());
      L.push(z.clase.startsWith('ultima_milla')
        ? `    FALTA ENERGIA. El troncal sigue en pie (${z.troncal.delta_pct}%):\n` +
          '    la fibra esta sana y no responden los equipos del usuario.\n' +
          '    Se necesita planta y combustible, no cuadrilla de red.'
        : `    FALTA RED. El operador retiro rutas (${z.troncal.delta_pct}%):\n` +
          '    corte fisico o nodo caido. Se necesita cuadrilla del operador\n' +
          '    o enlace satelital.');
      L.push('');
    });
  } else {
    L.push('Ninguna zona con degradacion significativa en esta ventana.');
    L.push('');
  }

  if (ciegas.length) {
    L.push('PUNTOS CIEGOS (no es que esten bien, es que no hay que medir):');
    ciegas.forEach((z) => L.push(`  - ${z.nombre}: solo ~${z.acceso.linea_base} ` +
                                 'bloques de red medibles.'));
    L.push('    Candidatas a enlace satelital: alli no hay red que restaurar,');
    L.push('    hay red que llevar.');
    L.push('');
  }
  if (resto.length) {
    L.push('SIN CAMBIO: ' + resto.map((z) => z.nombre).join(', ') + '.');
    L.push('');
  }

  L.push('ENERGIA: no disponible en este modo (XM necesita el servidor de HOPE).');
  L.push('');
  L.push('COMO LEER ESTO');
  L.push('Los porcentajes son la desviacion de cada zona contra SI MISMA hace');
  L.push('7 dias a la misma hora. NO son porcentaje de poblacion sin servicio.');
  L.push(`Ventana de ${horas} h. Fuente: IODA (Georgia Tech), series de 5-10 min.`);
  L.push('Granularidad maxima: departamento.');
  L.push('');
  L.push('ESTO NO ES UN DESPACHO DE EMERGENCIA. Para vidas en riesgo: 123.');
  L.push('Es apoyo de datos: nadie es enviado a ningun sitio desde aqui.');
  L.push(`Mapa: ${location.href}`);
  return L.join('\n');
}

/* Copiar es lo único que funciona en todos lados. Se intentó abrir WhatsApp
   directo con wa.me y no sirve: el enlace se abre DESPUÉS de esperar los datos,
   y para entonces el navegador ya no lo cuenta como un clic de la persona, así
   que lo bloquea como ventana emergente. Copiar y pegar da un paso más de
   trabajo pero nunca falla, y deja elegir WhatsApp, correo o lo que sea. */

async function copiarParte() {
  const area = $('#parte-texto');
  const texto = area.value;
  const ayuda = $('#parte-ayuda');
  try {
    // El texto ya está en pantalla, así que esto corre directo sobre el clic:
    // no hay espera de por medio que le quite el permiso.
    await navigator.clipboard.writeText(texto);
    toast('Informe copiado. Pégalo en WhatsApp, Telegram o el correo.');
  } catch (_) {
    // Sin permiso de portapapeles (pasa en algunos navegadores de celular), se
    // deja el texto seleccionado para que copiarlo a mano sea un gesto.
    area.focus();
    area.select();
    if (ayuda) {
      ayuda.textContent = 'Tu navegador no dejó copiar automáticamente. El texto ' +
        'ya quedó seleccionado: usa Ctrl+C, o mantén pulsado y elige «Copiar».';
      ayuda.classList.add('destacado');
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ICONOS DE ESTADO — dónde no hay luz, dónde hay poca, dónde no hay internet
   ───────────────────────────────────────────────────────────────────────────
   Un polígono de color dice «algo pasa en esta zona». Un icono dice QUÉ pasa,
   y eso es lo que alguien necesita leer de un vistazo, sin abrir nada.

   Reglas de legibilidad, que son las que hacen que se entienda a 24 px:
     · Glifo BLANCO sobre disco de color sólido. Máximo contraste, siempre, sea
       cual sea el mapa base que haya debajo.
     · Formas que ya conoce todo el mundo: bombilla para luz, arcos de wifi
       para internet. Nada de símbolos que haya que aprender.
     · La barra diagonal es el «no» universal, el mismo de «prohibido fumar».
     · Para «poca», el glifo se dibuja a medias en vez de tachado: la forma
       distingue «no hay» de «hay poco» sin depender solo del color, que es lo
       que falla con daltonismo y con el brillo del sol en pantalla.
   ═══════════════════════════════════════════════════════════════════════════ */

const COLOR_ESTADO = {
  sin:  '#e03131',   // rojo
  poca: '#f59f00',   // ámbar
  ok:   '#2f9e44',   // verde
  duda: '#9c36b5',   // morado — no sabemos
};

/** Rayo. Se probó primero una bombilla y a 28 px se leía como un signo de
 *  admiración: el bulbo más la rosca dan esa silueta. El rayo no se parece a
 *  nada más y se reconoce como «electricidad» sin pensarlo.
 *  En «poca» se pinta solo la mitad de abajo, así que la FORMA ya distingue
 *  «no hay» de «hay poco» aunque no se distinga el color. */
function glifoRayo(parcial) {
  const D = 'M13.6 2.6 L7 13.4 h4 l-1 8 L17.4 10.6 h-4.5 z';
  // «Poca» se dibuja más pequeño en vez de recortado a la mitad: un clipPath
  // necesita un id, y con decenas de iconos en el mapa esos ids se repiten y
  // el navegador acaba resolviendo todos contra el primero. Escalar no
  // necesita id ninguno y se lee igual de bien.
  return parcial
    ? `<g transform="translate(12 12) scale(.68) translate(-12 -12)">
         <path d="${D}" fill="#fff"/></g>`
    : `<path d="${D}" fill="#fff"/>`;
}

/** Arcos de wifi. En «poca» solo se pinta el arco pequeño: menos arcos = menos
 *  señal, que es la convención que ya usa cualquier celular. */
function glifoWifi(parcial) {
  const tenue = parcial ? 'rgba(255,255,255,.3)' : '#fff';
  return `
    <path d="M4.4 9.6a11 11 0 0 1 15.2 0" fill="none" stroke="${tenue}"
          stroke-width="2.2" stroke-linecap="round"/>
    <path d="M7.4 13.2a6.6 6.6 0 0 1 9.2 0" fill="none"
          stroke="${parcial ? '#fff' : '#fff'}" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="12" cy="17.4" r="1.9" fill="#fff"/>`;
}

/** Disco + glifo + barra. `nivel`: 'sin' | 'poca' | 'ok' | 'duda'. */
function iconoEstado(tipo, nivel, px = 32) {
  const color = COLOR_ESTADO[nivel] || COLOR_ESTADO.duda;
  const glifo = nivel === 'duda'
    ? '<text x="12" y="17" text-anchor="middle" font-size="14" font-weight="800" fill="#fff">?</text>'
    : (tipo === 'luz' ? glifoRayo(nivel === 'poca') : glifoWifi(nivel === 'poca'));

  // La barra se dibuja dos veces: una gruesa del color del disco por debajo y
  // la blanca encima. Ese borde de separación es lo que evita que la barra se
  // funda con el glifo — el rayo es diagonal igual que ella y sin esto los dos
  // se leían como una sola mancha.
  const barra = nivel === 'sin'
    ? `<line x1="5.6" y1="5.6" x2="18.4" y2="18.4" stroke="${color}" stroke-width="4"
             stroke-linecap="round"/>
       <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" stroke="#fff" stroke-width="2.2"
             stroke-linecap="round"/>`
    : '';

  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}">
      <circle cx="12" cy="12" r="11" fill="${color}" stroke="#fff" stroke-width="1.6"/>
      ${glifo}${barra}
    </svg>`;
}

function marcaEstado(tipo, nivel, etiqueta, px = 28) {
  return L.divIcon({
    className: 'marca-estado',
    html: `<div class="marca-caja">${iconoEstado(tipo, nivel, px)}` +
          (etiqueta ? `<span class="marca-texto">${escapar(etiqueta)}</span>` : '') + '</div>',
    iconSize: [px, px],
    iconAnchor: [px / 2, px / 2],
  });
}

// ── Capa: pueblo por pueblo. La vista de mayor resolución del sistema ───────
//
// Sustituye a la capa de luz por municipio, que solo miraba 17 ciudades del
// catálogo y leía el satélite en crudo. Esta mira los 263 poblados que el USGS
// confirma sacudidos, y a cada porcentaje de luz ya le viene descontada la
// deriva del satélite. Sin esa resta, la fase de la luna y las nubes pintaban
// 114 pueblos «sin luz» que no lo estaban.
//
// Lo nuevo, y lo importante: el PUNTO CIEGO. Un pueblo que tembló fuerte y del
// que no existe ni una medición local. Antes se veía igual que uno comprobado
// sano — que es exactamente al revés de lo que hay que mirar primero.

const CLASE_LUGAR = {
  sin_luz_y_sin_red: { tipo: 'luz', nivel: 'sin',  et: 'Sin luz y sin red' },
  sin_luz:           { tipo: 'luz', nivel: 'sin',  et: 'Sin luz' },
  sin_red:           { tipo: 'red', nivel: 'sin',  et: 'Sin red' },
  punto_ciego:       { tipo: 'red', nivel: 'duda', et: 'Nadie lo ha medido' },
};

const CERTEZA_TXT = {
  local: 'Medido aquí mismo',
  heredada: 'Solo se sabe el promedio de su departamento',
  ninguna: 'Sin ninguna medición',
};

/** Los pueblos grandes se ven más. No es decoración: entre dos puntos ciegos,
 *  el de 45.000 habitantes se atiende antes que el de 400. */
function tamanoPorPoblacion(pob) {
  if (!pob || pob < 5000) return 22;
  if (pob < 20000) return 27;
  if (pob < 60000) return 32;
  return 38;
}

async function cargarLugares() {
  const cont = $('#luz-municipios');
  if (Almacen.modo !== 'api') {
    if (cont) {
      cont.innerHTML = '<p class="hint">Esta vista necesita el backend de HOPE: ' +
        'cruza cuatro fuentes a la vez y una de ellas no se puede consultar ' +
        'desde el navegador.</p>';
    }
    return;
  }
  try {
    const d = await cargarJSON(`${Almacen.base}/mapa/lugares`);
    S.lugares = d;
    S.capas.luzMun.clearLayers();
    S.capas.ciegos.clearLayers();

    let conProblema = 0;
    let ciegos = 0;

    d.lugares.forEach((l) => {
      const c = CLASE_LUGAR[l.clase];
      // Los pueblos sin novedad no se marcan. Llenar el mapa de iconos verdes
      // tapa justo lo que hay que ver.
      if (!c) return;
      const px = tamanoPorPoblacion(l.poblacion);
      const capa = l.clase === 'punto_ciego' ? S.capas.ciegos : S.capas.luzMun;
      if (l.clase === 'punto_ciego') ciegos++; else conProblema++;

      L.marker([l.lat, l.lon], { icon: marcaEstado(c.tipo, c.nivel, l.nombre, px) })
        .bindPopup(popupLugar(l, c, d), { maxWidth: 340 })
        .addTo(capa);
    });

    actualizarCuenta('luzMun', conProblema);
    actualizarCuenta('ciegos', ciegos);
    pintarPanelLugares(d, cont);
    repintarSiFaltanMediciones();
  } catch (e) {
    if (cont) cont.innerHTML = `<p class="hint err">No se pudo medir: ${escapar(e.message)}</p>`;
  }
}

function popupLugar(l, c, d) {
  const luz = l.luz;
  const filas = [];

  filas.push(['Cuánto tembló',
    `MMI ${l.mmi.toFixed(1)} — ${descripcionMMI(Math.round(l.mmi))}`]);
  filas.push(['Cuánta gente', nf.format(l.poblacion) + ' hab.']);

  if (luz && luz.utilizable) {
    filas.push(['Luz nocturna',
      `${luz.cambio_pct}% frente a pueblos que apenas temblaron`]);
  } else if (luz) {
    filas.push(['Luz nocturna', 'no se puede afirmar nada']);
  }

  if (l.red_local) {
    filas.push(['Sonda física',
      `${l.red_local.cuantas} a ${l.red_local.km_mas_cerca} km — ` +
      (l.red_local.hay_internet_confirmado ? 'responde' : 'no responden')]);
  }
  if (l.red_departamento) {
    filas.push(['Red del departamento',
      `${escapar(l.departamento)}: ${escapar(l.red_departamento.clase || 's/d')}`]);
  }

  const necesita = l.necesita_texto
    ? `<div class="popup-necesita"><b>Qué haría falta:</b> ${escapar(l.necesita_texto)}</div>`
    : '';

  return `
    <h3>${escapar(l.nombre)}${l.departamento ? ', ' + escapar(l.departamento) : ''}</h3>
    <div style="color:${COLOR_ESTADO[c.nivel]};font-weight:600">${escapar(l.etiqueta)}</div>
    <dl style="margin-top:8px">
      ${filas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
      <dt>Certeza</dt><dd>${escapar(CERTEZA_TXT[l.certeza] || l.certeza)}</dd>
    </dl>
    ${luz && luz.lectura ? `<div style="margin-top:8px">${escapar(luz.lectura)}</div>` : ''}
    ${necesita}
    <div class="hint" style="margin-top:8px">Sacudida y población: USGS PAGER.
      Luz: satélite VIIRS con la deriva (${d.deriva_luz.valor_pct}%) ya descontada.
      Red: IODA, que no baja del departamento.</div>`;
}

function pintarPanelLugares(d, cont) {
  if (!cont) return;
  const r = d.resumen;
  const ciegos = d.lugares.filter((l) => l.clase === 'punto_ciego');
  const malos = d.lugares.filter((l) => l.clase === 'sin_luz' ||
                                        l.clase === 'sin_luz_y_sin_red' ||
                                        l.clase === 'sin_red');

  const fila = (l, marca) => `
    <div class="fila-luz">
      <span class="ico-mini">${iconoEstado(marca.tipo, marca.nivel, 22)}</span>
      <span class="nom">${escapar(l.nombre)}</span>
      <span class="cambio">${nf.format(l.poblacion)} hab.</span>
    </div>`;

  let html = '';

  if (ciegos.length) {
    html += `<p class="titular-ciegos"><b>${ciegos.length} pueblos temblaron fuerte
      y nadie los ha medido.</b> Viven allí ${nf.format(r.poblacion_en_puntos_ciegos)}
      personas. No es que estén bien: es que no hay dato.</p>` +
      ciegos.slice(0, 10).map((l) => fila(l, CLASE_LUGAR.punto_ciego)).join('') +
      (ciegos.length > 10 ? `<p class="hint">y ${ciegos.length - 10} más en el mapa.</p>` : '');
  }

  if (malos.length) {
    html += `<p class="hint" style="margin-top:12px"><b>Con pérdida medida:</b></p>` +
      malos.slice(0, 8).map((l) => fila(l, CLASE_LUGAR[l.clase])).join('') +
      (malos.length > 8 ? `<p class="hint">y ${malos.length - 8} más en el mapa.</p>` : '');
  }

  if (!html) html = '<p class="hint">Ningún poblado con pérdida medible ni sin medición en esta consulta.</p>';

  html += `<p class="hint">Se evaluaron ${nf.format(r.lugares)} poblados
    (${nf.format(r.poblacion_expuesta)} personas expuestas). Solo
    ${nf.format(r.medidos_localmente)} tienen medición <b>local</b>; del resto
    únicamente se conoce el promedio de su departamento, que no distingue un
    pueblo de otro.</p>`;

  if (d.deriva_luz && d.deriva_luz.valor_pct !== null) {
    html += `<p class="hint">A los porcentajes de luz se les descontó
      ${d.deriva_luz.valor_pct}%, que es lo que bajó la luz en
      ${d.deriva_luz.poblados_de_control} pueblos que apenas temblaron. Ese
      trozo es luna y nubes, no apagón: sin restarlo, medio país aparecería
      a oscuras.</p>`;
  }

  cont.innerHTML = html;
}

// ── Panel: estado por operador ──────────────────────────────────────────────

async function cargarOperadores() {
  const cont = $('#pulso-operadores');
  if (!cont) return;
  try {
    const horas = Number($('#f-pulso')?.value || 3);
    const d = Almacen.modo === 'api'
      ? await cargarJSON(`${Almacen.base}/cortes/operadores?horas=${horas}`)
      : await pulsoOperadoresNavegador(horas);
    S.operadores = d;
    pintarOperadores(d, cont);
  } catch (e) {
    cont.innerHTML = `<p class="hint err">No se pudo leer: ${escapar(e.message)}</p>`;
  }
}

function pintarOperadores(d, cont) {
  cont.innerHTML = d.operadores.map((o) => {
      const c = CLASES_PULSO[o.clase] || CLASES_PULSO.sin_medicion;
      const a = o.acceso || {};
      // Sin medición de IODA, la fila no tiene por qué quedarse en «s/d»: las
      // sondas RIPE declaran su ASN, así que se puede decir cuántos aparatos
      // de ESE operador están hablando ahora mismo.
      const s = o.clase === 'sin_medicion' ? sondasDeOperador(o.codigo) : '';
      return `<div class="op-fila" title="${escapar(o.diagnostico || '')}">
        <span class="op-punto" style="background:${c.color}"></span>
        <span class="op-nombre">${escapar(o.nombre)}</span>
        ${chispa(a.serie, c.color)}
        <span class="delta ${claseDelta(a.delta_pct)}">${s || fmtDelta(a.delta_pct)}</span>
      </div>`;
    }).join('') + `<p class="hint">${escapar(d.nota)}</p>`;
}

// ── Capa: luces nocturnas VIIRS (NASA GIBS) ─────────────────────────────────
//
// Teselas servidas directo por la NASA al navegador: no pasan por el backend
// porque no hace falta llave ni hay problema de CORS con imágenes.
//
// Son excluyentes entre sí: ver dos noches encimadas no compara nada. El botón
// activo apaga a los otros dos. La noche de referencia es anterior al sismo y
// existe justo para eso — para tener contra qué comparar.

// Plantilla y noches cuando no hay backend. Sin backend no se puede sondear el
// peso de la tesela, así que no se sabe qué noches procesó la NASA: se ofrecen
// todas y se avisa. Es peor esconder la capa que darla con su advertencia.
function lucesSinBackend() {
  const dia = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  return {
    plantilla: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
               'VIIRS_NOAA20_DayNightBand/default/{fecha}/' +
               'GoogleMapsCompatible_Level7/{z}/{y}/{x}.png',
    zoom_max: 7,
    noches: [
      { clave: 'anoche', fecha: dia(0), procesada: true },
      { clave: 'anterior', fecha: dia(1), procesada: true },
      { clave: 'previa', fecha: dia(2), procesada: true },
      { clave: 'referencia', fecha: '2026-08-08', procesada: true },
    ],
    nota_procesado: 'Sin backend no se puede comprobar qué noches publicó ya la ' +
      'NASA. Si una sale completamente negra, lo más probable es que aún no esté ' +
      'procesada — no que se haya ido la luz en todo el país.',
  };
}

async function cargarLuces() {
  const cont = $('#luces-control');
  if (!cont) return;
  try {
    const cfg = Almacen.modo === 'api'
      ? await cargarJSON(`${Almacen.base}/cortes/luces`)
      : lucesSinBackend();
    const ET = {
      anoche: 'Anoche', anterior: 'Anteanoche', previa: 'Hace 3 noches',
      referencia: 'Antes del sismo',
    };

    // Las noches que la NASA aún no procesó van deshabilitadas, no ocultas:
    // que se vea que existen y por qué no se pueden mirar todavía.
    cont.innerHTML = cfg.noches.map((n) =>
      `<button type="button" class="btn btn-sec luz-btn${n.procesada ? '' : ' pendiente'}"
               data-fecha="${n.procesada ? n.fecha : ''}" ${n.procesada ? '' : 'disabled'}
               title="${n.procesada ? '' : 'La NASA todavía no publicó esta noche'}">
         ${escapar(ET[n.clave] || n.clave)}<small>${escapar(n.fecha)}${n.procesada ? '' : ' · sin procesar'}</small>
       </button>`).join('') +
      `<button type="button" class="btn btn-sec luz-btn activo" data-fecha="">Apagar</button>`;

    cont.querySelectorAll('.luz-btn:not([disabled])').forEach((b) => {
      b.onclick = () => {
        cont.querySelectorAll('.luz-btn').forEach((o) => o.classList.remove('activo'));
        b.classList.add('activo');
        S.capas.luces.clearLayers();
        const fecha = b.dataset.fecha;
        if (!fecha) { actualizarCuenta('luces', '—'); return; }
        L.tileLayer(cfg.plantilla.replace('{fecha}', fecha), {
          maxNativeZoom: cfg.zoom_max, maxZoom: 18, opacity: 0.85,
          attribution: 'Imagen: NASA EOSDIS GIBS / VIIRS NOAA-20',
        }).addTo(S.capas.luces);
        actualizarCuenta('luces', fecha);
      };
    });

    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = cfg.nota_procesado;
    cont.after(p);
  } catch (e) {
    cont.innerHTML = `<p class="hint err">No se pudo configurar la capa: ${escapar(e.message)}</p>`;
  }
}

// ── Panel: cortes confirmados por Cloudflare Radar (opcional) ───────────────

async function cargarRadarCF() {
  const cont = $('#radar-cf');
  if (!cont || Almacen.modo !== 'api') return;
  try {
    const d = await cargarJSON(`${Almacen.base}/cortes/radar?dias=7`);
    if (!d.disponible) {
      cont.innerHTML = `<p class="hint">Fuente opcional sin activar. ${escapar(d.motivo || '')}
        <br>${escapar(d.como_activar || '')}</p>`;
      return;
    }
    const cs = d.cortes_confirmados || [];
    cont.innerHTML = cs.length
      ? cs.map((o) => `<div class="leyenda-fila">
            <span>${escapar(o.descripcion || o.tipo || 'corte')}</span>
            <span style="margin-left:auto" class="hint">${fechaCorta(o.inicio)}</span>
          </div>`).join('')
      : '<p class="hint">Cloudflare no ha anotado cortes en Colombia en los últimos 7 días.</p>';
  } catch (e) {
    cont.innerHTML = `<p class="hint err">${escapar(e.message)}</p>`;
  }
}

// ── Capas: cortes de internet (IODA) y de energía (XM) ──────────────────────
//
// Ambas pasan por el backend: XM solo acepta POST y no manda CORS, y así queda
// una caché compartida en vez de una por pestaña. Sin backend, estas capas
// simplemente no se dibujan y se dice por qué.

async function cargarCortes() {
  S.capas.energia.clearLayers();
  $('#prioridad').innerHTML = '<p class="hint">Consultando IODA y XM…</p>';
  $('#energia-resumen').innerHTML = '';
  $('#cortes-nota').textContent = '';

  if (Almacen.modo !== 'api') {
    $('#prioridad').innerHTML =
      '<p class="hint">Estas capas necesitan el backend. Levanta ' +
      '<code>uvicorn backend.main:app --port 8000</code> y recarga.</p>';
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
    pintarPanelPrioridad(prio);
    if (energia) { pintarCapaEnergia(energia); pintarPanelEnergia(energia); }
    else { actualizarCuenta('energia', '—'); }
  } catch (e) {
    $('#prioridad').innerHTML =
      `<p class="hint err">No se pudieron leer las fuentes: ${escapar(e.message)}</p>`;
  }
}

// ── Iconos pedagógicos (SVG en línea, sin depender de fuentes externas) ────
// Mismo símbolo en el mapa y en la leyenda: el ícono base (wifi / rayo) dice
// DE QUÉ servicio se habla; encima va la señal universal de "prohibido" —
// círculo rojo con diagonal, el mismo lenguaje que "no fumar" — porque se
// entiende sin tener que descifrar arcos de wifi. El punto ciego usa círculo
// PUNTEADO en vez de sólido: no es un "no" confirmado, es "no sabemos".

function svgWifi(color, estado) {
  const debil = estado === 'corte' ? .3 : 1;
  const prohibido = estado === 'corte'
    ? `<circle cx="12" cy="12" r="10" fill="none" stroke="#ff3b30" stroke-width="2.4"/>
       <line x1="5.3" y1="18.7" x2="18.7" y2="5.3" stroke="#ff3b30" stroke-width="2.6" stroke-linecap="round"/>`
    : '';
  const duda = estado === 'duda'
    ? `<circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-width="1.8" stroke-dasharray="3 2.4"/>
       <text x="12" y="15.6" text-anchor="middle" font-size="10.5" font-weight="800" fill="${color}">?</text>`
    : '';
  return `<svg viewBox="0 0 24 24" width="100%" height="100%">
    <circle cx="12" cy="19" r="1.7" fill="${color}" opacity="${debil}"/>
    <path d="M7 15.2a7.3 7.3 0 0 1 10 0" fill="none" stroke="${color}" stroke-width="2.1"
          stroke-linecap="round" opacity="${debil}"/>
    <path d="M3.3 11a12.4 12.4 0 0 1 17.4 0" fill="none" stroke="${color}" stroke-width="2.1"
          stroke-linecap="round" opacity="${debil}"/>
    ${prohibido}${duda}
  </svg>`;
}

function svgRayoCorte(color) {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%">
    <path d="M13 2 5 14h5.5l-1 8L19 10h-5.5l-.5-8Z" fill="${color}" opacity=".35"/>
    <circle cx="12" cy="12" r="10" fill="none" stroke="#ff3b30" stroke-width="2.4"/>
    <line x1="5.3" y1="18.7" x2="18.7" y2="5.3" stroke="#ff3b30" stroke-width="2.6" stroke-linecap="round"/>
  </svg>`;
}




/* Las áreas de XM tampoco son un punto. «AREA SUROCCIDENTAL» es una porción de
   la topología eléctrica que cubre Valle, Cauca y Nariño enteros; dibujar un
   rayo en unas coordenadas inventadas decía «el apagón fue aquí», que es
   falso. Se pinta como la suma de los departamentos que cubre, con la
   advertencia de que el borde eléctrico no coincide con el político. */
async function pintarCapaEnergia(energia) {
  const limites = await cargarLimites();
  S.capas.energia.clearLayers();
  let n = 0;

  energia.areas.forEach((a) => {
    if (!a.pico_kwh) return;
    const formas = (a.codigos || []).map((c) => limites.get(c)).filter(Boolean);
    if (!formas.length) return;

    const ficha = `
      <h3>${escapar(a.area.replace('AREA ', 'Área '))}</h3>
      <dl>
        <dt>Pico sin entregar</dt><dd>${nf.format(Math.round(a.pico_kwh))} kWh</dd>
        <dt>Fecha del pico</dt><dd>${escapar(a.pico_fecha || 's/d')}</dd>
        <dt>Su día normal</dt><dd>${nf.format(Math.round(a.linea_base_kwh))} kWh</dd>
        <dt>Veces sobre lo normal</dt><dd>${a.veces_sobre_base ? '×' + a.veces_sobre_base : 's/d'}</dd>
      </dl>
      <div class="hint" style="margin-top:8px">Esta es un <b>área eléctrica</b> de
        XM, no una división política: su borde real no coincide con el de los
        departamentos que se ven pintados. El dato tampoco dice en qué municipio
        se fue la luz, ni si sigue sin ella — es de ${escapar(a.pico_fecha || 's/d')}.</div>`;

    L.geoJSON(formas, {
      style: {
        color: '#00d4ff', weight: 1.5, opacity: 0.8,
        dashArray: '3 4',            // borde punteado: el límite es aproximado
        fillColor: '#00d4ff', fillOpacity: 0.09,
      },
    }).bindTooltip(`<b>${escapar(a.area.replace('AREA ', 'Área '))}</b><br>` +
                   `${nf.format(Math.round(a.pico_kwh))} kWh sin entregar`,
                   { sticky: true })
      .bindPopup(ficha, { maxWidth: 320 })
      .addTo(S.capas.energia);
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
    // Ya no hay una capa propia que abrir: se enfoca el polígono del pulso,
    // que es la representación geográfica única del estado de internet.
    fila.onclick = () => {
      const capa = S.poligonos && S.poligonos.get(z.codigo);
      if (capa) S.mapa.fitBounds(capa.getBounds(), { padding: [30, 30] });
      verEventosCorte(z.codigo);
    };
    cont.appendChild(fila);
  });

  $('#cortes-nota').textContent =
    `Ventana de ${Math.round((prio.ventana.hasta - prio.ventana.desde) / 3600)} h. ` +
    'El score de IODA no tiene unidad: ordena zonas entre sí, no mide población.';

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
  // Si IODA cayó, la tabla sigue en pie con lo de XM, pero el orden ya no
  // significa lo mismo y hay que decirlo donde se está leyendo, no en la
  // consola: sin este aviso, un score 0 se leería como "aquí no pasa nada".
  if (prio.error_internet) {
    const e = document.createElement('p');
    e.className = 'hint err';
    e.textContent = 'IODA no respondió: ' + prio.error_internet +
      ' — el orden de esta lista NO incluye internet ahora mismo. Los ceros ' +
      'de score son falta de medición, no zonas sanas.';
    cont.appendChild(e);
  }
}

function pintarPanelEnergia(energia) {
  const top = energia.areas.filter((a) => a.pico_kwh > 0).slice(0, 3);

  // El rezago va arriba y en grande, no en letra chica al final. Quien mire
  // esta cifra tiene que saber, antes de leerla, que es de anteayer: XM
  // publica el registro contable del apagón, no su estado actual.
  const rez = energia.rezago_dias;
  const sello = rez === null || rez === undefined ? '' :
    `<div class="sello-rezago ${rez >= 2 ? 'viejo' : ''}">
       Dato del ${escapar(energia.ultimo_dato)} · ${rez} día${rez === 1 ? '' : 's'} de rezago
     </div>`;

  $('#energia-resumen').innerHTML = sello + (top.length
    ? '<div class="leyenda-titulo">Energía no entregada — pico</div>' +
      top.map((a) => `
        <div class="leyenda-fila">
          <span>${escapar(a.area.replace('AREA ', ''))}</span>
          <span style="margin-left:auto;font-variant-numeric:tabular-nums">
            ${nf.format(Math.round(a.pico_kwh))} kWh
            ${a.veces_sobre_base ? `<b style="color:var(--critica)">×${a.veces_sobre_base}</b>` : ''}
          </span>
        </div>`).join('')
    : '<p class="hint">XM no reporta energía no entregada en esta ventana.</p>');

  $('#energia-rezago').textContent =
    `${energia.fuente} · ${energia.metrica}. ${energia.nota_rezago || ''} ${energia.nota_mapeo}`;
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

  // Se pide la llave ANTES de intentar guardar: si se pidiera al fallar, ya se
  // habría perdido lo escrito en el formulario.
  if (Almacen.modo === 'api' && !(await Llave.asegurar())) {
    toast('Hace falta la llave de coordinación para guardar.', true);
    return;
  }

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
  if (Almacen.modo === 'api' && !(await Llave.asegurar())) {
    toast('Hace falta la llave de coordinación para eliminar.', true);
    return;
  }
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
    if (Almacen.modo === 'api' && !(await Llave.asegurar())) {
      toast('Hace falta la llave de coordinación para importar.', true);
      return;
    }
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
  $('#f-pulso').onchange = () => { cargarPulso(); cargarOperadores(); };

  $('#btn-parte-copiar').onclick = copiarParte;
  $('#btn-parte-ver').onclick = async () => {
    const b = $('#btn-parte-ver');
    b.disabled = true;
    b.textContent = 'Preparando…';
    try {
      $('#parte-texto').value = await generarParte();
      $('#parte-ayuda').textContent = 'Después de copiarlo, ábrelo en WhatsApp, ' +
        'Telegram o el correo y pégalo donde lo necesites.';
      $('#parte-ayuda').classList.remove('destacado');
      $('#modal-parte').hidden = false;
    } catch (e) {
      toast('No se pudo preparar el informe: ' + e.message, true);
    } finally {
      b.disabled = false;
      b.textContent = 'Preparar informe para compartir';
    }
  };

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
    ['impacto',    'Danos reportados (prensa)','#c92a2a'],
    ['mancha',     'Fuerza del sismo (USGS)',  '#ff9100'],
    ['pulso',      'Sin internet (por zona)',  '#e03131'],
    ['ciegos',     'Puntos ciegos (sin medir)','#9c36b5'],
    ['luzMun',     'Sin luz (por poblado)',    '#f59f00'],
    ['luces',      'Luces nocturnas (VIIRS)',  '#ffd60a'],
    ['zonas',      'Zonas reportadas',         '#ff3b30'],
    ['aportes',    'Recursos ofrecidos',       '#34c759'],
    ['reportes',   'Apuntes internos',         '#4da3ff'],
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

  // Los iconos del mapa, primeros y con el mismo dibujo exacto que se ve allí.
  // Una leyenda que redibuja el símbolo «parecido» no sirve para consultarla.
  const hEs = document.createElement('div');
  hEs.className = 'leyenda-titulo';
  hEs.textContent = 'Iconos del mapa';
  cont.appendChild(hEs);
  [
    ['luz', 'sin',  'Sin luz — el pueblo perdió buena parte de su luz nocturna'],
    ['luz', 'poca', 'Poca luz — perdió una parte, apagón parcial o por sectores'],
    ['red', 'sin',  'Sin internet — la zona está muy por debajo de su normal'],
    ['red', 'poca', 'Poco internet — algo por debajo de su normal'],
    ['red', 'duda', 'No se sabe — no hay suficiente red o luz que medir aquí'],
  ].forEach(([tipo, nivel, txt]) => {
    const d = document.createElement('div');
    d.className = 'leyenda-fila';
    d.innerHTML = `<span class="muestra glifo">${iconoEstado(tipo, nivel, 22)}</span>` +
                  `<span>${txt}</span>`;
    cont.appendChild(d);
  });

  const hIn = document.createElement('div');
  hIn.className = 'leyenda-titulo';
  hIn.textContent = 'Clases del score acumulado (panel de datos técnicos)';
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

/* ── Llave de coordinación ─────────────────────────────────────────────────
   La capa de apuntes internos es de quien organiza la respuesta. Leerla es
   abierto; escribirla no puede serlo con el servicio en internet, porque un
   DELETE sin llave borra el trabajo de alguien en plena emergencia.

   La llave vive solo en este navegador. No viaja a Supabase ni se comparte con
   la capa pública de zonas y aportes, que tiene su propio control (RLS). */

const CLAVE_TOKEN = 'hope.token.v1';

const Llave = {
  leer() {
    try { return localStorage.getItem(CLAVE_TOKEN) || ''; } catch (_) { return ''; }
  },
  guardar(v) {
    try { v ? localStorage.setItem(CLAVE_TOKEN, v) : localStorage.removeItem(CLAVE_TOKEN); }
    catch (_) {}
    pintarEstadoLlave();
  },
  /** Se pide antes de escribir, no después: si se pidiera al fallar, la persona
   *  ya habría perdido lo que escribió en el formulario. */
  async asegurar() {
    if (!S.escrituraConToken || this.leer()) return true;
    const v = prompt(
      'Llave de coordinación\n\n' +
      'Este servidor exige una llave para crear, editar o borrar apuntes ' +
      'internos. Es la variable HOPE_TOKEN del servidor.\n\n' +
      'Se guarda solo en este navegador.');
    if (!v) return false;
    this.guardar(v.trim());
    return true;
  },
};

/** Pregunta al backend si exige llave para escribir. Sin backend no aplica:
 *  todo se guarda en este navegador y no hay nada que proteger de terceros. */
async function cargarConfigEscritura() {
  S.escrituraConToken = false;
  if (Almacen.modo === 'api') {
    try {
      const cfg = await cargarJSON(`${Almacen.base}/config`);
      S.escrituraConToken = !!cfg.escritura_con_token;
    } catch (_) { /* si no responde, se asume abierto y el 401 lo corregirá */ }
  }
  pintarEstadoLlave();
}

function pintarEstadoLlave() {
  const el = $('#estado-llave');
  if (!el) return;
  if (!S.escrituraConToken) {
    el.innerHTML = '<span class="hint">Este servidor no exige llave para escribir.</span>';
    return;
  }
  const hay = !!Llave.leer();
  el.innerHTML = hay
    ? '<span class="llave-ok">🔑 Llave guardada en este navegador.</span> ' +
      '<button type="button" id="btn-llave-borrar" class="btn-enlace">Borrarla</button>'
    : '<span class="llave-falta">🔒 Sin llave: solo lectura.</span> ' +
      '<button type="button" id="btn-llave-poner" class="btn-enlace">Poner llave</button>';
  const b = $('#btn-llave-borrar');
  if (b) b.onclick = () => { Llave.guardar(''); toast('Llave borrada de este navegador.'); };
  const p = $('#btn-llave-poner');
  if (p) p.onclick = () => Llave.asegurar();
}

async function pedir(url, metodo, cuerpo) {
  const cabeceras = cuerpo ? { 'Content-Type': 'application/json' } : {};
  const llave = Llave.leer();
  if (llave && metodo && metodo !== 'GET') cabeceras['X-HOPE-Token'] = llave;

  const r = await fetch(url, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (!r.ok) {
    let det = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j.detail) det = JSON.stringify(j.detail); } catch (_) {}
    // 401 con llave puesta = la llave está mal. Se borra para que el siguiente
    // intento la vuelva a pedir en vez de repetir el mismo fallo en silencio.
    if (r.status === 401 && llave) {
      Llave.guardar('');
      throw new Error('La llave de coordinación no es válida. Vuelve a intentarlo.');
    }
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
