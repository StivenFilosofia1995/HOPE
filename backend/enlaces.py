"""
HOPE — sala de enlaces: redacta las peticiones de conectividad.

Qué hace y qué NO hace, porque la diferencia importa:

  SÍ  · redacta automáticamente una carta distinta para cada destinatario, con
        los datos MEDIDOS de este momento dentro: qué municipios, cuánta gente,
        y si lo que falta es energía o es red.
  SÍ  · entrega la carta lista para enviar (mailto, archivo .eml, o copiar).
  NO  · envía nada por su cuenta.

Lo último es una decisión de diseño, no una limitación técnica:

  1. Una carta que sale de la dirección de una persona real, con su nombre y su
     teléfono, la lee alguien. Un envío masivo desde un servidor desconocido
     cae en spam o en el filtro corporativo, y quema el único contacto que hay.
     En una emergencia no se tiene un segundo intento con TSF ni con el ETC.
  2. Estas cartas piden recursos en nombre de comunidades reales. Quien firma
     tiene que haber leído lo que firma.

Por eso el sistema escribe las 20 cartas en un segundo y deja el botón de
enviar en manos de quien responde por ellas.

── Lo que hace útil este directorio ──────────────────────────────────────────

No es una lista de correos. Es un mapa de QUIÉN PUEDE PEDIRLE QUÉ A QUIÉN, que
es la parte que no se encuentra buscando en Google y la que hace que una
petición llegue a alguien con mandato para responderla:

  · `directo`            — se les escribe y ellos deciden. Es el caso de las
                           ONG de telecomunicaciones de emergencia.
  · `via_estado`         — solo actúan a petición de un Estado miembro. La UIT
                           despliega terminales satelitales en 24-48 h, pero
                           únicamente si lo pide el gobierno. Escribirles
                           directo como particular no activa nada: la carta
                           tiene que ir al MinTIC pidiéndole que ELLOS lo pidan.
  · `via_organizacion`   — donan a organizaciones verificadas, no a personas.

Cada contacto lleva cómo se obtuvo y cuándo. Los que no se pudieron verificar
van marcados como tales, con el enlace a su canal oficial, en vez de inventar
una dirección: una carta a un correo adivinado no rebota — se pierde en
silencio, que es peor.
"""

from __future__ import annotations

import io
import zipfile
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any, Optional

from . import fuentes

TZ_CO = timezone(timedelta(hours=-5))

# ── Grupos: el orden es el orden en que conviene escribirles ────────────────

GRUPOS: dict[str, dict[str, str]] = {
    "humanitario": {
        "titulo": "Telecomunicaciones de emergencia",
        "por_que": "Su mandato ES este: llevar conectividad a una zona de "
                   "desastre. No hay que convencerlos de la causa, solo darles "
                   "datos suficientes para priorizar. Es el grupo con más "
                   "probabilidad de respuesta y por donde conviene empezar.",
    },
    "estado": {
        "titulo": "Entidades del Estado colombiano",
        "por_que": "Son las únicas que pueden activar los mecanismos "
                   "internacionales. La UIT despliega equipos solo a petición "
                   "de un Estado miembro, y el Convenio de Tampere —del que "
                   "Colombia es parte— existe justo para esto. Sin una carta "
                   "aquí, la mitad del resto del directorio es inalcanzable.",
    },
    "satelite": {
        "titulo": "Operadores satelitales",
        "por_que": "Son los que pueden dar servicio donde no queda "
                   "infraestructura terrestre: los puntos ciegos. Casi todos "
                   "canalizan sus donaciones a través de organizaciones ya "
                   "verificadas, no de particulares.",
    },
    "telco": {
        "titulo": "Operadores de red en Colombia",
        "por_que": "Tienen la infraestructura y las cuadrillas en el terreno. "
                   "A ellos no se les pide que inventen nada: se les señala "
                   "dónde está su propia red por debajo de lo normal, medido "
                   "por un tercero independiente.",
    },
    "socorro": {
        "titulo": "Organismos de socorro",
        "por_que": "No dan internet, pero son quienes están en el terreno y "
                   "quienes pueden confirmar o desmentir lo que mide el mapa. "
                   "Además, un enlace satelital donado necesita a alguien que "
                   "lo instale y lo cuide.",
    },
}

HOY = "2026-08-15"

# ── Directorio ──────────────────────────────────────────────────────────────
#
# `estado`: "verificado" = la dirección se comprobó contra la página oficial en
# la fecha indicada. "por_verificar" = NO se pudo confirmar un correo; va el
# canal oficial (formulario o página de contacto) y se dice claramente. Nunca
# se inventa una dirección para rellenar el hueco.

