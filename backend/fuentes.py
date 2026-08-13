"""
HOPE — conectores a fuentes REALES de cortes de internet y energía.

Ninguna función de este módulo inventa, simula ni interpola datos. Si una fuente
no responde, se devuelve el error; no se rellena con estimaciones.

El módulo tiene dos mitades con propósitos distintos, y confundirlas es el error
más fácil de cometer:

  · Las funciones de ACUMULADO (`ioda_resumen`, `ioda_eventos`, `xm_no_atendida`,
    `prioridad_enlaces`) miran hacia atrás. Resumen días. Sirven para saber qué
    zona lleva más horas de corte, no cómo está ahora.

  · Las funciones de PULSO (`pulso_vivo`, `pulso_operadores`, `luces_nocturnas`)
    miran el presente, con series que se actualizan cada 5-10 minutos. Son la
    vista principal del sistema. Ver el bloque grande más abajo.

Catálogo completo de endpoints, ejemplos de llamada y límites: FUENTES.md.

Fuentes (públicas y sin llave salvo donde se indique, verificadas el 2026-08-13):

  IODA — Internet Outage Detection and Analysis, Georgia Tech.
    https://api.ioda.inetintel.cc.gatech.edu/v2/
    Mide alcanzabilidad de internet por tres métodos independientes:
      · bgp          — anuncios de rutas que desaparecen de la tabla global
      · ping-slash24 — sondeo activo a bloques /24
      · merit-nt     — telescopio de red (tráfico de fondo que deja de llegar)
    Granularidad máxima en Colombia: DEPARTAMENTO. No hay municipios.

  XM — operador del Sistema Interconectado Nacional colombiano.
    https://servapibi.xm.com.co/
    Métrica DemaNoAtenNoProg = energía que se debió entregar y no se entregó,
    por área operativa, en kWh/día. Un apagón deja rastro aquí.
    Rezago observado: ~1 día.

  USGS — catálogo sísmico global, ventana rodante sobre Colombia.
    https://earthquake.usgs.gov/fdsnws/event/1/query
    Detecta sismos nuevos, no solo réplicas del evento del 10 de agosto.

  Open-Meteo — pronóstico meteorológico abierto.
    https://api.open-meteo.com/v1/forecast
    Precipitación en los departamentos con daño reportado: lluvia intensa
    complica el acceso vial a zonas ya golpeadas por el sismo.

  RIPE Atlas — red de sondas voluntarias con coordenadas reales.
    https://atlas.ripe.net/api/v2/probes/
    A diferencia de IODA (que agrega por departamento), cada sonda es UN PUNTO
    FÍSICO verificable con su propio estado de conexión. Son decenas de puntos
    en todo el país, no un censo: ausencia de sonda no es ausencia de problema,
    solo ausencia de medición ahí.

  NASA GIBS / VIIRS — luces nocturnas, teselas WMTS sin llave.
    https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/
    Lo único que ve energía a escala de PUEBLO (~500 m) sin esperar el rezago de
    XM. El satélite pasa hacia la 1:30 a.m. Limitado por nubes, y el Chocó es de
    las zonas más nubladas del planeta.

  Cloudflare Radar — OPCIONAL, requiere llave gratuita.
    https://api.cloudflare.com/client/v4/radar
    La fuente más rápida que existe y la única con cortes confirmados a mano.
    Si no está CLOUDFLARE_API_TOKEN, el sistema sigue y lo dice.

Advertencia de interpretación, importante:
  Una señal DÉBIL de corte no significa "esa zona está bien". Puede significar
  que allí casi no hay infraestructura que medir. Chocó es el caso exacto: es el
  epicentro y su score IODA es 58, dos órdenes de magnitud por debajo de Valle
  del Cauca, porque hay muy poca conectividad de base. Ahí es donde un enlace
  satelital aporta más, no menos. Ver `interpretar_cobertura()`.
"""

from __future__ import annotations

import io
import json
import math
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

IODA = "https://api.ioda.inetintel.cc.gatech.edu/v2"
XM = "https://servapibi.xm.com.co"
TIEMPO_ESPERA = 45
CACHE_SEG = 600          # 10 min: suficiente para no martillar, poco para servir rancio
CACHE_PULSO_SEG = 120    # el pulso en vivo va más corto: IODA publica cada 5-10 min

INTENTOS_HTTP = 3        # un tropiezo de red no puede vaciar el panel
ESPERA_REINTENTO = 0.8   # segundos; se duplica en cada reintento
TIEMPO_IODA = 12         # las series del pulso son chicas: si tardan más, algo pasa

# Si IODA se cae del todo, se sirve la última medición buena hasta esta edad,
# rotulada con su hora. Un dato de hace dos horas dice mucho más que un panel
# en blanco: la red no cambia de estado cada minuto, y quien está coordinando
# necesita saber qué se sabía, no que le apaguen la pantalla.
CACHE_RANCIO_SEG = 6 * 3600

# ── Departamentos: código IODA → nombre y centroide real ────────────────────
# Los códigos salen de /v2/entities/query?entityType=region&relatedTo=country/CO
DEPARTAMENTOS: dict[int, dict[str, Any]] = {
    723: {"nombre": "Amazonas",                 "lat": -2.00, "lon": -71.50},
    724: {"nombre": "Antioquia",                "lat":  6.55, "lon": -75.50},
    725: {"nombre": "Boyacá",                   "lat":  5.60, "lon": -73.20},
    726: {"nombre": "Córdoba",                  "lat":  8.40, "lon": -75.90},
    727: {"nombre": "Santander",                "lat":  6.80, "lon": -73.30},
    728: {"nombre": "La Guajira",               "lat": 11.40, "lon": -72.60},
    729: {"nombre": "San Andrés y Providencia", "lat": 12.55, "lon": -81.72},
    730: {"nombre": "Caldas",                   "lat":  5.30, "lon": -75.30},
    731: {"nombre": "Cundinamarca",             "lat":  4.90, "lon": -74.30},
    732: {"nombre": "Bogotá",                   "lat":  4.65, "lon": -74.10},
    733: {"nombre": "Quindío",                  "lat":  4.45, "lon": -75.68},
    734: {"nombre": "Risaralda",                "lat":  5.15, "lon": -75.90},
    735: {"nombre": "Tolima",                   "lat":  4.10, "lon": -75.20},
    736: {"nombre": "Caquetá",                  "lat":  0.90, "lon": -74.20},
    737: {"nombre": "Cauca",                    "lat":  2.50, "lon": -76.80},
    738: {"nombre": "Huila",                    "lat":  2.60, "lon": -75.60},
    739: {"nombre": "Nariño",                   "lat":  1.50, "lon": -77.90},
    740: {"nombre": "Putumayo",                 "lat":  0.50, "lon": -76.30},
    741: {"nombre": "Valle del Cauca",          "lat":  3.80, "lon": -76.50},
    742: {"nombre": "Atlántico",                "lat": 10.75, "lon": -74.90},
    743: {"nombre": "Bolívar",                  "lat":  8.80, "lon": -74.30},
    744: {"nombre": "Cesar",                    "lat":  9.60, "lon": -73.60},
    745: {"nombre": "Chocó",                    "lat":  5.75, "lon": -76.85},
    746: {"nombre": "Magdalena",                "lat": 10.20, "lon": -74.30},
    747: {"nombre": "Sucre",                    "lat":  9.00, "lon": -75.10},
    748: {"nombre": "Arauca",                   "lat":  6.90, "lon": -70.90},
    749: {"nombre": "Norte de Santander",       "lat":  8.00, "lon": -72.90},
    750: {"nombre": "Casanare",                 "lat":  5.40, "lon": -71.60},
    751: {"nombre": "Guaviare",                 "lat":  1.80, "lon": -72.60},
    752: {"nombre": "Guainía",                  "lat":  2.60, "lon": -69.00},
    753: {"nombre": "Meta",                     "lat":  3.50, "lon": -73.00},
    754: {"nombre": "Vaupés",                   "lat":  0.50, "lon": -70.50},
    755: {"nombre": "Vichada",                  "lat":  4.80, "lon": -69.50},
}

# Departamentos con daño estructural reportado por el sismo. Se usa para no
# perder de vista una zona solo porque su señal instrumental sea baja.
AFECTADOS_SISMO = {745, 741, 734, 730, 733, 737, 739, 735}

# ── Áreas operativas de XM → departamentos ──────────────────────────────────
# APROXIMADO. Las áreas de XM son operativas (topología eléctrica), no
# político-administrativas, y no coinciden exactamente con departamentos.
# Sirve para ubicar el dato en el mapa, no para atribuir un corte a un municipio.
AREAS_XM: dict[str, dict[str, Any]] = {
    "AREA SUROCCIDENTAL": {"deptos": [741, 737, 739], "lat": 3.20, "lon": -76.70},
    "AREA ANTIOQUIA":     {"deptos": [724, 745],      "lat": 6.40, "lon": -75.60},
    "AREA CARIBE":        {"deptos": [742, 743, 744, 726, 728, 746, 747],
                           "lat": 10.20, "lon": -74.50},
    "AREA NORDESTE":      {"deptos": [727, 749, 748, 725], "lat": 7.20, "lon": -73.00},
    "AREA ORIENTAL":      {"deptos": [731, 732, 753, 735, 738, 750],
                           "lat": 4.40, "lon": -74.00},
    "AREA CQR":           {"deptos": [730, 733, 734], "lat": 4.95, "lon": -75.65},
}


