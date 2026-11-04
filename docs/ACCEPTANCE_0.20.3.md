# 0.20.3 beta validation

The regression covers reloading the filed document with its saved decision, including a move that changes the ETag. A new preparation remains reviewable.

On the NAS, the same synthetic invoice reproduced the stale status on 0.20.2 and showed Filed after a reload on the local 0.20.3 build. The review link was absent, and the Invoice tag and all four custom field values were present. The release workflow checks the packaged build on a fresh OpenCloud 9/Caddy installation and an upgrade from the published 0.20.2 kit. The corresponding receipts accompany the GitHub release.
