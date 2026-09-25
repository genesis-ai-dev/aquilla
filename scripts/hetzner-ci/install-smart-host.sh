#!/bin/bash
# Run as root on the designated shared host after installing docker.io.
set -euo pipefail
id aquillaqa >/dev/null 2>&1 || useradd --system --home /var/lib/aquilla-qa --shell /usr/sbin/nologin aquillaqa
install -d -m 750 -o aquillaqa -g aquillaqa /var/lib/aquilla-qa
install -d -m 700 /var/lib/aquilla-qa-jobs
install -d -m 750 -g aquillaqa /var/lib/aquilla-qa-evidence
install -d -m 750 -g aquillaqa /etc/aquilla-qa
install -d -m 755 /opt/aquilla-qa
# A separate filesystem bounds image/build growth and protects the live site's disk.
if ! mountpoint -q /var/lib/docker; then
  test -z "$(docker ps -aq)"
  test -z "$(docker images -q)"
  systemctl stop docker.service docker.socket
  test ! -e /var/lib/aquilla-qa-docker.ext4
  fallocate -l 24G /var/lib/aquilla-qa-docker.ext4
  mkfs.ext4 -q /var/lib/aquilla-qa-docker.ext4
  printf '%s\n' '/var/lib/aquilla-qa-docker.ext4 /var/lib/docker ext4 loop,defaults 0 0' >> /etc/fstab
  mount /var/lib/docker
  systemctl start docker.service
fi
cat > /etc/systemd/system/aquillaqa.slice <<'EOF'
[Unit]
Description=Bounded Aquilla QA containers
[Slice]
CPUAccounting=true
CPUQuota=150%
MemoryAccounting=true
MemoryHigh=2300M
MemoryMax=2500M
MemorySwapMax=512M
TasksMax=1536
EOF
systemctl daemon-reload
systemctl start aquillaqa.slice
docker network inspect aquilla-qa >/dev/null 2>&1 || docker network create \
  --subnet 172.30.71.0/24 --opt com.docker.network.bridge.name=br-aquillaqa aquilla-qa
# PR containers can reach public package/model endpoints, not the host or LAN.
# IPv6 is dropped outright rather than allowlisted: nothing here depends on IPv6
# egress (registries/model endpoints are all reachable over IPv4), and the host's
# own IPv6 address (if the provider routes one) isn't knowable at image-build time
# the way its IPv4 is, so there is no safe equivalent of the IPv4 host-address
# block below. Blanket-dropping v6 removes it as a containment bypass instead of
# leaving it implicitly wide open.
cat > /opt/aquilla-qa/firewall.sh <<'EOF'
#!/bin/bash
set -euo pipefail
iptables -C INPUT -i br-aquillaqa -j DROP 2>/dev/null || iptables -I INPUT -i br-aquillaqa -j DROP
iptables -N AQUILLA_QA 2>/dev/null || true
iptables -F AQUILLA_QA
for destination in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 5.161.201.46/32; do
  iptables -A AQUILLA_QA -d "$destination" -j DROP
done
iptables -A AQUILLA_QA -j RETURN
iptables -C DOCKER-USER -i br-aquillaqa -j AQUILLA_QA 2>/dev/null || iptables -I DOCKER-USER -i br-aquillaqa -j AQUILLA_QA

if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -C INPUT -i br-aquillaqa -j DROP 2>/dev/null || ip6tables -I INPUT -i br-aquillaqa -j DROP
  ip6tables -N AQUILLA_QA6 2>/dev/null || true
  ip6tables -F AQUILLA_QA6
  ip6tables -A AQUILLA_QA6 -j DROP
  ip6tables -C DOCKER-USER -i br-aquillaqa -j AQUILLA_QA6 2>/dev/null || ip6tables -I DOCKER-USER -i br-aquillaqa -j AQUILLA_QA6
fi
EOF
chmod 755 /opt/aquilla-qa/firewall.sh
cat > /etc/systemd/system/aquilla-qa-firewall.service <<'EOF'
[Unit]
Description=Block QA containers from host and private networks
After=docker.service
Requires=docker.service
PartOf=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/aquilla-qa/firewall.sh
[Install]
WantedBy=docker.service
EOF
cat > /etc/systemd/system/aquilla-qa-webhook.service <<'EOF'
[Unit]
Description=Signed Aquilla PR webhook
After=network.target
[Service]
User=aquillaqa
Group=aquillaqa
ExecStart=/usr/bin/python3 /opt/aquilla-qa/webhook.py
Restart=always
RestartSec=3
UMask=0007
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/aquilla-qa
MemoryMax=128M
CPUQuota=20%
TasksMax=64
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/aquilla-qa-runner.service <<'EOF'
[Unit]
Description=Isolated Aquilla smart-test queue
After=docker.service aquilla-qa-firewall.service
Requires=docker.service aquilla-qa-firewall.service
[Service]
ExecStart=/usr/bin/python3 /opt/aquilla-qa/runner.py
Restart=always
RestartSec=10
UMask=0007
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/aquilla-qa /var/lib/aquilla-qa-jobs /var/lib/aquilla-qa-evidence
Group=aquillaqa
MemoryMax=256M
CPUQuota=25%
TasksMax=64
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now aquilla-qa-firewall.service
# Start ingress and worker only after credentials and reviewed image are ready.
