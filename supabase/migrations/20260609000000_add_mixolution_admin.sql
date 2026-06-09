insert into public.approved_admins (github_username, note)
values ('mixolution', 'approved admin')
on conflict (github_username) do update
set active = true,
    note = excluded.note,
    updated_at = now();
