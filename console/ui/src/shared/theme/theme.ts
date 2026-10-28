import { createTheme, PaletteMode } from '@mui/material';
import { enUS } from '@mui/material/locale';

declare module '@mui/material/styles' {
  interface PaletteColor {
    lighter10?: string;
  }

  interface SimplePaletteColorOptions {
    lighter10?: string;
  }
}

/**
 * KeenPG design tokens, taken from the logo: deep indigo (the elephant and "PG"), a violet primary for actions and
 * the active page, and the heron's orange as the accent ("keen"). Header and sidebar are light surfaces that follow
 * the light/dark mode, like the content.
 */
export const BRAND = Object.freeze({
  name: 'KeenPG',
  tagline: 'A Keen Eye on Your Postgres',
  ink: '#261C51',
  inkSoft: '#3A2F73',
  violet: '#4B3AC4',
  violetHover: '#3C2DA6',
  violetLight: '#8C7CFF',
  orange: '#F5A10F',
  orangeDeep: '#D9870A',
  // older names, kept so every page picks up the new colours
  navy900: '#1A1338',
  navy800: '#221A47',
  navy700: '#2C2259',
  blue: '#4B3AC4',
  blueHover: '#3C2DA6',
  sky: '#F5A10F',
  green: '#22A36A',
  greenDeep: '#178A55',
  chromeText: '#ECE9FF',
  chromeMuted: 'rgba(236, 233, 255, 0.66)',
  fontSans: '"Plus Jakarta Sans", "Segoe UI", system-ui, -apple-system, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
});

