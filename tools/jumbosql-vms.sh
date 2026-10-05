#!/usr/bin/env bash
#
# jumbosql-vms.sh - create RHEL 9 VMs for a JumboSQL cluster on a KVM host. Nothing else: no Ansible,
#                   no PostgreSQL. JumboSQL deploys the cluster onto these VMs from its web console.
#
# Each VM gets:
#   - a free static IP on the libvirt network (picked automatically, or --ips), reserved in libvirt DHCP
#   - hostname <set>-<last octet>-vm<n>, root password (prompted), root SSH login
#   - an SSH key made for this set (/root/.ssh/jumbosql-<set>) - paste the private key into JumboSQL
#   - Red Hat registration (prompted), glibc-langpack-en, chrony, python3
#
# Usage (as root on the KVM host):
#   ./jumbosql-vms.sh [--name SET] [--count N] [--ips A,B,C]   create a set (default: 3 VMs)
#   ./jumbosql-vms.sh --dry-run [...]                          real checks, print every action, change nothing
#   ./jumbosql-vms.sh --no-rollback [...]                      keep what was built if a step fails
#   ./jumbosql-vms.sh --list                                   list sets made by this script
#   ./jumbosql-vms.sh --destroy SET                            unregister and delete a set's VMs
#   ./jumbosql-vms.sh --yes                                    don't ask for confirmation
#
# Sizes per VM (env): RAM_MB=4096 VCPUS=2 DISK=40G.  Other settings: see "settings" below.
# On failure everything this run created is undone in reverse order (Red Hat registrations, VMs, disks,
# DHCP reservations, the SSH key and the state file).

set -Eeuo pipefail
export LC_ALL=C LANG=C                                         # virsh/ip output in English, whatever the host locale
export LIBVIRT_DEFAULT_URI="${LIBVIRT_DEFAULT_URI:-qemu:///system}"

# ================================ settings (edit or override via env) ================================
BASE_IMAGE="${BASE_IMAGE:-/root/rhel-9.8-x86_64-kvm.qcow2}"   # RHEL 9.x KVM guest image (qcow2)
IMG_DIR="${IMG_DIR:-/var/lib/libvirt/images}"
TEMPLATE="${TEMPLATE:-$IMG_DIR/jumbosql-rhel9-template.qcow2}" # built once from BASE_IMAGE, then reused
NET="${NET:-default}"
SUBNET="${SUBNET:-192.168.122}"                               # /24 served by $NET
GW="${GW:-$SUBNET.1}"
DNS="${DNS:-$SUBNET.1}"
PREFIX="${PREFIX:-24}"
IP_FIRST="${IP_FIRST:-20}"                                    # free IPs are picked from this range
IP_LAST="${IP_LAST:-240}"
OS_VARIANT="${OS_VARIANT:-rhel9.0}"
TIMEZONE="${TIMEZONE:-Asia/Kolkata}"
RAM_MB="${RAM_MB:-4096}"
VCPUS="${VCPUS:-2}"
DISK="${DISK:-40G}"
EXTRA_PUBKEYS="${EXTRA_PUBKEYS:-/root/.ssh/id_rsa.pub /root/.ssh/id_ed25519.pub}"  # also allowed to log in, if present
STATE_DIR="${STATE_DIR:-/var/lib/jumbosql-vms}"
# ======================================================================================================

DRY_RUN=0 NO_ROLLBACK=0 ASSUME_YES=0 MODE=create
SET_NAME="" COUNT=3 IPS_ARG="" DESTROY_SET=""
UNDO=() STEP_NO=0 CURRENT_STEP="startup" WORKDIR="" LOG="" ROOT_PART="" SSH_KEY=""
V_NAME=() V_IP=() V_MAC=()
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
          -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=30)

# --------------------------------------------- output ---------------------------------------------
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
step() { STEP_NO=$((STEP_NO + 1)); CURRENT_STEP="$*"; printf '\n\033[1;36m[%02d] %s\033[0m\n' "$STEP_NO" "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }
usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }

