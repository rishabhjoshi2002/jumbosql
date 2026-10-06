import { FC } from 'react';
import { Box, Chip, Divider, Stack, Tooltip, Typography } from '@mui/material';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import { useTranslation } from 'react-i18next';
import { SQLProfile } from '@shared/api/api/access.ts';

const Row: FC<{ label: string; value: string }> = ({ label, value }) => (
  <Stack direction="row" gap={1}>
    <Typography variant="caption" sx={{ minWidth: 104, opacity: 0.75 }}>
      {label}
    </Typography>
    <Typography variant="caption" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
      {value}
    </Typography>
  </Stack>
);

/** What the user's access policies allow in the SQL editor here; details in the tooltip. */
const AccessBadge: FC<{ profile: SQLProfile; database: string }> = ({ profile, database }) => {
  const { t } = useTranslation('shared');
  const restricted =
    !!profile.schemas?.length ||
    !!profile.tables?.length ||
    !!profile.hidden_columns?.length ||
    !!profile.databases?.length;
  const label =
    profile.level === 'admin'
      ? t('sqlLevelAdmin')
      : profile.level === 'write'
        ? t('sqlLevelWrite')
        : profile.level === 'read'
          ? t('sqlLevelRead')
          : t('sqlLevelNone');
  const all = t('sqlScopeAll');
  return (
    <Tooltip
      arrow
      title={
        <Box sx={{ p: 0.5, maxWidth: 380 }}>
          <Typography variant="body2" fontWeight={700} mb={0.5}>
            {t('sqlAccessTitle', { database })}
          </Typography>
          <Row label={t('sqlAccessLevel')} value={label} />
          <Row label={t('sqlAccessDatabases')} value={profile.databases?.length ? profile.databases.join(', ') : all} />
          <Row label={t('sqlAccessSchemas')} value={profile.schemas?.length ? profile.schemas.join(', ') : all} />
          <Row label={t('sqlAccessTables')} value={profile.tables?.length ? profile.tables.join(', ') : all} />
          {profile.hidden_columns?.length ? (
            <Row label={t('sqlAccessHidden')} value={profile.hidden_columns.join(', ')} />
          ) : null}
          <Row
            label={t('sqlAccessLimits')}
            value={
              [
                profile.max_rows ? t('sqlAccessMaxRows', { count: profile.max_rows }) : '',
                profile.timeout_seconds ? `${profile.timeout_seconds}s` : '',
              ]
                .filter(Boolean)
                .join(' · ') || '—'
            }
          />
          <Row label={t('sqlAccessStats')} value={profile.stats ? t('yes') : t('no')} />
          {profile.policies?.length ? (
            <>
              <Divider sx={{ my: 0.75, borderColor: 'rgba(255,255,255,0.2)' }} />
              <Row label={t('sqlAccessPolicies')} value={profile.policies.join(', ')} />
            </>
          ) : null}
          {profile.note ? (
            <Typography variant="caption" component="div" mt={0.75} sx={{ opacity: 0.85 }}>
              {profile.note}
            </Typography>
          ) : null}
        </Box>
      }>
      <Chip
        size="small"
        icon={<ShieldOutlinedIcon />}
        color={
          profile.level === 'admin'
            ? 'warning'
            : profile.level === 'write'
              ? 'primary'
              : profile.level === 'read'
                ? 'info'
                : 'default'
        }
        variant={restricted ? 'outlined' : 'filled'}
        label={restricted ? `${label} · ${t('sqlScoped')}` : label}
        data-testid="sql-access-badge"
      />
    </Tooltip>
  );
};

export default AccessBadge;
