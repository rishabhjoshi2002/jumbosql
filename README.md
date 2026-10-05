<p align="center">
  <img src="console/ui/src/shared/assets/jumbosqlLogo.png" alt="JumboSQL" width="220">
</p>

# JumboSQL: Keen PostgreSQL HA

A web console for building and running highly available PostgreSQL clusters (Patroni, etcd, HAProxy,
PgBouncer, pgBackRest, Prometheus/Grafana) on your own virtual machines, using your licensed HA Ansible
collection (version **2.2.0**). Based on [Autobase](https://github.com/autobase-tech/autobase) (MIT).

| Area | What you get |
|---|---|
| **Sign-in** | Username and password, roles **admin / operator / viewer**, users managed in **Settings → Users**. Accounts are stored in the console today; LDAP and SSO plug in later on the server side. |
| **Create cluster** | **Inventory step**: add each VM, tick its roles (etcd, PostgreSQL + Patroni, HAProxy, PgBouncer, pgBackRest repo, monitoring). Live `inventory.yml` preview and download; the layout rules are checked as you type. |
| **Patroni console** | On each cluster page: `list`, `history`, `show-config`, `edit-config`, `pause`/`resume`, `switchover`, `failover`, `restart`, `reload`, `reinit` and a **rolling restart**. Every result shows the equivalent `patronictl` command. |
| **Observability** | One page with each cluster's **Grafana, Prometheus and Alertmanager**, taken from the VM with the Monitoring role; URLs can be overridden per cluster; Grafana can be shown inside the console. |
| **SQL editor** | Connects through HAProxy's read-write port, so it always reaches the current Patroni leader. |
| **Branding** | JumboSQL look (navy and logo blue), with a light watermark on every page: *JumboSQL, managed by Keen & Able Computers Pvt. Ltd.* |

## How it fits together

```
 browser ──► jumbosql/console          UI + API + console DB + SQL editor     (console VM, Docker)
                │  Create cluster  (inventory from the form)
                ▼
            jumbosql/automation-ha:2.2.0   one container per deployment
                │  ansible-playbook keen-ha.playbook.yml -e @vault.yml   (your group_vars, unchanged)
                ▼
            your RHEL 9 VMs: etcd · PostgreSQL + Patroni · HAProxy · PgBouncer · pgBackRest · monitoring
                ▲
 console API ───┘  Patroni REST API (port 8008) for the Patroni console
```

## Install on the console VM (RHEL 9 with Docker)

**1. Clone**

```bash
git clone https://github.com/rishabhjoshi2002/jumbosql.git
cd jumbosql
```

**2. Bring your HA setup over from the Ansible VM.** On the Ansible VM (`.10`), clone the repo too (or copy just
`automation-ha/pack-from-ansible-vm.sh`) and run it. Its defaults point at the collection's install directory
and `/root/.cpa_vault_pass`; pass other paths as arguments if yours differ.

```bash
./automation-ha/pack-from-ansible-vm.sh
scp /root/ha-bundle.tar.gz root@<console-vm>:/root/jumbosql/automation-ha/
```

The bundle holds your licensed collection and secrets. It is git-ignored and must never be committed or pushed.

**3. Build and start**

```bash
./build.sh all     # automation image + console image + start on port 80
```

`./build.sh run` asks for two things:

| Prompt | What it is |
|---|---|
| **API token** | for scripts; also the first `admin` password (unless you set `JUMBOSQL_ADMIN_PASSWORD`) |
| **Ansible vault password** | the password that decrypts `vault.yml` (the one in `/root/.cpa_vault_pass` on the Ansible VM). Press Enter if your `vault.yml` is not encrypted |

The vault password is saved in `/etc/jumbosql/vault_pass` (root only) and given to the console as a secret file;
the console passes it to each deployment, where it is written to a private file for that run only. It is never
put into an image, the console database or a log. To change it: `JUMBOSQL_VAULT_PASSWORD='new' ./build.sh run`.
For non-interactive installs set both: `JUMBOSQL_TOKEN=... JUMBOSQL_VAULT_PASSWORD=... ./build.sh all`.

Or step by step: `./build.sh automation`, `./build.sh console`, `./build.sh run`.
`JUMBOSQL_PORT=8081` picks another port. If your Patroni REST API needs a password, add
`PATRONI_USERNAME=... PATRONI_PASSWORD=...`.

**4. Sign in** as `admin`. On the very first start the password is your token (`JUMBOSQL_TOKEN`), or
`JUMBOSQL_ADMIN_PASSWORD` if you set it. Change it from the user menu, then add people in **Settings → Users**.

## Users and roles

| Role | Can |
|---|---|
| **admin** | everything, including users |
| **operator** | create and manage clusters, run Patroni commands, change monitoring URLs |
| **viewer** | read-only (cluster pages, `list`, `history`, `show-config`, observability) |

Passwords are stored as PBKDF2-SHA256 hashes; sessions last 12 hours (`PG_CONSOLE_AUTH_SESSION_TTL`) and only
a hash of each session token is stored. A password or role change signs that user out everywhere.
The token in `JUMBOSQL_TOKEN` stays valid as an **API token** for scripts.

LDAP / SSO later: the API checks credentials through a provider interface (`console/service/internal/auth`),
so an LDAP or OIDC provider is added next to the local one without touching the UI or the role rules.

## Create the VMs (KVM host)

`tools/jumbosql-vms.sh` creates and prepares RHEL 9 VMs and nothing else (no Ansible, no PostgreSQL). Run it as
root on the KVM host:

```bash
./tools/jumbosql-vms.sh --dry-run            # real checks, prints every action, changes nothing
./tools/jumbosql-vms.sh --name test1         # 3 VMs (default); --count 6 for a split layout
./tools/jumbosql-vms.sh --list               # sets made by the script
./tools/jumbosql-vms.sh --destroy test1      # unregister from Red Hat and delete the set
```

It picks free IPs on `192.168.122.0/24` (or `--ips A,B,C`), builds the VMs from the RHEL 9 KVM guest image
(`BASE_IMAGE`, default `/root/rhel-9.8-x86_64-kvm.qcow2`), sets static IPs and DHCP reservations, registers them
with Red Hat (prompted), installs `glibc-langpack-en` and `chrony`, and creates an SSH key for the set
(`/root/.ssh/jumbosql-<set>`). If any step fails, everything that run created is rolled back. The summary prints the
hostnames, IPs, suggested roles and the key to paste into JumboSQL. Sizes: `RAM_MB=4096 VCPUS=2 DISK=40G`.

## Create a cluster

1. **Clusters → Create cluster**. In **Inventory (virtual machines)** add each VM (hostname, IP) and tick its roles.
   The default is the combined layout: VM 1 = util (etcd, HAProxy, PgBouncer, pgBackRest, monitoring),
   VM 2 and 3 = etcd + PostgreSQL + Patroni. Rules: odd etcd count (3 or 5), at least 2 Patroni nodes, exactly
   one pgBackRest repo, HAProxy and PostgreSQL never on the same VM (both use 5432).
2. SSH: user `root` and the private key that reaches the VMs (the Ansible VM's key works).
3. Pick the PostgreSQL version and cluster name, then **Create cluster**. Follow the live log under **Operations**.

The VMs must be prepared as for your Ansible runs today: RHEL 9, registered, `glibc-langpack-en`, chrony,
root SSH access, and the HA playbook not yet run on them.

## Run the cluster (Patroni console)

| Button | patronictl | What it does |
|---|---|---|
| list / history / show-config | `patronictl list` … | members, failover history, cluster configuration |
| switchover | `patronictl switchover --leader … [--candidate …]` | planned leader change; clients reconnect through HAProxy |
| failover | `patronictl failover --candidate …` | emergency promotion, also works without a leader |
| restart / reload | `patronictl restart|reload <cluster> [member]` | one member, or all of them in turn |
| reinit | `patronictl reinit <cluster> <member>` | rebuild a replica from the leader |
| pause / resume | `patronictl pause|resume` | maintenance mode (no automatic failover) |
| edit-config | `patronictl edit-config` | JSON merged into the cluster configuration |
| rolling restart | — | replicas one by one → switchover → old leader; no write downtime apart from the switchover |

**Minor PostgreSQL upgrade** (for example 17.5 → 17.6): install the new packages on every database VM
(`dnf update 'postgresql17*'` or your usual repository process), then click **Rolling restart**. Patroni restarts
the replicas first, switches over, and restarts the old leader, so the cluster stays available.
A major upgrade (16 → 17) is a different procedure and is not automated yet.

## Observability

**Observability** in the sidebar lists, for each cluster, Grafana (`:3000`), Prometheus (`:9090`) and
Alertmanager (`:9093`) on the VM with the Monitoring role. Your browser must reach those VMs; if you reach the
console through an SSH tunnel, use a SOCKS proxy (`ssh -D 1080 root@<kvm-host>`) and set it in your browser.
**Show here** embeds Grafana; that needs `allow_embedding = true` in Grafana's configuration.

## Repository layout

| Path | What |
|---|---|
| `console/ui` | React UI. JumboSQL code: `shared/lib/haInventory.ts` (inventory model and rules), `entities/cluster/database-servers-block` (inventory step), `widgets/patroni-console`, `pages/observability`, `widgets/users-table`, `pages/login`, `shared/theme` |
| `console/service` | Go API. JumboSQL code: `internal/auth` (sign-in, sessions, providers), `internal/controllers/auth`, `internal/controllers/user`, `pkg/patroni/actions.go`, `internal/controllers/cluster/patroni_*.go`, `middleware/authorization.go` (roles) |
| `console/db/migrations` | console database; `20261005150000_jumbosql_users.sql` adds users and sessions |
| `automation-ha` | the HA automation image: entrypoint, inventory check and conversion, wrapper playbook, pack script |
| `automation` | Autobase's own automation (unused by JumboSQL, kept for upstream merges) |
| `build.sh` | builds and runs everything |
| `tools/jumbosql-vms.sh` | creates and prepares RHEL 9 VMs on the KVM host for a cluster |

## Tests

```bash
cd console/ui && yarn vitest run                      # inventory rules, rolling-restart plan, observability links, ...
cd console/service && make swagger && go test ./...   # auth, roles, Patroni client, ...
```

## Licence

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The HA Ansible collection used by the automation is licensed
separately by its vendor and is not part of this repository. Upstream documentation: [AUTOBASE-README.md](AUTOBASE-README.md).
