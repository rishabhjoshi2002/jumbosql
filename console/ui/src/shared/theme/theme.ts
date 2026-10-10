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
 * pg_genie design tokens. Colours come from the logo: navy outline (chrome), elephant blue (primary),
 * sky highlight (accent). The header and sidebar are always dark ("chrome"); the content area follows
 * the light/dark mode.
 */
export const BRAND = Object.freeze({
  navy900: '#071430',
  navy800: '#0B1D3F',
  navy700: '#11295A',
  blue: '#1D6FE0',
  blueHover: '#165BBE',
  sky: '#38B2F5',
  chromeText: '#E6EDF8',
  chromeMuted: 'rgba(230, 237, 248, 0.64)',
  fontSans: '"Plus Jakarta Sans", "Segoe UI", system-ui, -apple-system, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
});

export const createAppTheme = (mode: PaletteMode) => {
  const isLight = mode === 'light';

  const t = {
    bg: isLight ? '#F3F6FB' : '#0A1120',
    paper: isLight ? '#FFFFFF' : '#111B2E',
    paperRaised: isLight ? '#FFFFFF' : '#16223A',
    subtle: isLight ? '#F6F8FC' : '#152038',
    border: isLight ? '#E2E8F1' : '#22314F',
    borderStrong: isLight ? '#CCD6E4' : '#2E4067',
    text: isLight ? '#13233F' : '#E3EAF5',
    textMuted: isLight ? '#55657E' : '#9AABC6',
    hover: isLight ? '#EEF3FB' : '#1A2742',
    primary: isLight ? BRAND.blue : '#4C8FF0',
    danger: isLight ? '#D93636' : '#F06464',
  };

  return createTheme(
    {
      palette: {
        mode,
        primary: {
          main: t.primary,
          dark: BRAND.blueHover,
          lighter10: isLight ? 'rgba(29, 111, 224, 0.10)' : 'rgba(76, 143, 240, 0.16)',
        },
        secondary: { main: BRAND.sky },
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
            // Header and sidebar are dark in both modes: light icons and text there
            '[data-surface="chrome"] svg.MuiSvgIcon-root, [data-surface="chrome"] svg.MuiSvgIcon-root path': {
              fill: `${BRAND.chromeText} !important`,
              color: `${BRAND.chromeText} !important`,
            },
            '[data-surface="chrome"] .MuiIconButton-root:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.10)',
            },
            '[data-logo="true"]': {
              fill: 'unset !important',
              color: 'unset !important',
            },
            '.logo, .logo *': { fill: 'unset !important', color: 'unset !important' },
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
              background: `linear-gradient(90deg, ${BRAND.navy900} 0%, ${BRAND.navy800} 55%, ${BRAND.navy700} 100%)`,
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              color: BRAND.chromeText,
              boxShadow: '0 1px 0 rgba(7, 20, 48, 0.4)',
            },
          },
        },
        MuiDrawer: {
          styleOverrides: {
            paper: {
              backgroundColor: BRAND.navy800,
              borderRight: 'none',
              color: BRAND.chromeText,
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
                ? '0 1px 2px rgba(16, 35, 72, 0.06), 0 0 0 1px rgba(16, 35, 72, 0.05)'
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
              boxShadow: '0 12px 32px rgba(7, 20, 48, 0.18)',
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
                backgroundColor: isLight ? 'rgba(29,111,224,0.10)' : 'rgba(76,143,240,0.18)',
                '&:hover': { backgroundColor: isLight ? 'rgba(29,111,224,0.16)' : 'rgba(76,143,240,0.26)' },
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
              '&:hover': { backgroundColor: BRAND.blueHover },
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
              backgroundColor: BRAND.navy800,
              color: BRAND.chromeText,
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
