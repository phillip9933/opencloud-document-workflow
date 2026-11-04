# Architecture

Document Workflow is a native OpenCloud Web extension and a Node companion. OpenCloud owns files, identities, permissions and tags. The companion keeps workflow records and custom fields in a private SQLite journal. Original documents remain in OpenCloud.

## Components and boundaries

| Component | Responsibility |
| --- | --- |
| `NativeWorkspace.vue` | Attach the authenticated OpenCloud host session and router. |
| `state/workspace.ts` | Coordinate selected Space, document lists, review attempts and drafts. |
| `state/companion-request.ts` | Send same-origin requests and verify identity after bearer renewal. |
| `state/verified-preview.ts` | Display only the latest PDF request whose bytes match the recorded hash. |
| `draft-api.mjs` (`createWorkflowAPI`) | Authenticate requests, validate their boundary and dispatch named routes. |
| `Workflow` | Authorize preparation/filing, hold operation locks and enforce source/evidence guards. |
| `ProposalJournal` | Persist attempts and validated results; never treat a cached result as approval. |
| `Intake` / `intake-policy.mjs` | Schedule stable uploads, recover queues and classify retry/cancel eligibility. |
| `provider-routing.mjs` | Validate operator-approved task routes; keep local and hosted providers explicit. |
| `filing.mjs`, `Transfers`, `Metadata`, `DocumentTrash` | Execute recorded mutation stages and read-only recovery. |
| `pending-operations.mjs` | Share canonical-resource and historical-alias write interlocks. |
| `remote-transport.mjs`, `dav-response.mjs` | Guard authenticated destinations and parse scoped DAV/Trash responses. |
| `file-listing.mjs` | Classify current files with six scoped database reads, independent of list length. |
| `services.mjs` | Validate and bind the complete production dependency graph before background work. |

The production graph rejects missing or conflicting services and prevents later replacement of its service references. Constructors never register themselves on the workflow. Unbound service access fails closed; test fixtures explicitly assemble the same graph with replaceable test doubles. OpenCloud remains authoritative even when local records exist.

## Reading and preparation

Poppler extracts PDF text; Tesseract handles scanned pages independently of AI. Conversion of images/Office files is opt-in and runs in an isolated converter without credentials, persistent storage or an internet route. Original-format files remain browseable and manually fileable.

The selected local Ollama or hosted endpoint receives bounded complete source text. Hosted processing requires configuration and consent; there is no implicit fallback or page truncation. Every proposed fact must meet the schema and evidence checks. Missing/ambiguous evidence creates a manual-review hold rather than a guessed value. Typed error codes govern fallback and correction decisions; display translations cannot grant processing or mutation authority.

`readDocument` owns the pinned read/OCR boundary, and the journal separates request identity, generation and persistence. `Intake.tick` owns scheduling; per-session and per-item helpers own queue selection and retry decisions. Lock contention and expired sessions do not consume document retry attempts. Intake stops the current download cycle at the first busy preparation. Batch preparations retry queued contention with a bounded timer that stops on shutdown, and automatic work retains its authorization while pending; uncertain writes still require their existing recovery path.

See [Processing and recovery invariants](PROCESSING_SAFETY.md) for OCR supplementation, provider capacity, date interpretation, similarity, conversion and background-session rules.

## Approval, writes and recovery

Approval binds the exact source identity, ETag, full hash, review bundle and selected actions. Workflow checks those under job/resource locks before invoking a mutation service. Persisted intents precede remote writes. Conditional moves cannot overwrite another file; completion requires remote identity/hash/tag verification.

MOVE and tag changes are separate remote operations. A lost response remains held. Reconciliation reads remote state and does not blindly repeat writes. Metadata edits and tag removal use the same identity/version guards; removing a tag never deletes its global definition. Similar documents cannot authorize automatic Trash. Cross-Space transfer support remains separately guarded; ordinary external-move reconciliation covers only the configured filing tree in one Space.

## Journal and process ownership

`migrations.mjs` owns the persistent schema and transactional `user_version` upgrades. Version 1 adopts the released unversioned schema, validates the resulting shape and preserves existing approvals, fields, tags and uncertain intents. Newer or altered schemas stop startup. Future schema changes append migrations instead of editing the baseline.

A separate `.runtime.sqlite3` sidecar holds a process-lifetime SQLite transaction. The OS releases it after an unclean stop, avoiding hostname/PID reuse errors. Only that owner opens a writable journal. Interrupted reads require explicit retry; uncertain writes retain their recovery records. Never unlink the sidecar while a companion is running.

`withTransaction` is for synchronous journal work only. It rejects Promise-returning callbacks and rolls back callback/commit failures. Network requests stay outside transactions. Process ownership and location snapshots retain their specialized transaction/savepoint behavior.

## Browser state and localization

