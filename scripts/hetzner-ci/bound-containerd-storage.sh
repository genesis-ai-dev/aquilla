#!/bin/bash
# For this QA-only Docker installation. Never run on a shared container host.
set -euo pipefail
if mountpoint -q /var/lib/containerd; then
  exit 0
fi
test -z "$(docker ps -aq)"
# Installation on this host introduced containerd; no other workloads own it.
if ctr namespaces list -q | grep -Ev '^(moby|plugins.moby)$' | grep -q .; then
  echo 'Non-Docker containerd namespace exists; refusing migration' >&2
  exit 1
fi
systemctl stop docker.service docker.socket containerd.service
truncate -s 24G /var/lib/aquilla-qa-docker.ext4
qa_loop=$(findmnt -n -o SOURCE /var/lib/docker)
case "$qa_loop" in /dev/loop*) ;; *) exit 1 ;; esac
losetup -c "$qa_loop"
resize2fs "$qa_loop"
mkdir -p /var/lib/docker/containerd-store
# Remove each source only after its successful copy. This avoids needing a
# second complete image store on this small disk during the one-time migration.
nice -n 10 ionice -c 2 -n 7 rsync -aHAX --remove-source-files \
  /var/lib/containerd/ /var/lib/docker/containerd-store/
mount --bind /var/lib/docker/containerd-store /var/lib/containerd
if ! grep -q '^/var/lib/docker/containerd-store ' /etc/fstab; then
  printf '%s\n' '/var/lib/docker/containerd-store /var/lib/containerd none bind,x-systemd.requires=var-lib-docker.mount 0 0' >> /etc/fstab
fi
mkdir -p /etc/systemd/system/containerd.service.d
cat > /etc/systemd/system/containerd.service.d/aquilla-storage.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/containerd /var/lib/docker
EOF
systemctl daemon-reload
systemctl start containerd.service docker.service
docker info --format '{{.DockerRootDir}} {{json .DriverStatus}}'
df -h / /var/lib/docker /var/lib/containerd
systemctl is-active koinegreek aquilla-qa-webhook