DESTINATARIOS: list[dict[str, Any]] = [
    # ── Humanitario ─────────────────────────────────────────────────────────
    {
        "id": "tsf",
        "nombre": "Télécoms Sans Frontières (TSF)",
        "grupo": "humanitario",
        "idioma": "en",
        "pide": "directo",
        "canal": "correo",
        "valor": "info@tsfi.org",
        "estado": "verificado",
        "fuente": "https://www.tsfi.org/en/contact-us",
        "verificado_el": HOY,
        "puede_dar": "Equipos de ingenieros de telecomunicaciones con terminales "
                     "satelitales propias. Despliegan en menos de 24 h y montan "
                     "centros de llamadas y wifi para la población afectada.",
        "clave": "Es la primera carta que hay que mandar. Es una ONG cuyo único "
                 "objeto es este, no una empresa a la que haya que convencer.",
    },
    {
        "id": "etc_wfp",
        "nombre": "Emergency Telecommunications Cluster (ETC) — PMA/WFP",
        "grupo": "humanitario",
        "idioma": "en",
        "pide": "directo",
        "canal": "correo",
        "valor": "global.etc@wfp.org",
        "estado": "verificado",
        "fuente": "https://www.etcluster.org/contacts",
        "verificado_el": HOY,
        "puede_dar": "Coordinación del clúster de telecomunicaciones de "
                     "emergencia del sistema humanitario internacional, y "
                     "servicios de conectividad compartidos para la respuesta.",
        "clave": "El ETC se activa normalmente cuando el gobierno lo solicita o "
                 "cuando se activa el sistema de clústeres. Escribirles sirve "
                 "para poner el caso sobre la mesa aunque no esté activado.",
    },
    {
        "id": "nethope",
        "nombre": "NetHope",
        "grupo": "humanitario",
        "idioma": "en",
        "pide": "directo",
        "canal": "correo",
        "valor": "communications@nethope.org",
        "estado": "verificado",
        "fuente": "https://nethope.org/get-involved/contact/",
        "verificado_el": HOY,
        "puede_dar": "Coordina a las grandes empresas de tecnología para "
                     "respuesta a desastres: equipos de red, terminales y "
                     "conectividad donada por sus miembros.",
        "clave": "La dirección verificada es la de comunicaciones — su propia "
                 "página la ofrece para respuesta a emergencias. Pedir en el "
                 "primer párrafo que se redirija al equipo de Emergency Response.",
    },
    {
        "id": "itu",
        "nombre": "Unión Internacional de Telecomunicaciones (UIT/ITU)",
        "grupo": "humanitario",
        "idioma": "en",
        "pide": "via_estado",
        "canal": "pagina",
        "valor": "https://www.itu.int/en/ITU-D/Emergency-Telecommunications/Pages/Response.aspx",
        "estado": "por_verificar",
        "fuente": "https://www.itu.int/en/ITU-D/Emergency-Telecommunications/Pages/Response.aspx",
        "verificado_el": HOY,
        "puede_dar": "Teléfonos satelitales Iridium y terminales BGAN de banda "
                     "ancha, desplegados en las primeras 24-48 h, más "
                     "capacitación para los equipos locales.",
        "clave": "IMPORTANTE: la UIT despliega SOLO a petición de un Estado "
                 "miembro. En Tonga la petición la hizo el ministerio; en "
                 "Nicaragua, el regulador y la agencia nacional de desastres. "
                 "Como particular no se activa nada escribiéndoles: la carta "
                 "efectiva es la que va al MinTIC y a la UNGRD pidiéndoles que "
                 "sean ELLOS quienes lo soliciten. Esa carta ya está redactada "
                 "en este mismo paquete.",
    },
    {
        "id": "gsma_hcc",
        "nombre": "GSMA — Humanitarian Connectivity Charter",
        "grupo": "humanitario",
        "idioma": "en",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.gsma.com/solutions-and-impact/connectivity-for-good/"
                 "mobile-for-development/mobile-for-humanitarian-innovation/"
                 "humanitarian-connectivity-charter/",
        "estado": "por_verificar",
        "fuente": "https://www.gsma.com/solutions-and-impact/connectivity-for-good/"
                  "mobile-for-development/mobile-for-humanitarian-innovation/"
                  "humanitarian-connectivity-charter/",
        "verificado_el": HOY,
        "puede_dar": "Es el acuerdo por el que 160 operadores móviles de 112 "
                     "países se comprometieron a coordinar su respuesta ante "
                     "desastres. Puede mover a los operadores colombianos "
                     "firmantes desde dentro de la industria.",
        "clave": "Vale la pena preguntarles primero cuáles de los operadores "
                 "colombianos son firmantes: a un firmante se le puede recordar "
                 "un compromiso público, que pesa más que una petición suelta.",
    },

    # ── Estado colombiano ───────────────────────────────────────────────────
    {
        "id": "mintic",
        "nombre": "MinTIC — Ministerio de Tecnologías de la Información",
        "grupo": "estado",
        "idioma": "es",
        "pide": "directo",
        "canal": "correo",
        "valor": "minticresponde@mintic.gov.co",
        "estado": "verificado",
        "fuente": "https://www.mintic.gov.co/portal/inicio/Atencion-y-Servicio-a-la-Ciudadania/"
                  "Transparencia/162459:Mecanismos-de-contacto",
        "verificado_el": HOY,
        "puede_dar": "Es la entidad que puede solicitar formalmente el "
                     "despliegue de la UIT, coordinar a los operadores y "
                     "autorizar el uso de espectro para enlaces de emergencia.",
        "clave": "La carta más importante del paquete. Un derecho de petición "
                 "tiene plazo legal de respuesta en Colombia; una solicitud "
                 "suelta, no.",
    },
    {
        "id": "ungrd",
        "nombre": "UNGRD — Unidad Nacional para la Gestión del Riesgo de Desastres",
        "grupo": "estado",
        "idioma": "es",
        "pide": "directo",
        "canal": "correo",
        "valor": "contactenos@gestiondelriesgo.gov.co",
        "copia": "correspondencia@gestiondelriesgo.gov.co",
        "estado": "verificado",
        "fuente": "https://portal.gestiondelriesgo.gov.co/Paginas/Slide_home/"
                  "Respuestas-Atencion-al-Ciudadano.aspx",
        "verificado_el": HOY,
        "puede_dar": "Coordina la Sala de Crisis Nacional y es la contraparte "
                     "natural de los mecanismos internacionales de asistencia.",
        "clave": "Es también el destinatario que le da sentido a todo el mapa: "
                 "sin un organismo que reciba los datos, esto es una pantalla "
                 "bonita. Ofrecerles el acceso, no solo pedirles.",
    },
    {
        "id": "crc",
        "nombre": "CRC — Comisión de Regulación de Comunicaciones",
        "grupo": "estado",
        "idioma": "es",
        "pide": "directo",
        "canal": "correo",
        "valor": "atencioncliente@crcom.gov.co",
        "estado": "verificado",
        "fuente": "https://www.crcom.gov.co/en/node/620",
        "verificado_el": HOY,
        "puede_dar": "El regulador. En Nicaragua fue el regulador quien "
                     "canalizó la petición a la UIT junto con la agencia de "
                     "desastres.",
        "clave": "Es el camino alterno si el MinTIC no responde a tiempo.",
    },

    # ── Satélite ────────────────────────────────────────────────────────────
    {
        "id": "starlink",
        "nombre": "Starlink (SpaceX)",
        "grupo": "satelite",
        "idioma": "en",
        "pide": "via_organizacion",
        "canal": "pagina",
        "valor": "https://www.starlink.com/support",
        "estado": "por_verificar",
        "fuente": "https://www.starlink.com/support",
        "verificado_el": HOY,
        "puede_dar": "Terminales y servicio. Tiene antecedentes claros: 30 días "
                     "de servicio gratuito en las zonas del huracán Helene y "
                     "entregas de kits a equipos de respuesta en los incendios "
                     "de California.",
        "clave": "SpaceX canaliza donaciones hacia organizaciones de respuesta "
                 "VERIFICADAS, y aplica los programas de emergencia por zona, no "
                 "por solicitud individual. La vía que funciona es que la "
                 "petición la firme o la respalde la Cruz Roja Colombiana, la "
                 "Defensa Civil o la UNGRD. Este sistema no publica ningún "
                 "correo de Starlink porque los que circulan por internet no "
                 "son oficiales: el canal real es el soporte de su web y, sobre "
                 "todo, un organismo de socorro que ya esté en su lista.",
    },
    {
        "id": "viasat",
        "nombre": "Viasat (incluye Inmarsat)",
        "grupo": "satelite",
        "idioma": "en",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.viasat.com/about/contact-us/",
        "estado": "por_verificar",
        "fuente": "https://www.viasat.com/about/contact-us/",
        "verificado_el": HOY,
        "puede_dar": "Terminales BGAN de Inmarsat: son justo las que despliega "
                     "la UIT en estos casos, y funcionan con batería en un sitio "
                     "sin energía.",
        "clave": "Mencionar BGAN por su nombre: es el equipo concreto que se "
                 "usa en respuesta a desastres y evita que la carta acabe en "
                 "ventas residenciales.",
    },
    {
        "id": "ses",
        "nombre": "SES",
        "grupo": "satelite",
        "idioma": "en",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.ses.com/contact-us",
        "estado": "por_verificar",
        "fuente": "https://www.ses.com/contact-us",
        "verificado_el": HOY,
        "puede_dar": "Capacidad satelital de banda ancha; tiene programa de "
                     "respuesta humanitaria y trabaja con agencias de la ONU.",
        "clave": "",
    },
    {
        "id": "intelsat",
        "nombre": "Intelsat",
        "grupo": "satelite",
        "idioma": "en",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.intelsat.com/contact-us/",
        "estado": "por_verificar",
        "fuente": "https://www.intelsat.com/contact-us/",
        "verificado_el": HOY,
        "puede_dar": "Capacidad satelital y enlaces de respaldo para operadores "
                     "y para respuesta de emergencia.",
        "clave": "",
    },
    {
        "id": "hughes",
        "nombre": "Hughes / HughesNet Colombia",
        "grupo": "satelite",
        "idioma": "es",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.hughes.com.co/contactenos",
        "estado": "por_verificar",
        "fuente": "https://www.hughes.com.co/",
        "verificado_el": HOY,
        "puede_dar": "Ya opera internet satelital en Colombia, incluida "
                     "conectividad rural. Tiene equipos e instaladores EN el país.",
        "clave": "Ventaja sobre los operadores extranjeros: no hay que importar "
                 "nada ni esperar aduana.",
    },

    # ── Telcos ──────────────────────────────────────────────────────────────
    {
        "id": "claro",
        "nombre": "Claro Colombia",
        "grupo": "telco",
        "idioma": "es",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.claro.com.co/institucional/contactenos/",
        "estado": "por_verificar",
        "fuente": "https://www.claro.com.co/institucional/",
        "verificado_el": HOY,
        "puede_dar": "La mayor red del país (AS10620). Cuadrillas, plantas "
                     "eléctricas para sus nodos y roaming de emergencia.",
        "clave": "A los operadores conviene escribirles por el canal "
                 "institucional o de relaciones corporativas, no por soporte al "
                 "cliente: soporte no puede autorizar nada de esto.",
    },
    {
        "id": "tigo",
        "nombre": "Tigo Colombia (UNE / EPM Telecomunicaciones)",
        "grupo": "telco",
        "idioma": "es",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.tigo.com.co/atencion-al-cliente",
        "estado": "por_verificar",
        "fuente": "https://www.tigo.com.co/",
        "verificado_el": HOY,
        "puede_dar": "AS13489. Fuerte presencia en Antioquia y el eje cafetero, "
                     "justo la zona sacudida.",
        "clave": "",
    },
    {
        "id": "movistar",
        "nombre": "Movistar Colombia (Colombia Telecomunicaciones)",
        "grupo": "telco",
        "idioma": "es",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.movistar.co/atencion-al-cliente",
        "estado": "por_verificar",
        "fuente": "https://www.movistar.co/",
        "verificado_el": HOY,
        "puede_dar": "AS3816. Telefónica tiene un programa corporativo de "
                     "respuesta a emergencias a nivel de grupo.",
        "clave": "",
    },
    {
        "id": "etb",
        "nombre": "ETB — Empresa de Telecomunicaciones de Bogotá",
        "grupo": "telco",
        "idioma": "es",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://etb.com/contactenos",
        "estado": "por_verificar",
        "fuente": "https://etb.com/",
        "verificado_el": HOY,
        "puede_dar": "AS19429. Empresa con participación pública: sensible a "
                     "una solicitud institucional.",
        "clave": "",
    },
    {
        "id": "wom",
        "nombre": "WOM Colombia",
        "grupo": "telco",
        "idioma": "es",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.wom.co/ayuda/",
        "estado": "por_verificar",
        "fuente": "https://www.wom.co/",
        "verificado_el": HOY,
        "puede_dar": "Cuarto operador móvil del país.",
        "clave": "",
    },

    # ── Socorro ─────────────────────────────────────────────────────────────
    {
        "id": "cruz_roja",
        "nombre": "Cruz Roja Colombiana",
        "grupo": "socorro",
        "idioma": "es",
        "pide": "directo",
        "canal": "correo",
        "valor": "donaciones@cruzrojacolombiana.org",
        "estado": "verificado",
        "fuente": "https://www.cruzrojacolombiana.org/",
        "verificado_el": HOY,
        "puede_dar": "Presencia en terreno para instalar y custodiar un enlace "
                     "donado, y —esto es lo decisivo— el respaldo institucional "
                     "que exigen SpaceX y otros para entregar equipos.",
        "clave": "Es la llave de Starlink. Sin una organización verificada que "
                 "respalde la petición, la vía de donación no se abre.",
    },
    {
        "id": "defensa_civil",
        "nombre": "Defensa Civil Colombiana",
        "grupo": "socorro",
        "idioma": "es",
        "pide": "directo",
        "canal": "pagina",
        "valor": "https://www.defensacivil.gov.co/",
        "estado": "por_verificar",
        "fuente": "https://www.defensacivil.gov.co/",
        "verificado_el": HOY,
        "puede_dar": "Red de voluntarios con radiocomunicaciones propias en "
                     "todo el país, incluidas zonas rurales sin cobertura.",
        "clave": "Sus radioaficionados pueden confirmar en horas si un punto "
                 "ciego del mapa está realmente incomunicado.",
    },
]


