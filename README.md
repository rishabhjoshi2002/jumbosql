<p align="center">
  <img src="console/ui/src/shared/assets/pgMantraLogo.png" alt="KeenPG" width="220">
</p>

# KeenPG: A Keen Eye on Your Postgres

A web console for building and running highly available PostgreSQL clusters (Patroni, etcd, HAProxy,
PgBouncer, pgBackRest, Prometheus/Grafana) on your own virtual machines, using your licensed HA Ansible
collection (version **2.2.0**). Based on [Autobase](https://github.com/autobase-tech/autobase) (MIT).

| Area | What you get |
|---|---|
| **Sign-in** | Username and password, users with **attributes** (group, team, region, …) managed in **Settings → Users**. Accounts are stored in the console today; LDAP and SSO plug in later on the server side. |
| **Access policies (ABAC)** | **Settings → Access policies**: who (everyone, users, attribute conditions) may do what (permissions), where (clusters, environments, projects), with which data (databases, schemas, tables, hidden columns, row and time limits) and when (IP ranges, weekdays, hours). Deny wins, nothing is allowed by default. **Test access** shows what a user may do and which policy decides it. |
| **Audit log** | Every change, SQL statement, log read, sign-in and refused request: who, when, from which IP, on which cluster, with what result. Filters, search, details per event. |
| **Home page** | Everyone has their own: a greeting and the cards an admin picks and orders for them in Settings → Users (clusters summary, top risks, data growth, my clusters, recent queries, recent operations, shortcuts, private notes), limited to what their access allows, and the page that opens after sign-in. |
| **Discover** | Map any PostgreSQL setup the console can reach, with just an inventory and a database login: primary, streaming and logical replicas, failover manager, every server's details, as a diagram. |
| **Insights** | A health score (0-100) per cluster and an **All clusters** summary (worst first). Forecasts 30 days, 3 months, 6 months or 1 year ahead with a likely range: storage, disks, CPU, memory, connections, load and the biggest databases, with the date each one reaches its warning level and its limit and what to buy (vCPUs, disk size). Plus table bloat, unused indexes, top queries and a list of recommendations with the SQL. Print / save as PDF for management. |
| **PostgreSQL logs** | Each node's server log in the browser: pick cluster, node and file, live tail, level filter (WARNING+/ERROR+), search with highlighting, download. |
| **Create cluster** | **Inventory step**: add each VM (or **Import VM list** from the VM script), tick its roles (etcd, PostgreSQL + Patroni, HAProxy, PgBouncer, pgBackRest repo, Monitoring = Prometheus + Alertmanager + Grafana). One VM can hold one role or several. Live `inventory.yml` preview and download; the layout rules are checked as you type. |
| **Patroni console** | On each cluster page: `list`, `history`, `show-config`, `edit-config`, `pause`/`resume`, `switchover`, `failover`, `restart`, `reload`, `reinit` and a **rolling restart**. Every result shows the equivalent `patronictl` command. |
| **Observability** | A live monitoring dashboard per cluster from its Prometheus: cluster / PostgreSQL / etcd / services health, firing alerts, last backup, and graphs for connections, TPS, replication lag, cache hit, database size, CPU, memory, disk, load, network and etcd. Links to Grafana, Prometheus and Alertmanager (URLs can be overridden per cluster). |
| **SQL editor** | Built-in, pgAdmin-style query tool: object browser (schemas, tables with columns, views, functions, sequences), query tabs, every statement's result (also `SHOW`, `EXPLAIN`, `RETURNING`), Messages with notices and errors (SQLSTATE, detail, hint, position marked in the editor), Explain / Explain analyze, Cancel, CSV export, query history. Runs through HAProxy's read-write port, so always on the current Patroni leader. Follows the access policies: read-only / read-write / admin, only allowed databases, hidden columns and tables locked in the object browser, row and time limits. |
| **Branding** | KeenPG look (navy and logo blue) with the KeenPG logo, and a light watermark on every page: *KeenPG, managed by Keen & Able Computers Pvt. Ltd.* |

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
runs as a database role KeenPG creates per scope (`jsql_<hash>`), with `SELECT` (and for write access
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

## Discover (map any PostgreSQL setup)

**Discover** in the side menu (`discover.run`, given to Administrators) looks at PostgreSQL servers that KeenPG did
not build - any client, any layout - as long as the console can reach them. Give it:

- the **inventory**: one server per line (`host`, `host:port` or `host port`), or a whole **Ansible inventory**
  (INI or YAML, e.g. the one a CPA / Autobase cluster was deployed from) - its groups (`master`, `replica`,
  `balancers`, `etcd_cluster`, ...) say what each machine is meant to be, and `ansible_host`, `ansible_port`,
  `hostname` and `postgresql_port` are used;
- one **database login** for all of them (a superuser shows everything; a role with `pg_monitor` and
  `pg_read_all_settings` shows almost everything). The servers' `pg_hba.conf` must allow the console's IP.

- optionally, an **SSH login** (password or private key). Prometheus is found automatically (the one that
  scrapes the machines); nothing to type.

**One address is enough.** Give only the PostgreSQL primary (with the database login and one SSH login) and
Discover finds the rest by following its connections: its standbys and logical subscribers, its clients
(HAProxy, PgBouncer), the Patroni members and the etcd they use, the Prometheus that scrapes it, the servers in
the HAProxy / nginx / PgBouncer / keepalived / pgBackRest / Prometheus configs, and the established TCP
connections on the known ports (`ss`). Each new machine is probed the same way, round after round (up to 60
machines). Application servers that only connect to PostgreSQL are listed as clients, not followed. Where the
SSH login does not work, a pop-up asks for the logins of those machines (one for all, or one each) and Discover
runs again; they are used for that run only and never saved. KeenPG's own address as the machines see it
(the SSH client address, often a NAT gateway such as `192.168.122.1`) and their default gateway are ignored:
those connections are Discover's own probes, not part of the setup. If PostgreSQL cannot be reached, the summary
says why (e.g. "wrong database user or password").

The diagram shows the traffic path (grey arrows) and, by colour, the connections it saw, in groups that can be
switched on and off: **Data Path** (replication, PgBouncer, balancer routes - on by default), **Cluster Control**
(etcd, Patroni), **Monitoring**, **Backup**. Pointing at a machine shows all of its connections, with the port.

It looks at every machine at once and only reads: open ports and the HTTP endpoints that say what and which
version they are (Prometheus, Alertmanager, Grafana, etcd, Consul, Patroni, HAProxy stats, exporters, nginx /
HAProxy `Server` headers); with SSH, the installed packages, running services, listening programs, Docker
containers and extracts of the HAProxy, nginx, keepalived, Patroni, PgBouncer, etcd, pgBackRest and Prometheus
configs (passwords filtered out; the SSH secret is used for this run only and never saved); then the database
logins (catalog views and settings). It works out:

| | |
|---|---|
| **Machines** | what runs where - virtual IP (keepalived, vip-manager), load balancer (HAProxy, nginx, Pgpool-II - so a cluster whose HAProxy was replaced by nginx shows nginx), pooler (PgBouncer, Odyssey), PostgreSQL, HA (Patroni, repmgr, pg_auto_failover), HA store (etcd, Consul, ZooKeeper), backup (pgBackRest, Barman, WAL-G), monitoring (Prometheus, Grafana, Alertmanager, exporters), Docker / Podman - each with version, package name, ports and how it was found; OS, CPUs, RAM, disks; balancer routes (port → servers) and VIPs |
| **Roles** | primary, streaming standby (and cascading), logical replica, standalone; servers that could not be reached and why (refused, wrong password, pg_hba) |
| **Links** | who streams from whom (sync/async, slot, lag), who subscribes to which publication, upstreams and clients that are not in the inventory |
| **HA and tools** | Patroni (its REST API on 8008/8009), repmgr, pg_auto_failover, Citus, pglogical, BDR/PGD, pgBackRest / WAL-G / Barman archiving |
| **Per server** | version, uptime, system identifier, timeline, connections, key settings, databases (size, tables, extensions, publications), replication slots, subscriptions, users and roles |
| **Findings** | unreachable servers, standbys not streaming, unused slots keeping WAL, lag, split brain (two writable copies of one cluster), old versions, disabled subscriptions, no failover manager |

The result has five views:

- **Architecture**: the machines in lanes, in the order a connection travels (VIP → load balancer → pooler →
  PostgreSQL, then HA store, backup, monitoring) with arrows along the balancer routes; a machines table, a
  components / versions / packages table (CSV), each machine's packages, listening ports and disks, the balancer
  routes and the Prometheus targets.
- **PostgreSQL**: a diagram (one frame per physical cluster, solid arrows for streaming, dashed for logical
  replication), a plain-words summary, findings, and the details of each server.
- **Databases & migration**: a readiness table of every database on the writable servers, and a database explorer
  with everything inside each database - tables (rows, data / index / TOAST size, primary key, replica identity,
  dead rows, last vacuum), indexes (method, size, unique, scans, unused, invalid, definition), schemas, views and
  materialized views, functions and procedures (language, security definer), sequences (how full), foreign keys
  (with or without an index), enums / domains / composite types, triggers, foreign servers, column types in use and
  extensions - plus a **readiness checklist**: tables without a primary key or replica identity, unlogged tables,
  large objects, sequences, materialized views, triggers, untrusted languages, tablespaces, collation, invalid
  indexes, transaction ID age. Every list sorts, searches and exports to CSV.
- **Query**: 34 ready-made queries (sizes, readiness, indexes, health, activity, replication, users and security)
  in a drop-down, or your own. Only reading statements run (`SELECT`, `WITH`, `SHOW`, `EXPLAIN`, `TABLE`,
  `VALUES`), one at a time, inside a `READ ONLY` transaction with a 30-second limit; functions that act on the
  server (`pg_terminate_backend`, `pg_reload_conf`, replication slot functions, `dblink`, file access, ...) are
  refused, and every query is written to the audit log. For extra safety use a login with only `pg_monitor` and
  `pg_read_all_data`.
- **Sizing & cost**: from the node_exporter history in Prometheus (7 to 90 days), each machine's CPU, memory and
  disk peaks (95th percentile) and forecast, and what it should have for the next 90 / 180 / 365 days: vCPUs so
  the busiest hour stays under 65 %, RAM with 20 % head-room, disk under 75 % full, with minimums per role; the
  status (right size, too small, too big), the trend charts, and the monthly / yearly cost now and recommended at
  prices you type in (per vCPU, GB of RAM and GB of disk). Without Prometheus it works from the current hardware.
  Then PostgreSQL settings that fit each server's memory and CPUs (shared_buffers, effective_cache_size, work_mem,
  maintenance_work_mem, WAL, checkpoints, planner costs, parallel workers, huge pages, WAL compression) compared
  with what it runs now, and a ready `ALTER SYSTEM` script (servers under Patroni: `patronictl edit-config`).

Results can be saved (passwords never are), opened again, downloaded as JSON or printed. To try it, build the demo setup with `tools/pg-demo-cluster.sh` (above).

## Upgrades (admins)

**Upgrades** (in the sidebar, `upgrade.run`, given to Administrators) upgrades one component at a time -
PostgreSQL (minor version), Patroni, etcd, HAProxy, keepalived, PgBouncer, pgBackRest, vip-manager, node_exporter,
postgres_exporter, Prometheus, Alertmanager, Grafana - on **any cluster**. One **Cluster** list holds every cluster:
those **Found By Discover** (any setup, whoever built it: the machines and what runs on each come from Discover)
and those **Created By KeenPG** (with their inventory and stored SSH secret). Give the SSH login for the nodes
(used for that run only, never saved).

The steps are shown on top: Dry Run → Review → Upgrade → Rollback (If Needed). The step going on is dark, finished
steps turn green, the next ones stay grey. When a run starts the form is hidden and the screen splits in two:
**Live Progress** (the runner container, a line to each node, and on each node its steps - keep old version,
install, restart, health check - ticking as they finish) and the **Ansible Log**. If anything fails: **Roll Back
Now** (one click) or **Try Again** (back to the form to change the settings).

KeenPG's own playbook does the work (`automation-ha/upgrade/`: plain Ansible, no vendor collection). It runs in
the **upgrade runner** image `pg_mantra/upgrader:1.0`, built by `./build.sh console` (or `./build.sh upgrader`);
the deployment image (`./build.sh automation`) is not needed for upgrades.

**Packages from your own repository**: give its address (a yum/dnf `baseurl`, or a full `deb ...` line). It is
added on the nodes for each step and removed after, optionally as the only source and with GPG checks; empty
means the repositories the nodes already have.

1. **Dry run** - changes nothing: on every node of the component, what is installed, the version that would be
   installed (newest available, or the target version you give), the role (Patroni, or the PostgreSQL primary /
   standby), services, free disk; then **what will happen** node by node and the **rollback plan**. Nodes that
   cannot be reached are shown, and the upgrade is only offered when every node could be checked.
2. **Upgrade** (after a successful dry run) - one node at a time, standbys first: with Patroni, a switchover moves
   the primary role to an upgraded standby before the old primary is done, and Patroni is paused while it restarts;
   without Patroni the PostgreSQL service itself is restarted (the primary last). On each node: keep the installed
   version (the .rpm / .deb files, pip wheel or binaries, the config files - the usual places plus the ones the node
   really uses: `SHOW config_file` / `hba_file`, Patroni's config, pgBackRest's `--config`, the files the running
   service was started with - and a manifest in
   `/var/lib/pg_mantra/upgrade/<run>/<component>/`), install, restart, wait until healthy. It stops at the first
   node that fails; the others are not touched. If the old package cannot be kept, it stops before changing
   anything, unless you allow it.
3. **Roll back** (after an upgrade, even a failed one) - same order: put the kept versions back (from the saved
   files, else the repository), optionally restore the config files, restart, wait until healthy.

The runner's log is shown live, and each node's result (before / after versions, what was kept) is stored.

## Ansible Playbooks (admins)

**Ansible Playbooks** (in the sidebar) is a separate page for **your own** Ansible playbooks, saved by name and
run in the same runner container on any machines you choose.

**Add a playbook** (saved in the console) with the **Add Playbook** drop-down: **Write Or Paste YAML**, **Upload An
Archive**, or **From GitHub**:
- the **upgrade playbook** and, optionally, the **rollback playbook**: paste the YAML, or upload an archive
  (`.tar.gz` / `.tgz` / `.zip` with roles, templates, files, group_vars...) and give the playbooks' paths in it;
- the **inputs** KeenPG asks before each run (target version, repository, a password...). Each input becomes
  an Ansible variable. Types: text, password (never saved), number, yes/no, choice, long text;
- the **groups** your plays use (`hosts:`), filled with the machines where Discover found a component (e.g.
  `pgbouncer_nodes` = the machines with PgBouncer);
- or **From GitHub**: the repository (`https://github.com/owner/repo`, `owner/repo`, or a GitHub Enterprise
  address) and a branch / tag. It is pulled when you save (the commit is shown); **Pull Latest** pulls it again.
  For a private repository give an access token: it is used for that pull only and never saved. The console
  needs to reach GitHub (`api.github.com`, or your GitHub Enterprise server);
- optionally a `requirements.yml`. `ansible.posix`, `community.general` and `community.postgresql` are already in
  the image.

**Run it**:
1. Choose the machines: **IP Addresses** (type them, one per line - every group of the playbook gets all of them),
   a **Cluster** (created or discovered; you can limit it to some hosts), or **My Inventory** (INI or YAML).
2. Fill the inputs, the **Username** and **Password** (used for that run only, never saved). Under *More Options*:
   SSH key, sudo password, Ansible Vault password, extra variables, `-vv`.
3. **Dry run** = `ansible-playbook --check --diff`: nothing is changed. It shows, per host, what would change.
4. **Run The Playbook** (after a dry run) on the same machines with the same inputs.
5. **Roll Back** (after a run, even a failed one - **Roll Back Now** appears as soon as a run fails) runs the
   rollback playbook. **Try Again** goes back to the form to change the inputs.

The same split screen as Upgrades shows each machine live (its current task, tasks done, changes, the error)
next to the Ansible log.

The playbooks also get `pgm.action` (`plan` / `run` / `rollback`), `pgm.run_id` and `ansible_check_mode`.
`pgm.run_id` is the id of the upgrade that a rollback undoes, so an upgrade can keep its backups under it
(e.g. `/var/lib/pg_mantra/custom/{{ pgm.run_id }}/`) and the rollback can find them. *Fill with an example* in the
editor shows such a pair: PgBouncer, one node at a time.

The live log, the per-host results (changed tasks, counts, the first error) and the history are kept for each
playbook.

## PostgreSQL logs

**PostgreSQL logs** in the side menu (`logs.view`) reads each node's log directory over SQL (`pg_ls_logdir`,
`pg_read_binary_file`), straight to the node, not through HAProxy. Choose the node and file, load the last 64 KB
to 8 MB, follow it live, filter by level, search and download. Every read is in the audit log. The directory and
file names come from PostgreSQL itself (`log_directory`, `pg_current_logfile()`), so a renamed or moved log is always
followed; when `logging_collector` is off the page says where the log goes instead (`log_destination`).

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
hostnames, IPs, suggested roles and the key to paste into KeenPG. Sizes: `RAM_MB=4096 VCPUS=2 DISK=40G`.

