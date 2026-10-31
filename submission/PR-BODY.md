Add Document Workflow: a PDF Inbox, OCR, review and automatic filing app with custom fields, tags, local Ollama or explicitly configured compatible cloud AI.

The catalogue entry links the native Web ZIP and clearly states that processing requires the companion service. The matching Docker installation kit includes the Web app, companion build context, Node, SQLite, Poppler, Tesseract and initial OCR data. Traefik automation and an external-proxy option are documented; the store itself does not deploy the companion.

- AGPL-3.0-only application; upstream notices and dependency license texts included.
- Version 0.14.5 is an early public release, targeted at OpenCloud 9 / SDK 8.2.1.
- Synthetic checks: 223 UI/domain tests, 157 companion tests, 11 packaging tests; type checks and native/standalone builds.
- [Hosted CI](https://github.com/phillip9933/opencloud-document-workflow/actions/runs/41185178362) also builds the matching Docker image and runs companion/installer and OCR tool checks inside it without network access.
- All 10 public release downloads matched local SHA256, and all catalogue resource URLs returned HTTP 200. Artwork uses the tagged raw source URL to serve the correct image content type.

- [Fresh installation acceptance](https://github.com/phillip9933/opencloud-document-workflow/blob/main/docs/ACCEPTANCE_0.14.5.md): unchanged published kit installed on Linux/amd64 with OpenCloud 9 and Traefik; empty first-run setup, verified restoration, PDF preview/file verification, and repeat installation without restarts passed.

Hosted AI, arm64 and a wider OpenCloud/proxy matrix are not claimed. PDFs are the supported ingestion format. This is an independent community app.
