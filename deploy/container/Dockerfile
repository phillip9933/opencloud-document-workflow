# SPDX-License-Identifier: AGPL-3.0-only
# Build from the repository root after the normal build/package checks.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${NODE_IMAGE}
ARG WORKFLOW_VERSION=0.14.5
LABEL org.opencontainers.image.title="OpenCloud Document Workflow companion" \
      org.opencontainers.image.version="${WORKFLOW_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
RUN apt-get update && apt-get install --no-install-recommends -y \
      poppler-utils poppler-data fonts-noto-core fonts-noto-cjk tesseract-ocr tesseract-ocr-eng tesseract-ocr-jpn \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o 65534 -g 65534 /state /credentials /backups \
    && install -d -m 0755 -o 65534 -g 65534 /workflow-tessdata \
    && cp /usr/share/tesseract-ocr/5/tessdata/*.traineddata /workflow-tessdata/ \
    && chown -R 65534:65534 /workflow-tessdata
COPY artifacts/draft-stage/ /app/
COPY deploy/container/Dockerfile /distribution/Dockerfile
COPY artifacts/document-workflow-${WORKFLOW_VERSION}-local.zip /distribution/document-workflow.zip
COPY artifacts/native-web/ /distribution/web/
COPY artifacts/release.json artifacts/known-web-releases.json /distribution/
COPY deploy/installer/*.mjs /distribution/
RUN mkdir -m 0700 /install-history \
    && dpkg-query -W > /distribution/os-packages.txt
ENV NODE_ENV=production WORKFLOW_MODE=live WORKFLOW_LISTEN_ADDRESS=0.0.0.0 \
    WORKFLOW_PRIVATE_NETWORK=true WORKFLOW_DRAFT_DB=/state/workflow.sqlite3 \
    WORKFLOW_APP_TOKEN_DIRECTORY=/credentials WORKFLOW_BACKUP_DIRECTORY=/backups \
    TESSDATA_PREFIX=/workflow-tessdata WORKFLOW_OCR_DIRECTORY=/workflow-tessdata
WORKDIR /app
USER 65534:65534
EXPOSE 5175
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
 CMD node /distribution/health-check.mjs
ENTRYPOINT ["node"]
CMD ["companion/server.mjs"]
