"""
HOPE — backend de la capa de reportes.

FastAPI + SQLite (stdlib, sin ORM). Guarda puntos georreferenciados y los sirve
como GeoJSON para que el mapa los consuma sin traducción intermedia.

Levantar:
    uvicorn backend.main:app --reload --port 8000

Con eso queda todo servido en http://127.0.0.1:8000 — el frontend estático
también, montado en la raíz.

ALCANCE: pensado para correr en la máquina de quien coordina, o en una red
interna de confianza. No tiene autenticación. No exponerlo a internet tal cual.
"""

from __future__ import annotations

import csv
import io
import json
import os
import secrets
import sqlite3
import sys
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import fuentes

# ── Rutas ───────────────────────────────────────────────────────────────────

RAIZ = Path(__file__).resolve().parent.parent
DIR_WEB = RAIZ / "web"
DIR_DATOS = RAIZ / "data"
BD = DIR_DATOS / "hope.db"


def cargar_env() -> None:
    """Lee .env si existe. Las variables ya presentes en el entorno ganan, que es
    lo que hace falta en Railway: allí no hay archivo, hay entorno."""
    archivo = RAIZ / ".env"
    if not archivo.is_file():
        return
    for linea in archivo.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, _, valor = linea.partition("=")
        clave, valor = clave.strip(), valor.strip().strip('"').strip("'")
        os.environ.setdefault(clave, valor)


cargar_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

# ── Control de escritura ────────────────────────────────────────────────────
#
# La capa de reportes es de COORDINACIÓN INTERNA: apuntes de quien está
# organizando la respuesta. Leerla es abierto; escribirla no puede serlo si el
# servicio está en internet, porque un DELETE sin llave borra el trabajo de
# alguien en mitad de una emergencia.
#
# La regla es segura por defecto y no rompe el desarrollo local:
#
#   HOPE_TOKEN definido  →  POST/PUT/DELETE exigen la cabecera X-HOPE-Token.
#   HOPE_TOKEN vacío     →  solo se acepta escritura desde la propia máquina.
#                           Desde internet se responde 503 explicando cómo
#                           activarlo. Nunca se queda abierto sin querer.
#
# La lectura, el mapa y todas las fuentes de cortes siguen abiertos en los dos
# casos: son datos públicos y no se pierde nada si alguien los consulta.

HOPE_TOKEN = os.environ.get("HOPE_TOKEN", "").strip()
LOCALES = {"127.0.0.1", "::1", "localhost", "testclient"}


def exigir_escritura(peticion: Request) -> None:
    """Portero de las rutas que modifican datos. Lanza 401/503 si no procede."""
    if HOPE_TOKEN:
        entregado = (peticion.headers.get("X-HOPE-Token") or "").strip()
        # compare_digest evita filtrar la llave por diferencias de tiempo.
        if entregado and secrets.compare_digest(entregado, HOPE_TOKEN):
            return
        raise HTTPException(401, "Falta o no coincide la cabecera X-HOPE-Token.")

    # Una petición que llegó por un proxy NUNCA es local, aunque el peer lo
    # parezca. Sin esta comprobación, un despliegue cuyo proxy hable con el
    # contenedor por loopback dejaría la escritura abierta a internet entera.
    tras_proxy = any(peticion.headers.get(h) for h in
                     ("x-forwarded-for", "x-real-ip", "forwarded"))
    anfitrion = (peticion.client.host if peticion.client else "") or ""
    if anfitrion in LOCALES and not tras_proxy:
        return

    raise HTTPException(
        503,
        "Escritura deshabilitada: este servicio está expuesto a internet y no "
        "tiene HOPE_TOKEN configurado. Define la variable de entorno HOPE_TOKEN "
        "(en Railway: Variables del servicio) y vuelve a intentarlo. La lectura "
        "y el mapa siguen funcionando.",
    )

# ── Catálogos: deben coincidir con los de web/app.js ─────────────────────────

