# JumboSQL CPA automation image (crunchydata.pg 2.2.0) - the image the JumboSQL console runs for each deployment.
# Build it ON THE CONSOLE VM and keep it local: it contains your licensed Crunchy collection, vault.yml and
# vault password. Never push it to a registry.
#     ./build.sh automation        (from the repo root; see README)
FROM rockylinux/rockylinux:9
LABEL org.opencontainers.image.title="jumbosql-automation-cpa" org.opencontainers.image.source="https://github.com/rishabhjoshi2002/jumbosql"

# Same ansible-core you validated on the Ansible VM (.10). CPA 2.2 supports 2.13.13 - 2.17.x.
ARG ANSIBLE_CORE_VERSION=2.14.18

RUN dnf -y install python3 python3-pip openssh-clients sshpass rsync tar \
 && dnf clean all \
 && pip3 install --no-cache-dir "ansible-core==${ANSIBLE_CORE_VERSION}" netaddr jmespath

# bundle/ is produced by pack-from-ansible-vm.sh on the Ansible VM (.10):
#   bundle/collections/ansible_collections/...   crunchydata.pg + its pinned dependencies
#   bundle/project/                              crunchy-ha-postgresql dir: playbook, group_vars, files, vault.yml
#   bundle/vault_pass                            vault password (empty file = no vault)
COPY bundle/collections /cpa/collections
COPY bundle/project     /cpa/project
COPY bundle/vault_pass   /cpa/vault_pass

COPY json_log.py         /cpa/callback/json_log.py
COPY inventory_to_cpa.py /cpa/inventory_to_cpa.py
COPY jumbosql-deploy.yml /cpa/project/jumbosql-deploy.yml
COPY make_ansible_cfg.py /cpa/make_ansible_cfg.py
COPY entrypoint.sh       /cpa/entrypoint.sh

RUN set -e; \
    if [ -s /cpa/vault_pass ]; then mv /cpa/vault_pass /cpa/.vault_pass; chmod 600 /cpa/.vault_pass; else rm -f /cpa/vault_pass; fi; \
    chmod +x /cpa/entrypoint.sh; \
    test -f /cpa/project/crunchy-postgres-ha.playbook.yml || { echo "crunchy-postgres-ha.playbook.yml missing in bundle/project"; exit 1; }; \
    python3 /cpa/make_ansible_cfg.py; \
    ANSIBLE_CONFIG=/cpa/ansible.cfg ansible-galaxy collection list crunchydata.pg

ENV ANSIBLE_CONFIG=/cpa/ansible.cfg \
    ANSIBLE_FORCE_COLOR=0 \
    USER=root

WORKDIR /cpa/project
ENTRYPOINT ["/cpa/entrypoint.sh"]
