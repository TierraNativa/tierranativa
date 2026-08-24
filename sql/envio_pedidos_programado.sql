-- ============================================================================
-- envio_pedidos_programado.sql
-- Sistema de envío programado de pedidos por mail — Tierra Nativa SA
--
-- Replica el sistema de LK: pg_cron → fn SQL → net.http_post → Edge Function
-- "procesar-pedidos-db" que arma Excel con los pedidos pendientes y lo manda
-- por Gmail API.
--
-- Cadena: enviar_pedidos_main() [cron 15:00 UTC = 12:00 ARG]
--       → postear_envio_pedidos('main', 0)
--       → net.http_post a la Edge Function procesar-pedidos-db
--       → la EF lee orders.sheets_payload pendientes, arma Excel, manda mail
--       → sella orders.enviado_a_compras_at
--
-- Retry: retry_procesar_pedidos() [cron cada 6 min entre 15:02 y 16:59 UTC]
--       → resolver_envios_pedidos() (llena HTTP status de pg_net)
--       → si no hubo éxito hoy en procesar_pedidos_log, reintenta hasta 10x
--
-- REQUISITOS antes de correr:
--   1. pg_cron y pg_net habilitadas (Extensions en el dashboard de Supabase)
--   2. Edge Function "procesar-pedidos-db" deployada con sus secrets:
--      COMPANY, SEND_TO, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
--      GMAIL_REFRESH_TOKEN, GMAIL_SENDER
--   3. Correr este script en el SQL Editor del proyecto TN (zjvpzqhbekxnwxdczpof)
-- ============================================================================


-- ─── 1. Tablas ──────────────────────────────────────────────────────────────

-- Log de cada llamada HTTP a la Edge Function (pg_net es asíncrono)
create table if not exists public.envio_pedidos_http_log (
  request_id  bigint       not null primary key,
  fecha       date         not null,
  origen      text         not null,            -- 'main' | 'retry'
  intento     integer,
  posted_at   timestamptz  not null default now(),
  http_status integer,                          -- se llena al resolver
  timed_out   boolean,
  error_msg   text,
  content     text,
  resolved_at timestamptz
);

-- Control de reintentos diarios (máximo 10)
create table if not exists public.retry_envio_control (
  fecha     date         not null primary key,
  intentos  integer      not null default 0,
  last_at   timestamptz
);

-- procesar_pedidos_log ya debería existir (la usa el panel admin).
-- Si por algún motivo no existe, descomentar:
/*
create table if not exists public.procesar_pedidos_log (
  id                uuid         not null default gen_random_uuid() primary key,
  ran_at            timestamptz  not null default now(),
  company           text,
  status            text,        -- 'ok' | 'error' | 'no_orders'
  orders_count      integer,
  pedidos_generated integer,
  email_subject     text,
  email_to          text,
  error_message     text,
  row_numbers       integer[],
  duration_ms       integer
);
*/


-- ─── 2. Funciones ───────────────────────────────────────────────────────────

-- 2a) Dispara el HTTP POST a la Edge Function y loguea el request_id
create or replace function public.postear_envio_pedidos(
  p_origen  text,
  p_intento integer,
  p_body    jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare rid bigint;
begin
  select net.http_post(
    url     := 'https://zjvpzqhbekxnwxdczpof.supabase.co/functions/v1/procesar-pedidos-db',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer sb_publishable_b4ua15HoSbe8o5SHsbJxWw_fvZFUdxv'
    ),
    body    := p_body
  ) into rid;

  insert into public.envio_pedidos_http_log (request_id, fecha, origen, intento)
    values (rid, (now() at time zone 'America/Argentina/Buenos_Aires')::date, p_origen, p_intento);

  return rid;
end;
$$;

-- 2b) Wrapper principal — lo llama el cron de las 12:00 ARG
create or replace function public.enviar_pedidos_main()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.postear_envio_pedidos('main', 0);
end;
$$;

