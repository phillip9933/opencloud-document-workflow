# Releases and OpenCloud catalogue updates

**1.0.1 candidate** builds the next release. The current public catalogue entry was added in OpenCloud awesome-apps PR #62. Publish the verified GitHub release before proposing a catalogue update.

## Distribution

Run the checks and build commands in LOCAL_BUILD.md, followed by `python3 scripts/validate_release.py`. Matching artifacts are written to `artifacts/releases/1.0.1/`:

- `document-workflow-1.0.1.zip`: store frontend ZIP, with `manifest.json` and its entrypoint at the ZIP root.
- `document-workflow-1.0.1-install.tar.gz`: coordinated Web, companion and isolated converter installation kit.
- `document-workflow-1.0.1-companion-source.zip`: corresponding source, tests, exact locks, notices and dependency inventory.
- `document-workflow-1.0.1-screenshots.zip`: six 3:2 screenshots containing fictional information and redistribution terms.
- Installation guides, cover artwork, SHA256SUMS and a build receipt marked unpublished.

The internal installer frontend archive retains its app-directory wrapper. Its extracted bytes must exactly match the root-level store ZIP. The store installs only the frontend; it has no companion deployment hook. Keep that requirement prominent in the entry and link to the coordinated kit. Docker/Compose, Bash and sha256sum remain administrator prerequisites. The kit builds from official Node/Debian sources; AI models are optional and separate. Traefik is optional; external proxies require a same-origin route.

## Validation boundaries

See [1.0.1 acceptance](ACCEPTANCE_1.0.1.md). Local builds do not establish installation compatibility. The tagged GitHub workflow checks the runtime image, fresh OpenCloud 9/Caddy installation and upgrade from the published 1.0.0 kit, then attests the matching packages. See [GitHub’s artifact attestation guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Publication handoff

1. Review the source diff, release notes, licenses, dependency inventory and fictional screenshots. Keep private outputs, journals, credentials and personal configurations excluded.
2. Commit the reviewed source, run hosted CI for that exact commit and record its outcome. When publication is authorized, create tag `v1.0.1`, wait for its checks and provenance job, then publish the exact verified artifacts.
3. Upload the matching files, compare every public download with SHA256SUMS, and verify each catalogue URL and image content type. Prepared URLs are future targets until that upload succeeds.
4. Recheck current opencloud-eu/awesome-apps guidance. Update the existing Document Workflow entry in a fresh checkout. Retain the catalogue-hosted screenshots and their license.
5. Submit the catalogue update for maintainer review once the public links work. The store frontend ZIP is not a one-click server installation.

No publishing command is executed by packaging. Screenshot artwork and fictional examples are AGPL-3.0-only; third-party dependencies retain their own notices.

## Container registry updates

Publishing a stable GitHub release with its Web ZIP runs the release checks again. The registry job publishes the tested runtime image only after checks and package provenance succeed. It compares the public ZIP's file hashes with the image's bundled extension inventory. The image is published as `ghcr.io/phillip9933/opencloud-document-workflow:vVERSION`, attested, and promoted to `:latest` only if the release is GitHub's latest stable release. Publish fixes under a new version. Add each supported predecessor's exact Web inventory to `deploy/installer/known-web-releases.json` before publishing an upgrade.

The first GitHub container package defaults to private. The repository owner must make it public once before a NAS can pull it anonymously. Verify an anonymous pull and the image provenance before switching a production stack to the channel. See [GitHub Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
