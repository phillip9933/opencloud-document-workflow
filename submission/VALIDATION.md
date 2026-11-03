# Candidate validation — 0.20.0 Beta

Release validation for 0.20.0 Beta, 2026-11-04. Hosted CI and public download verification are recorded with the GitHub prerelease. The catalogue contribution is prepared for maintainer review.

## Completed

- 364 UI/domain tests, 278 companion tests and 13 packaging tests passed (655 total); TypeScript checks passed.
- Native OpenCloud and standalone builds passed. Dependency inventory and third-party notices regenerated from the locked dependencies.
- Exact release image built from the installation kit. All 278 companion and 13 packaging checks passed inside that non-root, read-only container with no network and a temporary scratch filesystem. Poppler extracted the synthetic fixture and Tesseract reported English/Japanese data.
- Store ZIP has `manifest.json` and the manifest entrypoint at its root. Its extracted files are byte-identical to the coordinated installer's internal frontend archive. Internal kit hashes and every release SHA256SUMS entry passed `scripts/validate_release.py`.
- Six fictional screenshots were visually checked, including light/dark Documents, review, Inbox, independent OCR/AI controls and unified Processing history. Each is a JPEG with matching .jpg extension, 1440×960 (3:2); redistribution terms are included. No live user documents or credentials appear.
- The catalogue patch applies cleanly to the upstream snapshots recorded in upstream-files.json and preserves every existing catalogue entry. Prepared URLs target the future v0.20.0 release/tag and must be checked after publication.
- Exact kit upgraded an existing Linux/amd64 OpenCloud 9 installation using the coordinated installer. Package SHA256 was verified on the target, installer recovery/idle checks passed, and the Web frontend displayed v0.20.0 Beta. Companion and converter were healthy; background intake resumed with the existing app-token connection. Separate fresh-install acceptance is recorded below.
- Live controls were inspected without saving preference changes: AI off leaves OCR, rule fields and matching tags available; returning AI on restores the saved choices. The local synthetic API test additionally completed scanned-page OCR and rule extraction with zero model requests and no automatic filing/metadata writes.
- Synthetic browser checks confirmed expandable attempt history and selection controls. Current processing remains separate from past imports; reprocessing still verifies source identity/ETag and creates no filing authority.

Installation kit SHA256: `314d2b72c96de3fabfaf681040a5258e50e3960c81c712ada4dfd6e9005b2b84`.

## Fresh installation

The matching kit also passed isolated OpenCloud 9/Caddy installation, empty initial workflow state, authenticated HTTPS boundary, synthetic backup restoration and a repeat install without restarting services. All 291 companion/packaging checks passed inside its isolated runtime. See ../docs/ACCEPTANCE_0.20.0.md for the precise scope.

## Publication verification

The release must identify its tagged commit, successful hosted CI and matching public asset checksums. The publication receipt is attached to the prerelease after public-link verification. Recheck the catalogue patch against current upstream before sending it. Live hosted-provider acceptance, arm64 and a broader OpenCloud/proxy matrix remain unclaimed.

Earlier fresh installation/restoration evidence for 0.14.5 is retained in ../docs/ACCEPTANCE_0.14.5.md and does not substitute for exact-release acceptance. This is an independent community beta, not an OpenCloud-approved or certified listing. The store frontend ZIP does not deploy the required companion service.
