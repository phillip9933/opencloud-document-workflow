# Beta releases and OpenCloud catalogue submission

**0.20.1 Beta** improves recovery, request handling and maintainability over 0.20.0. The GitHub prerelease supplies the matching assets; publishing it does not submit an OpenCloud catalogue pull request.

## Distribution

Run the checks and build commands in LOCAL_BUILD.md, followed by `python3 scripts/validate_release.py`. Matching artifacts are written to `artifacts/releases/0.20.1/`:

- `document-workflow-0.20.1.zip`: store frontend ZIP, with `manifest.json` and its entrypoint at the ZIP root.
- `document-workflow-0.20.1-install.tar.gz`: coordinated Web, companion and isolated converter installation kit.
- `document-workflow-0.20.1-companion-source.zip`: corresponding source, tests, exact locks, notices and dependency inventory.
- `document-workflow-0.20.1-screenshots.zip`: six 3:2 screenshots containing fictional information and redistribution terms.
- Installation guides, cover artwork, SHA256SUMS and a build receipt marked unpublished.

The internal installer frontend archive retains its app-directory wrapper. Its extracted bytes must exactly match the root-level store ZIP. The store installs only the frontend; it has no companion deployment hook. Keep that requirement prominent in the entry and link to the coordinated kit. Docker/Compose, Bash and sha256sum remain administrator prerequisites. The kit builds from official Node/Debian sources; AI models are optional and separate. Traefik is optional; external proxies require a same-origin route.

## Validation boundaries

See ACCEPTANCE_0.20.1.md for the local candidate checks; the release links the exact successful hosted CI run and its installation receipt. Fresh OpenCloud 9/Caddy installation, synthetic restoration and no-restart repeat checks are documented in ACCEPTANCE_0.20.1.md. Earlier 0.14.5 acceptance remains separately documented. OpenCloud 9 / SDK 8.2.1 and local Ollama are the exercised baseline. Live hosted AI, arm64 and a wider server/proxy matrix remain open. This independent beta is not OpenCloud-certified or catalogue-approved.

## Publication handoff

1. Review the source diff, release notes, licenses, dependency inventory and fictional screenshots. Keep private outputs, journals, credentials and personal configurations excluded.
2. Commit the reviewed source, run hosted CI for that exact commit and record its outcome. Create tag `v0.20.1` and a GitHub release with **prerelease enabled** only when publication is authorized.
3. Upload the matching files, compare every public download with SHA256SUMS, and verify each catalogue URL and image content type. Prepared URLs are future targets until that upload succeeds.
4. Recheck current opencloud-eu/awesome-apps guidance. Apply `submission/awesome-apps.patch` to a fresh checkout and inspect the small addition. Rebase if upstream changed; never replace existing entries.
5. Submit the prepared PR description for maintainer review once the public links work. The store frontend ZIP is not a one-click server installation.

No publishing command is executed by packaging. Screenshot artwork and fictional examples are AGPL-3.0-only; third-party dependencies retain their own notices.