Reviews are indexed by job identity, including separate attempts with identical contents. Refresh preserves selection and rejects late responses from another workspace. Session renewal re-authenticates the same server/account/Space before exposing a pending response. Preview loading likewise discards stale locations, errors and hash results; unchanged bytes retain the existing detail preview.

UI language, OCR languages and document interpretation packs are separate. Stable backend error codes map to translated display messages in English, Japanese, Spanish, French and German. Stage-specific holds retain their safe diagnostic detail. Unknown failures are redacted by the API instead of becoming document-review holds. Display messages never determine recovery behavior.

## Operations and deployment

The native store ZIP installs frontend assets only. The coordinated kit installs the companion and converter behind a same-origin proxy. The companion runs without root, with dropped capabilities, a read-only filesystem and private volumes. PDF.js fonts, CMaps, worker and codecs are bundled locally. Traefik is optional; the fresh-install acceptance harness also covers Caddy. See [Installation](INSTALLATION.md).

`createWorkflowAPI` is the production API factory. `createDraftAPI` remains a compatibility alias. `WORKFLOW_DB` selects the journal; `WORKFLOW_DRAFT_DB` and the old default path remain supported to avoid silently moving an existing installation. Historical build/archive names are retained for installer compatibility.

OpenCloud App Tokens are stored separately from the journal and excluded from journal backups. Backups may contain workflow records for every user served by the companion; their storage requires appropriate access restrictions.

Backup staging uses its own private SQLite ownership sidecar on local storage. Its transaction is released after an unclean stop; legacy hostname/PID lock files no longer govern ownership. Under that lock, cleanup removes only generated temporary snapshots not referenced by a pending upload. Corrupt upload intents stop cleanup, and uncertain uploads retain their stage for read-only reconciliation. Saved snapshots are never automatically pruned: configured capacity is a hold limit, not a rolling retention policy.

Structured logs contain fixed events, bounded error codes/statuses and packaged source locations. They omit raw messages/stacks, paths, document contents and credentials. Backup, session, batch and automation failures use the same allowlist. Expected sign-in and lock-contention events have lower severity than unexpected internal errors. Unexpected worker failures update health; partial HTTP responses close rather than attempting a second response. Logs never authorize retries.

## Code organization and validation

Strict `checkJs` covers every companion implementation through `companion/**/*.mjs` (70 modules), including server/CLI entry points, development plugins, backups and background sessions. The build plugins are checked as implementations, without declaration files masking them. Shared contracts describe service ownership, provider responses, authenticated requests, mutation inputs and persisted projections. Runtime boundary validation remains necessary; TypeScript does not validate stored JSON or remote responses. Compile-only regression fixtures reject incomplete mutation inputs, invalid settings and unsafe transaction callbacks.

The API factory authenticates requests, validates their boundary and delegates to named route groups. Unknown errors return a redacted 500. Typed request, access, provider and held-operation errors have explicit HTTP mappings. Provider capability probes use structured status/codes rather than display text. Text-based diagnostic classification cannot authorize a retry, fallback or mutation. Lint rejects new plain `Error` construction in application code.

Preparation separates ownership, pinned reading/OCR, generation and persistence. Automatic execution separates authorization, independent field resolution, reauthorization and approval. Duplicate processing separates pair locks, byte/identity verification and its one-shot Trash intent. Transfers separate copying, tag verification, source Trash recovery and final identity recording; destination locks remain held through asynchronous final verification. Backup publication separates staging ownership from one-shot uploads and read-only outcome checks. None of these boundaries permit replaying uncertain writes.

Scheduling and queue draining are separate. Each item uses the latest verified session without spending retries on contention. Status reuses one queue snapshot; file listing uses six scoped reads and a job page uses three, independent of page length. Preparation attempts use named ownership fields instead of positional tuples. Legacy PID/hostname columns remain for schema compatibility, but no longer contain process identifiers or govern ownership.

The review and details views compose presentation components around focused controllers. `filing-draft`, `review-decisions`, `metadata-actions`, `review-collection`, `verified-preview` and navigation each own their state transitions. Metadata and filing components emit drafts/actions; they do not write document records. Shared filing-state predicates keep editing, continuation and uncertain-write controls consistent. Processing settings preserve unsaved choices across tabs and keep OCR/rule-based fields independent of AI.

Lint caps companion, state-controller and view function complexity at 25, with stricter 15/20 limits on the cleaned operation/recovery/automatic/duplicate paths. The cap does not claim every function is below 15. Regression suites cover UI/domain behavior, companion failures and packaging. `test:coverage` measures loaded backend/domain code and emits LCOV; it does not claim browser coverage. CI pins external actions to verified commits.

Fresh-install/upgrade acceptance is a separate release requirement. Passing local tests, types, builds and archive validation does not establish NAS/container compatibility. See [Review follow-up](REVIEW_FOLLOWUP_0.20.1.md) for the cleanup evidence and installation boundary.
