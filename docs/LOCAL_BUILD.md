# Build Document Workflow from source

Requires Node22.18 or newer, pnpm11.25.0 and Python3 for development packaging. End-user Docker installation requires none of those host runtimes; see QUICK_INSTALL.md.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:types
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
```

The native ZIP is an OpenCloud Web extension using SDK8.2.1. The kit includes the corresponding source, exact dependency lock, notices and inventory. The Dockerfile bundles the runtime tools and initial OCR languages. See INSTALLATION.md and STORE_PACKAGING.md for installation, acceptance and publishing boundaries. No package contains a journal, app token, real document or host environment file. The SVG cover is generic artwork, not a screenshot of a user instance.

For isolated local development, use WORKFLOW_MODE=demo and a private synthetic journal; live mode needs the existing HTTPS OpenCloud origin, supported same-origin API route and the user's own authentication. There is no implicit hosted AI fallback or production intake cutover.
