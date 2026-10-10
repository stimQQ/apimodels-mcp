#!/usr/bin/env bash
# Build and (re)start the hosted MCP server on the apimodels box.
#   cd /data/projects/apimodels-mcp && bash deploy/deploy-hosted.sh
# Serves https://api.apimodels.app/mcp via nginx (deploy/nginx-api.apimodels.app.snippet.conf).
# Secrets live in deploy/hosted.env on the server only (git-ignored): MCP_UPLOAD_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=deploy/hosted.env
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  printf 'MCP_UPLOAD_SECRET=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  echo "created $ENV_FILE"
fi
git pull --ff-only
docker build -t apimodels-mcp-remote:latest .
docker rm -f apimodels-mcp-remote >/dev/null 2>&1 || true
docker run -d --name apimodels-mcp-remote --restart unless-stopped \
  -p 127.0.0.1:8095:8095 --memory 384m \
  --env-file "$ENV_FILE" \
  -e MCP_HOST=0.0.0.0 -e MCP_PUBLIC_URL=https://api.apimodels.app -e MCP_AUTH_SERVER=https://apimodels.app \
  apimodels-mcp-remote:latest serve --port 8095
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8095/healthz >/dev/null 2>&1; then echo "== up: $(git rev-parse --short HEAD) =="; exit 0; fi
  sleep 1
done
echo "!! not healthy"; docker logs --tail 50 apimodels-mcp-remote; exit 1
