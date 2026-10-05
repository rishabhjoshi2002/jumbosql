<p align="center">
  <img src="console/ui/src/shared/assets/jumbosqlLogo.png" alt="JumboSQL" width="240">
</p>

# JumboSQL

A web console for deploying and running **Crunchy Postgres HA** clusters (Crunchy Postgres for Ansible,
`crunchydata.pg` **2.2.0**) on your own virtual machines. Based on [Autobase](https://github.com/autobase-tech/autobase) (MIT).

What JumboSQL changes compared to Autobase:

| | Autobase | JumboSQL |
|---|---|---|
| Automation | Autobase's own playbooks (community packages) | Crunchy Postgres for Ansible 2.2.0, your licensed collection, your `group_vars` and vault |
| Where things run | database servers, optional DCS / load balancer blocks | **Inventory step**: add each VM and tick its roles: etcd, PostgreSQL + Patroni, HAProxy, PgBouncer, pgBackRest repo, monitoring. Live `inventory.yml` preview and download |
| Destinations | clouds + own machines | own machines (CPA installs onto existing VMs) |
| Cluster page | Patroni status | Patroni status **plus actions**: switchover (to a chosen node or automatic), restart PostgreSQL, reinitialize a replica |
| SQL editor | first host | registered on **HAProxy's read-write port**, so it always reaches the current Patroni leader |
| Branding | Autobase | JumboSQL |

## How it fits together

```
 browser ──► jumbosql/console  (UI + API + console DB + SQL editor)       on the console VM
                   │  Create cluster  (inventory from the form)
                   ▼
             jumbosql/automation-cpa:2.2.0  (one container per deployment)
                   │  ansible-playbook crunchy-postgres-ha.playbook.yml  -e @vault.yml
                   ▼
             your VMs:  etcd · PostgreSQL + Patroni · HAProxy · PgBouncer · pgBackRest · Prometheus/Grafana
```

## Install (on the console VM, with Docker)

**1. Clone**

```bash
git clone https://github.com/rishabhjoshi2002/jumbosql.git
cd jumbosql
```

**2. Bring your CPA 2.2.0 setup over from the Ansible VM.** On the Ansible VM (where `crunchydata.pg` 2.2.0 is
installed and your `group_vars`, `files/cpa-rpm.repo`, `vault.yml` live), clone the repo there too (or copy just
`automation-cpa/pack-from-ansible-vm.sh`) and run:

```bash
./automation-cpa/pack-from-ansible-vm.sh      # defaults: /root/crunchydata-pg-2.2/playbooks/crunchy-ha-postgresql, /root/.cpa_vault_pass
scp /root/cpa-bundle.tar.gz root@<console-vm>:/root/jumbosql/automation-cpa/
```

The bundle holds your licensed collection and secrets. It is git-ignored and must never be committed or pushed.

**3. Build and start**

```bash
./build.sh all            # automation image + console image + start on port 80 (asks for a login token)
```

Or step by step: `./build.sh automation`, `./build.sh console`, `./build.sh run`.
If your Patroni REST API needs a password: `PATRONI_USERNAME=... PATRONI_PASSWORD=... ./build.sh run`.

## Create a cluster

1. Open `http://<console-vm>` and sign in with your token.
2. **Clusters → Create cluster**. In **Inventory (virtual machines)** add each VM (hostname, IP) and tick its roles.
   The default is your lab's combined layout: VM 1 = util (etcd, HAProxy, PgBouncer, pgBackRest, monitoring),
   VM 2 and 3 = etcd + PostgreSQL + Patroni. For a split layout, give etcd its own 3 VMs.
   The form checks the CPA rules as you type: odd etcd count (3 or 5), at least 2 Patroni nodes, exactly one
   pgBackRest repo, HAProxy and PostgreSQL never on the same VM (both use 5432).
3. SSH: user `root` and the private key that reaches the VMs (the Ansible VM's key works).
4. Pick the PostgreSQL version and cluster name, then **Create cluster**. Follow the live log under **Operations**.

The VMs must be prepared the way you do for CPA today: RHEL 9, registered, `glibc-langpack-en`, chrony,
root SSH access. CPA itself must not have run on them yet.

## Operate

On the cluster page, the server table shows each Patroni member (role, state, timeline, lag). Use the `⋯` menu
on a row to **make it the leader**, **restart PostgreSQL** or **reinitialize** a replica, or **Switchover** at the
top to let Patroni pick the new leader. The **SQL editor** connects through HAProxy's read-write port, so it
follows the leader after a switchover or failover.

## Repository layout

| Path | What |
|---|---|
| `console/ui` | React UI. JumboSQL code: `shared/lib/cpaInventory.ts` (inventory model + rules), `entities/cluster/database-servers-block` (inventory step), `features/clusters-overview-table-row-actions` (Patroni actions) |
| `console/service` | Go API. JumboSQL code: `pkg/patroni/actions.go`, `internal/controllers/cluster/patroni_actions.go`, `/clusters/{id}/switchover`, `/servers/{id}/restart`, `/servers/{id}/reinitialize` in `api/swagger.yaml` |
| `automation-cpa` | the CPA 2.2.0 automation image: entrypoint, inventory check/conversion, wrapper playbook |
| `automation` | Autobase's own automation (unused by JumboSQL, kept for reference and upstream merges) |
| `build.sh` | builds and runs everything |

## Tests

```bash
cd console/ui && yarn vitest run                      # includes cpaInventory.test.ts
cd console/service && make swagger && go test ./...   # includes pkg/patroni/actions_test.go
```

## Licence

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Crunchy Postgres for Ansible is licensed separately by Crunchy Data
and is not included in this repository. Upstream Autobase documentation: [AUTOBASE-README.md](AUTOBASE-README.md).
