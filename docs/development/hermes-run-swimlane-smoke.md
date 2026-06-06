# Hermes run swimlane smoke test

This smoke path verifies the same behavior covered by `tests/unit/bases/kanbanRunSwimlanes.test.ts`, but in a live Obsidian vault.

## Prerequisites

- Obsidian is running with the vault named `Obsidian`.
- The TaskNotes plugin is built from this workspace and copied to the live vault.
- Hermes TaskNotes sync has produced at least one active task with `hermesBoard`, `hermesTaskId`, `hermesRootRunId`, and `hermesRunTitle` frontmatter. Tasks without `hermesRootRunId` are useful for checking the `No run` lane.

## Commands

From the repo root:

```bash
npm run verify:obsidian
HOME=/Users/yt /Applications/Obsidian.app/Contents/MacOS/Obsidian vault=Obsidian eval code="app.workspace.openLinkText('TaskNotes/Views/kanban-default.base', '', false)"
```

If the swimlane property is not visible in the UI picker, first confirm the generated/shared Base has the Hermes run properties:

```bash
grep -n "hermesRootRunId\|Hermes Root Run\|hermesRunTitle" /Users/yt/Documents/Obsidian/TaskNotes/Views/kanban-default.base
```

Expected output includes:

```text
hermesRootRunId:
  displayName: Hermes Root Run
hermesRunTitle:
  displayName: Hermes Run
```

## UI steps and expected observations

1. Open `TaskNotes/Views/kanban-default.base` in Obsidian and select a Hermes board view, for example `Hermes Agent`.
2. Leave the swimlane option unset.
   - Expected: the board renders the normal status columns.
   - Expected: existing non-run grouping, such as assignee/context grouping when selected instead of run grouping, does not render run rows.
3. In the TaskNotes Kanban view options, set `Swim Lane` to `Hermes Root Run`.
   - Expected: the task set stays scoped to the same Hermes board and active filters.
   - Expected: status columns remain the normal status columns.
   - Expected: rows render per logical root run.
4. Inspect an active/root/user/orchestrator run row.
   - Expected: the row is expanded by default.
   - Expected: normal `.kanban-view__card-wrapper` task cards render inside the status cells.
5. Inspect a completed run row, if one is present.
   - Expected: the row is collapsed by default.
   - Expected: collapsed cells show visible status-aligned summaries such as `done: 1`.
   - Expected: no task card elements are rendered inside the collapsed row until it is expanded.
6. Inspect populated synthetic rows.
   - Expected: tasks with no root run metadata appear in a visible `No run` row.
   - Expected: tasks with stale/unresolvable run metadata appear in a visible `Unknown run` row.
   - Expected: `Unknown run` includes the visible warning copy `Referenced run metadata is missing or not visible.` and an accessible row label containing the same warning.
7. Clear the `Swim Lane` option.
   - Expected: the same board task set returns to the normal Kanban layout.
   - Expected: no task run metadata changes.

## Automated coverage mapping

- `tests/unit/hermes/hermesApiClient.test.ts` covers backward-compatible `/board` calls when `group_by=run` is absent, explicit run grouping query parameters when requested, and explicit reassignment/unset payloads.
- `tests/unit/bases/kanbanRunSwimlanes.test.ts` covers task-set preservation, run grouping off, expanded rows, collapsed rows, No run, Unknown run, accessible warning copy, collapse persistence scope, and cross-run drop rejection.
- `tests/unit/bases/kanbanRunSwimlanesNonRegression.test.ts` covers board/project boundary invariants, branch/worktree/assignee non-inference, tenant-invisible Unknown run, root vs direct scope, retry count de-duplication, and historical-attempt stability after explicit reassignment.
- `tests/unit/hermes/hermesBoardProvisioning.test.ts` covers generated/shared Base provisioning of `hermesRootRunId`/`Hermes Root Run`, so the live swimlane picker can expose Run grouping on legacy shared bases.

See `docs/development/hermes-run-swimlane-rollout.md` for rollout, rollback, backfill, and v1 reassignment semantics.
