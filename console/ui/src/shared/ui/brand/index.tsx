import { FC } from 'react';
import { Box, BoxProps } from '@mui/material';
import { BRAND } from '@shared/theme/theme.ts';

/**
 * The autoNOMIC mark, drawn (not a picture), so it stays sharp at any size: the dial of the logo - a gold arc and a
 * blue arc on a navy disc - with the atmos prompt ">_" in the middle.
 */
export const BrandMark: FC<{ size?: number; title?: string }> = ({ size = 32, title = BRAND.name }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    role="img"
    aria-label={title}
    data-logo="true"
    style={{ flexShrink: 0, display: 'block' }}>
    <circle cx="32" cy="32" r="30.5" fill="#102A5C" stroke="rgba(255,255,255,0.55)" strokeWidth="2" />
    <circle cx="32" cy="32" r="25" fill="none" stroke="#1D3B78" strokeWidth="4" />
    <path d="M32 7 A25 25 0 1 1 9.2 42.2" fill="none" stroke={BRAND.gold} strokeWidth="4" strokeLinecap="round" />
    <path
      d="M9.2 42.2 A25 25 0 0 1 32 7"
      fill="none"
      stroke={BRAND.sky}
      strokeWidth="4"
      strokeLinecap="round"
      opacity="0.9"
    />
    <path
      d="M20 23 L29 32 L20 41"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="4.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect x="32" y="37.5" width="13" height="4.5" rx="1.5" fill={BRAND.gold} />
  </svg>
);

/** the product name as the logo writes it: "auto" and a bold gold "NOMIC" */
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
    <Box component="span" sx={{ fontWeight: 800, color: light ? BRAND.gold : BRAND.goldDeep }}>
      NOMIC
    </Box>
  </Box>
);

export default BrandName;
