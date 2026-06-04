# Supabase Upload Backend

This project uses Supabase Auth for GitHub sign-in and a Supabase Edge Function
to upload approved contributor zips into the GitHub publishing queue.

## Required Setup

1. Enable GitHub Auth in Supabase.
2. Apply `supabase/migrations/20260604000000_upload_allowlist.sql`.
3. Insert approved GitHub usernames in lowercase:

```sql
insert into public.approved_uploaders (github_username, note)
values ('github-username', 'maintainer approved');
```

4. Create a GitHub App installed only on `RSDWArchive/RSDWBuilds`.
   Required repository permissions:

- Metadata: read
- Contents: read/write
- Actions: write

5. Copy `.env.supabase-upload.example` to `.env.supabase-upload`, then fill
   in the private values. The real env file is ignored by git.

6. Run the setup helper:

```powershell
.\tools\setup_supabase_upload.ps1
```

The helper logs into Supabase, applies migrations if `SUPABASE_DB_PASSWORD` is
set, sets Edge Function secrets, and deploys the function.

Required Edge Function secrets:

```text
GITHUB_APP_ID
GITHUB_PRIVATE_KEY_B64
GITHUB_OWNER=RSDWArchive
GITHUB_REPO=RSDWBuilds
GITHUB_BRANCH=main
GITHUB_WORKFLOW_ID=process-submissions.yml
```

`GITHUB_INSTALLATION_ID` is optional. The function can discover it from the
installed GitHub App.

`GITHUB_PRIVATE_KEY_B64` should be the base64-encoded contents of the GitHub
App private key PEM file.
