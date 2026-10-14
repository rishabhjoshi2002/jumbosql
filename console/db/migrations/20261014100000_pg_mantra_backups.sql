-- +goose Up

-- pg_MANTRA: Backups (pgBackRest). Backup, check, config, schedule and restore jobs are kept with the upgrades
-- (component 'backup', their own actions); the new permission backup.run goes to Administrators.
alter table public.upgrades drop constraint if exists upgrades_action_check;
alter table public.upgrades add constraint upgrades_action_check
  check (action in ('plan', 'run', 'rollback', 'backup', 'check', 'stanza-create', 'config', 'schedule', 'restore'));

update public.policies
   set permissions = array_append(permissions, 'backup.run')
 where builtin and name = 'Administrators'
   and not ('backup.run' = any (permissions));

-- +goose Down
update public.policies set permissions = array_remove(permissions, 'backup.run') where builtin;
delete from public.upgrades where component = 'backup';
alter table public.upgrades drop constraint if exists upgrades_action_check;
alter table public.upgrades add constraint upgrades_action_check check (action in ('plan', 'run', 'rollback'));
