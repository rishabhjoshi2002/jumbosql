<p align="center">
  <img src="console/ui/src/shared/assets/pgGeninLogo.png" alt="pg_genin" width="220">
</p>

# pg_genin: Keen PostgreSQL HA

A web console for building and running highly available PostgreSQL clusters (Patroni, etcd, HAProxy,
PgBouncer, pgBackRest, Prometheus/Grafana) on your own virtual machines, using your licensed HA Ansible
collection (version **2.2.0**). Based on [Autobase](https://github.com/autobase-tech/autobase) (MIT).

| Area | What you get |
|---|---|
| **Sign-in** | Username and password, users with **attributes** (group, team, region, …) managed in **Settings → Users**. Accounts are stored in the console today; LDAP and SSO plug in later on the server side. |
| **Access policies (ABAC)** | **Settings → Access policies**: who (everyone, users, attribute conditions) may do what (permissions), where (clusters, environments, projects), with which data (databases, schemas, tables, hidden columns, row and time limits) and when (IP ranges, weekdays, hours). Deny wins, nothing is allowed by default. **Test access** shows what a user may do and which policy decides it. |
| **Audit log** | Every change, SQL statement, log read, sign-in and refused request: who, when, from which IP, on which cluster, with what result. Filters, search, details per event. |
| **Home page** | Everyone has their own: a greeting and the cards an admin picks and orders for them in Settings → Users (clusters summary, top risks, data growth, my clusters, recent queries, recent operations, shortcuts, private notes), limited to what their access allows, and the page that opens after sign-in. |
| **Insights** | A health score (0-100) per cluster and an **All clusters** summary (worst first). Forecasts 30 days, 3 months, 6 months or 1 year ahead with a likely range: storage, disks, CPU, memory, connections, load and the biggest databases, with the date each one reaches its warning level and its limit and what to buy (vCPUs, disk size). Plus table bloat, unused indexes, top queries and a list of recommendations with the SQL. Print / save as PDF for management. |
| **PostgreSQL logs** | Each node's server log in the browser: pick cluster, node and file, live tail, level filter (WARNING+/ERROR+), search with highlighting, download. |
| **Create cluster** | **Inventory step**: add each VM (or **Import VM list** from the VM script), tick its roles (etcd, PostgreSQL + Patroni, HAProxy, PgBouncer, pgBackRest repo, Monitoring = Prometheus + Alertmanager + Grafana). One VM can hold one role or several. Live `inventory.yml` preview and download; the layout rules are checked as you type. |
| **Patroni console** | On each cluster page: `list`, `history`, `show-config`, `edit-config`, `pause`/`resume`, `switchover`, `failover`, `restart`, `reload`, `reinit` and a **rolling restart**. Every result shows the equivalent `patronictl` command. |
| **Observability** | A live monitoring dashboard per cluster from its Prometheus: cluster / PostgreSQL / etcd / services health, firing alerts, last backup, and graphs for connections, TPS, replication lag, cache hit, database size, CPU, memory, disk, load, network and etcd. Links to Grafana, Prometheus and Alertmanager (URLs can be overridden per cluster). |
| **SQL editor** | Built-in, pgAdmin-style query tool: object browser (schemas, tables with columns, views, functions, sequences), query tabs, every statement's result (also `SHOW`, `EXPLAIN`, `RETURNING`), Messages with notices and errors (SQLSTATE, detail, hint, position marked in the editor), Explain / Explain analyze, Cancel, CSV export, query history. Runs through HAProxy's read-write port, so always on the current Patroni leader. Follows the access policies: read-only / read-write / admin, only allowed databases, hidden columns and tables locked in the object browser, row and time limits. |
| **Branding** | pg_genin look (navy and logo blue) with the pg_genin logo, and a light watermark on every page: *pg_genin, managed by Keen & Able Computers Pvt. Ltd.* |

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
 console API ───┘  Patroni REST API (port 8009, the HA automation default) for cluster status and the Patroni console
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

**KVM host:** when the console runs on the same host as the libvirt VMs, `./build.sh run` also lets the console
container (`docker0`) reach the VM networks (`virbr*`); libvirt rejects that traffic by default, which shows up as
`connection refused` on the Patroni port. A hook in `/etc/libvirt/hooks/network` keeps the rule after libvirt
restarts its networks.

**4. Sign in** as `admin`. On the very first start the password is your token (`JUMBOSQL_TOKEN`), or
`JUMBOSQL_ADMIN_PASSWORD` if you set it. Change it from the user menu, then add people in **Settings → Users**.

## Users, attributes and access policies

Each user has **attributes**, simple `key = value` pairs set in **Settings → Users**. The `group` attribute
(admin / operator / viewer) has its own selector; add any others you need (`team = analytics`, `region = eu`,
`clearance = pii`, …).

What a user may do comes only from **access policies** (**Settings → Access policies**). A policy says:

| Part | Example |
|---|---|
| **Who** | everyone, users by name, or attribute conditions (`team = analytics or bi` AND `region = eu`) |
| **What** | permissions: `clusters.view/manage`, `patroni.read/manage`, `sql.read/write/admin`, `sql.stats`, `logs.view`, `observability.manage`, `settings.manage`, `users.manage`, `policies.manage`, `audit.view` |
| **Where** | cluster name patterns (`prod-*`), environments, projects; empty = all clusters |
| **Data** (SQL) | databases, schemas, tables (`sales.*`), hidden columns (`*.*.email`, `public.customers.card_no`), max rows, statement time limit |
| **When** | client IP ranges (CIDR), weekdays, hours, time zone |

Rules: a permission is granted when an enabled **allow** policy matches and no **deny** policy does; everything
else is refused. For SQL the strongest level wins (admin > write > read), data scopes of matching allow policies
are combined, hidden columns of all matching policies add up, and the largest limits apply.

Three built-in policies match the `group` attribute:

| Group | Can |
|---|---|
| **admin** | everything, including users, policies and the audit log |
| **operator** | create and manage clusters, Patroni commands, SQL read/write (not as superuser), statistics, logs, monitoring URLs |
| **viewer** | read-only: cluster pages, `list`, `history`, `show-config`, observability, SQL editor read-only |

You can change or disable them (not delete them), and add your own. The console refuses a change that would
leave no user able to manage policies.

**How the data scope is enforced.** Only an unrestricted `sql.admin` runs as the cluster's superuser. Everyone else
runs as a database role pg_genin creates per scope (`jsql_<hash>`), with `SELECT` (and for write access
`INSERT/UPDATE/DELETE`) granted only on the allowed tables, and only on the visible columns when columns are hidden.
Views that read a hidden column are not granted, read-only profiles have `default_transaction_read_only`, and
server statistics (`pg_stat_activity` of other users, …) need `sql.stats`. So the rules hold for any SQL - `*`,
aliases, `row_to_json`, views, functions - because PostgreSQL itself refuses it. The roles are created and
kept in sync automatically (passwords encrypted in the console database). The cluster's `pg_hba.conf` must accept
password logins for these roles from the HAProxy node; the HA automation's usual rule for all users on the
cluster network covers it, and the SQL editor tells you if a login is refused.

Passwords are stored as PBKDF2-SHA256 hashes; sessions last 12 hours (`PG_CONSOLE_AUTH_SESSION_TTL`) and only
a hash of each session token is stored. A password change signs that user out everywhere; attribute and policy
changes apply within seconds. The token in `JUMBOSQL_TOKEN` stays valid as an **API token** for scripts (it is
allowed everything). Audit events are kept for 180 days (`PG_CONSOLE_AUDIT_RETENTION`, e.g. `2160h`).

LDAP / SSO later: the API checks credentials through a provider interface (`console/service/internal/auth`),
so an LDAP or OIDC provider is added next to the local one; its groups become attributes.

## Home page

**Home** is the first page after sign-in, and each user has their own. An admin sets it in **Settings → Users**
(the *Home page* button on a user's row): which cards, in which order, and the **start page** (Home or any page in
the menu). Only the cards and pages that user's access policies allow are offered, so an operator without
`audit.view` is never offered the audit log. Users cannot change their own layout; they can keep private notes in
the **My notes** card. The choices are stored with the user's account in the console database.

## Insights (growth, load and forecasts)

**Insights** in the side menu (`insights.view`) answers "how healthy is each cluster, how fast is it growing, what
will it need, by when, and what should I fix?".

With more than one cluster it opens on **All clusters**: every cluster you may see, worst first, with its health
score, nodes up, data size and growth, size in one year, when its disk fills up, busy-hour CPU and main concern, plus
the top risks across all clusters and a data-growth comparison. The summaries are refreshed every hour by the
console (and on demand with the refresh button), so the page opens instantly. Pick one cluster for its tabs:
**Overview** (health score, outlook in plain words, headline numbers, charts), **Capacity planning**, **Findings**,
**Databases & tables**, **Queries** and **Nodes**. **Look ahead** sets how far the forecasts go: 30 days, 3 months,
6 months or 1 year. The print button prints the open tab or saves it as a PDF.

**Health score** = 100 − 25 for each critical finding − 8 for each warning − up to 10 for small tips. 85 and above is
*good*, 60 to 84 *fair*, below 60 *poor*.

Where the numbers come from:

| Source | What | How often |
|---|---|---|
| The console's own sampler | size of every database, transactions, rows read / written, connections, cache hits, temp files, deadlocks | every 5 minutes (`PG_CONSOLE_INSIGHTS_INTERVAL`) |
| | size, live and dead rows of the 30 biggest tables per database | every hour (`PG_CONSOLE_INSIGHTS_TABLES_INTERVAL`) |
| Live, when the page opens | dead rows and wasted space of the 100 biggest tables, unused indexes, long-running queries, transaction ID age, replica lag, settings; top statements from `pg_stat_statements` (if enabled) | on demand |
| The cluster's Prometheus (Monitoring VM, or the URL on the Observability page) | CPU, memory and disk of each node (node_exporter); disk = the filesystem holding the data directory | on demand |

Samples are kept 90 days (`PG_CONSOLE_INSIGHTS_RETENTION`, e.g. `4320h`); `PG_CONSOLE_INSIGHTS_ENABLED=false` turns
sampling off. The sampler connects like the SQL editor does (HAProxy read-write port, the leader).

How the forecasts work, in short:

- The trend is the best straight line through the history (least squares). If the history curves upward (it grows
  by a percentage, like interest), compound growth is used instead, but only when it explains the data clearly
  better (at least halves the error) and there are 7+ days of history.
- Every forecast has a **likely range** (95 %): where the value lands 95 times out of 100 if the trend holds. It
  widens the further ahead it looks. A forecast more than 4 times further ahead than the history behind it is marked
  *rough*, and the confidence (low / medium / high) drops. Compound growth is never projected beyond 1000 × today.
- Load, CPU and memory use the trend of each day's busy hour (95th percentile), not the average.
- The first forecasts appear after one hour of samples; give it about a week to see busy and quiet days, and a few
  weeks before trusting a one-year view.

**Capacity planning** lists every resource with today's value, the value at the end of the look-ahead (and its
range), growth per month, the date it reaches its warning level and its limit, and what is needed:

