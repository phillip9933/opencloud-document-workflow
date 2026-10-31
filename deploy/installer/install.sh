#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Host requirements: Bash, Docker and Compose v2 already used by OpenCloud.
set -Eeuo pipefail
umask 077
workflow_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
workflow_action=${1:-help};if (($#));then shift;fi
workflow_container=opencloud workflow_proxy=traefik workflow_origin='' workflow_apps='' workflow_network='' workflow_entrypoint='' workflow_image='' workflow_ollama='' workflow_ca='' workflow_proxy_mode=''
usage(){ cat <<'USAGE'
Usage: ./install.sh install|doctor [options]
  --opencloud-container NAME   existing OpenCloud container (default opencloud)
  --proxy-container NAME       existing Traefik container (default traefik)
  --origin https://HOST        override detected OC_URL
  --apps-dir /ABSOLUTE/PATH    override detected web-apps directory on Docker host
  --network NAME               existing OpenCloud/proxy network
  --entrypoint NAME            existing HTTPS entrypoint (default detected or https)
  --image REF                  use a matching prebuilt image instead of building
  --ollama-url http://NAS:11434 optional existing local AI endpoint
  --trusted-ca /ABS/CA.pem      optional existing private CA; TLS stays verified
  --proxy-mode external        use an already configured non-Traefik API route
  --ollama-url off             explicitly remove a saved local AI endpoint
  --trusted-ca off             explicitly remove a saved private CA mount

Install builds/pulls the bundled runtime, installs matching web assets, starts the
companion, restarts only OpenCloud registration and checks the HTTPS API route.
Doctor builds the helper image if needed and checks the proposed setup without
changing apps, starting the companion, or restarting OpenCloud. No tokens needed.
USAGE
}
if [[ "$workflow_action" = help || "$workflow_action" = --help ]];then usage;exit 0;fi
[[ "$workflow_action" = install || "$workflow_action" = doctor ]] || { usage >&2;exit 2; }
while (($#));do
 (($#>=2)) || { usage >&2;exit 2; }
 case "$1" in
  --opencloud-container) workflow_container=$2;; --proxy-container) workflow_proxy=$2;;
  --origin) workflow_origin=$2;; --apps-dir) workflow_apps=$2;; --network) workflow_network=$2;;
  --entrypoint) workflow_entrypoint=$2;; --image) workflow_image=$2;; --ollama-url) workflow_ollama=$2;; --trusted-ca) workflow_ca=$2;; --proxy-mode) workflow_proxy_mode=$2;;
  *) printf 'Unknown option: %s\n' "$1" >&2;exit 2;;
 esac;shift 2
