# HOPE — mapa base del sismo M7.4 Chocó (10 ago 2026)

Visualización geoespacial del sismo y capa editable para captar puntos
(reportes, necesidades, daños). Corre en un portátil, sin servicios de pago.

---

## ⚠ Antes de usarlo con datos reales

**Una capa de reportes sin canal hacia quien ejecuta el rescate no llega a nadie.**
Definir el destinatario es requisito de diseño, no fase 2:

| Entidad | Rol |
|---|---|
| **UNGRD** | Coordinación nacional de la respuesta. Destinatario del consolidado. |
| **DAGRD / CMGRD municipal** | Despacha máquina y personal en terreno. |
| **Cruz Roja Colombiana, Defensa Civil** | Búsqueda, rescate, atención prehospitalaria. |
| **Bomberos** | Estructuras colapsadas. |

Mientras no exista un canal acordado, esto es un **ejercicio de visualización
interno**. No publicarlo como canal de emergencia: genera una expectativa de
auxilio que no puede cumplir, y eso hace daño. La línea de emergencia es **123**.

Dos decisiones ya tomadas en el código por esta razón:

- Todo reporte nace con `verificado = false` y se dibuja con borde punteado. Un
  despacho hacia un punto falso es capacidad que se le quita a un punto real.
- El campo `contacto` es dato personal: se **excluye** de las exportaciones salvo
  que se marque explícitamente.

---

## Correr

```bash
pip install -r requirements.txt
```

```bash
uvicorn backend.main:app --reload --port 8000
```

Abre <http://127.0.0.1:8000>. El backend sirve la API y el frontend estático.
La documentación interactiva de la API queda en `/docs`.

**Sin backend**: `web/index.html` también funciona solo — ábrelo con cualquier
servidor estático (`python -m http.server` dentro de `web/`). El frontend detecta
que no hay API y guarda los reportes en `localStorage` del navegador. El indicador
del panel dice en cuál de los dos modos está.

Para probar filtros y exportación con datos ficticios (van marcados `EJEMPLO —`):

```bash
python backend/main.py --sembrar
```

---

## Qué muestra

| Capa | Origen | Nota |
|---|---|---|
| Epicentro + anillos 50/100/200/300 km | `web/data/evento.json` | Fijo |
| Réplicas | USGS FDSN, **en vivo** | Se recarga en cada apertura |
| Contornos de intensidad (MMI) | ShakeMap del USGS, **en vivo** | Resuelve la versión vigente del producto |
| **Corte de internet** | **IODA (Georgia Tech), en vivo** | Por departamento. Requiere backend |
| **Energía no entregada** | **XM (SIN Colombia), en vivo** | Por área operativa. Requiere backend |
| Ciudades de referencia | `web/data/ciudades.json` | Distancia al epicentro calculada |
| Reportes | SQLite o localStorage | Capa editable |

---

## Cortes de red y energía: qué se mide de verdad

Dos fuentes públicas, sin llave de API, verificadas el 2026-08-12.

**IODA** — Internet Outage Detection and Analysis, Georgia Tech.
`https://api.ioda.inetintel.cc.gatech.edu/v2/`
Mide alcanzabilidad de internet por tres métodos independientes: `bgp` (rutas que
desaparecen de la tabla global), `ping-slash24` (sondeo activo a bloques /24) y
`merit-nt` (telescopio de red). Manda CORS. **Granularidad máxima en Colombia:
departamento — no hay municipios.**

**XM** — operador del Sistema Interconectado Nacional.
`https://servapibi.xm.com.co/daily`, POST, sin llave.
Métrica `DemaNoAtenNoProg`: energía que se debió entregar y no se entregó, en
kWh/día por área operativa. Un apagón deja rastro aquí. Rezago ~1 día.
(Ojo: la métrica horaria `DemaReal` sí tiene ~3 días de rezago.)

### Lo que midieron

Internet, ventana 9–13 de agosto, score acumulado de IODA:

| Departamento | Score | Eventos |
|---|---:|---:|
| **Valle del Cauca** | **11.926.225.573** | 10 |
| Risaralda | 241.536.527 | 5 |
| Quindío | 675.224 | 4 |
| Cauca | 14.842 | 2 |
| Caldas | 5.753 | 4 |
| Chocó | 58 | 3 |

El evento mayor de Risaralda arranca en `2026-08-10T12:30:00Z` — el bin de cinco
minutos que contiene el sismo (12:34:28 UTC) — y dura **45,8 horas**.

Energía, `DemaNoAtenNoProg`:

| Fecha | Total nacional | Área dominante |
|---|---:|---|
| 25 jul – 9 ago (base) | 33.000 – 300.000 kWh/día | variable |
| **10 ago (sismo)** | **8.469.830 kWh** | **SUROCCIDENTAL: 8.381.220 (99%)** |
| 11 ago | 113.490 kWh | vuelve a normal |