| Resource | Warning / limit | Needed |
|---|---|---|
| Disk of each node (data directory) | 80 % / full | disk size that keeps 25 % free, rounded up to 10 GB |
| CPU of each node (busy hour) | 75 % / 100 % | vCPUs that keep the busy hour near 65 % |
| Memory of each node | 90 % / 100 % | |
| Connections (busy hour) | 80 % of / `max_connections` | |
| All databases, the biggest databases, transactions per second | trend only | |

Status: **Act** = the limit is reached within the look-ahead, **Watch** = the warning level is, **OK** = neither.
Click a row to see its chart with the forecast range and the expected value in 1, 3, 6 and 12 months.

Also on the page:
- **Findings** (critical / warning / info, with the reason and what to do, SQL to copy): disk filling up,
  CPU or memory running hot, connections near the limit, bloated tables (VACUUM / pg_repack), stale statistics
  (ANALYZE), tables read by full scans (missing index), unused indexes, low cache hit ratio, transaction ID
  wraparound risk, long-running and idle-in-transaction sessions, replica lag, temp files, deadlocks, one statement
  taking most of the time, and `pg_stat_statements` not enabled.

## PostgreSQL logs

**PostgreSQL logs** in the side menu (`logs.view`) reads each node's log directory over SQL (`pg_ls_logdir`,
`pg_read_binary_file`), straight to the node, not through HAProxy. Choose the node and file, load the last 64 KB
to 8 MB, follow it live, filter by level, search and download. Every read is in the audit log.

