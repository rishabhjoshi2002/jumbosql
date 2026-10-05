import { FC } from 'react';
import { Link } from 'react-router-dom';
import { ListItemButton, ListItemIcon, ListItemText } from '@mui/material';
import { SidebarItemProps } from '@entities/sidebar-item/model/types.ts';
import { BRAND } from '@shared/theme/theme.ts';

// JumboSQL: sidebar items sit on the dark navy chrome; the active page is a blue pill.
const SidebarItemContent: FC<SidebarItemProps> = ({
  path,
  label,
  icon: SidebarIcon,
  isActive,
  target,
  isCollapsed,
}) => (
  <ListItemButton
    sx={{
      gap: isCollapsed ? 0 : '12px',
      height: '44px',
      mx: '10px',
      my: '2px',
      px: isCollapsed ? 0 : '12px',
      borderRadius: '10px',
      justifyContent: isCollapsed ? 'center' : 'flex-start',
      color: isActive ? '#FFFFFF' : BRAND.chromeMuted,
      backgroundColor: isActive ? BRAND.blue : 'transparent',
      boxShadow: isActive ? '0 6px 16px rgba(29, 111, 224, 0.35)' : 'none',
      '&:hover': {
        backgroundColor: isActive ? BRAND.blue : 'rgba(255, 255, 255, 0.07)',
        color: '#FFFFFF',
      },
    }}
    to={path}
    target={target}
    component={Link}>
    <ListItemIcon
      sx={{
        minWidth: 0,
        width: '26px',
        margin: 0,
        display: 'flex',
        justifyContent: 'center',
        color: 'inherit',
        '& svg': { fill: 'currentColor !important', color: 'inherit', '& path': { fill: 'currentColor !important' } },
      }}>
      {SidebarIcon ? <SidebarIcon width="24px" height="24px" /> : null}
    </ListItemIcon>
    {!isCollapsed ? (
      <ListItemText
        primary={label}
        sx={{
          '& .MuiListItemText-primary': {
            color: 'inherit',
            fontWeight: isActive ? 700 : 500,
            fontSize: '0.92rem',
          },
        }}
      />
    ) : null}
  </ListItemButton>
);

export default SidebarItemContent;
