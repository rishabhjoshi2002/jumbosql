import React, { FC, useEffect } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import logoIcon from '@shared/assets/pgGeninIcon.png';
import UserMenu from '@features/user-menu';
import { BRAND } from '@shared/theme/theme.ts';
import ThemeToggle from '@features/theme-toggle';
import { useGetProjectsQuery } from '@shared/api/api/projects.ts';
import { HEADER_HEIGHT } from '@shared/model/constants.ts';
import { OPEN_SIDEBAR_WIDTH } from '@widgets/sidebar/model/constants.ts';
import { setProject } from '@app/redux/slices/projectSlice/projectSlice.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { useAppDispatch, useAppSelector } from '@app/redux/store/hooks.ts';
import { useTranslation } from 'react-i18next';

const Header: FC = () => {
  const { t } = useTranslation('shared');
  const dispatch = useAppDispatch();
  const currentProject = useAppSelector(selectCurrentProject);

  const projects = useGetProjectsQuery({ limit: 999_999_999 });

  useEffect(() => {
    if (!currentProject && projects.data?.data) dispatch(setProject(String(projects.data?.data?.[0]?.id)));
  }, [projects.data?.data, dispatch, currentProject]);

  const handleProjectChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    dispatch(setProject(e.target.value));
  };

  return (
    <AppBar position="fixed" data-surface="chrome" sx={(theme) => ({ zIndex: theme.zIndex.drawer + 1 })} elevation={0}>
      <Toolbar sx={{ minHeight: `${HEADER_HEIGHT} !important`, paddingLeft: '0 !important' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" width="100%">
          <Stack direction="row" alignItems="center" gap="16px">
            <Stack
              direction="row"
              alignItems="center"
              gap="12px"
              width={OPEN_SIDEBAR_WIDTH}
              boxSizing="border-box"
              paddingLeft="16px">
              <Box
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: '10px',
                  backgroundColor: '#fff',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}>
                <img src={logoIcon} alt="JumboSQL" style={{ width: '32px', height: '32px' }} data-logo="true" />
              </Box>
              <Box sx={{ lineHeight: 1 }}>
                <Typography sx={{ color: BRAND.chromeText, fontWeight: 800, fontSize: '1.05rem', lineHeight: 1.15 }}>
                  JumboSQL
                </Typography>
                <Typography sx={{ color: BRAND.sky, fontSize: '0.74rem', fontWeight: 600, lineHeight: 1.2 }}>
                  {t('productLine')}
                </Typography>
              </Box>
            </Stack>
            <TextField
              sx={{
                minWidth: '140px',
                maxWidth: '180px',
                '& .MuiOutlinedInput-root': {
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  color: BRAND.chromeText,
                  '& fieldset': { borderColor: 'rgba(255,255,255,0.18)' },
                  '&:hover fieldset': { borderColor: BRAND.sky },
                },
                '& .MuiInputLabel-root': { color: BRAND.chromeMuted },
                '& .MuiSelect-select': { color: BRAND.chromeText },
              }}
              select
              size="small"
              value={currentProject}
              onChange={handleProjectChange}
              label={t('project')}>
              {projects.data?.data?.map((project) => (
                <MenuItem key={project.id} value={project.id}>
                  {project.name}
                </MenuItem>
              )) ?? []}
            </TextField>
          </Stack>
          <Stack direction="row" alignItems="center" gap="8px" pr="4px">
            <ThemeToggle />
            <UserMenu />
          </Stack>
        </Stack>
      </Toolbar>
    </AppBar>
  );
};

export default Header;
