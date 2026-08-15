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
| ¿Qué **pueblo** se quedó a oscuras? | NASA VIIRS **Black Marble** (BRDF-corregido) | 1–2 noches | no |
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

**Hay dos productos y la diferencia lo es todo.**

| Capa | Qué es | Sirve para |
|---|---|---|
| `VIIRS_NOAA20_DayNightBand` | Imagen **cruda** | Contexto visual. **NO** para medir apagones |
| `VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance` | **Black Marble**: corregido por luna y atmósfera, huecos de nube rellenados. `Level8` | **Medir apagones por municipio** ✅ |

`VIIRS_SNPP_DayNightBand_ENCC`, la que más se cita por ahí, **está congelada
desde el 7 de julio de 2023**. Verificado.

**Por qué la cruda no sirve, con números.** Brillo medio sobre el eje
Chocó–Valle en cuatro noches:

```
noche        cruda    corregida
2026-08-06   216,0      8,8
2026-08-08    75,1     10,7
2026-08-09   186,9      8,7
2026-08-11   129,9     13,5
```

La cruda oscila un factor de **tres** sin que pasara nada eléctrico: es la fase
de la luna reflejándose en las nubes. La corregida se mantiene. Como control,
Bogotá marca 255,0 las cuatro noches en la corregida.

**El detalle de fechas que es fácil equivocar:** el satélite pasa hacia la
**1:30 de la madrugada** y el sismo fue a las **7:34**. La imagen fechada el 10
de agosto es de **seis horas antes** del sismo: es línea base, no evento.

**Lo que este método no puede hacer:**
- Los valores salen de un PNG con paleta, no de radiancia física. Comparan una
  noche contra otra en el mismo sitio; no son nW/cm²/sr.
- Las ciudades grandes **saturan**. Bogotá y Medellín marcan 255 siempre: allí
  un apagón parcial no se vería. Se marcan aparte.
- Un pueblo que parte de muy poca luz da porcentajes frágiles. Por debajo de
  ~30 se marca la medida como poco confiable en vez de fingir precisión.
- «Rellenado» significa que los huecos de nube se completan con modelo: en el
  Chocó eso puede ser estimación, no observación.

Resultado real sobre los municipios del catálogo (noches 11–12 contra 8–10):
**San José del Palmar, el pueblo del epicentro, −34%** (medida frágil, parte de
poca luz); Palmira −18%; Zarzal −16%; Pereira −14%.

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

---

## 7. USGS PAGER — poblados, población y sacudida punto por punto

**Lo que rompe el techo de resolución del sistema.** Verificado el 2026-08-15.

Hasta aquí, la granularidad máxima era el departamento: IODA no baja de ahí y
XM publica por área operativa. Chocó son 46.500 km², y nadie lleva un enlace
satelital a un departamento.

El producto `losspager` del evento publica `json/cities.json`, con **todos los
poblados expuestos**: nombre, coordenadas, **población** e **intensidad MMI
interpolada desde el ShakeMap en esa coordenada exacta**. Para `us6000tjl2` son
**624 lugares**, y no es una estimación de nadie: es el cálculo con el que el
USGS emitió su alerta roja.

```
# La URL lleva sello de versión y cambia cuando reprocesan: resolverla siempre
# desde el detalle del evento, nunca cablearla.
GET https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=us6000tjl2
    → properties.products.losspager[0].contents["json/cities.json"].url
```

Reparto medido para este evento:

| MMI ≥ | lugares | población | teselas Black Marble distintas |
|-------|---------|-----------|-------------------------------|
| 4,0   | 537     | 36.456.396| 20                            |
| 5,0   | 263     | 17.238.802| 13                            |
| 6,0   | 104     |  7.902.416|  7                            |
| 7,0   |  21     |  2.563.636|  —                            |

Ventajas sobre todo lo demás del catálogo: **no depende de que ninguna red siga
en pie** (sale de sismómetros), llega con población incorporada, y su
resolución es el poblado. Escribe sin tildes (`Quibdo`, `Tado`, `San Jose del
Palmar`); conviene reescribir los nombres contra un catálogo propio.

También sirve `json/exposures.json` (población por franja de MMI) y
`coverage_mmi_{low,medium,high}_res.covjson` (rejilla regular de MMI; la baja
son 172×171 nodos ≈ 4 km, 118 KB).

