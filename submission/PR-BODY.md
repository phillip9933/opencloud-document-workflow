Add Document Workflow, a lightweight document management app for OpenCloud with an Inbox, local OCR, optional AI, fields, tags and reviewed or automatic filing.

The entry targets [0.20.2 Beta](https://github.com/phillip9933/opencloud-document-workflow/releases/tag/v0.20.2). Processing requires an administrator-installed companion. The matching Docker kit bundles the Web app, Node, SQLite, Poppler, Tesseract and initial OCR data, plus an isolated optional converter. Traefik and external-proxy installation are documented. The store ZIP installs only the frontend and has its manifest and entrypoint at the ZIP root.

This update fixes backup recovery, temporary snapshot cleanup, processing contention and shutdown/rollback error handling. All 70 backend implementation modules now have strict type checks; processing and UI functions are smaller, with consistent privacy-safe diagnostics and errors. OCR and field/tag rules remain available when AI is off.

Validation:

- 784 source tests: 410 UI/domain, 361 companion and 13 packaging; strict frontend/backend checks, lint, formatting and native/standalone builds.
- [Fresh-install receipt](https://github.com/phillip9933/opencloud-document-workflow/releases/download/v0.20.2/INSTALL-ACCEPTANCE.txt): exact packaged kit on a new OpenCloud 9/Caddy environment, empty journal, HTTPS/authentication, synthetic backup restore and repeat installation without restarts.
- [Upgrade receipt](https://github.com/phillip9933/opencloud-document-workflow/releases/download/v0.20.2/UPGRADE-ACCEPTANCE.txt): upgrade from published 0.20.1 with synthetic fields, preferences and held decisions preserved.
- [Public download verification](https://github.com/phillip9933/opencloud-document-workflow/releases/download/v0.20.2/PUBLICATION-RECEIPT.json) and [acceptance scope](https://github.com/phillip9933/opencloud-document-workflow/blob/v0.20.2/docs/ACCEPTANCE_0.20.2.md).

Six screenshots use fictional documents and include AGPL-3.0-only redistribution terms. Source, exact locks and dependency notices are provided. This remains an independent community beta. Installation checks are distinct from signed-in browser/live inference checks; cross-Space external move reconciliation, broader proxy/server layouts, arm64 and live hosted-provider compatibility are not claimed. The catalogue is not asked to execute a server installer.
