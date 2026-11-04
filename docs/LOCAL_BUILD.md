# Build Document Workflow from source

Requires Node22.18 or newer, pnpm11.25.0 and Python3 for development packaging. End-user Docker installation requires none of those host runtimes; see QUICK_INSTALL.md.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:types
pnpm check:companion
pnpm lint
pnpm format:check
pnpm test
pnpm test:companion
pnpm test:packaging
pnpm build
pnpm build:draft
pnpm run sbom
python3 scripts/notices.py
pnpm package
pnpm package:draft
pnpm package:installer
python3 scripts/validate_release.py
```

The native ZIP is an OpenCloud Web extension using SDK8.2.1. The kit includes the corresponding source, exact dependency lock, notices and inventory. The Dockerfile bundles the runtime tools and initial OCR languages. See INSTALLATION.md and STORE_PACKAGING.md for installation, acceptance and publishing boundaries. No package contains a journal, app token, real document or host environment file. The SVG cover is generic artwork, not a screenshot of a user instance.

For isolated local development, use WORKFLOW_MODE=demo and a private synthetic journal; live mode needs the existing HTTPS OpenCloud origin, supported same-origin API route and the user's own authentication. There is no implicit hosted AI fallback or production intake cutover.

For isolated full-install acceptance on a Linux Docker host with the official OpenCloud 9 image available:

```sh
bash scripts/accept_fresh_install.sh /absolute/path/to/installation-kit.tar.gz KIT_SHA256 /new/absolute/scratch/directory
```

The harness creates a private test OpenCloud/Caddy environment with separate volumes and synthetic restoration data. It needs Docker, Compose, OpenSSL and image-download access. It does not reset a live deployment. Stop/remove its named test containers after inspection; retain its private scratch directory outside public source.

For upgrade acceptance, first install the published baseline kit with a distinct
isolated origin, then upgrade that same synthetic environment:

```sh
bash scripts/accept_fresh_install.sh /path/baseline-kit.tar.gz BASELINE_SHA256 /new/baseline https://workflow-upgrade.test
bash scripts/accept_upgrade.sh /new/baseline /path/candidate-kit.tar.gz CANDIDATE_SHA256 /new/upgrade https://workflow-upgrade.test
```

The upgrade harness requires labelled acceptance containers. It checks preservation
of synthetic fields, preferences and a held decision, verifies the upgraded service,
and confirms the OpenCloud container is retained and the proxy is unchanged.
OpenCloud restarts to register updated web assets; repeating the same install does
not restart services. It never targets an
unlabelled production installation. A separate fresh candidate run needs a different
origin and an empty installation history.

For a backend/domain coverage report, run `mkdir -p coverage && pnpm test:coverage`.
The LCOV report is `coverage/companion.lcov`; the console also reports line, branch
and function coverage for loaded source files. UI component tests run separately.
The reporting command is validated on the minimum Node 22.18 runtime and adds no
dependency or production service.

`WORKFLOW_DB` is the preferred journal-path setting. The legacy `WORKFLOW_DRAFT_DB`
name and existing default path remain accepted. Package/build script names and
archive wrappers containing “draft” remain stable for installation compatibility.
