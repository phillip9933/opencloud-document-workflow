# 0.20.1 beta — reliability and maintainability

This patch fixes recovery after an unclean companion stop,
avoids consuming intake retries when the preparation lock is busy, and prevents a
late audit error from sending a second HTTP response. Regression tests cover each.

The companion now has bounded structured logging, transactional schema migrations,
shared guarded remote requests, typed mutation/recovery contracts and smaller
processing helpers. File listings use scoped batch reads. UI request/preview state
is shared with stale-response checks, and typed backend errors have translated
messages. Formatting, lint, strict type checks and coverage reporting run in CI.

Existing documents, approvals, fields, tags and uncertain write intents are retained.
`WORKFLOW_DB` and `createWorkflowAPI` are the preferred names; old database settings
and factory imports remain compatible. No new runtime service or dependency is added.

See [acceptance](ACCEPTANCE_0.20.1.md) for completed checks and limitations.