Área Suroccidental llegó a **282,6 veces su propia línea base**.

**Las dos fuentes se corroboran sin conocerse.** Una mide rutas BGP y respuesta a
pings; la otra mide kilovatios entregados. Ambas señalan el suroccidente por dos
órdenes de magnitud sobre el resto. Eso ya no es ruido de medición.

### La trampa que este código evita: el punto ciego

**Un score bajo no significa que la zona esté bien.** Chocó es el epicentro y su
score es 58 — dos órdenes de magnitud por debajo de Valle del Cauca. La razón no
es que Chocó esté mejor: es que **casi no tiene infraestructura de internet que
pueda caerse.** IODA mide lo que está conectado. Donde no hay línea base, no hay
señal de corte.

Por eso `fuentes.interpretar_cobertura()` clasifica aparte la categoría
`punto_ciego`: departamento con daño confirmado por el sismo **y** sin señal
medible. Se dibuja en morado con borde punteado, nunca en verde. Si se pintara
con la misma escala que el resto, la zona que más necesita un enlace satelital
sería literalmente invisible en el mapa.

Puntos ciegos detectados hoy: **Chocó, Nariño, Tolima**.

Ese es el ordenamiento que da `/api/cortes/prioridad`: primero lo medido como
colapso, después los puntos ciegos. **Es un ordenamiento de evidencia, no un plan
de despliegue.** Dónde poner un Starlink depende además de acceso por vía,
seguridad y de qué está haciendo ya el organismo que coordina esa zona.

---

## Datos del evento — verificados

Contrastados contra el USGS el 2026-08-12 (`GET /fdsnws/event/1/query?eventid=us6000tjl2`):

| Campo | Valor |
|---|---|
| Magnitud | **7.4** (mww) |
| Epicentro | 4.8436, −76.2422 — 5 km al S de San José del Palmar, Chocó |
| Profundidad | **110.3 km** |
| Fecha | 2026-08-10 12:34:28 UTC = **07:34 hora Colombia** |
| Alerta PAGER | **roja** |
| Intensidad máxima | MMI 8.0 (severo) |
| ID USGS | `us6000tjl2` |

Correcciones respecto al brief inicial:

- La profundidad **no es ~90 km sino 110.3 km** según USGS. El SGC reportó un
  rango de 96 a 120,5 km. Ambas cifras son consistentes entre sí; la de 90 no.
- Es un sismo **profundo de subducción**: por eso se sintió en casi todo el país
  y en Ecuador, Panamá y Venezuela, y por eso el daño se dispersa en vez de
  concentrarse en un radio pequeño alrededor del epicentro.

**El SGC es la autoridad sismológica en Colombia.** Este proyecto usa USGS porque
expone una API pública documentada y estable. Contrastar con el SGC antes de
cualquier uso oficial.

### Endpoints verificados (funcionando al 2026-08-12)

```
https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=us6000tjl2
https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=…&minlatitude=…
https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{significant,4.5,2.5,1.0,all}_{hour,day,week,month}.geojson
```

Los contornos MMI salen del producto ShakeMap (`download/cont_mi.json`): es un
`FeatureCollection` de `MultiLineString` con `properties.{value, units, color, weight}`.
Su URL lleva versión con *timestamp*, así que la app resuelve la vigente en
tiempo real desde el detalle del evento y solo cae a la fija si eso falla.

### Lo que **no** está verificado

`web/data/ciudades.json` → campo `danos_prensa`. Viene de prensa de las primeras
horas, va marcado `verificado: false` y aparece con advertencia en el popup.
**No hay cifras de víctimas cableadas en ningún archivo**: cambian por hora, y un
número congelado en un JSON desinforma. Esas las publica la UNGRD.

---

## Estructura

```
backend/main.py       FastAPI + SQLite. Sin ORM, sin dependencias extra.
data/hope.db          Se crea sola al arrancar. No versionar.
web/index.html        Estructura
web/style.css         Estilos
web/app.js            Mapa (Leaflet), capas, captura, filtros, import/export
web/data/evento.json  Parámetros del sismo + fuentes
web/data/ciudades.json
```

## API

| Método | Ruta | |
|---|---|---|
| `GET` | `/api/salud` | Sonda que usa el frontend para decidir su modo |
| `GET` | `/api/reportes` | GeoJSON. Filtros: `tipo`, `prioridad`, `estado`, `solo_verificados`, `incluir_contacto` |
| `POST` | `/api/reportes` | Crear |
| `PUT` | `/api/reportes/{id}` | Actualizar |
| `DELETE` | `/api/reportes/{id}` | Eliminar |
| `GET` | `/api/reportes.geojson` | Descarga para entrega (QGIS, ArcGIS, Google Earth) |
| `GET` | `/api/reportes.csv` | Descarga para Excel (con BOM) |
| `GET` | `/api/estadisticas` | Conteos por tipo/prioridad/estado |
| `GET` | `/api/cortes/internet?horas=96` | Score de corte por departamento (IODA) |
| `GET` | `/api/cortes/internet/{codigo}?horas=96` | Eventos con hora de inicio y duración reales |
| `GET` | `/api/cortes/energia?dias=20` | Energía no entregada por área (XM) + línea base |
| `GET` | `/api/cortes/prioridad?horas=96` | Ranking cruzado para decidir dónde llevar enlaces |