def _por_id(dest_id: str) -> Optional[dict]:
    return next((d for d in DESTINATARIOS if d["id"] == dest_id), None)


def directorio() -> dict:
    """El directorio, con el recuento de lo que está listo para enviar hoy."""
    listos = [d for d in DESTINATARIOS if d["estado"] == "verificado"
              and d["canal"] == "correo"]
    return {
        "generado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "grupos": GRUPOS,
        "total": len(DESTINATARIOS),
        "con_correo_verificado": len(listos),
        "como_leer": (
            "«verificado» = la dirección se comprobó contra la página oficial "
            "de la organización en la fecha indicada. «por verificar» = no se "
            "encontró un correo público y va el canal oficial en su lugar. No "
            "se inventa ninguna dirección: una carta a un correo adivinado no "
            "rebota, se pierde en silencio."
        ),
        "destinatarios": DESTINATARIOS,
    }


# ── La evidencia que va dentro de cada carta ────────────────────────────────

def reunir_evidencia(mmi_min: float = 5.0, horas: int = 3) -> dict:
    """Consulta el estado AHORA y lo resume en las cifras que van en la carta.

    Todo lo que la carta afirma sale de aquí, y todo lo de aquí sale de una
    consulta hecha en este momento. Si una fuente no responde, la carta lo dice
    en vez de callarlo: una petición con una cifra inventada dentro se cae
    entera en cuanto alguien la comprueba.
    """
    mapa = fuentes.mapa_precision(mmi_min, horas)
    lugares = mapa["lugares"]

    def top(clases: tuple[str, ...], n: int = 12) -> list[dict]:
        return [{"nombre": l["nombre"], "departamento": l["departamento"],
                 "poblacion": l["poblacion"], "mmi": l["mmi"],
                 "lat": round(l["lat"], 4), "lon": round(l["lon"], 4),
                 "necesita": l["necesita"]}
                for l in lugares if l["clase"] in clases][:n]

    ciegos = top(("punto_ciego",))
    sin_luz = top(("sin_luz", "sin_luz_y_sin_red"))
    sin_red = top(("sin_red", "sin_luz_y_sin_red"))

    # Que el epicentro esté entre los puntos ciegos pesa en una carta, pero hay
    # que mirarlo en la lista COMPLETA: las de arriba van recortadas a 12 y San
    # José del Palmar es pequeño, así que cae fuera del corte y la carta
    # dejaría de decir lo más contundente que tiene.
    epicentro_ciego = any("Palmar" in l["nombre"] for l in lugares
                          if l["clase"] == "punto_ciego")

    r = mapa["resumen"]
    return {
        "consultado": mapa["consultado"],
        "resumen": r,
        "deriva_luz": mapa.get("deriva_luz", {}),
        "fallos": mapa.get("fallos", {}),
        "puntos_ciegos": ciegos,
        "sin_luz": sin_luz,
        "sin_red": sin_red,
        "personas_ciegas": r.get("poblacion_en_puntos_ciegos", 0),
        "personas_expuestas": r.get("poblacion_expuesta", 0),
        "epicentro_ciego": epicentro_ciego,
    }


