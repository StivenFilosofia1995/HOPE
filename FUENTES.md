# Fuentes de cortes de internet y energía — Colombia

Todo lo de este documento fue probado contra el servicio real el **13 de agosto
de 2026**. Cada entrada dice qué mide, cada cuánto se actualiza, qué NO puede
responder, y si hace falta llave.

Regla que gobierna el documento: **una fuente sin su límite escrito al lado es
una trampa**. La mayoría de errores de lectura en emergencias no vienen de datos
falsos, vienen de datos ciertos leídos como si midieran otra cosa.

---

## Resumen: qué usar según la pregunta

| La pregunta | La fuente | Latencia | Llave |
|---|---|---|---|
| ¿Cómo está la red **ahora**? | IODA `/signals/raw` | 5–10 min | no |
| ¿Es la zona o es mi operador? | IODA `/signals/raw` por ASN | 5–10 min | no |
| ¿Es falta de **luz** o de **fibra**? | IODA: cruce acceso × troncal | 5–10 min | no |
| ¿Qué **pueblo** se quedó a oscuras? | NASA VIIRS luces nocturnas | 1 noche | no |
| ¿Cuánta energía se dejó de entregar? | XM `DemaNoAtenNoProg` | 1–2 días | no |
| ¿Hay un corte **confirmado**? | Cloudflare Radar | minutos | sí (gratis) |
| ¿Hay internet en **este punto exacto**? | RIPE Atlas | minutos | no |

---

## 1. IODA — Internet Outage Detection and Analysis (Georgia Tech)

**Base:** `https://api.ioda.inetintel.cc.gatech.edu/v2`
**Llave:** no. **CORS:** abierto. **Portal:** <https://ioda.inetintel.cc.gatech.edu/>

Es el motor de HOPE. Mide alcanzabilidad de internet por métodos independientes
y publica las series crudas, no solo los resúmenes.

### 1.1 Series crudas — lo que da el tiempo real

```
GET /signals/raw/{tipo}/{codigo}?from={epoch}&until={epoch}&datasource={ds}
```

`tipo` es `region` (departamento), `asn` (operador) o `country`.

| `datasource` | Qué mide | Paso |
|---|---|---|
| `ping-slash24` | bloques /24 que **responden** al sondeo → la **última milla** | 10 min |
| `bgp` | prefijos anunciados en la tabla global → el **troncal** | 5 min |
| `merit-nt` | telescopio de red (tráfico de fondo) | 5 min |
| `ping-slash24-loss` | % de pérdida de paquetes | 10 min |
| `ping-slash24-latency` | latencia (min/media/mediana/p10/p90) | 10 min |

Ejemplo real (Chocó, últimas 3 h):

```bash
NOW=$(date +%s)
curl "https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/region/745?from=$((NOW-10800))&until=$NOW&datasource=ping-slash24"
```

**El cruce que da el diagnóstico.** Ninguna fuente lo entrega hecho; sale de
mirar las dos series juntas:

| acceso (`ping-slash24`) | troncal (`bgp`) | Lectura | Qué hace falta en terreno |
|---|---|---|---|
| ↓ | = | La fibra está sana, los equipos del usuario no contestan | **Energía** — planta, combustible |
| ↓ | ↓ | El operador retiró rutas: corte físico o nodo caído | **Red** — cuadrilla o enlace satelital |
| = | = | Sin cambio medible | — |

Esto es lo que separa mandar un generador de mandar una cuadrilla de fibra.

**Trampa grande, verificada.** El valor absoluto **no se puede leer como
"% de gente sin internet"**. `ping-slash24-loss` marcaba **80% en Chocó** el 12
de agosto, y marcaba **84% el día antes del sismo**. La mayor parte de internet
no responde a ping, siempre. Solo sirve la **desviación de cada zona contra su
propio pasado**: HOPE compara contra la misma ventana horaria de hace 7 días,
para cancelar el ciclo diario y el semanal.

**Segunda trampa: muestra chica.** Chocó tiene ~33 bloques /24 medibles. Que
dejen de responder 3 ya da −9%, que no es señal sino ruido. Por debajo de ~60
bloques el porcentaje no es concluyente y hay que decirlo, no maquillarlo.

### 1.2 Resúmenes y eventos (ventana larga, mira hacia atrás)

```
GET /outages/summary?entityType=region&relatedTo=country/CO&from=&until=
GET /outages/events?entityType=region&entityCode=745&from=&until=
GET /entities/query?entityType=region&relatedTo=country/CO
GET /entities/query?entityType=asn&relatedTo=country/CO
```

El `score` no tiene unidad física: ordena zonas entre sí, no mide población.

