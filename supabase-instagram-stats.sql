-- Live Media Plans: Instagram stats.
-- One record per post, because one post can sit on several plan rows. A row's numbers are worked out from these records.
-- Additive and safe to run twice. It changes no existing table and touches no existing row.
-- Only the server reads and writes these, with the service key: they hold scraper details that users must not see,
-- so row-level security is on with no policies, and anon/authenticated get nothing.

create table if not exists instagram_link_stats (
  key text primary key,                         -- the post's ID, so /p/CODE and /reel/CODE are one record
  url text not null,
  aliases text[] not null default '{}',         -- every form of this link as it's written on a plan row
  attached_at timestamptz not null default now(), -- the first time the link came in. Never changes
  report jsonb,                                 -- the best answer so far
  complete boolean not null default false,
  last_fetched_at timestamptz,
  auto_fetches int not null default 0,
  started_at timestamptz,                       -- a paid fetch began and hasn't ended
  claimed_until timestamptz,                    -- nobody else may fetch this link until then
  claim_token uuid,                             -- only the holder may save its answer
  last_failed_at timestamptz,
  last_error text,
  fail_count int not null default 0,
  gave_up boolean not null default false,       -- no automatic try will pay for this link again
  retry_after timestamptz,                      -- the wait before the next automatic try
  held_count int not null default 0,            -- replies in a row that weren't believed
  suspect jsonb,
  history jsonb not null default '[]'::jsonb
);
create index if not exists instagram_link_stats_due_idx on instagram_link_stats (attached_at) where not gave_up and auto_fetches < 2;
create index if not exists instagram_link_stats_aliases_idx on instagram_link_stats using gin (aliases);

create table if not exists instagram_stats_refreshes (
  id uuid primary key,                          -- chosen by the page, so a cut connection can resume the same Refresh without using up the limit
  user_id uuid not null,
  plan_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists instagram_stats_refreshes_idx on instagram_stats_refreshes (user_id, plan_id, at);

create table if not exists instagram_stats_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  claimed int not null default 0,
  saved int not null default 0,
  failed int not null default 0,
  held int not null default 0,
  unfinished int not null default 0,
  backup_links int not null default 0,
  sources jsonb not null default '{}'::jsonb,
  stopped text
);
create index if not exists instagram_stats_runs_started_idx on instagram_stats_runs (started_at desc);

create table if not exists instagram_stats_alerts (kind text primary key, last_sent_at timestamptz not null);

create table if not exists instagram_stats_spend (day date primary key, usd numeric not null default 0); -- PARKED: daily limit

alter table instagram_link_stats enable row level security;
alter table instagram_stats_refreshes enable row level security;
alter table instagram_stats_runs enable row level security;
alter table instagram_stats_alerts enable row level security;
alter table instagram_stats_spend enable row level security;

-- Records a link the first time it's seen. A link that's already known keeps its first time.
create or replace function instagram_stats_attach(p_links jsonb) returns setof instagram_link_stats
language sql set search_path = public as $$
  insert into instagram_link_stats (key, url, aliases)
  select distinct on (l->>'key') l->>'key', l->>'url', array[l->>'alias']
  from jsonb_array_elements(p_links) l
  on conflict (key) do update
    set aliases = case when excluded.aliases[1] = any(instagram_link_stats.aliases) then instagram_link_stats.aliases
                       else instagram_link_stats.aliases || excluded.aliases end
  returning *;
$$;

-- Takes the link for one fetch, atomically, or returns nothing if someone else holds it. A claim expires, so a crash can't strand a link.
create or replace function instagram_stats_claim(p_key text, p_ttl_seconds int) returns setof instagram_link_stats
language sql set search_path = public as $$
  update instagram_link_stats
     set started_at = now(), claimed_until = now() + make_interval(secs => p_ttl_seconds), claim_token = gen_random_uuid()
   where key = p_key and (claimed_until is null or claimed_until < now())
  returning *;
$$;

