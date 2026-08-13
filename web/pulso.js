/* ===========================================================================
   HOPE — pulso de red calculado EN EL NAVEGADOR, sin backend.
   ---------------------------------------------------------------------------
   Por qué existe este archivo:

   En una emergencia, la distancia entre "tengo una herramienta" y "alguien la
   está usando" es la instalación. Si para ver el estado de la red hay que
   clonar un repo, instalar Python y levantar uvicorn, no la va a abrir nadie
   desde un celular a las 3 de la mañana.

   IODA manda CORS abierto (verificado: devuelve Access-Control-Allow-Origin con
   el origen que se le mande). Así que el navegador puede pedirle las series
   directamente y hacer la misma cuenta que hace el backend. Con eso, HOPE
   funciona subido a cualquier hosting estático —GitHub Pages, Netlify, un USB—
   y se comparte con un link.

   Lo que NO puede hacer este modo, y hay que decirlo en pantalla:
     · XM no manda CORS. Sin backend no hay capa de energía.
     · Cloudflare Radar necesita una llave que no puede ir en el navegador.
     · Cada pestaña consulta por su cuenta: no hay caché compartida.

   ── Aviso de mantenimiento ────────────────────────────────────────────────
   Los umbrales y las clases de aquí tienen que coincidir con los de
   `backend/fuentes.py` (`_diagnosticar`, `MUESTRA_MINIMA`, `RANGO_CLASE`).
   Son dos implementaciones de la misma regla, en dos lenguajes. Si se cambia
   una, hay que cambiar la otra o el mismo departamento saldrá clasificado
   distinto según haya backend o no, que es peor que no tener el modo.
   =========================================================================== */

'use strict';

const IODA_BASE = 'https://api.ioda.inetintel.cc.gatech.edu/v2';

const PULSO_ACCESO = 'ping-slash24';   // última milla
const PULSO_TRONCAL = 'bgp';           // troncal / anuncios de ruta
const SEMANA_S = 7 * 24 * 3600;
const MUESTRA_MINIMA = 60;             // == fuentes.MUESTRA_MINIMA

// Departamentos con daño reportado. Mismo conjunto que fuentes.AFECTADOS_SISMO.
const DEPTOS_SISMO = [
  { codigo: 745, nombre: 'Chocó',           lat: 5.75, lon: -76.85 },
  { codigo: 741, nombre: 'Valle del Cauca', lat: 3.80, lon: -76.50 },
  { codigo: 734, nombre: 'Risaralda',       lat: 5.15, lon: -75.90 },
  { codigo: 730, nombre: 'Caldas',          lat: 5.30, lon: -75.30 },
  { codigo: 733, nombre: 'Quindío',         lat: 4.45, lon: -75.68 },
  { codigo: 737, nombre: 'Cauca',           lat: 2.50, lon: -76.80 },
  { codigo: 739, nombre: 'Nariño',          lat: 1.50, lon: -77.90 },
  { codigo: 735, nombre: 'Tolima',          lat: 4.10, lon: -75.20 },
];

const OPERADORES_JS = [
  [10620, 'Claro / Telmex'],
  [13489, 'Tigo-UNE / EPM Telecomunicaciones'],
  [3816,  'Movistar / Colombia Telecomunicaciones'],
  [19429, 'ETB'],
  [14593, 'Starlink (SpaceX)'],
];

const RANGO_CLASE_JS = {
  troncal_caido: 0, ultima_milla_caida: 1, troncal_degradado: 2,
  ultima_milla_degradada: 3, muestra_chica: 4, degradacion_leve: 5,
  recuperando: 6, normal: 7, sin_medicion: 8,
};

const INTENTOS_IODA = 3;      // == fuentes.INTENTOS_HTTP
const ESPERA_REINTENTO_MS = 800;

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function iodaSerie(tipo, codigo, desde, hasta, ds) {
  const u = `${IODA_BASE}/signals/raw/${tipo}/${codigo}` +
            `?from=${desde}&until=${hasta}&datasource=${ds}`;
  // Con reintentos: un tropiezo de red de un segundo no puede pintar la zona
  // como «sin datos». Desde un celular con la red a medias —que es justo
  // quien abre esto— el primer intento falla a menudo y el segundo pasa.
  let ultimo;
  let r;
  for (let n = 0; n < INTENTOS_IODA; n++) {
    try {
      r = await fetch(u);
      if (r.ok) break;
      ultimo = new Error(`IODA ${r.status}`);
      r = null;
    } catch (e) {
      ultimo = e;
      r = null;
    }
    if (n < INTENTOS_IODA - 1) await dormir(ESPERA_REINTENTO_MS * (2 ** n));
  }
  if (!r) throw ultimo || new Error('IODA no respondió');
  const j = await r.json();
  let d = j.data || [];
  if (d.length && Array.isArray(d[0])) d = d[0];
  const s = d[0];
  // Se descartan los null del final: IODA publica con minutos de retraso y ese
  // hueco es "todavía no llegó", no "cayó a cero". Contarlo como cero
  // inventaría un apagón.
  return s ? (s.values || []).filter((v) => typeof v === 'number') : [];
}

