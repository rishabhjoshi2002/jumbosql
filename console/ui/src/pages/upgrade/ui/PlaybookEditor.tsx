import { FC, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import UploadIcon from '@mui/icons-material/UploadFile';
import GitHubIcon from '@mui/icons-material/GitHub';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  PGroup,
  Playbook,
  PlaybookRequest,
  PVariable,
  PVarType,
  usePostPlaybookMutation,
  usePutPlaybookMutation,
} from '@shared/api/api/playbooks.ts';
import { EXAMPLE } from '../lib/playbookExample.ts';

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 };
const TYPES: PVarType[] = ['text', 'password', 'number', 'boolean', 'select', 'textarea'];
/** machines a group can be filled with (components Discover finds) */
export const FROM = [
  'all',
  'postgres',
  'patroni',
  'etcd',
  'haproxy',
  'keepalived',
  'pgbouncer',
  'pgbackrest',
  'vip-manager',
  'nginx',
  'consul',
  'repmgr',
  'prometheus',
  'grafana',
  'alertmanager',
  'node_exporter',
  'postgres_exporter',
];

type Src = 'text' | 'archive';
type Form = {
  name: string;
  description: string;
  playbook: string;
  playbook_path: string;
  rollback: string;
  rollback_path: string;
  requirements: string;
};

const toBase64 = (f: File) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',', 2)[1] ?? '');
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });

/** Add / change a custom playbook: the upgrade playbook, its rollback, files, and the inputs asked at each run. */
export type AddMode = 'text' | 'archive' | 'github';