### 1.3 Códigos verificados

**Departamentos** (los del sismo en negrita): **Chocó 745**, **Valle 741**,
**Risaralda 734**, **Caldas 730**, **Quindío 733**, **Cauca 737**,
**Nariño 739**, **Tolima 735**, Antioquia 724, Bogotá 732, Cundinamarca 731,
Santander 727, Atlántico 742, Bolívar 743, Córdoba 726, Huila 738, Meta 753.

**Operadores (ASN)** — probados, los 103 ASN de Colombia salen del endpoint de
entidades:

| ASN | Operador |
|---|---|
| 10620 | Claro / Telmex |
| 13489 | Tigo-UNE / EPM Telecomunicaciones |
| 3816 | Movistar / Colombia Telecomunicaciones |
| 19429 | ETB |
| 14080 | Claro (bloque secundario) |
| 26611 | Emcali y regionales |
| **14593** | **Starlink (SpaceX)** — el respaldo cuando cae el resto |

**Límite duro:** para Colombia **no hay granularidad municipal** (0 counties).
El departamento es lo más fino que da IODA.

**No acepta multi-entidad.** `region/745,741,734` devuelve solo una. Hay que
paralelizar. Probado.

---

## 2. NASA VIIRS — luces nocturnas

**Teselas:** `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_DayNightBand/default/{fecha}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`
**Llave:** no. **CORS:** abierto (son imágenes). **Portal:** <https://worldview.earthdata.nasa.gov/>

La única fuente de energía con resolución **municipal** (~500 m) y sin rezago de
días. El satélite pasa sobre Colombia hacia la **1:30 a.m.** y ve qué pueblo
quedó a oscuras. Se usó así en Puerto Rico tras el huracán María.

**Ojo con la capa que se elige.** La que más se cita, `VIIRS_SNPP_DayNightBand_ENCC`,
**está congelada desde el 7 de julio de 2023**. Verificado. Las vivas son:

- `VIIRS_NOAA20_DayNightBand` — datos hasta hoy ✅ (la que usa HOPE)
- `VIIRS_NOAA21_DayNightBand` — datos hasta hoy ✅
- `VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance` — radiancia cruda, `Level8`

**Dos límites que hay que respetar:**

1. **Nubes.** Una noche nublada se ve tan oscura como una sin luz, y el Chocó es
   de las regiones más lluviosas del planeta. Solo es interpretable comparando
   dos noches, y aun así hay que descartar que la diferencia sea meteorológica.
2. **Noche sin procesar.** El procesamiento tarda horas después del paso. Una
   tesela no publicada se pinta **negra, igual que un apagón**. HOPE sondea una
   tesela sobre el epicentro y deshabilita las noches que aún no existen: sin
   eso, mirar el mapa a las 2 a.m. muestra "todo oscuro" y no significa nada.

Otras APIs de la NASA, si algún día hace falta el dato numérico y no la imagen:

- **Black Marble VNP46A2** (producto corregido por luna y atmósfera) —
  <https://ladsweb.modaps.eosdis.nasa.gov/> · requiere token de Earthdata (gratis)
- **FIRMS** (incendios, no energía) — <https://firms.modaps.eosdis.nasa.gov/api/>

---

## 3. XM — operador del Sistema Interconectado Nacional

**Base:** `https://servapibi.xm.com.co`
**Método:** POST. **Llave:** no. **CORS:** ✗ **no manda** — hay que proxiar desde el backend.
**Portal:** <https://www.xm.com.co/> · <https://sinergox.xm.com.co/>

```bash
curl -X POST https://servapibi.xm.com.co/daily \
  -H "Content-Type: application/json" \
  -d '{"MetricId":"DemaNoAtenNoProg","Entity":"Area","StartDate":"2026-08-01","EndDate":"2026-08-13"}'
```

| Métrica | Qué es |
|---|---|
| `DemaNoAtenNoProg` | Energía que se debió entregar y **no se entregó por falla**. Es la del apagón. |
| `DemaNoAtenProg` | Racionamiento o mantenimiento **planeado**. No es emergencia. |
| `DemaReal` | Demanda real horaria. |

Catálogo completo: `POST /lists` con `{"MetricId":"ListadoMetricas"}`.

Estructura: `Items[].DailyEntities[].{Id,Name,Value}` (o `HourlyEntities` con
`Values.Hour01..Hour24`).

**Rezago real, medido el 13 de agosto: el último día disponible era el 11.**
Uno a dos días. HOPE lo calcula en cada consulta y lo muestra como sello, no
como nota al pie: una cifra de anteayer presentada como si fuera de ahora es la
forma más fácil de decidir con datos vencidos.

