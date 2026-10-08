#!/usr/bin/env bash
#
# pg-demo-cluster.sh - a small, ordinary PostgreSQL 17 setup on 3 KVM VMs, to try pg_genin's Discover panel
#                      on something pg_genin did NOT build (no Patroni, no etcd, no HAProxy):
#
#       <set>-primary  ── streaming (physical) replication ──►  <set>-standby   read-only hot standby
#             │
#             └──────── logical replication (shop_pub) ───────►  <set>-logical   own read-write server,
#                                                                                 copies 3 tables of "shop"
#
#   primary : databases shop (customers, products, orders, order_items, payments, ...) and hr (departments,
#             employees), publication shop_pub, physical replication slot standby_slot; plus things a migration
#             review should flag: a table without a primary key, an unlogged table, an enum, a trigger,
#             a materialized view and a large object
#   standby : pg_basebackup copy of the primary, follows it through standby_slot
#   logical : its own cluster; database shop gets customers, products, orders through subscription shop_sub,
#             plus a local table (daily_sales) that only exists here
#
# Usage (as root on the KVM host, next to jumbosql-vms.sh):
#   ./pg-demo-cluster.sh [--name SET]          create the 3 VMs (jumbosql-vms.sh --layout demo) and set them up
#   ./pg-demo-cluster.sh --name SET --skip-vms set up VMs that jumbosql-vms.sh --layout demo already made
#   ./pg-demo-cluster.sh --destroy SET         delete the VMs (same as jumbosql-vms.sh --destroy SET)
#
# Passwords (env, else generated): DBA_PASSWORD (user dba, superuser - for pg_genin Discover),
# REPL_PASSWORD (user replicator). They are printed at the end and saved to /root/pg-demo-<set>.txt (root only).
# Re-running on the same VMs is safe: each step checks what is already there.

set -Eeuo pipefail
export LC_ALL=C LANG=C

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VMS_SCRIPT="${VMS_SCRIPT:-$HERE/jumbosql-vms.sh}"
PG_MAJOR=17
PGBIN=/usr/pgsql-$PG_MAJOR/bin
PGDATA=/var/lib/pgsql/$PG_MAJOR/data
PGDG_RPM="https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes
          -o ConnectTimeout=10 -o ServerAliveInterval=30)

SET_NAME="" SKIP_VMS=0 STEP_NO=0
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
step() { STEP_NO=$((STEP_NO + 1)); printf '\n\033[1;36m[%02d] %s\033[0m\n' "$STEP_NO" "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }
trap 'die "step $STEP_NO failed at line $LINENO (see the output above)"' ERR

# run a script as root on a VM: on IP 'script' (env vars are passed in front of it)
on() { local ip=$1; shift; ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "root@$ip" "bash -Eeuo pipefail -s" <<<"$*"; }
# run SQL as postgres on a VM: psql_on IP DB 'SQL'
psql_on() {
  local ip=$1 db=$2 sql=$3
  ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "root@$ip" \
    "cd /tmp && sudo -u postgres env PGOPTIONS='-c client_min_messages=warning' $PGBIN/psql -X -q -v ON_ERROR_STOP=1 -d $db" <<<"$sql"
}
q() { printf "%s" "${1//\'/\'\'}"; }   # quote for a SQL string literal

# no pipe: with pipefail, "tr </dev/urandom | head" fails when head closes the pipe
gen_pw() { local p; p=$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 600 /dev/urandom)); printf '%s' "${p:0:20}"; }

