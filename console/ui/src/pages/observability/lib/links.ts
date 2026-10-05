/**
 * JumboSQL: where each cluster's monitoring lives. The monitoring VM comes from the cluster's inventory
 * (the VM with the Monitoring role -> prometheus/grafana/alertmanager groups); the ports are the pgMonitor
 * defaults. Any URL can be overridden per cluster, e.g. when Grafana sits behind a proxy or a DNS name.
 */
export const OBSERVABILITY_TOOLS = ['grafana', 'prometheus', 'alertmanager'] as const;
export type ObservabilityTool = (typeof OBSERVABILITY_TOOLS)[number];
export type ObservabilityLinks = Partial<Record<ObservabilityTool, string>>;

export const DEFAULT_PORTS: Record<ObservabilityTool, number> = {
  grafana: 3000,
  prometheus: 9090,
  alertmanager: 9093,
};

const GROUPS: Record<ObservabilityTool, string> = {
  grafana: 'grafana_cluster',
  prometheus: 'prometheus_cluster',
  alertmanager: 'alertmanager_cluster',
};

type Inventory = { all?: { children?: Record<string, { hosts?: Record<string, { ansible_host?: string }> }> } };

const parseInventory = (raw?: string | object | null): Inventory | null => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Inventory;
  try {
    return JSON.parse(raw) as Inventory;
  } catch {
    return null;
  }
};

/** Links derived from the inventory (empty when the cluster has no Monitoring VM). */
export const linksFromInventory = (raw?: string | object | null): ObservabilityLinks => {
  const children = parseInventory(raw)?.all?.children ?? {};
  const links: ObservabilityLinks = {};
  OBSERVABILITY_TOOLS.forEach((tool) => {
    const hosts = children[GROUPS[tool]]?.hosts ?? {};
    const [name, vars] = Object.entries(hosts)[0] ?? [];
    if (name) links[tool] = `http://${vars?.ansible_host || name}:${DEFAULT_PORTS[tool]}`;
  });
  return links;
};

/** Saved overrides win over the inventory; empty overrides are ignored. */
export const resolveLinks = (
  raw: string | object | null | undefined,
  overrides?: ObservabilityLinks,
): ObservabilityLinks => {
  const links = linksFromInventory(raw);
  OBSERVABILITY_TOOLS.forEach((tool) => {
    const o = overrides?.[tool]?.trim();
    if (o) links[tool] = o;
  });
  return links;
};

export const isSafeHttpUrl = (url?: string) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

export const OBSERVABILITY_SETTING = 'observability_links';