# ── Caché en SQLite ─────────────────────────────────────────────────────────

_BD: Optional[str] = None


def configurar_cache(ruta_bd: str) -> None:
    global _BD
    _BD = ruta_bd
    with sqlite3.connect(_BD) as con:
        con.execute("CREATE TABLE IF NOT EXISTS cache_fuentes ("
                    "clave TEXT PRIMARY KEY, cuerpo TEXT NOT NULL, ts REAL NOT NULL)")


def _cache_leer(clave: str, ttl: int = CACHE_SEG) -> Optional[Any]:
    if not _BD:
        return None
    try:
        with sqlite3.connect(_BD) as con:
            f = con.execute("SELECT cuerpo, ts FROM cache_fuentes WHERE clave = ?",
                            (clave,)).fetchone()
        if f and (time.time() - f[1]) < ttl:
            return json.loads(f[0])
    except Exception:
        pass
    return None


def _cache_guardar(clave: str, valor: Any) -> None:
    if not _BD:
        return
    try:
        with sqlite3.connect(_BD) as con:
            con.execute("INSERT OR REPLACE INTO cache_fuentes VALUES (?,?,?)",
                        (clave, json.dumps(valor), time.time()))
    except Exception:
        pass


# ── HTTP ────────────────────────────────────────────────────────────────────

