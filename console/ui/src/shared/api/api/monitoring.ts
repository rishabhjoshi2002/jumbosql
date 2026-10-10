// pg_genie: live monitoring of a cluster from its Prometheus (GET /clusters/{id}/monitoring).
import { baseApi as api } from '../baseApi.ts';
import { TPoint } from './insights.ts';

export type MonTarget = { service: string; job: string; instance: string; node?: string; role?: string; up: boolean };
export type MonVM = {
  host: string;
  name: string;
  roles?: string;
  kind: 'database' | 'etcd' | 'proxy' | 'backup' | 'monitoring' | 'other';
  db_role?: string;
  up: boolean;
  services: { service: string; up: boolean; jobs: string[] }[];
};
export type MonAlert = {
  name: string;
  state: string;
  severity?: string;
  instance?: string;
  summary?: string;
  since: string;
};
export type MonPanel = { series: { name: string; points: TPoint[] | null }[]; query?: string };
export type Monitoring = {
  prometheus: string;
  error?: string;
  minutes: number;
  targets: MonTarget[];
  hosts: MonVM[] | null;
  alerts: MonAlert[];
  panels: Record<string, MonPanel>;
  stats: Record<string, number>;
  generated_at: string;
};

const injectedRtkApi = api.injectEndpoints({
  endpoints: (build) => ({
    getMonitoring: build.query<Monitoring, { id: number; minutes: number }>({
      query: ({ id, minutes }) => ({ url: `/clusters/${id}/monitoring`, params: { minutes } }),
      keepUnusedDataFor: 30,
    }),
  }),
  overrideExisting: false,
});

export const { useGetMonitoringQuery } = injectedRtkApi;
