import { FC, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditOutlined from '@mui/icons-material/EditOutlined';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import LockOutlined from '@mui/icons-material/LockOutlined';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import {
  Policy,
  useDeletePolicyMutation,
  useGetPermissionCatalogQuery,
  useGetPoliciesQuery,
  usePatchPolicyMutation,
  usePostPolicyMutation,
} from '@shared/api/api/access.ts';
import { useGetUsersQuery } from '@shared/api/api/auth.ts';
import { useGetEnvironmentsQuery } from '@shared/api/api/environments.ts';
import { useGetProjectsQuery } from '@shared/api/api/projects.ts';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { handleRequestErrorCatch } from '@shared/lib/functions.ts';
import PolicyEditor from './PolicyEditor.tsx';
import SimulatePanel from './SimulatePanel.tsx';
import { dataText, emptyPolicy, whenText, whereText, whoText } from '../lib/policyText.ts';

const errorText = (e: unknown) => {
  const d = (e as { data?: { title?: string; description?: string } })?.data;
  return d?.description || d?.title || (e ? String((e as Error).message ?? e) : '');
};

const Line: FC<{ label: string; text: string }> = ({ label, text }) =>
  text ? (
    <Stack direction="row" gap={1} alignItems="baseline">
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 64, textTransform: 'uppercase' }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        {text}
      </Typography>
    </Stack>
  ) : null;

