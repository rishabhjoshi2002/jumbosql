-- +goose Up

-- pg_MANTRA: a custom playbook can come from a GitHub repository (pulled as an archive; "Pull Latest" refreshes it).
alter table public.custom_playbooks add column if not exists git_url text not null default '';
alter table public.custom_playbooks add column if not exists git_ref text not null default '';
alter table public.custom_playbooks add column if not exists git_commit text not null default '';
alter table public.custom_playbooks add column if not exists git_pulled_at timestamptz;

-- +goose Down
alter table public.custom_playbooks drop column if exists git_pulled_at;
alter table public.custom_playbooks drop column if exists git_commit;
alter table public.custom_playbooks drop column if exists git_ref;
alter table public.custom_playbooks drop column if exists git_url;