run() {
  if (( DRY_RUN )); then printf '    [dry-run] %s\n' "$*"; return 0; fi
  printf '    + %s\n' "$*"
  "$@"
}
run_secret() {   # the command contains a secret: only the description is printed / logged
  local desc=$1; shift
  if (( DRY_RUN )); then printf '    [dry-run] %s\n' "$desc"; return 0; fi
  printf '    + %s\n' "$desc"
  "$@"
}
on() { local ip=$1; shift; ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "root@$ip" "$@"; }

# -------------------------------------------- rollback --------------------------------------------
push_undo() { UNDO+=("$1"); }
rollback() {
  if (( ${#UNDO[@]} == 0 )); then info "Nothing to roll back."; return 0; fi
  info "Rolling back ${#UNDO[@]} change(s) in reverse order..."
  local i
  for (( i = ${#UNDO[@]} - 1; i >= 0; i-- )); do
    printf '    undo: %s\n' "${UNDO[i]}"
    eval "${UNDO[i]}" >/dev/null 2>&1 || warn "undo step failed (continuing): ${UNDO[i]}"
  done
  UNDO=()
  info "Rollback complete."
}
fail() {
  if [[ $BASHPID != "$$" ]]; then exit 1; fi
  trap - ERR INT TERM
  err "$1"
  if (( DRY_RUN )); then err "Dry run stopped at: $CURRENT_STEP"; exit 1; fi
  if (( NO_ROLLBACK )); then warn "--no-rollback: leaving everything in place. Remove later with: $0 --destroy $SET_NAME"
  else rollback; fi
  err "Failed during: $CURRENT_STEP. Log: $LOG"
  exit 1
}
die() { fail "$*"; }
cleanup() {
  if [[ -n $WORKDIR && -d $WORKDIR ]]; then
    find "$WORKDIR" -type f -exec shred -u {} + 2>/dev/null || true
    rm -rf "$WORKDIR"
  fi
}
trap 'fail "command failed (exit $?) at line $LINENO: $BASH_COMMAND"' ERR
trap 'fail "interrupted"' INT TERM
trap cleanup EXIT

# --------------------------------------------- prompts --------------------------------------------
confirm() {
  if (( ASSUME_YES || DRY_RUN )); then return 0; fi
  local a; read -r -p "    $1 [y/N]: " a
  [[ $a =~ ^[Yy] ]] || { info "Aborted, nothing was changed."; exit 0; }
}
ask() { local __v=$1 p=$2 d=${3:-} a; read -r -p "    $p${d:+ [$d]}: " a; printf -v "$__v" '%s' "${a:-$d}"; }
ask_secret() {
  local __v=$1 p=$2 a b
  while true; do
    read -r -s -p "    $p: " a; echo
    [[ -n $a ]] || { warn "cannot be empty"; continue; }
    read -r -s -p "    $p (again): " b; echo
    [[ $a == "$b" ]] && break
    warn "did not match, try again"
  done
  printf -v "$__v" '%s' "$a"
}

# ============================================== steps ==============================================

check_network() {   # output captured first: no locale or pipefail/SIGPIPE surprises
  local active all info vm used net_of_vms=""
  active=$(virsh net-list --name 2>&1) || die "virsh cannot reach libvirt ($LIBVIRT_DEFAULT_URI): $active"
  if grep -qxF "$NET" <<<"$active"; then return 0; fi

  all=$(virsh net-list --all 2>&1 || true)
  info=$(virsh net-info "$NET" 2>&1 || true)
  # which network or bridge do the VMs already running here use?
  for vm in $(virsh list --name 2>/dev/null); do
    used=$(virsh domiflist "$vm" 2>/dev/null | awk 'NR>2 && NF {print $2 ":" $3}' || true)
    [[ -n $used ]] && net_of_vms+="      $vm -> $used"$'\n'
  done
  printf '\n    libvirt networks on this host:\n%s\n' "$(sed 's/^/      /' <<<"$all")" >&2
  printf '    virsh net-info %s:\n%s\n' "$NET" "$(sed 's/^/      /' <<<"$info")" >&2
  [[ -n $net_of_vms ]] && printf '    running VMs use (type:source):\n%s' "$net_of_vms" >&2
  die "libvirt network '$NET' is missing or not active. Start it (virsh net-start $NET; virsh net-autostart $NET) or run with NET=<name> SUBNET=<a.b.c> matching your VMs"
}

preflight() {
  step "Check the KVM host"
  [[ $EUID -eq 0 ]] || die "run this script as root"
  local c missing=()
  for c in virsh virt-install virt-customize virt-resize virt-filesystems qemu-img ssh ssh-keygen ping ip shred; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if (( ${#missing[@]} )); then
    warn "missing tools: ${missing[*]}"
    run dnf install -y guestfs-tools virt-install openssh-clients iputils iproute coreutils
  fi
  ok "required tools present"

  check_network
  ok "libvirt network '$NET' is active"

  if [[ -e $TEMPLATE ]]; then
    ok "reusing template $TEMPLATE"
    ROOT_PART=$(virt-filesystems -a "$TEMPLATE" --long --no-title 2>/dev/null | awk '$3=="xfs" && $4=="root" {print $1; exit}' || true)
  else
    [[ -f $BASE_IMAGE ]] || die "RHEL 9 KVM guest image not found: $BASE_IMAGE (set BASE_IMAGE=...)"
    ROOT_PART=$(virt-filesystems -a "$BASE_IMAGE" --long --no-title 2>/dev/null | awk '$3=="xfs" && $4=="root" {print $1; exit}' || true)
    ok "base image $BASE_IMAGE"
  fi
  if [[ -z $ROOT_PART ]]; then ROOT_PART=/dev/sda4; warn "could not detect the root partition, assuming $ROOT_PART"; fi
  ok "root partition $ROOT_PART"

  local need avail free
  need=$(( COUNT * RAM_MB ))
  avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if (( avail < need )); then warn "the VMs need ${need} MB RAM, only ${avail} MB available"; else ok "RAM: ${need} MB needed, ${avail} MB available"; fi
  free=$(df -Pm "$IMG_DIR" | awk 'NR==2 {print int($4/1024)}')
  if (( free < 20 * COUNT )); then warn "only ${free} GB free in $IMG_DIR"; else ok "disk: ${free} GB free in $IMG_DIR"; fi
}

ip_in_use() {   # libvirt leases/reservations, ARP neighbours, ping
  local ip=$1
  if grep -qxF "$ip" <<<"$USED_IPS"; then return 0; fi
  if ping -c1 -W1 "$ip" >/dev/null 2>&1; then return 0; fi
  return 1
}

choose_ips() {
  step "Pick IP addresses"
  USED_IPS=$( {
    virsh net-dhcp-leases "$NET" 2>/dev/null | grep -oE "$SUBNET\.[0-9]+" || true
    virsh net-dumpxml "$NET" 2>/dev/null | grep -oE "ip='$SUBNET\.[0-9]+'" | grep -oE "$SUBNET\.[0-9]+" || true
    ip neigh show 2>/dev/null | awk '$0 !~ /FAILED|INCOMPLETE/ {print $1}' | grep -E "^$SUBNET\." || true
    echo "$GW"
    # IPs of sets made by this script (in case a VM is off and its DHCP reservation was removed)
    cat "$STATE_DIR"/*.state 2>/dev/null | awk '/^VM=/ {print $2}' || true
  } | sort -u)

  if [[ -n $IPS_ARG ]]; then
    IFS=, read -r -a V_IP <<<"$IPS_ARG"
    (( ${#V_IP[@]} == COUNT )) || die "--ips has ${#V_IP[@]} addresses, --count is $COUNT"
    local ip
    for ip in "${V_IP[@]}"; do
      [[ $ip =~ ^$SUBNET\.([0-9]+)$ ]] && (( BASH_REMATCH[1] > 1 && BASH_REMATCH[1] < 255 )) || die "$ip is not in $SUBNET.0/$PREFIX"
      if ip_in_use "$ip"; then die "$ip is already in use"; fi
    done
  else
    local o
    for (( o = IP_FIRST; o <= IP_LAST && ${#V_IP[@]} < COUNT; o++ )); do
      if ! ip_in_use "$SUBNET.$o"; then V_IP+=("$SUBNET.$o"); fi
    done
    (( ${#V_IP[@]} == COUNT )) || die "found only ${#V_IP[@]} free IPs in $SUBNET.$IP_FIRST-$IP_LAST"
  fi

  local i
  for i in "${!V_IP[@]}"; do
    V_NAME+=("$SET_NAME-${V_IP[i]##*.}-vm$((i + 1))")
    V_MAC+=("$(printf '52:54:00:%02x:%02x:%02x' $((RANDOM % 256)) $((RANDOM % 256)) $((RANDOM % 256)))")
    if virsh dominfo "${V_NAME[i]}" &>/dev/null; then die "VM ${V_NAME[i]} already exists"; fi
    if [[ -e $IMG_DIR/${V_NAME[i]}.qcow2 ]]; then die "disk $IMG_DIR/${V_NAME[i]}.qcow2 already exists"; fi
  done
  ok "IPs: ${V_IP[*]}"
}

collect_inputs() {
  step "Credentials"
  if (( DRY_RUN )); then RH_MODE=1 RH_USER="<rh-user>" RH_PASS=x ROOT_PW=x; ok "dry run: prompts skipped"; return 0; fi
  ask_secret ROOT_PW "Root password for the new VMs (console and SSH)"
  ask RH_MODE "Register with Red Hat using 1 = username/password, 2 = organization ID + activation key" 1
  if [[ $RH_MODE == 2 ]]; then
    ask RH_ORG "Red Hat organization ID"
    ask_secret RH_KEY "Activation key"
  else
    RH_MODE=1
    ask RH_USER "Red Hat username"
    ask_secret RH_PASS "Red Hat password"
  fi
}

show_plan() {
  step "Plan"
  local i
  printf '    %-24s %-16s %-8s %-6s %s\n' NAME IP RAM_MB VCPUS DISK
  for i in "${!V_NAME[@]}"; do
    printf '    %-24s %-16s %-8s %-6s %s\n' "${V_NAME[i]}" "${V_IP[i]}" "$RAM_MB" "$VCPUS" "$DISK"
  done
  echo "    RHEL 9, registered with Red Hat, glibc-langpack-en + chrony; no PostgreSQL, no Ansible."
  echo "    SSH key for JumboSQL: /root/.ssh/jumbosql-$SET_NAME"
  confirm "Create these VMs?"
}

prepare_key_and_template() {
  step "SSH key and VM template"
  SSH_KEY=/root/.ssh/jumbosql-$SET_NAME
  if [[ -e $SSH_KEY ]]; then die "$SSH_KEY already exists (set '$SET_NAME' in use?)"; fi
  run install -d -m 700 /root/.ssh
  run ssh-keygen -q -t ed25519 -N "" -C "jumbosql-$SET_NAME" -f "$SSH_KEY"
  push_undo "rm -f '$SSH_KEY' '$SSH_KEY.pub'"
  ok "SSH key $SSH_KEY"

  if [[ ! -e $TEMPLATE ]]; then
    run cp --sparse=always "$BASE_IMAGE" "$TEMPLATE"
    push_undo "rm -f '$TEMPLATE'"
    run virt-customize -q -a "$TEMPLATE" \
      --touch /etc/cloud/cloud-init.disabled \
      --write "/etc/ssh/sshd_config.d/01-permitroot.conf:PermitRootLogin yes" \
      --timezone "$TIMEZONE" \
      --selinux-relabel
    ok "template built: $TEMPLATE (cloud-init off, root SSH allowed)"
  fi
}

create_vms() {
  step "Create the VMs"
  local i n ip mac disk nm k extra=() hosts=()
  for i in "${!V_NAME[@]}"; do hosts+=(--append-line "/etc/hosts:${V_IP[i]} ${V_NAME[i]}"); done
  for k in $EXTRA_PUBKEYS; do
    if [[ -f $k ]]; then extra+=(--ssh-inject "root:file:$k"); fi
  done
  if (( ! DRY_RUN )); then printf '%s\n' "$ROOT_PW" >"$WORKDIR/rootpw"; chmod 600 "$WORKDIR/rootpw"; fi

  for i in "${!V_NAME[@]}"; do
    n=${V_NAME[i]} ip=${V_IP[i]} mac=${V_MAC[i]} disk=$IMG_DIR/${V_NAME[i]}.qcow2 nm=$WORKDIR/${V_NAME[i]}.nmconnection
    info "$n ($ip)"
    cat >"$nm" <<EOF
[connection]
id=jumbosql-static
type=ethernet
autoconnect=true
autoconnect-priority=100

[ipv4]
method=manual
address1=$ip/$PREFIX,$GW
dns=$DNS;

[ipv6]
method=disabled
EOF
    if run virsh net-update "$NET" add ip-dhcp-host "<host mac='$mac' name='$n' ip='$ip'/>" --live --config; then
      push_undo "virsh net-update '$NET' delete ip-dhcp-host \"<host mac='$mac' name='$n' ip='$ip'/>\" --live --config"
    else
      warn "could not reserve $ip in libvirt DHCP (the VM uses a static IP anyway)"
    fi
    run qemu-img create -q -f qcow2 "$disk" "$DISK"
    push_undo "rm -f '$disk'"
    run virt-resize --quiet --expand "$ROOT_PART" "$TEMPLATE" "$disk"
    run virt-customize -q -a "$disk" \
      --hostname "$n" \
      --root-password "file:$WORKDIR/rootpw" \
      --ssh-inject "root:file:$SSH_KEY.pub" \
      "${extra[@]}" \
      --upload "$nm:/etc/NetworkManager/system-connections/jumbosql-static.nmconnection" \
      --chmod "0600:/etc/NetworkManager/system-connections/jumbosql-static.nmconnection" \
      "${hosts[@]}" \
      --selinux-relabel
    run virt-install --name "$n" --memory "$RAM_MB" --vcpus "$VCPUS" \
      --disk "path=$disk,format=qcow2,bus=virtio" \
      --network "network=$NET,model=virtio,mac=$mac" \
      --os-variant "$OS_VARIANT" --import --autostart \
      --graphics none --console pty,target_type=serial --noautoconsole
    push_undo "virsh destroy '$n'; virsh undefine '$n' --nvram || virsh undefine '$n'"
    ok "$n started"
  done
  save_state
}

wait_for_vms() {
  step "Wait for SSH"
  local i t
  for i in "${!V_NAME[@]}"; do
    if (( DRY_RUN )); then printf '    [dry-run] wait for SSH on %s\n' "${V_IP[i]}"; continue; fi
    for (( t = 0; t < 120; t++ )); do on "${V_IP[i]}" true 2>/dev/null && break; sleep 5; done
    (( t < 120 )) || die "${V_NAME[i]} (${V_IP[i]}) did not answer on SSH within 10 minutes"
    ok "${V_NAME[i]} up: $(on "${V_IP[i]}" 'hostname; ip -4 -o addr show scope global | awk "{print \$4}"' | paste -sd' ')"
  done
}

register_and_prepare() {
  step "Register with Red Hat and install the base packages"
  local i n ip cmd
  for i in "${!V_NAME[@]}"; do
    n=${V_NAME[i]} ip=${V_IP[i]}
    if [[ $RH_MODE == 2 ]]; then
      cmd="subscription-manager register --org $(printf %q "$RH_ORG") --activationkey $(printf %q "$RH_KEY")"
    else
      cmd="subscription-manager register --username $(printf %q "$RH_USER") --password $(printf %q "$RH_PASS")"
    fi
    run_secret "register $n with Red Hat" on "$ip" "$cmd"
    push_undo "on '$ip' 'subscription-manager unregister'"
    run on "$ip" "dnf -y -q install glibc-langpack-en chrony python3 rsync tar && systemctl enable --now chronyd"
    ok "$n registered and prepared"
  done
}

verify() {
  step "Check the VMs"
  if (( DRY_RUN )); then printf '    [dry-run] check hostname, IP, subscription, locale, chrony on each VM\n'; return 0; fi
  local i out
  for i in "${!V_NAME[@]}"; do
    out=$(on "${V_IP[i]}" 'printf "%s | %s | sub=%s | locale=%s | chrony=%s | ram=%sMB\n" \
      "$(hostname)" "$(. /etc/os-release; echo $PRETTY_NAME)" \
      "$(subscription-manager identity >/dev/null 2>&1 && echo yes || echo NO)" \
      "$(rpm -q glibc-langpack-en >/dev/null && echo en || echo MISSING)" \
      "$(systemctl is-active chronyd)" "$(free -m | awk "/Mem:/{print \$2}")"')
    ok "${V_IP[i]}: $out"
  done
}

# ---------------------------------------------- state ----------------------------------------------
save_state() {
  if (( DRY_RUN )); then return 0; fi
  install -d -m 700 "$STATE_DIR"
  local i f=$STATE_DIR/$SET_NAME.state
  { echo "# jumbosql-vms set $SET_NAME, created $(date -Is)"; echo "KEY=$SSH_KEY"
    for i in "${!V_NAME[@]}"; do echo "VM=${V_NAME[i]} ${V_IP[i]} ${V_MAC[i]} $IMG_DIR/${V_NAME[i]}.qcow2"; done; } >"$f"
  push_undo "rm -f '$f'"
}

list_sets() {
  shopt -s nullglob
  local f found=0
  for f in "$STATE_DIR"/*.state; do
    found=1
    echo "== $(basename "$f" .state)   ($(sed -n 1p "$f" | sed 's/.*created //'))"
    awk '/^VM=/ {sub("VM=",""); printf "   %-24s %-16s %s\n", $1, $2, $4}' "$f"
  done
  (( found )) || echo "no sets in $STATE_DIR"
}

destroy_set() {
  local f=$STATE_DIR/$DESTROY_SET.state n ip mac disk key
  [[ -f $f ]] || die "no set '$DESTROY_SET' (see --list)"
  step "Destroy set $DESTROY_SET"
  key=$(awk -F= '/^KEY=/ {print $2}' "$f")
  awk '/^VM=/ {sub("VM=",""); print "    " $1 "  " $2}' "$f"
  confirm "Unregister and permanently delete these VMs and their disks?"
  SSH_KEY=$key
  while read -r n ip mac disk; do
    if [[ $(virsh domstate "$n" 2>/dev/null || true) == running* ]]; then
      if [[ -f $SSH_KEY ]]; then
        run_secret "unregister $n from Red Hat" on "$ip" "subscription-manager unregister" || warn "could not unregister $n (remove it at console.redhat.com)"
      fi
      run virsh destroy "$n" || warn "could not stop $n"
    fi
    if virsh dominfo "$n" &>/dev/null; then run virsh undefine "$n" --nvram || run virsh undefine "$n" || warn "could not undefine $n"; fi
    run virsh net-update "$NET" delete ip-dhcp-host "<host mac='$mac' name='$n' ip='$ip'/>" --live --config || true
    if [[ -e $disk ]]; then run rm -f "$disk"; fi
    run ssh-keygen -R "$ip" >/dev/null 2>&1 || true
  done < <(awk '/^VM=/ {sub("VM=",""); print}' "$f")
  if [[ -n $key ]]; then run rm -f "$key" "$key.pub"; fi
  run rm -f "$f"
  ok "set $DESTROY_SET removed"
}

summary() {
  step "Done: set $SET_NAME"
  local i
  echo
  echo "    Enter these in JumboSQL: Clusters -> Create cluster -> Inventory (virtual machines)"
  echo
  printf '    %-8s %-24s %-16s %s\n' SERVER HOSTNAME IP "SUGGESTED ROLES"
  for i in "${!V_NAME[@]}"; do
    local roles="etcd, PostgreSQL + Patroni"
    if (( i == 0 )); then roles="etcd, HAProxy, PgBouncer, pgBackRest repo, Monitoring"; fi
    printf '    %-8s %-24s %-16s %s\n' "$((i + 1))" "${V_NAME[i]}" "${V_IP[i]}" "$roles"
  done
  cat <<EOF

    Authentication in the form:  SSH key,  username: root
    Private key to paste:        cat $SSH_KEY

    Log in yourself:             ssh -i $SSH_KEY root@${V_IP[0]}
    Remove this set:             $0 --destroy $SET_NAME
    Log:                         $LOG
EOF
}

# ============================================== main ==============================================
main() {
  while (( $# )); do
    case $1 in
      --name)        SET_NAME=${2:?--name needs a value}; shift ;;
      --count)       COUNT=${2:?--count needs a value}; shift ;;
      --ips)         IPS_ARG=${2:?--ips needs a value}; shift ;;
      --dry-run)     DRY_RUN=1 ;;
      --no-rollback) NO_ROLLBACK=1 ;;
      --list)        MODE=list ;;
      --destroy)     MODE=destroy; DESTROY_SET=${2:?--destroy needs a set name}; shift ;;
      -y|--yes)      ASSUME_YES=1 ;;
      -h|--help)     usage; exit 0 ;;
      *)             echo "Unknown option: $1"; usage; exit 2 ;;
    esac
    shift
  done
  [[ $COUNT =~ ^[0-9]+$ ]] && (( COUNT >= 1 && COUNT <= 9 )) || { echo "--count must be 1-9"; exit 2; }
  SET_NAME=${SET_NAME:-js-$(date +%m%d-%H%M)}
  [[ $SET_NAME =~ ^[a-z0-9][a-z0-9-]{0,20}$ ]] || { echo "--name: lowercase letters, digits and '-', max 21"; exit 2; }

  if [[ $MODE == list ]]; then list_sets; exit 0; fi

  local suffix=""
  if (( DRY_RUN )); then suffix=-dryrun; fi
  LOG=/var/log/jumbosql-vms-$(date +%Y%m%d-%H%M%S)$suffix.log
  exec > >(tee -a "$LOG") 2>&1
  WORKDIR=$(mktemp -d /root/.jumbosql-vms.XXXXXX); chmod 700 "$WORKDIR"
  if (( DRY_RUN )); then info "DRY RUN: checks are real, every change is only printed."; fi

  if [[ $MODE == destroy ]]; then destroy_set; exit 0; fi
  if [[ -e $STATE_DIR/$SET_NAME.state ]]; then die "set '$SET_NAME' already exists (--list / --destroy $SET_NAME)"; fi

  preflight
  choose_ips
  collect_inputs
  show_plan
  prepare_key_and_template
  create_vms
  wait_for_vms
  register_and_prepare
  verify
  UNDO=()   # success: nothing to roll back any more
  summary
}

main "$@"
