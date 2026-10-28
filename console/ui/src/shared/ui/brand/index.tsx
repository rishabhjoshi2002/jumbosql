import { FC } from 'react';
import { Box, BoxProps } from '@mui/material';
import { BRAND } from '@shared/theme/theme.ts';
import { useTheme } from '@mui/material';
import icon from '@shared/assets/keenpgIcon.png';
import iconDark from '@shared/assets/keenpgIconDark.png';
import logoLight from '@shared/assets/keenpgLogo.png';
import logoDark from '@shared/assets/keenpgLogoDark.png';

/** the KeenPG elephant (the logo without its name), for small places: header, favicon, watermark */
export const BrandMark: FC<{ size?: number; title?: string; onDark?: boolean }> = ({
  size = 32,
  title = BRAND.name,
  onDark,
}) => {
  const dark = useTheme().palette.mode === 'dark';
  return (
  <Box
    component="img"
    src={onDark ?? dark ? iconDark : icon}
    alt={title}
    data-logo="true"
    sx={{ width: size, height: size, flexShrink: 0, display: 'block', objectFit: 'contain' }}
  />
  );
};

/** the full KeenPG logo with its name and tagline; onDark uses the version with light letters */
export const BrandLogo: FC<{ width?: number | string; onDark?: boolean } & Omit<BoxProps, 'children'>> = ({
  width = 240,
  onDark,
  sx,
  ...rest
}) => (
  <Box
    component="img"
    src={onDark ? logoDark : logoLight}
    alt={`${BRAND.name} - ${BRAND.tagline}`}
    data-logo="true"
    sx={{ width, height: 'auto', display: 'block', ...sx }}
    {...rest}
  />
);

/** the name as the logo writes it: "keen" in the heron's orange and "PG" in deep indigo (light lavender on dark) */
export const BrandName: FC<{ size?: number | string; light?: boolean } & Omit<BoxProps, 'children'>> = ({
  size = '1.1rem',
  light,
  sx,
  ...rest
}) => (
  <Box
    component="span"
    sx={{ fontSize: size, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.1, whiteSpace: 'nowrap', ...sx }}
    {...rest}>
    <Box component="span" sx={{ color: BRAND.orange }}>
      keen
    </Box>
    <Box
      component="span"
      sx={(theme) => ({ color: light || theme.palette.mode === 'dark' ? '#ECE9FF' : BRAND.ink })}>
      PG
    </Box>
  </Box>
);

export default BrandName;