## Create the VMs (KVM host)

`tools/jumbosql-vms.sh` creates and prepares RHEL 9 VMs and nothing else (no Ansible, no PostgreSQL). Run it as
root on the KVM host:

```bash
./tools/jumbosql-vms.sh --dry-run                       # real checks, prints every action, changes nothing
./tools/jumbosql-vms.sh --name test1                    # combined: 3 VMs (util + 2 DB); --count N for more DB VMs
./tools/jumbosql-vms.sh --name js1 --layout split       # etcd, DB, proxy, backup, monitoring VMs (9, --db 2 for 8)
./tools/jumbosql-vms.sh --list                          # sets made by the script, with roles
./tools/jumbosql-vms.sh --destroy test1                 # unregister from Red Hat and delete the set
```

| Layout | VMs |
|---|---|
| `combined` (default) | `<set>-util` (etcd, HAProxy, PgBouncer, pgBackRest, Prometheus, Alertmanager, Grafana), `<set>-db1..` (etcd, PostgreSQL + Patroni) |
| `split` | `<set>-etcd1..3`, `<set>-pg1..3` (`--db 2..5`), `<set>-proxy` (HAProxy + PgBouncer), `<set>-backrest`, `<set>-monitor` (Prometheus + Alertmanager + Grafana) |

