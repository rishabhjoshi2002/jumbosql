import { FC, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import QueryStatsOutlined from '@mui/icons-material/QueryStatsOutlined';
import NotificationsActiveOutlined from '@mui/icons-material/NotificationsActiveOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import {
  useGetSettingsQuery,
  usePatchSettingsByNameMutation,
  usePostSettingsMutation,
} from '@shared/api/api/settings.ts';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { handleRequestErrorCatch } from '@shared/lib/functions.ts';
import { can } from '@shared/lib/session.ts';
import Spinner from '@shared/ui/spinner';
import MonitoringDashboard from './MonitoringDashboard.tsx';
import {
  isSafeHttpUrl,
  OBSERVABILITY_SETTING,
  OBSERVABILITY_TOOLS,
  ObservabilityLinks,
  ObservabilityTool,
  resolveLinks,
} from '@pages/observability/lib/links.ts';

type Overrides = Record<string, ObservabilityLinks>;

const TOOL_META: Record<ObservabilityTool, { icon: typeof DashboardOutlined; label: string; hint: string }> = {
  grafana: { icon: DashboardOutlined, label: 'Grafana', hint: 'obsGrafanaHint' },
  prometheus: { icon: QueryStatsOutlined, label: 'Prometheus', hint: 'obsPrometheusHint' },
  alertmanager: { icon: NotificationsActiveOutlined, label: 'Alertmanager', hint: 'obsAlertmanagerHint' },
};

const RANGES = [60, 360, 1440, 10080]; // minutes

/**
 * pg_genie: Observability - a live monitoring dashboard per cluster (services, alerts, PostgreSQL / etcd / node graphs
 * from the cluster's Prometheus) plus links to its Grafana, Prometheus and Alertmanager. URLs come from the cluster's
 * Monitoring VM and can be overridden per cluster (saved in console settings).
 */