def _mil(n: int) -> str:
    """Miles con punto, como se escriben en Colombia. Se formatea SOLO el
    número: aplicarle el reemplazo a la frase entera convertía las comas de
    'Quibdó, Chocó' y las de las coordenadas en puntos."""
    return f"{n:,}".replace(",", ".")


def _lista(lugares: list[dict], n: int = 8) -> str:
    if not lugares:
        return "  (ninguno en esta consulta)"
    filas = []
    for l in lugares[:n]:
        dep = f", {l['departamento']}" if l["departamento"] else ""
        filas.append(f"  - {l['nombre']}{dep} — {_mil(l['poblacion'])} hab., "
                     f"intensidad MMI {l['mmi']:.1f} ({l['lat']}, {l['lon']})")
    if len(lugares) > n:
        filas.append(f"  - (y {len(lugares) - n} más en el mapa)")
    return "\n".join(filas)


def _lista_en(lugares: list[dict], n: int = 8) -> str:
    if not lugares:
        return "  (none in this query)"
    filas = []
    for l in lugares[:n]:
        dep = f", {l['departamento']}" if l["departamento"] else ""
        filas.append(f"  - {l['nombre']}{dep} — pop. {l['poblacion']:,}, "
                     f"shaking intensity MMI {l['mmi']:.1f} ({l['lat']}, {l['lon']})")
    if len(lugares) > n:
        filas.append(f"  - (and {len(lugares) - n} more on the map)")
    return "\n".join(filas)


METODO_ES = (
    "CÓMO SE MIDIÓ, Y QUÉ NO SE PUEDE AFIRMAR\n"
    "  - Sacudida y población: producto PAGER/ShakeMap del USGS para el evento\n"
    "    {evento}. La intensidad está interpolada en la coordenada de cada\n"
    "    municipio, no promediada por departamento.\n"
    "  - Energía: banda día-noche VIIRS de la NASA (Black Marble corregido),\n"
    "    resolución ~610 m. A cada porcentaje se le descontó la deriva del\n"
    "    satélite ({deriva}%), medida en {n_control} municipios que apenas\n"
    "    temblaron: sin esa resta, la fase lunar y las nubes se leen como\n"
    "    apagón. Aun así, una noche muy nublada limita la medida.\n"
    "  - Red: IODA (Georgia Tech), series de 5-10 minutos, comparadas contra la\n"
    "    misma ventana horaria de hace 7 días. Su granularidad máxima en\n"
    "    Colombia es el DEPARTAMENTO: no distingue un municipio de otro.\n"
    "  - Sondas físicas: RIPE Atlas. Son decenas de puntos en todo el país.\n"
    "\n"
    "  Nada de esto sustituye una verificación en terreno, y los «puntos\n"
    "  ciegos» son por definición lugares sobre los que NO tenemos medición:\n"
    "  se listan porque nadie los ha mirado, no porque se sepa que están mal.\n"
    "  Es exactamente por eso que son la prioridad."
)

METODO_EN = (
    "HOW THIS WAS MEASURED, AND WHAT IT CANNOT CLAIM\n"
    "  - Shaking and population: USGS PAGER/ShakeMap product for event\n"
    "    {evento}. Intensity is interpolated at each populated place's own\n"
    "    coordinates, not averaged over a province.\n"
    "  - Power: NASA VIIRS day-night band (BRDF-corrected Black Marble), ~610 m\n"
    "    resolution. Each percentage has the satellite's own drift ({deriva}%)\n"
    "    subtracted, measured across {n_control} municipalities that barely shook —\n"
    "    without that correction, moon phase and clouds read as a blackout.\n"
    "    Heavy cloud cover still limits the measurement.\n"
    "  - Network: IODA (Georgia Tech), 5-10 minute series compared against the\n"
    "    same hourly window 7 days earlier. Its finest granularity in Colombia\n"
    "    is the PROVINCE: it cannot tell one municipality from another.\n"
    "  - Physical probes: RIPE Atlas — a few dozen points nationwide.\n"
    "\n"
    "  None of this replaces verification on the ground, and the \"blind spots\"\n"
    "  are by definition places we have NO measurement for. They are listed\n"
    "  because nobody has looked at them, not because we know they are cut off.\n"
    "  That is precisely why they rank first."
)


