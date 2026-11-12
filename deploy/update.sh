#!/usr/bin/env bash
# Redeploy after remote.sh has synced the files into /opt/slash-python. Run as root on the box.
set -euo pipefail
APP=/opt/slash-python
USER_NAME=slashpy
UNIT=slash-python
NODE_BIN=$(ls -d /root/.nvm/versions/node/v22*/bin/node 2>/dev/null | sort -V | tail -1)
NPM_BIN=$(dirname "$NODE_BIN")/npm
# The unit hides /root, so the service runs a copy of the Node binary from a system path.
NODE_RUN=/usr/local/lib/slash-python-node/node
install -D -m 755 "$NODE_BIN" "$NODE_RUN"
PORT=$(grep '^PORT=' "$APP/.env" | cut -d= -f2 || true); PORT=${PORT:-8021}

(cd "$APP" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --no-audit --no-fund --loglevel=error && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" run build)
chown -R "$USER_NAME:$USER_NAME" "$APP"
if [ -f "$APP/deploy/$UNIT.service" ]; then
  sed "s|__NODE_BIN__|$NODE_RUN|" "$APP/deploy/$UNIT.service" > "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
fi
systemctl restart "$UNIT"
for attempt in {1..30}; do
  if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then echo "app answering on :$PORT"; systemctl is-active "$UNIT"; exit 0; fi
  sleep 1
done
systemctl status "$UNIT" --no-pager
echo "app did not come up" >&2
exit 1
