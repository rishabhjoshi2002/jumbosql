# pg_mantra upgrade runner - the image the console starts for Upgrades (dry run, upgrade, rollback).
# Plain Ansible (+ ansible.posix, community.general, community.postgresql), pg_mantra's own upgrade playbook and
# your custom playbooks (Upgrades > Custom playbooks): works for any setup (built by pg_mantra or found by Discover). Built by ./build.sh console (or ./build.sh upgrader):
#     docker build -f upgrade/Dockerfile -t pg_mantra/upgrader:1.0 automation-ha
FROM registry.access.redhat.com/ubi9/ubi:latest
LABEL org.opencontainers.image.title="pg_mantra-upgrader"

ARG ANSIBLE_CORE_VERSION=2.14.18
RUN dnf -y install python3 python3-pip openssh-clients \
 && (dnf -y install https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm && dnf -y install sshpass \
     || echo "sshpass not installed: use SSH key authentication") \
 && dnf clean all \
 && pip3 install --no-cache-dir "ansible-core==${ANSIBLE_CORE_VERSION}" \
 && (ansible-galaxy collection install -p /usr/share/ansible/collections ansible.posix community.general community.postgresql \
     || echo "collections not installed: add them to the playbook's requirements")

COPY json_log.py       /pgm/callback/json_log.py
COPY inventory_to_ha.py /pgm/inventory_to_ha.py
COPY upgrade/          /pgm/upgrade/
RUN chmod +x /pgm/upgrade/entrypoint.sh && rm -f /pgm/upgrade/Dockerfile \
 && printf '[defaults]\ncallback_plugins = /pgm/callback\ncallbacks_enabled = json_log\nhost_key_checking = False\nforks = 10\ntimeout = 60\ninterpreter_python = auto_silent\n[ssh_connection]\npipelining = True\n' > /pgm/ansible.cfg

ENV ANSIBLE_CONFIG=/pgm/ansible.cfg ANSIBLE_FORCE_COLOR=0 USER=root
WORKDIR /pgm/upgrade
ENTRYPOINT ["/pgm/upgrade/entrypoint.sh"]
