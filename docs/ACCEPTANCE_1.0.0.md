# 1.0.0 release acceptance

The local regression suites cover the Space boundary, capacity limits, streamed
previews, the worker's PDF text and OCR transport, and evidence retention.
Deployment acceptance is separate. The release must pass a fresh OpenCloud 9
installation and an upgrade from the published 0.20.3 kit and the earlier private 1.0.0 candidate. Confirm that a
synthetic document reaches review and filing, and that fields, tags and filing
history survive an upgrade. Publish only the exact artifacts from a successful
tagged workflow with verifiable provenance.

The production JavaScript dependency audit on 2026-11-18 reported zero advisories.
The glob and minimatch build dependencies resolve to 14.0.6 and 11.0.9.
Picomatch 4.0.7 has no published fixed version for GHSA-fc5q-39xc-vjpf.
The lockfile applies the parser change from upstream PR 194 at commit
7be3276fb8bd215a8c73fa066bcaf696c244ad88. Version-based audits continue
to flag it. Remove the local patch after verifying an upstream release.