Los cortes pasan por el backend y no directo desde el navegador porque XM solo
acepta POST y no manda CORS, y así queda una caché compartida (10 min) en vez de
una por pestaña abierta.

## Mapear personas atrapadas

**No existe ningún feed de personas atrapadas.** No lo tiene el USGS, ni el SGC,
ni la UNGRD, ni ningún satélite. Un punto de "persona atrapada" en cualquier mapa
del mundo nace de un ser humano que lo reportó: una llamada, un radio, un vecino,
un equipo en terreno. La tecnología que sí detecta cuerpos bajo escombros es
radar de vida tipo IR-UWB (FINDER), que es un equipo dedicado y va en tierra.

Lo que este proyecto puede hacer, y hace, es el canal: `tipo: rescate` con
prioridad, estado, verificación y exportación a quien despacha. La calidad del
mapa depende enteramente de la calidad de quien reporta — por eso el campo
`verificado` existe y por eso nada nace verificado.

## Instagram como canal de entrada

Estado real de `@stivenetereo`, revisado el 2026-08-12:

- La API de Instagram **no permite buscar por hashtag ni por ubicación**.
  `GET_IG_USER_TAGS` está deprecado en integraciones con Instagram Login. Solo se
  puede leer la propia cuenta: posts propios, comentarios en ellos, y DMs.
  **Instagram no puede usarse para descubrir zonas afectadas.**
- La cuenta no tiene ninguna publicación sobre el sismo. El último post es del
  8 de agosto, sobre Huarte de San Juan.
- Los hilos de DM activos el 10–11 de agosto son conversación personal. **Cero
  reportes de emergencia.**

Conclusión: hoy Instagram aporta cero al mapa. Se vuelve útil solo si publicas
pidiendo reportes con un formato fijo (municipio + barrio + qué se necesita), y
aun así habría que verificar cada uno antes de que llegue a un equipo de rescate.

### Modelo de un reporte

`tipo`: rescate · salud · estructural · refugio · agua · alimentos · vias · servicios · recurso · otro
`prioridad`: critica · alta · media · baja
`estado`: nuevo · verificado · en_atencion · atendido · descartado
`fuente`: llamada · whatsapp · terreno · radio · redes · oficial · otro

Los catálogos están duplicados en `backend/main.py` y `web/app.js`. Si se toca
uno hay que tocar el otro; el backend rechaza con 422 lo que no esté en su lista.

## Seguridad

**El backend no tiene autenticación.** Está pensado para la máquina de quien
coordina o una red interna de confianza. Antes de exponerlo:

1. Cerrar el CORS abierto en `backend/main.py` (`allow_origins=["*"]`).
2. Poner autenticación.
3. Limitar tasa de escritura — un formulario público sin límite se llena de ruido
   en horas, y el ruido en una emergencia cuesta vidas.

## Estado y qué sigue

Hecho: visualización del sismo, captura de puntos (crear, editar, filtrar,
importar, exportar) con y sin backend, y capas de corte de internet y energía
contra fuentes reales. Verificado con prueba de humo de la API (29 + 27
comprobaciones contra las fuentes en vivo) y extremo a extremo en navegador
(33 + 23).

Lo siguiente, en orden de utilidad real:

1. **Acordar el destinatario de los datos.** Bloquea todo lo demás.
2. **Conseguir granularidad municipal de conectividad.** IODA solo llega a
   departamento en Colombia, y "Valle del Cauca sin internet" no dice dónde
   poner la antena. Vías posibles: Cloudflare Radar (requiere token), sondas
   RIPE Atlas por ciudad, o los reportes de los propios operadores.
3. Formulario público de captación, separado del panel de coordinación, con
   límite de tasa y cola de moderación.
4. Agrupamiento de marcadores (`Leaflet.markercluster`) — a partir de unos
   cientos de puntos el mapa se vuelve ilegible.
5. Detección de duplicados por proximidad: dos reportes a 30 m son casi siempre
   el mismo hecho, y contarlos dos veces distorsiona la priorización.
6. Capa de infraestructura crítica (hospitales, albergues, vías) desde
   OpenStreetMap vía Overpass API.
7. Modo offline (service worker + tiles en caché) para quien tenga conexión
   intermitente.
