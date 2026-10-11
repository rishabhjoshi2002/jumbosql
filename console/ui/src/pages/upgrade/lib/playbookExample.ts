import { PGroup, PVariable } from '@shared/api/api/playbooks.ts';

// The "Example" of the playbook editor: PgBouncer from your repository, one node at a time, with a rollback.
const upgrade = `- name: Upgrade PgBouncer
  hosts: pgbouncer_nodes
  become: true
  serial: 1
  tasks:
    - name: Installed version
      ansible.builtin.shell: rpm -q --qf '%{VERSION}-%{RELEASE}' pgbouncer 2>/dev/null || dpkg-query -W -f='\${Version}' pgbouncer
      register: old
      changed_when: false
      check_mode: false

    - name: Keep it for the rollback
      ansible.builtin.copy:
        dest: "/var/lib/pg_mantra/custom/{{ pgm.run_id }}/pgbouncer.version"
        content: "{{ old.stdout }}"

    - name: Install the new version
      ansible.builtin.package:
        name: "pgbouncer{{ '-' if ansible_os_family == 'RedHat' else '=' }}{{ target_version }}"
        state: present

    - name: Restart
      ansible.builtin.service:
        name: pgbouncer
        state: restarted

    - name: Wait until it listens
      ansible.builtin.wait_for:
        port: "{{ pgbouncer_port }}"
        timeout: 60
`;

const rollback = `- name: Roll back PgBouncer
  hosts: pgbouncer_nodes
  become: true
  serial: 1
  tasks:
    - name: Version kept by the upgrade
      ansible.builtin.slurp:
        src: "/var/lib/pg_mantra/custom/{{ pgm.run_id }}/pgbouncer.version"
      register: kept

    - name: Put it back
      ansible.builtin.shell: >-
        {{ 'dnf -y downgrade pgbouncer-' if ansible_os_family == 'RedHat'
           else 'apt-get install -y --allow-downgrades pgbouncer=' }}{{ kept.content | b64decode }}

    - name: Restart
      ansible.builtin.service:
        name: pgbouncer
        state: restarted

    - name: Wait until it listens
      ansible.builtin.wait_for:
        port: "{{ pgbouncer_port }}"
        timeout: 60
`;

export const EXAMPLE: {
  form: { name: string; description: string; playbook: string; rollback: string };
  variables: PVariable[];
  groups: PGroup[];
} = {
  form: {
    name: 'PgBouncer upgrade',
    description: 'PgBouncer from our repository, one node at a time',
    playbook: upgrade,
    rollback,
  },
  variables: [
    { name: 'target_version', label: 'Target version', type: 'text', required: true, help: 'e.g. 1.23.1-1PGDG' },
    { name: 'pgbouncer_port', label: 'PgBouncer port', type: 'number', required: true, default: 6432 },
  ],
  groups: [{ group: 'pgbouncer_nodes', from: 'pgbouncer' }],
};