---

## 8. La deriva del satélite: por qué un −12% no era un apagón

**El hallazgo más importante del 2026-08-15, y el que evita 114 falsos positivos.**

Al medir Black Marble sobre los 537 poblados expuestos, la luz nocturna había
bajado una **mediana de −12,2% respecto a antes del sismo**. Leerlo en crudo
habría marcado 114 pueblos como «sin luz».

Era falso. El desglose por sacudida lo delata:

| franja MMI | poblados | cambio mediano |
|------------|----------|----------------|
| 4,9 – 5,5  | 75       | **−8,2 %**     |
| 5,5 – 6,0  | 80       | −12,3 %        |
| 6,0 – 6,5  | 49       | −16,6 %        |
| 6,5 – 7,0  | 34       | −17,6 %        |
| 7,0 – 8,5  | 21       | −13,6 %        |

**A MMI 5 no se cae un poste**, y aun así esos pueblos marcaban −8,2%. Ese
fondo es fase lunar, nubosidad y relleno por modelo del producto — no
electricidad. El archivo ya documentaba esa trampa para la banda cruda; lo
nuevo es que **el producto BRDF-corregido la reduce pero NO la elimina**.

Hay señal real: el gradiente de −8% a −17% sí acompaña a la sacudida. Pero la
señal es la **diferencia**, no el número absoluto.

### La corrección

Es la misma idea que ya se usa con IODA —comparar contra un testigo que cancele
lo que no interesa— aplicada al espacio en vez de al tiempo:

1. Se piden los poblados desde **MMI 4,0**, aunque solo se muestren desde 5,0.
   Los que apenas temblaron son el **grupo de control**: lo que les pasó a
   ellos le pasó al satélite, no al sismo. Cuestan 7 teselas más.
2. La **deriva** es la mediana de su cambio. Medida el 2026-08-15 con 376
   poblados de control: **−6,8%**.
3. Se le resta a todos los demás. Los porcentajes que se publican y los que
   van dentro de las cartas ya llevan la resta hecha.
4. Solo entran al control las confianzas `media` y `alta`. Un pueblo que parte
   de casi nada de luz mete un ruido enorme en la mediana.
5. **Si no hay al menos 20 poblados de control, no se corrige y la capa de luz
   deja de usarse para clasificar.** Un «no sé» honesto vale más que 114
   pueblos pintados de rojo por culpa de la luna.

Resultado: los «sin luz» pasan de **114 a 28**.

### Y la categoría que faltaba: el punto ciego

Una medida que existe pero no es concluyente **no cuenta como medición**. Si
contara, un pueblo del que solo sabemos «el número salió pero no significa
nada» quedaría marcado como comprobado y desaparecería de la lista de los que
hay que ir a mirar.

De ahí sale la clasificación por **certeza**, que es lo que ninguna capa
anterior decía:

- `local` — se midió en ese punto (satélite sobre el casco, o sonda física a
  menos de 25 km).
- `heredada` — solo se conoce el promedio de su departamento. No dice nada de
  ese pueblo en concreto.
- `ninguna` — nadie lo ha mirado.

Y el **punto ciego**: un poblado que el USGS confirma sacudido a MMI ≥ 6, con
gente dentro, sin ninguna medición local. Medidos el 2026-08-15: **23 poblados,
325.333 personas**, entre ellos **San José del Palmar, el epicentro mismo**, y
11 municipios más del Chocó.

Un punto ciego **no es un pueblo sin problemas: es un pueblo sin datos**, y
suele ser justo lo contrario. Antes se veía igual que uno comprobado sano.

Endpoint: `GET /api/mapa/lugares?mmi_min=5&horas=3&noches=3`

---

## 9. geoBoundaries ADM2 — los 1.122 municipios, y el umbral que sale del ruido

Verificado el 2026-08-15.

PAGER da lugares poblados de un gacetero, no la división administrativa. Quien
firma un despacho trabaja por MUNICIPIO, así que la base pasa a ser el listado
oficial:

```
https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/
  gbOpen/COL/ADM2/geoBoundaries-COL-ADM2_simplified.geojson      (10,1 MB, 1.122)
```