# ---------------------------------------------------------------------------------------------------------
main() {
  while (( $# )); do
    case $1 in
      --name)     SET_NAME=${2:?--name needs a value}; shift ;;
      --skip-vms) SKIP_VMS=1 ;;
      --destroy)  exec "$VMS_SCRIPT" --destroy "${2:?--destroy needs a set name}" ;;
      -h|--help)  usage; exit 0 ;;
      *)          echo "Unknown option: $1"; usage; exit 2 ;;
    esac
    shift
  done
  [[ $EUID -eq 0 ]] || die "run this script as root on the KVM host"
  SET_NAME=${SET_NAME:-pgdemo}
  [[ $SET_NAME =~ ^[a-z0-9][a-z0-9-]{0,20}$ ]] || die "--name: lowercase letters, digits and '-', max 21"

  if (( ! SKIP_VMS )); then
    step "Create 3 VMs with jumbosql-vms.sh (layout demo, set $SET_NAME)"
    [[ -x $VMS_SCRIPT ]] || die "$VMS_SCRIPT not found (keep both scripts in the same folder)"
    "$VMS_SCRIPT" --layout demo --name "$SET_NAME"
  fi

  step "Read the VM list"
  local list=/root/jumbosql-$SET_NAME-vms.txt
  SSH_KEY=/root/.ssh/jumbosql-$SET_NAME
  [[ -r $list ]] || die "$list not found - create the VMs first (without --skip-vms)"
  [[ -r $SSH_KEY ]] || die "$SSH_KEY not found"
  P_NAME=$(awk '!/^#/ && $1 ~ /-primary$/ {print $1}' "$list"); P_IP=$(awk '!/^#/ && $1 ~ /-primary$/ {print $2}' "$list")
  S_NAME=$(awk '!/^#/ && $1 ~ /-standby$/ {print $1}' "$list"); S_IP=$(awk '!/^#/ && $1 ~ /-standby$/ {print $2}' "$list")
  L_NAME=$(awk '!/^#/ && $1 ~ /-logical$/ {print $1}' "$list"); L_IP=$(awk '!/^#/ && $1 ~ /-logical$/ {print $2}' "$list")
  [[ -n $P_IP && -n $S_IP && -n $L_IP ]] || die "$list must list <set>-primary, -standby and -logical (use --layout demo)"
  SUBNET_CIDR="${P_IP%.*}.0/24"
  ok "primary $P_IP   standby $S_IP   logical $L_IP   (network $SUBNET_CIDR)"

  local secrets=/root/pg-demo-$SET_NAME.txt
  if [[ -r $secrets ]]; then   # re-run: keep the passwords already in use
    DBA_PASSWORD=${DBA_PASSWORD:-$(awk -F= '$1=="DBA_PASSWORD"{print $2}' "$secrets")}
    REPL_PASSWORD=${REPL_PASSWORD:-$(awk -F= '$1=="REPL_PASSWORD"{print $2}' "$secrets")}
  fi
  DBA_PASSWORD=${DBA_PASSWORD:-$(gen_pw)}
  REPL_PASSWORD=${REPL_PASSWORD:-$(gen_pw)}
  ( umask 077; printf 'DBA_PASSWORD=%s\nREPL_PASSWORD=%s\n' "$DBA_PASSWORD" "$REPL_PASSWORD" >"$secrets" )

  install_pg
  setup_primary
  setup_standby
  setup_logical
  verify
  summary
}

# ---------------------------------------------------------------------------------------------------------
install_pg() {
  local ip
  for ip in "$P_IP" "$S_IP" "$L_IP"; do
    step "Install PostgreSQL $PG_MAJOR on $ip"
    on "$ip" "
      if ! rpm -q postgresql$PG_MAJOR-server >/dev/null 2>&1; then
        rpm -q pgdg-redhat-repo >/dev/null 2>&1 || dnf -y -q install '$PGDG_RPM'
        dnf -y -q module disable postgresql >/dev/null 2>&1 || true
        dnf -y -q install postgresql$PG_MAJOR-server postgresql$PG_MAJOR-contrib
      fi
      if systemctl is-active -q firewalld; then
        firewall-cmd -q --permanent --add-service=postgresql && firewall-cmd -q --reload
      fi
      $PGBIN/postgres --version"
    ok "installed"
  done
}

# settings and access rules every node gets (the standby inherits them through pg_basebackup)
common_conf() {
  cat <<EOF
cat >$PGDATA/conf.d/pg_demo.conf <<'CONF'
# pg-demo-cluster.sh
listen_addresses = '*'
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
hot_standby = on
password_encryption = 'scram-sha-256'
shared_preload_libraries = 'pg_stat_statements'
log_line_prefix = '%m [%p] %q%u@%d '
cluster_name = '\$(hostname -s)'
CONF
grep -q "^include_dir = 'conf.d'" $PGDATA/postgresql.conf || echo "include_dir = 'conf.d'" >>$PGDATA/postgresql.conf
grep -q 'pg-demo-cluster' $PGDATA/pg_hba.conf || cat >>$PGDATA/pg_hba.conf <<'HBA'
# pg-demo-cluster.sh: the demo network (other nodes and the pg_genin console)
host    all             all             $SUBNET_CIDR          scram-sha-256
host    replication     replicator      $SUBNET_CIDR          scram-sha-256
HBA
EOF
}