done
for workflow_name in "$workflow_container" "$workflow_proxy";do [[ "$workflow_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { printf 'Invalid container name\n' >&2;exit 2; };done
command -v docker >/dev/null || { printf 'Docker is required on the OpenCloud server\n' >&2;exit 1; }
docker compose version >/dev/null
[[ "$(docker info --format '{{.OSType}}')" = linux ]] || { printf 'Use the Linux Docker host that runs OpenCloud\n' >&2;exit 1; }
IFS= read -r workflow_version < "$workflow_here/VERSION"
[[ "$workflow_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
command -v sha256sum >/dev/null || { printf 'The standard sha256sum utility is required\n' >&2;exit 1; }
(cd -- "$workflow_here" && sha256sum --check --status SHA256SUMS) || { printf 'Package file verification failed; use an intact release kit\n' >&2;exit 1; }
# Read only selected public metadata, never the container's full environment.
if [[ -z "$workflow_origin" ]];then workflow_origin="$(docker inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "OC_URL"}}{{index (split . "=") 1}}{{end}}{{end}}' "$workflow_container")";fi
workflow_mounts="$(docker inspect --format '{{json .Mounts}}' "$workflow_container")"
workflow_networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$workflow_container")"
workflow_proxy_networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$workflow_proxy")"
if [[ -z "$workflow_entrypoint" ]];then workflow_entrypoint="$(docker inspect --format '{{index .Config.Labels "traefik.http.routers.opencloud.entrypoints"}}' "$workflow_container")";[[ "$workflow_entrypoint" != '<no value>' ]] || workflow_entrypoint='';fi
if [[ -z "$workflow_image" ]];then
 workflow_image="document-workflow-companion:$workflow_version"
 if ! docker image inspect "$workflow_image" >/dev/null 2>&1;then docker build --tag "$workflow_image" "$workflow_here/image";fi
elif ! docker image inspect "$workflow_image" >/dev/null 2>&1;then docker pull "$workflow_image";fi
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$workflow_image")" = "$workflow_version" ]] || { printf 'Image version does not match this package\n' >&2;exit 1; }
workflow_image_id="$(docker image inspect --format '{{.Id}}' "$workflow_image")"
workflow_work="$(mktemp -d "${TMPDIR:-/tmp}/document-workflow-install.XXXXXXXX")"
workflow_token='' workflow_changed=false workflow_assets_attempted=false workflow_assets_completed=false workflow_stopped=false workflow_committed=false
workflow_dc(){ docker compose --project-name "$workflow_project" --file "$workflow_work/compose.yaml" "$@"; }
workflow_history(){ docker run --rm -i --pull=never --network none --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges --mount "type=volume,src=${workflow_project}_history,dst=/install-history" --entrypoint node "$workflow_image_id" /distribution/plans.mjs "$@"; }
cleanup(){
 local workflow_exit=$?
 trap - EXIT
 if [[ "$workflow_stopped" = true && "$workflow_committed" != true ]];then
  printf 'Installation did not complete; retaining data and restoring the previous app/runtime where verified\n' >&2
  workflow_dc stop companion >/dev/null 2>&1 || true
  local workflow_restore=true
  if [[ "$workflow_assets_attempted" = true && ( "$workflow_changed" = true || "$workflow_assets_completed" != true ) ]];then workflow_dc run --rm --no-deps web-assets rollback || { workflow_restore=false;printf 'Asset rollback held; processing stays stopped. Inspect the private installer history\n' >&2; };fi
  if [[ "$workflow_restore" = true && -s "$workflow_work/previous.yaml" ]];then docker compose --project-name "$workflow_project" --file "$workflow_work/previous.yaml" up -d --no-deps companion || printf 'Previous runtime could not restart; retained volumes are untouched\n' >&2;fi
  if [[ "$workflow_restore" = true && "$workflow_assets_attempted" = true && ( "$workflow_changed" = true || "$workflow_assets_completed" != true || ! -s "$workflow_work/previous.yaml" ) ]];then docker restart "$workflow_container" >/dev/null 2>&1 || true;fi
 fi
 if [[ -n "$workflow_token" ]];then workflow_history release "$workflow_token" || true;fi
 # This directory contains only this run's generated public deployment plans.
 rm -rf -- "$workflow_work"
 exit "$workflow_exit"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
workflow_generate_plan(){ docker run --rm -i --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
 --env "INSTALL_ORIGIN=$workflow_origin" --env "INSTALL_IMAGE=$workflow_image_id" --env "INSTALL_MOUNTS=$workflow_mounts" \
 --env "INSTALL_NETWORKS=$workflow_networks" --env "INSTALL_PROXY_NETWORKS=$workflow_proxy_networks" \
 --env "INSTALL_APPS=$workflow_apps" --env "INSTALL_NETWORK=$workflow_network" --env "INSTALL_ENTRYPOINT=$workflow_entrypoint" \
 --env "INSTALL_OLLAMA=$workflow_ollama" --env "INSTALL_CA=$workflow_ca" --env "INSTALL_PROXY_MODE=$workflow_proxy_mode" \
 --entrypoint node "$workflow_image_id" /distribution/plan.mjs; }
workflow_generate_plan < /dev/null > "$workflow_work/compose.yaml"
workflow_project="$(docker run --rm -i --pull=never --network none --read-only --cap-drop ALL --entrypoint node "$workflow_image_id" --input-type=module -e 'let b="";for await(const c of process.stdin)b+=c;console.log(JSON.parse(b).name)' < "$workflow_work/compose.yaml")"
workflow_origin="$(docker run --rm -i --pull=never --network none --read-only --cap-drop ALL --entrypoint node "$workflow_image_id" --input-type=module -e 'let b="";for await(const c of process.stdin)b+=c;console.log(JSON.parse(b).services.companion.environment.WORKFLOW_OPENCLOUD_ORIGIN)' < "$workflow_work/compose.yaml")"
workflow_dc config --quiet
printf 'OpenCloud: %s · release %s · project %s\n' "$workflow_origin" "$workflow_version" "$workflow_project"
# Refuse a parallel legacy worker rather than silently starting a second journal.
if docker container inspect document-workflow >/dev/null 2>&1;then
 workflow_legacy_origin="$(docker inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "WORKFLOW_OPENCLOUD_ORIGIN"}}{{index (split . "=") 1}}{{end}}{{end}}' document-workflow)"
 workflow_legacy_origin="$(docker run --rm --pull=never --network none --read-only --cap-drop ALL --env "INSTALL_LEGACY_ORIGIN=$workflow_legacy_origin" --entrypoint node "$workflow_image_id" -e 'console.log(new URL(process.env.INSTALL_LEGACY_ORIGIN).origin)')"
 if [[ "$workflow_legacy_origin" = "$workflow_origin" ]];then printf 'Existing manually managed Document Workflow found for this OpenCloud. No second worker was started. Use the documented migration plan.\n' >&2;exit 1;fi
fi
workflow_token="$(workflow_history acquire)"
workflow_history read > "$workflow_work/previous.yaml"
if [[ -s "$workflow_work/previous.yaml" ]];then workflow_generate_plan < "$workflow_work/previous.yaml" > "$workflow_work/compose.yaml";workflow_dc config --quiet;fi
workflow_dc run --rm --no-deps web-assets check > "$workflow_work/asset-check.json"
cat "$workflow_work/asset-check.json"
if [[ ! -s "$workflow_work/previous.yaml" && -n "$(workflow_dc ps -aq companion)" ]];then printf 'Managed runtime exists without a completed installer receipt; inspect retained history before continuing\n' >&2;exit 1;fi
if [[ "$workflow_action" = doctor ]];then printf 'Preflight passed. No app/runtime or OpenCloud registration was changed.\n';exit 0;fi
if [[ -s "$workflow_work/previous.yaml" ]];then
 read -r workflow_new_sum workflow_hash_rest < <(sha256sum "$workflow_work/compose.yaml")
 read -r workflow_old_sum workflow_hash_rest < <(sha256sum "$workflow_work/previous.yaml")
 if [[ "$workflow_new_sum" = "$workflow_old_sum" ]] && docker run --rm -i --pull=never --network none --read-only --cap-drop ALL --entrypoint node "$workflow_image_id" --input-type=module -e 'import{readFileSync}from"node:fs";let b="";for await(const c of process.stdin)b+=c;process.exit(JSON.parse(b).current===JSON.parse(readFileSync("/distribution/release.json","utf8")).version?0:1)' < "$workflow_work/asset-check.json" && workflow_dc exec -T companion node /distribution/health-check.mjs "$workflow_origin" >/dev/null 2>&1;then
  printf 'Document Workflow %s is already installed and healthy. No service was restarted.\n' "$workflow_version"
  exit 0
 fi
fi
if [[ -s "$workflow_work/previous.yaml" ]];then workflow_dc stop companion;fi
workflow_stopped=true
workflow_dc run --rm --no-deps checkpoint
workflow_assets_attempted=true
workflow_dc run --rm --no-deps web-assets install > "$workflow_work/assets.json"
workflow_changed="$(docker run --rm -i --pull=never --network none --read-only --cap-drop ALL --entrypoint node "$workflow_image_id" --input-type=module -e 'let b="";for await(const c of process.stdin)b+=c;const changed=JSON.parse(b).changed;if(typeof changed!=="boolean")throw Error("Invalid asset receipt");console.log(changed)' < "$workflow_work/assets.json")"
workflow_assets_completed=true
workflow_dc up -d --no-deps companion
workflow_ready=false
for workflow_attempt in {1..30};do
 if workflow_dc exec -T companion node /distribution/health-check.mjs >/dev/null 2>&1;then workflow_ready=true;break;fi
 sleep 1
done
[[ "$workflow_ready" = true ]] || { printf 'Companion failed its startup check\n' >&2;exit 1; }
if [[ "$workflow_changed" = true || ! -s "$workflow_work/previous.yaml" ]];then docker restart "$workflow_container" >/dev/null;fi
workflow_ready=false
for workflow_attempt in {1..30};do
 if workflow_dc exec -T companion node /distribution/health-check.mjs "$workflow_origin" >/dev/null 2>&1;then workflow_ready=true;break;fi
 sleep 1
done
[[ "$workflow_ready" = true ]] || { printf 'HTTPS API route did not reach the matching companion. Check the existing proxy network/entrypoint and trusted certificate.\n' >&2;exit 1; }
workflow_history commit < "$workflow_work/compose.yaml"
workflow_committed=true
printf 'Installed Document Workflow %s. Open %s/document-workflow/settings to choose folders, AI models and optional background access.\n' "$workflow_version" "$workflow_origin"
