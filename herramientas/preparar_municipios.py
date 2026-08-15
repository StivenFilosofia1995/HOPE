"""
Prepara el listado OFICIAL de municipios de Colombia con su punto de medición.

Por qué existe este archivo
───────────────────────────
La capa «pueblo por pueblo» usaba los 624 poblados que publica el producto
PAGER del USGS. Son datos excelentes —traen población y sacudida medida— pero
NO son la división administrativa del país: PAGER lista lugares poblados de un
gacetero, no municipios. Faltan municipios enteros y sobran corregimientos.

Y eso importa para lo único que hace falta: un alcalde, un CMGRD o un
ministerio trabajan por MUNICIPIO. Una lista que dice «Pie de Pato» cuando el
municipio se llama Alto Baudó no le sirve a quien tiene que firmar el despacho.

Este script cruza las dos cosas:

  · geoBoundaries ADM2 → los 1.122 municipios reales, con su nombre y su borde.
  · PAGER cities       → dónde está el casco urbano y cuánta gente vive ahí.

y escribe, para cada municipio, el mejor PUNTO DE MEDICIÓN disponible:

  origen "poblado"   — hay un lugar poblado de PAGER dentro del municipio. El
                       punto es el casco urbano y la luz nocturna medida ahí
                       significa algo.
  origen "centroide" — no lo hay. Se usa el centro geométrico del polígono, que
                       en el Chocó suele ser selva. Queda marcado, porque medir
                       luz nocturna en un centroide rural mide oscuridad de
                       monte, no un apagón, y confundir las dos cosas es
                       inventarse un corte.

El departamento se asigna por POLÍGONO, no por cercanía a un centroide: con
centroides, municipios de frontera caen en el departamento vecino.

Fuentes, ambas abiertas y sin llave:
    geoBoundaries (gbOpen, sobre OpenStreetMap) — https://www.geoboundaries.org/
    USGS PAGER (cities.json del evento)         — https://earthquake.usgs.gov/

Uso:
    python herramientas/preparar_municipios.py

Escribe web/data/municipios.json. Solo hay que repetirlo si cambian los
límites administrativos (cosa de años) o si el USGS reprocesa el evento.
"""

from __future__ import annotations

import json
import sys
import unicodedata
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.fuentes import DEPARTAMENTOS, _en_anillo  # noqa: E402

ADM2 = ("https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/"
        "gbOpen/COL/ADM2/geoBoundaries-COL-ADM2_simplified.geojson")

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "web" / "data" / "municipios.json"
DEPTOS = RAIZ / "web" / "data" / "departamentos.geojson"

# Un poblado de PAGER cuenta como casco urbano de este municipio si cae DENTRO
# de su polígono. Si no cae en ninguno (pasa en la costa, donde el borde
# simplificado se come penínsulas), se acepta el municipio más cercano dentro
# de este radio antes que perder el dato.
RESCATE_KM = 12


