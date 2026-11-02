-- Multi-station boards (ANVT first). Additive only: no existing NDLS table, function, policy or job is changed.
-- NDLS keeps running on public.trains / ndls_trains / settings / api_usage and the board-sync function.

-- Stations other than NDLS, with their own settings and sync state.
create table public.stations (
  code text primary key check (code ~ '^[A-Z]{2,5}$' and code <> 'NDLS'),
  name_en text not null,
  name_hi text,
  zone_division text not null default 'Northern Railway · Delhi Division',
  local_codes text[] not null default '{}',           -- nearby stations whose seats are never checked or shown
  active boolean not null default true,
  sync_minutes integer not null default 15 check (sync_minutes in (5, 10, 15, 20, 30, 60)),
  default_refresh_minutes integer not null default 30 check (default_refresh_minutes in (15, 30, 45, 60, 90, 120)),
  seat_daily_budget integer not null default 1000 check (seat_daily_budget between 0 and 20000),
  irctc_credits_left integer not null default 0 check (irctc_credits_left >= 0),
  board_fetched_at timestamptz, board_source text, names_at timestamptz,
  last_sync_at timestamptz, last_sync_note text, sync_lock_until timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- Who may manage a station (besides the overall admin).
create table public.station_admins (
  station text not null references public.stations(code) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (station, user_id)
);

-- Each station's API keys. Private schema, no grants: only the sync job (service connection) reads them.
create table private.station_keys (
  station text primary key references public.stations(code) on delete cascade,
  railradar text, irctcdev text, railkit text,
  updated_at timestamptz not null default now(), updated_by uuid
);
revoke all on private.station_keys from public, anon, authenticated;

-- Per-station equivalent of ndls_trains: halts and classes learnt once per train.
create table public.st_train_info (
  station text not null references public.stations(code) on delete cascade,
  train_no text not null,
  train_name text, display_name text, category text, origin_code text,
  stop_codes text[] not null default '{}', classes text[], stop_names jsonb,
  schedule_at timestamptz, source text not null default 'railradar',
  primary key (station, train_no)
);

-- Per-station equivalent of trains.
create table public.st_trains (
  id bigint generated always as identity primary key,
  station text not null references public.stations(code) on delete cascade,
  train_no text not null, journey_date date not null, start_date date,
  train_name text, dep_at timestamptz,
  status text not null default 'queued' check (status in ('queued','active','error','removed','departed')),
  checked_at timestamptz, next_check_at timestamptz not null default now(),
  stops jsonb not null default '[]'::jsonb, last_error text, chart_ready boolean,
  refresh_minutes integer not null default 30,
  expected_dep_at timestamptz, delay_min integer, running_note text, running_checked_at timestamptz,
  platform text, platform_override text,
  added_at timestamptz not null default now(),
  unique (station, train_no, journey_date)
);
create index st_trains_live on public.st_trains (station, status, dep_at);

create table public.st_api_usage (
  station text not null references public.stations(code) on delete cascade,
  day date not null, provider text not null,
  calls integer not null default 0, month_limit integer, month_remaining integer,
  updated_at timestamptz not null default now(),
  primary key (station, day, provider)
);

-- ---- access rules ---------------------------------------------------------------------------------
create or replace function private.is_station_admin(p_station text) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_admin() or exists (
    select 1 from public.station_admins a join public.profiles p on p.id = a.user_id
     where a.station = p_station and a.user_id = auth.uid() and p.status = 'approved');
$$;

alter table public.stations enable row level security;
alter table public.station_admins enable row level security;
alter table public.st_train_info enable row level security;
alter table public.st_trains enable row level security;
alter table public.st_api_usage enable row level security;

-- Anyone (the public board) can read a station's name and nearby-station list; nothing secret is in this table.
create policy "anyone reads stations" on public.stations for select to anon, authenticated using (true);
create policy "admin adds stations" on public.stations for insert to authenticated with check (private.is_admin());
create policy "station admin updates station" on public.stations for update to authenticated
  using (private.is_station_admin(code)) with check (private.is_station_admin(code));

create policy "station admins listed to station admins" on public.station_admins for select to authenticated
  using (private.is_station_admin(station));
create policy "admin assigns station admins" on public.station_admins for insert to authenticated with check (private.is_admin());
create policy "admin removes station admins" on public.station_admins for delete to authenticated using (private.is_admin());

create policy "public board reads live station trains" on public.st_trains for select to anon
  using (status in ('active','error') and checked_at is not null and coalesce(expected_dep_at, dep_at) > now());
create policy "approved staff read station trains" on public.st_trains for select to authenticated using (private.is_approved());
create policy "approved staff read station train info" on public.st_train_info for select to authenticated using (private.is_approved());
create policy "approved staff read station usage" on public.st_api_usage for select to authenticated using (private.is_approved());

-- Station admins can't change bookkeeping columns the sync job owns.
create or replace function private.stations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;      -- sync job
  new.code := old.code; new.created_at := old.created_at; new.updated_at := now();
  new.board_fetched_at := old.board_fetched_at; new.board_source := old.board_source; new.names_at := old.names_at;
  new.last_sync_at := old.last_sync_at; new.last_sync_note := old.last_sync_note; new.sync_lock_until := old.sync_lock_until;
  return new;
end $$;
create trigger stations_guard before update on public.stations for each row execute function private.stations_guard();

-- ---- API keys: write-only from the website ----------------------------------------------------------
-- Empty/null leaves a key unchanged; '-' clears it.
create or replace function public.set_station_keys(p_station text, p_railradar text, p_irctcdev text, p_railkit text)
returns void language plpgsql security definer set search_path = public as $$
declare f text := '-';
begin
  if not private.is_station_admin(p_station) then raise exception 'Only this station''s admin can change its API keys'; end if;
  insert into private.station_keys (station) values (p_station) on conflict do nothing;
  update private.station_keys set
    railradar = case when nullif(trim(p_railradar), '') is null then railradar when trim(p_railradar) = f then null else trim(p_railradar) end,
    irctcdev  = case when nullif(trim(p_irctcdev), '')  is null then irctcdev  when trim(p_irctcdev)  = f then null else trim(p_irctcdev)  end,
    railkit   = case when nullif(trim(p_railkit), '')   is null then railkit   when trim(p_railkit)   = f then null else trim(p_railkit)   end,
    updated_at = now(), updated_by = auth.uid()
  where station = p_station;
end $$;

-- Which keys are set, showing only the last 4 characters.
create or replace function public.station_key_status(p_station text)
returns table (railradar text, irctcdev text, railkit text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select case when k.railradar is null then null else '…' || right(k.railradar, 4) end,
         case when k.irctcdev  is null then null else '…' || right(k.irctcdev, 4)  end,
         case when k.railkit   is null then null else '…' || right(k.railkit, 4)   end,
         k.updated_at
    from private.station_keys k where k.station = p_station and private.is_station_admin(p_station);
$$;

-- Add a station admin by the email they registered with.
create or replace function public.add_station_admin(p_station text, p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not private.is_admin() then raise exception 'Only the admin can assign station admins'; end if;
  select id into v from public.profiles where email = lower(trim(p_email)) and status = 'approved';
  if v is null then raise exception 'No approved account with that email. They must register and be approved first.'; end if;
  insert into public.station_admins (station, user_id) values (p_station, v) on conflict do nothing;
  return 'ok';
end $$;

revoke all on function public.set_station_keys(text, text, text, text) from public, anon;
revoke all on function public.station_key_status(text) from public, anon;
revoke all on function public.add_station_admin(text, text) from public, anon;
grant execute on function public.set_station_keys(text, text, text, text) to authenticated;
grant execute on function public.station_key_status(text) to authenticated;
grant execute on function public.add_station_admin(text, text) to authenticated;

-- ---- sync bookkeeping -------------------------------------------------------------------------------
create or replace function private.count_station_call(p_station text, p_provider text, p_n integer, p_limit integer, p_remaining integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.st_api_usage (station, day, provider, calls, month_limit, month_remaining, updated_at)
  values (p_station, (now() at time zone 'Asia/Kolkata')::date, p_provider, p_n, p_limit, p_remaining, now())
  on conflict (station, day, provider) do update set calls = st_api_usage.calls + excluded.calls,
    month_limit = coalesce(excluded.month_limit, st_api_usage.month_limit),
    month_remaining = coalesce(excluded.month_remaining, st_api_usage.month_remaining), updated_at = now();
  if p_provider = 'irctcdev' then
    update public.stations set irctc_credits_left = greatest(0, irctc_credits_left - p_n) where code = p_station;
  end if;
end $$;

-- One sync call per active station that has at least one key. Called every minute by pg_cron.
create or replace function private.run_station_syncs() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select s.code from public.stations s join private.station_keys k on k.station = s.code
            where s.active and (k.railradar is not null or k.railkit is not null or k.irctcdev is not null)
              and (s.sync_lock_until is null or s.sync_lock_until < now()) loop
    perform net.http_post(
      url := 'https://guhxzsjckifbfwmdrmou.supabase.co/functions/v1/station-sync',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-sync-token', (select value from private.app_secret where name = 'sync_token')),
      body := jsonb_build_object('station', r.code),
      timeout_milliseconds := 150000);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---- first station ----------------------------------------------------------------------------------
insert into public.stations (code, name_en, name_hi, local_codes, active)
values ('ANVT', 'Anand Vihar Terminal', 'आनंद विहार टर्मिनल',
        array['NDLS','NZM','DLI','DSA','DEC','DEE','DKZ','DSJ','ANVT','SSB','SBB','GZB','FDB','FDN','BVH','GGN','OKA','TKD','NNO','ADRS','NUR'],
        true);
