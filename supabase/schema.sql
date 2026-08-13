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
