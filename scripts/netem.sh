#!/usr/bin/env bash
# Degrades the network to test congestion detection (Linux, needs sudo).
#   sudo scripts/netem.sh lo loss 10%          # 10% packet loss
#   sudo scripts/netem.sh lo delay 300ms 50ms  # 300 ms delay, 50 ms jitter
#   sudo scripts/netem.sh lo rate 300kbit      # bandwidth limit
#   sudo scripts/netem.sh lo clear             # back to normal
# Use "lo" when both browsers run on this machine, or the LAN interface
# (e.g. wlan0, see `ip link`) when testing between two machines.
set -euo pipefail
IFACE=${1:?interface}; shift
if [[ "${1:-}" == "clear" ]]; then
  tc qdisc del dev "$IFACE" root 2>/dev/null || true
  echo "netem removed from $IFACE"
else
  tc qdisc replace dev "$IFACE" root netem "$@"
  echo "netem on $IFACE: $*"
fi
tc qdisc show dev "$IFACE"
