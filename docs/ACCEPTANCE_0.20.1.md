# 0.20.1 beta acceptance

Verified on 2026-11-04. This candidate remains unpublished; the production installation was not changed.

## Source checks

- 710 passing tests: 321 companion, 376 UI/domain, 13 packaging; none skipped.
- Strict frontend types and 30 explicitly included backend modules pass.
- ESLint, Prettier, diff checks, native/standalone builds and release-package validation pass.
- Backend tests and coverage pass on the minimum supported Node 22.18 runtime. Loaded backend/domain source coverage: 93.27% lines, 82.95% branches, 87.91% functions. This is not whole-application or browser coverage.

## Isolated installation and upgrade

The Linux Docker host used Docker 29.8.2, the official OpenCloud 9.0.0 image and Caddy 2. Test origins, containers, networks and persistent storage were separate from the live installation. Only synthetic records were used; no production documents or credentials were copied.

The published 0.20.0 installation kit was verified against its published SHA256:
`1ea5063a1f2b2f6b79aee34de2a0b54e9f177adb9432854c701da1295efe0cc8`.
It passed the fresh-install harness, then upgraded to the 0.20.1 candidate.

The tested candidate kit SHA256 was:
`c7c8ab1cb328abac1ae3d6fe9f22db88c6273d2864efe9855a88bfe8e6ecaf54`.

- Upgrade completed with a matching, healthy 0.20.1 companion.
- Synthetic custom fields, preferences and a held filing decision matched before and after the upgrade.
- Repeating the upgraded install retained all test service IDs and start times.
- A separate fresh 0.20.1 install started with an empty journal.
- Synthetic snapshot verification and offline restore passed; restored ingestion remained paused.
- HTTPS routing, authentication-required behavior and matching frontend/backend versions passed.
- Repeating the fresh install did not restart services.
- Bundled companion and packaging tests passed without network access, alongside Poppler extraction and Tesseract language discovery.

The new upgrade harness initially asserted that OpenCloud would not restart. That assertion was corrected: a changed web release intentionally restarts OpenCloud registration. Data preservation and repeat-install checks were verified separately after that correction. No application fix was needed for this test expectation.

## Boundaries

The tested kit contains the application/runtime changes described in the release notes. Acceptance documentation and test-harness refinements were completed afterward; a future rebuilt distribution has a different archive checksum and must not be presented as the identical tested archive.

The larger workflow, intake, journal and provider orchestration remains incrementally typed; this release does not claim full backend type coverage. These checks do not constitute a security audit, a production rollout, an authenticated live-document filing test, or a new compatibility claim for other OpenCloud versions/proxy configurations.
