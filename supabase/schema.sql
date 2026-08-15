-- =====================================================================
-- HOPE — esquema para Supabase
-- Respuesta al sismo M7.4 del 10 de agosto de 2026 (Chocó, Colombia)
-- =====================================================================
--
-- CÓMO APLICARLO
--   Supabase → SQL Editor → New query → pegar todo esto → Run.
--   Es idempotente: se puede volver a correr sin romper nada.
--
-- DECISIÓN DE PRIVACIDAD, LA MÁS IMPORTANTE DE ESTE ARCHIVO
--   Las tablas públicas (`zonas`, `aportes`) NO contienen ni un solo dato
--   personal. Los teléfonos y nombres viven en `contactos`, donde el rol
--   `anon` puede INSERTAR pero NUNCA LEER.
--
--   Esto no es paranoia: `zonas` y `aportes` están publicadas en Realtime,
--   y cualquiera con la anon key —que va en el navegador y por tanto es
--   pública— puede suscribirse y recibir cada fila nueva. Si el teléfono
--   estuviera ahí, se estaría transmitiendo el directorio de personas
--   vulnerables a cualquiera que abra la consola. Por eso va aparte.
--
-- =====================================================================

-- ── Catálogos ────────────────────────────────────────────────────────

do $$ begin
  create type zona_tipo as enum (
    'buscar_personas',   -- se cree que hay gente atrapada o incomunicada
    'sin_energia',       -- sin electricidad
    'sin_internet',      -- sin comunicaciones
    'infraestructura',   -- edificación con daño, colapsada o por revisar
    'albergue',          -- punto de refugio activo
    'salud',             -- necesidad de atención médica
    'agua_alimentos',    -- agua potable o comida
    'via_bloqueada',     -- acceso interrumpido
    'otro'
  );
exception when duplicate_object then null; end $$;

-- Migración: tipo agregado después del lanzamiento inicial. ADD VALUE IF NOT
-- EXISTS es seguro de repetir y no rompe instalaciones que ya tienen el enum.
alter type zona_tipo add value if not exists 'punto_donacion'; -- acopio físico de donaciones, verificado por un humano

