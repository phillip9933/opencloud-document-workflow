# 0.20.2 submission validation

The cleanup has 784 passing source tests: 410 UI/domain, 361 companion and 13 packaging. All 70 companion implementation modules are strictly type-checked. Frontend checks, lint, formatting and both builds are required as well.

The pre-version-bump cleanup passed [isolated NAS acceptance](../docs/ACCEPTANCE_CLEANUP_2026-11-05.md). That earlier archive is not the 0.20.2 release artifact. [0.20.2 acceptance](../docs/ACCEPTANCE_0.20.2.md) defines the exact hosted release checks and receipts: fresh OpenCloud 9/Caddy installation, empty journal, HTTPS authentication boundary, synthetic restoration, repeat installation and upgrade from published 0.20.1.

Only unmodified packages from the successful tagged-commit CI run may be published. Verify public hashes, flat ZIP manifest/entrypoint, corresponding source, all catalogue URLs and image content types before updating PR #62. The source and artwork are AGPL-3.0-only; dependency notices and exact locks are supplied.

The supported acceptance baseline is Linux/amd64, OpenCloud 9 and SDK 8.2.1. Command-line installation checks do not claim a new signed-in browser filing/inference cycle. Cross-Space external moves, broader server/proxy layouts, arm64 and live hosted-provider compatibility remain unclaimed. Store installation does not deploy the companion automatically.