Se cruza con PAGER (casco urbano y población) y con la rejilla del ShakeMap
`coverage_mmi_medium_res.covjson` (343×342 nodos cada ~2 km, 470 KB), que da
intensidad en CUALQUIER punto y no solo en los 624 de PAGER. Comprobada contra
PAGER donde ambos coinciden: Pereira 7,8 contra 7,87; Quibdó 7,7 contra 7,78.

Resultado: **586 municipios afectados (MMI ≥ 4) en 20 departamentos**.
Script: `herramientas/preparar_municipios.py` → `web/data/municipios.json`.

### El punto de medición, y por qué hay tres clases

| clase | n | qué significa |
|-------|---|----------------|
| `poblado`    | 557 | Hay casco urbano de PAGER dentro y su nombre concuerda. La luz medida ahí significa algo. |
| `aproximado` |  20 | Cae uno dentro, pero con nombre de otro municipio. Con bordes simplificados eso es el pueblo VECINO. |
| `centroide`  | 545 | No hay ninguno. El centro geométrico, que en el Chocó es selva. |

**Solo se mide luz en los 557.** Medir en un centroide rural mide oscuridad de
monte, y en un `aproximado` se le atribuiría a un municipio el alumbrado de
otro. Los otros 565 quedan como no medibles, que es lo que son.

Separar `aproximado` de `poblado` no es trivial y hacerlo mal falla en las dos
direcciones: «Don Matías / Donmatias» y «El Litoral del San Juán (Docordó) /
Santa Genoveva de Docordó» son el MISMO sitio escrito distinto, mientras que
«Sotaquirá / Paipa» y «Rondón / Zetaquira» son pueblos distintos. Se resuelve
por palabras compartidas de ≥4 letras: las variantes siempre comparten el
nombre propio, los pueblos distintos no comparten ninguno.

### Los umbrales de apagón salen del ruido, no de un número redondo

Ya con la deriva de §8 descontada, se midió la dispersión DENTRO del grupo de
control —municipios donde el sismo no rompió nada:

| percentil | p1 | p5 | p10 | p25 | p50 | p75 | p90 |
|---|---|---|---|---|---|---|---|
| cambio | −63,2% | −25,7% | −20,4% | −8,9% | **+0,5%** | +6,6% | +9,3% |

Y la señal real por franja de intensidad, ya corregida:

| MMI | 4,0–4,5 | 4,5–5,0 | 5,0–5,5 | 5,5–6,0 | 6,0–6,5 | 6,5+ |
|---|---|---|---|---|---|---|
| mediana | +0,5% | +3,2% | +6,5% | −1,9% | −2,1% | **−5,4%** |

**La señal existe pero vive dentro del ruido:** −5,4% de efecto contra ±20% de
dispersión. Con el umbral fijo de −35% que se usaba antes, **el 3% del grupo de
control salía «sin luz» y el 11% «poca luz»** — sobre 586 municipios, decenas
de apagones inventados en sitios donde no pasó nada.

Por eso el umbral se calibra contra el propio control: «sin luz» exige caer por
debajo de su **percentil 2** y «poca luz», del **percentil 10**. Medidos el
2026-08-15 con 123 municipios de control: **−42,5%** y **−22,8%**. Eso fija la
tasa de falsos positivos por construcción (2% y 10%) y la respuesta la publica
en `deriva_luz.falsos_positivos_esperados`, en vez de dejar que el lector se la
imagine.

Consecuencia práctica: los «sin luz» pasan de 114 (umbral crudo) a 40 (con
deriva) a **22** (con umbral calibrado). Los tres números salen de los mismos
datos; solo el último es defendible.

Endpoints: `GET /api/mapa/municipios?mmi_min=4` y `.csv` para adjuntar.

---

## 10. Fuentes externas: quién más está mirando esto

Buscadas y probadas el 2026-08-15. **Seis candidatas, dos sirven.**

### GDACS — alerta oficial y población expuesta · FUNCIONA

`https://www.gdacs.org/gdacsapi/api/events/` — JSON abierto, sin llave, ~2 s.
Sin CORS: hay que proxiar por el backend.