### Demo: an ordinary PostgreSQL 17 setup (to try Discover)

`tools/pg-demo-cluster.sh` builds something KeenPG did **not** deploy: 3 VMs (`jumbosql-vms.sh --layout demo`)
with plain PostgreSQL 17 from the PGDG repository - `<set>-primary` (databases `shop` and `hr` with sample data),
`<set>-standby` (streaming replica through slot `standby_slot`) and `<set>-logical` (subscriber of publication
`shop_pub`, plus a table of its own).

```bash
./tools/pg-demo-cluster.sh --name pgdemo        # asks for the root password and Red Hat registration like jumbosql-vms.sh
./tools/pg-demo-cluster.sh --destroy pgdemo
```

A second layout, `--layout cross` (4 VMs, `jumbosql-vms.sh --layout demo-cross`), builds **two HA clusters linked by
logical replication in both directions**: cluster A (`a-primary` + a **synchronous** streaming standby) sends
customers, products and orders to cluster B (`b-primary` + an asynchronous standby), and B sends its `daily_sales`
back to A's `analytics` database.

```bash
./tools/pg-demo-cluster.sh --layout cross --name pgcross   # smaller VMs: RAM_MB=2048 DISK=20G unless set
./tools/pg-demo-cluster.sh --destroy pgcross
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
It only **schedules** backups when `backrest_backup_schedule` is set, so KeenPG sets a default on the pgBackRest
repository VM: **full on Sunday, incremental Monday to Saturday, at 01:00** (VM time zone), run as the PostgreSQL
OS user through the automation's wrapper, which backs up only when Patroni reports a leader. They are systemd
timers (`systemctl list-timers | grep jumbosql-backup` on the repository VM). If your `group_vars` set
`backrest_backup_schedule`, yours is used instead. Check with `pgbackrest info` on the repository VM.

### Backup & Restore page (admins)

**Backup & Restore** (in the sidebar, `backup.run`) manages pgBackRest for **any** cluster: one created by KeenPG (its saved SSH
secret is used) or one found by Discover (give an SSH login; it is used for that call only and never saved). It
reads every node with pgBackRest over SSH (root, `sudo -n`, or `sudo` with the SSH password) and shows:

- **Recoverable Window**: from the end of the oldest backup that can still be restored to the last archived WAL;
  **Data At Risk**: WAL written on the primary but not archived yet (set `archive_timeout`, e.g. 60s);
  last backup, backups and repository size, free space in the repository;
- the **Recovery Timeline** (backups as dots, the window as a band) and the backups list. After a point-in-time
  restore, backups left on the old timeline are marked **Old Timeline** and never used;
- issues: archiving off or failing, no stanza, no recent backup, no schedule, config different between nodes.

Nothing is assumed about names, paths or ports - everything is **found on the node**:

- **pgBackRest's config**: from the options pgBackRest is really started with - the primary's `archive_command`, a
  standby's `restore_command`, running `pgbackrest` processes, cron and systemd units, `PGBACKREST_CONFIG*` - so a
  renamed or moved file (`--config=/etc/pgbackrest/prod.conf`, `--config-path`) is found, and every command the page
  runs uses that same config. It follows pgBackRest's own rules: `conf.d/*.conf` is read only where pgBackRest reads
  it (not with `--config` alone). The **Nodes** tab and the Configuration tab say which file was used and how it was
  found;
- **PostgreSQL**: every running server is found from its process (its data directory, then port and socket from
  `postmaster.pid`), not from port 5432; then PostgreSQL itself is asked: `SHOW config_file`, `hba_file`,
  `ident_file`, `data_directory`, `log_directory`, `log_filename`, `logging_collector`. A stopped server (during a
  restore) is handled with what was found before it was stopped. A config outside the data directory (Debian) is
  handled too;
- the stanza: from the config, else the repository, else `archive_command`, cron or systemd. A Patroni config given as
  a directory is read too, and backup jobs kept as **systemd timers** count as a schedule. If the stanza is not in the
  repository yet, the page shows **Create Stanza**;
- secrets (`repo*-s3-key`, `cipher-pass` ...) never leave the nodes: they are shown as `********`, and an edited
  config keeps each node's own value where it still says `********`.

**Repositories** (several at once): every `repo1`, `repo2` ... of any type - a disk, **S3 / MinIO**, **Azure**, **GCS**,
**SFTP**, CIFS - with its status, backups, size, last backup and free space. **Add Repository** writes it as its own
file (`conf.d/pgm-repo<N>.conf`, or a marked block in the main config where pgBackRest reads only that) on every node,
then creates the stanza in it and checks; if that fails, every node is put back as it was. On a layout with a
repository server, a new disk repository lives on that server and the database nodes reach it through it; cloud
repositories are written to directly by every node. **Remove** takes out a repository added here (its backups stay
in the storage). Backups, schedules and restores can pick the repository (**Default** = repo1, restore **Best
Available** = pgBackRest's choice; a chosen backup set is restored from the repository that holds it).

**Running backups** started outside the console - by a cron or systemd timer schedule, or by hand on a node - are
seen by the console (every 45 s while someone is signed in): everyone who may run backups gets a **popup**, also right
after signing in, and its **Watch Live** button opens the Backup & Restore page with the backup running live
(animated, with its progress where pgBackRest reports it). For a setup found by Discover the console uses the login
last given on its page, kept in memory only (gone after 12 hours or a restart).

Actions (run in the runner container with `automation-ha/upgrade/pgm-backup.yml`, kept in **History** with their
log, shown live next to the Ansible log):

- **Backup Now** (full, differential, incremental) on the primary (or the repository server), to the repository
  chosen, **Check**, **Create Stanza**;
- **Add / Remove Repository** (see above);
- **Configuration**: edit `pgbackrest.conf` (or a `conf.d` file) from one node and apply it to every node of the same
  kind (database nodes, or the repository server - their configs differ on purpose). Each node keeps its own
  `pg1-path`, port, socket and host; the old file is saved next to it (`pgbackrest.conf.pgm-<job>`), the new one is
  checked with `pgbackrest check`, and if that fails the old config is put back on every node;
- **Schedule**: full / differential / incremental cron times, written to `/etc/cron.d/pg_mantra_pgbackrest` on every
  node. Only the node that is primary at that moment backs up, so the schedule follows a failover;
- **Restore** to **Latest**, a **Point In Time** inside the window, or a **Backup Set** as it was taken. Type the
  cluster name to confirm. Optionally a backup first; replicas are stopped, the primary is restored and promoted
  (with Patroni: Patroni is stopped, the old cluster state is removed from the DCS, then started again), the
  replicas are rebuilt from the same backup, replication slots are created again, and a new **full backup** is
  taken (on by default) so the next restore has a base on the new timeline. Each node keeps its own
  `postgresql.conf`, `pg_hba.conf` and replication settings.

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
| `console/ui` | React UI. KeenPG code: `shared/lib/haInventory.ts` (inventory model and rules), `entities/cluster/database-servers-block` (inventory step), `widgets/patroni-console`, `pages/observability`, `widgets/users-table`, `pages/login`, `shared/theme` |
| `console/service` | Go API. KeenPG code: `internal/auth` (sign-in, sessions, providers), `internal/controllers/auth`, `internal/controllers/user`, `pkg/patroni/actions.go`, `internal/controllers/cluster/patroni_*.go`, `middleware/authorization.go`, `internal/policy` (policy engine), `internal/access` (routes, audit), `internal/insights` (sampler, forecasts, recommendations), `pkg/sqlroles` (data scope roles), `pkg/pglogs` |
| `console/db/migrations` | console database; `20261005150000_jumbosql_users.sql` adds users and sessions |
| `automation-ha` | the HA automation image: entrypoint, inventory check and conversion, wrapper playbook, pack script |
| `automation` | Autobase's own automation (unused by KeenPG, kept for upstream merges) |
| `build.sh` | builds and runs everything |
| `tools/jumbosql-vms.sh` | creates and prepares RHEL 9 VMs on the KVM host for a cluster |

## Tests

```bash
cd console/ui && yarn vitest run                      # inventory rules, rolling-restart plan, observability links, ...
cd console/service && make swagger && go test ./...   # auth, roles, Patroni client, ...
python3 -m unittest automation-ha/upgrade/test_pgm_backup.py   # backup helper: secrets, repositories, config blocks
```

## Licence

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Open-source components and their licenses:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The HA Ansible collection used by the automation is licensed
separately by its vendor and is not part of this repository. Upstream documentation: [AUTOBASE-README.md](AUTOBASE-README.md).
