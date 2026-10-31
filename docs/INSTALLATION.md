# Installation and OpenCloud store boundary

Document Workflow has a standard OpenCloud Web extension and one companion service. The release provides both packages. The current catalogue provides downloadable web ZIPs; it does not deploy this companion or its container automatically. Use matching versions of both components. The official [Web Apps guide](https://docs.opencloud.eu/de/docs/admin/configuration/web-applications/) describes download, extraction into the apps directory and restart; [the catalogue](https://github.com/opencloud-eu/awesome-apps) explicitly lists Forms, News, Notes and ocphotos as companion-backed apps. This is architectural precedent, not OpenCloud certification of this product.

## What is added where

| Component | Location | Purpose |
| --- | --- | --- |
| Web ZIP | OpenCloud `WEB_ASSET_APPS_PATH/document-workflow` | UI, manifest, host router/session integration and local PDF assets |
| One companion container | Same private network as the existing reverse proxy | Watches Inbox; manages reviews, inference, fields, OCR and backups |
| Node, Poppler, Tesseract | Inside the dedicated companion image | Runtime, PDF text and local OCR; no host installation or Paperless service required |
| Active journal | Private `/state` volume | SQLite metadata, configuration, approvals, mutation intents and audit history |
| App tokens | Separate private `/credentials` volume | User-entered OpenCloud credential; excluded from journal/backups |
| OCR packs | Writable `/workflow-tessdata` volume | Initial English/Japanese data plus explicit admin-installed official packs |
| Backup staging/config | Private `/backups` volume | Temporary upload/verification, backup settings, earlier local recovery material |
| Saved backup files | Administrator-selected OpenCloud Space/folder | Verified SQLite snapshot and matching JSON manifest; includes this companion's users' workflow records |
| API route | Existing HTTPS host `/_workflow/api/` | Same-origin authenticated requests; no extra public hostname or host port |
| AI service | Existing Ollama or configured compatible cloud provider | Models; no model service is installed automatically and no cloud fallback occurs |

OpenCloud remains the owner of original documents, native tags, permissions, Trash and user authentication. The active SQLite journal and credentials stay outside OpenCloud document folders; only backup snapshots are uploaded. Backups exclude the token directory. Installing this app does not change identity-provider grants, scanner routing or OpenCloud core binaries.

## Coordinated installation kit

Source0.13 adds a self-contained kit with `./install.sh install` for the existing Docker/Traefik baseline. It detects the apps directory/origin/network, builds the runtime automatically, installs matching web assets, preserves private state across managed upgrades, checkpoints the journal and verifies the HTTPS route/sign-in boundary. `doctor` checks the proposal first. See [QUICK_INSTALL.md](QUICK_INSTALL.md) and [STORE_PACKAGING.md](STORE_PACKAGING.md) for exact scope and acceptance. This is a local release kit; it has not been published or submitted to the catalogue. The existing manually managed0.12 NAS trial is unchanged.

## Container installation

Build and package from the source using README.md's checked commands, then use `deploy/container/compose.yaml`. The Dockerfile uses the maintained Node22 Debian image (which may be pinned through `NODE_IMAGE`); record its exact resolved image digest and installed package inventory during acceptance. It bundles the runtime tools in a dedicated image, rather than depending on an existing Paperless installation. The Compose example creates four named application volumes, runs as UID65534 with read-only root/dropped capabilities/resource limits, and publishes no host port. Fresh Docker volumes inherit the image's ownership. Bind mounts require the operator to prepare matching ownership/permissions explicitly; never solve that by making credentials world-readable.

Set only the existing OpenCloud HTTPS origin/hostname, existing proxy network, optional initial Space and authorized Ollama URL. Adapt the documented route to the installation's existing proxy/TLS configuration if it is not Traefik. Preserve Authorization, Host and Origin; no CORS or authentication bypass is needed. The example is an administrator deployment template, not an automatic change to an existing stack.

Install the matching native ZIP in the official apps directory and reload OpenCloud registration. Configure folders/models in the UI, enter your own OpenCloud App Token for unattended work, and select the backup Space/folder in System. The app reports missing companion/credential/tool access rather than silently falling back. English/Japanese OCR starts bundled; other packs are installed from Processing → Manage languages.

See STORE_PACKAGING.md for catalogue submission and tested compatibility. The store ZIP installs only the frontend; an administrator must install the matching companion kit.