init_node() {   # initdb (if needed) + common settings + start
  local ip=$1
  on "$ip" "
    if [[ ! -s $PGDATA/PG_VERSION ]]; then PGSETUP_INITDB_OPTIONS='--data-checksums' $PGBIN/postgresql-$PG_MAJOR-setup initdb >/dev/null; fi
    install -d -o postgres -g postgres -m 700 $PGDATA/conf.d
    $(common_conf)
    sed -i \"s/^cluster_name = .*/cluster_name = '\$(hostname -s)'/\" $PGDATA/conf.d/pg_demo.conf
    chown -R postgres:postgres $PGDATA/conf.d
    systemctl enable -q postgresql-$PG_MAJOR
    systemctl restart postgresql-$PG_MAJOR"
}

setup_primary() {
  step "Primary ($P_NAME): settings, users, demo data, publication, replication slot"
  init_node "$P_IP"
  psql_on "$P_IP" postgres "
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dba') THEN CREATE ROLE dba LOGIN SUPERUSER; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replicator') THEN CREATE ROLE replicator LOGIN REPLICATION; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user LOGIN; END IF;
END \$\$;
ALTER ROLE dba PASSWORD '$(q "$DBA_PASSWORD")';
ALTER ROLE replicator PASSWORD '$(q "$REPL_PASSWORD")';
ALTER ROLE app_user PASSWORD '$(q "$DBA_PASSWORD")';
SELECT 'CREATE DATABASE shop OWNER app_user' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'shop') \\gexec
SELECT 'CREATE DATABASE hr OWNER app_user' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hr') \\gexec
SELECT pg_create_physical_replication_slot('standby_slot') WHERE NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = 'standby_slot');
"
  psql_on "$P_IP" shop "
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SET ROLE app_user;
CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL, city text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY, sku text UNIQUE NOT NULL, name text NOT NULL, category text, price numeric(10,2) NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers, status text NOT NULL DEFAULT 'new',
  ordered_at timestamptz NOT NULL DEFAULT now(), total numeric(12,2) NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS order_items (
  order_id bigint REFERENCES orders ON DELETE CASCADE, product_id int REFERENCES products, qty int NOT NULL,
  price numeric(10,2) NOT NULL, PRIMARY KEY (order_id, product_id));
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);
CREATE OR REPLACE VIEW sales_by_city AS
  SELECT c.city, count(*) AS orders, sum(o.total) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.city;

INSERT INTO customers (name, email, city)
SELECT 'Customer ' || g, 'customer' || g || '@example.com',
       (ARRAY['Mumbai','Delhi','Bengaluru','Pune','Chennai','Hyderabad','Kolkata','Jaipur'])[1 + g % 8]
FROM generate_series(1, 5000) g ON CONFLICT DO NOTHING;
INSERT INTO products (sku, name, category, price)
SELECT 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g,
       (ARRAY['Laptops','Phones','Books','Grocery','Fashion'])[1 + g % 5], round((50 + random() * 4950)::numeric, 2)
FROM generate_series(1, 500) g ON CONFLICT DO NOTHING;
INSERT INTO orders (customer_id, status, ordered_at)
SELECT 1 + (random() * 4999)::int, (ARRAY['new','paid','shipped','delivered','cancelled'])[1 + (random() * 4)::int],
       now() - (random() * interval '180 days')
FROM generate_series(1, 20000 - (SELECT count(*) FROM orders)) g;
INSERT INTO order_items (order_id, product_id, qty, price)
SELECT o.id, p.id, 1 + (random() * 3)::int, p.price
FROM orders o CROSS JOIN LATERAL (SELECT id, price FROM products WHERE o.id > 0 ORDER BY random() LIMIT 2) p
WHERE NOT EXISTS (SELECT FROM order_items i WHERE i.order_id = o.id);
UPDATE orders o SET total = s.t FROM (SELECT order_id, sum(qty * price) t FROM order_items GROUP BY 1) s
 WHERE s.order_id = o.id AND o.total = 0;
-- things a migration review should notice
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_type WHERE typname = 'payment_method') THEN
    CREATE TYPE payment_method AS ENUM ('card', 'upi', 'netbanking', 'cod');
  END IF;
