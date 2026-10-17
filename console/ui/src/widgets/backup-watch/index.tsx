import { FC, useEffect } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import BackupRounded from '@mui/icons-material/BackupRounded';
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BActivity, useGetBackupActivityQuery } from '@shared/api/api/backup.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import { can } from '@shared/lib/session.ts';
import RouterPaths from '@app/router/routerPathsConfig';

/** which running backups this sign-in has already been told about (a new sign-in is told again) */
const seenKey = () => `autonomic.seenBackups.${(localStorage.getItem('token') ?? '').slice(-16)}`;
const seen = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(seenKey()) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const remember = (s: Set<string>) => {
  try {
    sessionStorage.setItem(seenKey(), JSON.stringify([...s].slice(-200)));
  } catch {
    /* private window: the popup may show again, nothing breaks */
  }
};

const Popup: FC<{ a: BActivity; onOpen: () => void }> = ({ a, onOpen }) => {
  const { t } = useTranslation('backup');
  return (
    <Stack direction="row" gap={1.5} alignItems="flex-start" onClick={onOpen} sx={{ cursor: 'pointer' }} data-testid="backup-popup">
      <Box
        sx={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: '12px',
          display: 'grid',
          placeItems: 'center',
          color: '#1B1300',
          background: 'linear-gradient(135deg,#F4B321,#C98A0B)',
          '@keyframes bwPulse': { '0%': { boxShadow: '0 0 0 0 rgba(244,179,33,.6)' }, '100%': { boxShadow: '0 0 0 14px rgba(244,179,33,0)' } },
          animation: 'bwPulse 1.6s infinite',
        }}>
        <BackupRounded />
      </Box>
      <Box minWidth={0} flex={1}>
        <Typography fontWeight={800}>{t('pop_title')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('pop_text', { type: t(a.type), cluster: a.cluster, by: t(`rn_by_${a.by}`, { how: a.how ?? '' }) })}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {a.address} · {new Date(a.started).toLocaleTimeString()}
        </Typography>
        <Box mt={0.75}>
          <Button size="small" variant="contained" onClick={onOpen}>
            {t('pop_open')}
          </Button>
        </Box>
      </Box>
    </Stack>
  );
};

/**
 * Tells everyone signed in (who may run backups) when a backup starts that the console did not start - a cron or
 * systemd timer schedule, or someone on a node - and opens its live view on the Backup & Restore page when clicked.
 * Also right after signing in, for one that is already running.
 */
const BackupWatch: FC = () => {
  const user = useSessionUser();
  const navigate = useNavigate();
  const allowed = !!user && can('backup.run', undefined, user);
  const q = useGetBackupActivityQuery({}, { skip: !allowed, pollingInterval: 30000 });

  useEffect(() => {
    const items = (q.data?.items ?? []).filter((a) => a.by !== 'console');
    if (!items.length) return;
    const s = seen();
    items
      .filter((a) => !s.has(a.key))
      .forEach((a) => {
        s.add(a.key);
        const open = () => {
          toast.dismiss(a.key);
          navigate(`${RouterPaths.backups.absolutePath}?${a.kind === 'clusters' ? 'cluster' : 'discovery'}=${a.id}&live=1`);
        };
        toast(<Popup a={a} onOpen={open} />, { toastId: a.key, autoClose: 20000, closeOnClick: false, icon: false });
      });
    remember(s);
  }, [q.data, navigate]);
  return null;
};

export default BackupWatch;
