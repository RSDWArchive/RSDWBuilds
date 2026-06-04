create table if not exists public.approved_uploaders (
  github_username text primary key,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approved_uploaders_username_lower
    check (github_username = lower(github_username)),
  constraint approved_uploaders_username_format
    check (github_username ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
);

create table if not exists public.submission_uploads (
  id uuid primary key default gen_random_uuid(),
  github_username text not null,
  original_filename text not null,
  file_size_bytes bigint not null,
  repo_path text not null,
  upload_commit_sha text,
  upload_commit_url text,
  workflow_url text,
  created_at timestamptz not null default now()
);

alter table public.approved_uploaders enable row level security;
alter table public.submission_uploads enable row level security;

insert into public.approved_uploaders (github_username, note)
values ('rsdwarchive', 'initial approved uploader')
on conflict (github_username) do update
set active = true,
    note = excluded.note,
    updated_at = now();