END \$\$;
CREATE TABLE IF NOT EXISTS payments (order_id bigint, method payment_method, amount numeric(12,2), paid_at timestamptz DEFAULT now());
CREATE UNLOGGED TABLE IF NOT EXISTS session_cache (token text, customer_id int, expires_at timestamptz);
CREATE TABLE IF NOT EXISTS audit_trail (at timestamptz DEFAULT now(), table_name text, action text, row_id bigint);
CREATE OR REPLACE FUNCTION log_order_change() RETURNS trigger LANGUAGE plpgsql AS \$f\$
BEGIN INSERT INTO audit_trail (table_name, action, row_id) VALUES (TG_TABLE_NAME, TG_OP, NEW.id); RETURN NEW; END \$f\$;
DROP TRIGGER IF EXISTS orders_audit ON orders;
CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION log_order_change();
CREATE MATERIALIZED VIEW IF NOT EXISTS monthly_sales AS
  SELECT date_trunc('month', ordered_at) AS month, count(*) AS orders, sum(total) AS revenue FROM orders GROUP BY 1;
INSERT INTO payments (order_id, method, amount)
SELECT id, (ARRAY['card','upi','netbanking','cod']::payment_method[])[1 + (id % 4)], total FROM orders
WHERE NOT EXISTS (SELECT FROM payments) AND status IN ('paid','shipped','delivered');
RESET ROLE;
SELECT lo_from_bytea(0, 'invoice template v1') WHERE NOT EXISTS (SELECT FROM pg_largeobject_metadata);
GRANT SELECT ON customers, products, orders TO replicator;
SELECT 'CREATE PUBLICATION shop_pub FOR TABLE customers, products, orders'
 WHERE NOT EXISTS (SELECT FROM pg_publication WHERE pubname = 'shop_pub') \\gexec
ANALYZE;
"
  psql_on "$P_IP" hr "
SET ROLE app_user;
CREATE TABLE IF NOT EXISTS departments (id serial PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS employees (
  id serial PRIMARY KEY, name text NOT NULL, department_id int REFERENCES departments, grade text,
  salary numeric(10,2), date_of_joining date);
INSERT INTO departments (name) VALUES ('Engineering'),('Sales'),('Finance'),('HR'),('Support') ON CONFLICT DO NOTHING;
INSERT INTO employees (name, department_id, grade, salary, date_of_joining)
SELECT 'Employee ' || g, 1 + g % 5, (ARRAY['G1','G2','G3','G4','G5'])[1 + g % 5],
       round((30000 + random() * 170000)::numeric, 2), date '2015-01-01' + (random() * 3900)::int
FROM generate_series(1, 300 - (SELECT count(*) FROM employees)) g;
"
  ok "users dba, replicator, app_user; databases shop (~20k orders) and hr; publication shop_pub; slot standby_slot"
}

setup_standby() {
  step "Standby ($S_NAME): copy the primary with pg_basebackup and follow it (streaming replication)"
  on "$S_IP" "
    if [[ -f $PGDATA/standby.signal ]]; then
      echo 'already a standby'
    else
      systemctl stop postgresql-$PG_MAJOR 2>/dev/null || true
      rm -rf $PGDATA && install -d -o postgres -g postgres -m 700 $PGDATA
      # PGAPPNAME names this standby in the primary's pg_stat_replication (-R keeps it in primary_conninfo)
      cd /tmp && sudo -u postgres env PGPASSWORD='$(q "$REPL_PASSWORD")' PGAPPNAME='$S_NAME' \
        $PGBIN/pg_basebackup -h $P_IP -U replicator -D $PGDATA -X stream -S standby_slot -R -c fast
      sed -i \"s/^cluster_name = .*/cluster_name = '\$(hostname -s)'/\" $PGDATA/conf.d/pg_demo.conf
    fi
    systemctl enable -q postgresql-$PG_MAJOR
    systemctl restart postgresql-$PG_MAJOR"
  ok "standby is streaming from $P_IP"
}

setup_logical() {
  step "Logical replica ($L_NAME): own server, subscription to shop_pub, plus a local table"
  init_node "$L_IP"
  psql_on "$L_IP" postgres "
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dba') THEN CREATE ROLE dba LOGIN SUPERUSER; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user LOGIN; END IF;
END \$\$;
ALTER ROLE dba PASSWORD '$(q "$DBA_PASSWORD")';
ALTER ROLE app_user PASSWORD '$(q "$DBA_PASSWORD")';
SELECT 'CREATE DATABASE shop OWNER app_user' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'shop') \\gexec
"
  # the subscriber needs the same tables (logical replication copies rows, not the schema)
  psql_on "$L_IP" shop "
SET ROLE app_user;
CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL, city text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY, sku text UNIQUE NOT NULL, name text NOT NULL, category text, price numeric(10,2) NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL DEFAULT 'new',
  ordered_at timestamptz NOT NULL DEFAULT now(), total numeric(12,2) NOT NULL DEFAULT 0);
