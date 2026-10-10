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
import { FleetGrowth, FleetRisks, FleetTable, FleetTiles, useFleet } from '@pages/insights/ui/Fleet.tsx';
import { chosenCards, isWide } from '../model/cards.ts';

const Panel: FC<{ title: string; action?: ReactNode; children: ReactNode; wide?: boolean }> = ({
  title,
  action,
  children,
  wide,
}) => (
  <Box
    sx={{
      gridColumn: wide ? '1 / -1' : undefined,
      border: 1,
      borderColor: 'divider',
      borderRadius: 2,
      p: 2,
      bgcolor: 'background.paper',
      minWidth: 0,
    }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.25} gap={1}>
      <Typography fontWeight={700}>{title}</Typography>
      {action}
    </Stack>
    {children}
  </Box>
);

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
    <Panel title={t('home_fleet')} action={more} wide={isWide(id)}>
      {body(
        <Stack gap={2}>
          <FleetTiles fleet={q.data!} />
          <FleetTable fleet={q.data!} onOpen={open} compact />
        </Stack>,
      )}
    </Panel>
  ) : id === 'risks' ? (
    <Panel title={t('home_risks')}>{body(<FleetRisks fleet={q.data!} max={6} onOpen={open} />)}</Panel>
  ) : (
    <Panel title={t('home_growth')}>{body(<FleetGrowth fleet={q.data!} />)}</Panel>
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

const ShortcutsCard: FC = () => {
  const { t } = useTranslation(['shared', 'clusters', 'operations', 'settings', 'insights']);
  const user = useSessionUser();
  const links = sidebarData(t, user).filter((l) => l.path !== RouterPaths.home.absolutePath);
  return (
    <Panel title={t('home_shortcuts')}>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        {links.map((l) => (
          <Button
            key={l.path}
            component={RouterLink}
            to={l.path}
            variant="outlined"
            startIcon={<l.icon width={18} height={18} />}
            sx={{ justifyContent: 'flex-start', textTransform: 'none' }}>
            {l.label}
          </Button>
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

/** pg_genie: each user's own home page - the cards an admin chose for them (Settings -> Users), limited to what they may see. */
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
  return (
    <Stack gap={2} p={2}>
      <Stack direction="row" alignItems="flex-end" gap={2} flexWrap="wrap">
        <Box flex={1}>
          <Typography variant="h5" fontWeight={700}>
            {t(`homeGreeting_${greeting(new Date().getHours())}`, { name })}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
            {' · '}
            {t('homeSubtitle')}
          </Typography>
        </Box>
      </Stack>

      {!cards.length ? <Alert severity="info">{t('homeEmpty')}</Alert> : null}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
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
