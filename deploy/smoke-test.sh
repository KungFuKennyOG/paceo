#!/usr/bin/env bash
# End-to-end smoke test of the production Docker stack (used by CI, runnable locally).
# Builds the image, starts api + postgres with throwaway secrets, then walks the main user flow
# through the HTTP API: health → web app shell → invite → register → health screen → profile →
# plan generate → workouts → proposals. Run from the repo root:  bash deploy/smoke-test.sh
set -euo pipefail

cd "$(dirname "$0")"
BASE=http://127.0.0.1:3000
JAR=$(mktemp)
ENV_FILE=.env
CREATED_ENV=0

cleanup() {
  status=$?
  if [ $status -ne 0 ]; then
    echo "::group::api logs"; docker compose logs --no-color api | tail -200 || true; echo "::endgroup::"
  fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$CREATED_ENV" = 1 ] && rm -f "$ENV_FILE"
  rm -f "$JAR"
  exit $status
}
trap cleanup EXIT

if [ -f "$ENV_FILE" ]; then
  echo "deploy/.env already exists; refusing to overwrite it. Move it aside to run the smoke test." >&2
  exit 1
fi
CREATED_ENV=1
cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
PACEO_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
PUBLIC_URL=http://localhost:3000
COOKIE_SECURE=false
JOBS_ENABLED=true
# Unused here (profiles not started) but compose interpolates every service.
TUNNEL_TOKEN=unused
DOMAIN=localhost
EOF

echo "▶ build image"
docker compose build api
docker run --rm paceo-api:latest node dist/cli/vapid-keys.js >> "$ENV_FILE"

echo "▶ start stack"
docker compose up -d postgres api

echo "▶ wait for /api/health"
for i in $(seq 1 60); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { echo "API never became healthy" >&2; exit 1; }
  sleep 3
done
curl -fsS "$BASE/api/health"; echo

echo "▶ web app shell is served"
curl -fsS "$BASE/" | grep -qi "<div id=\"root\"" || { echo "index.html not served" >&2; exit 1; }
curl -fsS "$BASE/today" | grep -qi "<div id=\"root\"" || { echo "SPA fallback missing" >&2; exit 1; }
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/does-not-exist")
[ "$code" = 404 ] || { echo "unknown /api path returned $code, expected 404" >&2; exit 1; }

echo "▶ invite + register"
INVITE=$(docker compose exec -T api node dist/cli/create-invite.js | sed -n 's/^Invite code: *//p')
[ -n "$INVITE" ] || { echo "no invite code" >&2; exit 1; }

# method path [json-body] → prints the response body; fails (showing the body) on a non-2xx status.
post() {
  local out code
  out=$(mktemp)
  if [ -n "${3:-}" ]; then
    code=$(curl -sS -o "$out" -w '%{http_code}' -b "$JAR" -c "$JAR" -H 'content-type: application/json' -X "$1" "$BASE$2" -d "$3")
  else
    code=$(curl -sS -o "$out" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$1" "$BASE$2")
  fi
  if [ "${code:0:1}" != 2 ]; then
    echo "$1 $2 → HTTP $code: $(head -c 1500 "$out")" >&2
    rm -f "$out"; return 1
  fi
  cat "$out"; rm -f "$out"
}

post POST /api/auth/register "{\"inviteCode\":\"$INVITE\",\"email\":\"smoke@paceo.test\",\"password\":\"correct horse battery\",\"displayName\":\"Smoke\"}" >/dev/null
post GET /api/me | grep -q '"isAdmin":true' || { echo "first user is not admin" >&2; exit 1; }

echo "▶ health screen"
post POST /api/health-screen '{"answers":[false,false,false,false,false,false,false],"pregnantOrPostpartum":false,"recentSeriousInjuryOrSurgery":false}' | grep -q '"canProceed":true'

echo "▶ profile"
RACE=$(date -u -d '+126 days' +%F)
PROFILE=$(cat <<JSON
{"units":"metric","timezone":"America/Toronto","experienceLevel":"intermediate","monthsRunning":13,
 "currentWeeklyKm":42,"longestRun30d":{"km":14,"minutes":95},"canRun20MinContinuous":true,
 "recentResult":{"distanceM":42195,"timeS":15840,"date":"$(date -u -d '-20 days' +%F)","kind":"race"},
 "birthYear":null,"hrMax":null,"hrRest":null,"injury":"none",
 "goal":{"type":"race","distance":"marathon","raceDate":"$RACE","goalTimeS":15300},
 "daysAvailable":["tue","thu","sat","sun"],"longRunDay":"sun","maxMinutesByDay":{},"longRunMode":"daniels",
 "strength":{"mode":"running","equipment":"gym","sessionsPerWeek":2,"liftingExperience":"experienced"},
 "crossTraining":[{"activity":"dragon boat","days":["thu"],"typicalMinutes":90,"typicalSrpe":7,"locked":true}],
 "watchBrand":"garmin"}
JSON
)
post PUT /api/profile "$PROFILE" >/dev/null

echo "▶ preview + generate"
post POST /api/plan/preview "{\"profile\":$PROFILE}" | grep -q '"feasibility"'
post POST /api/plan/generate | grep -q '"planId"'
post GET /api/plan/current | grep -q '"weeks"'

echo "▶ workouts"
FROM=$(date -u +%F); TO=$(date -u -d '+30 days' +%F)
N=$(post GET "/api/workouts?from=$FROM&to=$TO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items.length))')
echo "workouts in next 30 days: $N"
[ "$N" -gt 0 ] || { echo "no workouts generated" >&2; exit 1; }

echo "▶ proposals"
post GET /api/proposals | grep -q '"items":\[' || { echo "GET /api/proposals did not return a list" >&2; exit 1; }
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/proposals/none" -d '{"accept":true}')
[ "$code" = 404 ] || { echo "POST /api/proposals/none returned $code, expected 404" >&2; exit 1; }

echo "▶ memory"
docker stats --no-stream --format '{{.Name}}: {{.MemUsage}}' | grep paceo || true

echo "✓ smoke test passed"