const PlaybookEditor: FC<{
  open: boolean;
  edit?: Playbook | null;
  mode?: AddMode;
  onClose: (saved?: Playbook) => void;
}> = ({ open, edit, mode = 'text', onClose }) => {
  const { t } = useTranslation('upgrade');
  const [form, setForm] = useState<Form>({
    name: '',
    description: '',
    playbook: '',
    playbook_path: '',
    rollback: '',
    rollback_path: '',
    requirements: '',
  });
  const [src, setSrc] = useState<{ up: Src; rb: Src }>({ up: 'text', rb: 'text' });
  const [vars, setVars] = useState<PVariable[]>([]);
  const [groups, setGroups] = useState<PGroup[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [keepFile, setKeepFile] = useState(true);
  // where the files come from: an uploaded archive or a GitHub repository
  const [filesFrom, setFilesFrom] = useState<'upload' | 'github'>('upload');
  const [git, setGit] = useState({ url: '', ref: '', token: '', pull: false });
  const [add, adding] = usePostPlaybookMutation();
  const [put, putting] = usePutPlaybookMutation();

  useEffect(() => {
    if (!open) return;
    setForm({
      name: edit?.name ?? '',
      description: edit?.description ?? '',
      playbook: edit?.playbook ?? '',
      playbook_path: edit?.playbook_path ?? '',
      rollback: edit?.rollback ?? '',
      rollback_path: edit?.rollback_path ?? '',
      requirements: edit?.requirements ?? '',
    });
    // a new playbook starts the way it was chosen in the Add Playbook menu
    const fromFiles = !edit && mode !== 'text';
    setSrc({
      up: edit?.playbook_path || fromFiles ? 'archive' : 'text',
      rb: edit?.rollback_path || fromFiles ? 'archive' : 'text',
    });
    setVars(edit?.variables ?? []);
    setGroups(edit?.groups ?? []);
    setFile(null);
    setKeepFile(true);
    setFilesFrom(edit?.git_url || (!edit && mode === 'github') ? 'github' : 'upload');
    setGit({ url: edit?.git_url ?? '', ref: edit?.git_ref ?? '', token: '', pull: false });
  }, [open, edit, mode]);

  const hasArchive =
    filesFrom === 'github' ? !!git.url.trim() : !!file || (!!edit?.files_name && !edit?.git_url && keepFile);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setVar = (i: number, v: Partial<PVariable>) => setVars((l) => l.map((x, j) => (j === i ? { ...x, ...v } : x)));
  const setGroup = (i: number, v: Partial<PGroup>) => setGroups((l) => l.map((x, j) => (j === i ? { ...x, ...v } : x)));

  const save = async () => {
    try {
      const body: PlaybookRequest = {
        name: form.name.trim(),
        description: form.description.trim(),
        playbook: src.up === 'text' ? form.playbook : '',
        playbook_path: src.up === 'archive' ? form.playbook_path.trim() : '',
        rollback: src.rb === 'text' ? form.rollback : '',
        rollback_path: src.rb === 'archive' ? form.rollback_path.trim() : '',
        requirements: form.requirements,
        variables: vars
          .filter((v) => v.name.trim())
          .map((v) => ({ ...v, name: v.name.trim(), default: v.default === '' ? undefined : v.default })),
        groups: groups.filter((g) => g.group.trim()),
        files_keep: filesFrom === 'upload' && !file && keepFile && !edit?.git_url,
      };
      if (filesFrom === 'github') {
        body.git_url = git.url.trim();
        body.git_ref = git.ref.trim();
        body.git_token = git.token.trim() || undefined;
        body.git_pull = git.pull;
      } else if (file) {
        body.files_base64 = await toBase64(file);
        body.files_name = file.name;
      }
      const out = edit ? await put({ id: edit.id, body }).unwrap() : await add(body).unwrap();
      toast.success(t('pb.saved'));
      onClose(out);
    } catch (e) {
      toast.error(String((e as { data?: { title?: string } }).data?.title ?? t('failed')));
    }
  };

  const yaml = (k: 'playbook' | 'rollback', label: string, s: Src, setS: (v: Src) => void, pathKey: keyof Form) => (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={0.75}>
        <Typography fontWeight={700} variant="body2">
          {label}
        </Typography>
        <ToggleButtonGroup exclusive size="small" value={s} onChange={(_, v) => v && setS(v)}>
          <ToggleButton value="text">{t('pb.paste')}</ToggleButton>
          <ToggleButton value="archive">{t('pb.inArchive')}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {s === 'text' ? (
        <TextField
          fullWidth
          multiline
          minRows={8}
          maxRows={22}
          value={form[k]}
          onChange={set(k)}
          placeholder={k === 'playbook' ? '- hosts: postgres\n  become: true\n  tasks: ...' : t('pb.rollbackEmpty')}
          InputProps={{ sx: mono }}
        />
      ) : (
        <TextField
          fullWidth
          size="small"
          value={form[pathKey]}
          onChange={set(pathKey)}
          placeholder={k === 'playbook' ? 'upgrade.yml' : 'rollback.yml'}
          helperText={hasArchive ? t('pb.pathHelp') : t('pb.needArchive')}
          error={!hasArchive}
        />
      )}
    </Box>
  );

  return (
    <Dialog open={open} onClose={() => onClose()} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box flex={1}>{edit ? t('pb.editTitle', { name: edit.name }) : t('pb.addTitle')}</Box>
        {!edit ? (
          <Button
            size="small"
            onClick={() => {
              setForm((f) => ({ ...f, ...EXAMPLE.form }));
              setSrc({ up: 'text', rb: 'text' });
              setVars(EXAMPLE.variables);
              setGroups(EXAMPLE.groups);
            }}>
            {t('pb.example')}
          </Button>
        ) : null}
      </DialogTitle>
      <DialogContent dividers>
        <Stack gap={2.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5}>
            <TextField
              size="small"
              label={t('pb.name')}
              value={form.name}
              onChange={set('name')}
              sx={{ minWidth: 260 }}
            />
            <TextField
              size="small"
              fullWidth
              label={t('pb.description')}
              value={form.description}
              onChange={set('description')}
            />
          </Stack>

          <Box>
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={0.75}>
              <Typography fontWeight={700} variant="body2">
                {t('pb.archive')}
              </Typography>
              <ToggleButtonGroup exclusive size="small" value={filesFrom} onChange={(_, v) => v && setFilesFrom(v)}>
                <ToggleButton value="upload">{t('pb.fromUpload')}</ToggleButton>
                <ToggleButton value="github">
                  <GitHubIcon fontSize="small" sx={{ mr: 0.75 }} />
                  {t('pb.fromGithub')}
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
            {filesFrom === 'github' ? (
              <Stack gap={1.25}>
                <Stack direction={{ xs: 'column', md: 'row' }} gap={1.25}>
                  <TextField
                    size="small"
                    fullWidth
                    label={t('pb.gitUrl')}
                    placeholder="https://github.com/your-org/postgres-playbooks"
                    value={git.url}
                    onChange={(e) => setGit((g) => ({ ...g, url: e.target.value }))}
                    InputProps={{ sx: mono }}
                  />
                  <TextField
                    size="small"
                    label={t('pb.gitRef')}
                    placeholder="main"
                    value={git.ref}
                    onChange={(e) => setGit((g) => ({ ...g, ref: e.target.value }))}
                    sx={{ minWidth: 200 }}
                  />
                </Stack>
                <TextField
                  size="small"
                  type="password"
                  autoComplete="new-password"
                  label={t('pb.gitToken')}
                  value={git.token}
                  onChange={(e) => setGit((g) => ({ ...g, token: e.target.value }))}
                  helperText={t('pb.gitTokenHelp')}
                />
                {edit?.git_url ? (
                  <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                    <Typography variant="body2" sx={mono}>
                      {t('pb.gitPulled', {
                        commit: edit.git_commit || '—',
                        when: edit.git_pulled_at ? new Date(edit.git_pulled_at).toLocaleString() : '—',
                      })}
                    </Typography>
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={git.pull}
                          onChange={(e) => setGit((g) => ({ ...g, pull: e.target.checked }))}
                        />
                      }
                      label={<Typography variant="body2">{t('pb.gitPullNow')}</Typography>}
                    />
                  </Stack>
                ) : null}
              </Stack>
            ) : (
              <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
                <Button component="label" variant="outlined" size="small" startIcon={<UploadIcon />}>
                  {t('pb.upload')}
                  <input
                    hidden
                    type="file"
                    accept=".tar.gz,.tgz,.tar,.zip"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </Button>
                <Typography variant="body2" sx={mono}>
                  {file
                    ? `${file.name} (${Math.ceil(file.size / 1024)} KB)`
                    : edit?.files_name && keepFile && !edit.git_url
                      ? `${edit.files_name} (${Math.ceil(edit.files_size / 1024)} KB)`
                      : t('pb.noArchive')}
                </Typography>
                {file || (edit?.files_name && keepFile && !edit.git_url) ? (
                  <IconButton
                    size="small"
                    onClick={() => {
                      setFile(null);
                      setKeepFile(false);
                    }}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                ) : null}
              </Stack>
            )}
            <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
              {filesFrom === 'github' ? t('pb.gitHelp') : t('pb.archiveHelp')}
            </Typography>
          </Box>

          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
            {yaml(
              'playbook',
              t('pb.upgradePlaybook'),
              src.up,
              (v) => setSrc((s) => ({ ...s, up: v })),
              'playbook_path',
            )}
            {yaml(
              'rollback',
              t('pb.rollbackPlaybook'),
              src.rb,
              (v) => setSrc((s) => ({ ...s, rb: v })),
              'rollback_path',
            )}
          </Box>
          <Typography variant="caption" color="text.secondary" mt={-1.5}>
            {t('pb.gets')}
          </Typography>

          <Box>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography fontWeight={700} variant="body2">
                {t('pb.inputs')}
              </Typography>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setVars((l) => [...l, { name: '', label: '', type: 'text', required: true }])}>
                {t('pb.addInput')}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" mb={1}>
              {t('pb.inputsHelp')}
            </Typography>
            <Stack gap={1}>
              {vars.map((v, i) => (
                <Stack key={i} direction={{ xs: 'column', md: 'row' }} gap={1} alignItems={{ md: 'center' }}>
                  <TextField
                    size="small"
                    label={t('pb.varName')}
                    value={v.name}
                    onChange={(e) => setVar(i, { name: e.target.value })}
                    InputProps={{ sx: mono }}
                    sx={{ minWidth: 170 }}
                  />
                  <TextField
                    size="small"
                    label={t('pb.varLabel')}
                    value={v.label ?? ''}
                    onChange={(e) => setVar(i, { label: e.target.value })}
                    sx={{ minWidth: 190 }}
                  />
                  <TextField
                    select
                    size="small"
                    label={t('pb.varType')}
                    value={v.type}
                    onChange={(e) => setVar(i, { type: e.target.value as PVarType })}
                    sx={{ minWidth: 120 }}>
                    {TYPES.map((x) => (
                      <MenuItem key={x} value={x}>
                        {t(`pb.type_${x}`)}
                      </MenuItem>
                    ))}
                  </TextField>
                  {v.type === 'select' ? (
                    <TextField
                      size="small"
                      label={t('pb.varOptions')}
                      value={(v.options ?? []).join(', ')}
                      onChange={(e) =>
                        setVar(i, {
                          options: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      sx={{ minWidth: 170 }}
                    />
                  ) : null}
                  {v.type !== 'password' ? (
                    <TextField
                      size="small"
                      fullWidth
                      label={t('pb.varDefault')}
                      value={v.default == null ? '' : String(v.default)}
                      onChange={(e) => setVar(i, { default: e.target.value })}
                    />
                  ) : (
                    <Box flex={1} />
                  )}
                  <Tooltip title={t('pb.varRequired')}>
                    <Stack direction="row" alignItems="center">
                      <Checkbox
                        size="small"
                        checked={!!v.required}
                        onChange={(e) => setVar(i, { required: e.target.checked })}
                      />
                      <Typography variant="caption">{t('pb.req')}</Typography>
                    </Stack>
                  </Tooltip>
                  <IconButton size="small" onClick={() => setVars((l) => l.filter((_, j) => j !== i))}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          </Box>

          <Box>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography fontWeight={700} variant="body2">
                {t('pb.groups')}
              </Typography>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setGroups((l) => [...l, { group: '', from: 'postgres' }])}>
                {t('pb.addGroup')}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" mb={1}>
              {t('pb.groupsHelp')}
            </Typography>
            <Stack gap={1}>
              {groups.map((g, i) => (
                <Stack key={i} direction="row" gap={1} alignItems="center">
                  <TextField
                    size="small"
                    label={t('pb.groupName')}
                    value={g.group}
                    onChange={(e) => setGroup(i, { group: e.target.value })}
                    InputProps={{ sx: mono }}
                    sx={{ width: 220 }}
                  />
                  <Typography variant="body2">=</Typography>
                  <TextField
                    select
                    size="small"
                    label={t('pb.groupFrom')}
                    value={g.from}
                    onChange={(e) => setGroup(i, { from: e.target.value })}
                    sx={{ width: 220 }}>
                    {FROM.map((x) => (
                      <MenuItem key={x} value={x}>
                        {x === 'all' ? t('pb.allMachines') : x}
                      </MenuItem>
                    ))}
                  </TextField>
                  <IconButton size="small" onClick={() => setGroups((l) => l.filter((_, j) => j !== i))}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          </Box>

          <TextField
            fullWidth
            multiline
            minRows={2}
            maxRows={10}
            label={t('pb.requirements')}
            value={form.requirements}
            onChange={set('requirements')}
            placeholder={'collections:\n  - name: community.postgresql'}
            helperText={t('pb.requirementsHelp')}
            InputProps={{ sx: mono }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose()}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={!form.name.trim() || adding.isLoading || putting.isLoading}
          onClick={() => void save()}>
          {t('pb.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default PlaybookEditor;
