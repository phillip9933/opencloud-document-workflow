# Cleanup candidate: isolated NAS acceptance

Completed November 5, 2026. The local review-cleanup candidate passed a fresh installation on the NAS using separate OpenCloud, proxy, companion and converter containers. The existing production installation was not upgraded.

## Exact candidate

The unreleased installer retains version 0.20.1; it is **not** the published 0.20.1 artifact.

```text
document-workflow-0.20.1-install.tar.gz
SHA256 3109db7beb34f4c13ab88974b11d74f17fa658be758f18d5b0dda3b7b1e9f513
```

The archive checksum was verified on the NAS before installation. These acceptance notes were added afterward; the tested archive was not rebuilt.

## Verified results

- Fresh installer doctor reported no current installation; installation completed with matching frontend and companion versions and healthy services.
- The journal started with no proposals, decisions, metadata, metadata schemas, intake settings or preferences.
- OpenCloud 9.0.0 and Caddy served the frontend and companion over HTTPS using an explicitly trusted test CA. The protected companion status endpoint returned 401 without authentication.
- A synthetic metadata backup restored its field value, kept ingestion paused and made no network requests during restore.
- Repeating installation reported the existing healthy installation without changing OpenCloud, companion or converter container IDs or start times.
- Inside the built runtime image, all **361 backend and 13 packaging tests passed**, with zero failures or skips. These checks used an isolated network namespace with no external network access.
- Poppler extracted the synthetic PDF fixture text. Tesseract reported the bundled language data, including English and Japanese. This is a dependency smoke check, not a new OCR accuracy evaluation.

## Isolation and cleanup

The test used dedicated storage, named volumes and internal networks, with no published host ports or production document mounts. No production credentials or documents were used. Production container IDs, images, start times and mounts matched before installation, after installation and after cleanup; production companion and converter health remained healthy.

After verifying their test labels and mounts, all four temporary test containers were stopped and removed. Test logs and storage were retained for diagnosis. No production container, volume, configuration or document was removed or changed.

This acceptance covers the installer and synthetic backend checks. It does not claim a new signed-in browser workflow test, live-document acceptance, or a production upgrade. The earlier local UI/domain checks remain recorded in [the review follow-up](REVIEW_FOLLOWUP_0.20.1.md).
