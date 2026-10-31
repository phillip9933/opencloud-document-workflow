# 0.14.5 installation acceptance — 2026-10-31

The published v0.14.5 installation kit was downloaded from GitHub, checked against its published SHA256, built without changes and installed on a Linux/amd64 OpenCloud 9 instance using its existing Docker Compose and Traefik setup. The native frontend uses Web SDK 8.2.1.

## Performed

1. Created and verified private online/stopped database snapshots, native-app and complete prior-installation archives, the old runtime image and deployment configuration. Retained the old worker disabled for recovery.
2. Removed the old frontend registration and manual worker from the active deployment, preserving original document storage. Confirmed that Document Workflow disappeared from the app switcher.
3. Ran the unchanged published installer's doctor and install commands. It reported no existing app/journal, created fresh managed volumes, registered the frontend and started the matching companion. HTTPS health and unauthenticated API rejection passed.
4. Verified the new journal initially had no proposals, decisions, personal metadata schema or filing configuration. The native UI displayed its first-run Choose inbox screen.
5. Restored the verified prior snapshot using the official restore function. Compared all 24 historical tables; records and settings matched, with the documented paused-intake and cleared-lock restoration behavior. Retained the fresh journal separately. Restored OCR packs and backup preferences and resumed the selected Inbox through the UI.
6. Verified the restored library, rendered an existing synthetic PDF and used Verify file successfully against OpenCloud.
7. Repeated installation: it reported already installed and healthy, with no companion or OpenCloud restart. The new companion runs without root, with a read-only root filesystem, dropped capabilities, named data volumes and no host ports. Other existing services retained their identities/images/start times.
8. Ran all 157 companion and 11 installer tests inside the exact installed image, without network access or production-data mounts. They passed, including real PDF extraction/OCR fixtures. The 223 frontend/domain tests, type checks, both builds and image build also passed in [hosted CI](https://github.com/phillip9933/opencloud-document-workflow/actions/runs/41185178362).

## Distribution and scope

The live OpenCloud App Store's own help describes ZIP downloads followed by administrator installation; it does not install server companions. The application is not yet in the upstream catalogue. This acceptance used the exact published ZIP/kit that the prepared listing links; it does not claim installation through an already-approved catalogue entry.

The pass verifies fresh installation, first-run UI, restoration, retained document preview/identity and repeat installation on this baseline. A new upload/inference/filing cycle through the live UI was not rerun in this pass. Earlier live local-Ollama workflow acceptance and the isolated runtime ingestion tests retain their separate scopes. Caddy/external-proxy, arm64, broader OpenCloud versions and live hosted-provider acceptance are not claimed.

No private hostnames, profiles, credentials, journals, actual document names or deployment archives are included in this repository. This is an independent community pre-release, not OpenCloud certification.