-- Takes the links due for their automatic fetch. Times use the database's clock. Two jobs at once can't take the same link.
create or replace function instagram_stats_claim_due(p_limit int, p_ttl_seconds int) returns setof instagram_link_stats
language sql set search_path = public as $$
  update instagram_link_stats s
     set started_at = now(), claimed_until = now() + make_interval(secs => p_ttl_seconds), claim_token = gen_random_uuid()
   where s.key in (
     select d.key from instagram_link_stats d
      where d.attached_at <= now() - interval '24 hours'
        and d.auto_fetches < 2
        and not d.gave_up
        and (d.retry_after is null or d.retry_after <= now())
        and (d.claimed_until is null or d.claimed_until < now())
        and (d.last_fetched_at is null or d.last_fetched_at <= now() - interval '12 hours')
        and exists (select 1 from media_plan_items i where i.live_links ?| d.aliases) -- a link no longer on a row stops costing money
      order by d.attached_at
      limit p_limit
      for update of d skip locked)
  returning s.*;
$$;

-- Lets go of a link without any charge or blame.
create or replace function instagram_stats_release(p_key text, p_token uuid) returns void
language sql set search_path = public as $$
  update instagram_link_stats set started_at = null, claimed_until = null, claim_token = null
   where key = p_key and claim_token = p_token;
$$;

-- Saves an answer. Says false if the claim was lost, so a late answer can't overwrite a newer one.
-- A partial answer keeps the claim, because a failure note follows it.
create or replace function instagram_stats_save_fetch(p_key text, p_token uuid, p_report jsonb, p_kind text, p_complete boolean, p_entry jsonb, p_history_limit int) returns boolean
language plpgsql set search_path = public as $$
begin
  update instagram_link_stats set
    report = p_report,
    complete = p_complete,
    last_fetched_at = now(),
    auto_fetches = auto_fetches + case when p_complete and p_kind <> 'manual' then 1 else 0 end,
    started_at = case when p_complete then null else started_at end,
    claimed_until = case when p_complete then null else claimed_until end,
    claim_token = case when p_complete then null else claim_token end,
    last_failed_at = case when p_complete then null else last_failed_at end,
    last_error = case when p_complete then null else last_error end,
    fail_count = case when p_complete then 0 else fail_count end,
    gave_up = case when p_complete then false else gave_up end,
    retry_after = case when p_complete then null else retry_after end,
    held_count = case when p_complete then 0 else held_count end,
    suspect = case when p_complete then null else suspect end,
    history = (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
      select e, n from jsonb_array_elements(history || jsonb_build_array(p_entry)) with ordinality t(e, n)
      order by n desc limit p_history_limit) kept)
  where key = p_key and claim_token = p_token;
  return found;
end $$;

-- Notes a fetch that didn't complete. Saved numbers stay. The wait starts at p_base_seconds and doubles, up to a day; p_wait_seconds overrides it.
create or replace function instagram_stats_save_failure(p_key text, p_token uuid, p_message text, p_give_up boolean, p_base_seconds int, p_wait_seconds int, p_max_failures int) returns boolean
language plpgsql set search_path = public as $$
begin
  update instagram_link_stats set
    last_failed_at = now(),
    last_error = p_message,
    fail_count = fail_count + 1,
    gave_up = p_give_up or fail_count + 1 >= p_max_failures,
    retry_after = now() + make_interval(secs => coalesce(p_wait_seconds, least(p_base_seconds * power(2, least(fail_count, 20)), 86400))),
    started_at = null, claimed_until = null, claim_token = null
  where key = p_key and claim_token = p_token;
  return found;
end $$;

-- Notes numbers that weren't believed. They count as an attempt: without this, a held link stays due and pays on every wake.
create or replace function instagram_stats_save_suspect(p_key text, p_token uuid, p_numbers jsonb, p_entry jsonb, p_base_seconds int, p_max_holds int, p_message text, p_history_limit int) returns boolean
language plpgsql set search_path = public as $$
begin
  update instagram_link_stats set
    suspect = p_numbers,
    held_count = held_count + 1,
    gave_up = gave_up or held_count + 1 >= p_max_holds,
    last_error = case when held_count + 1 >= p_max_holds then p_message else last_error end,
    retry_after = now() + make_interval(secs => least(p_base_seconds * power(2, least(held_count, 20)), 86400)),
    started_at = null, claimed_until = null, claim_token = null,
    history = (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
      select e, n from jsonb_array_elements(history || jsonb_build_array(p_entry)) with ordinality t(e, n)
      order by n desc limit p_history_limit) kept)
  where key = p_key and claim_token = p_token;
  return found;
end $$;

