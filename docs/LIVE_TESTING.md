# Synthetic testing

Build using LOCAL_BUILD.md, then start `WORKFLOW_MODE=demo pnpm run draft`. Open the loopback URL printed by the server and connect the demo workspace. Use only synthetic fixtures for development. Demo mode keeps copies in its private journal and does not access OpenCloud.

For live acceptance, use a dedicated test Space and your own OpenCloud credentials. Begin in Review first mode. Verify PDF preview, OCR, extracted facts, paths, fields, tags, unchanged PDF hashes, sequential review, exact-duplicate recovery, restart behavior and backup restoration. Do not point two workers at the same intake folder.

Hosted inference must be explicitly enabled and authorized. Do not submit real personal documents, credentials or deployment logs in public issues.
