-- Monetize workspace, property and revenue model.
-- Authorization uses active membership rows, never user-editable JWT metadata.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 100),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'manager')),
  status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  domain text not null check (length(trim(domain)) between 3 and 253),
  display_name text,
  category text not null default 'other',
  status text not null default 'active' check (status in ('active', 'attention', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, domain)
);

create table public.revenue_daily (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  property_id uuid not null,
  report_date date not null,
  platform text not null check (platform in ('google_ad_manager', 'google_adsense')),
  estimated_revenue numeric(14, 4) not null default 0 check (estimated_revenue >= 0),
  pageviews bigint not null default 0 check (pageviews >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  currency char(3) not null default 'BRL',
  imported_at timestamptz not null default now(),
  unique (property_id, report_date, platform),
  foreign key (workspace_id, property_id) references public.properties(workspace_id, id) on delete cascade
);

create table public.operating_expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  property_id uuid,
  expense_date date not null,
  category text not null check (category in ('content', 'team', 'technology', 'operations', 'taxes', 'other')),
  description text not null check (length(trim(description)) between 2 and 200),
  amount numeric(14, 4) not null check (amount >= 0),
  currency char(3) not null default 'BRL',
  recurring boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, property_id) references public.properties(workspace_id, id) on delete cascade
);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  role text not null check (role in ('admin', 'manager')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create table public.ad_platform_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text not null check (platform in ('google_ad_manager', 'google_adsense')),
  external_account_id text,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'revoked')),
  last_synced_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, platform)
);

-- These tables live in the exposed schema so server-side PostgREST clients can reach them,
-- but no user-facing database role receives privileges or an RLS policy.
create table public.google_oauth_credentials (
  connection_id uuid primary key references public.ad_platform_connections(id) on delete cascade,
  encrypted_refresh_token bytea not null,
  encryption_key_version smallint not null default 1,
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create table public.google_oauth_states (
  state_hash text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text not null check (platform in ('google_ad_manager', 'google_adsense')),
  requested_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default now()
);

create index workspace_memberships_user_idx on public.workspace_memberships (user_id, workspace_id) where status = 'active';
create index properties_workspace_status_idx on public.properties (workspace_id, status);
create index revenue_daily_workspace_date_idx on public.revenue_daily (workspace_id, report_date desc);
create index revenue_daily_property_date_idx on public.revenue_daily (property_id, report_date desc);
create index operating_expenses_workspace_date_idx on public.operating_expenses (workspace_id, expense_date desc);
create index operating_expenses_property_date_idx on public.operating_expenses (property_id, expense_date desc) where property_id is not null;
create index workspace_invites_pending_idx on public.workspace_invites (workspace_id, expires_at) where status = 'pending';

-- SECURITY DEFINER prevents recursive membership RLS. Keep this helper in a non-exposed schema,
-- pin search_path, and only answer membership/role questions for the current auth.uid().
create or replace function private.has_workspace_role(target_workspace uuid, allowed_roles text[] default null)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships as membership
    where membership.workspace_id = target_workspace
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and (allowed_roles is null or membership.role = any (allowed_roles))
  );
$$;
revoke all on function private.has_workspace_role(uuid, text[]) from public, anon;
grant execute on function private.has_workspace_role(uuid, text[]) to authenticated, service_role;

create or replace function public.create_workspace(workspace_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  new_workspace_id uuid;
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if length(trim(workspace_name)) not between 2 and 100 then
    raise exception 'Workspace name must have 2 to 100 characters' using errcode = '22023';
  end if;
  insert into public.workspaces (name, created_by)
  values (trim(workspace_name), current_user_id)
  returning id into new_workspace_id;
  insert into public.workspace_memberships (workspace_id, user_id, role, status)
  values (new_workspace_id, current_user_id, 'admin', 'active');
  return new_workspace_id;
end;
$$;
revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;

create or replace function public.accept_workspace_invites()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  current_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  accepted_count integer := 0;
  pending_invite record;
begin
  if current_user_id is null or current_email = '' then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  for pending_invite in
    select id, workspace_id, role
    from public.workspace_invites
    where email = current_email and status = 'pending' and expires_at > now()
  loop
    insert into public.workspace_memberships (workspace_id, user_id, role, status)
    values (pending_invite.workspace_id, current_user_id, pending_invite.role, 'active')
    on conflict (workspace_id, user_id) do update
      set role = excluded.role, status = 'active';
    update public.workspace_invites set status = 'accepted' where id = pending_invite.id;
    accepted_count := accepted_count + 1;
  end loop;
  return accepted_count;
end;
$$;
revoke all on function public.accept_workspace_invites() from public, anon;
grant execute on function public.accept_workspace_invites() to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.properties enable row level security;
alter table public.revenue_daily enable row level security;
alter table public.operating_expenses enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.ad_platform_connections enable row level security;
alter table public.google_oauth_credentials enable row level security;
alter table public.google_oauth_states enable row level security;

revoke all on public.workspaces, public.workspace_memberships, public.properties,
  public.revenue_daily, public.operating_expenses, public.workspace_invites,
  public.ad_platform_connections from public, anon;
grant select on public.workspaces to authenticated;
grant update (name, updated_at) on public.workspaces to authenticated;
grant select on public.workspace_memberships to authenticated;
grant select, insert, update, delete on public.properties to authenticated;
grant select on public.revenue_daily to authenticated;
grant select, insert, update, delete on public.operating_expenses to authenticated;
grant select, insert, update, delete on public.workspace_invites to authenticated;
grant select, insert, update, delete on public.ad_platform_connections to authenticated;
grant all on public.workspaces, public.workspace_memberships, public.properties,
  public.revenue_daily, public.operating_expenses, public.workspace_invites, public.ad_platform_connections,
  public.google_oauth_credentials, public.google_oauth_states to service_role;
revoke all on public.google_oauth_credentials, public.google_oauth_states from public, anon, authenticated;
grant all on public.google_oauth_credentials, public.google_oauth_states to service_role;

create policy "Members can view their workspaces" on public.workspaces
  for select to authenticated using (private.has_workspace_role(id));
create policy "Admins can update workspace details" on public.workspaces
  for update to authenticated using (private.has_workspace_role(id, array['admin']))
  with check (private.has_workspace_role(id, array['admin']));

create policy "Members can view workspace memberships" on public.workspace_memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or private.has_workspace_role(workspace_id, array['admin']));

