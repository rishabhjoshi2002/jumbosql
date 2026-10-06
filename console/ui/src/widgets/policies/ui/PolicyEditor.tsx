import { FC, ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useTranslation } from 'react-i18next';
import { PermissionInfo, Policy } from '@shared/api/api/access.ts';
import { PERMISSION_GROUPS, tidyPolicy, WEEKDAYS } from '../lib/policyText.ts';

/** Chips input: type and press Enter (or pick a suggestion). */
const Chips: FC<{
  label: string;
  value?: string[];
  onChange: (v: string[]) => void;
  options?: string[];
  placeholder?: string;
  helper?: ReactNode;
}> = ({ label, value, onChange, options = [], placeholder, helper }) => (
  <Autocomplete
    multiple
    freeSolo
    size="small"
    options={options}
    value={value ?? []}
    onChange={(_, v) => onChange((v as string[]).map((x) => x.trim()).filter(Boolean))}
    renderValue={(vals, getItemProps) =>
      vals.map((option, index) => {
        const { key, ...rest } = getItemProps({ index });
        return <Chip key={key} size="small" label={option} {...rest} />;
      })
    }
    renderInput={(params) => (
      <TextField {...params} label={label} placeholder={value?.length ? '' : placeholder} helperText={helper} />
    )}
  />
);

const Section: FC<{ title: string; hint?: string; children: ReactNode }> = ({ title, hint, children }) => (
  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
    <Typography fontWeight={700} fontSize="0.95rem">
      {title}
    </Typography>
    {hint ? (
      <Typography variant="caption" color="text.secondary" component="div" mb={1.5}>
        {hint}
      </Typography>
    ) : (
      <Box mb={1.5} />
    )}
    <Stack gap={1.5}>{children}</Stack>
  </Box>
);

interface Props {
  open: boolean;
  initial: Policy;
  catalog: PermissionInfo[];
  users: string[];
  attributeKeys: Record<string, string[]>; // known attribute names -> known values
  environments: string[];
  projects: string[];
  clusters: string[];
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (p: Policy) => void;
}

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Kolkata', 'Europe/Berlin', 'America/New_York'];
  }
})();

