# Security

This is an early public release. Keep OpenCloud, the proxy and container dependencies updated. Review automatic filing settings and grant background App Tokens only the access your workflow needs. Protect credential volumes and journal backups; they are not public artifacts.

Report suspected vulnerabilities privately using this repository's GitHub security advisory reporting if available. If private reporting is unavailable, open an issue asking for a private reporting channel without exploit details, credentials or documents. Do not post live tokens or personal files in public issues.

The companion accepts same-origin requests, validates OpenCloud identity/Space access and binds write decisions to source/proposal digests. These controls do not replace host isolation, TLS or review of model output. See docs/ARCHITECTURE.md for data and credential boundaries.