-- Uses up one Refresh for this user on this plan. The same id can be sent again to resume, and costs nothing more.
create or replace function instagram_stats_take_refresh(p_id uuid, p_user uuid, p_plan uuid, p_limit int, p_window_seconds int, p_resume_seconds int)
returns table (allowed boolean, at timestamptz, retry_seconds int)
language plpgsql set search_path = public as $$
declare
  found_at timestamptz;
  used int;
  oldest timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text || p_plan::text));
  select r.at into found_at from instagram_stats_refreshes r where r.id = p_id;
  if found_at is not null then
    -- Only its own user on its own plan can resume a Refresh, and only for a short while.
    if exists (select 1 from instagram_stats_refreshes r where r.id = p_id and r.user_id = p_user and r.plan_id = p_plan)
       and found_at > now() - make_interval(secs => p_resume_seconds) then
      return query select true, found_at, 0;
    end if;
    return query select false, found_at, 0;
    return;
  end if;
  delete from instagram_stats_refreshes r where r.at < now() - interval '7 days';
  select count(*), min(r.at) into used, oldest from instagram_stats_refreshes r
   where r.user_id = p_user and r.plan_id = p_plan and r.at > now() - make_interval(secs => p_window_seconds);
  if used >= p_limit then
    return query select false, null::timestamptz, ceil(extract(epoch from oldest + make_interval(secs => p_window_seconds) - now()))::int;
    return;
  end if;
  insert into instagram_stats_refreshes (id, user_id, plan_id) values (p_id, p_user, p_plan) returning instagram_stats_refreshes.at into found_at;
  return query select true, found_at, 0;
end $$;

-- PARKED: daily limit. Nothing calls this unless DAILY_LIMIT_USD is set.
create or replace function instagram_stats_reserve_spend(p_usd numeric, p_limit numeric) returns boolean
language plpgsql set search_path = public as $$
declare spent numeric;
begin
  insert into instagram_stats_spend (day, usd) values ((now() at time zone 'utc')::date, 0) on conflict (day) do nothing;
  update instagram_stats_spend set usd = usd + p_usd
   where day = (now() at time zone 'utc')::date and usd + p_usd <= p_limit returning usd into spent;
  return spent is not null;
end $$;

-- Says whether this alert may go out now, and if so marks it sent, so an outage doesn't send one email per wake.
create or replace function instagram_stats_alert_due(p_kind text, p_every_seconds int) returns boolean
language plpgsql set search_path = public as $$
begin
  insert into instagram_stats_alerts (kind, last_sent_at) values (p_kind, now())
  on conflict (kind) do update set last_sent_at = now()
    where instagram_stats_alerts.last_sent_at < now() - make_interval(secs => p_every_seconds);
  return found;
end $$;

-- Only the server's service key. Supabase grants new tables and functions to everyone by default, so this takes that back.
revoke all on instagram_link_stats, instagram_stats_refreshes, instagram_stats_runs, instagram_stats_alerts, instagram_stats_spend from anon, authenticated;
revoke all on function instagram_stats_attach(jsonb), instagram_stats_claim(text, int), instagram_stats_claim_due(int, int), instagram_stats_release(text, uuid),
  instagram_stats_save_fetch(text, uuid, jsonb, text, boolean, jsonb, int), instagram_stats_save_failure(text, uuid, text, boolean, int, int, int),
  instagram_stats_save_suspect(text, uuid, jsonb, jsonb, int, int, text, int), instagram_stats_take_refresh(uuid, uuid, uuid, int, int, int),
  instagram_stats_reserve_spend(numeric, numeric), instagram_stats_alert_due(text, int) from public, anon, authenticated;
grant all on instagram_link_stats, instagram_stats_refreshes, instagram_stats_runs, instagram_stats_alerts, instagram_stats_spend to service_role;
grant execute on function instagram_stats_attach(jsonb), instagram_stats_claim(text, int), instagram_stats_claim_due(int, int), instagram_stats_release(text, uuid),
  instagram_stats_save_fetch(text, uuid, jsonb, text, boolean, jsonb, int), instagram_stats_save_failure(text, uuid, text, boolean, int, int, int),
  instagram_stats_save_suspect(text, uuid, jsonb, jsonb, int, int, text, int), instagram_stats_take_refresh(uuid, uuid, uuid, int, int, int),
  instagram_stats_reserve_spend(numeric, numeric), instagram_stats_alert_due(text, int) to service_role;
