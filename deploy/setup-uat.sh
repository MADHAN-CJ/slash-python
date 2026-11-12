#!/usr/bin/env bash
# One-time setup on the uat box (run as root): service user, app dir (synced by remote.sh),
# Node 22 build, a uv-managed Python venv with numpy+pandas, systemd unit, .env, nginx site,
# certificate. Re-runnable.
set -euo pipefail
APP=/opt/slash-python
USER_NAME=slashpy
STATE=/var/lib/slashpy
export UV_PYTHON_INSTALL_DIR=$STATE/python
HOSTNAME_PUBLIC=${PUBLIC_HOSTNAME:?set PUBLIC_HOSTNAME (remote.sh passes it from deploy/deploy.env)}
PORT=${APP_PORT:-8021}
SITE_NAME=${HOSTNAME_PUBLIC//./-}
SITE=/etc/nginx/sites-available/$SITE_NAME
HERE=$(cd "$(dirname "$0")" && pwd)
NODE_BIN=$(ls -d /root/.nvm/versions/node/v22*/bin/node 2>/dev/null | sort -V | tail -1 || true)
[ -n "$NODE_BIN" ] || { echo "No Node 22 under /root/.nvm; install one (nvm install 22)" >&2; exit 1; }
NPM_BIN=$(dirname "$NODE_BIN")/npm
# The unit hides /root, so the service runs a copy of the Node binary from a system path.
NODE_RUN=/usr/local/lib/slash-python-node/node
install -D -m 755 "$NODE_BIN" "$NODE_RUN"

id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$STATE" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$STATE" && chown "$USER_NAME:$USER_NAME" "$STATE" && chmod 750 "$STATE"
[ -d "$APP" ] || { echo "$APP missing: run 'bash deploy/remote.sh setup' from the laptop, which syncs it first" >&2; exit 1; }

# Build the browser bundle with Node 22 (esbuild is a devDependency, so a full install).
(cd "$APP" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --no-audit --no-fund --loglevel=error && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" run build)

# Python for user scripts: uv-managed 3.14 in a venv owned by the service user, with numpy+pandas.
sudo -u "$USER_NAME" -H bash -c 'command -v ~/.local/bin/uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh'
mkdir -p "$UV_PYTHON_INSTALL_DIR" && chown "$USER_NAME:$USER_NAME" "$UV_PYTHON_INSTALL_DIR"
chown -R "$USER_NAME:$USER_NAME" "$APP"
sudo -u "$USER_NAME" -H bash -c "export UV_PYTHON_INSTALL_DIR=$UV_PYTHON_INSTALL_DIR; cd $APP && ~/.local/bin/uv python install 3.14 && [ -x $APP/.venv/bin/python ] || ~/.local/bin/uv venv --python 3.14 $APP/.venv; ~/.local/bin/uv pip install --python $APP/.venv/bin/python --quiet numpy pandas"

if [ ! -f "$APP/.env" ]; then
  cat > "$APP/.env" <<ENV
HOST=127.0.0.1
PORT=$PORT
PYTHON_BIN=$APP/.venv/bin/python
RUN_TIMEOUT_MS=10000
CLAUDE_MODEL=claude-opus-5-5
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
ENV
  echo "wrote $APP/.env"
fi
chown "$USER_NAME:$USER_NAME" "$APP/.env" && chmod 600 "$APP/.env"
grep -q '^ANTHROPIC_API_KEY=.\+' "$APP/.env" || echo "WARNING: ANTHROPIC_API_KEY is empty in $APP/.env (reports will be off)"

sed "s|__NODE_BIN__|$NODE_RUN|" "$HERE/slash-python.service" > /etc/systemd/system/slash-python.service
chmod 644 /etc/systemd/system/slash-python.service
systemctl daemon-reload
systemctl enable --now slash-python
systemctl restart slash-python

if [ ! -f "$SITE" ]; then
  sed -e "s|__HOSTNAME__|$HOSTNAME_PUBLIC|g" -e "s|__PORT__|$PORT|g" "$HERE/nginx.conf.template" > "$SITE"
  chmod 644 "$SITE"
  ln -sf "$SITE" "/etc/nginx/sites-enabled/$SITE_NAME"
fi
nginx -t && systemctl reload nginx
if [ ! -d "/etc/letsencrypt/live/$HOSTNAME_PUBLIC" ]; then
  certbot --nginx -d "$HOSTNAME_PUBLIC" --non-interactive --agree-tos --redirect --keep-until-expiring || \
    echo "certbot failed: create the DNS A record for $HOSTNAME_PUBLIC, then run 'certbot --nginx -d $HOSTNAME_PUBLIC --redirect'"
fi

for attempt in {1..30}; do
  if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then echo "app answering on :$PORT"; break; fi
  sleep 1
done
systemctl is-active slash-python
echo "URL: https://$HOSTNAME_PUBLIC"
