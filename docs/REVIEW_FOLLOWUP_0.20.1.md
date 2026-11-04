# Follow-up to the 0.20.1 static review

Cleanup completed locally on November 4, 2026, and included in the 0.20.2 release candidate. The published 0.20.1 tag, catalogue PR and NAS installation have not been changed by this work.

## Reproduced and fixed

Eight failing regression cases initially reproduced the six reported issues. Backup owner tests cover both a reused PID on the same hostname and a changed container hostname; contention covers both batch preparation and automatic filing.

| Review issue | Fix and regression evidence |
| --- | --- |
| 15 — abandoned backup lock | A separate private SQLite ownership transaction replaces hostname/PID liveness. A real SIGKILL test verifies exclusion of a concurrent backup, release after death, orphan cleanup on restart and preservation of saved snapshots. |
| 16 — abandoned temporary copies | Cleanup runs under backup ownership before capacity checks and after a failed run. Pending upload references are retained, malformed intents fail closed, and symlinked stages cannot remove outside files. Existing lost-response tests still verify no PUT replay. |
| 17 — contention becomes a permanent hold | Busy batch preparation keeps the current and remaining items queued and retries with a bounded timer. Automatic document contention retains its authorization and returns to pending; later resume completes the same authorized plan. |
| 18 — repeated downloads while busy | Intake ends the cycle after the first busy preparation instead of downloading every eligible file. Retry attempts remain unchanged. |
| 19 — false shutdown failure | A stopping/paused/disabled scan does not log or persist a source-access failure. |
| 20 — rollback masks the cause | Automatic SQLite rollback no longer triggers a second rollback that replaces the original constraint error. Rollback failure cannot mask the original exception. |

A related regression also ensures that batch history does not mark a pending automatic task complete: it stays queued and retries until the operation has an actual result. Interrupted or uncertain writes retain their existing non-replay guards.

## Completed cleanup

- **Logging:** backup, session/App Token, batch and automation failures use the same privacy allowlist. Expected access, validation, evidence and contention events have appropriate severity; unexpected errors remain errors. Messages, credentials and document contents are not logged.
- **Type coverage:** strict checking now includes all 70 companion implementation modules, including workflows, intake, API routes, backups, sessions, CLI/server entry points and development plugins. Masking plugin declarations were removed. Compile-only fixtures cover invalid provider callbacks, mutation identities, preparation options, backup settings and session/token inputs. Runtime validation remains separate from type checking.
- **Functions:** preparation, automatic execution, duplicate verification, conversion, transfers, Trash and backup publication have explicit helpers for ownership, reading, planning, writes and recovery. Intake separates scheduling from draining the current queue. Provider generation separates route execution from result combination. Named preparation-attempt fields replace positional argument spreading.
- **Complexity:** lint enforces a maximum of 25 across companion code, frontend state and views, with tighter 15/20 limits for operation/recovery/automatic/duplicate paths. The previously reported worst orchestration functions are split. There are still functions above 15; this is not a claim that all validation and state machines meet that lower threshold.
- **Service wiring:** constructors no longer mutate their workflow. The composition root validates and freezes the complete graph; unbound access raises a typed internal error. Tests explicitly assemble the graph. Optional adapter capabilities and genuinely optional configured integrations remain optional; service-existence checks no longer alter workflow SQL or silently omit safety checks.
- **Errors:** application-created failures use typed codes. Unknown and programming failures return redacted 500 responses; expected domain holds remain distinct from authentication, malformed requests and provider failures. The browser preserves response codes. Provider capability probes now use structured status/codes rather than matching exception text. Lint prevents new plain errors in application code. Safe stage-specific messages and diagnostic-only text classification remain intentionally supported.
- **Schema and ownership:** redundant table-existence checks are removed. Migrations and backup integrity checks still inspect schemas. Runtime ownership no longer writes PIDs/hostnames; legacy columns stay compatible with existing journals.
- **Repeated work:** intake summaries reuse one queue snapshot; each job's input is parsed once. Conversion/automation associations load in bulk: a 200-job page performs three scoped reads rather than two extra reads per job. Regression tests cover fixed query count and account isolation.
- **Frontend:** review/details views now compose focused controllers for filing drafts, decisions, metadata saves, selection, previews and navigation. ReviewInbox is 683 lines, DocumentDetails 521, MetadataSettings 439 and Settings 328. Shared filing-state predicates remove duplicated state lists. Metadata/processing components preserve draft immutability, uncertain-write restrictions and unsaved settings across tabs.
- **Compatibility:** the canonical API factory is `createWorkflowAPI`; historical build names, the `createDraftAPI` alias, `WORKFLOW_DRAFT_DB` and existing client type names remain supported to avoid breaking installations. The unused automatic resume option is removed and the changelog includes 0.20.1.

## Safety regressions

Existing source identity, exact evidence, capacity, approval and conditional-write checks remain intact. New regression coverage includes unbound service construction, unknown-error redaction, structured provider failures independent of display text, browser error-code preservation, pinned-review revision changes and duplicate-content selection, uncertain filing controls, typed backup validation, scoped constant-query job pages, and destination locks held through asynchronous transfer completion. Interrupted writes retain their recorded intents; verification never blindly repeats them.

Backup retention remains deliberate: configured count/size are capacity limits. Reaching them holds backups instead of deleting saved snapshots. This is documented operational behavior, not an unfinished cleanup change.

## Validation

- **784 tests pass:** 361 companion, 410 UI/domain and 13 packaging tests; none skipped.
- All 361 companion tests also pass on minimum supported Node 22.18.0.
- Strict frontend and full backend type checks, lint, formatting and diff checks pass.
- Native OpenCloud and standalone builds pass. The generated local packages are checked separately by `scripts/validate_release.py` for matching frontend bytes, safe archive paths and checksums.

The requested local review cleanup is complete. The exact local candidate subsequently passed [isolated fresh-install acceptance on the NAS](ACCEPTANCE_CLEANUP_2026-11-05.md), including container tests, synthetic backup/restore and repeat installation. Temporary test containers were removed afterward. The published 0.20.1 tag, OpenCloud catalogue request, production NAS installation, credentials and live documents remain unchanged.
