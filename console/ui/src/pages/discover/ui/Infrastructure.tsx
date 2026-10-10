import { FC, useMemo, useState } from 'react';
import { Alert, Box, Chip, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { DComponent, DHost, DResult } from '@shared/api/api/discover.ts';
import { bytes } from '@pages/insights/lib/format.ts';
import Card from './Card.tsx';
import DataTable, { Col } from './DataTable.tsx';
import InfraDiagram, { useLaneColors } from './InfraDiagram.tsx';
import { hostLabel } from '../lib/infraLayout.ts';

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 };

const RoleChips: FC<{ roles: string[] }> = ({ roles }) => {
  const { t } = useTranslation('discover');
  const lane = useLaneColors();
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap">
      {roles.map((r) => (
        <Chip
          key={r}
          size="small"
          label={t(`lane_${r === 'ha' ? 'database' : r}`)}
          sx={{ height: 20, fontWeight: 600, bgcolor: `${lane[r === 'ha' ? 'database' : r] ?? '#888'}22` }}
        />
      ))}
    </Stack>
  );
};

const dataDisk = (h: DHost) => {
  const disks = h.disks ?? [];
  return disks.find((d) => /pgsql|postgres|pgdata|\/data/.test(d.mount)) ?? disks.find((d) => d.mount === '/');
};

/** One machine: facts, components with their config, packages, listening ports. */
const HostDetails: FC<{ host: DHost }> = ({ host }) => {
  const { t } = useTranslation('discover');
  const [tab, setTab] = useState<'components' | 'packages' | 'listening' | 'disks'>('components');
  const facts: [string, string | undefined][] = [
    [t('h_os'), host.os],
    [t('h_kernel'), host.kernel && `${host.kernel} (${host.arch ?? ''})`],
    [t('h_cpu'), host.cpus ? `${host.cpus} × ${host.cpu_model ?? ''}` : undefined],
    [t('h_ram'), host.mem_bytes ? bytes(host.mem_bytes) : undefined],
    [t('h_swap'), host.swap_bytes !== undefined && host.mem_bytes ? bytes(host.swap_bytes) : undefined],
    [t('h_virt'), host.virtualization],
    [t('h_boot'), host.booted_at],
    [t('h_load'), host.load],
    [
      t('h_ssh'),
      host.ssh === 'failed' ? `${t('ssh_failed')}: ${host.ssh_error}` : t(`ssh_${host.ssh.replace(' ', '_')}`),
    ],
    [t('h_sudo'), host.sudo],
    [t('h_groups'), (host.groups ?? []).join(', ') || undefined],
    [t('h_ports'), host.open_ports.join(', ') || '—'],
  ];
  return (
    <Card title={t('hostTitle', { host: hostLabel(host) })} subtitle={host.address}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', xl: 'repeat(3, 1fr)' },
          columnGap: 3,
          rowGap: 0.5,
          mb: 1.5,
        }}>
        {facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <Stack key={k} direction="row" gap={1}>
              <Typography variant="body2" color="text.secondary" sx={{ minWidth: 110 }}>
                {k}
              </Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                {v}
              </Typography>
            </Stack>
          ))}
      </Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36 } }}>
        <Tab value="components" label={t('ht_components', { count: host.components.length })} />
        <Tab value="packages" label={t('ht_packages', { count: host.packages?.length ?? 0 })} />
        <Tab value="listening" label={t('ht_listening', { count: host.listening?.length ?? 0 })} />
        <Tab value="disks" label={t('ht_disks', { count: host.disks?.length ?? 0 })} />
      </Tabs>
      <Box mt={1.5}>
        {tab === 'components' ? (
          <Stack gap={1}>
            {host.components.map((c) => (
              <Box key={c.kind} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.25 }}>
                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: c.running ? 'success.main' : 'text.disabled',
                    }}
                  />
                  <Typography fontWeight={700}>{c.label}</Typography>
                  <Typography variant="body2">{c.version}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t(`lane_${c.layer === 'ha' ? 'database' : c.layer}`, { defaultValue: c.layer })}
                    {c.ports?.length ? ` · ${t('ports')} ${c.ports.join(', ')}` : ''}
                    {` · ${t('foundBy')} ${c.sources.map((s) => t(`src_${s}`, { defaultValue: s })).join(', ')}`}
                  </Typography>
                </Stack>
                {c.package || c.path ? (
                  <Typography variant="caption" component="div" sx={mono} color="text.secondary" mt={0.5}>
                    {[c.package && `${t('package')}: ${c.package}`, c.path].filter(Boolean).join('   ')}
                  </Typography>
                ) : null}
                {c.details && Object.keys(c.details).length ? (
                  <Box
                    component="dl"
                    sx={{ m: 0, mt: 0.75, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1.5 }}>
                    {Object.entries(c.details).map(([k, v]) => (
                      <Box key={k} sx={{ display: 'contents' }}>
                        <Typography component="dt" variant="caption" color="text.secondary">
                          {k}
                        </Typography>
                        <Typography component="dd" variant="caption" sx={{ m: 0, ...mono, wordBreak: 'break-word' }}>
                          {v}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                ) : null}
              </Box>
            ))}
            {!host.components.length ? (
              <Typography variant="body2" color="text.secondary">
                {t('none')}
              </Typography>
            ) : null}
          </Stack>
        ) : null}
        {tab === 'packages' ? (
          <DataTable
            rows={host.packages ?? []}
            name={`packages-${hostLabel(host)}`}
            empty={host.ssh === 'ok' ? t('none') : t('needSsh')}
            initialSort={{ key: 'name' }}
            cols={[
              { key: 'name', label: t('package'), value: (r) => r.name, mono: true },
              { key: 'version', label: t('c_version'), value: (r) => r.version, mono: true },
            ]}
          />
        ) : null}
        {tab === 'listening' ? (
          <DataTable
            rows={host.listening ?? []}
            name={`listening-${hostLabel(host)}`}
            empty={host.ssh === 'ok' ? t('none') : t('needSsh')}
            initialSort={{ key: 'port' }}
            cols={[
              { key: 'port', label: t('port'), value: (r) => r.port, align: 'right', mono: true },
              { key: 'addr', label: t('address'), value: (r) => r.addr, mono: true },
              { key: 'process', label: t('process'), value: (r) => r.process ?? '' },
            ]}
          />
        ) : null}
        {tab === 'disks' ? (
          <DataTable
            rows={host.disks ?? []}
            name={`disks-${hostLabel(host)}`}
            empty={host.ssh === 'ok' ? t('none') : t('needSsh')}
            initialSort={{ key: 'mount' }}
            cols={[
              { key: 'mount', label: t('mount'), value: (r) => r.mount, mono: true },
              { key: 'fs', label: t('fs'), value: (r) => r.fs },
              {
                key: 'size',
                label: t('c_size'),
                value: (r) => r.size_bytes,
                render: (r) => bytes(r.size_bytes),
                align: 'right',
              },
              {
                key: 'used',
                label: t('used'),
                value: (r) => r.used_bytes,
                render: (r) => bytes(r.used_bytes),
                align: 'right',
              },
              {
                key: 'pct',
                label: '%',
                value: (r) => (r.size_bytes ? Math.round((100 * r.used_bytes) / r.size_bytes) : 0),
                render: (r) => `${r.size_bytes ? Math.round((100 * r.used_bytes) / r.size_bytes) : 0}%`,
                align: 'right',
              },
            ]}
          />
        ) : null}
      </Box>
    </Card>
  );
};