const Observability: FC = () => {
  const { t } = useTranslation('shared');
  const projectId = useAppSelector(selectCurrentProject);
  const clusters = useGetClustersQuery(
    { projectId: Number(projectId), offset: 0, limit: 999_999_999 },
    { skip: !projectId },
  );
  const setting = useGetSettingsQuery({ name: OBSERVABILITY_SETTING });
  const [createSetting] = usePostSettingsMutation();
  const [patchSetting] = usePatchSettingsByNameMutation();
  const writable = can('observability.manage');

  const saved = setting.data?.data?.find((s) => s.name === OBSERVABILITY_SETTING);
  const overrides = useMemo(() => (saved?.value ?? {}) as Overrides, [saved?.value]);

  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<{ id: number; name: string; links: ObservabilityLinks } | null>(null);

  const items = useMemo(
    () =>
      (clusters.data?.data ?? []).map((c) => ({
        id: c.id as number,
        name: c.name ?? '',
        status: c.status ?? '',
        links: resolveLinks((c as { inventory?: string }).inventory, overrides[String(c.id)]),
      })),
    [clusters.data, overrides],
  );

  const saveOverrides = async () => {
    if (!editing) return;
    const next: Overrides = { ...overrides, [String(editing.id)]: editing.links };
    try {
      if (saved) await patchSetting({ name: OBSERVABILITY_SETTING, requestChangeSetting: { value: next } }).unwrap();
      else await createSetting({ requestCreateSetting: { name: OBSERVABILITY_SETTING, value: next } }).unwrap();
      toast.success(t('obsSaved', { cluster: editing.name }));
      setEditing(null);
      setting.refetch();
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  const current = items.find((c) => String(c.id) === params.get('cluster')) ?? items[0];
  const minutes = Number(params.get('minutes')) || 60;
  const setParam = (k: string, v: string | number) => {
    const next = new URLSearchParams(params);
    next.set(k, String(v));
    setParams(next, { replace: true });
  };

  if (clusters.isLoading) return <Spinner />;

  return (
    <Stack gap="16px" p="16px">
      <Box>
        <Typography variant="h5">{t('observability')}</Typography>
        <Typography color="text.secondary" mt="4px" maxWidth="900px">
          {t('obsIntro')}
        </Typography>
      </Box>

      {!items.length ? (
        <Paper sx={{ p: '32px', textAlign: 'center' }}>
          <Typography fontWeight={700}>{t('obsNoClusters')}</Typography>
        </Paper>
      ) : null}

      {current ? (
        <>
          {/* filters, then the cluster's monitoring links */}
          <Stack direction="row" gap="12px" alignItems="center" flexWrap="wrap">
            <TextField
              select
              size="small"
              label={t('cluster', { ns: 'clusters', defaultValue: 'Cluster' })}
              value={current.id}
              onChange={(e) => setParam('cluster', e.target.value)}
              sx={{ minWidth: 200 }}>
              {items.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                </MenuItem>
              ))}
            </TextField>
            <ToggleButtonGroup size="small" exclusive value={minutes} onChange={(_, v) => v && setParam('minutes', v)}>
              {RANGES.map((r) => (
                <ToggleButton key={r} value={r}>
                  {t(`monRange_${r}`)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Box flex={1} />
            {OBSERVABILITY_TOOLS.map((tool) => {
              const url = current.links[tool];
              const Icon = TOOL_META[tool].icon;
              return (
                <Tooltip key={tool} title={url ? `${t(TOOL_META[tool].hint)} ${url}` : t('obsNotDeployed')}>
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<Icon />}
                      endIcon={<OpenInNewOutlined />}
                      disabled={!isSafeHttpUrl(url)}
                      href={isSafeHttpUrl(url) ? url : undefined}
                      target="_blank"
                      rel="noopener noreferrer">
                      {TOOL_META[tool].label}
                    </Button>
                  </span>
                </Tooltip>
              );
            })}
            {writable ? (
              <Button
                size="small"
                startIcon={<EditOutlined />}
                onClick={() =>
                  setEditing({ id: current.id, name: current.name, links: { ...overrides[String(current.id)] } })
                }>
                {t('obsEditUrls')}
              </Button>
            ) : null}
          </Stack>
          {!OBSERVABILITY_TOOLS.some((tool) => current.links[tool]) ? (
            <Typography color="text.secondary">{t('obsNoMonitoring')}</Typography>
          ) : null}
          <Stack direction="row" gap="8px" alignItems="center">
            <Typography variant="h6">{current.name}</Typography>
            {current.status ? <Chip size="small" label={current.status} /> : null}
          </Stack>
          <MonitoringDashboard
            key={current.id}
            clusterId={current.id}
            clusterStatus={current.status}
            minutes={minutes}
          />
          <Typography variant="caption" color="text.secondary">
            {t('obsReachHint')}
          </Typography>
        </>
      ) : null}

      <Dialog open={!!editing} onClose={() => setEditing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('obsEditTitle', { cluster: editing?.name })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb="16px">
            {t('obsEditHelp')}
          </Typography>
          <Stack gap="14px">
            {OBSERVABILITY_TOOLS.map((tool) => (
              <TextField
                key={tool}
                label={TOOL_META[tool].label}
                placeholder={items.find((i) => i.id === editing?.id)?.links[tool] ?? 'https://'}
                value={editing?.links[tool] ?? ''}
                error={!!editing?.links[tool] && !isSafeHttpUrl(editing?.links[tool])}
                onChange={(e) =>
                  editing && setEditing({ ...editing, links: { ...editing.links, [tool]: e.target.value } })
                }
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: '24px', pb: '16px' }}>
          <Button onClick={() => setEditing(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            onClick={saveOverrides}
            disabled={OBSERVABILITY_TOOLS.some(
              (tool) => !!editing?.links[tool] && !isSafeHttpUrl(editing?.links[tool]),
            )}>
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
};

export default Observability;
