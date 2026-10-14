import { FC, useEffect, useMemo } from 'react';
import { ListSubheader, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { useGetDiscoveriesQuery } from '@shared/api/api/discover.ts';
import { UTarget } from '@shared/api/api/upgrade.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { can } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';

export const targetKey = (t?: UTarget | null) => (t && t.id ? `${t.kind}:${t.id}` : '');
const fromKey = (k: string): UTarget | null => {
  const [kind, id] = k.split(':');
  return kind && Number(id) ? { kind: kind as UTarget['kind'], id: Number(id) } : null;
};

/** the clusters the console knows, by name - for labels elsewhere */
export const useTargetNames = () => {
  const projectId = Number(useAppSelector(selectCurrentProject));
  const clusters = useGetClustersQuery({ projectId, offset: 0, limit: 999_999_999 }, { skip: !projectId });
  const discoveries = useGetDiscoveriesQuery();
  return useMemo(() => {
    const m: Record<string, string> = {};
    (clusters.data?.data ?? []).forEach((c) => c.id && (m[`clusters:${c.id}`] = c.name ?? `#${c.id}`));
    (discoveries.data ?? []).forEach((d) => (m[`discoveries:${d.id}`] = d.name || `#${d.id}`));
    return m;
  }, [clusters.data, discoveries.data]);
};

/**
 * One list of every cluster: created by pg_mantra or found by Discover (any setup, whoever built it).
 */
const TargetSelect: FC<{
  value: UTarget | null;
  onChange: (t: UTarget | null) => void;
  label?: string;
  perm?: string;
}> = ({ value, onChange, label, perm = 'upgrade.run' }) => {
  const { t } = useTranslation('upgrade');
  const user = useSessionUser();
  const projectId = Number(useAppSelector(selectCurrentProject));
  const clusters = useGetClustersQuery({ projectId, offset: 0, limit: 999_999_999 }, { skip: !projectId });
  const discoveries = useGetDiscoveriesQuery();
  const created = useMemo(
    () => (clusters.data?.data ?? []).filter((c) => c.id && can(perm, c.id, user)),
    [clusters.data, user, perm],
  );
  const found = useMemo(() => discoveries.data ?? [], [discoveries.data]);
  useEffect(() => {
    if (value?.id) return;
    if (found[0]) onChange({ kind: 'discoveries', id: found[0].id });
    else if (created[0]?.id) onChange({ kind: 'clusters', id: created[0].id });
  }, [value, found, created, onChange]);

  return (
    <TextField
      select
      size="small"
      label={label ?? t('cluster')}
      value={targetKey(value)}
      helperText={!found.length && !created.length ? t('noTargets') : undefined}
      onChange={(e) => onChange(fromKey(e.target.value))}>
      {found.length ? <ListSubheader>{t('groupDiscovered')}</ListSubheader> : null}
      {found.map((d) => (
        <MenuItem key={`d${d.id}`} value={`discoveries:${d.id}`}>
          {d.name || 'Discovery'}
          <Typography component="span" variant="caption" color="text.secondary" ml={1}>
            #{d.id} · {new Date(d.created_at).toLocaleDateString()}
          </Typography>
        </MenuItem>
      ))}
      {created.length ? <ListSubheader>{t('groupCreated')}</ListSubheader> : null}
      {created.map((c) => (
        <MenuItem key={`c${c.id}`} value={`clusters:${c.id}`}>
          {c.name}
        </MenuItem>
      ))}
    </TextField>
  );
};

export default TargetSelect;
