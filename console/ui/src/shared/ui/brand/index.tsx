import { FC } from 'react';
import { Box, BoxProps } from '@mui/material';
import { BRAND } from '@shared/theme/theme.ts';
import icon from '@shared/assets/keenpgIcon.png';
import logoLight from '@shared/assets/keenpgLogo.png';
import logoDark from '@shared/assets/keenpgLogoDark.png';

/** the KeenPG elephant (the logo without its name), for small places: header, favicon, watermark */
export const BrandMark: FC<{ size?: number; title?: string }> = ({ size = 32, title = BRAND.name }) => (
  <Box
    component="img"
    src={icon}
    alt={title}
    data-logo="true"
    sx={{ width: size, height: size, flexShrink: 0, display: 'block', objectFit: 'contain' }}
  />
);

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

/** the name as the logo writes it: "Keen" in navy (white on dark) and "PG" in the logo's blue-to-green */
export const BrandName: FC<{ size?: number | string; light?: boolean } & Omit<BoxProps, 'children'>> = ({
  size = '1.1rem',
  light = true,
  sx,
  ...rest
}) => (
  <Box
    component="span"
    sx={{ fontSize: size, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.1, whiteSpace: 'nowrap', ...sx }}
    {...rest}>
    <Box component="span" sx={{ color: light ? '#FFFFFF' : 'text.primary' }}>
      Keen
    </Box>
    <Box
      component="span"
      sx={{
        background: light
          ? `linear-gradient(90deg, #4D9BFF, ${BRAND.sky} 45%, #3BE08F)`
          : `linear-gradient(90deg, ${BRAND.blue}, ${BRAND.sky} 45%, ${BRAND.green})`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }}>
      PG
    </Box>
  </Box>
);

export default BrandName;
