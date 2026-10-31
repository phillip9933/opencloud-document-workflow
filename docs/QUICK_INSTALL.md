# Install Document Workflow

For an existing Linux OpenCloud installation using Docker Compose and Traefik:

1. Download and extract the matching `document-workflow-VERSION-install.tar.gz` on the Docker host.
2. In its `document-workflow` folder run:

   ```sh
   ./install.sh install
   ```

The installer discovers the `opencloud` and `traefik` containers, HTTPS origin, existing proxy network and apps directory. It verifies package checksums, automatically builds the bundled image (or uses `--image`), installs the matching Web app, starts the companion, restarts only OpenCloud registration and verifies the HTTPS API route. Node, SQLite, Poppler, Tesseract and English/Japanese OCR packs are in the image; users do not install them on the host. The existing Docker/Compose setup, Bash and standard `sha256sum` utility are prerequisites. Building needs access to the official Node/Debian registries; a prebuilt matching image avoids building.

To inspect the setup first, use `./install.sh doctor`. This can build the helper image and create its private installer-history volume, but does not install web assets, start a worker or restart OpenCloud. Unknown/modified app assets, ambiguous networks, missing mounted directories and an existing manually managed worker for the same instance hold installation.

For named containers or a custom installation:

```sh
./install.sh install --opencloud-container my-opencloud \
  --proxy-container my-traefik --entrypoint https \
  --ollama-url http://my-nas:11434
```

Other optional overrides: `--origin https://cloud.your-domain`, `--apps-dir /absolute/web/apps`, `--network existing-network`, `--image registry/image@sha256:DIGEST`, `--trusted-ca /absolute/private-ca.pem`. The apps path must already exist on the Docker host. The installer never disables certificate checks, creates accounts/tokens, edits the identity provider, changes sharing or redirects scanners. Non-Traefik installations can use `--proxy-mode external --proxy-container my-proxy` after configuring their existing proxy to preserve Host/Origin/Authorization for `/_workflow/api/` to the companion. External mode disables Traefik labels entirely. Automated proxy setup is currently Traefik-specific.

After installation, open **Document Workflow → Settings** and choose folders, models and OCR languages. Optionally connect your own OpenCloud App Token for work after sign-in expires or the server restarts. Choose an OpenCloud backup folder in System. Those are user choices, not additional software installations. No AI model or cloud provider is selected/downloaded automatically.

## Updates and rollback

Run the new matching kit's `./install.sh install` for the same origin/containers. Local AI endpoint, private CA and proxy mode/entrypoint choices are inherited from its private managed plan when omitted; explicitly supplied options take precedence. Use `--ollama-url off` or `--trusted-ca off` to remove those saved choices. The stable per-origin Compose project and named volumes preserve the journal, credential directory, OCR packs and backup settings across kit folders. The installed image ID and complete public deployment plan are retained privately. Re-running the same healthy kit checks it without restarting services; OpenCloud registration reloads only when native assets change or on initial installation. A stopped journal gets a verified private checkpoint before replacement. Pending WAL or rollback-journal data holds the upgrade; the source mount remains read-only and original bytes are checked unchanged. The old native assets are verified and retained; unknown/local changes hold instead of being overwritten. Operator `config.json` is preserved, with its ownership and permissions; `apps.yaml` stays owned by OpenCloud.

If startup or the HTTPS route fails, the installer attempts to restore the exact previous managed runtime plan and verified native assets. It never restores an older database over current records, deletes credentials, removes data volumes or silently replays uncertain document operations. Checkpoints and old files are retained for inspection. An interrupted transaction or stale deployment lock holds further changes for administrator recovery; do not delete a lock while its installer is running.

See INSTALLATION.md for component boundaries and STORE_PACKAGING.md for release validation. Existing manually managed workers require an explicit migration plan; the installer refuses to run a second worker.