create policy "Members can view workspace properties" on public.properties
  for select to authenticated using (private.has_workspace_role(workspace_id));
create policy "Admins and managers can add properties" on public.properties
  for insert to authenticated with check (private.has_workspace_role(workspace_id, array['admin', 'manager']));
create policy "Admins and managers can update properties" on public.properties
  for update to authenticated using (private.has_workspace_role(workspace_id, array['admin', 'manager']))
  with check (private.has_workspace_role(workspace_id, array['admin', 'manager']));
create policy "Admins can remove properties" on public.properties
  for delete to authenticated using (private.has_workspace_role(workspace_id, array['admin']));

create policy "Members can view workspace revenue" on public.revenue_daily
  for select to authenticated using (private.has_workspace_role(workspace_id));

create policy "Members can view workspace operating expenses" on public.operating_expenses
  for select to authenticated using (private.has_workspace_role(workspace_id));
create policy "Admins can add operating expenses" on public.operating_expenses
  for insert to authenticated
  with check (private.has_workspace_role(workspace_id, array['admin']) and created_by = (select auth.uid()));
create policy "Admins can update operating expenses" on public.operating_expenses
  for update to authenticated using (private.has_workspace_role(workspace_id, array['admin']))
  with check (private.has_workspace_role(workspace_id, array['admin']));
create policy "Admins can delete operating expenses" on public.operating_expenses
  for delete to authenticated using (private.has_workspace_role(workspace_id, array['admin']));

create policy "Admins can view workspace invites" on public.workspace_invites
  for select to authenticated using (private.has_workspace_role(workspace_id, array['admin']));
create policy "Admins can create workspace invites" on public.workspace_invites
  for insert to authenticated
  with check (private.has_workspace_role(workspace_id, array['admin']) and invited_by = (select auth.uid()));
create policy "Admins can update workspace invites" on public.workspace_invites
  for update to authenticated using (private.has_workspace_role(workspace_id, array['admin']))
  with check (private.has_workspace_role(workspace_id, array['admin']));
create policy "Admins can delete workspace invites" on public.workspace_invites
  for delete to authenticated using (private.has_workspace_role(workspace_id, array['admin']));

create policy "Members can view platform connection status" on public.ad_platform_connections
  for select to authenticated using (private.has_workspace_role(workspace_id));
create policy "Admins can manage platform connections" on public.ad_platform_connections
  for all to authenticated using (private.has_workspace_role(workspace_id, array['admin']))
  with check (private.has_workspace_role(workspace_id, array['admin']));

create view public.workspace_profit_daily with (security_invoker = true) as
  with revenue as (
    select workspace_id, report_date,
      sum(estimated_revenue) as gross_revenue,
      sum(pageviews) as pageviews,
      sum(impressions) as impressions
    from public.revenue_daily
    group by workspace_id, report_date
  ), expenses as (
    select workspace_id, expense_date as report_date, sum(amount) as operating_costs
    from public.operating_expenses
    group by workspace_id, expense_date
  )
  select coalesce(revenue.workspace_id, expenses.workspace_id) as workspace_id,
    coalesce(revenue.report_date, expenses.report_date) as report_date,
    coalesce(revenue.gross_revenue, 0)::numeric(14, 4) as gross_revenue,
    coalesce(expenses.operating_costs, 0)::numeric(14, 4) as operating_costs,
    (coalesce(revenue.gross_revenue, 0) - coalesce(expenses.operating_costs, 0))::numeric(14, 4) as estimated_profit,
    coalesce(revenue.pageviews, 0)::bigint as pageviews,
    coalesce(revenue.impressions, 0)::bigint as impressions
  from revenue full outer join expenses using (workspace_id, report_date);
revoke all on public.workspace_profit_daily from public, anon;
grant select on public.workspace_profit_daily to authenticated, service_role;

comment on table public.revenue_daily is 'Daily imported revenue metrics, stored separately by platform.';
comment on table public.operating_expenses is 'Workspace costs used to calculate estimated operating profit.';
comment on view public.workspace_profit_daily is 'Daily workspace revenue less recorded operating expenses; underlying RLS is enforced.';
comment on table public.google_oauth_credentials is 'Encrypted Google refresh tokens; privileges are restricted to trusted server functions.';
comment on function public.create_workspace(text) is 'Atomically creates a workspace and assigns its creator as first admin.';