**Probado y descartado:** `DemaReal` con `Entity: "Area"` devuelve **400**, y con
`Entity: "Sistema"` no trae los últimos días. **XM no sirve para tiempo real.**
Es el registro contable del apagón, no su estado actual.

**Límite de geografía:** las áreas de XM son **operativas** (topología eléctrica),
no político-administrativas. `AREA SUROCCIDENTAL`, `AREA ANTIOQUIA`, `AREA CARIBE`,
`AREA NORDESTE`, `AREA ORIENTAL`, `AREA CQR`. El mapeo área→departamento es
aproximado y **no sirve para atribuir un corte a un municipio**.

---

## 4. Cloudflare Radar — opcional, la más rápida

**Base:** `https://api.cloudflare.com/client/v4/radar`
**Llave:** sí, **gratis**. **Portal:** <https://radar.cloudflare.com/>

Es la fuente más rápida que existe a nivel país y operador, y la única que
publica cortes **confirmados y anotados a mano** por un equipo humano.

```
GET /annotations/outages?location=CO&dateRange=7d
GET /http/timeseries?location=CO&dateRange=1d&aggInterval=15m
GET /netflows/timeseries?location=CO&dateRange=1d
GET /quality/iqi/summary?location=CO
```

Cabecera: `Authorization: Bearer <token>`.

**Cómo sacar la llave** (2 minutos, sin tarjeta ni dominio):
<https://dash.cloudflare.com/> → My Profile → API Tokens → Create Token →
Custom token → permiso **Account · Radar · Read**.

Luego, en `.env`:

```
CLOUDFLARE_API_TOKEN=tu_token
```

HOPE la activa sola si la encuentra y sigue funcionando sin ella.

---

## 5. RIPE Atlas — puntos físicos reales

**Base:** `https://atlas.ripe.net/api/v2/probes/?country_code=CO&format=json`
**Llave:** no para leer. **CORS:** abierto. **Portal:** <https://atlas.ripe.net/>

Cada sonda es **un dispositivo real con coordenadas**, no un promedio de zona.
Complementa a IODA justo donde IODA es flojo: la resolución espacial.

Filtrar por `status.name` y `status_since`: descartar `Abandoned`,
`Never Connected` y `Written Off` — es hardware que dejó de reportar mucho antes
del sismo y no es señal de nada.

**Streaming en vivo** (conexión/desconexión de sondas, WebSocket):
`wss://atlas-stream.ripe.net/stream/` — <https://atlas.ripe.net/docs/apis/result-streaming/>

**Límite:** son pocas decenas de puntos en todo el país. **Ausencia de sonda no
es ausencia de problema, solo ausencia de medición ahí.**

---

## 6. Contexto (ya integrado, no es de cortes)

- **USGS** — `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` ·
  sin llave, CORS abierto. Evento: `us6000tjl2`.
  Cataloga **menos réplicas que el SGC**: su red global no ve las magnitudes
  pequeñas que sí ve la red local. Cualquier conteo saldrá corto.
- **SGC Colombia** — <https://sismo.sgc.gov.co/> · más réplicas, sin API pública documentada.
- **Open-Meteo** — `https://api.open-meteo.com/v1/forecast` · sin llave, CORS abierto.
  Pronóstico de modelo abierto, **no es alerta oficial del IDEAM**.

---

## Lo que NO existe — verificado, no volver a buscar

- **Feed de personas atrapadas en tiempo real.** No lo tiene nadie. Solo reportes humanos.
- **Búsqueda de Instagram por hashtag o ubicación.** La API con Instagram Login
  no la soporta y `GET_IG_USER_TAGS` está deprecado. Solo se lee la propia cuenta.
- **API pública de cortes de los operadores eléctricos colombianos**
  (EPM, Celsia, Enel, Air-e, Afinia, DISPAC, CHEC, EDEQ). Tienen mapas web, no
  endpoints documentados ni estables. No apoyarse en scraping para una
  herramienta de emergencia.
- **Granularidad municipal en IODA para Colombia.** Cero counties.
- **XM en tiempo real.** Probado: 400 por área, sin datos recientes por sistema.

---

## Advertencia final, que vale más que la lista

Ninguna de estas fuentes ve a una persona. Ven bloques de red, kilovatios y
fotones. Una zona **puede estar en verde en todas y aun así tener gente
incomunicada** — sobre todo donde nunca hubo infraestructura que medir, que es
exactamente donde más falta hace ayudar.

Por eso HOPE marca esas zonas como **punto ciego** con color y forma propios en
vez de pintarlas de verde: un score bajo puede significar "no hay nada que
medir", y eso suele ser peor que un score alto.