def _firma(rem: dict, idioma: str) -> str:
    partes = [rem.get("nombre") or ("(your name)" if idioma == "en" else "(tu nombre)")]
    for k in ("cargo", "organizacion", "ciudad", "telefono", "correo"):
        if rem.get(k):
            partes.append(rem[k])
    return "\n".join(partes)


def redactar(dest_id: str, evidencia: dict, remitente: dict,
             url_mapa: str = "") -> dict:
    """Redacta la carta para un destinatario, con la evidencia ya dentro."""
    d = _por_id(dest_id)
    if d is None:
        raise ValueError(f"destinatario desconocido: {dest_id}")

    ev = evidencia
    r = ev["resumen"]
    ahora = datetime.now(TZ_CO)
    deriva = ev.get("deriva_luz", {})
    metodo_fmt = {
        "evento": fuentes.USGS_EVENTO,
        "deriva": deriva.get("valor_pct"),
        "n_control": deriva.get("poblados_de_control", 0),
    }
    mapa_linea = f"\nMapa en vivo: {url_mapa}\n" if url_mapa else ""

    n_ciegos = r.get("puntos_ciegos", 0)
    p_ciegos = ev.get("personas_ciegas", 0)

    # Hoy el epicentro está entre los puntos ciegos, y decirlo pesa. Pero es un
    # hecho que puede dejar de ser cierto en cuanto alguien mida allí, y una
    # carta que afirma algo falso se cae entera. Se comprueba en cada envío,
    # contra la lista completa y no contra la recortada.
    epicentro_ciego = bool(ev.get("epicentro_ciego"))
    remate_es = (" Entre ellos está San José del Palmar, que es el epicentro mismo."
                 if epicentro_ciego else "")
    remate_en = (" Among them is San José del Palmar, the epicentre itself."
                 if epicentro_ciego else "")

    # El bloque de petición cambia según a quién se le escriba. Al Estado no se
    # le piden terminales: se le pide que active lo que solo él puede activar.
    if d["grupo"] == "estado":
        solicitud = """QUÉ SE SOLICITA — y por qué a ustedes en particular

La Unión Internacional de Telecomunicaciones (UIT) despliega teléfonos
satelitales y terminales BGAN en las primeras 24 a 48 horas de un desastre,
pero ÚNICAMENTE a petición de un Estado miembro. En Tonga la solicitud la hizo
el ministerio del ramo; en Nicaragua, el regulador junto con la agencia
nacional de desastres. Ninguna persona ni organización privada puede activar
ese mecanismo: solo ustedes.

Colombia además es parte del Convenio de Tampere sobre el suministro de
recursos de telecomunicaciones para la mitigación de catástrofes, que existe
precisamente para reducir las barreras aduaneras y regulatorias a la entrada
de equipos de emergencia.

Por eso se solicita, en orden de urgencia:

  1. Que se curse la solicitud formal de asistencia a la UIT, con los municipios
     de este documento como base técnica.
  2. Facilitación aduanera y de espectro para el ingreso de terminales
     satelitales donadas, invocando el Convenio de Tampere.
  3. Coordinación con los operadores para priorizar los municipios listados.
  4. Un canal de recepción para estos datos. Hoy este mapa no está conectado a
     ningún despacho oficial, y esa es su mayor limitación: una capa de datos
     sin destinatario no le llega a nadie. Se ofrece completo y sin costo."""
    else:
        solicitud = """QUÉ SE SOLICITA
  1. Terminales satelitales con energía autónoma para los puntos ciegos.
  2. Orientación sobre la vía más rápida viable, considerando aduanas y
     permisos de espectro en Colombia.
  3. Si su procedimiento exige una solicitud de autoridad nacional, indicarnos
     cuál documento requieren: estamos escribiendo en paralelo al MinTIC y a
     la UNGRD."""

    if d["idioma"] == "en":
        asunto = (f"Colombia M7.4 earthquake — request for emergency "
                  f"connectivity: {n_ciegos} unmeasured towns, "
                  f"{p_ciegos:,} people")
        cuerpo = f"""To: {d['nombre']}

Subject: Emergency connectivity request — M7.4 earthquake, Chocó, Colombia
Date: {ahora:%d %B %Y, %H:%M} Colombia time (UTC-5)

Dear colleagues,

On 10 August 2026 a magnitude 7.4 earthquake struck Chocó, Colombia (USGS
event {fuentes.USGS_EVENTO}, red PAGER alert). I am writing to request
emergency connectivity support, with measured evidence attached below rather
than an estimate.

WHAT WE MEASURED
We fused four independent public sources down to the level of individual
the official municipality list: {r.get('lugares', 0)} municipalities,
{r.get('poblacion_expuesta', 0):,} people exposed. The finding that matters:

  {n_ciegos} municipalities, home to {p_ciegos:,} people, shook at MMI 6 or
  above and have NO local measurement of any kind. Not "they are fine" —
  nobody has measured them.{remate_en}

BLIND SPOTS — highest priority, no data exists for these:
{_lista_en(ev['puntos_ciegos'])}

MEASURED LOSS OF POWER (satellite, ~610 m resolution):
{_lista_en(ev['sin_luz'])}

WHAT IS ACTUALLY NEEDED
The measurements separate two problems that look identical from a distance
and need opposite responses:

  - Where last-mile access dropped but the backbone still routes, the fibre is
    intact and what failed is POWER. A router without electricity does not
    come on. Sending a network crew there fixes nothing; generators and fuel do.
  - Where the backbone withdrew its routes, it is a genuine network cut and
    needs a crew or a satellite link.
  - In the blind spots, an AUTONOMOUS satellite terminal with its own power is
    the only thing that works, because we do not even know what is left standing.

WHAT WE ARE ASKING FOR
  1. Deployable satellite terminals with autonomous power for the blind spots.
  2. Technical guidance on the fastest viable route given Colombian customs and
     spectrum rules.
  3. If your mandate requires a request from a national authority, please tell
     us which document you need — we are writing to MinTIC and UNGRD in parallel.

WHAT WE OFFER IN RETURN
The full live map, its data feeds and its source code, free and without
conditions, to whoever coordinates the response. Everything above updates
every few minutes.
{mapa_linea}
{METODO_EN.format(**metodo_fmt)}

This is not an official emergency dispatch and does not replace Colombia's
emergency line (123). It is a data contribution offered in good faith.

Thank you for your time.

{_firma(remitente, 'en')}
"""
    else:
        asunto = (f"Sismo M7.4 Chocó — solicitud de conectividad de emergencia: "
                  f"{n_ciegos} municipios sin medición, {_mil(p_ciegos)} personas")
        cuerpo = f"""Para: {d['nombre']}

Asunto: Solicitud de conectividad de emergencia — sismo M7.4, Chocó
Fecha: {ahora:%d/%m/%Y %H:%M} hora Colombia

Respetados señores:

El 10 de agosto de 2026 un sismo de magnitud 7.4 golpeó el Chocó (evento USGS
{fuentes.USGS_EVENTO}, alerta PAGER roja). Escribo para solicitar apoyo en
conectividad de emergencia, y lo hago con mediciones, no con estimaciones.

QUÉ SE MIDIÓ
Se cruzaron cuatro fuentes públicas independientes sobre el listado oficial de
municipios: {r.get('lugares', 0)} municipios, {_mil(r.get('poblacion_expuesta', 0))} personas expuestas.
El hallazgo que importa:

  {n_ciegos} municipios, donde viven {_mil(p_ciegos)} personas, temblaron a
  intensidad MMI 6 o más y NO tienen ninguna medición local. No es que estén
  bien: es que nadie los ha mirado.{remate_es}

PUNTOS CIEGOS — máxima prioridad, no existe dato de estos lugares:
{_lista(ev['puntos_ciegos'])}

PÉRDIDA DE ENERGÍA MEDIDA POR SATÉLITE (resolución ~610 m):
{_lista(ev['sin_luz'])}

QUÉ HACE FALTA EXACTAMENTE
Las mediciones separan dos problemas que de lejos se ven iguales y que se
resuelven al revés uno del otro:

  - Donde cayó el acceso pero el troncal sigue anunciando rutas, la fibra está
    sana y lo que falta es ENERGÍA. Un router sin luz no prende. Mandar una
    cuadrilla de red allí no arregla nada; una planta y combustible, sí.
  - Donde el troncal retiró rutas, sí es corte de red y hace falta cuadrilla o
    enlace satelital.
  - En los puntos ciegos solo sirve un terminal satelital AUTÓNOMO, con su
    propia energía, porque ni siquiera sabemos qué quedó en pie.

{solicitud}

QUÉ SE OFRECE A CAMBIO
El mapa completo en vivo, sus datos y su código, gratis y sin condiciones,
para quien coordine la respuesta. Todo lo anterior se actualiza cada pocos
minutos.
{mapa_linea}
{METODO_ES.format(**metodo_fmt)}

Esto no es un despacho oficial de emergencia ni sustituye la línea 123. Es un
aporte de datos hecho de buena fe.

Agradezco su tiempo y quedo atento.

{_firma(remitente, 'es')}
"""

    return {
        "destinatario": d,
        "asunto": asunto,
        "cuerpo": cuerpo.strip() + "\n",
        "para": d["valor"] if d["canal"] == "correo" else "",
        "copia": d.get("copia", ""),
        "enviable_directo": d["canal"] == "correo" and d["estado"] == "verificado",
    }


