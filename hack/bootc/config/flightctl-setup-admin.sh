#!/usr/bin/env bash
set -euo pipefail

USER="testadmin"
PASSWORD="testadmin"

for i in $(seq 1 60); do
    if podman exec flightctl-pam-issuer id &>/dev/null; then
        break
    fi
    sleep 5
done

podman exec -i flightctl-pam-issuer groupadd flightctl-admin 2>/dev/null || true
podman exec flightctl-pam-issuer adduser "$USER" 2>/dev/null || true
podman exec -i flightctl-pam-issuer sh -c "echo '$USER:$PASSWORD' | chpasswd"
podman exec -i flightctl-pam-issuer usermod -aG flightctl-admin "$USER"

echo "PAM issuer admin user '$USER' configured"
