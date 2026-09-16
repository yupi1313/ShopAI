#!/usr/bin/env bash
# Deploy the committed HEAD to the server without any registry or GitHub credentials:
# git archive over ssh, then docker compose build + up on the box.
#
# Usage (from the repo root, Git Bash or WSL):  deploy/deploy.sh [ssh-alias]
set -euo pipefail

HOST="${1:-shopai}"
REMOTE_DIR=/opt/shopai/app
REF="${REF:-HEAD}"

if [ -n "$(git status --porcelain)" ]; then
  echo "note: working tree has uncommitted changes; deploying committed ${REF} only" >&2
fi

echo "==> shipping $(git rev-parse --short "$REF") to ${HOST}:${REMOTE_DIR}"
git archive --format=tar "$REF" | ssh "$HOST" "mkdir -p ${REMOTE_DIR} && tar -x -C ${REMOTE_DIR}"

echo "==> building and starting"
ssh "$HOST" "cd ${REMOTE_DIR} && test -f ../.env || { echo 'missing /opt/shopai/.env' >&2; exit 1; }; \
  docker compose --env-file ../.env up -d --build --remove-orphans && \
  docker compose --env-file ../.env ps && \
  docker image prune -f >/dev/null && df -h / | tail -1"

echo "==> recent server logs"
ssh "$HOST" "cd ${REMOTE_DIR} && docker compose --env-file ../.env logs --tail=30 server"