def redactar_todas(evidencia: dict, remitente: dict, ids: Optional[list[str]] = None,
                   url_mapa: str = "") -> list[dict]:
    elegidos = ids or [d["id"] for d in DESTINATARIOS]
    return [redactar(i, evidencia, remitente, url_mapa)
            for i in elegidos if _por_id(i)]



# ═══════════════════════════════════════════════════════════════════════════
#  CARTA CONJUNTA — un botón, un envío, todas las entidades
# ═══════════════════════════════════════════════════════════════════════════
#
# Las veinte cartas individuales sirven para hacer las cosas bien: cada
# organización con su idioma y su argumento. Pero exigen sentarse un rato, y
# eso deja fuera a la mayoría de la gente que querría empujar.
#
# Esto es lo contrario: UNA carta, dirigida a todas las entidades a la vez, que
# cualquiera puede mandar desde su propio correo en un clic. Es el formato de
# campaña.
#
# ── Por qué van todos en el mismo «Para» y no en copia oculta ──────────────
#
# Porque que se vean unos a otros es media petición. El MinTIC leyendo que la
# misma carta le llegó a la UIT, a TSF y a la Cruz Roja entiende que hay un
# expediente abierto, no una queja suelta. Y TSF, al ver al MinTIC en el hilo,
# sabe que existe la contraparte estatal que su procedimiento exige. Con copia
# oculta se pierde exactamente eso, que es lo único que una carta conjunta
# aporta sobre veinte cartas sueltas.
#
# ── Por qué sale del correo de la persona y no del servidor ────────────────
#
# Porque es lo que funciona. Quinientos correos desde quinientas direcciones
# reales de ciudadanos colombianos son presión: cada uno es una persona
# identificable a la que hay que responder, y a un derecho de petición el
# Estado colombiano tiene plazo legal para contestar. Quinientos correos desde
# un servidor desconocido son una sola regla de filtro y, con suerte, una
# lista negra que después impide llegar a nadie.
#
# ── Por qué es bilingüe ────────────────────────────────────────────────────
#
# Van juntos el MinTIC y el Emergency Telecommunications Cluster. Mandar dos
# correos distintos rompe el hilo compartido; mandar uno solo en español deja
# fuera a la mitad de los que pueden ayudar. Va el cuerpo en español y un
# resumen en inglés con las mismas cifras.

# Un derecho de petición invoca el artículo 23 de la Constitución y obliga a
# responder en plazo. Es la diferencia entre una carta y un trámite con reloj.
ASUNTO_CONJUNTA = (
    "Derecho de peticion / Urgent request — Sismo M7.4 Choco: "
    "{n_ciegos} municipios sin medicion, {p_ciegos} personas"
)


def destinatarios_conjunta() -> list[dict]:
    """Los que tienen correo comprobado. A un canal web no se le puede mandar
    un correo, y meter una dirección sin verificar en una campaña masiva es
    multiplicar por mil una carta que no llega a ninguna parte."""
    return [d for d in DESTINATARIOS
            if d["canal"] == "correo" and d["estado"] == "verificado"]