export const createAppTheme = (mode: PaletteMode) => {
  const isLight = mode === 'light';

  const t = {
    bg: isLight ? '#F5F4FB' : '#0F0D1E',
    paper: isLight ? '#FFFFFF' : '#17142B',
    paperRaised: isLight ? '#FFFFFF' : '#1D1935',
    subtle: isLight ? '#F7F6FC' : '#1B1832',
    border: isLight ? '#E7E4F3' : '#2A2549',
    borderStrong: isLight ? '#D3CEE8' : '#3A3463',
    text: isLight ? '#1E1745' : '#ECE9FF',
    textMuted: isLight ? '#5E5880' : '#ABA5CC',
    hover: isLight ? '#F1EFFA' : '#221E3D',
    primary: isLight ? BRAND.violet : BRAND.violetLight,
    danger: isLight ? '#D93636' : '#F06464',
  };

  return createTheme(
    {
      palette: {
        mode,
        primary: {
          main: t.primary,
          dark: BRAND.violetHover,
          lighter10: isLight ? 'rgba(75, 58, 196, 0.10)' : 'rgba(140, 124, 255, 0.16)',
        },
        secondary: { main: BRAND.orange, contrastText: '#1E1745' },
        success: { main: isLight ? BRAND.greenDeep : BRAND.green },
        error: { main: t.danger },
        background: { default: t.bg, paper: t.paper },
        text: { primary: t.text, secondary: t.textMuted },
        divider: t.border,
        action: { hover: t.hover },
      },
      shape: { borderRadius: 10 },
      typography: {
        fontFamily: BRAND.fontSans,
        h4: { fontWeight: 800, letterSpacing: '-0.02em' },
        h5: { fontWeight: 800, letterSpacing: '-0.015em' },
        h6: { fontWeight: 700, letterSpacing: '-0.01em' },
        subtitle1: { fontWeight: 600 },
        button: { fontWeight: 600, letterSpacing: 0 },
        caption: { letterSpacing: 0 },
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            body: { backgroundColor: t.bg },
            'code, pre, kbd': { fontFamily: BRAND.fontMono },
            '*': {
              transition: 'color 0.15s ease-in-out, border-color 0.15s ease-in-out',
            },
            // Default icon colour for MUI icons; custom SVGs (logos, cloud icons) are left alone
            'svg.MuiSvgIcon-root': {
              fill: `${t.text} !important`,
              color: `${t.text} !important`,
              '& path, & circle, & rect, & polygon': { fill: `${t.text} !important` },
            },
            // Status icons (color="error" | "warning" | "success" | "info") keep their meaning
            ...Object.fromEntries(
              (
                [
                  ['Error', t.danger],
                  ['Warning', isLight ? '#ed6c02' : '#ffa726'],
                  ['Success', isLight ? '#2e7d32' : '#66bb6a'],
                  ['Info', isLight ? '#0288d1' : '#29b6f6'],
                ] as const
              ).map(([k, c]) => [
                `svg.MuiSvgIcon-color${k}, svg.MuiSvgIcon-color${k} path`,
                { fill: `${c} !important`, color: `${c} !important` },
              ]),
            ),
            '[data-logo="true"]': {
              fill: 'unset !important',
              color: 'unset !important',
            },
            '.logo, .logo *': { fill: 'unset !important', color: 'unset !important' },
            // white icons on the gradient chips (home page)
            '.kp-chip svg.MuiSvgIcon-root, .kp-chip svg.MuiSvgIcon-root path': {
              fill: '#FFFFFF !important',
              color: '#FFFFFF !important',
            },
            // Primary-coloured icons (e.g. inside contained buttons) keep their colour
            '.MuiButton-contained svg.MuiSvgIcon-root, .MuiButton-contained svg.MuiSvgIcon-root path': {
              fill: '#FFFFFF !important',
              color: '#FFFFFF !important',
            },
          },
        },
        MuiAppBar: {
          styleOverrides: {
            colorPrimary: {
              background: t.paper,
              borderBottom: `1px solid ${t.border}`,
              color: t.text,
              boxShadow: 'none',
            },
          },
        },
        MuiDrawer: {
          styleOverrides: {
            paper: {
              backgroundColor: t.paper,
              borderRight: `1px solid ${t.border}`,
              color: t.text,
            },
          },
        },
        MuiTextField: {
          styleOverrides: {
            root: {
              '& .MuiOutlinedInput-root': {
                backgroundColor: t.paper,
                borderRadius: '10px',
                '& fieldset': { borderColor: t.borderStrong },
                '&:hover fieldset': { borderColor: t.primary },
                '&.Mui-focused fieldset': { borderColor: t.primary, borderWidth: '2px' },
                '&.Mui-error fieldset': { borderColor: t.danger },
                '& input': { color: t.text },
              },
              '& .MuiInputLabel-root': {
                color: t.textMuted,
                '&.Mui-focused': { color: t.primary },
                '&.Mui-error': { color: t.danger },
              },
              '& .MuiFormHelperText-root': {
                fontSize: '0.75rem',
                '&.Mui-error': { color: t.danger },
              },
            },
          },
        },
        MuiPaper: {
          styleOverrides: {
            root: {
              backgroundColor: t.paper,
              backgroundImage: 'none',
              borderColor: t.border,
              boxShadow: isLight
                ? '0 1px 2px rgba(38, 28, 81, 0.05), 0 0 0 1px rgba(38, 28, 81, 0.05)'
                : '0 0 0 1px rgba(255, 255, 255, 0.05), 0 6px 20px rgba(0, 0, 0, 0.25)',
            },
          },
        },
        MuiCard: {
          styleOverrides: {
            root: { borderRadius: '14px' },
          },
        },
        MuiMenu: {
          styleOverrides: {
            paper: {
              backgroundColor: t.paperRaised,
              border: `1px solid ${t.border}`,
              borderRadius: '12px',
              boxShadow: '0 12px 32px rgba(38, 28, 81, 0.18)',
            },
          },
        },
        MuiMenuItem: {
          styleOverrides: {
            root: {
              color: t.text,
              borderRadius: '8px',
              margin: '2px 6px',
              '&:hover': { backgroundColor: t.hover },
              '&.Mui-selected': {
                backgroundColor: isLight ? 'rgba(75,58,196,0.10)' : 'rgba(140,124,255,0.18)',
                '&:hover': { backgroundColor: isLight ? 'rgba(75,58,196,0.16)' : 'rgba(140,124,255,0.26)' },
              },
            },
          },
        },
        MuiListItemButton: {
          styleOverrides: {
            root: { color: t.text, '&:hover': { backgroundColor: t.hover } },
          },
        },
        MuiListItemText: {
          styleOverrides: {
            primary: { color: t.text },
          },
        },
        MuiListItemIcon: {
          styleOverrides: {
            root: {
              color: t.text,
              '& svg': { fill: `${t.text} !important`, '& path': { fill: `${t.text} !important` } },
            },
          },
        },
        MuiIconButton: {
          styleOverrides: {
            root: {
              color: t.text,
              '&:hover': { backgroundColor: t.hover },
              '& svg': { fill: t.text },
            },
          },
        },
        MuiTable: {
          styleOverrides: {
            root: {
              backgroundColor: t.paper,
              '& .MuiTableHead-root': { backgroundColor: t.subtle },
              '& .MuiTableCell-root': { borderBottomColor: t.border, color: t.text },
              '& .MuiTableCell-head': {
                backgroundColor: t.subtle,
                color: t.textMuted,
                fontWeight: 700,
                fontSize: '0.78rem',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              },
            },
          },
        },
        MuiTableContainer: {
          styleOverrides: {
            root: {
              backgroundColor: t.paper,
              border: `1px solid ${t.border}`,
              borderRadius: '12px',
            },
          },
        },
        MuiToolbar: {
          styleOverrides: {
            root: { backgroundColor: 'transparent', color: 'inherit' },
          },
        },
        MuiButton: {
          defaultProps: { disableElevation: true },
          styleOverrides: {
            root: {
              textTransform: 'none',
              borderRadius: '10px',
              '&:focus-visible': { outline: `2px solid ${t.primary}`, outlineOffset: '2px' },
            },
            contained: {
              '&:hover': { backgroundColor: isLight ? BRAND.violetHover : '#7A69F5' },
            },
            containedPrimary: {
              backgroundImage: isLight
                ? `linear-gradient(180deg, #5645D3 0%, ${BRAND.violet} 100%)`
                : 'linear-gradient(180deg, #9A8BFF 0%, #8070FA 100%)',
              boxShadow: isLight ? '0 4px 12px rgba(75, 58, 196, 0.28)' : 'none',
              color: isLight ? '#FFFFFF' : '#14102B',
              '&.Mui-disabled': { backgroundImage: 'none', boxShadow: 'none' },
            },
            outlined: {
              borderColor: t.borderStrong,
              color: t.text,
              '&:hover': { borderColor: t.primary, backgroundColor: t.hover },
            },
          },
        },
        MuiTabs: {
          styleOverrides: {
            indicator: { height: '3px', borderRadius: '3px 3px 0 0' },
          },
        },
        MuiTab: {
          styleOverrides: {
            root: { textTransform: 'none', fontWeight: 600, fontSize: '0.92rem' },
          },
        },
        MuiChip: {
          styleOverrides: {
            // neutral chips get the brand surface; coloured ones (success / warning / error …) keep their colour
            root: ({ ownerState }: { ownerState: { color?: string } }) =>
              !ownerState.color || ownerState.color === 'default'
                ? { backgroundColor: t.subtle, color: t.text, fontWeight: 600 }
                : { fontWeight: 600 },
          },
        },
        MuiTooltip: {
          styleOverrides: {
            tooltip: {
              backgroundColor: BRAND.ink,
              color: '#FFFFFF',
              fontSize: '0.78rem',
              borderRadius: '8px',
            },
          },
        },
        MuiDialog: {
          styleOverrides: {
            paper: { backgroundColor: t.paperRaised, color: t.text, borderRadius: '16px' },
          },
        },
        MuiDialogTitle: {
          styleOverrides: {
            root: { color: t.text, fontWeight: 700 },
          },
        },
        MuiDialogContent: {
          styleOverrides: {
            root: { color: t.text },
          },
        },
        MuiAlert: {
          styleOverrides: {
            root: { borderRadius: '10px' },
          },
        },
        MuiLinearProgress: {
          styleOverrides: {
            root: {
              backgroundColor: t.border,
              '& .MuiLinearProgress-bar': { backgroundColor: t.primary },
            },
          },
        },
        MuiSkeleton: {
          styleOverrides: {
            root: { backgroundColor: t.subtle },
          },
        },
        MuiAccordion: {
          styleOverrides: {
            root: {
              backgroundColor: t.paper,
              border: `1px solid ${t.border}`,
              borderRadius: '12px !important',
              boxShadow: 'none',
              '&:before': { display: 'none' },
              '&.Mui-expanded': { margin: '0' },
            },
          },
        },
        MuiAccordionSummary: {
          styleOverrides: {
            root: {
              backgroundColor: t.subtle,
              borderBottom: `1px solid ${t.border}`,
              minHeight: '56px',
              '&.Mui-expanded': { minHeight: '56px' },
              '& .MuiAccordionSummary-content': {
                margin: '12px 0',
                '&.Mui-expanded': { margin: '12px 0' },
              },
            },
          },
        },
        MuiAccordionDetails: {
          styleOverrides: {
            root: { backgroundColor: t.paper, padding: '16px' },
          },
        },
      },
    },
    enUS,
  );
};

// Default light theme for backward compatibility
const theme = createAppTheme('light');

export default theme;