-- 2c) Resuelve las respuestas HTTP pendientes de pg_net
create or replace function public.resolver_envios_pedidos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.envio_pedidos_http_log l
     set http_status  = r.status_code,
         timed_out    = r.timed_out,
         error_msg    = r.error_msg,
         content      = left(r.content, 4000),
         resolved_at  = now()
    from net._http_response r
   where r.id = l.request_id
     and l.resolved_at is null;
end;
$$;

-- 2d) Retry: cada 6 minutos chequea si ya hubo éxito hoy, si no reintenta
create or replace function public.retry_procesar_pedidos()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t_arg       time := (now() at time zone 'America/Argentina/Buenos_Aires')::time;
  d_arg       date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  ok_today    int;
  intentos_hoy int;
begin
  -- Primero resolver cualquier HTTP pendiente
  perform public.resolver_envios_pedidos();

  -- No reintentar antes de las 12:01 (el main sale a las 12:00)
  if t_arg < time '12:01' then return; end if;

  -- Si ya hubo un ok o no_orders hoy, no hacer nada
  select count(*) into ok_today
    from public.procesar_pedidos_log
   where status in ('ok', 'no_orders')
     and (ran_at at time zone 'America/Argentina/Buenos_Aires')::date = d_arg;
  if ok_today > 0 then return; end if;

  -- Inicializar contador de hoy si no existe
  insert into public.retry_envio_control (fecha, intentos)
    values (d_arg, 0)
    on conflict (fecha) do nothing;

  select intentos into intentos_hoy
    from public.retry_envio_control
   where fecha = d_arg;

  -- Máximo 10 reintentos
  if intentos_hoy >= 10 then return; end if;

  -- Incrementar y reintentar
  update public.retry_envio_control
     set intentos = intentos + 1,
         last_at  = now()
   where fecha = d_arg;

  perform public.postear_envio_pedidos('retry', intentos_hoy + 1);
end;
$$;


-- ─── 3. Cron jobs ───────────────────────────────────────────────────────────

-- Principal: 15:00 UTC = 12:00 ARG
select cron.schedule(
  'procesar-pedidos-web',
  '0 15 * * *',
  $$select public.enviar_pedidos_main();$$
);

-- Retry: cada 6 minutos entre 15:02 y 16:59 UTC (12:02–13:59 ARG)
select cron.schedule(
  'retry-procesar-pedidos',
  '2-59/6 15,16 * * *',
  $$select public.retry_procesar_pedidos();$$
);


-- ─── 4. Seguridad ───────────────────────────────────────────────────────────
-- Estas funciones las ejecuta pg_cron (rol postgres), no el navegador.
-- Revocar a anon y authenticated para que no sean llamables con la anon key.

revoke execute on function public.enviar_pedidos_main()                              from public, anon, authenticated;
revoke execute on function public.postear_envio_pedidos(text, integer, jsonb)        from public, anon, authenticated;
revoke execute on function public.resolver_envios_pedidos()                          from public, anon, authenticated;
revoke execute on function public.retry_procesar_pedidos()                           from public, anon, authenticated;


-- ─── Pruebas ────────────────────────────────────────────────────────────────
-- Modo dry (sin mandar mail ni sellar):
--   select public.postear_envio_pedidos('test', 0, '{"dry":true}'::jsonb);
--   -- Esperar 5-10 seg para que pg_net resuelva, luego:
--   select * from envio_pedidos_http_log order by posted_at desc limit 5;
--
-- Ver respuestas HTTP pendientes:
--   select public.resolver_envios_pedidos();
--   select * from envio_pedidos_http_log where resolved_at is not null order by posted_at desc;
--
-- Simular el main:
--   select public.enviar_pedidos_main();
--
-- Para desprogramar:
--   select cron.unschedule('procesar-pedidos-web');
--   select cron.unschedule('retry-procesar-pedidos');
-- ============================================================================
