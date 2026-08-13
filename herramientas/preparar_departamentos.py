"""
Prepara los límites reales de los departamentos de Colombia para el mapa.

Por qué existe este archivo
───────────────────────────
HOPE dibujaba cada departamento como un CÍRCULO centrado en un par de
coordenadas escritas a mano (Chocó en 5.75/-76.85, y así). Ese círculo no
existe: no es el borde del departamento, no es el alcance del corte, no es
nada. Y como el ojo lee un círculo en un mapa como «el problema está aquí
dentro», estaba afirmando una precisión que el dato no tiene.

Los datos de IODA son por DEPARTAMENTO COMPLETO y no hay forma de bajar de
ahí para Colombia. Un polígono del departamento dice exactamente eso: «en
algún punto de esta área, y no sabemos dónde». Es a la vez más honesto y más
preciso que el círculo.

Fuente: geoBoundaries (gbOpen), construido sobre OpenStreetMap.
    https://www.geoboundaries.org/  ·  licencia abierta, sin llave.

Uso:
    python herramientas/preparar_departamentos.py

Escribe web/data/departamentos.geojson. Solo hay que volver a correrlo si
cambian los límites administrativos, que es cosa de años.
"""

from __future__ import annotations

import json
import sys
import urllib.request
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.fuentes import DEPARTAMENTOS  # noqa: E402

FUENTE = ("https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/"
          "gbOpen/COL/ADM1/geoBoundaries-COL-ADM1_simplified.geojson")

SALIDA = Path(__file__).resolve().parent.parent / "web" / "data" / "departamentos.geojson"

# Tres decimales son ~110 m en el ecuador. Para pintar un departamento entero
# en una pantalla de celular eso sobra, y recorta el archivo a una fracción.
DECIMALES = 3

# Distancia mínima entre puntos consecutivos, en grados (~1,1 km). El contorno
# de un departamento tiene miles de vértices de detalle costero que a la escala
# a la que se mira esto no aportan nada y sí pesan.
PASO_MINIMO = 0.01


def normalizar(s: str) -> str:
    """Compara nombres ignorando tildes y mayúsculas: la fuente escribe
    'Bogotá D.C.' y 'Archipiélago de San Andrés' con variaciones."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower().replace(".", "").replace(",", "").strip()


# Nombres de geoBoundaries que no coinciden literalmente con los de IODA.
ALIAS = {
    "bogota dc": "Bogotá",
    "bogota distrito capital": "Bogotá",
    "santafe de bogota": "Bogotá",
    "archipielago de san andres providencia y santa catalina":
        "San Andrés y Providencia",
    "san andres y providencia": "San Andrés y Providencia",
    "valle": "Valle del Cauca",
    "norte de santander": "Norte de Santander",
}

POR_NOMBRE = {normalizar(m["nombre"]): cod for cod, m in DEPARTAMENTOS.items()}


def buscar_codigo(nombre: str) -> int | None:
    n = normalizar(nombre)
    if n in POR_NOMBRE:
        return POR_NOMBRE[n]
    if n in ALIAS:
        return POR_NOMBRE.get(normalizar(ALIAS[n]))
    # Último recurso: coincidencia por prefijo, para casos como
    # "Choco" contra "Chocó" que la normalización ya cubre, o nombres largos.
    for clave, cod in POR_NOMBRE.items():
        if n.startswith(clave) or clave.startswith(n):
            return cod
    return None


def adelgazar(anillo: list) -> list:
    """Quita vértices más cercanos que PASO_MINIMO, conservando siempre el
    primero y el último para no abrir el polígono."""
    if len(anillo) <= 4:
        return anillo
    salida = [anillo[0]]
    for x, y in anillo[1:-1]:
        ax, ay = salida[-1]
        if abs(x - ax) >= PASO_MINIMO or abs(y - ay) >= PASO_MINIMO:
            salida.append([x, y])
    salida.append(anillo[-1])
    # Un anillo necesita al menos 4 posiciones (la última repite la primera).
    return salida if len(salida) >= 4 else anillo


def limpiar(geom: dict) -> dict:
    """Redondea y adelgaza. Descarta los anillos que quedan degenerados: son
    islotes de pocos metros que a esta escala no se ven."""
    def anillo(a):
        return adelgazar([[round(p[0], DECIMALES), round(p[1], DECIMALES)] for p in a])

    if geom["type"] == "Polygon":
        anillos = [anillo(a) for a in geom["coordinates"]]
        return {"type": "Polygon", "coordinates": [a for a in anillos if len(a) >= 4]}

    if geom["type"] == "MultiPolygon":
        poligonos = []
        for pol in geom["coordinates"]:
            anillos = [anillo(a) for a in pol]
            anillos = [a for a in anillos if len(a) >= 4]
            if anillos:
                poligonos.append(anillos)
        return {"type": "MultiPolygon", "coordinates": poligonos}

    return geom


def main() -> None:
    print(f"Descargando {FUENTE.rsplit('/', 1)[-1]} …")
    req = urllib.request.Request(FUENTE, headers={"User-Agent": "HOPE/0.3"})
    crudo = urllib.request.urlopen(req, timeout=180).read()
    print(f"  {len(crudo) / 1024:.0f} KB de origen")

    entrada = json.loads(crudo)
    salida, sin_codigo = [], []

    for f in entrada["features"]:
        nombre = f["properties"].get("shapeName", "")
        codigo = buscar_codigo(nombre)
        if codigo is None:
            sin_codigo.append(nombre)
            continue
        salida.append({
            "type": "Feature",
            "properties": {
                "codigo": codigo,
                "nombre": DEPARTAMENTOS[codigo]["nombre"],
                "nombre_fuente": nombre,
            },
            "geometry": limpiar(f["geometry"]),
        })

    salida.sort(key=lambda f: f["properties"]["nombre"])
    doc = {
        "type": "FeatureCollection",
        "metadata": {
            "fuente": "geoBoundaries gbOpen ADM1 (sobre OpenStreetMap)",
            "url": FUENTE,
            "licencia": "Abierta. Atribución: geoBoundaries / OpenStreetMap.",
            "simplificacion": f"{DECIMALES} decimales, paso mínimo {PASO_MINIMO}°",
            "advertencia": (
                "Geometría simplificada para pintar en pantalla. NO usar para "
                "medir áreas, distancias ni definir jurisdicciones."
            ),
        },
        "features": salida,
    }

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    SALIDA.write_text(texto, encoding="utf-8")

    print(f"  {len(salida)} departamentos con código de IODA")
    if sin_codigo:
        print(f"  sin emparejar ({len(sin_codigo)}): {', '.join(sin_codigo)}")
    print(f"Escrito {SALIDA.relative_to(SALIDA.parent.parent.parent)} "
          f"— {len(texto) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
