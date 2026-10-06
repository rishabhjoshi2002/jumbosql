import { FC, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import QueryStatsOutlined from '@mui/icons-material/QueryStatsOutlined';
import NotificationsActiveOutlined from '@mui/icons-material/NotificationsActiveOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { useTranslation } from 'react-i18next';
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

/**
 * JumboSQL: Observability - each cluster's Grafana, Prometheus and Alertmanager in one place.
 * URLs come from the cluster's Monitoring VM and can be overridden per cluster (saved in console settings).
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

  const [embed, setEmbed] = useState<{ title: string; url: string } | null>(null);
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

  if (clusters.isLoading) return <Spinner />;

  return (
    <Stack gap="20px" p="16px">
      <Box>
        <Typography variant="h5">{t('observability')}</Typography>
        <Typography color="text.secondary" mt="4px" maxWidth="860px">
          {t('obsIntro')}
        </Typography>
      </Box>

      <Alert severity="info">{t('obsReachHint')}</Alert>

      {!items.length ? (
        <Paper sx={{ p: '32px', textAlign: 'center' }}>
          <Typography fontWeight={700}>{t('obsNoClusters')}</Typography>
        </Paper>
      ) : null}

      {items.map((c) => {
        const hasAny = OBSERVABILITY_TOOLS.some((tool) => c.links[tool]);
        return (
          <Paper key={c.id} sx={{ p: '20px', borderRadius: '14px' }} data-testid={`obs-cluster-${c.id}`}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb="16px">
              <Stack direction="row" alignItems="center" gap="10px">
                <Typography variant="h6">{c.name}</Typography>
                {c.status ? <Chip size="small" label={c.status} /> : null}
              </Stack>
              {writable ? (
                <Button
                  size="small"
                  startIcon={<EditOutlined />}
                  onClick={() => setEditing({ id: c.id, name: c.name, links: { ...overrides[String(c.id)] } })}>
                  {t('obsEditUrls')}
                </Button>
              ) : null}
            </Stack>
            {!hasAny ? (
              <Typography color="text.secondary">{t('obsNoMonitoring')}</Typography>
            ) : (
              <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(260px, 1fr))" gap="14px">
                {OBSERVABILITY_TOOLS.map((tool) => {
                  const url = c.links[tool];
                  const Meta = TOOL_META[tool];
                  const Icon = Meta.icon;
                  return (
                    <Box
                      key={tool}
                      sx={{
                        p: '16px',
                        borderRadius: '12px',
                        border: '1px solid',
                        borderColor: 'divider',
                        backgroundColor: 'background.default',
                        opacity: url ? 1 : 0.6,
                      }}>
                      <Stack direction="row" alignItems="center" gap="10px" mb="6px">
                        <Icon />
                        <Typography fontWeight={700}>{Meta.label}</Typography>
                      </Stack>
                      <Typography variant="body2" color="text.secondary" minHeight="40px">
                        {t(Meta.hint)}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{ fontFamily: 'monospace', display: 'block', my: '10px', wordBreak: 'break-all' }}>
                        {url ?? t('obsNotDeployed')}
                      </Typography>
                      <Stack direction="row" gap="8px">
                        <Button
                          size="small"
                          variant="contained"
                          endIcon={<OpenInNewOutlined />}
                          disabled={!isSafeHttpUrl(url)}
                          href={isSafeHttpUrl(url) ? url : undefined}
                          target="_blank"
                          rel="noopener noreferrer">
                          {t('obsOpen')}
                        </Button>
                        {tool === 'grafana' ? (
                          <Tooltip title={t('obsEmbedHint')}>
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={!isSafeHttpUrl(url)}
                                onClick={() => setEmbed({ title: `${c.name} · Grafana`, url: url as string })}>
                                {t('obsEmbed')}
                              </Button>
                            </span>
                          </Tooltip>
                        ) : null}
                      </Stack>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Paper>
        );
      })}

      {embed ? (
        <Paper sx={{ p: '12px', borderRadius: '14px' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" mb="8px">
            <Typography fontWeight={700}>{embed.title}</Typography>
            <IconButton size="small" onClick={() => setEmbed(null)} aria-label={t('closePanel')}>
              <CloseOutlined />
            </IconButton>
          </Stack>
          <Box
            component="iframe"
            src={embed.url}
            title={embed.title}
            sx={{
              width: '100%',
              height: '75vh',
              border: 0,
              borderRadius: '10px',
              backgroundColor: 'background.default',
            }}
          />
        </Paper>
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