TIPOS = ("rescate", "salud", "estructural", "refugio", "agua",
         "alimentos", "vias", "servicios", "enlace", "recurso", "otro")
PRIORIDADES = ("critica", "alta", "media", "baja")
ESTADOS = ("nuevo", "verificado", "en_atencion", "atendido", "descartado")
FUENTES = ("llamada", "whatsapp", "terreno", "radio", "redes", "oficial", "otro")

Tipo = Literal[TIPOS]           # type: ignore[valid-type]
Prioridad = Literal[PRIORIDADES]  # type: ignore[valid-type]
Estado = Literal[ESTADOS]       # type: ignore[valid-type]
Fuente = Literal[FUENTES]       # type: ignore[valid-type]

# ── Base de datos ───────────────────────────────────────────────────────────

ESQUEMA = """
CREATE TABLE IF NOT EXISTS reportes (
    id             TEXT PRIMARY KEY,
    lat            REAL NOT NULL,
    lon            REAL NOT NULL,
    tipo           TEXT NOT NULL,
    prioridad      TEXT NOT NULL,
    estado         TEXT NOT NULL,
    municipio      TEXT NOT NULL DEFAULT '',
    personas       INTEGER NOT NULL DEFAULT 0,
    descripcion    TEXT NOT NULL DEFAULT '',
    fuente         TEXT NOT NULL DEFAULT 'otro',
    contacto       TEXT NOT NULL DEFAULT '',
    verificado     INTEGER NOT NULL DEFAULT 0,
    creado_en      TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reportes_estado    ON reportes(estado);
CREATE INDEX IF NOT EXISTS ix_reportes_prioridad ON reportes(prioridad);
CREATE INDEX IF NOT EXISTS ix_reportes_creado    ON reportes(creado_en);
"""


@contextmanager
def conexion() -> Iterator[sqlite3.Connection]:
    con = sqlite3.connect(BD)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


def iniciar_bd() -> None:
    DIR_DATOS.mkdir(parents=True, exist_ok=True)
    with conexion() as con:
        # WAL: permite leer mientras se escribe. Útil si alguien consulta el mapa
        # mientras otra persona está capturando reportes.
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(ESQUEMA)


def ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── Modelos ─────────────────────────────────────────────────────────────────

class ReporteEntrada(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    tipo: Tipo = "otro"
    prioridad: Prioridad = "media"
    estado: Estado = "nuevo"
    municipio: str = Field("", max_length=120)
    personas: int = Field(0, ge=0, le=1_000_000)
    descripcion: str = Field("", max_length=2000)
    fuente: Fuente = "otro"
    contacto: str = Field("", max_length=160)
    verificado: bool = False

    @field_validator("municipio", "descripcion", "contacto")
    @classmethod
    def _limpiar(cls, v: str) -> str:
        return v.strip()


class Reporte(ReporteEntrada):
    id: str
    creado_en: str
    actualizado_en: str


# ── App ─────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def ciclo_vida(_: FastAPI):
    iniciar_bd()
    fuentes.configurar_cache(str(BD))
    yield


app = FastAPI(
    lifespan=ciclo_vida,
    title="HOPE — capa de reportes",
    description=(
        "Captura y consulta de puntos georreferenciados para la respuesta al "
        "sismo M7.4 del 10 de agosto de 2026 (Chocó, Colombia).\n\n"
        "**Los reportes con `verificado=false` son información sin confirmar.** "
        "No deben tratarse como hechos ni entregarse como tales a un equipo de "
        "rescate: un despacho hacia un punto falso es capacidad que se le quita "
        "a un punto real."
    ),
    version="0.1.0",
)

# Los límites de los departamentos son 312 KB de GeoJSON y comprimen a una
# fracción: es texto con muchísimos números repetidos. Quien abre esto suele
# estar en la zona del desastre, con la red a medias — ahorrarle 250 KB no es
# una optimización cosmética.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Abierto porque en desarrollo el frontend suele servirse desde otro puerto
# (p. ej. `python -m http.server` en web/). Cerrar antes de cualquier despliegue.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ── Serialización GeoJSON ───────────────────────────────────────────────────

def a_feature(f: sqlite3.Row, incluir_contacto: bool) -> dict:
    props = {
        "id": f["id"],
        "tipo": f["tipo"],
        "prioridad": f["prioridad"],
        "estado": f["estado"],
        "municipio": f["municipio"],
        "personas": f["personas"],
        "descripcion": f["descripcion"],
        "fuente": f["fuente"],
        "verificado": bool(f["verificado"]),
        "creado_en": f["creado_en"],
        "actualizado_en": f["actualizado_en"],
    }
    if incluir_contacto:
        props["contacto"] = f["contacto"]
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [f["lon"], f["lat"]]},
        "properties": props,
    }


