# Submission validation — 0.14.5

- Public source: https://github.com/phillip9933/opencloud-document-workflow
- Published pre-release: https://github.com/phillip9933/opencloud-document-workflow/releases/tag/v0.14.5
- Source checks and matching container build: https://github.com/phillip9933/opencloud-document-workflow/actions/runs/41185178362
- 223 UI/domain, 157 companion and 11 installer tests passed; types and native/standalone builds passed.
- Matching Node/Debian image built; companion/installer tests and Poppler/Tesseract tools passed inside a non-root, read-only container without network access.
- Ten public release downloads were compared with local SHA256 values and matched; catalogue links returned HTTP 200. Internal installation-kit file checksums, native ZIP root and manifest version were verified.
- The patch applies cleanly to the upstream files recorded in upstream-files.json. No existing catalogue entries are replaced.
- Personal profiles, live documents, credentials, journals and private operational history are excluded. Test identities are fictional. Licenses, dependency notices, exact lockfile and package inventory are included.

The published kit now has [fresh full installation acceptance](../docs/ACCEPTANCE_0.14.5.md) on OpenCloud 9 / SDK 8.2.1, Linux/amd64 and Traefik, including first-run setup, restoration, existing PDF verification and repeat installation without restarts. Prior live local-Ollama workflow acceptance retains its separate scope. Container/source tests alone do not prove full deployment compatibility. Wider server/proxy/platform and live hosted-provider acceptance remain open. This release is an independent community pre-release, not an OpenCloud-approved listing.
