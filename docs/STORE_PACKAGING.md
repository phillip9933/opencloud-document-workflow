# Releases and OpenCloud catalogue submission

The public project is https://github.com/phillip9933/opencloud-document-workflow. Version 0.14.5 is an early public release. This document does not imply OpenCloud certification or catalogue acceptance.

## Distribution

Run the checks and build commands in LOCAL_BUILD.md. `pnpm run package:installer` emits matching files in `artifacts/releases/0.14.5/`:

- `document-workflow-0.14.5.zip`: native Web app for the catalogue; root folder matches app ID `document-workflow`.
- `document-workflow-0.14.5-install.tar.gz`: coordinated Web/companion installation kit. The runtime is built from the included pinned Dockerfile.
- `document-workflow-0.14.5-companion-source.zip`: corresponding application/build/test source.
- Cover artwork, installation guides, checksums and a build receipt.

Publish these together under tag `v0.14.5`. The native ZIP alone cannot perform processing. The catalogue description and installation link must retain this requirement. No prebuilt companion image is promised by this release; the kit builds it from official sources.

Source excludes private operational history, user configuration, documents, credentials and journals. Include LICENSE, third-party notices, the exact lockfile and dependency inventory with distribution. OS packages are recorded in the built image at `/distribution/os-packages.txt`.

## Compatibility and validation

The native app has been exercised with OpenCloud 9 and SDK 8.2.1; local Ollama is the accepted AI path. Automated tests cover UI/domain behavior, companion operations and installer planning/asset safeguards. Earlier coordinated-installer acceptance covered Linux/amd64 fresh installation, failed-route rollback and repeat installation. The 0.14.5 source packages require their own rebuild/checksum verification; prior acceptance is not a claim that every new image, server version or proxy layout has been tested.

Live hosted-provider, arm64 and broad OpenCloud-version acceptance remain open. A container build and fresh isolated installation of this exact release should be recorded before presenting it as a broadly supported stable store release.

## Catalogue contribution

OpenCloud's [awesome-apps repository](https://github.com/opencloud-eu/awesome-apps) accepts pull requests. Its current `webApps/apps.json` lists public download URLs and companion requirements; the catalogue does not run a server installer.

`submission/` contains the prepared entry, README addition, PR body and patch against the upstream catalogue. The ID follows the GitHub namespace convention: `com.github.phillip9933.opencloud-document-workflow.document-workflow`. Render the entry with:

```sh
python3 scripts/store_entry.py \
  --release-base-url https://github.com/phillip9933/opencloud-document-workflow/releases/download/v0.14.5 \
  --source-url https://github.com/phillip9933/opencloud-document-workflow \
  --output /tmp/document-workflow-entry.json
```

Verify every release URL publicly resolves, SHA256SUMS matches downloads, the ZIP has one correct root/manifest, and companion requirements are visible. Apply the patch to a fresh upstream checkout, inspect its small diff and submit it for maintainer review. Preparing this contribution does not send a pull request or guarantee listing.