def carta_conjunta_breve(evidencia: dict, remitente: dict,
                         url_mapa: str = "") -> str:
    """Versión corta, la que cabe en un `mailto:`.

    La carta completa son ~11.500 caracteres. Un `mailto:` con eso dentro
    revienta en Outlook de escritorio, que corta sobre los 2.000: el correo se
    abriría con el texto truncado a media frase, y la persona lo enviaría sin
    darse cuenta. Peor que no tener el botón.

    Y para una campaña la corta es además la buena: una carta de once mil
    caracteres no la lee nadie; esta se lee entera en treinta segundos y lleva
    las mismas cifras, con el enlace al método completo para quien lo quiera
    comprobar.
    """
    ev = evidencia
    r = ev["resumen"]
    n_ciegos = r.get("puntos_ciegos", 0)
    p_ciegos = ev.get("personas_ciegas", 0)
    top5 = ev["puntos_ciegos"][:5]
    nombres = ", ".join(l["nombre"] for l in top5)
    epi = (" Uno de ellos es San Jose del Palmar: el epicentro."
           if ev.get("epicentro_ciego") else "")
    quien = (remitente.get("nombre") or "").strip()
    ciudad = (remitente.get("ciudad") or "").strip()
    firma = quien or "(nombre)"
    if ciudad:
        firma += f"\n{ciudad}, Colombia"
    enlace = f"\nDatos, metodo y mapa en vivo: {url_mapa}\n" if url_mapa else ""

    return f"""DERECHO DE PETICION (art. 23 de la Constitucion Politica)
Sismo M7.4 del 10 de agosto de 2026, Choco - evento USGS {fuentes.USGS_EVENTO}

Respetados senores:

Les escribo a todos ustedes en el mismo correo, a proposito, porque cada uno
tiene una pieza que los demas no pueden poner.

{n_ciegos} municipios que el USGS confirma sacudidos a intensidad MMI 6 o mas,
donde viven {_mil(p_ciegos)} personas, NO tienen ninguna medicion de red ni de
energia. No es que se sepa que estan bien: es que nadie los ha mirado.{epi}

Algunos: {nombres}.

Esto sale de cruzar cuatro fuentes publicas -USGS PAGER/ShakeMap, satelite
VIIRS de la NASA, sondas RIPE Atlas e IODA de Georgia Tech- sobre el listado
oficial de municipios. Son datos verificables, no estimaciones.

SOLICITO:

1. Al MinTIC, la UNGRD y la CRC: que se curse la solicitud formal de
   asistencia a la Union Internacional de Telecomunicaciones. La UIT
   despliega terminales satelitales en 24-48 horas, pero UNICAMENTE a
   peticion de un Estado miembro. Ningun ciudadano puede activar ese
   mecanismo: solo ustedes. Y facilitacion aduanera invocando el Convenio
   de Tampere, del que Colombia es parte.

2. A las organizaciones de telecomunicaciones de emergencia: despliegue de
   equipos autonomos hacia esos municipios, o la via mas rapida para lograrlo.

3. A los organismos de socorro: verificacion en terreno y respaldo
   institucional, que es lo que exigen los donantes de equipos.

Donde cayo el acceso pero el troncal aguanta, lo que falta es ENERGIA: un
router sin luz no prende y una cuadrilla de fibra no arregla nada. Donde no
hay ninguna medicion, hace falta un terminal satelital autonomo.
{enlace}
Como derecho de peticion, solicito respuesta en los terminos del articulo 14
de la Ley 1755 de 2015.

Esto no es una linea de emergencia ni sustituye al 123.

{firma}
"""