```
# El id puede cambiar si reprocesan: buscar por fecha y filtrar por iso3
/geteventlist/SEARCH?eventtype=EQ&fromDate=2026-08-09&toDate=2026-08-12&alertlevel=Red;Orange
/geteventdata?eventtype=EQ&eventid=1557236
```

Aporta lo que HOPE **no puede calcular**: cuánta gente vive dentro del área
sacudida a intensidad VII o más. Sale de cruzar el ShakeMap con una rejilla
global de población.

| campo | valor medido |
|---|---|
| `alertlevel` / `alertscore` | Red / 3 |
| `shakepop` | **1.969.735** (MMI ≥ VII, con ShakeMap) |
| `rapidpop` | 2.883.124 (MMI ≥ VII, estimación rápida) |
| `depth` | 107 km |

Va dentro de las cartas: que la cifra venga de la Comisión Europea y no de
nosotros es lo que la hace resistir en una petición formal.
**Límite:** es exposición, no daño — cuenta a quien sintió la sacudida, no a
quien perdió la casa. Y el nivel de alerta es del evento entero.

> **Trampa que costó un 403:** GDACS rechaza cualquier petición cuyo
> `User-Agent` lleve un carácter no ASCII. El del proyecto decía «respuesta
> sismo Chocó» y devolvía 403 sistemáticamente — se veía igual que una fuente
> caída. Ahora la cabecera es ASCII y está en una sola constante, `AGENTE`.

### HDX / CKAN (OCHA) — el catálogo en vivo · FUNCIONA

`https://data.humdata.org/api/3/action/package_search?q=colombia+earthquake`
JSON abierto, sin llave, **CORS `*`**, 0,6 s. Se filtra por
`metadata_modified >= 2026-08-10` para quedarse con lo de este sismo.

Lo publicado sobre este evento al 2026-08-15 (7 conjuntos):

| organización | qué publicó | formato |
|---|---|---|
| **UNOSAT** | Exposición de población del evento | XLSX |
| **UNOSAT** | **Evaluación de daño en edificios, Viterbo (Caldas)** | GDB, SHP |
| **HOT** | Edificios y vías de la zona, actualizados | GeoJSON, SHP |
| **Microsoft AI for Good** | **Predicción de daño edificio por edificio, Cali** (Airbus) | GeoTIFF, GPKG |
| **Microsoft AI for Good** | Ídem sobre **Pereira** (Vantor) | GeoTIFF, GPKG |
| GDACS | RSS del sistema de alertas | CSV |
| GLIDE | Eventos de desastre de Colombia | CSV, GeoJSON |

Sirve para dos cosas distintas y las dos importan: **no repetir trabajo** —
UNOSAT y Microsoft ya hicieron evaluación de daño con satélite, y eso es mejor
que nada que HOPE pueda derivar— y **saber a quién escribirle**: una
organización que ya publicó datos de este evento tiene equipo dedicado a él.

Los pesados (Geopackage, GeoTIFF de 10-77 MB) **no se procesan**: harían falta
GDAL y decenas de megas por consulta. Se entregan los enlaces para abrirlos en
QGIS, que es donde sirven.

### Probadas y descartadas

| fuente | resultado |
|---|---|
| **ReliefWeb v1** | 410 — decomisionada. |
| **ReliefWeb v2** | 403 — exige *registrar la aplicación*. Es gratis en `reliefweb.int/help/api`; con eso entrarían los informes de situación oficiales. **Vale la pena pedirla.** |
| **WFP ADAM** | 401 — exige llave. |
| **Copernicus EMS** (RSS de activaciones) | 404 en la ruta publicada. Si hay activación de mapeo rápido, sus productos suelen acabar en HDX, que sí se consulta. |

Endpoint: `GET /api/fuentes/externas`

## Operadores eléctricos y telcos: buscado a fondo el 2026-08-13

La pregunta obvia es «¿por qué no pegarse directo a la API del operador que
sabe si hay luz?». La respuesta corta: **no existe.** La larga, para que nadie
tenga que repetir la búsqueda:

### Distribuidoras eléctricas

