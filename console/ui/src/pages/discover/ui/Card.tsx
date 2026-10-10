import { FC, ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';

/** A bordered section with a title. */
export const Card: FC<{ title?: string; subtitle?: string; children: ReactNode; action?: ReactNode }> = ({
  title,
  subtitle,
  children,
  action,
}) => (
  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, bgcolor: 'background.paper', minWidth: 0 }}>
    {title ? (
      <Stack direction="row" alignItems="flex-start" gap={1} mb={1.25}>
        <Box flex={1}>
          <Typography fontWeight={700}>{title}</Typography>
          {subtitle ? (
            <Typography variant="caption" color="text.secondary">
              {subtitle}
            </Typography>
          ) : null}
        </Box>
        {action}
      </Stack>
    ) : null}
    {children}
  </Box>
);

export default Card;
