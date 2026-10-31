# OpenCloud catalogue contribution

Prepared for [opencloud-eu/awesome-apps](https://github.com/opencloud-eu/awesome-apps). No upstream pull request has been sent.

`app-entry.json` is the catalogue entry; `awesome-apps.patch` adds it to `webApps/apps.json` and adds a README listing. `PR-BODY.md` is the proposed pull-request description. `upstream-files.json` records the source file hashes used to prepare this patch.

Apply against a current upstream checkout with `git apply --check /path/to/awesome-apps.patch`, then `git apply /path/to/awesome-apps.patch`. If upstream changed, rebase the small addition without replacing or reformatting other entries. Confirm its current contribution guidance before sending.

Public download checksums, ZIP manifest/root and a fresh full install of the exact release kit have been checked; see VALIDATION.md and ../docs/ACCEPTANCE_0.14.5.md. Recheck the upstream patch and download links when submitting. Report compatibility precisely. This early public release is not yet OpenCloud-certified or catalogue-approved. Catalogue installation delivers only the frontend; companion installation must remain prominent in the entry and installation resources.
