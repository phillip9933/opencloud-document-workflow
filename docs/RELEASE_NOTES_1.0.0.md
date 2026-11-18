# Document Workflow 1.0.0

This release moves PDF reading and OCR to the same isolated worker that converts
Office files and images. The worker has no OpenCloud credentials or internet
route. The installer continues to manage both services.

Live previews stream from OpenCloud with one active preview per account. The
maximum document size is 100 MiB; higher saved limits from older releases are
read as 100 MiB. File checks continue to verify the complete hash and identity.

Completed filing records retain their fields, tags, history and evidence
excerpts. Full extracted text expires after 90 days by default, so Document
Workflow full-text searches and similarity suggestions no longer use expired
pages. Pending reviews and uncertain writes retain the evidence they need.
Old backup snapshots are separate and can still contain this text.

Shared installations can restrict access to selected OpenCloud account IDs.
An operator using a DNS name for local Ollama can explicitly allow that name.
The release workflow scans the runtime image and attests tagged build artifacts.