Sizes for `split`: PostgreSQL VMs `RAM_DB=4096 DISK_DB=40G`, monitor `RAM_MON=4096 DISK_MON=40G`, pgBackRest
`DISK_REPO=60G`, etcd and proxy `RAM_SMALL=2048 DISK_SMALL=20G` (about 24 GB RAM in total with 3 DB VMs).
Prometheus, Alertmanager and Grafana stay on one VM: the HA automation connects them through `localhost`. The script writes the VM list with roles to
`/root/jumbosql-<set>-vms.txt`; paste it into **Create cluster → Import VM list** and every VM gets its roles.

It picks free IPs on `192.168.122.0/24` (or `--ips A,B,C`), builds the VMs from the RHEL 9 KVM guest image
(`BASE_IMAGE`, default `/root/rhel-9.8-x86_64-kvm.qcow2`), sets static IPs and DHCP reservations, registers them
with Red Hat (prompted), installs `glibc-langpack-en` and `chrony`, and creates an SSH key for the set
(`/root/.ssh/jumbosql-<set>`). If any step fails, everything that run created is rolled back. The summary prints the
hostnames, IPs, suggested roles and the key to paste into pg_genin. Sizes: `RAM_MB=4096 VCPUS=2 DISK=40G`.

### Demo: an ordinary PostgreSQL 17 setup (to try Discover)

`tools/pg-demo-cluster.sh` builds something pg_genin did **not** deploy: 3 VMs (`jumbosql-vms.sh --layout demo`)
with plain PostgreSQL 17 from the PGDG repository - `<set>-primary` (databases `shop` and `hr` with sample data),
`<set>-standby` (streaming replica through slot `standby_slot`) and `<set>-logical` (subscriber of publication
`shop_pub`, plus a table of its own).

```bash
./tools/pg-demo-cluster.sh --name pgdemo        # asks for the root password and Red Hat registration like jumbosql-vms.sh
./tools/pg-demo-cluster.sh --destroy pgdemo
```

At the end it prints the inventory (`IP:5432` of each VM) and the `dba` user and password, and saves them in
`/root/pg-demo-<set>-inventory.txt` and `/root/pg-demo-<set>.txt` (root only). The VMs need internet access for
the PGDG repository.

## Create a cluster