const media = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function tendenciaJS(serie) {
  const s = serie.filter((v) => typeof v === 'number');
  if (s.length < 6) return 'sin_datos';
  const n = Math.floor(s.length / 3);
  const ini = media(s.slice(0, n)), fin = media(s.slice(-n));
  if (!ini) return 'sin_datos';
  const c = (fin - ini) / ini * 100;
  return c <= -5 ? 'empeorando' : c >= 5 ? 'mejorando' : 'estable';
}

/** Espejo exacto de `fuentes._diagnosticar`. Ver aviso de mantenimiento arriba. */
function diagnosticarJS(dAcceso, dTroncal, baseAcceso, tipo) {
  if (dAcceso === null) {
    return ['sin_medicion',
      'IODA no está devolviendo datos para esta zona en esta ventana.',
      'No se puede concluir nada. Confirmar por radio o en terreno.'];
  }
  if (baseAcceso < MUESTRA_MINIMA) {
    return ['muestra_chica',
      `Solo hay ~${baseAcceso.toFixed(0)} bloques de red medibles aquí. Un cambio ` +
      `de pocos bloques ya mueve el porcentaje, así que el ${dAcceso.toFixed(1)}% ` +
      'no es concluyente.',
      tipo === 'region'
        ? 'Zona con poca infraestructura que medir. Es candidata a enlace satelital ' +
          'por definición: aquí no hay red que restaurar, hay red que llevar.'
        : 'Operador con poca presencia medible. Su curva no sirve para concluir nada.'];
  }
  const troncalCayo = dTroncal !== null && dTroncal <= -3;

  if (dAcceso <= -50) {
    return troncalCayo
      ? ['troncal_caido',
         `Corte mayor: el acceso cayó ${dAcceso.toFixed(1)}% y el troncal ` +
         `${dTroncal.toFixed(1)}%. El operador retiró rutas de la tabla global.`,
         'Corte de red, no de energía. Requiere cuadrilla del operador o enlace ' +
         'satelital para restablecer servicio.']
      : ['ultima_milla_caida',
         `El acceso cayó ${dAcceso.toFixed(1)}% pero el troncal sigue en pie. La ` +
         'fibra está sana; lo que no responde son los equipos del usuario.',
         'Firma de apagón: sin energía no hay router aunque el cable esté bueno. ' +
         'Aquí hace falta ENERGÍA (planta, combustible), no fibra.'];
  }
  if (dAcceso <= -20) {
    return troncalCayo
      ? ['troncal_degradado',
         `Acceso ${dAcceso.toFixed(1)}% y troncal ${dTroncal.toFixed(1)}% por debajo ` +
         'de lo normal. Degradación que ya toca el enrutamiento.',
         'Vigilar de cerca: si el troncal sigue bajando es corte de red en curso.']
      : ['ultima_milla_degradada',
         `El acceso está ${dAcceso.toFixed(1)}% por debajo de su normal, con el ` +
         'troncal intacto.',
         'Compatible con cortes de energía parciales o intermitentes. Contrastar ' +
         'con reportes en terreno.'];
  }
  if (dAcceso <= -8) {
    return ['degradacion_leve',
      `Acceso ${dAcceso.toFixed(1)}% bajo su línea base. Está dentro de lo que puede ` +
      'ser variación normal de un día a otro.',
      'No es concluyente por sí solo. Sirve como tendencia si sigue bajando.'];
  }
  if (dAcceso >= 8) {
    return ['recuperando',
      `El acceso está +${dAcceso.toFixed(1)}% por ENCIMA de su línea base: hay más ` +
      'red respondiendo que hace una semana.',
      'Señal de restablecimiento.'];
  }
  return ['normal',
    `Acceso en su nivel habitual (${dAcceso > 0 ? '+' : ''}${dAcceso.toFixed(1)}% ` +
    'contra hace 7 días).',
    'Sin evidencia instrumental de corte. No descarta problemas locales que estas ' +
    'fuentes no alcanzan a ver.'];
}

