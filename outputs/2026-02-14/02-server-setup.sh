#!/bin/bash
# =============================================
# Parket Control Tower — Server Setup
# Run as root on fresh Ubuntu 24.04 LTS EC2
# =============================================
set -euo pipefail

echo "=== Parket Control Tower Setup ==="

# ── 1. System update ──
echo ">>> Updating system..."
apt-get update && apt-get upgrade -y
apt-get install -y \
  curl wget git unzip jq htop \
  apt-transport-https ca-certificates \
  gnupg lsb-release software-properties-common \
  fail2ban ufw

# ── 2. Create non-root user ──
echo ">>> Creating parket user..."
useradd -m -s /bin/bash -G sudo parket
echo "parket ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/parket

# Copy SSH keys
mkdir -p /home/parket/.ssh
cp /root/.ssh/authorized_keys /home/parket/.ssh/ 2>/dev/null || \
cp /home/ubuntu/.ssh/authorized_keys /home/parket/.ssh/ 2>/dev/null || true
chown -R parket:parket /home/parket/.ssh
chmod 700 /home/parket/.ssh
chmod 600 /home/parket/.ssh/authorized_keys

# ── 3. Firewall (UFW) ──
echo ">>> Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Caddy redirect)
ufw allow 443/tcp   # HTTPS (Caddy)
ufw --force enable

# ── 4. Install Docker ──
echo ">>> Installing Docker..."
curl -fsSL https://get.docker.com | sh
usermod -aG docker parket

# ── 5. Install Docker Compose ──
echo ">>> Installing Docker Compose..."
COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | jq -r .tag_name)
curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" \
  -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# ── 6. Mount data volume ──
echo ">>> Setting up data volume..."
if lsblk | grep -q nvme1n1; then
  DATA_DEV="/dev/nvme1n1"
elif lsblk | grep -q xvdf; then
  DATA_DEV="/dev/xvdf"
else
  echo "WARNING: No secondary volume detected, using /data on root"
  DATA_DEV=""
fi

if [ -n "$DATA_DEV" ]; then
  # Only format if not already formatted
  if ! blkid "$DATA_DEV" | grep -q ext4; then
    mkfs.ext4 "$DATA_DEV"
  fi
  mkdir -p /data
  mount "$DATA_DEV" /data
  if ! grep -q "$DATA_DEV" /etc/fstab; then
    echo "$DATA_DEV /data ext4 defaults,nofail 0 2" >> /etc/fstab
  fi
fi

mkdir -p /data/{postgres,redis,n8n,metabase,caddy/{data,config},backups}
chown -R parket:parket /data

# ── 7. Setup project directory ──
echo ">>> Creating project directory..."
mkdir -p /opt/parket
chown -R parket:parket /opt/parket

# ── 8. Install AWS CLI ──
echo ">>> Installing AWS CLI..."
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip

# ── 9. Fail2ban for SSH ──
echo ">>> Configuring fail2ban..."
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
FAIL2BAN
systemctl enable fail2ban
systemctl restart fail2ban

# ── 10. Sysctl tuning ──
echo ">>> Applying sysctl tuning..."
cat >> /etc/sysctl.conf << 'SYSCTL'
# Parket tuning
vm.overcommit_memory = 1
net.core.somaxconn = 1024
net.ipv4.tcp_max_syn_backlog = 1024
SYSCTL
sysctl -p

# ── Done ──
echo ""
echo "=== Setup Complete ==="
echo "Next steps:"
echo "  1. Copy docker-compose.yml and .env to /opt/parket/"
echo "  2. Copy Caddyfile to /opt/parket/"
echo "  3. Run: cd /opt/parket && docker-compose up -d"
echo "  4. SSH as: ssh parket@<ip>"
echo ""