def _get(url: str, intentos: int = INTENTOS_HTTP, tiempo: int = 0) -> Any:
    """GET con reintentos.

    Un fallo aislado de red no puede vaciar el panel. Desde el contenedor de
    Railway hacia IODA se ven cortes esporádicos (timeout, 502, TLS a medias)
    que en el reintento siguiente pasan. Sin esto, un tropiezo de un segundo
    pinta las ocho zonas como «no hay datos», que es la peor mentira posible:
    parece que el país se apagó cuando lo que falló fue nuestra propia consulta.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "HOPE/0.2 (respuesta sismo Chocó)"})
    ultimo: Exception | None = None
    for n in range(intentos):
        try:
            with urllib.request.urlopen(req, timeout=tiempo or TIEMPO_ESPERA) as r:
                return json.loads(r.read().decode())
        except Exception as e:               # noqa: BLE001 — se reintenta cualquier fallo
            ultimo = e
            if n < intentos - 1:
                time.sleep(ESPERA_REINTENTO * (2 ** n))
    raise ultimo if ultimo else RuntimeError(f"sin respuesta de {url}")


def _post(url: str, cuerpo: dict) -> Any:
    req = urllib.request.Request(
        url, data=json.dumps(cuerpo).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "HOPE/0.2 (respuesta sismo Chocó)"})
    with urllib.request.urlopen(req, timeout=TIEMPO_ESPERA * 2) as r:
        return json.loads(r.read().decode())


def _desanidar(respuesta: dict) -> list:
    """IODA envuelve resultados en data[0] cuando la consulta es de un solo tipo."""
    d = respuesta.get("data") or []
    if d and isinstance(d[0], list):
        return d[0]
    return d


# ── IODA ────────────────────────────────────────────────────────────────────

def ioda_resumen(desde: int, hasta: int) -> dict:
    """Score agregado de corte de internet por departamento colombiano.

    El score de IODA no tiene unidad física: combina cuánto cayó la señal, por
    cuánto tiempo y en cuántas fuentes independientes. Sirve para ORDENAR
    zonas entre sí, no para decir "X% de la gente está sin internet".
    """
    clave = f"ioda_resumen:{desde}:{hasta}"
    if (c := _cache_leer(clave)) is not None:
        return c

    filas = _desanidar(_get(f"{IODA}/outages/summary?entityType=region"
                            f"&relatedTo=country/CO&from={desde}&until={hasta}"))
    salida = []
    for f in filas:
        ent = f.get("entity", {}) or {}
        try:
            codigo = int(ent.get("code"))
        except (TypeError, ValueError):
            continue
        meta = DEPARTAMENTOS.get(codigo)
        if not meta:
            continue
        salida.append({
            "codigo": codigo,
            "nombre": meta["nombre"],
            "lat": meta["lat"],
            "lon": meta["lon"],
            "score": f.get("scores", {}).get("overall") or 0,
            "eventos": f.get("event_cnt") or 0,
            "afectado_sismo": codigo in AFECTADOS_SISMO,
        })

    # Departamentos golpeados por el sismo que IODA no reportó: se incluyen con
    # score 0 explícito. Ausencia de señal no es ausencia de problema.
    vistos = {d["codigo"] for d in salida}
    for codigo in AFECTADOS_SISMO - vistos:
        meta = DEPARTAMENTOS[codigo]
        salida.append({"codigo": codigo, "nombre": meta["nombre"], "lat": meta["lat"],
                       "lon": meta["lon"], "score": 0, "eventos": 0,
                       "afectado_sismo": True})

    salida.sort(key=lambda x: -x["score"])
    res = {"fuente": "IODA (Georgia Tech)", "desde": desde, "hasta": hasta,
           "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "departamentos": salida}
    _cache_guardar(clave, res)
    return res


def ioda_eventos(codigo: int, desde: int, hasta: int) -> dict:
    """Eventos de corte con marca de tiempo real, para un departamento."""
    clave = f"ioda_eventos:{codigo}:{desde}:{hasta}"
    if (c := _cache_leer(clave)) is not None:
        return c

    crudos = _desanidar(_get(f"{IODA}/outages/events?entityType=region"
                             f"&entityCode={codigo}&from={desde}&until={hasta}"))
    eventos = []
    for e in crudos:
        inicio = e.get("start")
        dur = e.get("duration") or 0
        eventos.append({
            "inicio": inicio,
            "inicio_iso": (datetime.fromtimestamp(inicio, timezone.utc).isoformat()
                           if inicio else None),
            "duracion_s": dur,
            "duracion_h": round(dur / 3600, 1),
            "score": e.get("score") or 0,
            "fuente_medicion": e.get("datasource"),
            "metodo": e.get("method"),
        })
    eventos.sort(key=lambda x: -(x["score"] or 0))
    meta = DEPARTAMENTOS.get(codigo, {})
    res = {"codigo": codigo, "nombre": meta.get("nombre", str(codigo)),
           "eventos": eventos, "total": len(eventos)}
    _cache_guardar(clave, res)
    return res


# ── XM ──────────────────────────────────────────────────────────────────────

def xm_no_atendida(desde: date, hasta: date) -> dict:
    """Energía que se debió entregar y no se entregó, por área operativa (kWh/día).

    Se devuelven las dos métricas por separado porque significan cosas distintas:
      · no_programada — falla. Es la que indica apagón por daño.
      · programada    — racionamiento o mantenimiento planeado. No es emergencia.
    """
    clave = f"xm_noaten:{desde}:{hasta}"
    if (c := _cache_leer(clave)) is not None:
        return c

    def traer(metrica: str) -> dict[str, dict[str, float]]:
        r = _post(f"{XM}/daily", {"MetricId": metrica, "Entity": "Area",
                                  "StartDate": desde.isoformat(),
                                  "EndDate": hasta.isoformat()})
        por_fecha: dict[str, dict[str, float]] = {}
        for item in r.get("Items", []):
            fecha = (item.get("Date") or "")[:10]
            for ent in item.get("DailyEntities", []):
                v = ent.get("Value") or 0
                if v:
                    nombre = (ent.get("Name") or "").strip()
                    por_fecha.setdefault(fecha, {})[nombre] = \
                        por_fecha.setdefault(fecha, {}).get(nombre, 0) + v
        return por_fecha

    no_prog = traer("DemaNoAtenNoProg")
    prog = traer("DemaNoAtenProg")

    # Línea base = mediana diaria por área, excluyendo el día del sismo en adelante.
    # Sin línea base un número absoluto no dice nada: 46.000 kWh puede ser un
    # martes cualquiera.
    corte_sismo = "2026-08-10"
    base: dict[str, list[float]] = {}
    for fecha, areas in no_prog.items():
        if fecha < corte_sismo:
            for a, v in areas.items():
                base.setdefault(a, []).append(v)

    def mediana(xs: list[float]) -> float:
        if not xs:
            return 0.0
        s = sorted(xs)
        n = len(s)
        return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

    lineas_base = {a: mediana(v) for a, v in base.items()}

    areas_salida = []
    todas = {a for d in no_prog.values() for a in d} | set(AREAS_XM)
    for nombre in sorted(todas):
        serie = {f: no_prog.get(f, {}).get(nombre, 0) for f in sorted(no_prog)}
        pico = max(serie.values()) if serie else 0
        pico_fecha = max(serie, key=serie.get) if serie else None
        lb = lineas_base.get(nombre, 0)
        geo = AREAS_XM.get(nombre, {})
        areas_salida.append({
            "area": nombre,
            "lat": geo.get("lat"),
            "lon": geo.get("lon"),
            # Los códigos van junto a los nombres para que el mapa pueda pintar
            # el área como la suma de sus departamentos. Un área de XM no tiene
            # un punto: es topología eléctrica, no un lugar.
            "codigos": geo.get("deptos", []),
            "departamentos": [DEPARTAMENTOS[d]["nombre"]
                              for d in geo.get("deptos", []) if d in DEPARTAMENTOS],
            "serie_kwh": serie,
            "pico_kwh": pico,
            "pico_fecha": pico_fecha,
            "linea_base_kwh": round(lb, 1),
            "veces_sobre_base": round(pico / lb, 1) if lb else None,
        })
    areas_salida.sort(key=lambda x: -(x["pico_kwh"] or 0))

    # Rezago real, medido en cada consulta y no supuesto. XM publica con
    # retraso variable; verificado el 2026-08-13, el último día disponible era
    # el 11 — dos días. Decirlo importa: quien mira esta capa tiene que saber
    # que está viendo anteayer, no ahora. Para el estado actual está `pulso_vivo`.
    ultimo = max(no_prog) if no_prog else None
    rezago = (date.today() - date.fromisoformat(ultimo)).days if ultimo else None

    res = {
        "fuente": "XM — Sistema Interconectado Nacional",
        "metrica": "DemaNoAtenNoProg (energía no entregada por falla, kWh)",
        "desde": desde.isoformat(), "hasta": hasta.isoformat(),
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ultimo_dato": ultimo,
        "rezago_dias": rezago,
        "nota_rezago": (
            f"El dato más reciente de XM es del {ultimo} ({rezago} día(s) de "
            f"rezago). Esta capa es el registro contable del apagón, no su "
            f"estado actual. Para saber qué pasa AHORA está el pulso en vivo "
            f"y la capa de luces nocturnas."
            if ultimo else "XM no devolvió datos en esta ventana."),
        "nota_mapeo": "Las áreas de XM son operativas (topología eléctrica), no "
                      "político-administrativas. El mapeo área→departamento es "
                      "aproximado y no debe usarse para atribuir un corte a un municipio.",
        "areas": areas_salida,
        "racionamiento_programado": prog,
    }
    _cache_guardar(clave, res)
    return res


# ── Cruce de las dos fuentes ────────────────────────────────────────────────

def interpretar_cobertura(score: float, afectado: bool) -> tuple[str, str]:
    """Traduce un score a una lectura operativa, incluyendo el caso peligroso:
    señal baja porque no hay infraestructura, no porque todo esté bien."""
    if score >= 1e6:
        return ("colapso_medido",
                "Caída masiva y confirmada por varios métodos. Hay red que se cayó.")
    if score >= 1e4:
        return ("degradacion_fuerte", "Caída significativa y sostenida.")
    if score >= 100:
        return ("degradacion_leve", "Interrupciones menores o intermitentes.")
    if afectado:
        return ("punto_ciego",
                "Zona con daño por el sismo pero SIN señal de corte medible. "
                "Lo más probable es que no haya infraestructura suficiente para "
                "medir. Prioridad alta para enlace satelital: aquí no hay red "
                "que restaurar, hay red que llevar.")
    return ("sin_senal", "Sin señal de corte y sin daño reportado.")


def prioridad_enlaces(desde: int, hasta: int) -> dict:
    """Ranking para decidir a dónde llevar enlaces satelitales.

    NO es un algoritmo de asignación: es un ordenamiento de evidencia. La
    decisión final depende de acceso por vía, seguridad y de lo que ya esté
    haciendo el organismo de socorro que coordina la zona.
    """
    internet = ioda_resumen(desde, hasta)
    try:
        energia = xm_no_atendida(date(2026, 7, 25), date.today())
        por_depto_energia: dict[int, dict] = {}
        for a in energia["areas"]:
            for nombre_d in a["departamentos"]:
                for cod, m in DEPARTAMENTOS.items():
                    if m["nombre"] == nombre_d:
                        por_depto_energia[cod] = {
                            "area": a["area"], "pico_kwh": a["pico_kwh"],
                            "veces_sobre_base": a["veces_sobre_base"]}
        error_energia = None
    except Exception as e:  # la falta de XM no debe tumbar el ranking
        por_depto_energia, error_energia = {}, f"{type(e).__name__}: {e}"

    filas = []
    for d in internet["departamentos"]:
        clase, lectura = interpretar_cobertura(d["score"], d["afectado_sismo"])
        en = por_depto_energia.get(d["codigo"])
        filas.append({**d, "clase": clase, "lectura": lectura, "energia": en})

    # Orden: primero lo medido como colapso, después los puntos ciegos con daño.
    rango = {"colapso_medido": 0, "degradacion_fuerte": 1, "punto_ciego": 2,
             "degradacion_leve": 3, "sin_senal": 4}
    filas.sort(key=lambda x: (rango[x["clase"]], -x["score"]))

    return {
        "generado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ventana": {"desde": desde, "hasta": hasta},
        "fuentes": ["IODA (Georgia Tech)", "XM (SIN Colombia)"],
        "error_energia": error_energia,
        "advertencia": "Ordenamiento de evidencia, no plan de despliegue. Un score "
                       "bajo puede significar 'no hay nada que medir', que suele ser "
                       "peor que un score alto. Contrastar con el organismo de "
                       "socorro que coordina la zona antes de mover recursos.",
        "zonas": filas,
    }


def ventana_horas(horas: int = 96) -> tuple[int, int]:
    ahora = int(time.time())
    return ahora - horas * 3600, ahora


# ── USGS: sismicidad reciente en Colombia (monitoreo continuo) ─────────────
#
# Distinta de las "réplicas" que pinta el frontend directo desde el navegador
# (esas miran solo alrededor del epicentro, desde el 10 de agosto). Esta es una
# ventana rodante sobre todo el país: sirve para detectar un sismo NUEVO, no
# necesariamente relacionado con el del Chocó.

USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"
BBOX_COLOMBIA = {"minlat": -1.5, "maxlat": 13.5, "minlon": -82.0, "maxlon": -66.0}


def usgs_sismos_recientes(dias: int = 7, mag_min: float = 3.0) -> dict:
    """Sismos recientes en Colombia y su zona de influencia, catálogo USGS."""
    clave = f"usgs_recientes:{dias}:{mag_min}"
    if (c := _cache_leer(clave)) is not None:
        return c

    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(days=dias)
    b = BBOX_COLOMBIA
    url = (f"{USGS}?format=geojson&starttime={desde:%Y-%m-%d}&endtime={hasta:%Y-%m-%d}"
           f"&minlatitude={b['minlat']}&maxlatitude={b['maxlat']}"
           f"&minlongitude={b['minlon']}&maxlongitude={b['maxlon']}"
           f"&minmagnitude={mag_min}&orderby=time")
    gj = _get(url)

    sismos = []
    for f in gj.get("features", []):
        p = f.get("properties", {}) or {}
        lon, lat, prof = f.get("geometry", {}).get("coordinates", [None, None, None])
        t = p.get("time")
        sismos.append({
            "id": f.get("id"),
            "lat": lat, "lon": lon, "profundidad_km": prof,
            "magnitud": p.get("mag"),
            "lugar": p.get("place"),
            "hora_ms": t,
            "hora_iso": (datetime.fromtimestamp(t / 1000, timezone.utc).isoformat()
                        if t else None),
            "alerta": p.get("alert"),
            "url": p.get("url"),
        })
    sismos.sort(key=lambda x: -(x["hora_ms"] or 0))

    res = {
        "fuente": "USGS (catálogo global, ventana rodante sobre Colombia)",
        "dias": dias, "mag_min": mag_min,
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(sismos),
        "sismos": sismos,
    }
    _cache_guardar(clave, res)
    return res


# ── Open-Meteo: clima en zonas con daño reportado ───────────────────────────
#
# Lluvia intensa complica el acceso vial a zonas ya golpeadas por el sismo: es
# dato operativo para decidir prioridad de vías, no solo contexto ambiental.
# API pública, sin llave, datos de modelos meteorológicos abiertos.

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"


def clima_zonas_afectadas() -> dict:
    """Precipitación actual y probabilidad a 24 h en los departamentos con
    daño reportado por el sismo (`AFECTADOS_SISMO`)."""
    clave = "clima_zonas_afectadas"
    if (c := _cache_leer(clave)) is not None:
        return c

    zonas = []
    for codigo in sorted(AFECTADOS_SISMO):
        meta = DEPARTAMENTOS[codigo]
        url = (f"{OPEN_METEO}?latitude={meta['lat']}&longitude={meta['lon']}"
               f"&current=precipitation,rain,weather_code"
               f"&hourly=precipitation_probability,precipitation"
               f"&forecast_days=2&timezone=America%2FBogota")
        try:
            r = _get(url)
            cur = r.get("current", {}) or {}
            hor = r.get("hourly", {}) or {}
            probs = [p for p in (hor.get("precipitation_probability") or [])[:24] if p is not None]
            precs = [p for p in (hor.get("precipitation") or [])[:24] if p is not None]
            zonas.append({
                "codigo": codigo, "nombre": meta["nombre"],
                "lat": meta["lat"], "lon": meta["lon"],
                "precipitacion_actual_mm": cur.get("precipitation"),
                "codigo_clima": cur.get("weather_code"),
                "prob_lluvia_24h_max": max(probs) if probs else None,
                "lluvia_acumulada_24h_mm": round(sum(precs), 1) if precs else None,
            })
        except Exception as e:
            zonas.append({"codigo": codigo, "nombre": meta["nombre"],
                         "lat": meta["lat"], "lon": meta["lon"],
                         "error": f"{type(e).__name__}: {e}"})

    res = {
        "fuente": "Open-Meteo",
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "nota": "Lluvia intensa dificulta el acceso vial a zonas ya golpeadas por "
                "el sismo. No es alerta oficial de IDEAM: es pronóstico de modelo abierto.",
        "zonas": zonas,
    }
    _cache_guardar(clave, res)
    return res


# ── RIPE Atlas: sondas individuales, punto exacto (no por departamento) ─────

RIPE_ATLAS = "https://atlas.ripe.net/api/v2/probes"
SISMO_TS = datetime(2026, 8, 10, 12, 34, 28, tzinfo=timezone.utc).timestamp()


def ripe_atlas_colombia() -> dict:
    """Sondas RIPE Atlas en Colombia con estado de conexión reciente.

    Se excluyen sondas 'Abandoned' / 'Written Off' / 'Never Connected': son
    hardware que dejó de reportar mucho antes del sismo, no una señal de nada.
    Solo quedan las que están conectadas AHORA (prueba de que ahí sí hay
    internet) o que se desconectaron DESPUÉS del sismo (posible corte real).
    """
    clave = "ripe_atlas_co"
    if (c := _cache_leer(clave)) is not None:
        return c

    datos = _get(f"{RIPE_ATLAS}/?country_code=CO&format=json&page_size=500")

    sondas = []
    for p in datos.get("results", []):
        coords = (p.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        lon, lat = coords[0], coords[1]
        estado = (p.get("status") or {}).get("name", "")
        desde = p.get("status_since")

        if estado == "Connected":
            clase = "activa"
        elif estado == "Disconnected" and desde and desde >= SISMO_TS:
            clase = "caida_reciente"
        else:
            continue  # hardware viejo abandonado: no aporta señal del sismo

        sondas.append({
            "id": p.get("id"),
            "lat": lat, "lon": lon,
            "clase": clase,
            "estado": estado,
            "desde_iso": (datetime.fromtimestamp(desde, timezone.utc).isoformat()
                         if desde else None),
            "descripcion": p.get("description") or "",
            "asn": p.get("asn_v4") or p.get("asn_v6"),
            "es_ancla": bool(p.get("is_anchor")),
        })

    res = {
        "fuente": "RIPE Atlas (sondas individuales)",
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "nota": "Cada sonda es un punto real, no un promedio de zona. Son pocas "
                "decenas de puntos en todo el país: ausencia de sonda no es "
                "ausencia de problema, solo ausencia de medición ahí.",
        "total": len(sondas),
        "sondas": sondas,
    }
    _cache_guardar(clave, res)
    return res


# ═══════════════════════════════════════════════════════════════════════════
#  PULSO EN VIVO — el corazón del sistema
# ═══════════════════════════════════════════════════════════════════════════
#
# Todo lo de arriba mira hacia atrás: el score de IODA resume días, XM publica
# con dos días de rezago. Esto mira AHORA, con dos series crudas de IODA que se
# actualizan cada 5-10 minutos (`/signals/raw`):
#
#   ping-slash24 — cuántos bloques /24 del departamento responden al sondeo.
#                  Es el acceso: la última milla, el router de la casa, la
#                  antena del barrio. Cae cuando se va la luz o el enlace local.
#   bgp          — cuántos prefijos del departamento siguen anunciados en la
#                  tabla global de rutas. Es el troncal: la fibra, el operador.
#                  Solo cae si el problema es grande y de red, no de energía.
#
# Cruzarlas es lo que da el diagnóstico que ninguna fuente da sola:
#
#   ping ↓  +  bgp =   →  se cayó la ÚLTIMA MILLA. La fibra está intacta y el
#                        operador sigue anunciando sus rutas, pero los equipos
#                        del usuario no contestan. Firma típica de un apagón:
#                        sin energía no hay router, aunque el cable esté sano.
#                        Lo que hace falta ahí es ENERGÍA, no fibra.
#   ping ↓  +  bgp ↓   →  se cayó el TRONCAL. El operador retiró rutas: corte
#                        físico de fibra o caída del nodo. Ahí sí hace falta
#                        una cuadrilla de red o un enlace satelital.
#   ping =  +  bgp =   →  sin cambio medible.
#
# ── Por qué se compara contra línea base y nunca en absoluto ──────────────
#
# El valor crudo de estas series NO se puede leer como "% de gente sin
# internet", y es un error fácil de cometer: la métrica `loss_pct` de IODA
# marcaba 80% en Chocó el 12 de agosto y podría leerse como catástrofe. Pero
# marcaba 84% el día ANTES del sismo. La mayoría de internet simplemente no
# responde a ping, siempre. El número absoluto no dice nada.
#
# Lo que sí dice algo es la DESVIACIÓN de cada zona contra su propio pasado.
# Por eso cada ventana se compara con la misma ventana de hace 7 días: mismo
# día de la semana y misma hora, que es como se cancelan el ciclo diario y el
# ciclo semanal del tráfico.

PULSO_ACCESO = "ping-slash24"    # última milla
PULSO_TRONCAL = "bgp"            # troncal / anuncios de ruta
SEMANA_S = 7 * 24 * 3600

# Debajo de este número de bloques /24 la aritmética de porcentajes deja de
# tener sentido: en Chocó la línea base son ~33 bloques, y que dejen de
# responder 3 ya da -9%. No es señal, es ruido de muestra chica. Esas zonas se
# marcan aparte en vez de fingir precisión que no existe.
MUESTRA_MINIMA = 60

# Operadores que llevan la mayor parte del tráfico del país. Los códigos ASN
# están verificados contra /entities/query?entityType=asn&relatedTo=country/CO.
# Starlink va incluido a propósito: es el enlace de respaldo cuando el resto
# se cae, y ver su curva subir es ver a la gente migrando a satélite.
OPERADORES: dict[int, str] = {
    10620: "Claro / Telmex",
    13489: "Tigo-UNE / EPM Telecomunicaciones",
    3816:  "Movistar / Colombia Telecomunicaciones",
    19429: "ETB",
    14080: "Claro (bloque secundario)",
    26611: "Emcali / otros regionales",
    14593: "Starlink (SpaceX)",
}


def _ioda_serie(tipo: str, codigo: Any, desde: int, hasta: int, ds: str) -> list[float]:
    """Serie temporal cruda de IODA. Devuelve solo los valores numéricos.

    Se descartan los `null` del final: IODA publica con unos minutos de retraso
    y esos huecos son "todavía no llegó el dato", no "cayó a cero". Contarlos
    como ceros inventaría un apagón que no existe.
    """
    url = (f"{IODA}/signals/raw/{tipo}/{codigo}"
           f"?from={desde}&until={hasta}&datasource={ds}")
    # Espera corta a propósito: estas series son pequeñas y IODA las contesta en
    # ~2 s. Con los 45 s generales, tres intentos por serie × cuatro series
    # dejarían la página colgada minutos antes de admitir que la fuente cayó.
    datos = _desanidar(_get(url, tiempo=TIEMPO_IODA))
    for serie in datos:
        return [v for v in (serie.get("values") or []) if isinstance(v, (int, float))]
    return []


def _media(xs: list[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def _tendencia(serie: list[float]) -> str:
    """¿Está cayendo AHORA, o cayó y se estabilizó?

    Sale de la misma serie que ya se pidió, comparando su primer tercio con su
    último tercio. No necesita guardar historia ni que la pestaña haya estado
    abierta: en la primera carga ya sabe si la cosa va a peor.

    La diferencia es operativa, no cosmética. Una zona -30% y estable lleva
    horas así y probablemente ya la están atendiendo. Una zona -30% y cayendo
    se está apagando mientras alguien lee la pantalla.
    """
    s = [v for v in serie if isinstance(v, (int, float))]
    if len(s) < 6:
        return "sin_datos"
    n = len(s) // 3
    ini, fin = _media(s[:n]), _media(s[-n:])
    if not ini:
        return "sin_datos"
    cambio = (fin - ini) / ini * 100
    if cambio <= -5:
        return "empeorando"
    if cambio >= 5:
        return "mejorando"
    return "estable"


def _pulso_entidad(tipo: str, codigo: Any, nombre: str, horas: int) -> dict:
    """Estado de una entidad ahora contra su propia línea base de hace 7 días."""
    hasta = int(time.time())
    desde = hasta - horas * 3600

    # Las cuatro series son independientes: van a la vez. En serie, un IODA
    # lento multiplicaba por cuatro la espera de cada zona, y con reintentos
    # eso se vuelve minutos de página colgada. Así el peor caso de una zona es
    # el de una sola serie.
    ventanas = [
        (desde, hasta, PULSO_ACCESO), (desde - SEMANA_S, hasta - SEMANA_S, PULSO_ACCESO),
        (desde, hasta, PULSO_TRONCAL), (desde - SEMANA_S, hasta - SEMANA_S, PULSO_TRONCAL),
    ]
    acceso_hoy, acceso_base, troncal_hoy, troncal_base = _en_paralelo(
        [(lambda d=d, h=h, s=s: _ioda_serie(tipo, codigo, d, h, s)) for d, h, s in ventanas],
        hilos=4)

    def delta(hoy: list[float], base: list[float]) -> Optional[float]:
        a, b = _media(hoy), _media(base)
        if a is None or not b:
            return None
        return round((a - b) / b * 100, 1)

    d_acceso = delta(acceso_hoy, acceso_base)
    d_troncal = delta(troncal_hoy, troncal_base)
    base_acceso = _media(acceso_base) or 0

    clase, diagnostico, accion = _diagnosticar(d_acceso, d_troncal, base_acceso, tipo)

    return {
        "tipo": tipo, "codigo": codigo, "nombre": nombre,
        "tendencia": _tendencia(acceso_hoy),
        "acceso": {
            "ahora": round(_media(acceso_hoy) or 0, 1),
            "linea_base": round(base_acceso, 1),
            "delta_pct": d_acceso,
            "serie": acceso_hoy[-72:],
            "muestra_suficiente": base_acceso >= MUESTRA_MINIMA,
        },
        "troncal": {
            "ahora": round(_media(troncal_hoy) or 0, 1),
            "linea_base": round(_media(troncal_base) or 0, 1),
            "delta_pct": d_troncal,
            "serie": troncal_hoy[-72:],
        },
        "clase": clase,
        "diagnostico": diagnostico,
        "accion": accion,
    }


def _diagnosticar(d_acceso: Optional[float], d_troncal: Optional[float],
                  base_acceso: float, tipo: str = "region") -> tuple[str, str, str]:
    """Traduce dos deltas a una lectura operativa.

    La distinción que importa: si el troncal aguanta y solo cae el acceso, el
    problema casi siempre es energía. Mandar fibra ahí no arregla nada.
    """
    if d_acceso is None:
        return ("sin_medicion",
                "IODA no está devolviendo datos para esta zona en esta ventana.",
                "No se puede concluir nada. Confirmar por radio o en terreno.")

    if base_acceso < MUESTRA_MINIMA:
        accion = ("Zona con poca infraestructura que medir. Es candidata a enlace "
                  "satelital por definición: aquí no hay red que restaurar, hay "
                  "red que llevar."
                  if tipo == "region" else
                  "Operador con poca presencia medible. Su curva no sirve para "
                  "concluir nada a nivel nacional.")
        return ("muestra_chica",
                f"Solo hay ~{base_acceso:.0f} bloques de red medibles aquí. Un "
                f"cambio de pocos bloques ya mueve el porcentaje, así que el "
                f"{d_acceso:+.1f}% no es concluyente.",
                accion)

    troncal_cayo = d_troncal is not None and d_troncal <= -3

    if d_acceso <= -50:
        if troncal_cayo:
            return ("troncal_caido",
                    f"Corte mayor: el acceso cayó {d_acceso:.1f}% y el troncal "
                    f"{d_troncal:.1f}%. El operador retiró rutas de la tabla global.",
                    "Corte de red, no de energía. Requiere cuadrilla del operador "
                    "o enlace satelital para restablecer servicio.")
        return ("ultima_milla_caida",
                f"El acceso cayó {d_acceso:.1f}% pero el troncal sigue en pie. La "
                f"fibra está sana; lo que no responde son los equipos del usuario.",
                "Firma de apagón: sin energía no hay router aunque el cable esté "
                "bueno. Aquí hace falta ENERGÍA (planta, combustible), no fibra.")

    if d_acceso <= -20:
        if troncal_cayo:
            return ("troncal_degradado",
                    f"Acceso {d_acceso:.1f}% y troncal {d_troncal:.1f}% por debajo "
                    f"de lo normal. Degradación que ya toca el enrutamiento.",
                    "Vigilar de cerca: si el troncal sigue bajando es corte de red "
                    "en curso, no una fluctuación.")
        return ("ultima_milla_degradada",
                f"El acceso está {d_acceso:.1f}% por debajo de su normal, con el "
                f"troncal intacto.",
                "Compatible con cortes de energía parciales o intermitentes. "
                "Contrastar con la capa de energía y con reportes en terreno.")

    if d_acceso <= -8:
        return ("degradacion_leve",
                f"Acceso {d_acceso:.1f}% bajo su línea base. Está dentro de lo que "
                f"puede ser variación normal de un día a otro.",
                "No es concluyente por sí solo. Sirve como tendencia si sigue "
                "bajando en las próximas horas.")

    if d_acceso >= 8:
        return ("recuperando",
                f"El acceso está {d_acceso:+.1f}% por ENCIMA de su línea base: "
                f"hay más red respondiendo que hace una semana.",
                "Señal de restablecimiento. Verificar si coincide con reconexión "
                "de energía reportada.")

    return ("normal",
            f"Acceso en su nivel habitual ({d_acceso:+.1f}% contra hace 7 días).",
            "Sin evidencia instrumental de corte. No descarta problemas locales "
            "que estas fuentes no alcanzan a ver.")


# El orden en que se listan las zonas. Primero lo que exige decisión hoy.
RANGO_CLASE = {
    "troncal_caido": 0, "ultima_milla_caida": 1, "troncal_degradado": 2,
    "ultima_milla_degradada": 3, "muestra_chica": 4, "degradacion_leve": 5,
    "recuperando": 6, "normal": 7, "sin_medicion": 8,
}


def _en_paralelo(tareas: list, hilos: int = 8) -> list:
    """IODA aguanta bien varias consultas a la vez y no ofrece consulta
    multi-entidad (probado: los códigos separados por coma devuelven solo uno).
    Sin paralelizar, 8 departamentos × 4 series serían ~30 s de espera."""
    with ThreadPoolExecutor(max_workers=hilos) as ej:
        return list(ej.map(lambda f: f(), tareas))


def pulso_vivo(horas: int = 3) -> dict:
    """Estado AHORA de los departamentos golpeados por el sismo.

    Esta es la vista principal de HOPE. Ventana corta (3 h por defecto) contra
    la misma ventana de hace 7 días.
    """
    clave = f"pulso_vivo:{horas}"
    if (c := _cache_leer(clave, CACHE_PULSO_SEG)) is not None:
        return c

    codigos = sorted(AFECTADOS_SISMO)

    def tarea(cod: int):
        def _():
            try:
                z = _pulso_entidad("region", cod, DEPARTAMENTOS[cod]["nombre"], horas)
                z.update(lat=DEPARTAMENTOS[cod]["lat"], lon=DEPARTAMENTOS[cod]["lon"])
                return z
            except Exception as e:
                m = DEPARTAMENTOS[cod]
                return {"tipo": "region", "codigo": cod, "nombre": m["nombre"],
                        "lat": m["lat"], "lon": m["lon"], "clase": "sin_medicion",
                        "diagnostico": f"IODA no respondió: {type(e).__name__}",
                        "accion": "Reintentar. No concluir nada de este vacío.",
                        "acceso": {}, "troncal": {}}
        return _

    zonas = _en_paralelo([tarea(c) for c in codigos])
    zonas.sort(key=lambda z: (RANGO_CLASE.get(z["clase"], 9),
                              (z.get("acceso") or {}).get("delta_pct") or 0))

    # Medida y no-medida son cosas distintas y no pueden sumarse. Contar una
    # zona sin datos dentro de «zonas medidas» hacía que el panel dijera «las 8
    # zonas están como un día normal» mientras las ocho tarjetas decían «no hay
    # datos». Ese titular es peor que no tener panel.
    medidas = [z for z in zonas if z["clase"] != "sin_medicion"]
    sin_medir = [z for z in zonas if z["clase"] == "sin_medicion"]

    # Si no se midió NADA, la consulta falló entera. Antes de dar la pantalla
    # por vacía se busca la última medición buena, que se entrega rotulada.
    if not medidas:
        motivos = sorted({z.get("diagnostico", "") for z in sin_medir})
        rancio = _cache_leer(f"{clave}:bueno", CACHE_RANCIO_SEG)
        if rancio is not None:
            envejecido = dict(rancio)
            envejecido["rancio"] = True
            envejecido["medido_en"] = rancio.get("consultado")
            envejecido["fallo_fuente"] = " · ".join(m for m in motivos if m)
            return envejecido

    con_corte = [z for z in zonas
                 if z["clase"] in ("troncal_caido", "ultima_milla_caida",
                                   "troncal_degradado", "ultima_milla_degradada")]
    por_energia = [z for z in con_corte if z["clase"].startswith("ultima_milla")]

    res = {
        "fuente": "IODA /signals/raw (Georgia Tech) — series crudas cada 5-10 min",
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ventana_horas": horas,
        "comparado_contra": "la misma ventana horaria de hace 7 días",
        "resumen": {
            "zonas_medidas": len(medidas),
            "zonas_sin_medir": len(sin_medir),
            "zonas_totales": len(zonas),
            "con_degradacion": len(con_corte),
            "firma_de_apagon": len(por_energia),
        },
        "como_leer": (
            "Estos números son DESVIACIONES contra el pasado de cada zona, no "
            "porcentajes de población sin servicio. Un -30% significa que "
            "responde un 30% menos de red que hace una semana a esta misma "
            "hora; no que el 30% de la gente esté incomunicada."
        ),
        "zonas": zonas,
    }
    # Un fallo NO se cachea. Guardar «no sabemos nada» durante dos minutos
    # alarga el apagón de datos por nuestra cuenta: quien recarga buscando
    # novedades recibe el mismo vacío sin que se haya vuelto a preguntar.
    # Sin caché, el siguiente golpe de F5 reintenta de verdad.
    #
    # La copia «buena» tampoco se pisa con un fallo: es la red de seguridad
    # para el próximo corte, y sobrescribirla sería tirar justo lo único que
    # serviría entonces.
    if medidas:
        _cache_guardar(clave, res)
        _cache_guardar(f"{clave}:bueno", res)
    return res


def pulso_operadores(horas: int = 3) -> dict:
    """Lo mismo, pero por operador. Responde a: ¿es mi zona o es mi proveedor?

    Un corte que aparece en un solo ASN a lo largo de varios departamentos es
    un problema del operador. Uno que aparece en todos los ASN de un mismo
    departamento es un problema de esa zona — energía, casi siempre.
    """
    clave = f"pulso_operadores:{horas}"
    if (c := _cache_leer(clave, CACHE_PULSO_SEG)) is not None:
        return c

    def tarea(asn: int, nombre: str):
        def _():
            try:
                return _pulso_entidad("asn", asn, nombre, horas)
            except Exception as e:
                return {"tipo": "asn", "codigo": asn, "nombre": nombre,
                        "clase": "sin_medicion",
                        "diagnostico": f"IODA no respondió: {type(e).__name__}",
                        "accion": "Reintentar.", "acceso": {}, "troncal": {}}
        return _

    ops = _en_paralelo([tarea(a, n) for a, n in OPERADORES.items()])
    ops.sort(key=lambda o: (RANGO_CLASE.get(o["clase"], 9),
                            (o.get("acceso") or {}).get("delta_pct") or 0))

    res = {
        "fuente": "IODA /signals/raw por ASN",
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ventana_horas": horas,
        "nota": "Los ASN son nacionales: un operador degradado aquí no dice EN "
                "QUÉ departamento está degradado. Cruzar con la vista por zona.",
        "operadores": ops,
    }
    _cache_guardar(clave, res)
    return res


# ── NASA VIIRS: luces nocturnas, el único dato de energía casi en vivo ──────
#
# XM publica con dos días de rezago y por área operativa, que no es un
# municipio. El satélite ve la luz encendida o apagada a ~500 m de resolución,
# cada noche, con el paso sobre Colombia alrededor de la 1:30 de la madrugada.
# Es la forma de saber qué pueblo se quedó a oscuras sin esperar a XM.
#
# Se sirve como capa de teselas WMTS directamente al navegador: no hace falta
# llave ni proxy. Verificado el 2026-08-13: la capa de Suomi-NPP (la que suele
# citarse) está congelada desde 2023; la viva es la de NOAA-20.
#
# Limitación honesta y grande: NUBES. El Chocó es de las regiones más lluviosas
# del planeta. Una noche nublada se ve igual de oscura que una noche sin luz.
# Por eso siempre se entrega junto con una noche de referencia anterior al
# sismo: la comparación entre dos noches es lo único interpretable, y aun así
# hay que descartar que la diferencia sea meteorológica.

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
CAPA_LUCES = "VIIRS_NOAA20_DayNightBand"
NOCHE_REFERENCIA = "2026-08-08"   # dos noches antes del sismo, sin daño


PLANTILLA_LUCES = (f"{GIBS}/{CAPA_LUCES}/default/{{fecha}}/"
                   f"GoogleMapsCompatible_Level7/{{z}}/{{y}}/{{x}}.png")

# Tesela de referencia en z=6 que cubre el epicentro y el eje Chocó–Valle.
# Sirve para preguntarle a la NASA si ya procesó esa noche.
TESELA_SONDA = {"z": 6, "x": 18, "y": 31}

# Una tesela sin procesar pesa ~1,6 KB (PNG transparente); una con imagen real
# pesa decenas de KB. El umbral separa "todavía no hay dato" de "hay dato".
UMBRAL_TESELA_BYTES = 8000
TIMEOUT_SONDA_TESELA = 8


def _noche_procesada(fecha: str) -> tuple[bool, int]:
    """¿La NASA ya publicó esa noche?

    Importa más de lo que parece: el paso del satélite es a la 1:30 a.m. y el
    procesamiento tarda horas. Una tesela vacía se pinta negra, igual que un
    pueblo sin luz. Sin esta comprobación, alguien puede mirar el mapa a las
    2 a.m., ver todo oscuro y concluir un apagón que no ocurrió.
    """
    url = (PLANTILLA_LUCES.replace("{fecha}", fecha)
           .replace("{z}", str(TESELA_SONDA["z"]))
           .replace("{y}", str(TESELA_SONDA["y"]))
           .replace("{x}", str(TESELA_SONDA["x"])))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "HOPE/0.3"})
        # Timeout corto y propio: esto es una comprobación de disponibilidad, no
        # una descarga de datos. Si la NASA va lenta, la respuesta correcta es
        # decir "no sé" en segundos, no dejar colgado un worker del servidor.
        with urllib.request.urlopen(req, timeout=TIMEOUT_SONDA_TESELA) as r:
            n = len(r.read())
        return n >= UMBRAL_TESELA_BYTES, n
    except Exception:
        return False, 0


def luces_nocturnas() -> dict:
    """Configuración de la capa de luces nocturnas para el mapa.

    No descarga la imagen que se ve: devuelve la plantilla de teselas y las
    noches que tiene sentido comparar, cada una marcada según si la NASA ya la
    procesó. El navegador pide las teselas directo, sin pasar por aquí.
    """
    clave = "luces_nocturnas"
    if (c := _cache_leer(clave, 1800)) is not None:
        return c

    hoy = datetime.now(timezone.utc).date()
    candidatas = [
        ("anoche", hoy.isoformat()),
        ("anterior", (hoy - timedelta(days=1)).isoformat()),
        ("previa", (hoy - timedelta(days=2)).isoformat()),
        ("referencia", NOCHE_REFERENCIA),
    ]

    sondeos = _en_paralelo([(lambda f=f: _noche_procesada(f)) for _, f in candidatas], hilos=4)
    noches = [{"clave": et, "fecha": f, "procesada": ok, "peso_sonda_bytes": peso}
              for (et, f), (ok, peso) in zip(candidatas, sondeos)]

    res = {
        "fuente": "NASA GIBS / VIIRS NOAA-20 Day-Night Band",
        "plantilla": PLANTILLA_LUCES,
        "zoom_max": 7,
        "noches": noches,
        "ultima_procesada": next((n["fecha"] for n in noches if n["procesada"]), None),
        "paso_satelital_local": "~01:30 hora Colombia",
        "advertencia": (
            "ESTA CAPA NO SIRVE PARA CONCLUIR UN APAGÓN. Es contexto visual. "
            "La imagen está dominada por la luz de la LUNA reflejada en las "
            "nubes, que es mucho más brillante que un pueblo entero encendido. "
            "Medido el 2026-08-13 sobre el eje Chocó-Valle: el brillo promedio "
            "SUBIÓ de 75 a 137 entre el 8 y el 12 de agosto, no porque hubiera "
            "más luz eléctrica sino porque la luna creció. Comparar dos noches "
            "a ojo mide fase lunar y nubosidad, no electricidad."
        ),
        "camino_correcto": (
            "Para medir apagones de verdad hace falta el producto NASA Black "
            "Marble VNP46A2, que corrige luna y atmósfera y trae máscara de "
            "nubes. Exige cuenta gratuita de Earthdata "
            "(urs.earthdata.nasa.gov) y descargar granulos HDF5, no teselas."
        ),
        "nota_procesado": (
            "Las noches sin procesar salen deshabilitadas. Una tesela que la "
            "NASA todavía no publicó se pinta negra igual que un pueblo sin "
            "luz, y confundir las dos cosas es el error más fácil de cometer "
            "con esta capa."
        ),
    }
    _cache_guardar(clave, res)
    return res


# ── Parte de situación: el formato que un humano puede recibir ─────────────
#
# La restricción de diseño de todo el proyecto es que una capa de datos sin
# canal hacia quien ejecuta el rescate no le llega a nadie. Un GeoJSON no se
# lee en un celular a las 3 de la mañana; un mensaje de WhatsApp sí.
#
# Esto es texto plano, corto, sin markdown ni tablas, pensado para pegar en un
# grupo de WhatsApp del CMGRD o mandar por correo a la UNGRD. Lleva siempre la
# hora, la fuente, el rezago de cada dato y la advertencia de que no es un
# despacho de emergencia — porque quien lo reenvía no va a agregarla.

TZ_COLOMBIA = timezone(timedelta(hours=-5))

FLECHAS = {"empeorando": "▼ empeorando", "mejorando": "▲ mejorando",
           "estable": "= estable", "sin_datos": ""}


def parte_situacion(horas: int = 3, url_mapa: str = "") -> str:
    """Genera el parte en texto plano. Todo lo que afirma sale de una consulta
    hecha en este mismo momento; nada se guarda ni se reutiliza."""
    ahora_co = datetime.now(TZ_COLOMBIA)
    L: list[str] = []
    L.append("HOPE · PARTE DE RED Y ENERGÍA")
    L.append(f"{ahora_co:%d/%m/%Y %H:%M} hora Colombia")
    L.append("Sismo M7.4 Chocó 10-ago-2026 · evento USGS us6000tjl2")
    L.append("")

    try:
        p = pulso_vivo(horas)
    except Exception as e:
        L.append(f"NO SE PUDO CONSULTAR LA FUENTE DE INTERNET ({type(e).__name__}).")
        L.append("No hay estado que reportar. No asumir que eso significa que todo está bien.")
        return "\n".join(L)

    r = p["resumen"]
    graves = [z for z in p["zonas"] if z["clase"] in
              ("troncal_caido", "ultima_milla_caida", "troncal_degradado",
               "ultima_milla_degradada")]
    ciegas = [z for z in p["zonas"] if z["clase"] == "muestra_chica"]
    normales = [z for z in p["zonas"] if z["clase"] in ("normal", "recuperando",
                                                        "degradacion_leve")]

    L.append(f"ESTADO: {r['con_degradacion']} de {r['zonas_medidas']} zonas por "
             f"debajo de su nivel normal.")
    L.append("")

    if graves:
        for z in graves:
            a = z.get("acceso") or {}
            t = z.get("troncal") or {}
            flecha = FLECHAS.get(z.get("tendencia", ""), "")
            L.append(f"[!] {z['nombre'].upper()} — acceso {a.get('delta_pct')}% "
                     f"{flecha}".rstrip())
            if z["clase"].startswith("ultima_milla"):
                L.append("    FALTA ENERGIA. El troncal sigue en pie "
                         f"({t.get('delta_pct')}%): la fibra esta sana y no")
                L.append("    responden los equipos del usuario. Se necesita planta y")
                L.append("    combustible, no cuadrilla de red.")
            else:
                L.append("    FALTA RED. El operador retiro rutas "
                         f"({t.get('delta_pct')}%): corte fisico o")
                L.append("    nodo caido. Se necesita cuadrilla del operador o enlace")
                L.append("    satelital.")
            L.append("")
    else:
        L.append("Ninguna zona con degradacion significativa en esta ventana.")
        L.append("")

    if ciegas:
        L.append("PUNTOS CIEGOS (no es que esten bien, es que no hay que medir):")
        for z in ciegas:
            a = z.get("acceso") or {}
            L.append(f"  - {z['nombre']}: solo ~{a.get('linea_base')} bloques de red "
                     f"medibles.")
        L.append("    Son candidatas a enlace satelital por definicion: alli no hay")
        L.append("    red que restaurar, hay red que llevar.")
        L.append("")

    if normales:
        L.append("SIN CAMBIO: " + ", ".join(z["nombre"] for z in normales) + ".")
        L.append("")

    # Energía y luces: cada una con su rezago dicho en la cara.
    try:
        e = xm_no_atendida(date.today() - timedelta(days=20), date.today())
        top = [a for a in e["areas"] if a["pico_kwh"] > 0][:2]
        L.append(f"ENERGIA (XM, ultimo dato disponible {e['ultimo_dato']}, "
                 f"{e['rezago_dias']} dia(s) de rezago):")
        if top:
            # Va la FECHA del pico junto al numero. Sin ella, "8 millones de kWh
            # sin entregar" se lee como si estuviera pasando ahora, y puede ser
            # el registro del dia del sismo, ya superado.
            for a in top:
                veces = f", x{a['veces_sobre_base']} su normal" if a["veces_sobre_base"] else ""
                L.append(f"  - {a['area'].replace('AREA ', '')}: pico de "
                         f"{a['pico_kwh']:,.0f} kWh sin entregar")
                L.append(f"    el {a['pico_fecha']}{veces}.")
            hoy_serie = {a["area"]: a["serie_kwh"].get(e["ultimo_dato"], 0) for a in top}
            L.append(f"  En el ultimo dia con dato ({e['ultimo_dato']}): "
                     + ", ".join(f"{k.replace('AREA ','')} {v:,.0f} kWh"
                                 for k, v in hoy_serie.items()) + ".")
            L.append("  Es el registro contable del apagon, NO su estado actual.")
        else:
            L.append("  Sin energia no entregada registrada en la ventana.")
        L.append("")
    except Exception:
        L.append("ENERGIA: XM no respondio en este momento.")
        L.append("")

    try:
        luz = luces_nocturnas()
        if luz.get("ultima_procesada"):
            L.append(f"LUCES NOCTURNAS (NASA VIIRS): ultima noche procesada "
                     f"{luz['ultima_procesada']}.")
            L.append("  Nubes y apagon se ven iguales. Comparar contra la noche previa")
            L.append(f"  al sismo ({NOCHE_REFERENCIA}) antes de concluir nada.")
            L.append("")
    except Exception:
        pass

    L.append("COMO LEER ESTO")
    L.append("Los porcentajes son la desviacion de cada zona contra SI MISMA hace")
    L.append("7 dias a la misma hora. NO son porcentaje de poblacion sin servicio.")
    L.append(f"Ventana de {horas} h. Fuente internet: IODA (Georgia Tech),")
    L.append("series de 5-10 min. Granularidad maxima: departamento.")
    L.append("")
    L.append("ESTO NO ES UN DESPACHO DE EMERGENCIA. Para vidas en riesgo: 123.")
    L.append("Es apoyo de datos: nadie es enviado a ningun sitio desde aqui.")
    if url_mapa:
        L.append(f"Mapa: {url_mapa}")

    return "\n".join(L)


# ═══════════════════════════════════════════════════════════════════════════
#  BLACK MARBLE — energía a escala de municipio
# ═══════════════════════════════════════════════════════════════════════════
#
# Esto resuelve el hueco más grande del sistema. XM publica por área operativa
# con dos días de rezago; IODA no baja del departamento. Ninguna de las dos
# dice qué PUEBLO se quedó sin luz.
#
# La imagen cruda del satélite tampoco: se probó y está dominada por luz de
# luna reflejada en nubes. Sobre el eje Chocó-Valle su brillo osciló entre 75 y
# 216 en cuatro noches, un factor de tres, sin que hubiera pasado nada
# eléctrico. Medir con eso es medir la fase lunar.
#
# El producto BRDF-corregido y rellenado sí sirve. Corrige luna y atmósfera, y
# GIBS lo publica como teselas SIN LLAVE — que es lo que hace esto posible hoy.
# Las mismas cuatro noches, ya corregidas: 8,8 / 10,7 / 8,7 / 13,5. Y Bogotá,
# usada como control, se mantiene clavada en 255,0 las cuatro noches.
#
# ── Detalle de fechas que es fácil equivocar ──────────────────────────────
# El satélite pasa hacia la 1:30 de la madrugada y el sismo fue a las 7:34 de
# la mañana del 10 de agosto. La imagen fechada el 10 es, por tanto, de SEIS
# HORAS ANTES del sismo: es línea base, no evento. Las noches posteriores
# empiezan el 11.
#
# ── Lo que este método NO puede hacer, y hay que decirlo ─────────────────
# · Los valores salen de un PNG con paleta de color, no de radiancia física.
#   Sirven para comparar una noche contra otra en el mismo sitio, no para dar
#   un número absoluto en nW/cm²/sr.
# · Las ciudades grandes SATURAN. Bogotá marca 255 siempre; un apagón parcial
#   ahí no se vería hasta que fuera muy grave. Esas zonas se marcan aparte.
# · "Rellenado" significa que los huecos de nube se completan con modelo. En
#   una zona permanentemente nublada como el Chocó eso puede ser dato viejo
#   presentado como actual. No es lo mismo "observado oscuro" que "estimado".

BLACK_MARBLE = (
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
    "VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance/default/"
    "{fecha}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png"
)
BM_ZOOM = 8                  # máximo de esa capa; el píxel mide ~610 m
BM_VENTANA_PX = 3            # ±3 px ≈ 4 km alrededor del casco urbano
BM_SATURADO = 248            # por encima de esto la medida ya no distingue
NOCHE_SISMO = "2026-08-10"   # imagen de las 01:30, seis horas ANTES del sismo


def _bm_tesela(fecha: str, tx: int, ty: int, cache: dict):
    """Descarga y decodifica una tesela. El caché es por llamada: varios
    municipios cercanos caen en la misma tesela y sería absurdo pedirla dos
    veces."""
    clave = (fecha, tx, ty)
    if clave in cache:
        return cache[clave]
    try:
        from PIL import Image
        url = BLACK_MARBLE.format(fecha=fecha, z=BM_ZOOM, y=ty, x=tx)
        req = urllib.request.Request(url, headers={"User-Agent": "HOPE/0.3"})
        with urllib.request.urlopen(req, timeout=TIEMPO_ESPERA) as r:
            im = Image.open(io.BytesIO(r.read())).convert("RGBA")
    except Exception:
        im = None
    cache[clave] = im
    return im


def _bm_valor(lat: float, lon: float, fecha: str, cache: dict) -> Optional[float]:
    """Luminosidad media alrededor de un punto, ignorando píxeles sin dato.

    Los píxeles transparentes son AUSENCIA DE OBSERVACIÓN, no oscuridad.
    Contarlos como negro inventaría apagones donde solo hubo nubes.
    """
    n = 2 ** BM_ZOOM
    xw = (lon + 180) / 360 * n
    lr = math.radians(lat)
    yw = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
    tx, ty = int(xw), int(yw)

    im = _bm_tesela(fecha, tx, ty, cache)
    if im is None:
        return None

    px, py = int((xw - tx) * 256), int((yw - ty) * 256)
    vals = []
    for dy in range(-BM_VENTANA_PX, BM_VENTANA_PX + 1):
        for dx in range(-BM_VENTANA_PX, BM_VENTANA_PX + 1):
            X, Y = px + dx, py + dy
            if 0 <= X < 256 and 0 <= Y < 256:
                r, g, b, a = im.getpixel((X, Y))
                if a > 0:
                    vals.append(0.299 * r + 0.587 * g + 0.114 * b)
    return sum(vals) / len(vals) if vals else None


def _bm_clasificar(base: Optional[float], ahora: Optional[float]) -> tuple[str, str]:
    if base is None or ahora is None:
        return ("sin_dato",
                "El satélite no dejó observación utilizable aquí en estas noches.")
    if base >= BM_SATURADO:
        return ("saturado",
                "Zona tan iluminada que la medida se satura. Un apagón parcial no "
                "se distinguiría; solo se vería uno muy grande.")
    if base < 12:
        return ("muy_oscuro",
                "Casi no había luz medible aquí ni antes del sismo. No hay contra "
                "qué comparar: es un punto ciego, no una zona sin problemas.")

    cambio = (ahora - base) / base * 100
    if cambio <= -40:
        return ("sin_luz", f"Perdió {abs(cambio):.0f}% de su luz nocturna habitual. "
                           f"Compatible con un apagón extenso.")
    if cambio <= -15:
        return ("poca_luz", f"Perdió {abs(cambio):.0f}% de su luz nocturna. "
                            f"Compatible con un apagón parcial o por sectores.")
    if cambio >= 15:
        return ("mas_luz", f"Tiene {cambio:.0f}% más luz que antes. Puede ser "
                           f"restablecimiento, o plantas y luminarias de emergencia.")
    return ("normal", f"Su luz nocturna está como antes del sismo ({cambio:+.0f}%).")


def luces_municipios(municipios: list[dict], noches: int = 3) -> dict:
    """Cambio de luz nocturna por municipio contra las noches previas al sismo.

    `municipios` es una lista de dicts con nombre, departamento, lat y lon.
    """
    clave = f"bm_municipios:{noches}:{len(municipios)}"
    if (c := _cache_leer(clave, 3600)) is not None:
        return c

    hoy = datetime.now(timezone.utc).date()
    base_f = date.fromisoformat(NOCHE_SISMO)

    # Noches de referencia: las anteriores al sismo, incluida la del propio día
    # 10, que es de antes de que temblara.
    noches_base = [(base_f - timedelta(days=i)).isoformat() for i in range(0, noches)]
    # Noches posteriores: desde el 11 hasta donde alcance el archivo.
    noches_post = [(hoy - timedelta(days=i)).isoformat() for i in range(1, noches + 3)]
    noches_post = [f for f in noches_post if f > NOCHE_SISMO][:noches]

    cache: dict = {}

    # Se piden primero, en paralelo, las teselas distintas que hacen falta. Sin
    # esto cada municipio esperaba su descarga en fila y la consulta tardaba
    # ~25 s; los municipios vecinos comparten tesela, así que son pocas.
    n_lado = 2 ** BM_ZOOM
    necesarias = set()
    for m in municipios:
        xw = (m["lon"] + 180) / 360 * n_lado
        lr = math.radians(m["lat"])
        yw = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n_lado
        for f in noches_base + noches_post:
            necesarias.add((f, int(xw), int(yw)))
    _en_paralelo([(lambda t=t: _bm_tesela(t[0], t[1], t[2], cache))
                  for t in necesarias], hilos=8)

    def medir(m: dict) -> dict:
        def promedio(fechas):
            vs = [v for f in fechas
                  if (v := _bm_valor(m["lat"], m["lon"], f, cache)) is not None]
            return (sum(vs) / len(vs), len(vs)) if vs else (None, 0)

        base, n_base = promedio(noches_base)
        ahora, n_post = promedio(noches_post)
        clase, lectura = _bm_clasificar(base, ahora)
        cambio = (round((ahora - base) / base * 100, 1)
                  if base and ahora and base >= 12 else None)

        # Un pueblo pequeño parte de muy poca luz, y sobre poca luz un cambio
        # de dos o tres unidades ya da un porcentaje enorme. Es el mismo
        # problema de muestra chica que en la red: el porcentaje se calcula
        # igual, pero se dice que no es concluyente en vez de fingir precisión.
        if base is None:
            confianza = "sin_dato"
        elif base >= BM_SATURADO:
            confianza = "saturada"
        elif base < 30:
            confianza = "baja"
        elif base < 80:
            confianza = "media"
        else:
            confianza = "alta"
        if confianza == "baja" and clase in ("sin_luz", "poca_luz"):
            lectura += (" Aviso: este municipio parte de muy poca luz medible, "
                        "así que el porcentaje es frágil. Confirmar en terreno "
                        "antes de darlo por bueno.")

        return {**m, "luz_base": round(base, 1) if base else None,
                "luz_ahora": round(ahora, 1) if ahora else None,
                "cambio_pct": cambio, "clase": clase, "lectura": lectura,
                "confianza": confianza,
                "noches_usadas": {"base": n_base, "despues": n_post}}

    # En serie a propósito: el caché de teselas es compartido y los municipios
    # cercanos reutilizan la misma imagen. Paralelizar la pediría varias veces.
    filas = [medir(m) for m in municipios]

    orden = {"sin_luz": 0, "poca_luz": 1, "muy_oscuro": 2, "saturado": 3,
             "mas_luz": 4, "normal": 5, "sin_dato": 6}
    filas.sort(key=lambda f: (orden.get(f["clase"], 9), f.get("cambio_pct") or 0))

    res = {
        "fuente": "NASA VIIRS NOAA-20 Black Marble (BRDF-corregido y rellenado), vía GIBS",
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "noches_base": noches_base,
        "noches_despues": noches_post,
        "resolucion_m": 610,
        "como_leer": (
            "Compara la luz nocturna de cada pueblo contra sus propias noches "
            "previas al sismo. La imagen del 10 de agosto es de las 01:30, seis "
            "horas ANTES del sismo, así que cuenta como línea base."
        ),
        "limites": [
            "Los valores salen de una imagen con paleta de color, no de "
            "radiancia física: sirven para comparar noches en el mismo sitio, "
            "no como número absoluto.",
            "Las ciudades muy iluminadas saturan la medida y salen marcadas "
            "aparte: allí un apagón parcial no se distinguiría.",
            "El producto rellena huecos de nube con modelo. En zonas muy "
            "nubladas como el Chocó eso puede ser estimación, no observación.",
            "El archivo va con uno o dos días de rezago.",
        ],
        "municipios": filas,
    }
    _cache_guardar(clave, res)
    return res


# ── Cloudflare Radar (opcional, requiere llave gratuita) ────────────────────
#
# Es la fuente más rápida que existe para tráfico de internet a nivel país y
# operador: se actualiza en minutos, mientras IODA va en decenas de minutos y
# XM en días. Además publica cortes CONFIRMADOS y anotados a mano por su
# equipo, que es lo más cercano a una fuente autoritativa pública.
#
# No entra en la ruta crítica de HOPE a propósito: exige llave, y el sistema
# tiene que seguir funcionando sin ella. Si CLOUDFLARE_API_TOKEN está en el
# entorno se activa sola; si no, se dice que falta y se sigue.
#
# Llave gratuita: dash.cloudflare.com → My Profile → API Tokens → Create Token
# → permiso «Account · Radar · Read». No necesita dominio ni tarjeta.

RADAR = "https://api.cloudflare.com/client/v4/radar"


def _radar_get(ruta: str, params: dict) -> Any:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("sin_llave")
    url = f"{RADAR}/{ruta}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "User-Agent": "HOPE/0.3 (respuesta sismo Chocó)"})
    with urllib.request.urlopen(req, timeout=TIEMPO_ESPERA) as r:
        return json.loads(r.read().decode())


def radar_cloudflare(dias: int = 7) -> dict:
    """Cortes confirmados por Cloudflare y curva de tráfico de Colombia."""
    clave = f"radar_cf:{dias}"
    if (c := _cache_leer(clave, CACHE_PULSO_SEG)) is not None:
        return c

    if not os.environ.get("CLOUDFLARE_API_TOKEN", "").strip():
        return {
            "disponible": False,
            "motivo": "Falta CLOUDFLARE_API_TOKEN en el entorno.",
            "como_activar": "dash.cloudflare.com → My Profile → API Tokens → "
                            "Create Token → permiso «Account · Radar · Read». "
                            "Es gratis y no pide tarjeta. Ponerlo en .env.",
        }

    salida: dict[str, Any] = {"disponible": True, "fuente": "Cloudflare Radar",
                              "consultado": datetime.now(timezone.utc)
                                            .isoformat(timespec="seconds")}
    try:
        an = _radar_get("annotations/outages",
                        {"location": "CO", "dateRange": f"{dias}d", "limit": 25})
        salida["cortes_confirmados"] = [
            {"inicio": o.get("startDate"), "fin": o.get("endDate"),
             "alcance": o.get("scope"), "tipo": o.get("outageType"),
             "causa": o.get("outageCause"), "asn": o.get("asnDetails"),
             "descripcion": o.get("description")}
            for o in (an.get("result", {}).get("annotations") or [])
        ]
    except Exception as e:
        salida["error_cortes"] = f"{type(e).__name__}: {e}"

    try:
        ts = _radar_get("http/timeseries",
                        {"location": "CO", "dateRange": "1d", "aggInterval": "15m"})
        r = ts.get("result", {}).get("serie_0") or {}
        salida["trafico_http"] = {"tiempos": r.get("timestamps", []),
                                  "valores": r.get("values", []),
                                  "nota": "Índice relativo de peticiones HTTP "
                                          "vistas por Cloudflare, no volumen absoluto."}
    except Exception as e:
        salida["error_trafico"] = f"{type(e).__name__}: {e}"

    _cache_guardar(clave, salida)
    return salida
