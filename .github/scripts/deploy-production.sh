#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
component=${1:?Pass backend or frontend}
[[ "$component" == backend || "$component" == frontend ]] || exit 2
revision=${2:?Pass release revision}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
root=/opt/aigenerate
release=/opt/intexa-releases/$component-$revision
backup=/opt/aigenerate-backups/ci-$component-$revision-$(date -u +%Y%m%dT%H%M%SZ)
exec 9>/opt/intexa-deploy.lock
flock -w 3000 9 || { echo 'Another deployment is running'; exit 1; }
[[ -f "$root/.env" && -f "$root/docker-compose.prod.yml" ]]
mkdir -p "$backup"
cp "$root/.env" "$backup/previous.env"
old_backend=$(docker inspect -f '{{.Image}}' aigenerate-backend)
old_frontend=$(docker inspect -f '{{.Image}}' aigenerate-frontend)
new_backend=$old_backend
new_frontend=$old_frontend
if [[ "$component" == backend ]]; then new_backend=intexa-backend:$revision; else new_frontend=intexa-frontend:$revision; fi
if [[ "$component" == backend ]]; then
  printf 'services:\n  backend:\n    image: %s\n    build:\n      context: %s\n  frontend:\n    image: %s\n' "$new_backend" "$release" "$new_frontend" > "$release/images.yml"
else
  printf 'services:\n  backend:\n    image: %s\n  frontend:\n    image: %s\n    build:\n      context: %s\n' "$new_backend" "$new_frontend" "$release" > "$release/images.yml"
fi
cat > "$backup/rollback.yml" <<IMAGES
services:
  backend:
    image: $old_backend
  frontend:
    image: $old_frontend
IMAGES
compose=(docker compose --env-file "$root/.env" -p aigenerate -f "$root/docker-compose.prod.yml" -f "$release/images.yml")
rollback=(docker compose --env-file "$backup/previous.env" -p aigenerate -f "$root/docker-compose.prod.yml" -f "$backup/rollback.yml")
gated=false
switched=false
frontend_stopped=false
cleanup() {
  result=$?
  trap - EXIT
  if (( result != 0 )) && $switched; then
    echo 'Deployment failed; restoring previous container images. Database is retained.'
    if ! "${rollback[@]}" up -d --no-build --no-deps --wait --wait-timeout 180 "$component"; then
      echo 'ROLLBACK FAILED: generation gate stays closed; operator intervention required'
      exit 1
    fi
  fi
  if $gated; then
    docker exec aigenerate-backend node -e "require('fs').rmSync('/app/storage/.deployment-blocked',{force:true})" || result=1
  fi
  if $frontend_stopped; then docker start aigenerate-frontend >/dev/null || true; fi
  exit "$result"
}
trap cleanup EXIT
"${compose[@]}" build "$component"
# A deployment-aware backend rejects new generation requests before reserving credits.
if docker exec aigenerate-backend node -e "fetch('http://127.0.0.1:4100/health/deployment').then(async r=>{const j=await r.json();if(!r.ok||typeof j.inFlight!=='number')process.exit(1)}).catch(()=>process.exit(1))"; then
  docker exec aigenerate-backend node -e "require('fs').writeFileSync('/app/storage/.deployment-blocked','deployment')"
  gated=true
else
  # First installation only: old versions have no gate. Remove their sole public
  # entry point and finish any in-flight frontend requests before checking jobs.
  echo 'Legacy backend: temporarily stopping frontend to drain safely'
  docker stop --time 120 aigenerate-frontend >/dev/null
  frontend_stopped=true
fi
wait_start=$SECONDS
while :; do
  requests=0
  if $gated; then
    requests=$(docker exec aigenerate-backend node -e "fetch('http://127.0.0.1:4100/health/deployment').then(r=>r.json()).then(j=>{if(!j.blocked||!Number.isInteger(j.inFlight))process.exit(1);console.log(j.inFlight)}).catch(()=>process.exit(1))")
  fi
  jobs=$(docker exec aigenerate-postgres psql -U aigenerate -d aigenerate -Atc "SELECT count(*) FROM generation_jobs WHERE status IN ('queued','running')")
  [[ "$jobs" =~ ^[0-9]+$ && "$requests" =~ ^[0-9]+$ ]]
  if (( jobs == 0 && requests == 0 )); then break; fi
  (( SECONDS - wait_start < 1800 )) || { echo 'Drain timeout; deployment cancelled'; exit 1; }
  echo "Waiting: $jobs generation jobs, $requests incoming requests"
  sleep 10
done
docker exec aigenerate-postgres pg_dump -U aigenerate -d aigenerate -Fc > "$backup/database.dump"
printf '%s\n' "$old_backend" "$old_frontend" > "$backup/previous-images"
switched=true
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 "$component"
if $frontend_stopped; then docker start aigenerate-frontend >/dev/null; frontend_stopped=false; fi
# Verify both the private API and public TLS route before reopening generation.
docker exec aigenerate-backend node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
curl --fail --silent --show-error --retry 5 --retry-delay 3 --max-time 20 https://intexa-ai.com/ > /dev/null
curl --fail --silent --show-error --max-time 20 https://intexa-ai.com/login > /dev/null
printf '%s\n' "$revision" > "/opt/intexa-releases/$component-current-revision"
printf 'Deployed %s %s; backup: %s\n' "$component" "$revision" "$backup"
