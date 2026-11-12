#!/usr/bin/env bash
# Operate the workbench box over SSH. Settings come from deploy/deploy.env (git-ignored; see
# deploy.env.example): DEPLOY_HOST, PUBLIC_HOSTNAME, APP_PORT. Files are rsync'd from this checkout.
#
#   bash deploy/remote.sh setup     one-time: sync, user, venv, unit, nginx + basic auth, cert
#   bash deploy/remote.sh deploy    sync + rebuild + restart
#   bash deploy/remote.sh status | logs | creds | cert
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PROJECT=$(cd "$HERE/.." && pwd)
[ -f "$HERE/deploy.env" ] && set -a && . "$HERE/deploy.env" && set +a
HOST=${DEPLOY_HOST:-}; HOSTNAME_PUBLIC=${PUBLIC_HOSTNAME:-}; PORT=${APP_PORT:-8021}
[ -n "$HOST" ] && [ -n "$HOSTNAME_PUBLIC" ] || { echo "Create deploy/deploy.env from deploy.env.example" >&2; exit 2; }
REMOTE_DIR=/root/slash-python-deploy
APP=/opt/slash-python
BOX_ENV="PUBLIC_HOSTNAME='$HOSTNAME_PUBLIC' APP_PORT='$PORT'"

sync_files() {
  ssh "$HOST" "mkdir -p $APP $REMOTE_DIR"
  rsync -az --delete \
    --exclude node_modules --exclude dist --exclude .env --exclude .venv --exclude 'deploy/deploy.env' --exclude 'deploy/nginx.conf' --exclude 'deploy/credentials*' --exclude '.DS_Store' \
    "$PROJECT/" "$HOST:$APP/"
  scp -q "$HERE/setup-uat.sh" "$HERE/update.sh" "$HERE/slash-python.service" "$HERE/nginx.conf.template" "$HOST:$REMOTE_DIR/"
}

case "${1:-}" in
  setup)
    sync_files
    KEY=$(grep '^ANTHROPIC_API_KEY=' "$PROJECT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
    ssh "$HOST" "$BOX_ENV ANTHROPIC_API_KEY='$KEY' bash $REMOTE_DIR/setup-uat.sh" ;;
  deploy)
    sync_files
    ssh "$HOST" "$BOX_ENV bash $REMOTE_DIR/update.sh" ;;
  status)
    ssh "$HOST" "systemctl status slash-python --no-pager | head -5; curl -fsS -o /dev/null -w 'local %{http_code}\n' http://127.0.0.1:$PORT/" ;;
  logs)
    ssh "$HOST" 'journalctl -u slash-python -n 100 --no-pager -o cat' ;;
  creds)
    ssh "$HOST" "cat $REMOTE_DIR/credentials.txt" ;;
  cert)
    ssh "$HOST" "certbot --nginx -d $HOSTNAME_PUBLIC --non-interactive --agree-tos --redirect --keep-until-expiring && systemctl reload nginx" ;;
  *)
    sed -n 2,8p "$0"; exit 2 ;;
esac
