Add Document Workflow, an independent community beta for OpenCloud 9: a PDF Inbox, local OCR, optional Ollama or explicitly configured compatible cloud AI, fields, tags and reviewed or automatic filing.

The entry links the [published 0.20.0 prerelease](https://github.com/phillip9933/opencloud-document-workflow/releases/tag/v0.20.0). It prominently states that processing requires an administrator-installed companion. The coordinated Docker kit bundles the Web app, Node, SQLite, Poppler, Tesseract and initial OCR data, plus an isolated optional converter. Traefik and external-proxy installation are documented. The store ZIP installs only the frontend and has its manifest and entrypoint at the ZIP root.

Validation for the tagged application commit:

- [Hosted CI](https://github.com/phillip9933/opencloud-document-workflow/actions/runs/41740899849): 364 UI/domain, 278 companion and 13 packaging tests, types, native/standalone builds and matching runtime-image checks.
- [Fresh installation acceptance](https://github.com/phillip9933/opencloud-document-workflow/blob/v0.20.0/docs/ACCEPTANCE_0.20.0.md): new OpenCloud 9/Caddy environment, empty initial workflow journal, authenticated HTTPS, synthetic backup restoration and repeat installation without restarts. CI publishes the same kit that passed these checks.
- [Public verification receipt](https://github.com/phillip9933/opencloud-document-workflow/releases/download/v0.20.0/PUBLICATION-RECEIPT.json): all packaged downloads matched SHA256; catalogue resources and six 3:2 JPEG screenshots returned public HTTP 200 with the expected image content types.

The screenshots use fictional documents and include AGPL-3.0-only redistribution terms. Application source, dependency notices, exact lockfile and corresponding build source are supplied. Review-first is the default; manual reviews and uncertain writes require explicit decisions. AI can be disabled while local OCR and field/tag rules remain available.

The acceptance record distinguishes command-line first-state verification from native UI/live inference checks. Cross-Space external move reconciliation, broader OpenCloud/proxy layouts, arm64 and live hosted-provider compatibility are not claimed. This contribution does not ask the catalogue to execute a server installer.
