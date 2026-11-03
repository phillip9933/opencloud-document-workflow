# OpenCloud catalogue submission — 0.20.0 Beta

The [GitHub beta](https://github.com/phillip9933/opencloud-document-workflow/releases/tag/v0.20.0) is published. The OpenCloud catalogue contribution is prepared; no upstream pull request has been sent.

- `app-entry.json`: ready catalogue entry with public download, installation, artwork and screenshot URLs.
- `awesome-apps.patch`: minimal additions to `webApps/apps.json` and the upstream README; existing entries are preserved.
- `PR-BODY.md`: proposed pull-request description with release and validation links.
- `upstream-files.json`: exact upstream snapshots used for the patch.
- `VALIDATION.md`: tested baseline and remaining compatibility boundaries.

[Hosted CI](https://github.com/phillip9933/opencloud-document-workflow/actions/runs/41740899849) passed for the tagged application commit, including the exact packaged kit's fresh OpenCloud 9/Caddy installation. [Public download verification](https://github.com/phillip9933/opencloud-document-workflow/releases/download/v0.20.0/PUBLICATION-RECEIPT.json) records asset SHA256 and catalogue link/content-type checks. Screenshots contain fictional data, use 3:2 JPEG images and include redistribution terms in ../deploy/screenshots/LICENSE.md.

Apply-check the patch against a fresh opencloud-eu/awesome-apps checkout before opening the PR. If upstream changed, rebase this small addition without reformatting other entries. The listing prominently requires an administrator-installed companion; the store ZIP installs only the Web frontend. This is an independent community beta, not an approved or certified listing.
