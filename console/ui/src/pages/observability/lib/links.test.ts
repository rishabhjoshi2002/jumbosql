import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl, linksFromInventory, resolveLinks } from './links';

const inventory = JSON.stringify({
  all: {
    children: {
      patroni_cluster: { hosts: { '192.168.122.24': {}, '192.168.122.25': {} } },
      prometheus_cluster: { hosts: { '192.168.122.27': {} } },
      alertmanager_cluster: { hosts: { '192.168.122.27': {} } },
      grafana_cluster: { hosts: { '192.168.122.27': {} } },
    },
  },
});

describe('observability links', () => {
  it('uses the Monitoring VM from the inventory with the default ports', () => {
    expect(linksFromInventory(inventory)).toEqual({
      grafana: 'http://192.168.122.27:3000',
      prometheus: 'http://192.168.122.27:9090',
      alertmanager: 'http://192.168.122.27:9093',
    });
  });

  it('returns nothing for clusters without monitoring or without an inventory', () => {
    expect(linksFromInventory(JSON.stringify({ all: { children: { patroni_cluster: { hosts: {} } } } }))).toEqual({});
    expect(linksFromInventory(undefined)).toEqual({});
    expect(linksFromInventory('not json')).toEqual({});
  });

  it('lets saved URLs override the derived ones', () => {
    expect(resolveLinks(inventory, { grafana: ' https://grafana.example.com ', prometheus: '' })).toEqual({
      grafana: 'https://grafana.example.com',
      prometheus: 'http://192.168.122.27:9090',
      alertmanager: 'http://192.168.122.27:9093',
    });
  });

  it('only opens or embeds http(s) URLs', () => {
    expect(isSafeHttpUrl('https://g.example.com')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
  });
});
