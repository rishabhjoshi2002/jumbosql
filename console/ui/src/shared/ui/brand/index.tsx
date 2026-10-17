import { FC } from 'react';
import { Box, BoxProps } from '@mui/material';
import { BRAND } from '@shared/theme/theme.ts';

/** the product name as the logo writes it: a light "auto" and a bold gold "NOMIC" */
export const BrandName: FC<{ size?: number | string; light?: boolean } & Omit<BoxProps, 'children'>> = ({
  size = '1.1rem',
  light = true,
  sx,
  ...rest
}) => (
  <Box
    component="span"
    sx={{ fontSize: size, letterSpacing: '-0.01em', lineHeight: 1.1, whiteSpace: 'nowrap', ...sx }}
    {...rest}>
    <Box component="span" sx={{ fontWeight: 600, color: light ? BRAND.chromeText : 'text.primary' }}>
      auto
    </Box>
    <Box component="span" sx={{ fontWeight: 900, color: BRAND.gold, letterSpacing: '0.01em' }}>
      NOMIC
    </Box>
  </Box>
);

export default BrandName;
