#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# A disposable OpenCloud 9 + external Caddy baseline, never a production reset.
set -Eeuo pipefail
umask 077
kit=$(realpath "${1:?installation kit required}")
expected=${2:?kit SHA256 required}
run=${3:?new absolute scratch directory required}
[[ "$run" = /* && ! -e "$run" && "$expected" =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "$expected" "$kit" | sha256sum -c -
mkdir -p "$run/private" "$run/apps" "$run/config" "$run/data" "$run/tls"
tar -xzf "$kit" -C "$run"
cd "$run/document-workflow"
version=$(cat VERSION)
name=workflow-cleanup-fresh-${version//./-}
origin=${4:-https://workflow-beta.test}
[[ "$origin" =~ ^https://workflow-[a-z0-9-]+\.test$ ]]
host=${origin#https://}
network=$name-net
opencloud=$name-opencloud
proxy=$name-caddy
image=$name-runtime
for candidate in "$opencloud" "$proxy"; do
 if docker container inspect "$candidate" >/dev/null 2>&1; then
  echo 'An earlier isolated acceptance exists; inspect it before retrying' >&2; exit 1
 fi
done
docker network inspect "$network" >/dev/null 2>&1 && exit 1
docker build --build-arg "WORKFLOW_VERSION=$version" --tag "$image" image > "$run/build.log" 2>&1
docker pull caddy:2 > "$run/proxy-image.log" 2>&1
docker image inspect opencloudeu/opencloud-rolling:9.0.0 >/dev/null
docker network create --internal --label document-workflow.acceptance=true "$network" > /dev/null
chown 1000:1000 "$run/config" "$run/data" "$run/apps"
chmod 755 "$run" "$run/apps"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
 -subj "/CN=$host" -addext "subjectAltName=DNS:$host" \
 -keyout "$run/tls/private.key" -out "$run/tls/ca.crt" > "$run/certificate.log" 2>&1
chmod 644 "$run/tls/ca.crt"
{
 printf 'OC_URL=%s\n' "$origin"
 printf 'IDM_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
 printf '%s\n' 'PROXY_TLS=false' 'OC_INSECURE=true' 'PROXY_ENABLE_BASIC_AUTH=true' \
  'IDM_CREATE_DEMO_USERS=false' 'FRONTEND_CHECK_FOR_UPDATES=false' 'OC_LOG_LEVEL=error'
} > "$run/private/opencloud.env"
project=$(docker run --rm --network none --read-only --entrypoint node "$image" \
 -e 'console.log("document-workflow-"+require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,10))' "$origin")
cat > "$run/Caddyfile" <<EOF
{
 admin off
 auto_https off
}
$origin {
 tls /tls/ca.crt /tls/private.key
 @workflow path /_workflow/api/*
 handle @workflow {
  reverse_proxy $project-companion-1:5175
 }
 handle {
  reverse_proxy $opencloud:9200
 }
}
EOF
docker run -d --name "$opencloud" --label document-workflow.acceptance=true \
 --network "$network" --user 1000:1000 --env-file "$run/private/opencloud.env" \
 -v "$run/config:/etc/opencloud" -v "$run/data:/var/lib/opencloud" \
 -v "$run/apps:/var/lib/opencloud/web/assets/apps" \
 --entrypoint /bin/sh opencloudeu/opencloud-rolling:9.0.0 \
 -c 'opencloud init || true; opencloud server' > /dev/null
docker run -d --name "$proxy" --label document-workflow.acceptance=true \
 --network "$network" --network-alias "$host" \
 -v "$run/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$run/tls:/tls:ro" \
 caddy:2 > /dev/null
probe(){ docker run --rm --network "$network" --read-only --cap-drop ALL \
 -v "$run/tls/ca.crt:/ca.crt:ro" --env NODE_EXTRA_CA_CERTS=/ca.crt \
 --entrypoint node "$image" -e "$1"; }
ready=false
for attempt in {1..100}; do
 if probe "fetch('$origin/status.php',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error('not ready');const j=await r.json();if(!String(j.productversion??j.versionstring??j.version??'').startsWith('9.'))throw Error('not OpenCloud 9')}).catch(()=>process.exit(1))" > /dev/null 2>&1; then ready=true;break;fi
 sleep 2
done
[[ "$ready" = true ]] || { echo 'Isolated OpenCloud did not become ready' >&2;exit 1; }
args=(--opencloud-container "$opencloud" --proxy-container "$proxy" --network "$network" \
 --proxy-mode external --trusted-ca "$run/tls/ca.crt" --image "$image")
./install.sh doctor "${args[@]}" > "$run/doctor.log" 2>&1
grep -Eq '"current"[[:space:]]*:[[:space:]]*null' "$run/doctor.log"
./install.sh install "${args[@]}" > "$run/install.log" 2>&1
grep -q "Installed Document Workflow $version" "$run/install.log"
docker exec "$project-companion-1" node /distribution/health-check.mjs "$origin"
docker exec -i "$project-companion-1" node --input-type=module > "$run/empty-state.json" <<'JS'
import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';
const d=new DatabaseSync('/state/workflow.sqlite3',{readOnly:true});
const counts=Object.fromEntries(['proposals','decisions','metadata','metadata_schema','intake_settings','preferences'].map(t=>[t,d.prepare('select count(*) n from '+t).get().n]));
assert.ok(Object.values(counts).every(n=>n===0));console.log(JSON.stringify(counts));d.close();
JS
docker exec -i "$project-companion-1" node --input-type=module > "$run/restore.json" <<'JS'
import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';
import{BackupManager,restoreSnapshot}from'/app/companion/backups.mjs';
const d=new DatabaseSync('/state/workflow.sqlite3');
d.prepare('insert into metadata values(?,?,?,?,?)').run('synthetic-acceptance','synthetic-resource',1,JSON.stringify({reference:'SYN-RESTORE-0200'}),new Date().toISOString());d.close();
const manager=new BackupManager({database:'/state/workflow.sqlite3',directory:'/backups/acceptance'});
try{const snapshot=await manager.tick({force:true});assert.ok(snapshot);const receipt=await restoreSnapshot(snapshot.directory,'/tmp/acceptance-restore/workflow.sqlite3');assert.equal(receipt.networkRequests,0);assert.equal(receipt.ingestionPaused,true);const restored=new DatabaseSync('/tmp/acceptance-restore/workflow.sqlite3',{readOnly:true});assert.equal(JSON.parse(restored.prepare('select fields from metadata where resource=?').get('synthetic-resource').fields).reference,'SYN-RESTORE-0200');restored.close();console.log(JSON.stringify({snapshotVerified:true,syntheticFieldsRestored:true,ingestionPaused:true,networkRequests:0}));}finally{await manager.stop()}
JS
test -f "$run/apps/document-workflow/manifest.json"
# Installing the web assets restarts OpenCloud. The companion can be healthy
# before OpenCloud's web service has finished starting; poll only this read.
web_ready=false
for attempt in {1..30}; do
 if probe "fetch('$origin',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok||!(await r.text()).includes('<html'))throw Error('Web frontend unavailable: HTTP '+r.status)}).catch(e=>{console.error(e.message);process.exit(1)})"; then web_ready=true;break;fi
 sleep 2
done
[[ "$web_ready" = true ]] || { echo 'OpenCloud web frontend did not become ready' >&2;exit 1; }
before=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$opencloud" "$project-companion-1" "$project-converter-1")
./install.sh install "${args[@]}" > "$run/repeat.log" 2>&1
grep -q 'already installed and healthy' "$run/repeat.log"
after=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$opencloud" "$project-companion-1" "$project-converter-1")
[[ "$before" = "$after" ]]
docker run --rm --network none --read-only --cap-drop ALL \
 --tmpfs /tmp:rw,noexec,nosuid,size=256m --entrypoint /bin/sh "$image" -ec '
 cd /app/source
 node --test --experimental-test-isolation=none tests/companion/*.test.mjs
 node --test --experimental-test-isolation=none tests/packaging/*.test.mjs
 pdftotext tests/fixtures/english.pdf /tmp/fixture.txt
 grep -F SYNTHETIC /tmp/fixture.txt
 tesseract --list-langs
 ' > "$run/image-checks.log" 2>&1
docker image inspect --format '{{.Id}}' "$image" opencloudeu/opencloud-rolling:9.0.0 caddy:2 > "$run/image-ids.txt"
printf 'FRESH_INSTALL_PASS %s\nEMPTY_JOURNAL_PASS\nSYNTHETIC_RESTORE_PASS\nHTTPS_AUTH_REQUIRED_PASS\nREPEAT_WITHOUT_RESTART_PASS\nISOLATED_IMAGE_CHECKS_PASS\n' "$version" | tee "$run/RESULT.txt"
echo "Isolated acceptance retained at $run; stop its named containers after inspection. No production containers or volumes were used."
