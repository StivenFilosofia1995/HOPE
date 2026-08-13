"""
HOPE — conectores a fuentes REALES de corte de internet y energía.

Ninguna función de este módulo inventa, simula ni interpola datos. Si una fuente
no responde, se devuelve el error; no se rellena con estimaciones.

Fuentes (ambas públicas, sin llave de API, verificadas el 2026-08-12):

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

Advertencia de interpretación, importante:
  Una señal DÉBIL de corte no significa "esa zona está bien". Puede significar
  que allí casi no hay infraestructura que medir. Chocó es el caso exacto: es el
  epicentro y su score IODA es 58, dos órdenes de magnitud por debajo de Valle
  del Cauca, porque hay muy poca conectividad de base. Ahí es donde un enlace
  satelital aporta más, no menos. Ver `interpretar_cobertura()`.
"""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

IODA = "https://api.ioda.inetintel.cc.gatech.edu/v2"
XM = "https://servapibi.xm.com.co"
TIEMPO_ESPERA = 45
CACHE_SEG = 600          # 10 min: suficiente para no martillar, poco para servir rancio

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


def _cache_leer(clave: str) -> Optional[Any]:
    if not _BD:
        return None
    try:
        with sqlite3.connect(_BD) as con:
            f = con.execute("SELECT cuerpo, ts FROM cache_fuentes WHERE clave = ?",
                            (clave,)).fetchone()
        if f and (time.time() - f[1]) < CACHE_SEG:
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

def _get(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "HOPE/0.2 (respuesta sismo Chocó)"})
    with urllib.request.urlopen(req, timeout=TIEMPO_ESPERA) as r:
        return json.loads(r.read().decode())


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
            "departamentos": [DEPARTAMENTOS[d]["nombre"]
                              for d in geo.get("deptos", []) if d in DEPARTAMENTOS],
            "serie_kwh": serie,
            "pico_kwh": pico,
            "pico_fecha": pico_fecha,
            "linea_base_kwh": round(lb, 1),
            "veces_sobre_base": round(pico / lb, 1) if lb else None,
        })
    areas_salida.sort(key=lambda x: -(x["pico_kwh"] or 0))

    res = {
        "fuente": "XM — Sistema Interconectado Nacional",
        "metrica": "DemaNoAtenNoProg (energía no entregada por falla, kWh)",
        "desde": desde.isoformat(), "hasta": hasta.isoformat(),
        "consultado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
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
