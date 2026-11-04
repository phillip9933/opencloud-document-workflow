#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Upgrade only an explicitly labelled, synthetic accept_fresh_install environment.
set -Eeuo pipefail
umask 077
baseline=$(realpath "${1:?isolated baseline directory required}")
kit=$(realpath "${2:?candidate installation kit required}")
expected=${3:?kit SHA256 required}
run=${4:?new absolute scratch directory required}
origin=${5:?isolated baseline origin required}
[[ "$run" = /* && ! -e "$run" && "$expected" =~ ^[a-f0-9]{64}$ && "$origin" =~ ^https://workflow-[a-z0-9-]+\.test$ ]]
grep -q '^FRESH_INSTALL_PASS ' "$baseline/RESULT.txt"
old=$(cat "$baseline/document-workflow/VERSION")
name=workflow-cleanup-fresh-${old//./-}
opencloud=$name-opencloud
proxy=$name-caddy
network=$name-net
for container in "$opencloud" "$proxy"; do
 [[ "$(docker inspect --format '{{index .Config.Labels "document-workflow.acceptance"}}' "$container")" = true ]]
done
printf '%s  %s\n' "$expected" "$kit" | sha256sum -c -
mkdir -p "$run"
tar -xzf "$kit" -C "$run"
cd "$run/document-workflow"
version=$(cat VERSION)
[[ "$version" != "$old" ]]
image=workflow-beta-upgrade-${version//./-}-runtime
docker build --build-arg "WORKFLOW_VERSION=$version" --tag "$image" image > "$run/build.log" 2>&1
project=$(docker run --rm --network none --read-only --entrypoint node "$image" \
 -e 'console.log("document-workflow-"+require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,10))' "$origin")
companion=$project-companion-1
# Synthetic scope cannot match an authenticated OpenCloud account or Space.
docker exec -i "$companion" node --input-type=module <<'JS'
import{DatabaseSync}from'node:sqlite';
const d=new DatabaseSync('/state/workflow.sqlite3');
d.prepare('insert into preferences values(?,?)').run('synthetic-upgrade',JSON.stringify({processingMode:'review',marker:'SYN-UPGRADE'}));
d.prepare('insert into decisions values(?,?,?,?,?,?)').run('synthetic-held-job','synthetic-upgrade',JSON.stringify({marker:'SYN-HELD'}),'held',null,new Date().toISOString());d.close();
JS
snapshot(){ docker exec -i "$companion" node --input-type=module <<'JS'
import{DatabaseSync}from'node:sqlite';import{createHash}from'node:crypto';
const d=new DatabaseSync('/state/workflow.sqlite3',{readOnly:true});
const rows=Object.fromEntries(['metadata','preferences','decisions'].map(t=>[t,d.prepare('select * from '+t+' order by 1').all()]));
console.log(createHash('sha256').update(JSON.stringify(rows)).digest('hex'));d.close();
JS
}
snapshot > "$run/before.sha256"
before=$(docker inspect --format '{{.Id}}' "$opencloud")
proxy_before=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$proxy")
args=(--opencloud-container "$opencloud" --proxy-container "$proxy" --network "$network" \
 --proxy-mode external --trusted-ca "$baseline/tls/ca.crt" --image "$image")
./install.sh install "${args[@]}" > "$run/install.log" 2>&1
grep -q "Installed Document Workflow $version" "$run/install.log"
docker exec "$companion" node /distribution/health-check.mjs "$origin"
snapshot > "$run/after.sha256"
cmp "$run/before.sha256" "$run/after.sha256"
after=$(docker inspect --format '{{.Id}}' "$opencloud")
proxy_after=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$proxy")
[[ "$before" = "$after" && "$proxy_before" = "$proxy_after" ]]
./install.sh install "${args[@]}" > "$run/repeat.log" 2>&1
grep -q 'already installed and healthy' "$run/repeat.log"
printf 'UPGRADE_PASS %s to %s\nSYNTHETIC_FIELDS_PREFERENCES_HELD_DECISION_PRESERVED\nOPENCLOUD_CONTAINER_RETAINED_PROXY_UNCHANGED_PASS\nUPGRADED_REPEAT_PASS\n' "$old" "$version" | tee "$run/RESULT.txt"
