# Document Workflow companion

The Node companion provides watched-folder intake, PDF extraction/OCR, local or explicitly configured hosted AI, durable review and approvals, fields/tags, conditional filing, recovery and journal backups. Original live PDFs stay in OpenCloud. See [Architecture](../docs/ARCHITECTURE.md) and [Installation](../docs/INSTALLATION.md).

The [published installation kit](https://github.com/phillip9933/opencloud-document-workflow/releases) builds a container with Node, SQLite, Poppler, Tesseract and initial OCR data. The native Web ZIP alone cannot process documents. Source development requires Node 22.18 or newer with TypeScript/SQLite support, the locked JavaScript dependencies and local PDF/OCR tools; see [Source builds](../docs/LOCAL_BUILD.md).

`server.mjs` defaults to a loopback listener. Live deployment uses the existing HTTPS origin and the same-origin `/_workflow/api/` route. Explicit private-network/listener flags are required for a container listener. Users sign in through OpenCloud; optional unattended access uses their own OpenCloud App Tokens in separate private storage. No token is included in a release, returned to the browser or included in journal backups. There is no implicit cloud fallback.

Core modules: `intake.mjs` queues arrivals; `extract.mjs` and `ocr.mjs` read PDFs; `providers.mjs` and `ollama.mjs` route inference; `journal.mjs` stores proposals; `workflow.mjs` binds approvals and conditional writes; `metadata.mjs` manages fields/tags; `opencloud.mjs` performs scoped Graph/DAV operations; `backups.mjs` verifies snapshots; `draft-api.mjs` handles authenticated requests.

Demo mode uses synthetic local copies and cannot access live OpenCloud. One-shot CLI preparation/review exports do not provide an authenticated capability to change OpenCloud files. Never expose a development Vite server as a production API.

The backup CLI verifies snapshots and restores only to a new database, with intake paused. The operator must verify restored state and permissions before starting a worker. Retain the prior journal and do not run two workers for the same intake. See [acceptance](../docs/ACCEPTANCE_0.14.5.md) for the tested baseline and limits.
