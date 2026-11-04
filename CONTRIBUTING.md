# Contributing

Please open an issue describing the problem or proposed change, then send a focused pull request with relevant validation. Follow docs/LOCAL_BUILD.md for checks and packaging.

Keep files and permissions in OpenCloud. Use synthetic fixtures, preserve review/approval boundaries and never add credentials, real documents, personal taxonomies or private deployment details. No cloud fallback or silent truncation of document input. Extend languages through data and tests rather than fixed language lists.

New application code uses AGPL-3.0-only; retain upstream notices. Run domain/UI tests, companion tests, packaging tests, type checks and builds as appropriate. Distinguish source checks from live deployment acceptance. Local development does not authorize changes to a production instance.

Use `pnpm format` before submitting changes; `pnpm format:check` and `pnpm lint` run in CI. Format-only commits are recorded in `.git-blame-ignore-revs`; use `git blame --ignore-revs-file .git-blame-ignore-revs` when tracing behavior. Keep mechanical formatting separate from logic changes. ESLint covers companion, installer, UI and tests; dynamic Vue/API test fixtures still allow existing `any` types, while domain TypeScript does not. Linting is not backend type-checking.
