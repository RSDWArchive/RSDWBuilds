create table if not exists public.approved_admins (
  github_username text primary key,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approved_admins_username_lower
    check (github_username = lower(github_username)),
  constraint approved_admins_username_format
    check (github_username ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
);

create table if not exists public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_username text not null,
  target_username text not null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.approved_admins enable row level security;
alter table public.admin_actions enable row level security;

insert into public.approved_admins (github_username, note)
values ('rsdwarchive', 'initial admin')
on conflict (github_username) do update
set active = true,
    note = excluded.note,
    updated_at = now();