def normalizar(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower().replace(".", "").replace(",", "").strip()


# Conectores que no distinguen un municipio de otro.
VACIAS = {"de", "del", "la", "el", "los", "las", "y", "san", "santa"}


def mismo_lugar(nombre_muni: str, nombre_poblado: str) -> bool:
    """¿El lugar poblado que cayó dentro del polígono es su casco urbano?

    Hace falta preguntarlo porque los bordes de geoBoundaries vienen
    simplificados, y con un borde grueso el casco urbano del municipio VECINO
    cae dentro. Medido: pasa en 29 de 577. Mezclados hay dos casos muy
    distintos, y tratarlos igual sería un error en cualquiera de las dos
    direcciones:

      · variantes de escritura del mismo sitio — «Don Matías / Donmatias»,
        «El Carmen / El Carmen de Atrato», «El Litoral del San Juán (Docordó) /
        Santa Genoveva de Docordó». Son correctos y perderlos sería tirar
        mediciones buenas.
      · pueblos que no son — «Sotaquirá / Paipa», «Rondón / Zetaquira»,
        «Norcasia / Samaná». Aquí la luz medida es la de OTRO municipio.

    Se resuelve por palabras compartidas de cuatro letras o más, que es lo que
    separa los dos casos: las variantes siempre comparten el nombre propio y
    los pueblos distintos no comparten ninguno.
    """
    def piezas(s: str) -> set[str]:
        limpio = "".join(c if c.isalnum() else " " for c in normalizar(s))
        return {p for p in limpio.split() if len(p) >= 4 and p not in VACIAS}

    a, b = piezas(nombre_muni), piezas(nombre_poblado)
    if a & b:
        return True
    # Sin palabras largas en común, queda el caso de los nombres pegados:
    # «Peñol» contra «El Penol», «San Juan de Rioseco» contra «San Juan de Rio Seco».
    ja = "".join(ch for ch in normalizar(nombre_muni) if ch.isalnum())
    jb = "".join(ch for ch in normalizar(nombre_poblado) if ch.isalnum())
    return bool(ja and jb and (ja in jb or jb in ja))


def bajar(url: str, etiqueta: str) -> dict:
    print(f"Descargando {etiqueta} …")
    req = urllib.request.Request(url, headers={"User-Agent": "HOPE/0.4"})
    crudo = urllib.request.urlopen(req, timeout=300).read()
    print(f"  {len(crudo) / 1048576:.1f} MB")
    return json.loads(crudo)


def anillos(geom: dict) -> list:
    """Todos los contornos exteriores de una geometría, sin los huecos."""
    t, c = geom.get("type"), geom.get("coordinates") or []
    if t == "Polygon":
        return [c[0]] if c else []
    if t == "MultiPolygon":
        return [p[0] for p in c if p]
    return []


def area_centroide(anillo: list) -> tuple[float, float, float]:
    """Área con signo y centroide por la fórmula del polígono (shoelace)."""
    a = cx = cy = 0.0
    n = len(anillo)
    for i in range(n):
        x1, y1 = anillo[i][0], anillo[i][1]
        x2, y2 = anillo[(i + 1) % n][0], anillo[(i + 1) % n][1]
        cruz = x1 * y2 - x2 * y1
        a += cruz
        cx += (x1 + x2) * cruz
        cy += (y1 + y2) * cruz
    a *= 0.5
    if abs(a) < 1e-12:
        xs = [p[0] for p in anillo]
        ys = [p[1] for p in anillo]
        return 0.0, sum(xs) / len(xs), sum(ys) / len(ys)
    return abs(a), cx / (6 * a), cy / (6 * a)


def punto_representativo(geom: dict) -> tuple[float, float]:
    """Centroide del anillo más grande. Un municipio con islas o con forma de
    media luna no debe quedar representado por su isla ni por el hueco."""
    mejor = (-1.0, 0.0, 0.0)
    for an in anillos(geom):
        a, x, y = area_centroide(an)
        if a > mejor[0]:
            mejor = (a, x, y)
    return mejor[2], mejor[1]        # lat, lon


def caja(geom: dict) -> tuple[float, float, float, float]:
    xs, ys = [], []
    for an in anillos(geom):
        for p in an:
            xs.append(p[0])
            ys.append(p[1])
    return min(xs), min(xs and ys), max(xs), max(ys)


def dentro(lat: float, lon: float, geom: dict) -> bool:
    return any(_en_anillo(lat, lon, an) for an in anillos(geom))


def km(lat1, lon1, lat2, lon2) -> float:
    import math
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def pager_ciudades() -> list[dict]:
    det = bajar("https://earthquake.usgs.gov/fdsnws/event/1/query"
                "?format=geojson&eventid=us6000tjl2", "detalle del evento USGS")
    lp = det["properties"]["products"]["losspager"][0]
    url = (lp["contents"].get("json/cities.json")
           or lp["contents"]["cities.json"])["url"]
    return bajar(url, "PAGER cities.json")["all_cities"]


def main() -> None:
    adm2 = bajar(ADM2, "geoBoundaries ADM2 (municipios)")
    munis = adm2["features"]
    print(f"  {len(munis)} municipios")

    if not DEPTOS.is_file():
        sys.exit("Falta web/data/departamentos.geojson. "
                 "Corre antes preparar_departamentos.py.")
    deptos = json.loads(DEPTOS.read_text(encoding="utf-8"))["features"]

    ciudades = pager_ciudades()
    print(f"  {len(ciudades)} lugares poblados de PAGER")

    # ── Preparación: caja y punto de cada municipio ─────────────────────────
    registros = []
    for f in munis:
        g = f["geometry"]
        lat, lon = punto_representativo(g)
        xs = [p[0] for an in anillos(g) for p in an]
        ys = [p[1] for an in anillos(g) for p in an]
        registros.append({
            "nombre": (f["properties"].get("shapeName") or "").strip(),
            "geom": g,
            "bbox": (min(xs), min(ys), max(xs), max(ys)),
            "lat_centro": round(lat, 4),
            "lon_centro": round(lon, 4),
            "poblado": None,
        })

    # ── Cada lugar poblado, a su municipio ──────────────────────────────────
    # La caja filtra primero: sin eso son 624 × 1.122 pruebas de polígono.
    sin_municipio = 0
    for c in ciudades:
        try:
            clat, clon = float(c["lat"]), float(c["lon"])
        except (TypeError, ValueError, KeyError):
            continue
        elegido = None
        for r in registros:
            x0, y0, x1, y1 = r["bbox"]
            if not (x0 <= clon <= x1 and y0 <= clat <= y1):
                continue
            if dentro(clat, clon, r["geom"]):
                elegido = r
                break
        if elegido is None:
            # El borde simplificado se come penínsulas y deja fuera cascos
            # urbanos costeros. Antes de perder el dato, el más cercano.
            cerca = min(registros,
                        key=lambda r: km(clat, clon, r["lat_centro"], r["lon_centro"]))
            if km(clat, clon, cerca["lat_centro"], cerca["lon_centro"]) <= RESCATE_KM:
                elegido = cerca
            else:
                sin_municipio += 1
                continue
        # Si ya había uno, gana el de más población: es el casco urbano.
        pob = int(c.get("pop") or 0)
        if elegido["poblado"] is None or pob > elegido["poblado"]["poblacion"]:
            elegido["poblado"] = {"nombre": (c.get("name") or "").strip(),
                                  "lat": round(clat, 4), "lon": round(clon, 4),
                                  "poblacion": pob}

    # ── Departamento por polígono ───────────────────────────────────────────
    salida, sin_depto = [], []
    for r in registros:
        lat = r["poblado"]["lat"] if r["poblado"] else r["lat_centro"]
        lon = r["poblado"]["lon"] if r["poblado"] else r["lon_centro"]

        cod = None
        for d in deptos:
            if dentro(lat, lon, d["geometry"]):
                cod = d["properties"]["codigo"]
                break
        if cod is None:                      # costa e islas: el más cercano
            mejor, mdist = None, 1e9
            for d in deptos:
                m = DEPARTAMENTOS.get(d["properties"]["codigo"])
                if not m:
                    continue
                dd = km(lat, lon, m["lat"], m["lon"])
                if dd < mdist:
                    mejor, mdist = d["properties"]["codigo"], dd
            cod = mejor
            sin_depto.append(r["nombre"])

        # Un casco urbano cuyo nombre no se parece al del municipio es, casi
        # siempre, el pueblo de al lado que se coló por un borde simplificado.
        # Se conserva la coordenada, pero marcada: medir su luz sería atribuirle
        # a este municipio el alumbrado de otro.
        if not r["poblado"]:
            punto = "centroide"
        elif mismo_lugar(r["nombre"], r["poblado"]["nombre"]):
            punto = "poblado"
        else:
            punto = "aproximado"

        salida.append({
            "nombre": r["nombre"],
            "depto": cod,
            "departamento": DEPARTAMENTOS.get(cod, {}).get("nombre", ""),
            "lat": lat, "lon": lon,
            # De dónde salió el punto. Cambia por completo si la luz nocturna
            # medida ahí significa algo o es oscuridad de monte.
            "punto": punto,
            "poblacion": r["poblado"]["poblacion"] if r["poblado"] else None,
            # El nombre del casco urbano solo se guarda si aporta algo. muchos
            # nombres de geoBoundaries ya lo traen dentro —«Alto Baudó (Pie De
            # Pato)»— y repetirlo daba «Alto Baudó (Pie De Pato) (Pie de Pato)».
            "nombre_poblado": (r["poblado"]["nombre"] if r["poblado"] and
                               normalizar(r["poblado"]["nombre"])
                               not in normalizar(r["nombre"]) else ""),
        })

    salida.sort(key=lambda m: (m["departamento"], m["nombre"]))

    con_poblado = sum(1 for m in salida if m["punto"] == "poblado")
    aprox = sum(1 for m in salida if m["punto"] == "aproximado")
    doc = {
        "_meta": {
            "que_es": "Los 1.122 municipios de Colombia con su mejor punto de "
                      "medición disponible.",
            "fuentes": ["geoBoundaries gbOpen ADM2 (sobre OpenStreetMap)",
                        "USGS PAGER cities.json del evento us6000tjl2"],
            "url_adm2": ADM2,
            "punto_poblado": (
                "El municipio tiene un lugar poblado de PAGER dentro de su "
                "polígono: el punto es el casco urbano y la luz nocturna medida "
                "ahí significa algo."),
            "punto_centroide": (
                "No lo tiene. Se usa el centro geométrico del polígono, que en "
                "zonas rurales suele ser monte. La luz nocturna medida ahí NO se "
                "puede leer como apagón: mide oscuridad de selva. Queda marcado "
                "para que el sistema no lo confunda."),
            "advertencia_poblacion": (
                "La población es la del LUGAR POBLADO de PAGER, no la del "
                "municipio entero: no incluye la zona rural. Sirve para ordenar "
                "por magnitud, no como censo."),
            "punto_aproximado": (
                "El lugar poblado que cayó dentro del polígono tiene un nombre "
                "que no se parece al del municipio: con bordes simplificados, "
                "eso suele ser el casco urbano del municipio VECINO. Se conserva "
                "la coordenada pero NO se mide luz allí, porque sería atribuirle "
                "a este municipio el alumbrado de otro."),
            "con_punto_poblado": con_poblado,
            "con_punto_aproximado": aprox,
            "con_centroide": len(salida) - con_poblado - aprox,
            "total": len(salida),
        },
        "municipios": salida,
    }

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    SALIDA.write_text(texto, encoding="utf-8")

    print(f"\n  {con_poblado} municipios con casco urbano identificado")
    print(f"  {aprox} con punto aproximado (el nombre no coincide: seguramente el vecino)")
    print(f"  {len(salida) - con_poblado - aprox} solo con centroide (luz no interpretable)")
    if sin_municipio:
        print(f"  {sin_municipio} lugares de PAGER sin municipio (fuera del país o islas)")
    if sin_depto:
        print(f"  {len(sin_depto)} asignados al departamento más cercano: "
              f"{', '.join(sin_depto[:6])}"
              + (" …" if len(sin_depto) > 6 else ""))
    print(f"Escrito {SALIDA.relative_to(RAIZ)} — {len(texto) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
