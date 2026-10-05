-- +goose Up

-- JumboSQL: the bundled HA automation (2.2.0) installs PostgreSQL up to 17; offering 18 made the playbook crash in
-- preflight ('NoneType' object has no attribute 'split'). The automation image also refuses versions that are not
-- in its package list (automation-ha/inventory_to_ha.py), so a newer automation only needs this row added back.
delete from public.postgres_versions
where major_version > 17;

-- +goose Down
insert into public.postgres_versions (major_version, release_date, end_of_life)
  values (18, '2025-09-25', '2030-11-14')
on conflict do nothing;
