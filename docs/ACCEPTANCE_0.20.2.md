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

## Published artifact record — 2026-11-05

[0.20.2 Beta](https://github.com/phillip9933/opencloud-document-workflow/releases/tag/v0.20.2)
uses commit `6a29df8e3cbc23c1a3d281b7f2aac32529a49500` and the unmodified
packages from [run 41860820885](https://github.com/phillip9933/opencloud-document-workflow/actions/runs/41860820885).
All 784 source tests, type/lint/build checks, offline runtime tests, exact fresh
installation and upgrade from public 0.20.1 completed successfully. Archive hashes,
frontend identity and 291 tracked source files were checked against the tagged checkout.

Installer SHA256:
`ac154a300cfd16c5ff72b182ac9b1f5f0f1e87a4d3f50d2a5d4e64faeca81eef`.

All 15 packaged assets matched their CI hashes when downloaded without authentication;
11 catalogue resources and image URLs returned HTTP 200 with expected image types.
[Public verification receipt](https://github.com/phillip9933/opencloud-document-workflow/releases/download/v0.20.2/PUBLICATION-RECEIPT.json).
The receipt is an additional release asset; no tested package was rebuilt or replaced.

GitHub status limitation: the job reports success for every step, including cleanup,
and its completed log and artifacts are available. However, aggregate run/check reads
still report in progress while cancellation reports the run is no longer in progress.
Publication relied on the completed step logs and verified receipts; a completed-success
aggregate status is not claimed. A redundant verification was requested, then cancellation
was requested after the exact artifacts were independently verified. This discrepancy is
also disclosed in the release and OpenCloud PR.

[OpenCloud PR #62](https://github.com/opencloud-eu/awesome-apps/pull/62) now references
this release. Its companion requirement and Beta designation are retained. Production
NAS services, documents and credentials were not changed during publication.
