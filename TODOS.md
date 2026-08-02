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
