# Reliability

The 1688 engine uses inline Playwright sessions with persistent profiles.

Reliability behavior:

- Profile lock prevents concurrent inline commands from sharing one browser profile.
- Stale locks older than five minutes can be cleaned automatically.
- Search returns partial detail results: successful offers are kept and failed offer IDs go to `failures`.
- `offers` validates every ID independently, deduplicates input while preserving order, and keeps one output shape for single and multiple IDs.
- Risk-control events are recoverable and should be resolved manually with `--headed`.
- Retries are bounded. Infinite retry loops are forbidden.

Artifacts and events are written under the 1688 home directory for debugging. Sensitive cookies and tokens must not be logged.
