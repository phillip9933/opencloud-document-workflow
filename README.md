# OpenCloud Document Workflow

An OpenCloud app for turning a folder of PDFs into an organized document library. Review proposed names, folders, fields and tags beside the original PDF, or enable automatic filing for your selected Inbox.

**0.20.0 is a beta release.** Tested with OpenCloud 9 and Web SDK 8.2.1; broader server, platform and provider compatibility needs testing. It is an independent community app, not an official OpenCloud product.

## What it does

- Watches one Inbox, including optional subfolders, with manual or scheduled checks.
- Extracts PDF text and reads scanned pages locally using Tesseract OCR.
- Uses optional local Ollama or an explicitly configured compatible cloud AI endpoint; no cloud fallback. With AI off, PDF text extraction, Tesseract OCR and field/tag matching rules still prepare a manual review.
- Browses manually stored files of any format inside the chosen destination, without processing them. Conversion is an explicit Inbox action.
- Offers PDF review, evidence quotes, sequential navigation, search, saved views and bulk actions. Manual reviews retain verified fields and explain individual validation failures; preparation batches can be paused, resumed or cancelled.
- Files documents using configurable categories, naming patterns, custom fields and tag rules. Optional AI tag review reuses related existing tags and can propose new candidates; creation follows your review or automatic Tags policy. Inbox and destination can use different authorized Spaces.
- Preserves original PDF bytes and OpenCloud permissions. Exact duplicates can be held or moved to recoverable OpenCloud Trash. Conservative similarity warnings offer comparison links for separate scans; they never delete files.
- Provides optional unattended processing through users' OpenCloud App Tokens, and configurable journal backups stored in OpenCloud.
- Includes English, Japanese, Spanish, French and German UI, plus light, dark and system appearance. OCR languages and interpretation rules can be extended separately.

## Install

Download the matching **installation kit** from [Releases](https://github.com/phillip9933/opencloud-document-workflow/releases). Extract it, verify `SHA256SUMS`, and run `./install.sh install` as an administrator on the Docker host. See [Quick install](docs/QUICK_INSTALL.md) for prerequisites, options and rollback.

The kit includes the Web app and the companion image build context, with Node, SQLite, Poppler, Tesseract and initial English/Japanese OCR data inside the container. A separate isolated conversion service supplies LibreOffice, MuPDF and image-to-PDF conversion; the installer manages it automatically. It has no OpenCloud credentials, storage mounts, public ports or internet route. Docker/Compose, Bash and `sha256sum` must already be available. Building the image downloads packages from the official Node/Debian sources. AI models are optional and configured separately.

**The OpenCloud store ZIP installs the frontend only.** Processing requires the companion service. Traefik routing can be configured by the installer; Caddy and other proxies use the external-proxy option and an administrator-configured same-origin route. See [Installation boundaries](docs/INSTALLATION.md).

After installation, choose Inbox and destination folders in Settings, configure models and OCR, and start with **Review first**. Enable automatic processing only after checking proposals against representative documents.

## Current boundaries

OCR and AI review use PDFs. Any original format can instead be filed manually: open it in the Inbox, choose **Choose filing details**, select a folder, filename and tags, then **Accept**. For OCR and AI review, select images, Office documents, text or XPS/OXPS files and choose **Create PDF copies**. The app verifies each uploaded PDF before moving its original to the configured archive outside the Inbox, preserving subfolders. CAD and SketchUp files need export from their original application only if you want PDF-based OCR or AI review; manual filing preserves their original format. Office pagination and spreadsheet print areas should be checked in the resulting PDF. Scanning hardware, email ingestion, webhooks and finance integrations are not included.

Ambiguous or unsupported AI facts, missing dates and oversized model inputs open a manual review without accepting the rejected suggestions. Choose a destination and tags beside the PDF; this requires explicit human approval even in automatic mode. Pages still unreadable after OCR can also be reviewed visually. Destination collisions and uncertain writes remain held for verification. Similar-looking scans are not automatically discarded; only verified byte-identical copies qualify for duplicate Trash. AI evidence matching is a guardrail, not proof that a model's interpretation is correct.

Unattended work requires a valid user App Token and continued access to the chosen Spaces. Browser-session access alone expires. Hosted-provider adapters have automated tests; live acceptance has focused on local Ollama. The 0.20.0 kit passed [isolated fresh installation and synthetic restoration acceptance](docs/ACCEPTANCE_0.20.0.md) on Linux/amd64 with OpenCloud 9 and Caddy, alongside live Traefik upgrade checks. Arm64 and other deployment layouts are not certified.

## Build and contribute

See [Source builds](docs/LOCAL_BUILD.md), [Architecture](docs/ARCHITECTURE.md), [Contributing](CONTRIBUTING.md), [Security](SECURITY.md) and [Release/submission notes](docs/STORE_PACKAGING.md). Source tests require Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) and Tesseract with English/Japanese data on the development host; the end-user installation kit supplies these inside its container. Test fixtures are synthetic. Personal filing taxonomies and live credentials are not shipped as defaults.

New application code is **AGPL-3.0-only**. The upstream OpenCloud skeleton and dependencies retain their licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md), `LICENSES/` and the [dependency inventory](docs/dependencies.cdx.json).
