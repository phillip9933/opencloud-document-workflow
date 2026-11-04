# OpenCloud Document Workflow

An OpenCloud app for turning a folder of PDFs into an organized document library. Review proposed names, folders, fields and tags beside the original PDF, or enable automatic filing for your selected Inbox.

**0.20.0 is a beta release.** Tested with OpenCloud 9 and Web SDK 8.2.1. It is an independent community app, not an official OpenCloud product.

## What it does

- Watch folder to manually or automatically check for incoming documents.
- Extracts PDF text and reads scanned pages locally using Tesseract OCR with optional convert to PDF for unsupported filetypes. (can still tag and add fields manually to unsupported file types)
- Uses OPTIONAL AI with local Ollama or compatible cloud AI endpoint for suggestions and automations. With AI off the OCR and field/tag matching rules can still work.
- Files documents using configurable categories, naming patterns, custom fields and tag rules. Optional AI tag review reuses related existing tags and can propose new tags.
- Preserves original PDF bytes and OpenCloud permissions. Duplicate detection with exact byte matches and similarity matches.
- Provides optional unattended processing with OpenCloud App Tokens
- Customizable backups stored in OpenCloud.
- Includes English, Japanese, Spanish, French and German UI, plus light, dark and system appearance. OCR languages and interpretation rules can be extended separately.

## Install

Download the matching **installation kit** from [Releases](https://github.com/phillip9933/opencloud-document-workflow/releases). Extract it, verify `SHA256SUMS`, and run `./install.sh install` as an administrator on the Docker host. See [Quick install](docs/QUICK_INSTALL.md) for prerequisites, options and rollback.

The kit includes the Web app and the companion image build context, with Node, SQLite, Poppler, Tesseract and initial English/Japanese OCR data inside the container. A separate isolated conversion service supplies LibreOffice, MuPDF and image-to-PDF conversion; the installer manages it automatically. It has no OpenCloud credentials, storage mounts, public ports or internet route. Docker/Compose, Bash and `sha256sum` must already be available. Building the image downloads packages from the official Node/Debian sources. AI models are optional and configured separately.

**The OpenCloud store ZIP installs the frontend only.** Processing requires the companion service. Traefik routing can be configured by the installer; Caddy and other proxies use the external-proxy option and an administrator-configured same-origin route. See [Installation boundaries](docs/INSTALLATION.md).

After installation, choose Inbox and destination folders in Settings, configure models and OCR, and start with **Review first**. Enable automatic processing only after checking proposals against representative documents.

## Build and contribute

See [Source builds](docs/LOCAL_BUILD.md), [Architecture](docs/ARCHITECTURE.md), [Contributing](CONTRIBUTING.md), [Security](SECURITY.md) and [Release/submission notes](docs/STORE_PACKAGING.md). Source tests require Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) and Tesseract with English/Japanese data on the development host; the end-user installation kit supplies these inside its container. Test fixtures are synthetic. Personal filing taxonomies and live credentials are not shipped as defaults.

New application code is **AGPL-3.0-only**. The upstream OpenCloud skeleton and dependencies retain their licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md), `LICENSES/` and the [dependency inventory](docs/dependencies.cdx.json).
