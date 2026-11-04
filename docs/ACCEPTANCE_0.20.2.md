# 0.20.2 beta acceptance

The cleanup passed 784 local tests (410 UI/domain, 361 backend, 13 packaging),
strict frontend and full backend checks, lint, formatting and both builds. All
361 backend tests also passed on the minimum supported Node 22.18.0.

Before the version bump, the same application cleanup passed an isolated fresh
NAS installation. That archive retained the old version number and is not the
0.20.2 release artifact; see [the dated NAS record](ACCEPTANCE_CLEANUP_2026-11-05.md).
Production services, documents and credentials were not changed.

Publication requires successful hosted CI for the tagged commit. The release
assets must be the unmodified packages from that run, with these attached receipts:

- `INSTALL-ACCEPTANCE.txt`: exact-package fresh OpenCloud 9/Caddy installation,
  empty journal, HTTPS authentication boundary, synthetic backup restore, and
  repeat installation without service restarts.
- `UPGRADE-ACCEPTANCE.txt`: isolated upgrade from the checksum-pinned public
  0.20.1 kit, preserving synthetic fields, preferences and held decisions.
- `IMAGE-IDS.txt`: images used in fresh-install acceptance.
- `PUBLICATION-RECEIPT.json`: subsequent verification of public release downloads
  and catalogue URLs against the hosted artifact checksums.

These are synthetic command-line checks, not a new signed-in browser filing or
live AI-provider evaluation. No broader OpenCloud/proxy matrix, arm64 or hosted
provider compatibility is claimed. Release publication does not upgrade any
existing NAS installation.