def a_dict(f: sqlite3.Row) -> dict:
    d = dict(f)
    d["verificado"] = bool(d["verificado"])
    return d


def consultar(
    tipo: Optional[str] = None,
    prioridad: Optional[str] = None,
    estado: Optional[str] = None,
    solo_verificados: bool = False,
) -> list[sqlite3.Row]:
    sql = "SELECT * FROM reportes WHERE 1=1"
    params: list = []
    if tipo:
        sql += " AND tipo = ?"
        params.append(tipo)
    if prioridad:
        sql += " AND prioridad = ?"
        params.append(prioridad)
    if estado:
        sql += " AND estado = ?"
        params.append(estado)
    if solo_verificados:
        sql += " AND verificado = 1"
    sql += " ORDER BY creado_en DESC"
    with conexion() as con:
        return con.execute(sql, params).fetchall()


# ── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/api/salud", tags=["sistema"])
def salud() -> dict:
    """Sonda que usa el frontend para decidir si hay backend o cae a localStorage."""
    with conexion() as con:
        n = con.execute("SELECT COUNT(*) AS n FROM reportes").fetchone()["n"]
    return {"ok": True, "reportes": n, "bd": str(BD), "hora": ahora()}


@app.get("/api/reportes", tags=["reportes"])
def listar(
    tipo: Optional[Tipo] = None,
    prioridad: Optional[Prioridad] = None,
    estado: Optional[Estado] = None,
    solo_verificados: bool = False,
    incluir_contacto: bool = Query(True, description="Datos personales. Poner en false para entregas."),
) -> dict:
    filas = consultar(tipo, prioridad, estado, solo_verificados)
    return {
        "type": "FeatureCollection",
        "metadata": {
            "generado_en": ahora(),
            "total": len(filas),
            "contacto_incluido": incluir_contacto,
            "advertencia": "Los reportes con verificado=false NO están confirmados.",
        },
        "features": [a_feature(f, incluir_contacto) for f in filas],
    }


@app.post("/api/reportes", response_model=Reporte, status_code=201, tags=["reportes"],
          dependencies=[Depends(exigir_escritura)])
def crear(r: ReporteEntrada) -> dict:
    t = ahora()
    fila = {**r.model_dump(), "id": uuid.uuid4().hex[:12], "creado_en": t, "actualizado_en": t}
    cols = ", ".join(fila)
    marc = ", ".join(f":{c}" for c in fila)
    with conexion() as con:
        con.execute(f"INSERT INTO reportes ({cols}) VALUES ({marc})",
                    {**fila, "verificado": int(fila["verificado"])})
    return fila


@app.put("/api/reportes/{id_reporte}", response_model=Reporte, tags=["reportes"],
         dependencies=[Depends(exigir_escritura)])
def actualizar(id_reporte: str, r: ReporteEntrada) -> dict:
    with conexion() as con:
        actual = con.execute("SELECT * FROM reportes WHERE id = ?", (id_reporte,)).fetchone()
        if actual is None:
            raise HTTPException(404, "Reporte no encontrado")
        datos = {**r.model_dump(), "actualizado_en": ahora()}
        asigna = ", ".join(f"{c} = :{c}" for c in datos)
        con.execute(f"UPDATE reportes SET {asigna} WHERE id = :id",
                    {**datos, "verificado": int(datos["verificado"]), "id": id_reporte})
        return a_dict(con.execute("SELECT * FROM reportes WHERE id = ?", (id_reporte,)).fetchone())