async function pulsoEntidadJS(tipo, codigo, nombre, horas) {
  const hasta = Math.floor(Date.now() / 1000);
  const desde = hasta - horas * 3600;

  const [accHoy, accBase, troHoy, troBase] = await Promise.all([
    iodaSerie(tipo, codigo, desde, hasta, PULSO_ACCESO),
    iodaSerie(tipo, codigo, desde - SEMANA_S, hasta - SEMANA_S, PULSO_ACCESO),
    iodaSerie(tipo, codigo, desde, hasta, PULSO_TRONCAL),
    iodaSerie(tipo, codigo, desde - SEMANA_S, hasta - SEMANA_S, PULSO_TRONCAL),
  ]);

  const delta = (hoy, base) => {
    const a = media(hoy), b = media(base);
    if (a === null || !b) return null;
    return Math.round((a - b) / b * 1000) / 10;
  };

  const dAcc = delta(accHoy, accBase);
  const dTro = delta(troHoy, troBase);
  const baseAcc = media(accBase) || 0;
  const [clase, diagnostico, accion] = diagnosticarJS(dAcc, dTro, baseAcc, tipo);

  return {
    tipo, codigo, nombre,
    tendencia: tendenciaJS(accHoy),
    acceso: {
      ahora: Math.round((media(accHoy) || 0) * 10) / 10,
      linea_base: Math.round(baseAcc * 10) / 10,
      delta_pct: dAcc, serie: accHoy.slice(-72),
      muestra_suficiente: baseAcc >= MUESTRA_MINIMA,
    },
    troncal: {
      ahora: Math.round((media(troHoy) || 0) * 10) / 10,
      linea_base: Math.round((media(troBase) || 0) * 10) / 10,
      delta_pct: dTro, serie: troHoy.slice(-72),
    },
    clase, diagnostico, accion,
  };
}

/** Mismo contrato de salida que `GET /api/cortes/vivo`, para que el resto del
 *  frontend no tenga que saber en qué modo está. */
async function pulsoVivoNavegador(horas = 3) {
  const zonas = await Promise.all(DEPTOS_SISMO.map(async (d) => {
    try {
      const z = await pulsoEntidadJS('region', d.codigo, d.nombre, horas);
      return { ...z, lat: d.lat, lon: d.lon };
    } catch (e) {
      return {
        tipo: 'region', codigo: d.codigo, nombre: d.nombre, lat: d.lat, lon: d.lon,
        clase: 'sin_medicion', diagnostico: `IODA no respondió: ${e.message}`,
        accion: 'Reintentar. No concluir nada de este vacío.',
        acceso: {}, troncal: {},
      };
    }
  }));

  zonas.sort((a, b) =>
    (RANGO_CLASE_JS[a.clase] ?? 9) - (RANGO_CLASE_JS[b.clase] ?? 9) ||
    ((a.acceso || {}).delta_pct || 0) - ((b.acceso || {}).delta_pct || 0));

  const conCorte = zonas.filter((z) => ['troncal_caido', 'ultima_milla_caida',
    'troncal_degradado', 'ultima_milla_degradada'].includes(z.clase));

  // Medidas y sin medir van por separado. Ver la nota en `fuentes.pulso_vivo`:
  // sumarlas producía el titular «las 8 zonas están como un día normal» encima
  // de ocho tarjetas que decían «no hay datos».
  const medidas = zonas.filter((z) => z.clase !== 'sin_medicion');

  return {
    fuente: 'IODA /signals/raw — consultado directo desde el navegador',
    consultado: new Date().toISOString(),
    ventana_horas: horas,
    comparado_contra: 'la misma ventana horaria de hace 7 días',
    sin_backend: true,
    resumen: {
      zonas_medidas: medidas.length,
      zonas_sin_medir: zonas.length - medidas.length,
      zonas_totales: zonas.length,
      con_degradacion: conCorte.length,
      firma_de_apagon: conCorte.filter((z) => z.clase.startsWith('ultima_milla')).length,
    },
    zonas,
  };
}

async function pulsoOperadoresNavegador(horas = 3) {
  const ops = await Promise.all(OPERADORES_JS.map(async ([asn, nombre]) => {
    try {
      return await pulsoEntidadJS('asn', asn, nombre, horas);
    } catch (e) {
      return { tipo: 'asn', codigo: asn, nombre, clase: 'sin_medicion',
               diagnostico: `IODA no respondió: ${e.message}`, acceso: {}, troncal: {} };
    }
  }));
  ops.sort((a, b) =>
    (RANGO_CLASE_JS[a.clase] ?? 9) - (RANGO_CLASE_JS[b.clase] ?? 9) ||
    ((a.acceso || {}).delta_pct || 0) - ((b.acceso || {}).delta_pct || 0));

  return {
    fuente: 'IODA /signals/raw por ASN (directo desde el navegador)',
    consultado: new Date().toISOString(),
    ventana_horas: horas,
    nota: 'Los ASN son nacionales: un operador degradado aquí no dice en qué ' +
          'departamento está degradado. Cruzar con la vista por zona.',
    operadores: ops,
  };
}
