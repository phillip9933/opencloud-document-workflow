# Architecture

Document Workflow combines a native OpenCloud Web extension with one Node companion. It follows the [OpenCloud app skeleton](https://github.com/opencloud-eu/web-app-skeleton) and uses Web SDK 8.2.1. OpenCloud remains the owner of document files, resource identities, tags and permissions.

## Web extension

`src/components/NativeWorkspace.vue` attaches the host session; `src/state/workspace.ts` sends authenticated same-origin requests. `src/views/` contains Inbox, Documents, Activity and Settings. PDF.js worker, fonts, CMaps and codecs are packaged locally. The native ZIP root `document-workflow` matches the generated manifest's app ID. The host router is shared rather than bundled privately.

## Companion

`companion/server.mjs` exposes `/_workflow/api/` behind the existing HTTPS proxy. It validates current identity and authorized Space access through OpenCloud Graph/DAV. Caller-supplied account identifiers do not establish ownership. Credentials are not returned to the browser or stored in browser storage.

The companion owns a private SQLite journal for settings, metadata, queue state, proposals, approvals, mutation intents and activity. Original live documents stay in OpenCloud. Demo mode instead uses synthetic PDFs in an isolated journal and cannot access live OpenCloud files.

A durable intake loop checks upload stability, prepares bounded jobs and retries transient failures. OpenCloud App Tokens are stored separately from the journal and are required for reliable unattended access. They are excluded from journal backups. Backup snapshots and manifests can be uploaded to a configured OpenCloud folder; administrators must restrict access because snapshots include workflow records for users served by this companion.

## Processing and writes

Poppler extracts text; missing-text pages can use local Tesseract. Original PDF bytes are never rewritten. Local Ollama and compatible hosted endpoints use explicit task routing. Hosted transmission requires operator configuration and user consent. There is no implicit provider fallback.

Model output must fit the schema and quote extracted page text. Dates, paths, categories, field values and tags are validated before proposal acceptance. Text is untrusted input. Literal quotes cannot establish semantic truth, so human review is the default.

Approvals bind to the exact source identity, hash, ETag, proposal and selected actions. Before DAV MOVE the worker rechecks the source, refuses collisions, persists intent, uses `If-Match` and `Overwrite: F`, and verifies destination identity/hash. Graph tags are additive and verified separately. MOVE and tag updates are not one atomic server transaction. Uncertain outcomes remain held; reconciliation reads remote state instead of blindly replaying writes.

Identical-byte duplicate handling is scoped to the authenticated workflow. Recoverable Trash is opt-in and verified. No similarity-based automatic deletion or purge is exposed.

## Deployment

The companion runs without root, with a read-only filesystem, dropped capabilities, private volumes and no published host ports. The proxy forwards Host, Origin and Authorization to a same-origin route. Traefik automation is optional; external proxies need an equivalent route. No raw OpenCloud storage or identity-provider changes are required.

The installer builds the pinned Node image with Poppler/Tesseract, installs matching native assets, checkpoints managed journal state for upgrades and retains rollback evidence. Unknown existing assets and manually managed workers hold installation. See QUICK_INSTALL.md.

## Language extensibility

UI translations, Tesseract OCR packs and document interpretation rules are separate concerns. Data-only interpretation packs provide labels and extraction cues; names and source quotes retain their original script. Unsupported date formats remain review holds. No fixed English/Japanese allowlist is imposed on future packs.