def carta_conjunta(evidencia: dict, remitente: dict, url_mapa: str = "") -> dict:
    """Una sola carta para todas las entidades. El formato de campaña."""
    ev = evidencia
    r = ev["resumen"]
    ahora = datetime.now(TZ_CO)
    deriva = ev.get("deriva_luz", {})
    dests = destinatarios_conjunta()

    n_ciegos = r.get("puntos_ciegos", 0)
    p_ciegos = ev.get("personas_ciegas", 0)
    epicentro_ciego = bool(ev.get("epicentro_ciego"))

    quien = (remitente.get("nombre") or "").strip()
    ciudad = (remitente.get("ciudad") or "").strip()
    presentacion = "Escribo como ciudadano"
    if quien and ciudad:
        presentacion = f"Escribo como ciudadano desde {ciudad}"
    elif ciudad:
        presentacion = f"Escribo desde {ciudad}"

    metodo = METODO_ES.format(evento=fuentes.USGS_EVENTO,
                              deriva=deriva.get("valor_pct"),
                              n_control=deriva.get("poblados_de_control", 0))
    mapa_linea = f"\nMapa en vivo, con los datos y el metodo abiertos: {url_mapa}\n" \
                 if url_mapa else ""

    cuerpo = f"""DERECHO DE PETICION (art. 23 de la Constitucion Politica de Colombia)
y solicitud de asistencia internacional en telecomunicaciones de emergencia

{ahora:%d/%m/%Y %H:%M} hora Colombia
Sismo M7.4 del 10 de agosto de 2026, Choco · evento USGS {fuentes.USGS_EVENTO}

Para, en un mismo envio y a proposito:
{chr(10).join('  · ' + d['nombre'] for d in dests)}

Van todos en el mismo correo para que cada uno vea a los demas. Esto no es
una queja suelta: es un expediente abierto, y cada entidad de esta lista tiene
una pieza que las otras no pueden poner.

Respetados senores:

{presentacion}.

Solicito su intervencion urgente para llevar conectividad a los municipios que
siguen incomunicados tras el sismo. Lo hago con mediciones publicas y
verificables, no con estimaciones.

LO QUE ESTA MEDIDO

Se cruzaron cuatro fuentes publicas independientes sobre el listado oficial de
municipios: {r.get('lugares', 0)} municipios, {_mil(r.get('poblacion_expuesta', 0))} personas en la zona sacudida.

  {n_ciegos} municipios, donde viven {_mil(p_ciegos)} personas, temblaron a
  intensidad MMI 6 o mas y NO tienen NINGUNA medicion local. No es que se
  sepa que estan bien: es que nadie los ha mirado.{
  ' Entre ellos esta San Jose del Palmar, que es el epicentro mismo.'
  if epicentro_ciego else ''}

MUNICIPIOS DE LOS QUE NO SE SABE NADA (maxima prioridad):
{_lista(ev['puntos_ciegos'], 12)}

MUNICIPIOS CON PERDIDA DE ENERGIA MEDIDA POR SATELITE:
{_lista(ev['sin_luz'], 10)}

QUE SE PIDE, A CADA UNO

  Al MinTIC, a la UNGRD y a la CRC:
    1. Que se curse la solicitud formal de asistencia a la Union Internacional
       de Telecomunicaciones (UIT). La UIT despliega telefonos satelitales y
       terminales BGAN en las primeras 24 a 48 horas, pero UNICAMENTE a
       peticion de un Estado miembro. En Tonga la solicitud la hizo el
       ministerio; en Nicaragua, el regulador con la agencia de desastres.
       Ningun ciudadano ni organizacion privada puede activar ese mecanismo.
       Solo ustedes. Por eso esta carta llega primero aqui.
    2. Facilitacion aduanera y de espectro para el ingreso de terminales
       satelitales donadas, invocando el Convenio de Tampere sobre suministro
       de recursos de telecomunicaciones para la mitigacion de catastrofes,
       del que Colombia es parte y que existe exactamente para esto.
    3. Coordinacion con los operadores para priorizar los municipios listados.

  A las organizaciones de telecomunicaciones de emergencia:
    4. Orientacion sobre la via mas rapida viable y, si su procedimiento lo
       permite, despliegue de equipos hacia los puntos ciegos.

  A los organismos de socorro:
    5. Verificacion en terreno de los municipios listados, y respaldo
       institucional para las donaciones de equipos que exigen una
       organizacion acreditada como contraparte.

QUE HACE FALTA EXACTAMENTE, QUE NO ES LO MISMO EN TODAS PARTES

Las mediciones separan dos problemas que de lejos se ven iguales y que se
resuelven al reves uno del otro:

  - Donde cayo el acceso pero el troncal sigue anunciando rutas, la fibra esta
    sana y lo que falta es ENERGIA. Un router sin luz no prende. Mandar una
    cuadrilla de red alli no arregla nada; una planta y combustible, si.
  - Donde el troncal retiro rutas, si es corte de red: hace falta cuadrilla o
    enlace satelital.
  - En los puntos ciegos solo sirve un terminal satelital AUTONOMO, con su
    propia energia, porque ni siquiera se sabe que quedo en pie.

QUE SE OFRECE A CAMBIO

El mapa completo en vivo, sus datos y su codigo fuente, gratis y sin
condiciones, para quien coordine la respuesta. Se actualiza cada pocos minutos.
{mapa_linea}
{metodo}

Como derecho de peticion, solicito respuesta dentro de los terminos del
articulo 14 de la Ley 1755 de 2015.

Esto no es una linea de emergencia y no sustituye al 123. Es un aporte de
datos hecho de buena fe por un ciudadano.

Agradezco su tiempo,

{_firma(remitente, 'es')}


═══════════════════════════════════════════════════════════════════════════
ENGLISH SUMMARY — for the international recipients of this same message

On 10 August 2026 a magnitude 7.4 earthquake struck Choco, Colombia (USGS
event {fuentes.USGS_EVENTO}, red PAGER alert). This is a citizen request for
emergency connectivity support, sent to Colombian authorities and to emergency
telecommunications organisations in the same message, on purpose.

Four independent public sources were fused down to the level of individual
populated places: {r.get('lugares', 0)} towns, {r.get('poblacion_expuesta', 0):,} people exposed.

  {n_ciegos} municipalities, home to {p_ciegos:,} people, shook at MMI 6 or
  above and have NO local measurement of any kind. Not "they are fine" —
  nobody has measured them.{
  ' Among them is San Jose del Palmar, the epicentre itself.'
  if epicentro_ciego else ''}

BLIND SPOTS — highest priority, no data exists for these:
{_lista_en(ev['puntos_ciegos'], 12)}

MEASURED LOSS OF POWER (satellite, ~610 m resolution):
{_lista_en(ev['sin_luz'], 10)}

What is requested: satellite terminals with autonomous power for the blind
spots; guidance on the fastest viable route given Colombian customs and
spectrum rules; and, from the Colombian authorities copied here, the formal
Member State request that ITU assistance requires.

Offered in return: the full live map, its data feeds and its source code, free
and unconditionally, to whoever coordinates the response.

{METODO_EN.format(evento=fuentes.USGS_EVENTO,
                  deriva=deriva.get('valor_pct'),
                  n_control=deriva.get('poblados_de_control', 0))}

This is not an official emergency dispatch. It is a data contribution offered
in good faith.

{_firma(remitente, 'en')}
"""

    return {
        "asunto": ASUNTO_CONJUNTA.format(n_ciegos=n_ciegos, p_ciegos=_mil(p_ciegos)),
        "cuerpo": cuerpo.strip() + "\n",
        # La breve es la que viaja en el mailto; la larga, la que se copia o se
        # baja como .eml. Van las dos para que el navegador elija sin otra
        # consulta: en una campaña, cada ida y vuelta al servidor es gente que
        # cierra la pestaña.
        "cuerpo_breve": carta_conjunta_breve(evidencia, remitente, url_mapa).strip() + "\n",
        "para": [d["valor"] for d in dests],
        "copia": [d["copia"] for d in dests if d.get("copia")],
        "destinatarios": [{"nombre": d["nombre"], "valor": d["valor"]} for d in dests],
    }


def paquete_eml(cartas: list[dict], remitente: dict) -> bytes:
    """Un .zip con un .eml por carta: se arrastran al cliente de correo y
    quedan listas para revisar y enviar, sin copiar y pegar veinte veces."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for c in cartas:
            msg = EmailMessage()
            msg["Subject"] = c["asunto"]
            if remitente.get("correo"):
                msg["From"] = remitente["correo"]
            if c["para"]:
                msg["To"] = c["para"]
            if c.get("copia"):
                msg["Cc"] = c["copia"]
            msg.set_content(c["cuerpo"])
            nombre = f"{c['destinatario']['grupo']}_{c['destinatario']['id']}.eml"
            z.writestr(nombre, msg.as_bytes())

        pendientes = [c for c in cartas if not c["enviable_directo"]]
        if pendientes:
            guia = ["DESTINATARIOS SIN CORREO VERIFICADO",
                    "",
                    "Para estos no se publica una dirección porque no se pudo",
                    "confirmar ninguna oficial. Inventar una no habría hecho que",
                    "la carta rebotara: se habría perdido en silencio.",
                    "",
                    "Su carta ya está escrita en el .eml correspondiente. Falta",
                    "pegar el texto en el canal oficial de cada uno:",
                    ""]
            for c in pendientes:
                d = c["destinatario"]
                guia += [f"· {d['nombre']}", f"    {d['valor']}"]
                if d.get("clave"):
                    guia += [f"    Nota: {d['clave']}"]
                guia.append("")
            z.writestr("LEEME_canales_por_verificar.txt", "\n".join(guia))
    return buf.getvalue()
