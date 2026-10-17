-- +goose Up
-- autoNOMIC: Backup & Restore - add or remove a repository (a second disk, S3, Azure, GCS, SFTP)
alter table public.upgrades drop constraint if exists upgrades_action_check;
alter table public.upgrades add constraint upgrades_action_check
  check (action in ('plan', 'run', 'rollback', 'backup', 'check', 'stanza-create', 'config', 'schedule', 'restore',
                    'repo-add', 'repo-remove'));

-- +goose Down
delete from public.upgrades where action in ('repo-add', 'repo-remove');
alter table public.upgrades drop constraint if exists upgrades_action_check;
alter table public.upgrades add constraint upgrades_action_check
  check (action in ('plan', 'run', 'rollback', 'backup', 'check', 'stanza-create', 'config', 'schedule', 'restore'));
