import { FC, ReactNode, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import RouterPaths from '@app/router/routerPathsConfig';
import { useGetAuthMeQuery, usePutAuthMePreferencesMutation, UserPreferences } from '@shared/api/api/auth.ts';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { useGetOperationsQuery } from '@shared/api/api/operations.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import { can } from '@shared/lib/session.ts';
import { sidebarData } from '@widgets/sidebar/model/constants.ts';
import { loadHistory } from '@pages/sql-editor/lib/storage.ts';
import { FleetGrowth, useFleet } from '@pages/insights/ui/Fleet.tsx';
import { chosenCards, isWide } from '../model/cards.ts';
import { ClusterTiles, Hero, homeAnim, Panel } from './Visual.tsx';
import HubOutlined from '@mui/icons-material/HubOutlined';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded';
import StorageRounded from '@mui/icons-material/StorageRounded';
import TerminalRounded from '@mui/icons-material/TerminalRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import BoltRounded from '@mui/icons-material/BoltRounded';
import StickyNote2Outlined from '@mui/icons-material/StickyNote2Outlined';

const greeting = (h: number) => (h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening');

/* ------------------------------------------------------------ cards ------------------------------------------------------------ */

/** fleet cards share one cached summary request */
const FleetCard: FC<{ id: 'fleet' | 'risks' | 'growth' }> = ({ id }) => {
  const { t } = useTranslation(['shared', 'insights']);
  const navigate = useNavigate();
  const projectId = Number(useAppSelector(selectCurrentProject));
  const q = useFleet(projectId);
  const open = (id: number) => navigate(`${RouterPaths.insights.absolutePath}?cluster=${id}`);
  const more = (
    <Button size="small" component={RouterLink} to={`${RouterPaths.insights.absolutePath}?cluster=all`}>
      {t('homeOpenInsights')}
    </Button>
  );
  const body = (node: ReactNode) =>
    q.data ? (
      node
    ) : q.error ? (
      <Alert severity="warning">{t('loadFailed', { ns: 'insights' })}</Alert>
    ) : (
      <Typography color="text.secondary">{t('homeLoading')}</Typography>
    );
  return id === 'fleet' ? (
    <Panel title={t('home_fleet')} icon={<HubOutlined />} action={more} wide={isWide(id)} delay={0.05}>
      {body(<ClusterTiles fleet={q.data!} onOpen={open} />)}
    </Panel>
  ) : id === 'risks' ? (
    <Panel title={t('home_risks')} icon={<WarningAmberRounded />} delay={0.1}>
      {body(<Risks fleet={q.data!} onOpen={open} />)}
    </Panel>
  ) : (
    <Panel title={t('home_growth')} icon={<TrendingUpRounded />} delay={0.15}>
      {body(<FleetGrowth fleet={q.data!} />)}
    </Panel>
  );
};

const SEV: Record<string, { color: string; n: number }> = {
  critical: { color: '#EF4444', n: 0 },
  warning: { color: '#F59E0B', n: 1 },
  info: { color: '#38B2F5', n: 2 },
};

/** the top risks across clusters: a colour bar for how serious, the cluster, what to do */
const Risks: FC<{ fleet: NonNullable<ReturnType<typeof useFleet>['data']>; onOpen: (id: number) => void }> = ({
  fleet,
  onOpen,
}) => {
  const { t } = useTranslation('insights');
  const lines = (fleet.clusters ?? [])
    .flatMap((c) => [
      ...(c.summary?.unreachable ? [{ id: c.id, cluster: c.name, severity: 'critical', text: c.summary.unreachable }] : []),
      ...(c.summary?.outlook ?? []).filter((o) => o.severity !== 'ok').map((o) => ({ id: c.id, cluster: c.name, ...o })),
    ])
    .sort((a, b) => (SEV[a.severity]?.n ?? 9) - (SEV[b.severity]?.n ?? 9))
    .slice(0, 6);
  if (!lines.length) return <Alert severity="success">{t('noRisks')}</Alert>;
  return (
    <Stack gap={1}>
      {lines.map((l, i) => (
        <Box
          key={i}
          onClick={() => onOpen(l.id)}
          sx={{
            cursor: 'pointer',
            pl: 1.5,
            pr: 1,
            py: 1,
            borderRadius: '10px',
            borderLeft: `4px solid ${SEV[l.severity]?.color ?? '#8A99B4'}`,
            bgcolor: 'action.hover',
            transition: 'transform .15s',
            '&:hover': { transform: 'translateX(3px)' },
          }}>
          <Typography variant="caption" fontWeight={800} sx={{ color: SEV[l.severity]?.color }}>
            {l.cluster}
          </Typography>
          <Typography variant="body2">{l.text}</Typography>
        </Box>
      ))}
    </Stack>
  );
};

const ClustersCard: FC = () => {
  const { t } = useTranslation('shared');
  const projectId = Number(useAppSelector(selectCurrentProject));
  const user = useSessionUser();
  const q = useGetClustersQuery({ projectId, offset: 0, limit: 999_999_999 }, { skip: !projectId });
  const rows = (q.data?.data ?? []).filter((c) => c.id && can('clusters.view', c.id, user));
  return (
    <Panel
      title={t('home_clusters')}
      icon={<StorageRounded />}
      action={
        <Button size="small" component={RouterLink} to={RouterPaths.clusters.absolutePath}>
          {t('homeAll')}
        </Button>
      }>
      <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
        {rows.slice(0, 8).map((c) => (
          <Stack
            key={c.id}
            direction="row"
            alignItems="center"
            gap={1}
            py={0.75}
            component={RouterLink}
            to={RouterPaths.clusters.overview.absolutePath.replace(':clusterId', String(c.id))}
            sx={{ color: 'inherit', textDecoration: 'none' }}>
            <Typography fontWeight={600} variant="body2" flex={1} noWrap>
              {c.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {c.servers?.length ?? 0} {t('homeNodes')}
            </Typography>
            <Chip
              size="small"
              label={c.status}
              color={c.status === 'healthy' || c.status === 'ready' ? 'success' : 'default'}
              variant="outlined"
              sx={{ height: 20 }}
            />
          </Stack>
        ))}
        {!rows.length ? (
          <Typography color="text.secondary" variant="body2">
            {q.isLoading ? t('homeLoading') : t('homeNoClusters')}
          </Typography>
        ) : null}
      </Stack>
    </Panel>
  );
};

const RecentQueriesCard: FC = () => {
  const { t } = useTranslation('shared');
  const items = useMemo(() => loadHistory().slice(0, 6), []);
  return (
    <Panel
      title={t('home_recentQueries')}
      icon={<TerminalRounded />}
      action={
        <Button size="small" component={RouterLink} to={RouterPaths.sqlEditor.absolutePath}>
          {t('homeOpenEditor')}
        </Button>
      }>
      <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
        {items.map((h, i) => (
          <Box key={i} py={0.75} minWidth={0}>
            <Box
              sx={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={h.sql}>
              {h.sql.replace(/\s+/g, ' ')}
            </Box>
            <Typography variant="caption" color={h.ok ? 'text.secondary' : 'error.main'}>
              {h.clusterName} · {h.database} · {new Date(h.at).toLocaleString()} · {h.summary}
            </Typography>
          </Box>
        ))}
        {!items.length ? (
          <Typography color="text.secondary" variant="body2">
            {t('homeNoQueries')}
          </Typography>
        ) : null}
      </Stack>
    </Panel>
  );
};

const OperationsCard: FC = () => {
  const { t } = useTranslation('shared');
  const projectId = Number(useAppSelector(selectCurrentProject));
  const [range] = useState(() => ({
    startDate: new Date(Date.now() - 7 * 86400000).toISOString(),
    endDate: new Date(Date.now() + 86400000).toISOString(),
  }));
  const q = useGetOperationsQuery({ projectId, ...range, limit: 6, offset: 0, sortBy: '-id' }, { skip: !projectId });
  const rows = q.data?.data ?? [];
  return (
    <Panel
      title={t('home_operations')}
      icon={<HistoryRounded />}
      action={
        <Button size="small" component={RouterLink} to={RouterPaths.operations.absolutePath}>
          {t('homeAll')}
        </Button>
      }>
      <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
        {rows.map((o) => (
          <Stack key={o.id} direction="row" alignItems="center" gap={1} py={0.75}>
            <Box flex={1} minWidth={0}>
              <Typography variant="body2" fontWeight={600} noWrap>
                {o.type} · {o.cluster_name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {o.started ? new Date(o.started).toLocaleString() : ''}
              </Typography>
            </Box>
            <Chip
              size="small"
              variant="outlined"
              label={o.status}
              color={o.status === 'success' ? 'success' : o.status === 'failed' ? 'error' : 'default'}
              sx={{ height: 20 }}
            />
          </Stack>
        ))}
        {!rows.length ? (
          <Typography color="text.secondary" variant="body2">
            {q.isLoading ? t('homeLoading') : t('homeNoOperations')}
          </Typography>
        ) : null}
      </Stack>
    </Panel>
  );
};

const TILE = [
  'linear-gradient(135deg,#1D6FE0,#14286B)',
  'linear-gradient(135deg,#F4B321,#C98A0B)',
  'linear-gradient(135deg,#22C55E,#15803D)',
  'linear-gradient(135deg,#38B2F5,#1D6FE0)',
  'linear-gradient(135deg,#A855F7,#6D28D9)',
  'linear-gradient(135deg,#EF4444,#B91C1C)',
];

const ShortcutsCard: FC = () => {
  const { t } = useTranslation(['shared', 'clusters', 'operations', 'settings', 'insights']);
  const user = useSessionUser();
  const links = sidebarData(t, user).filter((l) => l.path !== RouterPaths.home.absolutePath);
  return (
    <Panel title={t('home_shortcuts')} icon={<BoltRounded />}>
      <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))' }}>
        {links.map((l, i) => (
          <Stack
            key={l.path}
            component={RouterLink}
            to={l.path}
            alignItems="center"
            gap={1}
            sx={{
              p: 1.5,
              borderRadius: '14px',
              border: 1,
              borderColor: 'divider',
              color: 'text.primary',
              textDecoration: 'none',
              textAlign: 'center',
              transition: 'transform .15s, box-shadow .15s, border-color .15s',
              '&:hover': { transform: 'translateY(-3px)', borderColor: 'primary.main', boxShadow: '0 10px 22px rgba(16,30,70,0.12)' },
            }}>
            <Box
              sx={{
                width: 42,
                height: 42,
                borderRadius: '12px',
                display: 'grid',
                placeItems: 'center',
                background: TILE[i % TILE.length],
                '& svg': { fill: '#fff', color: '#fff' },
              }}>
              <l.icon width={22} height={22} />
            </Box>
            <Typography variant="caption" fontWeight={700} lineHeight={1.2}>
              {l.label}
            </Typography>
          </Stack>
        ))}
      </Box>
    </Panel>
  );
};

const NotesCard: FC<{ prefs: UserPreferences; save: (p: UserPreferences) => Promise<void> }> = ({ prefs, save }) => {
  const { t } = useTranslation('shared');
  const [text, setText] = useState(prefs.notes ?? '');
  useEffect(() => setText(prefs.notes ?? ''), [prefs.notes]);
  const dirty = text !== (prefs.notes ?? '');
  return (
    <Panel
      title={t('home_notes')}
      icon={<StickyNote2Outlined />}
      action={
        <Button size="small" disabled={!dirty} onClick={() => void save({ ...prefs, notes: text.slice(0, 8000) })}>
          {t('save')}
        </Button>
      }>
      <TextField
        multiline
        minRows={4}
        maxRows={14}
        fullWidth
        placeholder={t('homeNotesHint')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Panel>
  );
};

/* ------------------------------------------------------------ page ------------------------------------------------------------ */

/** autoNOMIC: each user's own home page - the cards an admin chose for them (Settings -> Users), limited to what they may see. */
const Home: FC = () => {
  const { t } = useTranslation('shared');
  const user = useSessionUser();
  const me = useGetAuthMeQuery();
  const [put] = usePutAuthMePreferencesMutation();
  const prefs: UserPreferences = me.data?.preferences ?? {};
  const cards = chosenCards(me.data ? prefs : undefined, user);

  const save = async (p: UserPreferences) => {
    try {
      await put(p).unwrap();
      await me.refetch();
      toast.success(t('homeSaved'));
    } catch {
      toast.error(t('homeSaveFailed'));
    }
  };

  const name = user?.display_name || user?.username || '';
  const projectId = Number(useAppSelector(selectCurrentProject));
  const fleetOk = can('insights.view', undefined, user);
  const fleet = useFleet(fleetOk ? projectId : 0);
  const cl = useGetClustersQuery({ projectId, offset: 0, limit: 999_999_999 }, { skip: !projectId });
  const mine = (cl.data?.data ?? []).filter((c) => c.id && can('clusters.view', c.id, user));
  const nodes = fleet.data ? fleet.data.totals.servers : mine.reduce((n, c) => n + (c.servers?.length ?? 0), 0);
  const up = fleet.data
    ? (fleet.data.clusters ?? []).reduce((n, c) => n + c.healthy, 0)
    : mine.reduce((n, c) => n + (c.servers ?? []).filter((x) => x.status === 'running' || x.status === 'streaming').length, 0);
  return (
    <Stack gap={2.25} p={{ xs: 1.5, md: 2.5 }} sx={homeAnim}>
      <Hero
        greeting={t(`homeGreeting_${greeting(new Date().getHours())}`, { name })}
        subtitle={t('homeSubtitle')}
        fleet={fleet.data}
        clusters={fleet.data ? fleet.data.totals.clusters : mine.length}
        nodes={nodes}
        nodesUp={up}
      />

      {!cards.length ? <Alert severity="info">{t('homeEmpty')}</Alert> : null}

      <Box
        sx={{
          display: 'grid',
          gap: 2.25,
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
          alignItems: 'start',
        }}>
        {cards.map((id) => {
          switch (id) {
            case 'fleet':
            case 'risks':
            case 'growth':
              return <FleetCard key={id} id={id} />;
            case 'clusters':
              return <ClustersCard key={id} />;
            case 'recentQueries':
              return <RecentQueriesCard key={id} />;
            case 'operations':
              return <OperationsCard key={id} />;
            case 'shortcuts':
              return <ShortcutsCard key={id} />;
            case 'notes':
              return <NotesCard key={id} prefs={prefs} save={save} />;
            default:
              return null;
          }
        })}
      </Box>
    </Stack>
  );
};

export default Home;
