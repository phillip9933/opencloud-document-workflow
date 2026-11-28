# Document Workflow engineering

## Central guidance for local agents

Use the owner-configured absolute `APP_GUIDELINES_ROOT` when the trusted launch
environment supplies it. Otherwise, on the owner's laptop use
`/home/phil/Projects/App_Guidelines`. On another executor, use the confirmed,
accessible location of the same master.

Before changing the repository or running its code, read
`<resolved root>/agent-guidelines.md` and the guides that apply. If the root or
a required file is missing, denied, or inconsistent, report the exact path and
stop changing or executing repository code. Do not use a cached guide or
silently fall back from an explicit override. Record the revision you read in
private task evidence. The master is not a dependency of the product or CI.

## Project context

- Public web extension and companion; use the web/service and software
  distribution profiles. Keep OpenCloud authorization and private document
  processing distinct from the optional AI and conversion services.
- Read [design](docs/design.md) and [architecture](docs/ARCHITECTURE.md).
  [Source builds](docs/LOCAL_BUILD.md) lists the project checks and
  [synthetic testing](docs/LIVE_TESTING.md) describes the test boundaries.

Read README.md and docs/ARCHITECTURE.md before extending this project. Keep OpenCloud the owner of document files, tags and permissions. Use synthetic fixtures and preserve evidence, exact approval and recovery boundaries. No cloud fallback, credentials or real documents in source, browser storage or review bundles.

Local engineering does not imply production deployment, new credentials/grants, hosted document transmission or publication. Follow the user's explicit authorized scope. New code is AGPL-3.0-only; retain upstream notices, exact locks and current dependency inventory. Do not infer deployment compatibility from compilation. Run relevant UI/domain, companion and packaging tests, types and native build when changing their behavior.
