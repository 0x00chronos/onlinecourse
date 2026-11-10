#!/usr/bin/env bash
# Validate the built image without touching the developer's config or database.
set -euo pipefail

image="${1:-onlinecourse:local}"
temp_dir="$(mktemp -d)"
container="onlinecourse-smoke-$$"
volume="${container}-data"
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then docker logs "$container" >&2 || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
  exit "$result"
}
trap cleanup EXIT

cat > "$temp_dir/config.yaml" <<'YAML'
server:
  address: "0.0.0.0:8080"
  api_key: "isolated-container-smoke-test"
database:
  driver: sqlite
  sqlite:
    path: "/app/data/questionbank.db"
log:
  format: json
YAML
chmod 644 "$temp_dir/config.yaml"
docker volume create "$volume" >/dev/null

start_container() {
  docker create --name "$container" --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,source=$temp_dir/config.yaml,target=/app/config/config.yaml,readonly" \
    --mount "type=volume,source=$volume,target=/app/data" \
    --health-interval 1s --health-start-period 1s "$image" >/dev/null
  docker start "$container" >/dev/null
  for ((attempt=0; attempt<60; attempt++)); do
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ]; then
      return
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
      return 1
    fi
    sleep 1
  done
  echo "Container did not become healthy" >&2
  return 1
}

start_container
test "$(docker exec "$container" id -u)" = 10001
test "$(docker exec "$container" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/v1/courses)" = 401
docker exec "$container" curl -fsS http://127.0.0.1:8080/ | grep '<html' >/dev/null
docker exec "$container" curl -fsS http://127.0.0.1:8080/userscripts/chaoxing-questionbank.user.js | grep '==UserScript==' >/dev/null
docker exec "$container" curl -fsS http://127.0.0.1:8080/api/v1/courses \
  -H 'Authorization: Bearer isolated-container-smoke-test' \
  -H 'Content-Type: application/json' \
  -d '{"platform":"docker-smoke","external_id":"persistence","name":"Container persistence"}' >/dev/null
# Recreate the container with the same volume to verify SQLite survives updates.
docker stop --time 15 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
docker rm "$container" >/dev/null
start_container
docker exec "$container" curl -fsS http://127.0.0.1:8080/api/v1/courses \
  -H 'Authorization: Bearer isolated-container-smoke-test' | grep 'Container persistence' >/dev/null
echo "Docker smoke passed: non-root, health, auth, embedded assets, SQLite persistence, graceful shutdown."
