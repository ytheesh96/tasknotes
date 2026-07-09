# Hermes run swimlane rollout, rollback, and backfill

Audience: implementers and reviewer-qa acceptance for run swimlanes phase 5.

Source artifact: `/Users/yt/Documents/Obsidian/TaskNotes/developer/activity/artifacts/t_22882c41-run-swimlanes-full-artifacts.md`

## Rollout model

Run swimlanes are an additive grouping view inside an existing board/project. The safe rollout order is:

1. Storage/API fields exist and are additive.
2. TaskNotes mirrors logical run metadata into TaskNote frontmatter when Hermes provides it.
3. Kanban Bases exposes `Hermes Root Run` as an optional swimlane property.
4. Users or generated board views may select Run grouping, but the default board API and default non-run Kanban behavior stay unchanged unless `group_by=run` or a run swimlane property is explicitly selected.

No separate generated Runs board is required for v1. Board/project remains the task universe; status columns remain status columns.

## Rollback behavior

Safe rollback is to turn grouping off:

- Clear the Kanban swimlane/grouping selection, or select an existing non-run grouping such as assignee/context.
- For direct dashboard API callers, omit `group_by=run` from `/api/plugins/kanban/board` requests.
- Leave the additive run fields in place. Old clients and old board views ignore `runs`, `tasks.run_id`, mirrored `hermesRunId`, and `hermesRootRunId` fields when run grouping is not selected.

Rollback must not require deleting run metadata. Deleting metadata would hide provenance and can turn resolved lanes into No run/Unknown run lanes when grouping is re-enabled.

Expected rollback invariants:

- Board/project boundary is unchanged.
- Task status columns and transitions are unchanged.
- Assignee grouping works exactly as before when Run grouping is off.
- `task_links` and readiness recomputation remain canonical; run grouping never changes dependency readiness.
- Branch/worktree fields remain execution metadata and are never used to infer runs.
- `/board` responses stay in the legacy shape when `group_by=run` is absent.

## Conservative backfill guidance

Backfill is optional. Existing tasks may remain without a logical run and appear in No run when grouping is enabled.

Allowed backfill sources:

- Explicit `tasks.run_id` already present in the backend.
- Explicit mirrored frontmatter such as `hermesRunId` or `hermesRootRunId`.
- Explicit session/root provenance from Hermes where a logical root run is already represented.
- Explicit orchestrator-child provenance recorded by Hermes at task creation.

Disallowed inference sources:

- `assignee` alone.
- `branch_name` alone.
- `workspace_kind` alone.
- `workspace_path` alone.
- A shared branch/worktree/assignee combination without explicit session/root provenance.

Attempt backfill semantics:

- `task_runs.logical_run_id` may be populated only where the task has a non-null explicit logical run at backfill time.
- `task_runs.attempt_number` can be backfilled per task ordered by `started_at` and then `id`.
- `parent_attempt_run_id` should remain null unless explicit provenance identifies the parent attempt.
- `tasks.current_run_id` remains the active attempt pointer and must not be renamed or repurposed.

## V1 reassignment semantics

Cross-run drag/drop is disabled/rejected in v1. Reassignment is explicit-only through a task action, CLI/API edit, or unset action.

An explicit reassignment updates only current task assignment/audit fields:

- `tasks.run_id`
- `tasks.run_assigned_at`
- `tasks.run_assignment_source`
- `tasks.run_assignment_actor`, when available

Historical attempts are stable. Existing `task_runs.logical_run_id` rows are not rewritten after reassignment. Future attempts copy the task's current `run_id` at claim time and receive the next attempt number.

Unset moves the task to No run with source `unset`. Missing, other-tenant, or archived target runs should be rejected by the backend unless a deliberate force/admin mode exists; Unknown run is for pre-existing inconsistent data, not for successful reassignment.

## Non-regression test map

Current focused automated coverage:

- `tests/unit/hermes/hermesApiClient.test.ts`
  - `/board` legacy response/query remains unchanged when `group_by=run` is absent.
  - `group_by=run`, `run_scope`, and `run_id` are sent only when requested.
  - explicit reassignment and unset payloads use `/tasks/{task_id}/run` and preserve returned audit fields.
- `tests/unit/bases/kanbanRunSwimlanes.test.ts`
  - normal run grouping preserves the same task set and status columns.
  - run grouping off renders flat assignee columns without run rows.
  - No run and Unknown run lanes render visible/accessibility copy.
  - collapsed rows hide cards and show status-aligned counts.
  - cross-run drag/drop is rejected while same-lane status moves are allowed.
  - collapse persistence keys are scoped by profile, board, view, tenant, group_by=run, run_scope, and lane id.
- `tests/unit/bases/kanbanRunSwimlanesNonRegression.test.ts`
  - board/project boundary is external to grouping: only already-visible tasks are resolved.
  - branch/worktree/assignee are not used for run inference.
  - No run and tenant-invisible/missing Unknown run lanes are separate.
  - root scope rolls nested runs to their root; direct scope keeps exact assignment.
  - retry attempts count once per task.
  - explicit reassignment updates audit fields and future attempts only; historical attempts stay stable.
- `tests/unit/hermes/hermesBoardProvisioning.test.ts`
  - shared Kanban bases expose the Hermes Root Run property so the UI can enable Run swimlanes without generated Runs boards.

Reviewer-qa should still do a live Obsidian smoke pass with `docs/development/hermes-run-swimlane-smoke.md` because unit tests do not prove the rendered picker behavior inside a running vault.
