import { FC, ReactNode } from 'react';
import { Alert, Box } from '@mui/material';
import LockPersonOutlinedIcon from '@mui/icons-material/LockPersonOutlined';
import { useTranslation } from 'react-i18next';
import { canAny } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';

/**
 * pg_genie: shows the page only when the signed-in user holds one of the permissions (anywhere).
 * The API refuses the requests anyway; this replaces a page full of errors with one clear message.
 */
const RequirePermission: FC<{ perms: string[]; children: ReactNode }> = ({ perms, children }) => {
  const { t } = useTranslation('shared');
  const user = useSessionUser();
  if (canAny(perms, undefined, user)) return <>{children}</>;
  return (
    <Box p={3}>
      <Alert severity="info" icon={<LockPersonOutlinedIcon />} sx={{ maxWidth: 720 }}>
        {t('noPermissionForPage', { perms: perms.join(' / ') })}
      </Alert>
    </Box>
  );
};

export default RequirePermission;