do $$ begin
  create type zona_estado as enum (
    'nuevo',        -- reportado, sin confirmar
    'verificado',   -- confirmado por fuente confiable
    'en_atencion',  -- alguien está trabajando en ello
    'resuelto',
    'descartado'    -- falso, duplicado o ya no aplica
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type aporte_tipo as enum (
    'starlink',
    'generador',
    'panel_solar',
    'bateria',
    'internet_movil',   -- hotspot, router LTE
    'combustible',
    'transporte',
    'personal_tecnico',
    'otro'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type aporte_estado as enum (
    'ofrecido',    -- alguien lo tiene y lo presta
    'asignado',    -- ya tiene destino
    'en_camino',
    'instalado',
    'retirado'
  );
exception when duplicate_object then null; end $$;

-- ── Zonas: un lugar que necesita algo ────────────────────────────────
-- SIN DATOS PERSONALES. Ver nota de privacidad arriba.

create table if not exists public.zonas (
  id                uuid primary key default gen_random_uuid(),
  tipo              zona_tipo   not null default 'otro',
  estado            zona_estado not null default 'nuevo',
  titulo            text        not null check (length(trim(titulo)) between 3 and 120),
  descripcion       text        not null default '' check (length(descripcion) <= 1000),
  municipio         text        not null default '' check (length(municipio) <= 120),
  departamento      text        not null default '' check (length(departamento) <= 80),
  lat               double precision not null check (lat between -4.3 and 13.5),
  lon               double precision not null check (lon between -82.0 and -66.8),
  radio_m           integer     not null default 500 check (radio_m between 50 and 50000),
  personas_estimadas integer    not null default 0 check (personas_estimadas between 0 and 100000),
  urgencia          smallint    not null default 2 check (urgencia between 1 and 4), -- 1 crítica … 4 baja
  verificado        boolean     not null default false,
  verificado_por    text        not null default '' check (length(verificado_por) <= 120),
  contacto_publico  text        not null default '' check (length(contacto_publico) <= 80),
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);

-- Los límites de lat/lon son la caja de Colombia. Un punto fuera del país en
-- este sistema es un error de captura o ruido, no un reporte.

comment on table public.zonas is
  'Zonas que necesitan algo. Público, sin datos personales. Un registro con '
  'verificado=false NO es un hecho confirmado.';

create index if not exists ix_zonas_tipo      on public.zonas (tipo);
create index if not exists ix_zonas_estado    on public.zonas (estado);
create index if not exists ix_zonas_creado    on public.zonas (creado_en desc);
create index if not exists ix_zonas_urgencia  on public.zonas (urgencia);

-- ── Aportes: alguien que ofrece un recurso ───────────────────────────
-- SIN DATOS PERSONALES.

create table if not exists public.aportes (
  id             uuid primary key default gen_random_uuid(),
  tipo           aporte_tipo   not null default 'otro',
  estado         aporte_estado not null default 'ofrecido',
  titulo         text          not null check (length(trim(titulo)) between 3 and 120),
  descripcion    text          not null default '' check (length(descripcion) <= 1000),
  cantidad       integer       not null default 1 check (cantidad between 1 and 1000),
  organizacion   text          not null default '' check (length(organizacion) <= 120),
  municipio_base text          not null default '' check (length(municipio_base) <= 120),
  lat            double precision check (lat between -4.3 and 13.5),
  lon            double precision check (lon between -82.0 and -66.8),
  zona_id        uuid references public.zonas(id) on delete set null,
  contacto_publico text        not null default '' check (length(contacto_publico) <= 80),
  creado_en      timestamptz   not null default now(),
  actualizado_en timestamptz   not null default now()
);

comment on table public.aportes is
  'Recursos ofrecidos (Starlink, generadores, paneles). Público, sin datos personales.';

create index if not exists ix_aportes_tipo   on public.aportes (tipo);
create index if not exists ix_aportes_estado on public.aportes (estado);
create index if not exists ix_aportes_zona   on public.aportes (zona_id);

-- ── Migración: contacto público opcional (instalaciones previas a este campo) ──
-- ADD COLUMN IF NOT EXISTS es un no-op si ya se creó arriba (instalación
-- nueva). En una instalación existente, esto es lo que realmente agrega la
-- columna: distinto de `contactos.telefono`, que es privado y nunca se lee.
-- Este es opcional y lo decide quien reporta: si lo llena, CUALQUIERA lo ve.
alter table public.zonas
  add column if not exists contacto_publico text not null default '' check (length(contacto_publico) <= 80);
alter table public.aportes
  add column if not exists contacto_publico text not null default '' check (length(contacto_publico) <= 80);

-- ── Contactos: AQUÍ Y SOLO AQUÍ van los datos personales ─────────────

create table if not exists public.contactos (
  id         uuid primary key default gen_random_uuid(),
  zona_id    uuid references public.zonas(id)   on delete cascade,
  aporte_id  uuid references public.aportes(id) on delete cascade,
  nombre     text not null default '' check (length(nombre) <= 120),
  telefono   text not null default '' check (length(telefono) <= 40),
  email      text not null default '' check (length(email) <= 160),
  nota       text not null default '' check (length(nota) <= 500),
  creado_en  timestamptz not null default now(),
  constraint contacto_pertenece_a_algo
    check (zona_id is not null or aporte_id is not null)
);

comment on table public.contactos is
  'DATOS PERSONALES. El rol anon puede INSERTAR pero jamás leer. Solo '
  'service_role lee esta tabla. No publicarla ni exportarla sin base legal.';

create index if not exists ix_contactos_zona   on public.contactos (zona_id);
create index if not exists ix_contactos_aporte on public.contactos (aporte_id);

-- ── actualizado_en automático ────────────────────────────────────────

create or replace function public.tocar_actualizado()
returns trigger language plpgsql as $$
begin
  new.actualizado_en = now();
  return new;
end $$;

drop trigger if exists t_zonas_actualizado on public.zonas;
create trigger t_zonas_actualizado before update on public.zonas
  for each row execute function public.tocar_actualizado();

drop trigger if exists t_aportes_actualizado on public.aportes;
create trigger t_aportes_actualizado before update on public.aportes
  for each row execute function public.tocar_actualizado();

-- ── Freno de inundación ──────────────────────────────────────────────
-- Un formulario público sin límite se llena de basura en horas, y la basura
-- en una emergencia cuesta vidas: cada reporte falso es un equipo desviado.
-- Esto no sustituye el rate limiting del gateway de Supabase; es la última
-- línea, la que sigue en pie aunque alguien use la anon key desde un script.

create or replace function public.freno_inundacion()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  recientes integer;
begin
  execute format('select count(*) from public.%I where creado_en > now() - interval ''1 minute''',
                 tg_table_name)
    into recientes;
  if recientes >= 60 then
    raise exception 'Demasiados registros en el último minuto (%). Freno de inundación activo.', recientes
      using hint = 'Si es tráfico legítimo, subir el umbral en public.freno_inundacion().';
  end if;
  return new;
end $$;

drop trigger if exists t_zonas_freno on public.zonas;
create trigger t_zonas_freno before insert on public.zonas
  for each row execute function public.freno_inundacion();

drop trigger if exists t_aportes_freno on public.aportes;
create trigger t_aportes_freno before insert on public.aportes
  for each row execute function public.freno_inundacion();

-- ── Row Level Security ───────────────────────────────────────────────
--
-- Modelo: cualquiera lee el mapa y cualquiera reporta. Nadie anónimo edita
-- ni borra lo ajeno — si se permitiera UPDATE a anon, una sola persona
-- podría marcar todas las zonas como 'resuelto' y borrar la emergencia del
-- mapa. La curaduría se hace con service_role desde el panel.

alter table public.zonas     enable row level security;
alter table public.aportes   enable row level security;
alter table public.contactos enable row level security;

drop policy if exists zonas_lectura_publica on public.zonas;
create policy zonas_lectura_publica on public.zonas
  for select to anon, authenticated using (true);

drop policy if exists zonas_insercion_publica on public.zonas;
create policy zonas_insercion_publica on public.zonas
  for insert to anon, authenticated with check (
    -- Nadie se autoproclama verificado al insertar.
    verificado = false and estado = 'nuevo'
  );

drop policy if exists aportes_lectura_publica on public.aportes;
create policy aportes_lectura_publica on public.aportes
  for select to anon, authenticated using (true);

drop policy if exists aportes_insercion_publica on public.aportes;
create policy aportes_insercion_publica on public.aportes
  for insert to anon, authenticated with check (estado = 'ofrecido');

-- contactos: SIN política de SELECT. En RLS, ausencia de política = denegado.
-- Es deliberado. No agregar una policy de select aquí.
drop policy if exists contactos_insercion_publica on public.contactos;
create policy contactos_insercion_publica on public.contactos
  for insert to anon, authenticated with check (true);

-- Cinturón además de tirantes: revocar los privilegios de tabla que RLS ya
-- filtra. Si alguien desactiva RLS por error, esto sigue bloqueando.
revoke all on public.contactos from anon, authenticated;
grant insert on public.contactos to anon, authenticated;

revoke update, delete on public.zonas, public.aportes from anon, authenticated;
grant select, insert on public.zonas, public.aportes to anon, authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────
-- Solo las tablas sin datos personales. `contactos` JAMÁS se publica.

do $$ begin
  alter publication supabase_realtime add table public.zonas;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.aportes;
exception when duplicate_object then null; end $$;

-- ── Vista de resumen para el panel ───────────────────────────────────

create or replace view public.resumen_zonas as
select
  tipo,
  estado,
  count(*)                              as total,
  sum(personas_estimadas)               as personas,
  count(*) filter (where verificado)    as verificadas,
  min(creado_en)                        as primera,
  max(creado_en)                        as ultima
from public.zonas
group by tipo, estado;

grant select on public.resumen_zonas to anon, authenticated;

-- =====================================================================
-- Comprobación rápida tras aplicar:
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname='public' and tablename in ('zonas','aportes','contactos');
--   -- las tres deben salir con rowsecurity = true
--
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and schemaname='public';
--   -- deben salir zonas y aportes, y NO contactos
-- =====================================================================

-- =====================================================================
-- PARTE 2 — LO QUE FALTABA: memoria, catálogo y campaña
-- =====================================================================
--
-- Todo lo de arriba guarda lo que la GENTE reporta. Nada guardaba lo que el
-- sistema MIDE, y esa es la carencia que más duele: hoy todo se calcula en
-- vivo y se olvida. Consecuencias concretas, las tres reales:
--
--   · Cuando IODA se cae —y se cayó el 13 y otra vez el 15 de agosto— no
--     queda nada. El panel enseña la última medición buena que tenga en
--     caché y, si la caché expiró, nada.
--   · No se puede responder «¿desde cuándo está Tadó sin luz?». Y «lleva
--     tres días» pesa muchísimo más en una carta que «hoy no tiene».
--   · No se puede demostrar una recuperación ni una recaída.
--
-- Se añaden cuatro tablas. Ninguna toca las de arriba.
--
--   municipios        catálogo oficial, para que todo lo demás lo referencie
--   mediciones        la historia: una fila por municipio y consulta
--   reportes_prensa   lo que dijo un medio de un municipio, con enlace
--   peticiones        el contador de la campaña de cartas
--
-- PRIVACIDAD: ninguna de las cuatro admite datos personales. `peticiones`
-- guarda a quién se le escribió y desde qué ciudad, nunca quién escribió.
-- =====================================================================

-- ── Catálogo de municipios ───────────────────────────────────────────
-- Se carga con herramientas/preparar_municipios.py. Es referencia, no algo
-- que la gente edite: por eso anon lee y no escribe.

create table if not exists public.municipios (
  id            bigserial primary key,
  nombre        text not null,
  departamento  text not null default '',
  codigo_depto  integer,
  lat           double precision not null check (lat between -4.3 and 13.5),
  lon           double precision not null check (lon between -82.0 and -66.8),
  -- De dónde salió el punto de medición. Decide si la luz nocturna medida
  -- ahí significa algo o es la oscuridad del monte.
  --   poblado    → casco urbano identificado y con nombre concordante
  --   aproximado → cae dentro un poblado con nombre de OTRO municipio
  --   centroide  → centro geométrico; en el Chocó, selva
  punto         text not null default 'centroide'
                check (punto in ('poblado', 'aproximado', 'centroide')),
  poblacion     integer check (poblacion >= 0),
  creado_en     timestamptz not null default now(),
  unique (nombre, departamento)
);

comment on table public.municipios is
  'Los 1.122 municipios oficiales (geoBoundaries ADM2) con su mejor punto de '
  'medición. La población es la del casco urbano según USGS PAGER, NO la del '
  'municipio entero: sirve para ordenar por magnitud, no como censo.';

create index if not exists ix_municipios_depto on public.municipios (departamento);

-- ── Mediciones: la memoria del sistema ───────────────────────────────

create table if not exists public.mediciones (
  id             bigserial primary key,
  municipio_id   bigint references public.municipios(id) on delete cascade,
  municipio      text not null,              -- desnormalizado a propósito, ver abajo
  departamento   text not null default '',
  medido_en      timestamptz not null default now(),

  mmi            real,                       -- intensidad ShakeMap en el punto
  clase          text not null,              -- sin_luz | punto_ciego | …
  certeza        text not null,              -- local | heredada | ninguna
  necesita       text not null default '',   -- ENERGIA | RED | ENLACE | …

  luz_cambio_pct       real,                 -- ya con la deriva descontada
  luz_utilizable       boolean not null default false,
  red_clase            text,                 -- del departamento: es heredada
  red_acceso_pct       real,
  red_troncal_pct      real,
  sondas_cerca         integer not null default 0,
  sonda_responde       boolean,

  -- Los umbrales con los que se clasificó ESTA fila. Sin ellos, comparar dos
  -- días distintos es comparar dos reglas distintas y no significa nada: los
  -- umbrales se recalibran en cada consulta contra el grupo de control.
  deriva_pct           real,
  umbral_sin_luz_pct   real,
  umbral_poca_luz_pct  real
);

comment on table public.mediciones is
  'Una fila por municipio y consulta. Es la memoria que el sistema no tenía: '
  'permite responder «desde cuándo» y sobrevive a que la fuente se caiga.';

-- El nombre va desnormalizado además del id: si algún día se recarga el
-- catálogo y cambian los ids, la historia no puede quedarse huérfana. En una
-- serie histórica, perder a qué municipio se refería una fila es perderla.

create index if not exists ix_mediciones_muni  on public.mediciones (municipio, medido_en desc);
create index if not exists ix_mediciones_fecha on public.mediciones (medido_en desc);
create index if not exists ix_mediciones_clase on public.mediciones (clase);

-- ── Reportes de prensa ───────────────────────────────────────────────
-- NO son mediciones y por eso viven aparte. Su valor es otro: confirmar un
-- punto ciego. Instrumentos que dicen «no sé» + periodista que dice «está
-- incomunicado» es la evidencia más fuerte que este sistema produce.

create table if not exists public.reportes_prensa (
  id            bigserial primary key,
  municipio     text not null,
  departamento  text not null default '',
  estado        text[] not null default '{}',   -- incomunicado, sin_energia, …
  detalle       text not null default '' check (length(detalle) <= 1000),
  medio         text not null default '',
  url           text not null default '',
  fecha         date not null,
  creado_en     timestamptz not null default now(),
  unique (municipio, medio, fecha)
);

comment on table public.reportes_prensa is
  'Lo que un medio publicó sobre un municipio, con enlace y fecha. La prensa '
  'se contradice y se corrige: esto orienta la mirada, no confirma un hecho.';

create index if not exists ix_prensa_muni on public.reportes_prensa (municipio);

-- ── Peticiones: el contador de la campaña ────────────────────────────
--
-- Sin datos personales, y no es un descuido: quien manda una carta ya pone su
-- nombre DENTRO de la carta, que va directo al destinatario. Repetirlo aquí
-- crearía una lista pública de gente que le escribió al Estado, y eso no hace
-- falta para nada. Lo único que aporta esta tabla es el número.
--
-- Y el número importa: «342 personas ya enviaron esta carta» es lo que
-- convierte una petición suelta en una campaña.

create table if not exists public.peticiones (
  id             bigserial primary key,
  destinatario   text not null check (length(destinatario) <= 60),  -- id: tsf, mintic…
  via            text not null default 'conjunta'
                 check (via in ('conjunta', 'individual')),
  ciudad         text not null default '' check (length(ciudad) <= 120),
  enviado_en     timestamptz not null default now()
);

comment on table public.peticiones is
  'Contador de la campaña de cartas. SIN datos personales: solo a quién se '
  'escribió, por qué vía y desde qué ciudad. Es AUTORREPORTADO —se registra '
  'cuando alguien pulsa enviar— y no prueba que el correo saliera.';

create index if not exists ix_peticiones_dest  on public.peticiones (destinatario);
create index if not exists ix_peticiones_fecha on public.peticiones (enviado_en desc);

-- El mismo freno que protege a zonas y aportes. Un contador público sin
-- límite se infla en minutos, y un contador inflado destruye justo lo que lo
-- hace útil: que el destinatario se crea el número.
drop trigger if exists t_peticiones_freno on public.peticiones;
create trigger t_peticiones_freno before insert on public.peticiones
  for each row execute function public.freno_inundacion();

-- ── Row Level Security ───────────────────────────────────────────────
--
-- `municipios`, `mediciones` y `reportes_prensa` las escribe el backend con
-- service_role, que salta RLS. anon solo lee: son datos que se publican, no
-- que se capturan. `peticiones` sí acepta inserción anónima, porque el
-- contador se alimenta de quien manda la carta desde su navegador.

alter table public.municipios      enable row level security;
alter table public.mediciones      enable row level security;
alter table public.reportes_prensa enable row level security;
alter table public.peticiones      enable row level security;

drop policy if exists municipios_lectura on public.municipios;
create policy municipios_lectura on public.municipios
  for select to anon, authenticated using (true);

drop policy if exists mediciones_lectura on public.mediciones;
create policy mediciones_lectura on public.mediciones
  for select to anon, authenticated using (true);

drop policy if exists prensa_lectura on public.reportes_prensa;
create policy prensa_lectura on public.reportes_prensa
  for select to anon, authenticated using (true);

drop policy if exists peticiones_lectura on public.peticiones;
create policy peticiones_lectura on public.peticiones
  for select to anon, authenticated using (true);

drop policy if exists peticiones_insercion on public.peticiones;
create policy peticiones_insercion on public.peticiones
  for insert to anon, authenticated with check (true);

-- Cinturón además de tirantes, igual que arriba: si alguien desactiva RLS por
-- error, los privilegios de tabla siguen bloqueando la escritura.
revoke insert, update, delete
  on public.municipios, public.mediciones, public.reportes_prensa
  from anon, authenticated;
grant select
  on public.municipios, public.mediciones, public.reportes_prensa
  to anon, authenticated;

revoke update, delete on public.peticiones from anon, authenticated;
grant select, insert on public.peticiones to anon, authenticated;

-- ── Vistas ───────────────────────────────────────────────────────────

-- Lo último que se sabe de cada municipio, sin tener que ordenar a mano.
create or replace view public.ultima_medicion as
select distinct on (municipio)
  municipio, departamento, medido_en, mmi, clase, certeza, necesita,
  luz_cambio_pct, luz_utilizable, red_clase, sondas_cerca, sonda_responde
from public.mediciones
order by municipio, medido_en desc;

grant select on public.ultima_medicion to anon, authenticated;

-- Desde cuándo lleva así cada municipio. Es la pregunta que hoy no se puede
-- responder, y la que convierte «no tiene luz» en «lleva tres días sin luz»,
-- que es lo que mueve a alguien a cargar un camión.
create or replace view public.racha_actual as
with ordenado as (
  select municipio, departamento, clase, medido_en,
         lag(clase) over (partition by municipio order by medido_en) as clase_previa
  from public.mediciones
),
cambios as (
  select municipio, departamento, clase, medido_en
  from ordenado
  where clase_previa is distinct from clase
)
select distinct on (municipio)
  municipio, departamento, clase,
  medido_en                as desde,
  now() - medido_en        as lleva
from cambios
order by municipio, medido_en desc;

grant select on public.racha_actual to anon, authenticated;

-- El contador de la campaña, agrupado por destinatario.
create or replace view public.resumen_peticiones as
select
  destinatario,
  count(*)                                                     as envios,
  count(distinct ciudad) filter (where ciudad <> '')           as ciudades,
  min(enviado_en)                                              as primera,
  max(enviado_en)                                              as ultima
from public.peticiones
group by destinatario;

grant select on public.resumen_peticiones to anon, authenticated;

-- =====================================================================
-- Comprobación de la parte 2:
--
--   select tablename, rowsecurity from pg_tables where schemaname='public'
--    and tablename in ('municipios','mediciones','reportes_prensa','peticiones');
--   -- las cuatro con rowsecurity = true
--
--   -- anon NO debe poder escribir mediciones:
--   select has_table_privilege('anon','public.mediciones','INSERT');  -- false
--   -- anon SÍ debe poder registrar una petición:
--   select has_table_privilege('anon','public.peticiones','INSERT');  -- true
-- =====================================================================
