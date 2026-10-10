import { FC, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { ApiUser, usePatchUsersByIdMutation } from '@shared/api/api/auth.ts';
import { SessionUser } from '@shared/lib/session.ts';
import { sidebarData } from '@widgets/sidebar/model/constants.ts';
import { availableCards, chosenCards, defaultCards, HomeCardId, safeStartPage } from '../model/cards.ts';

/**
 * pg_genie: an admin sets a user's home page (Settings -> Users): which cards, their order and the start page.
 * Only cards and pages that user's own access allows are offered.
 */
const HomeEditor: FC<{ user: ApiUser | null; onClose: () => void }> = ({ user, onClose }) => {
  const { t } = useTranslation(['shared', 'clusters', 'operations', 'settings', 'insights']);
  const [patch, { isLoading }] = usePatchUsersByIdMutation();
  // the target user's access, not the admin's
  const target: SessionUser | null = useMemo(
    () =>
      user
        ? {
            username: user.username,
            permissions: { global: user.permissions?.global ?? [], clusters: user.permissions?.clusters ?? {} },
          }
        : null,
    [user],
  );
  const avail = availableCards(target);
  const pages = sidebarData(t, target);
  const [list, setList] = useState<{ id: HomeCardId; on: boolean }[]>([]);
  const [start, setStart] = useState('/home');
  const fill = (cards: HomeCardId[], startPage?: string) => {
    setList([
      ...cards.map((id) => ({ id, on: true })),
      ...avail.filter((id) => !cards.includes(id)).map((id) => ({ id, on: false })),
    ]);
    setStart(safeStartPage(startPage));
  };
  useEffect(() => {
    if (user) fill(chosenCards(user.preferences, target), user.preferences?.home?.start_page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);
  const move = (i: number, d: number) =>
    setList((l) => {
      const n = [...l];
      const j = i + d;
      if (j < 0 || j >= n.length) return l;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const save = async () => {
    if (!user) return;
    try {
      await patch({
        id: user.id,
        home: { cards: list.filter((c) => c.on).map((c) => c.id), start_page: start },
      }).unwrap();
      toast.success(t('homeSaved'));
      onClose();
    } catch {
      toast.error(t('homeSaveFailed'));
    }
  };
  return (
    <Dialog open={!!user} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('homeCustomizeFor', { name: user?.display_name || user?.username })}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" mb={1.5}>
          {t('homeCustomizeHelp')}
        </Typography>
        <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
          {list.map((c, i) => (
            <Stack key={c.id} direction="row" alignItems="center" gap={1} py={0.25}>
              <Switch
                checked={c.on}
                onChange={(e) => setList((l) => l.map((x) => (x.id === c.id ? { ...x, on: e.target.checked } : x)))}
              />
              <Box flex={1}>
                <Typography variant="body2" fontWeight={600}>
                  {t(`home_${c.id}`)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t(`home_${c.id}_help`)}
                </Typography>
              </Box>
              <IconButton size="small" onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
              <IconButton size="small" onClick={() => move(i, 1)} disabled={i === list.length - 1}>
                <ArrowDownwardIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
        <TextField
          select
          fullWidth
          size="small"
          label={t('homeStartPage')}
          helperText={t('homeStartPageHelp')}
          value={pages.some((p) => p.path === start) ? start : '/home'}
          onChange={(e) => setStart(e.target.value)}
          sx={{ mt: 2.5 }}>
          {pages.map((p) => (
            <MenuItem key={p.path} value={p.path}>
              {p.label}
            </MenuItem>
          ))}
        </TextField>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => fill(defaultCards(target))}>{t('homeReset')}</Button>
        <Box flex={1} />
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button variant="contained" disabled={isLoading} onClick={() => void save()}>
          {t('save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default HomeEditor;