-- only on this server: a reporting table built from the replicated orders
CREATE TABLE IF NOT EXISTS daily_sales (day date PRIMARY KEY, orders int, revenue numeric(14,2));
RESET ROLE;
SELECT format('CREATE SUBSCRIPTION shop_sub CONNECTION %L PUBLICATION shop_pub',
              'host=$P_IP port=5432 dbname=shop user=replicator password=$(q "$REPL_PASSWORD") application_name=$L_NAME')
 WHERE NOT EXISTS (SELECT FROM pg_subscription WHERE subname = 'shop_sub') \\gexec
"
  # wait for the first copy, then fill the local reporting table
  local state=""
  for _ in $(seq 1 60); do
    state=$(psql_on "$L_IP" shop "\\pset tuples_only on
SELECT count(*) FILTER (WHERE srsubstate <> 'r') FROM pg_subscription_rel;" | tr -d ' \n')
    [[ $state == 0 ]] && break
    sleep 2
  done
  [[ $state == 0 ]] || die "the subscription did not finish its first copy (check $L_IP: journalctl -u postgresql-$PG_MAJOR)"
  psql_on "$L_IP" shop "
INSERT INTO daily_sales SELECT ordered_at::date, count(*), sum(total) FROM orders GROUP BY 1
ON CONFLICT (day) DO UPDATE SET orders = excluded.orders, revenue = excluded.revenue;
ALTER TABLE daily_sales OWNER TO app_user;
"
  ok "subscription shop_sub copies customers, products, orders from $P_IP"
}

verify() {
  step "Check replication"
  printf '    primary - who is connected (pg_stat_replication):\n'
  psql_on "$P_IP" postgres "SELECT application_name, client_addr, state, sync_state, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS lag FROM pg_stat_replication;" | sed 's/^/      /'
  printf '    primary - replication slots:\n'
  psql_on "$P_IP" postgres "SELECT slot_name, slot_type, database, active FROM pg_replication_slots;" | sed 's/^/      /'
  printf '    standby - in recovery?\n'
  psql_on "$S_IP" postgres "SELECT pg_is_in_recovery() AS standby, (SELECT count(*) FROM pg_stat_wal_receiver) AS receiving;" | sed 's/^/      /'
  printf '    logical - subscription and row counts:\n'
  psql_on "$L_IP" shop "SELECT subname, received_lsn IS NOT NULL AS receiving FROM pg_stat_subscription;
SELECT (SELECT count(*) FROM customers) customers, (SELECT count(*) FROM products) products, (SELECT count(*) FROM orders) orders;" | sed 's/^/      /'
  # a live change: a new order on the primary shows up on both replicas
  psql_on "$P_IP" shop "INSERT INTO orders (customer_id, status, total) VALUES (1, 'new', 999.00);"
  sleep 3
  local s l
  s=$(psql_on "$S_IP" shop "\\pset tuples_only on
SELECT count(*) FROM orders;" | tr -d ' \n')
  l=$(psql_on "$L_IP" shop "\\pset tuples_only on
SELECT count(*) FROM orders;" | tr -d ' \n')
  ok "new order on the primary: standby sees $s orders, logical sees $l orders"
}

summary() {
  step "Done: demo set $SET_NAME"
  local inv=/root/pg-demo-$SET_NAME-inventory.txt
  { echo "# pg_genin Discover inventory (host port), demo set $SET_NAME"
    printf '%s 5432\n' "$P_IP" "$S_IP" "$L_IP"; } >"$inv"
  cat <<EOF

    $P_NAME   $P_IP   primary      databases shop, hr; publication shop_pub
    $S_NAME   $S_IP   standby      streaming replica of the primary (read-only)
    $L_NAME   $L_IP   logical      subscriber of shop_pub + its own table daily_sales

    For pg_genin -> Discover:
      inventory   $(tr '\n' ' ' < <(grep -v '^#' "$inv" | awk '{print $1":"$2}'))   ($inv)
      username    dba
      password    $DBA_PASSWORD
    Replication user: replicator / $REPL_PASSWORD
    Passwords saved in /root/pg-demo-$SET_NAME.txt (root only).

    Try it:   ssh -i $SSH_KEY root@$P_IP "sudo -u postgres psql -c 'select * from pg_stat_replication'"
    Remove:   $0 --destroy $SET_NAME
EOF
}

main "$@"