1. **Clusters → Create cluster**. In **Inventory (virtual machines)** add each VM (hostname, IP) and tick its roles.
   The default is the combined layout: VM 1 = util (etcd, HAProxy, PgBouncer, pgBackRest, Prometheus, Alertmanager, Grafana),
   VM 2 and 3 = etcd + PostgreSQL + Patroni. For VMs from the VM script, click **Import VM list** and paste
   `/root/jumbosql-<set>-vms.txt`. Rules: odd etcd count (3 or 5), at least 2 Patroni nodes, exactly one pgBackRest
   repo, Monitoring on one VM at most (Prometheus, Alertmanager and Grafana reach each other on localhost), HAProxy
   and PostgreSQL never on the same VM (both use 5432).
2. SSH: user `root` and the private key that reaches the VMs (the Ansible VM's key works).
3. Pick the PostgreSQL version and cluster name, then **Create cluster**. Follow the live log under **Operations**.

The VMs must be prepared as for your Ansible runs today: RHEL 9, registered, `glibc-langpack-en`, chrony,
root SSH access, and the HA playbook not yet run on them.

## Backups

The HA automation creates the pgBackRest stanza and takes a first full backup at the end of every deployment.
It only **schedules** backups when `backrest_backup_schedule` is set, so pg_genin sets a default on the pgBackRest
repository VM: **full on Sunday, incremental Monday to Saturday, at 01:00** (VM time zone), run as the PostgreSQL
OS user through the automation's wrapper, which backs up only when Patroni reports a leader. They are systemd
timers (`systemctl list-timers | grep jumbosql-backup` on the repository VM). If your `group_vars` set
`backrest_backup_schedule`, yours is used instead. Check with `pgbackrest info` on the repository VM.

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

**Observability** in the sidebar shows a live dashboard for the chosen cluster (1 hour to 7 days, refreshed every
30 seconds). The console reads it from the cluster's Prometheus on the Monitoring VM (port `9090`), so your browser
doesn't need to reach the VMs for it:

- **Health** (top): cluster state, PostgreSQL instances up and replica lag, etcd members up and leader, machines up,
  firing alerts with their summary, and the age of the last full / incremental backup.
- **Cluster** tab: the machines by role - Database, etcd, Proxy (HAProxy + PgBouncer), Backup (pgBackRest),
  Monitoring (Prometheus, Grafana, Alertmanager) - one entry per VM with each service up or down (when several
  Prometheus jobs scrape the same service on a VM they count once); graphs per node (CPU, memory, fullest disk, load,
  network in / out, disk busy), etcd (database size, WAL fsync, leader changes), HAProxy servers up per backend and
  PgBouncer clients.
- **PostgreSQL** tab: each instance with its Patroni role and services, and graphs for connections (with
  `max_connections`), transactions per second, replication lag, cache hit ratio, database size and deadlocks.

Exporters differ between setups (postgres_exporter, pgMonitor's `ccp_*` metrics, ...): each graph tries the usual
metric names and shows "Not collected by this Prometheus" when none exist. Nodes are named from the cluster's
inventory.

The **Grafana / Prometheus / Alertmanager** buttons open those tools (`:3000`, `:9090`, `:9093` on the Monitoring
VM); for those your browser must reach the VMs - through an SSH tunnel, use a SOCKS proxy
(`ssh -D 1080 root@<kvm-host>`). **Edit URLs** changes the addresses per cluster (also used by the dashboard and
Insights).

## Repository layout

| Path | What |
|---|---|
| `console/ui` | React UI. pg_genin code: `shared/lib/haInventory.ts` (inventory model and rules), `entities/cluster/database-servers-block` (inventory step), `widgets/patroni-console`, `pages/observability`, `widgets/users-table`, `pages/login`, `shared/theme` |
| `console/service` | Go API. pg_genin code: `internal/auth` (sign-in, sessions, providers), `internal/controllers/auth`, `internal/controllers/user`, `pkg/patroni/actions.go`, `internal/controllers/cluster/patroni_*.go`, `middleware/authorization.go`, `internal/policy` (policy engine), `internal/access` (routes, audit), `internal/insights` (sampler, forecasts, recommendations), `pkg/sqlroles` (data scope roles), `pkg/pglogs` |
| `console/db/migrations` | console database; `20261005150000_jumbosql_users.sql` adds users and sessions |
| `automation-ha` | the HA automation image: entrypoint, inventory check and conversion, wrapper playbook, pack script |
| `automation` | Autobase's own automation (unused by pg_genin, kept for upstream merges) |
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