type CompRow = { host: DHost; c: DComponent };

/** The Architecture tab: every machine and what runs on it, with versions and package names. */
const Infrastructure: FC<{ result: DResult }> = ({ result }) => {
  const { t } = useTranslation('discover');
  const inf = result.infra!;
  const [selected, setSelected] = useState(inf.hosts[0]?.address ?? '');
  const host = inf.hosts.find((h) => h.address === selected);
  const comps: CompRow[] = useMemo(() => inf.hosts.flatMap((h) => h.components.map((c) => ({ host: h, c }))), [inf]);

  const hostCols: Col<DHost>[] = [
    {
      key: 'host',
      label: t('c_machine'),
      value: (r) => hostLabel(r),
      render: (r) => (
        <Box>
          <Typography variant="body2" fontWeight={700}>
            {hostLabel(r)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={mono}>
            {r.address}
          </Typography>
        </Box>
      ),
    },
    {
      key: 'roles',
      label: t('c_runs'),
      value: (r) => r.roles.join(', '),
      render: (r) => <RoleChips roles={r.roles} />,
    },
    { key: 'os', label: t('h_os'), value: (r) => r.os ?? '' },
    { key: 'cpus', label: t('c_cpu'), value: (r) => r.cpus ?? 0, render: (r) => r.cpus ?? '—', align: 'right' },
    {
      key: 'ram',
      label: t('h_ram'),
      value: (r) => r.mem_bytes ?? 0,
      render: (r) => (r.mem_bytes ? bytes(r.mem_bytes) : '—'),
      align: 'right',
    },
    {
      key: 'disk',
      label: t('c_disk'),
      value: (r) => dataDisk(r)?.size_bytes ?? 0,
      render: (r) => {
        const d = dataDisk(r);
        return d ? `${bytes(d.used_bytes)} / ${bytes(d.size_bytes)}` : '—';
      },
      align: 'right',
    },
    {
      key: 'ssh',
      label: 'SSH',
      value: (r) => r.ssh,
      render: (r) => (
        <Typography variant="body2" color={r.ssh === 'failed' ? 'error' : undefined} title={r.ssh_error}>
          {t(`ssh_${r.ssh.replace(' ', '_')}`)}
        </Typography>
      ),
    },
    { key: 'ports', label: t('h_ports'), value: (r) => r.open_ports.join(' '), mono: true },
  ];
  const compCols: Col<CompRow>[] = [
    { key: 'host', label: t('c_machine'), value: (r) => hostLabel(r.host) },
    {
      key: 'layer',
      label: t('c_layer'),
      value: (r) => r.c.layer,
      render: (r) => t(`lane_${r.c.layer === 'ha' ? 'database' : r.c.layer}`, { defaultValue: r.c.layer }),
    },
    { key: 'component', label: t('c_component'), value: (r) => r.c.label },
    { key: 'version', label: t('c_version'), value: (r) => r.c.version ?? '', mono: true },
    { key: 'package', label: t('package'), value: (r) => r.c.package ?? '', mono: true },
    {
      key: 'running',
      label: t('c_running'),
      value: (r) => (r.c.running ? t('yes') : t('no')),
      render: (r) => (
        <Typography variant="body2" color={r.c.running ? 'success.main' : 'text.secondary'} fontWeight={600}>
          {r.c.running ? t('yes') : t('no')}
        </Typography>
      ),
    },
    { key: 'ports', label: t('ports'), value: (r) => (r.c.ports ?? []).join(', '), mono: true },
    {
      key: 'sources',
      label: t('foundBy'),
      value: (r) => r.c.sources.map((s) => t(`src_${s}`, { defaultValue: s })).join(', '),
    },
  ];

  return (
    <Stack gap={2}>
      <Card>
        <Typography fontWeight={700}>{t('whatRunsWhere')}</Typography>
        <Stack component="ul" gap={0.5} sx={{ m: 0, mt: 1, pl: 2.5 }}>
          {inf.summary.map((s) => (
            <Typography component="li" variant="body2" key={s}>
              {s}
            </Typography>
          ))}
        </Stack>
        {!inf.ssh_used ? (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            {t('noSshNote')}
          </Alert>
        ) : null}
      </Card>

      <Card title={t('infraTitle')}>
        <InfraDiagram infra={inf} nodes={result.nodes} selected={selected} onSelect={setSelected} />
      </Card>

      <Card title={t('machinesTitle')}>
        <DataTable rows={inf.hosts} cols={hostCols} name="machines" empty={t('none')} />
      </Card>

      {host ? <HostDetails key={host.address} host={host} /> : null}

      <Card title={t('componentsTitle')}>
        <DataTable rows={comps} cols={compCols} name="components" empty={t('none')} initialSort={{ key: 'layer' }} />
      </Card>

      {inf.routes.length || inf.vips.length ? (
        <Card title={t('routesTitle')}>
          {inf.vips.length ? (
            <Typography variant="body2" mb={1}>
              {t('vipsAre', { vips: inf.vips.join(', ') })}
            </Typography>
          ) : null}
          <DataTable
            rows={inf.routes}
            name="routes"
            empty={t('needSshRoutes')}
            cols={[
              {
                key: 'host',
                label: t('c_machine'),
                value: (r) => {
                  const h = inf.hosts.find((x) => x.address === r.host);
                  return h ? hostLabel(h) : r.host;
                },
              },
              { key: 'kind', label: t('c_balancer'), value: (r) => r.kind },
              { key: 'name', label: t('c_name'), value: (r) => r.name, mono: true },
              { key: 'port', label: t('port'), value: (r) => r.port, align: 'right', mono: true },
              { key: 'mode', label: t('c_mode'), value: (r) => r.mode ?? '' },
              { key: 'targets', label: t('c_sendsTo'), value: (r) => r.targets.join(', '), mono: true },
            ]}
          />
        </Card>
      ) : null}

      {inf.prometheus ? (
        <Card
          title={t('promTitle')}
          subtitle={inf.prometheus_error ? `${inf.prometheus} · ${inf.prometheus_error}` : inf.prometheus}>
          <DataTable
            rows={inf.prometheus_targets ?? []}
            name="prometheus-targets"
            empty={t('none')}
            initialSort={{ key: 'job' }}
            cols={[
              { key: 'job', label: t('c_job'), value: (r) => r.job, mono: true },
              { key: 'instance', label: t('c_instance'), value: (r) => r.instance, mono: true },
              {
                key: 'host',
                label: t('c_machine'),
                value: (r) => {
                  const h = inf.hosts.find((x) => x.address === r.host);
                  return h ? hostLabel(h) : t('notInInventoryShort');
                },
              },
              {
                key: 'health',
                label: t('c_health'),
                value: (r) => r.health,
                render: (r) => (
                  <Typography variant="body2" fontWeight={600} color={r.health === 'up' ? 'success.main' : 'error'}>
                    {r.health}
                  </Typography>
                ),
              },
            ]}
          />
        </Card>
      ) : null}
    </Stack>
  );
};

export default Infrastructure;