/** JumboSQL: Settings > Access policies (ABAC). */
const PoliciesPage: FC = () => {
  const { t } = useTranslation(['settings', 'shared']);
  const projectId = useAppSelector(selectCurrentProject);
  const policies = useGetPoliciesQuery();
  const catalog = useGetPermissionCatalogQuery();
  const users = useGetUsersQuery();
  const envs = useGetEnvironmentsQuery({ offset: 0, limit: 999_999_999 });
  const projects = useGetProjectsQuery({ offset: 0, limit: 999_999_999 });
  const clusters = useGetClustersQuery(
    { projectId: Number(projectId), offset: 0, limit: 999_999_999 },
    { skip: !projectId },
  );
  const [post, postState] = usePostPolicyMutation();
  const [patch, patchState] = usePatchPolicyMutation();
  const [del] = useDeletePolicyMutation();

  const [editing, setEditing] = useState<Policy | null>(null);
  const [saveError, setSaveError] = useState('');
  const [filter, setFilter] = useState('');

  const userNames = useMemo(() => (users.data ?? []).map((u) => u.username), [users.data]);
  const attributeKeys = useMemo(() => {
    const out: Record<string, Set<string>> = { group: new Set(['admin', 'operator', 'viewer']) };
    (users.data ?? []).forEach((u) =>
      Object.entries(u.attributes ?? {}).forEach(([k, v]) => (out[k] ??= new Set()).add(v)),
    );
    (policies.data ?? []).forEach((p) =>
      Object.entries(p.subjects?.attributes ?? {}).forEach(([k, vs]) =>
        vs.forEach((v) => (out[k] ??= new Set()).add(v)),
      ),
    );
    return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, [...s].sort()]));
  }, [users.data, policies.data]);
  const clusterList = useMemo(
    () => (clusters.data?.data ?? []).filter((c) => c.id && c.name).map((c) => ({ id: c.id!, name: c.name! })),
    [clusters.data],
  );

  const shown = (policies.data ?? []).filter((p) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return [p.name, p.description, whoText(p), whereText(p), p.permissions.join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  const open = (p: Policy) => {
    setSaveError('');
    setEditing(p);
  };

  const save = async (p: Policy) => {
    setSaveError('');
    try {
      if (p.id) await patch({ ...p, id: p.id }).unwrap();
      else await post(p).unwrap();
      toast.success(t('policySaved', { name: p.name }));
      setEditing(null);
    } catch (e) {
      setSaveError(errorText(e));
    }
  };

  const toggle = async (p: Policy) => {
    try {
      await patch({ ...p, id: p.id!, enabled: !p.enabled }).unwrap();
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  const remove = async (p: Policy) => {
    if (!window.confirm(t('confirmDeletePolicy', { name: p.name }))) return;
    try {
      await del({ id: p.id! }).unwrap();
      toast.success(t('policyDeleted', { name: p.name }));
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  return (
    <Stack gap="16px" p="16px">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap="16px">
        <Box>
          <Typography variant="h6">{t('accessPolicies')}</Typography>
          <Typography variant="body2" color="text.secondary" maxWidth="820px">
            {t('accessPoliciesHelp')}
          </Typography>
        </Box>
        <Stack direction="row" gap={1}>
          <TextField
            size="small"
            placeholder={t('search', { ns: 'shared' })}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => open(emptyPolicy())}>
            {t('newPolicy')}
          </Button>
        </Stack>
      </Stack>

      {policies.isLoading ? (
        <Skeleton variant="rounded" height={160} />
      ) : policies.error ? (
        <Alert severity="error">{errorText(policies.error)}</Alert>
      ) : null}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' },
        }}>
        {shown.map((p) => (
          <Box
            key={p.id}
            sx={{
              border: 1,
              borderColor: 'divider',
              borderLeft: 4,
              borderLeftColor: p.effect === 'deny' ? 'error.main' : 'success.main',
              borderRadius: 2,
              p: 2,
              opacity: p.enabled ? 1 : 0.6,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}>
            <Stack direction="row" alignItems="center" gap={1}>
              <Typography fontWeight={700} sx={{ flex: 1, minWidth: 0 }} noWrap title={p.name}>
                {p.name}
              </Typography>
              {p.builtin ? (
                <Tooltip title={t('builtinHint')}>
                  <Chip size="small" icon={<LockOutlined />} label={t('builtin')} variant="outlined" />
                </Tooltip>
              ) : null}
              <Chip
                size="small"
                color={p.effect === 'deny' ? 'error' : 'success'}
                label={t(p.effect === 'deny' ? 'effectDeny' : 'effectAllow')}
              />
              <Tooltip title={p.enabled ? t('disablePolicy') : t('enablePolicy')}>
                <Switch size="small" checked={p.enabled} onChange={() => toggle(p)} />
              </Tooltip>
            </Stack>
            {p.description ? (
              <Typography variant="body2" color="text.secondary">
                {p.description}
              </Typography>
            ) : null}
            <Line label={t('who')} text={whoText(p)} />
            <Line label={t('where')} text={whereText(p)} />
            <Line label={t('data')} text={dataText(p)} />
            <Line label={t('when')} text={whenText(p)} />
            <Stack direction="row" gap={0.5} flexWrap="wrap">
              {p.permissions.map((perm) => (
                <Chip
                  key={perm}
                  size="small"
                  variant="outlined"
                  label={perm}
                  sx={{ fontFamily: 'monospace', fontSize: 11 }}
                />
              ))}
            </Stack>
            <Stack direction="row" justifyContent="flex-end" mt="auto">
              <Tooltip title={t('edit', { ns: 'shared' })}>
                <IconButton size="small" onClick={() => open(p)}>
                  <EditOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={t('duplicate')}>
                <IconButton
                  size="small"
                  onClick={() => open({ ...p, id: undefined, builtin: false, name: `${p.name} (copy)` })}>
                  <ContentCopyOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              {p.builtin ? null : (
                <Tooltip title={t('delete', { ns: 'shared' })}>
                  <IconButton size="small" onClick={() => remove(p)}>
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          </Box>
        ))}
      </Box>

      <Alert severity="info">{t('policyRulesHelp')}</Alert>

      <SimulatePanel users={userNames} clusters={clusterList} catalog={catalog.data ?? []} />

      {editing ? (
        <PolicyEditor
          open
          initial={editing}
          catalog={catalog.data ?? []}
          users={userNames}
          attributeKeys={attributeKeys}
          environments={(envs.data?.data ?? []).map((e) => e.name ?? '').filter(Boolean)}
          projects={(projects.data?.data ?? []).map((e) => e.name ?? '').filter(Boolean)}
          clusters={clusterList.map((c) => c.name)}
          saving={postState.isLoading || patchState.isLoading}
          error={saveError}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </Stack>
  );
};

export default PoliciesPage;
