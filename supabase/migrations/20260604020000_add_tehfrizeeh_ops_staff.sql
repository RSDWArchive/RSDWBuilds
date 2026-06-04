insert into public.approved_uploaders (github_username, note)
values ('tehfrizeeh-ops', 'approved uploader')
on conflict (github_username) do update
set active = true,
    note = excluded.note,
    updated_at = now();

insert into public.approved_managers (github_username, note)
values ('tehfrizeeh-ops', 'approved manager')
on conflict (github_username) do update
set active = true,
    note = excluded.note,
    updated_at = now();
