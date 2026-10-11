-- +goose Up

-- pg_mantra: your own upgrade playbooks. An admin adds the upgrade playbook (and its rollback playbook, an archive
-- with roles / files, the inputs it needs); the console runs it in the upgrade runner container: a dry run
-- (ansible-playbook --check --diff), the upgrade, and the rollback. Runs are kept in upgrades (playbook_id set).
create table if not exists public.custom_playbooks (
  playbook_id       bigserial   primary key,
  name              text        not null unique,
  description       text        not null default '',
  playbook          text        not null default '', -- the upgrade playbook (YAML), or ...
  playbook_path     text        not null default '', -- ... its path inside the archive
  rollback          text        not null default '', -- the rollback playbook (YAML), or ...
  rollback_path     text        not null default '', -- ... its path inside the archive
  requirements      text        not null default '', -- requirements.yml (collections / roles, installed at each run)
  variables         jsonb       not null default '[]', -- the inputs asked at each run: [{name, label, type, required, default, options, help}]
  groups            jsonb       not null default '[]', -- inventory groups the playbook uses: [{group, from}] (from: a component)
  files             bytea,                              -- .tar.gz / .zip with roles, files, templates, group_vars ...
  files_name        text        not null default '',
  created_by        text        not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.upgrades add column if not exists playbook_id bigint references public.custom_playbooks (playbook_id) on delete cascade;
alter table public.upgrades drop constraint if exists upgrades_target;
alter table public.upgrades add constraint upgrades_target check (cluster_id is not null or discovery_id is not null or playbook_id is not null);
create index if not exists upgrades_playbook on public.upgrades (playbook_id, created_at desc);

-- +goose Down
drop index if exists upgrades_playbook;
delete from public.upgrades where cluster_id is null and discovery_id is null;
alter table public.upgrades drop constraint if exists upgrades_target;
alter table public.upgrades add constraint upgrades_target check (cluster_id is not null or discovery_id is not null);
alter table public.upgrades drop column if exists playbook_id;
drop table if exists public.custom_playbooks;
