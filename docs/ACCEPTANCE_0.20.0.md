# 0.20.0 Beta installation acceptance — 2026-11-04

The coordinated installation kit was exercised on Linux/amd64 with a new OpenCloud 9.0.0 container and Caddy as an external HTTPS proxy. The temporary environment used an internal Docker network, separate configuration/data/apps directories and new workflow volumes. No production documents, permissions, app tokens or deployment volumes were used.

## Performed

1. Verified the installation-kit SHA256 before extraction and built its matching runtime image without modifying the installer or application. Used the official OpenCloud 9.0.0 image and official Caddy 2 image; runtime image identities were recorded privately with the test results.
2. Configured Caddy's same-origin API route and a temporary test certificate. The companion used the installer's explicit trusted-CA option; its TLS validation stayed enabled. The isolated OpenCloud self-signed-certificate setting followed the upstream Compose baseline. No test ports were exposed publicly.
3. Ran the unmodified doctor/install flow. Doctor reported no current app, and installation created fresh managed volumes and registered the matching frontend.
4. Verified that proposals, decisions, custom fields, schemas, Inbox configuration and preferences initially contained zero records. Verified the installed native manifest and the OpenCloud Web frontend response. This was a command-line first-state check; a new browser login/first-run wizard was not performed in this isolated environment.
5. Verified matching HTTPS health and rejection of an unauthenticated companion request. Existing live 0.20.0 native UI acceptance remains a separate check.
6. Added one fictional field record to the isolated journal, created and verified its backup, and restored to a separate database through the official restoration function. The field survived, ingestion was paused and restoration made zero network requests. This did not restore a real user's journal or app-token credentials.
7. Repeated installation successfully: it reported already installed and healthy; OpenCloud, companion and converter identities/start times were unchanged.
8. Ran all 278 companion and 13 packaging tests inside the matching non-root, read-only runtime without network access or production-data mounts. Poppler extraction and bundled English/Japanese Tesseract data passed. The separate 364 UI/domain tests, types and both builds also passed.

The reusable harness is scripts/accept_fresh_install.sh. OpenCloud status.php exposes an OwnCloud-compatible version separately from productversion; the harness checks the OpenCloud product version. The final distribution checksum and hosted CI are recorded in the release assets/notes.

## Scope

This verifies fresh installation, empty initial workflow state, external-proxy routing, synthetic restoration and repeat installation on this baseline. It complements the earlier live Traefik upgrade and native UI tests. A new live upload/Ollama/filing cycle was not rerun in this pass. Arm64, other OpenCloud releases and live hosted-provider acceptance remain unclaimed. Catalogue ZIP installation supplies only the frontend; the server companion still needs administrator installation. No upstream store approval or OpenCloud certification is implied.
