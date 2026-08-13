"""
Verifica que el esquema de Supabase quedó bien aplicado y, sobre todo, que las
políticas de seguridad hacen lo que dicen.

    python supabase/verificar.py

Usa SOLO la anon key —la misma que va en el navegador— porque la pregunta que
importa es exactamente esa: qué puede hacer un desconocido con la llave pública.

La prueba crítica es la de `contactos`. Si esa lectura NO devuelve error, hay
una fuga de datos personales y el sistema no debe publicarse.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def cargar_env() -> None:
    archivo = RAIZ / ".env"
    if not archivo.is_file():
        return
    for linea in archivo.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if linea and not linea.startswith("#") and "=" in linea:
            k, _, v = linea.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


cargar_env()
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
ANON = os.environ.get("SUPABASE_ANON_KEY", "")

if not URL or not ANON:
    sys.exit("Faltan SUPABASE_URL o SUPABASE_ANON_KEY (revisa .env)")


def pedir(metodo: str, ruta: str, cuerpo=None, prefer=None):
    h = {"apikey": ANON, "Authorization": f"Bearer {ANON}",
         "Content-Type": "application/json", "User-Agent": "HOPE-verificador/1.0"}
    if prefer:
        h["Prefer"] = prefer
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(URL + ruta, data=datos, headers=h, method=metodo)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            texto = r.read().decode()
            return r.status, (json.loads(texto) if texto.strip() else None)
    except urllib.error.HTTPError as e:
        texto = e.read().decode()
        try:
            return e.code, json.loads(texto)
        except Exception:
            return e.code, texto


fallos, avisos = [], []


def check(nombre, cond, detalle="", critico=True):
    marca = "OK    " if cond else ("FALLA " if critico else "AVISO ")
    print(f"  {marca} {nombre}" + (f"  →  {detalle}" if detalle else ""))
    if not cond:
        (fallos if critico else avisos).append(nombre)


print(f"\nProyecto: {URL}")
print("Llave:    anon (la pública, la que va en el navegador)\n")

print("── 1. ¿Existen las tablas? " + "─" * 40)
existen = True
for tabla in ("zonas", "aportes"):
    est, cuerpo = pedir("GET", f"/rest/v1/{tabla}?select=id&limit=1")
    ok = est == 200
    existen = existen and ok
    check(f"{tabla} legible", ok, f"HTTP {est}" + ("" if ok else f" {cuerpo}"))

# Sin tablas, todo lo demás devuelve 404 y las pruebas de seguridad pasarían
# por el motivo equivocado: "nadie puede leer los contactos" es trivialmente
# cierto si la tabla no existe. Un verificador que da OK así es peor que no
# tenerlo, porque genera confianza infundada. Se corta aquí.
if not existen:
    print("\n" + "=" * 62)
    print("El esquema todavía no está aplicado.")
    print("Aplica supabase/schema.sql en el SQL Editor de Supabase y")
    print("vuelve a correr esto. Las pruebas de seguridad NO se ejecutaron:")
    print("sin tablas darían 'OK' sin haber comprobado nada.")
    print("=" * 62)
    sys.exit(1)

print("\n── 2. LA PRUEBA QUE IMPORTA: contactos no se puede leer " + "─" * 8)
est, cuerpo = pedir("GET", "/rest/v1/contactos?select=*&limit=1")
fuga = est == 200
check("contactos NO es legible con la anon key", not fuga,
      f"HTTP {est}" + (f"  ¡¡FUGA DE DATOS PERSONALES!!  {cuerpo}" if fuga
                       else "  (denegado, que es lo correcto)"))

print("\n── 3. Escritura pública: cualquiera puede reportar " + "─" * 14)
zona = {
    "tipo": "sin_internet",
    "titulo": "PRUEBA AUTOMATICA — borrar",
    "descripcion": "Fila creada por supabase/verificar.py. No es un reporte real.",
    "municipio": "Prueba", "departamento": "Prueba",
    "lat": 4.8436, "lon": -76.2422, "radio_m": 500,
    "personas_estimadas": 0, "urgencia": 4,
    "verificado": False, "estado": "nuevo",
}
est, cuerpo = pedir("POST", "/rest/v1/zonas", zona, prefer="return=representation")
creada = est in (200, 201) and cuerpo
check("anon puede INSERTAR una zona", bool(creada), f"HTTP {est}")
zona_id = cuerpo[0]["id"] if creada and isinstance(cuerpo, list) else None

print("\n── 4. Nadie anónimo puede alterar lo ajeno " + "─" * 22)
if zona_id:
    est, cuerpo = pedir("PATCH", f"/rest/v1/zonas?id=eq.{zona_id}",
                        {"estado": "resuelto"}, prefer="return=representation")
    # PostgREST devuelve 200 con lista vacía cuando RLS no deja tocar ninguna fila.
    sin_efecto = est in (401, 403, 404) or (est == 200 and not cuerpo)
    check("anon NO puede hacer UPDATE", sin_efecto,
          f"HTTP {est}" + ("" if sin_efecto else f"  ¡puede editar!  {cuerpo}"))

    est, cuerpo = pedir("DELETE", f"/rest/v1/zonas?id=eq.{zona_id}",
                        prefer="return=representation")
    sin_efecto = est in (401, 403, 404) or (est in (200, 204) and not cuerpo)
    check("anon NO puede hacer DELETE", sin_efecto,
          f"HTTP {est}" + ("" if sin_efecto else "  ¡puede borrar!"))

print("\n── 5. No se puede colar un reporte pre-verificado " + "─" * 16)
est, cuerpo = pedir("POST", "/rest/v1/zonas",
                    {**zona, "titulo": "PRUEBA verificado", "verificado": True},
                    prefer="return=representation")
check("rechaza verificado=true al insertar", est not in (200, 201),
      f"HTTP {est}" + (" (aceptado — la policy no está filtrando)" if est in (200, 201) else ""))

print("\n── 6. Validaciones de datos " + "─" * 37)
est, _ = pedir("POST", "/rest/v1/zonas", {**zona, "lat": 48.85, "lon": 2.35})
check("rechaza coordenadas fuera de Colombia", est not in (200, 201), f"HTTP {est}")
est, _ = pedir("POST", "/rest/v1/zonas", {**zona, "titulo": "x"})
check("rechaza título demasiado corto", est not in (200, 201), f"HTTP {est}")

print("\n── 7. Contactos: se puede escribir aunque no leer " + "─" * 16)
if zona_id:
    est, _ = pedir("POST", "/rest/v1/contactos",
                   {"zona_id": zona_id, "nombre": "Prueba", "telefono": "0000000"})
    check("anon puede INSERTAR un contacto", est in (200, 201, 204), f"HTTP {est}")

print("\n" + "=" * 62)
if fallos:
    print("FALLOS CRÍTICOS:", ", ".join(fallos))
    print("\nNO publiques el sistema hasta resolverlos.")
elif avisos:
    print("Sin fallos críticos. Avisos:", ", ".join(avisos))
else:
    print("Todo correcto. El modelo de permisos hace lo que dice.")

if zona_id:
    print(f"\nQuedó una fila de prueba (id {zona_id}). Bórrala desde el editor")
    print("de Supabase — a propósito no se puede borrar con la anon key:")
    print("  delete from public.zonas where titulo like 'PRUEBA%';")

print("=" * 62)
sys.exit(1 if fallos else 0)
