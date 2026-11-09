#!/usr/bin/env bash
# Self-signed certificate for HTTPS/WSS during development and LAN demos.
# Browsers only allow camera access on https:// (or localhost), so another
# machine on the LAN needs HTTPS. Accept the browser warning once per device.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=secure-visio" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1${LAN_IP:+,IP:$LAN_IP}"
chmod 600 certs/key.pem
echo "Created certs/cert.pem and certs/key.pem (valid for localhost${LAN_IP:+ and $LAN_IP})"
