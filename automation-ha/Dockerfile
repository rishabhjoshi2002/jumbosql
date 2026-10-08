# pg_genin Keen PostgreSQL HA automation image - the image the console runs for each deployment.
# Build it ON THE CONSOLE VM and keep it local: it contains your licensed HA Ansible collection and your
# (encrypted) vault.yml. The vault password is NOT in the image; the console passes it to each run.
#     ./build.sh automation        (from the repo root; see README)
FROM registry.access.redhat.com/ubi9/ubi:latest
LABEL org.opencontainers.image.title="jumbosql-automation-ha" org.opencontainers.image.source="https://github.com/rishabhjoshi2002/jumbosql"

# Same ansible-core you validated on the Ansible VM (.10); the 2.2.0 collection supports 2.13.13 - 2.17.x.
ARG ANSIBLE_CORE_VERSION=2.14.18

# Red Hat UBI 9 base. sshpass (only needed for password SSH logins) comes from EPEL.
RUN dnf -y install python3 python3-pip openssh-clients rsync tar \
 && (dnf -y install https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm && dnf -y install sshpass \
     || echo "sshpass not installed: use SSH key authentication") \
 && dnf clean all \
 && pip3 install --no-cache-dir "ansible-core==${ANSIBLE_CORE_VERSION}" netaddr jmespath

# bundle/ is produced by pack-from-ansible-vm.sh on the Ansible VM (.10):
#   bundle/collections/ansible_collections/...   the HA collection + its pinned dependencies
#   bundle/project/                              playbook dir: keen-ha.playbook.yml, group_vars, files, vault.yml
COPY bundle/collections /ha/collections
COPY bundle/project     /ha/project

COPY json_log.py         /ha/callback/json_log.py
COPY inventory_to_ha.py  /ha/inventory_to_ha.py
COPY jumbosql-deploy.yml /ha/jumbosql-deploy.template.yml
COPY make_deploy_playbook.py /ha/make_deploy_playbook.py
COPY make_ansible_cfg.py /ha/make_ansible_cfg.py
COPY entrypoint.sh       /ha/entrypoint.sh

RUN set -e; \
    chmod +x /ha/entrypoint.sh; \
    test -f /ha/project/keen-ha.playbook.yml || { echo "keen-ha.playbook.yml missing in bundle/project - re-run pack-from-ansible-vm.sh"; exit 1; }; \
    python3 /ha/make_deploy_playbook.py /ha/jumbosql-deploy.template.yml /ha/project/keen-ha.playbook.yml /ha/project/jumbosql-deploy.yml; \
    python3 /ha/make_ansible_cfg.py; \
    ANSIBLE_CONFIG=/ha/ansible.cfg ansible-galaxy collection list

ENV ANSIBLE_CONFIG=/ha/ansible.cfg \
    ANSIBLE_FORCE_COLOR=0 \
    USER=root

WORKDIR /ha/project
ENTRYPOINT ["/ha/entrypoint.sh"]
