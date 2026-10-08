import { FC } from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import logo from '@shared/assets/pgGeninIcon.png';

/**
 * JumboSQL: faint brand watermark on every page - logo, product name and the managing company.
 * It never takes clicks (pointer-events: none) and sits below the page content.
 *   fixed    - centred in the viewport (main layout)
 *   absolute - inside the parent (login panel); align='bottom' keeps it clear of the sign-in form
 */
const Watermark: FC<{ variant?: 'fixed' | 'absolute'; align?: 'center' | 'bottom' }> = ({
  variant = 'fixed',
  align = 'center',
}) => {
  const theme = useTheme();
  const isLight = theme.palette.mode === 'light';

  return (
    <Box
      aria-hidden
      data-testid="jumbosql-watermark"
      sx={{
        position: variant,
        inset: 0,
        // fixed (every page): above the page content so solid panels (tables, editors, charts) can't hide it,
        // below the app bar, sidebar, menus and dialogs; it never takes clicks
        zIndex: variant === 'fixed' ? 1050 : 0,
        pointerEvents: 'none',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: align === 'bottom' ? 'flex-end' : 'center',
        pb: align === 'bottom' ? '28px' : 0,
        gap: '6px',
        // keep the mark visually centred in the content area, right of the sidebar
        pl: variant === 'fixed' ? { xs: 0, md: '220px' } : 0,
        pt: variant === 'fixed' ? '56px' : 0,
      }}>
      <Box
        component="img"
        src={logo}
        alt=""
        data-logo="true"
        sx={{
          width: align === 'bottom' ? { xs: 72, md: 88 } : { xs: 220, md: 320 },
          height: 'auto',
          opacity: align === 'bottom' ? (isLight ? 0.18 : 0.2) : isLight ? 0.06 : 0.07,
          filter: isLight ? 'grayscale(15%)' : 'grayscale(30%) brightness(1.4)',
        }}
      />
      <Typography
        sx={{
          fontWeight: 800,
          fontSize: align === 'bottom' ? '1.4rem' : { xs: '2rem', md: '3rem' },
          letterSpacing: '-0.03em',
          color: 'text.primary',
          opacity: align === 'bottom' ? 0.18 : isLight ? 0.07 : 0.08,
          lineHeight: 1,
        }}>
        JumboSQL
      </Typography>
      <Typography
        sx={{
          fontWeight: 600,
          fontSize: { xs: '0.8rem', md: '0.95rem' },
          letterSpacing: '0.06em',
          color: 'text.primary',
          opacity: align === 'bottom' ? 0.35 : isLight ? 0.1 : 0.12,
        }}>
        Managed by Keen &amp; Able Computers Pvt. Ltd.
      </Typography>
    </Box>
  );
};

export default Watermark;
