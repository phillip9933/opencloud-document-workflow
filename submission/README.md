# Prepared beta catalogue contribution

Candidate: **0.20.0 Beta**. Nothing from this candidate has been published or submitted.

`app-entry.json` and `awesome-apps.patch` prepare the catalogue and README additions against the upstream snapshots identified by `upstream-files.json`. Screenshot URLs target the future v0.20.0 tag; they are not verified public downloads yet. The six fictional 3:2 screenshots live in ../deploy/screenshots with redistribution terms.

Review VALIDATION.md and ../docs/RELEASE_NOTES_0.20.0.md, then follow ../docs/STORE_PACKAGING.md. Run `git apply --check` against a fresh awesome-apps checkout before submitting. New hosted CI, public download verification and exact-release fresh-install acceptance must be recorded separately; earlier releases' evidence does not establish those checks for 0.20.0.

The entry explicitly requires an administrator-installed companion. The catalogue ZIP installs only the Web frontend. This is an independent community beta.
