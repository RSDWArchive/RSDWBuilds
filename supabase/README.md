# Supabase Staff Backend

This project uses Supabase Auth for GitHub sign-in and a Supabase Edge Function
to upload approved contributor zips into the GitHub publishing queue. It also
uses separate manager approval for the hidden `/manage/` panel.

## Required Setup

1. Enable GitHub Auth in Supabase.
2. Apply all migrations in `supabase/migrations`.
3. Insert approved uploader GitHub usernames in lowercase:

```sql
insert into public.approved_uploaders (github_username, note)
values ('github-username', 'maintainer approved');
```

4. Insert approved manager GitHub usernames in lowercase:

```sql
insert into public.approved_managers (github_username, note)
values ('github-username', 'manager approved');
```

## Managing Approved Uploaders

Approved uploaders are stored in Supabase, not GitHub repo permissions. Use
lowercase GitHub usernames without `@`.

Add or reactivate an uploader:

```sql
insert into public.approved_uploaders (github_username, note)
values ('githubusername', 'approved uploader')
on conflict (github_username) do update
set active = true,
    note = excluded.note,
    updated_at = now();
```

Revoke upload access:

```sql
update public.approved_uploaders
set active = false,
    updated_at = now()
where github_username = 'githubusername';
```

## Managing Approved Managers

Managers use the hidden `/manage/` page. Managers can edit metadata,
hide/unhide entries, queue replacement packages, and manage entry screenshots.
They do not receive GitHub repo permissions.

Add or reactivate a manager:

```sql
insert into public.approved_managers (github_username, note)
values ('githubusername', 'approved manager')
on conflict (github_username) do update
set active = true,
    note = excluded.note,
    updated_at = now();
```

Revoke manager access:

```sql
update public.approved_managers
set active = false,
    updated_at = now()
where github_username = 'githubusername';
```

Management actions are recorded in `public.management_actions`.

## GitHub App

Create a GitHub App installed only on `RSDWArchive/RSDWBuilds`.
   Required repository permissions:

- Metadata: read
- Contents: read/write
- Actions: write

## Deployment

Copy `.env.supabase-upload.example` to `.env.supabase-upload`, then fill
   in the private values. The real env file is ignored by git.

Run the setup helper:

```powershell
.\tools\setup_supabase_upload.ps1
```

The helper logs into Supabase, applies migrations if `SUPABASE_DB_PASSWORD` is
set, sets Edge Function secrets, and deploys the Edge Functions.

Required Edge Function secrets:

```text
GITHUB_APP_ID
GITHUB_PRIVATE_KEY_B64
GITHUB_OWNER=RSDWArchive
GITHUB_REPO=RSDWBuilds
GITHUB_BRANCH=main
GITHUB_WORKFLOW_ID=process-submissions.yml
DEPLOY_WORKFLOW_ID=deploy-pages.yml
REPLACE_WORKFLOW_ID=replace-entry.yml
SITE_ASSETS_WORKFLOW_ID=sync-site-assets.yml
MAX_IMAGE_BYTES=8388608
```

`GITHUB_INSTALLATION_ID` is optional. The function can discover it from the
installed GitHub App.

`GITHUB_PRIVATE_KEY_B64` should be the base64-encoded contents of the GitHub
App private key PEM file.
