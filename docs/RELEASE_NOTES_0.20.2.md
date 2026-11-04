# 0.20.2 beta — recovery, queues and complete backend type coverage

This maintenance release fixes abandoned backup locks and temporary snapshots,
keeps busy processing work queued for retry, avoids unnecessary intake downloads,
and preserves the original error during shutdown and database rollback failures.
Saved backups and uncertain upload records are retained.

All 70 backend implementation modules now have strict type checking. Request
validation and typed errors distinguish expected document holds from internal
failures. Structured diagnostics omit document contents and credentials.
Processing, duplicate handling, conversion and recovery functions are smaller,
and review, metadata and settings screens use focused components and controllers.
Queue listings avoid repeated per-document database reads.

The source suite has 784 passing tests: 410 UI/domain, 361 backend and 13 packaging.
Existing source identity, evidence, approval, conditional-write and uncertain-write
recovery checks remain intact. No new runtime service or dependency is added.
OCR and matching rules remain independent of optional AI processing.

Use the matching installation kit for the frontend and companion. The installer
recognizes the published 0.20.1 frontend inventory for guarded upgrades. The store
ZIP alone installs only the frontend. Start with Review first.

See [acceptance](ACCEPTANCE_0.20.2.md) for the exact release validation boundary.