| Operador | Zona | Qué hay | Por qué no sirve |
|---|---|---|---|
| **EPM** | Antioquia | Página AEM con interrupciones | Solo **programadas**. Sin API: se probó interceptando la red del navegador y no hay endpoint de datos. Además Antioquia no es zona del sismo. |
| **Enel** | Bogotá, Cundinamarca | Mapa de cortes | Página con protección anti-bot; no devuelve JSON propio. |
| **Celsia** | Valle, Tolima, Cauca | Portal de clientes | Ninguna respuesta JSON propia al cargar. |
| **CHEC** | **Caldas** | App ArcGIS pública | La app (`4b557aa0…`) resultó ser **«SEDES COMERCIALES»**, oficinas, no cortes. |
| **EMCALI** | Cali | Línea 177 | Se reporta por teléfono. Sin API. |
| **EDEQ / DISPAC / CEDENAR** | Quindío, Chocó, Nariño | — | Sin endpoint público. |

**Conclusión: ninguna distribuidora colombiana publica cortes en tiempo real
por API.** Lo que hay son páginas para consulta humana, varias detrás de
protección anti-bot. Apoyar una herramienta de emergencia en raspar esas
páginas es construir sobre algo que se rompe sin aviso y sin nadie a quien
reclamarle.

### Telcos

Claro, Tigo, Movistar y ETB: **sin página de estado con API**. Se probaron
además los patrones habituales (`status.<dominio>/api/v2/status.json`, de
Statuspage) y ninguno responde. No hay equivalente colombiano a un status page
de operador.

### datos.gov.co (Socrata) — API real, datos viejos

Esta **sí** es una API de verdad y documentada: `https://www.datos.gov.co/resource/{id}.json`
con lenguaje de consulta SoQL (`$select`, `$where`, `$order`, `$limit`).
El problema es la frescura:

| Conjunto | Qué trae | Último dato |
|---|---|---|
| `3a44-zwt6` | Generación **diaria** por localidad en Zonas No Interconectadas, con horas de encendido/apagado y causal de no generación | **2023-06-30** |
| `3ebi-d83g` | Energía por localidad ZNI, mensual | 2026-01 en general, pero **Chocó se detiene en 2022-08** |
| `as4w-pgry` | Índice de calidad ITAD por empresa | Trimestral |

El de generación diaria en ZNI habría sido excelente — granularidad de
**localidad** justo donde IODA y XM son ciegos, que es el Chocó rural. Lleva
tres años sin actualizarse.

### OONI — probado y descartado como detector de cortes

`https://api.ooni.io/api/v1/aggregation?probe_cc=CO&since=…&axis_x=measurement_start_day`
Gratis, sin llave, y mide desde **dispositivos reales dentro del país** (al
revés que IODA, que sondea desde fuera). Unas 11.000 mediciones diarias en
Colombia, con ASN.

Suena ideal y no sirve para esto. La tasa de anomalías fue:

```
2026-08-03  1,84%   ← día normal
2026-08-08  1,23%
2026-08-09  1,42%
2026-08-10  1,98%   ← día del sismo
2026-08-11  1,90%
```

El día del sismo (1,98%) apenas supera un martes cualquiera (1,84%). **La
variación normal se come la señal.** Y por diseño de privacidad OONI no publica
ubicación por debajo del país, así que tampoco aporta geografía. Se deja
documentado para no volver a intentarlo.

---

## Lo que NO existe — verificado, no volver a buscar

- **Feed de personas atrapadas en tiempo real.** No lo tiene nadie. Solo reportes humanos.
- **Búsqueda de Instagram por hashtag o ubicación.** La API con Instagram Login
  no la soporta y `GET_IG_USER_TAGS` está deprecado. Solo se lee la propia cuenta.
- **API pública de cortes de los operadores eléctricos colombianos**
  (EPM, Celsia, Enel, Air-e, Afinia, DISPAC, CHEC, EDEQ). Verificado a fondo el
  2026-08-13 interceptando la red de sus propias páginas: ver la sección de
  arriba. No apoyarse en raspado para una herramienta de emergencia.
- **Página de estado con API de las telcos** (Claro, Tigo, Movistar, ETB).
  Tampoco usan Statuspage ni equivalente.
- **Alguna fuente que dé cortes de energía por municipio en tiempo real.**
  No la hay en Colombia. Lo más cerca es XM por área operativa con 1-2 días de
  rezago, y VIIRS Black Marble por satélite si se procesa bien.
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