@app.delete("/api/reportes/{id_reporte}", status_code=204, tags=["reportes"],
            dependencies=[Depends(exigir_escritura)])
def eliminar(id_reporte: str) -> Response:
    with conexion() as con:
        cur = con.execute("DELETE FROM reportes WHERE id = ?", (id_reporte,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Reporte no encontrado")
    return Response(status_code=204)


@app.get("/api/reportes.geojson", tags=["entrega"])
def descargar_geojson(incluir_contacto: bool = False, solo_verificados: bool = False) -> Response:
    """Archivo listo para entregar a UNGRD / CMGRD / Cruz Roja. Se abre en QGIS."""
    filas = consultar(solo_verificados=solo_verificados)
    gj = {
        "type": "FeatureCollection",
        "metadata": {
            "generado_por": "HOPE — mapa base sismo M7.4 Chocó",
            "generado_en": ahora(),
            "evento_usgs": "us6000tjl2",
            "total": len(filas),
            "contacto_incluido": incluir_contacto,
            "advertencia": "Reportes ciudadanos sin verificación independiente salvo verificado=true.",
        },
        "features": [a_feature(f, incluir_contacto) for f in filas],
    }
    nombre = f"hope_reportes_{datetime.now(timezone.utc):%Y%m%d_%H%M}.geojson"
    return Response(
        content=json.dumps(gj, ensure_ascii=False, indent=2),
        media_type="application/geo+json",
        headers={"Content-Disposition": f'attachment; filename="{nombre}"'},
    )


@app.get("/api/reportes.csv", tags=["entrega"])
def descargar_csv(incluir_contacto: bool = False) -> Response:
    filas = consultar()
    cols = ["id", "lat", "lon", "tipo", "prioridad", "estado", "municipio", "personas",
            "descripcion", "fuente", "verificado", "creado_en", "actualizado_en"]
    if incluir_contacto:
        cols.append("contacto")

    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for f in filas:
        w.writerow({c: dict(f)[c] for c in cols})

    nombre = f"hope_reportes_{datetime.now(timezone.utc):%Y%m%d_%H%M}.csv"
    return Response(
        content="﻿" + buf.getvalue(),   # BOM para Excel en Windows
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{nombre}"'},
    )


@app.get("/api/estadisticas", tags=["reportes"])
def estadisticas() -> dict:
    with conexion() as con:
        def agrupar(col: str) -> dict:
            # `col` nunca viene del usuario: sale de la tupla literal de abajo.
            return {r[col]: r["n"] for r in
                    con.execute(f"SELECT {col}, COUNT(*) AS n FROM reportes GROUP BY {col}")}

        total = con.execute("SELECT COUNT(*) AS n FROM reportes").fetchone()["n"]
        personas = con.execute(
            "SELECT COALESCE(SUM(personas), 0) AS n FROM reportes "
            "WHERE estado NOT IN ('atendido', 'descartado')").fetchone()["n"]
        sin_verificar = con.execute(
            "SELECT COUNT(*) AS n FROM reportes WHERE verificado = 0").fetchone()["n"]
        por = {c: agrupar(c) for c in ("tipo", "prioridad", "estado")}

    return {
        "total": total,
        "sin_verificar": sin_verificar,
        "personas_pendientes": personas,
        "por_tipo": por["tipo"],
        "por_prioridad": por["prioridad"],
        "por_estado": por["estado"],
    }


# ── Cortes de internet y energía: datos medidos, de fuentes externas ────────
#
# Se sirven a través del backend y no directo desde el navegador por dos
# razones: XM solo acepta POST y no manda CORS, y así queda una sola caché
# compartida en vez de una por pestaña abierta.

@app.get("/api/cortes/vivo", tags=["cortes"])
def cortes_vivo(horas: int = Query(3, ge=1, le=48)) -> dict:
    """**Vista principal.** Estado de la red AHORA en las zonas del sismo.

    Lee las series crudas de IODA (se actualizan cada 5-10 minutos) y compara
    cada zona contra su propia línea base de hace 7 días. Cruza dos señales:

    - **acceso** (`ping-slash24`): la última milla, el router de la casa.
    - **troncal** (`bgp`): las rutas que el operador anuncia al mundo.

    Si cae el acceso y el troncal aguanta, la fibra está bien y lo que falta es
    ENERGÍA. Si caen los dos, es corte de red. Esa distinción cambia qué se
    manda a la zona, y ninguna fuente la da por separado.
    """
    try:
        return fuentes.pulso_vivo(horas)
    except Exception as e:
        raise HTTPException(502, f"IODA no respondió: {type(e).__name__}: {e}")


@app.get("/api/informe", tags=["entrega"], response_class=Response)
def informe(
    horas: int = Query(3, ge=1, le=48),
    url_mapa: str = Query("", max_length=300),
) -> Response:
    """Parte de situación en texto plano, listo para pegar en WhatsApp o correo.

    Es la pieza que convierte esto en algo que le sirve a alguien: un GeoJSON no
    se lee en un celular de madrugada, un mensaje sí. Lleva la hora, el rezago
    de cada fuente y la advertencia de que no es un despacho — porque quien lo
    reenvíe no la va a agregar.
    """
    texto = fuentes.parte_situacion(horas, url_mapa.strip())
    return Response(content=texto, media_type="text/plain; charset=utf-8")


@app.get("/api/cortes/operadores", tags=["cortes"])
def cortes_operadores(horas: int = Query(3, ge=1, le=48)) -> dict:
    """Estado por operador (Claro, Tigo-UNE, Movistar, ETB, Starlink…).

    Responde a la pregunta que separa un problema de zona de uno de proveedor:
    si un solo ASN está degradado, es del operador; si están todos en la misma
    zona, es de la zona.
    """
    try:
        return fuentes.pulso_operadores(horas)
    except Exception as e:
        raise HTTPException(502, f"IODA no respondió: {type(e).__name__}: {e}")


@app.get("/api/cortes/luces", tags=["cortes"])
def cortes_luces() -> dict:
    """Capa de luces nocturnas VIIRS (NASA): qué pueblo se quedó a oscuras.

    Es el dato de energía con mejor resolución espacial que existe sin llave
    (~500 m, cada noche) y el único que no espera los dos días de rezago de XM.
    Devuelve la plantilla de teselas; el navegador las pide directo a la NASA.
    """
    return fuentes.luces_nocturnas()


@app.get("/api/cortes/luz-municipios", tags=["cortes"])
def luz_municipios(noches: int = Query(3, ge=1, le=7)) -> dict:
    """**Energía a escala de municipio**, por satélite. Lo más fino que hay.

    Compara la luz nocturna de cada pueblo contra sus propias noches previas al
    sismo, usando el producto VIIRS corregido por luna y atmósfera. Es la única
    fuente del sistema que baja del departamento para energía: XM publica por
    área operativa con dos días de rezago y IODA no baja del departamento.

    Ojo con las fechas: el satélite pasa a la 1:30 de la madrugada y el sismo
    fue a las 7:34, así que la imagen del 10 de agosto es LÍNEA BASE.
    """
    archivo = DIR_WEB / "data" / "ciudades.json"
    if not archivo.is_file():
        raise HTTPException(503, "Falta web/data/ciudades.json")
    try:
        crudo = json.loads(archivo.read_text(encoding="utf-8"))
        municipios = [
            {"nombre": c["nombre"], "departamento": c.get("departamento", ""),
             "lat": float(c["lat"]), "lon": float(c["lon"])}
            for c in crudo.get("ciudades", []) if c.get("lat") and c.get("lon")
        ]
    except Exception as e:
        raise HTTPException(500, f"No se pudo leer el catálogo: {type(e).__name__}: {e}")

    try:
        return fuentes.luces_municipios(municipios, noches)
    except Exception as e:
        raise HTTPException(502, f"GIBS no respondió: {type(e).__name__}: {e}")


@app.get("/api/cortes/radar", tags=["cortes"])
def cortes_radar(dias: int = Query(7, ge=1, le=28)) -> dict:
    """Cortes confirmados y tráfico en vivo de Cloudflare Radar.

    Opcional: si no hay `CLOUDFLARE_API_TOKEN` en el entorno devuelve
    `disponible: false` con las instrucciones, sin romper nada.
    """
    try:
        return fuentes.radar_cloudflare(dias)
    except Exception as e:
        raise HTTPException(502, f"Cloudflare Radar no respondió: {type(e).__name__}: {e}")


@app.get("/api/cortes/internet", tags=["cortes"])
def cortes_internet(horas: int = Query(96, ge=1, le=720)) -> dict:
    """Score de corte de internet por departamento (IODA, Georgia Tech).

    El score ordena zonas entre sí; no es un porcentaje de población sin
    servicio. Granularidad máxima disponible en Colombia: departamento.
    """
    desde, hasta = fuentes.ventana_horas(horas)
    try:
        return fuentes.ioda_resumen(desde, hasta)
    except Exception as e:
        raise HTTPException(502, f"IODA no respondió: {type(e).__name__}: {e}")


@app.get("/api/cortes/internet/{codigo}", tags=["cortes"])
def cortes_internet_detalle(codigo: int, horas: int = Query(96, ge=1, le=720)) -> dict:
    """Eventos individuales de corte, con hora de inicio y duración reales."""
    if codigo not in fuentes.DEPARTAMENTOS:
        raise HTTPException(404, "Código de departamento desconocido")
    desde, hasta = fuentes.ventana_horas(horas)
    try:
        return fuentes.ioda_eventos(codigo, desde, hasta)
    except Exception as e:
        raise HTTPException(502, f"IODA no respondió: {type(e).__name__}: {e}")


@app.get("/api/cortes/energia", tags=["cortes"])
def cortes_energia(dias: int = Query(20, ge=2, le=31)) -> dict:
    """Energía no entregada por falla, por área operativa (XM).

    Rezago de publicación observado: aproximadamente un día.
    """
    hasta = date.today()
    desde = hasta - timedelta(days=dias)
    try:
        return fuentes.xm_no_atendida(desde, hasta)
    except Exception as e:
        raise HTTPException(502, f"XM no respondió: {type(e).__name__}: {e}")


@app.get("/api/cortes/prioridad", tags=["cortes"])
def cortes_prioridad(horas: int = Query(96, ge=1, le=720)) -> dict:
    """Ordenamiento de zonas por evidencia de corte, para decidir a dónde
    llevar enlaces satelitales. Cruza IODA con XM."""
    desde, hasta = fuentes.ventana_horas(horas)
    try:
        return fuentes.prioridad_enlaces(desde, hasta)
    except Exception as e:
        raise HTTPException(502, f"Fuentes no disponibles: {type(e).__name__}: {e}")


@app.get("/api/cortes/sondas", tags=["cortes"])
def cortes_sondas() -> dict:
    """Sondas RIPE Atlas: puntos individuales reales con coordenadas exactas,
    no un promedio por departamento. Complementa a IODA con más resolución."""
    try:
        return fuentes.ripe_atlas_colombia()
    except Exception as e:
        raise HTTPException(502, f"RIPE Atlas no respondió: {type(e).__name__}: {e}")


@app.get("/api/sismos/recientes", tags=["sismos"])
def sismos_recientes(
    dias: int = Query(7, ge=1, le=30),
    mag_min: float = Query(3.0, ge=0, le=10),
) -> dict:
    """Sismos recientes en Colombia (catálogo USGS, ventana rodante).

    No es la capa de réplicas del mapa (esa mira fijo desde el 10 de agosto
    alrededor del epicentro): esta ventana se mueve con el tiempo y cubre todo
    el país, para detectar un sismo nuevo aunque no sea réplica de este.
    """
    try:
        return fuentes.usgs_sismos_recientes(dias, mag_min)
    except Exception as e:
        raise HTTPException(502, f"USGS no respondió: {type(e).__name__}: {e}")


@app.get("/api/clima", tags=["clima"])
def clima() -> dict:
    """Precipitación actual y a 24 h en departamentos con daño reportado
    (Open-Meteo). Lluvia intensa complica el acceso vial a zonas ya afectadas."""
    try:
        return fuentes.clima_zonas_afectadas()
    except Exception as e:
        raise HTTPException(502, f"Open-Meteo no respondió: {type(e).__name__}: {e}")


@app.get("/api/config", tags=["sistema"])
def config_publica() -> dict:
    """Configuración que el navegador necesita.

    La anon key de Supabase es pública por diseño: va en el cliente y está
    protegida por Row Level Security, no por secreto. La `service_role`
    NO se expone aquí ni en ningún otro sitio del frontend — esa salta RLS.
    """
    return {
        "supabase_url": SUPABASE_URL,
        "supabase_anon_key": SUPABASE_ANON_KEY,
        "configurado": bool(SUPABASE_URL and SUPABASE_ANON_KEY),
        "evento_usgs": "us6000tjl2",
        # El frontend necesita saberlo para pedir la llave ANTES de que la
        # persona escriba un apunte y lo pierda contra un 401.
        "escritura_con_token": bool(HOPE_TOKEN),
    }


@app.get("/api", include_in_schema=False)
def raiz_api() -> JSONResponse:
    return JSONResponse({"servicio": "HOPE", "docs": "/docs", "salud": "/api/salud"})


# El frontend estático va montado al final para no tapar las rutas /api.
if DIR_WEB.is_dir():
    app.mount("/", StaticFiles(directory=str(DIR_WEB), html=True), name="web")


# ── Datos de prueba ─────────────────────────────────────────────────────────

def sembrar_ejemplos() -> None:
    """Puntos ficticios para probar filtros y exportación. Van marcados como
    EJEMPLO para que nadie los confunda con un reporte real."""
    ejemplos = [
        (4.8956, -76.2289, "rescate", "critica", "nuevo", "San José del Palmar", 4,
         "EJEMPLO — dato de prueba, no es un reporte real.", "radio", False),
        (5.6947, -76.6611, "salud", "alta", "verificado", "Quibdó", 30,
         "EJEMPLO — dato de prueba, no es un reporte real.", "oficial", True),
        (5.0689, -75.5174, "estructural", "alta", "en_atencion", "Manizales", 0,
         "EJEMPLO — dato de prueba, no es un reporte real.", "terreno", True),
        (3.4516, -76.5320, "refugio", "media", "nuevo", "Cali", 120,
         "EJEMPLO — dato de prueba, no es un reporte real.", "whatsapp", False),
        (4.8133, -75.6961, "vias", "media", "atendido", "Pereira", 0,
         "EJEMPLO — dato de prueba, no es un reporte real.", "redes", False),
    ]
    iniciar_bd()
    t = ahora()
    with conexion() as con:
        for lat, lon, tipo, pri, est, mun, per, desc, fte, ver in ejemplos:
            con.execute(
                "INSERT INTO reportes (id, lat, lon, tipo, prioridad, estado, municipio, "
                "personas, descripcion, fuente, contacto, verificado, creado_en, actualizado_en) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,'',?,?,?)",
                (uuid.uuid4().hex[:12], lat, lon, tipo, pri, est, mun, per, desc, fte,
                 int(ver), t, t))
    print(f"Sembrados {len(ejemplos)} reportes de EJEMPLO en {BD}")


if __name__ == "__main__":
    if "--sembrar" in sys.argv:
        sembrar_ejemplos()
    else:
        print(__doc__)