const PolicyEditor: FC<Props> = ({
  open,
  initial,
  catalog,
  users,
  attributeKeys,
  environments,
  projects,
  clusters,
  saving,
  error,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation('settings');
  const [p, setP] = useState<Policy>(initial);
  const [view, setView] = useState<'form' | 'json'>('form');
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [attrRows, setAttrRows] = useState<{ key: string; values: string[] }[]>([]);

  useEffect(() => {
    if (!open) return;
    setP(initial);
    setView('form');
    setJsonError('');
    const rows = Object.entries(initial.subjects?.attributes ?? {}).map(([key, values]) => ({ key, values }));
    setAttrRows(rows.length ? rows : []);
  }, [open, initial]);

  // keep attributes in the policy in step with the rows
  useEffect(() => {
    setP((cur) => ({
      ...cur,
      subjects: {
        ...cur.subjects,
        attributes: Object.fromEntries(attrRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.values])),
      },
    }));
  }, [attrRows]);

  const describe = useMemo(() => Object.fromEntries(catalog.map((c) => [c.name, c])), [catalog]);
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const hasPerm = (perm: string) => p.permissions.includes(perm);
  const togglePerm = (perm: string) =>
    set('permissions', hasPerm(perm) ? p.permissions.filter((x) => x !== perm) : [...p.permissions, perm]);
  const sqlInvolved = p.permissions.some((x) => x.startsWith('sql.')) || p.effect === 'deny';
  const [from, to] = (p.conditions.hours ?? '').split('-');

  const switchView = (v: 'form' | 'json') => {
    if (v === 'json') {
      setJson(JSON.stringify(tidyPolicy(p), null, 2));
      setJsonError('');
    } else {
      try {
        const parsed = JSON.parse(json) as Policy;
        setP({ ...p, ...parsed });
        const rows = Object.entries(parsed.subjects?.attributes ?? {}).map(([key, values]) => ({ key, values }));
        setAttrRows(rows);
        setJsonError('');
      } catch (e) {
        setJsonError(String(e));
        return;
      }
    }
    setView(v);
  };

  const save = () => {
    if (view === 'json') {
      try {
        onSave(tidyPolicy({ ...p, ...(JSON.parse(json) as Policy) }));
      } catch (e) {
        setJsonError(String(e));
      }
      return;
    }
    onSave(tidyPolicy(p));
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper">
      <DialogTitle sx={{ pb: 0 }}>
        {initial.id ? t('editPolicy') : t('newPolicy')}
        <Tabs
          value={view}
          onChange={(_, v) => switchView(v)}
          sx={{ mt: 1, minHeight: 34, '& .MuiTab-root': { minHeight: 34 } }}>
          <Tab value="form" label={t('policyForm')} />
          <Tab value="json" label="JSON" />
        </Tabs>
      </DialogTitle>
      <DialogContent dividers>
        {view === 'json' ? (
          <Stack gap={1}>
            <TextField
              multiline
              minRows={20}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              slotProps={{ input: { sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 13 } } }}
            />
            {jsonError ? <Alert severity="error">{jsonError}</Alert> : null}
          </Stack>
        ) : (
          <Stack gap={2}>
            <Section title={t('policyBasics')}>
              <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap">
                <TextField
                  size="small"
                  label={t('policyName')}
                  value={p.name}
                  onChange={(e) => set('name', e.target.value)}
                  sx={{ flex: 1, minWidth: 240 }}
                  required
                />
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={p.effect}
                  onChange={(_, v) => v && set('effect', v)}
                  color={p.effect === 'deny' ? 'error' : 'success'}>
                  <ToggleButton value="allow">{t('effectAllow')}</ToggleButton>
                  <ToggleButton value="deny">{t('effectDeny')}</ToggleButton>
                </ToggleButtonGroup>
                <FormControlLabel
                  control={<Switch checked={p.enabled} onChange={(e) => set('enabled', e.target.checked)} />}
                  label={t('policyEnabled')}
                />
              </Stack>
              <TextField
                size="small"
                label={t('policyDescription')}
                value={p.description ?? ''}
                onChange={(e) => set('description', e.target.value)}
              />
              <Typography variant="caption" color="text.secondary">
                {p.effect === 'deny' ? t('denyHint') : t('allowHint')}
              </Typography>
            </Section>

            <Section title={t('policyWho')} hint={t('policyWhoHint')}>
              <FormControlLabel
                control={
                  <Switch
                    checked={!!p.subjects.everyone}
                    onChange={(e) => set('subjects', { ...p.subjects, everyone: e.target.checked })}
                  />
                }
                label={t('everyone')}
              />
              {!p.subjects.everyone ? (
                <>
                  <Chips
                    label={t('policyUsers')}
                    value={p.subjects.users}
                    options={users}
                    onChange={(v) => set('subjects', { ...p.subjects, users: v })}
                    placeholder="alice"
                  />
                  {attrRows.map((row, i) => (
                    <Stack key={i} direction="row" gap={1} alignItems="flex-start">
                      <Autocomplete
                        freeSolo
                        size="small"
                        options={Object.keys(attributeKeys)}
                        value={row.key}
                        onInputChange={(_, v) =>
                          setAttrRows((rows) => rows.map((r, j) => (j === i ? { ...r, key: v } : r)))
                        }
                        renderInput={(params) => <TextField {...params} label={t('attribute')} placeholder="team" />}
                        sx={{ width: 200 }}
                      />
                      <Typography sx={{ pt: 1 }}>=</Typography>
                      <Box flex={1}>
                        <Chips
                          label={t('anyOfValues')}
                          value={row.values}
                          options={attributeKeys[row.key] ?? []}
                          onChange={(v) =>
                            setAttrRows((rows) => rows.map((r, j) => (j === i ? { ...r, values: v } : r)))
                          }
                          placeholder="payments"
                        />
                      </Box>
                      <IconButton onClick={() => setAttrRows((rows) => rows.filter((_, j) => j !== i))}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  ))}
                  <Box>
                    <Button
                      size="small"
                      startIcon={<AddIcon />}
                      onClick={() => setAttrRows((rows) => [...rows, { key: '', values: [] }])}>
                      {t('addAttributeCondition')}
                    </Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    {t('attributesAndHint')}
                  </Typography>
                </>
              ) : null}
            </Section>

            <Section title={p.effect === 'deny' ? t('policyWhatDeny') : t('policyWhat')}>
              {PERMISSION_GROUPS.map((g) => (
                <Box key={g.label}>
                  <Typography variant="body2" fontWeight={700} mb={0.5}>
                    {g.label}
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" columnGap={2}>
                    {g.perms.map((perm) => (
                      <Tooltip key={perm} title={describe[perm]?.description ?? ''} placement="top-start">
                        <FormControlLabel
                          control={<Checkbox size="small" checked={hasPerm(perm)} onChange={() => togglePerm(perm)} />}
                          label={
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.8rem' }}>
                              {perm}
                            </Typography>
                          }
                        />
                      </Tooltip>
                    ))}
                  </Stack>
                </Box>
              ))}
            </Section>

            <Section title={t('policyWhere')} hint={t('policyWhereHint')}>
              <Chips
                label={t('clusterPatterns')}
                value={p.resources.clusters}
                options={clusters}
                onChange={(v) => set('resources', { ...p.resources, clusters: v })}
                placeholder="prod-*"
              />
              <Stack direction="row" gap={2}>
                <Box flex={1}>
                  <Chips
                    label={t('environments')}
                    value={p.resources.environments}
                    options={environments}
                    onChange={(v) => set('resources', { ...p.resources, environments: v })}
                  />
                </Box>
                <Box flex={1}>
                  <Chips
                    label={t('projects')}
                    value={p.resources.projects}
                    options={projects}
                    onChange={(v) => set('resources', { ...p.resources, projects: v })}
                  />
                </Box>
              </Stack>
            </Section>

            {sqlInvolved ? (
              <Section title={t('policyData')} hint={t('policyDataHint')}>
                <Stack direction="row" gap={2}>
                  <Box flex={1}>
                    <Chips
                      label={t('databases')}
                      value={p.data.databases}
                      onChange={(v) => set('data', { ...p.data, databases: v })}
                      placeholder="app*"
                    />
                  </Box>
                  <Box flex={1}>
                    <Chips
                      label={t('schemas')}
                      value={p.data.schemas}
                      onChange={(v) => set('data', { ...p.data, schemas: v })}
                      placeholder="public"
                    />
                  </Box>
                </Stack>
                <Chips
                  label={t('tables')}
                  value={p.data.tables}
                  onChange={(v) => set('data', { ...p.data, tables: v })}
                  placeholder="sales.orders, sales.*"
                  helper={t('tablesHelp')}
                />
                <Chips
                  label={t('hiddenColumns')}
                  value={p.data.hidden_columns}
                  onChange={(v) => set('data', { ...p.data, hidden_columns: v })}
                  placeholder="*.*.email, customers.card_no, ssn"
                  helper={t('hiddenColumnsHelp')}
                />
                <Stack direction="row" gap={2}>
                  <TextField
                    size="small"
                    type="number"
                    label={t('maxRows')}
                    value={p.data.max_rows ?? ''}
                    onChange={(e) => set('data', { ...p.data, max_rows: Number(e.target.value) || undefined })}
                    helperText={t('zeroNoLimit')}
                  />
                  <TextField
                    size="small"
                    type="number"
                    label={t('timeLimit')}
                    value={p.data.timeout_seconds ?? ''}
                    onChange={(e) => set('data', { ...p.data, timeout_seconds: Number(e.target.value) || undefined })}
                    helperText={t('seconds')}
                  />
                </Stack>
              </Section>
            ) : null}

            <Section title={t('policyWhen')} hint={t('policyWhenHint')}>
              <Chips
                label={t('ipRanges')}
                value={p.conditions.ip_ranges}
                onChange={(v) => set('conditions', { ...p.conditions, ip_ranges: v })}
                placeholder="10.0.0.0/8, 192.168.1.20"
              />
              <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap">
                <ToggleButtonGroup
                  size="small"
                  value={p.conditions.weekdays ?? []}
                  onChange={(_, v: number[]) => set('conditions', { ...p.conditions, weekdays: v })}>
                  {WEEKDAYS.map((d, i) => (
                    <ToggleButton key={d} value={i + 1} sx={{ px: 1.2 }}>
                      {d}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
                <TextField
                  size="small"
                  type="time"
                  label={t('from')}
                  value={from ?? ''}
                  onChange={(e) =>
                    set('conditions', {
                      ...p.conditions,
                      hours: e.target.value ? `${e.target.value}-${to || '23:59'}` : '',
                    })
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <TextField
                  size="small"
                  type="time"
                  label={t('until')}
                  value={to ?? ''}
                  onChange={(e) =>
                    set('conditions', {
                      ...p.conditions,
                      hours: e.target.value ? `${from || '00:00'}-${e.target.value}` : '',
                    })
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <Autocomplete
                  size="small"
                  options={TIMEZONES}
                  value={p.conditions.timezone ?? null}
                  onChange={(_, v) => set('conditions', { ...p.conditions, timezone: v ?? undefined })}
                  renderInput={(params) => <TextField {...params} label={t('timezone')} />}
                  sx={{ minWidth: 220 }}
                />
              </Stack>
            </Section>
          </Stack>
        )}
        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel', { ns: 'shared' })}</Button>
        <Button variant="contained" onClick={save} disabled={saving || (view === 'form' && !p.name.trim())}>
          {t('save', { ns: 'shared' })}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default PolicyEditor;
