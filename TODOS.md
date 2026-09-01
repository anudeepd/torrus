# TODOs

## Admin console follow-ups

- [ ] **P3 — Audit export and investigation notes**
  - **What:** Export filtered command/admin events and attach operator notes to an incident timeline.
  - **Why:** Preserve incident context outside in-app retention windows and support handoff.
  - **Pros:** Better evidence review, collaboration, and post-incident reconstruction.
  - **Cons:** Adds sensitive-data export authorization, redaction, format, and retention obligations.
  - **Context:** Baseline admin console provides bounded submitted-input and durable mutation events. Start after `event_kind` migration and redaction policy stabilize.
  - **Effort:** M human team → S with CC+gstack.
  - **Depends on / blocked by:** Stable admin-event schema and approved export policy.

- [ ] **P3 — Authoritative remote process inspection/control**
  - **What:** Add a target-host agent or documented remote control protocol for exact process state and termination.
  - **Why:** Current SSH-channel interrupt is best-effort and cannot guarantee a specific remote process stopped.
  - **Pros:** Truthful process state, stronger incident response, precise kill semantics.
  - **Cons:** Requires deployment/trust model on every host, privilege boundaries, compatibility, and new failure modes.
  - **Context:** Baseline intentionally labels interrupt `best_effort` and excludes process enumeration. Revisit with a concrete target-host deployment model.
  - **Effort:** XL human team → L with CC+gstack.
  - **Depends on / blocked by:** Remote-host ownership, deployment, and security design.

- [ ] **P3 — Activity filters sync to URL**
  - **What:** Reflect Submitted-input filter state (user/host/kind/since/until) in query params so investigations are shareable and back-navigable.
  - **Why:** /design-review 2026-09-01 deferred finding — audit checklist "URL reflects state".
- [ ] **P4 — FTS5 for activity search if scale demands**
  - **What:** Replace LIKE-based free-text search with an FTS5 virtual table when audit volume justifies it.
  - **Why:** Benchmarked 2026-09-01: LIKE over 1M rows x 6 cols = 0.26s worst case. Revisit at ~5-10M rows or >1s admin queries. Cost then: ~2x storage on indexed cols, insert triggers, lost substring matching.
