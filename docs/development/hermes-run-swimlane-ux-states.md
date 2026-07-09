# Hermes run swimlane UX states and accessible copy

Task: t_9aacf5bd
Audience: `peacock` implementation and `reviewer-qa` acceptance review
Source artifact: `/Users/yt/Documents/Obsidian/TaskNotes/developer/activity/artifacts/t_22882c41-run-swimlanes-full-artifacts.md`
Related parent handoff: `t_eb538e44` dashboard/API run_lanes contract

## 1. Product decision

Run grouping is a selectable Kanban swimlane mode inside the existing board view. It must not create separate `<Board> Runs` or archive Bases views per board.

Preferred control model:

- Keep the existing board/project selector unchanged.
- Keep status columns unchanged.
- Use the existing swimlane/grouping control to select the run property, e.g. `hermesRootRunId` / Run.
- When run swimlanes are off, existing board, assignee grouping, dependency, branch/worktree, status, archive, and graph affordances continue to behave exactly as they do today.

Suggested control labels:

- Swimlane combobox placeholder: `Select property for swim lanes (optional)`
- Run option label: `Run`
- Run option helper text, if the combobox supports descriptions: `Group Hermes tasks by logical root run`
- Clear control accessible label: `Clear swimlane grouping`
- Selected state accessible label: `Swimlanes grouped by Run`

Do not present a standalone `Runs` base/view as the default UX. If a saved view is needed for examples, it should be user-created or optional, not generated for every board.

## 2. View mode behavior

When the user selects Run in the swimlane combobox:

1. The underlying task set stays scoped to the current board/project and active filters.
2. Status columns remain the current board status columns in the existing order.
3. Rows become logical run lanes using root scope by default.
4. Cards remain normal TaskNotes Kanban cards.
5. Existing status transitions inside a lane remain available.
6. Cross-run drag/drop reassignment remains disabled/rejected in v1; run changes require explicit task actions/API/CLI.

When the user clears Run from the swimlane combobox:

1. The same task set returns to the non-run Kanban layout or the previously selected grouping.
2. No run metadata is mutated.
3. Assignee/project/dependency/branch/worktree affordances remain available.

Acceptance test wording:

- Enabling or clearing Run swimlanes must not add, remove, archive, or reassign tasks.
- Existing assignee grouping must still work when Run is not selected.

## 3. Run lane taxonomy

Render these lane types:

1. Normal run lane
   - A resolved logical run, usually top-level/root scoped.
   - Title comes from run title or mirrored task run title.
   - Fallback title is the run id.

2. No run lane
   - Synthetic lane for tasks with no logical/root run id.
   - Visible whenever populated.

3. Unknown run lane
   - Synthetic lane for tasks whose run id is present but cannot be resolved in the current board/tenant scope.
   - Visible whenever populated.
   - Must be text-based and not color-only.

Synthetic ids can remain implementation-specific, but the visible labels must be stable:

- `No run`
- `Unknown run`

## 4. Default expansion rules

Initial state, before user overrides:

- Active top-level, user, and orchestrator runs: expanded.
- Any run with `blocked > 0`: expanded.
- Any run with `running > 0` or `active > 0`: expanded.
- Completed/done/archived runs where `done >= total` and no active work remains: collapsed.
- `No run`: expanded when populated.
- `Unknown run`: expanded when populated, even if counts look completed, because it is a metadata warning.

User toggles:

- Toggle is per lane.
- Toggle affects only rendering, not filters, task membership, task readiness, status, or run assignment.
- If persistence is implemented, scope it by profile, board, view/grouping, run scope, and lane id.
- If persistence is not yet implemented, default rules should be recomputed on reload.

## 5. Expanded row layout

Expanded row anatomy:

- Left row header cell.
- One status cell for each existing status column.
- Normal task cards inside status cells.
- Existing empty-cell/add-task affordances where they are already allowed.

Row header content order:

1. Expand/collapse button.
2. Run title.
3. Run type badge.
4. Derived status badge.
5. Count summary.
6. Fallback/synthetic copy when applicable.
7. Actions, if feasible.

Required run header fields:

- Title:
  - Resolved title: e.g. `Implement run swimlanes phase 3`
  - Fallback: e.g. `run_20260605_1748` or `Run 81`
- Type badge:
  - `user`, `orchestrator`, `cron`, `webhook`, `session`, `manual`, `metadata`, `warning`, or `unknown`
- Derived status badge:
  - `blocked` when any visible task is blocked.
  - `running` when visible active/running work exists and no blocked task exists.
  - `done` when all visible tasks are done.
  - explicit backend status only when counts do not derive a clearer state.
- Counts:
  - Format: `{done}/{total} done · {active} active · {running} running · {blocked} blocked`
  - Example: `3/8 done · 5 active · 1 running · 2 blocked`

Expanded normal run example:

- Title: `Implement run swimlanes phase 3`
- Badges: `orchestrator`, `blocked`
- Count line: `3/8 done · 5 active · 1 running · 2 blocked`
- Toggle button aria-label: `Collapse Implement run swimlanes phase 3`

## 6. Collapsed row layout

Collapsed rows must not render task cards.

Collapsed row anatomy:

- Left row header remains visible and focusable.
- Each status column cell renders a count summary aligned under that status header.
- Counts must be visible text, not just color or icon badges.

Collapsed status cell copy:

- Preferred compact visible text: `{status}: {count}`
- Examples:
  - `todo: 0`
  - `running: 1`
  - `blocked: 2`
  - `done: 5`

Collapsed row header copy example:

- `Nightly sync · done · 8/8 done · 0 active · 0 running · 0 blocked`

Collapsed row accessible summary:

- `Run Nightly sync, collapsed, 8 tasks, 8 done, 0 active, 0 running, 0 blocked.`

Acceptance test wording:

- A collapsed run lane contains no `.kanban-view__card-wrapper` task card elements.
- Every collapsed status cell communicates its count with visible text.

## 7. No run lane copy and behavior

Visible label:

- `No run`

Preferred title copy when a longer header is used:

- `No run — tasks not assigned to a logical run`

Header count copy:

- Same count line as normal runs: `{done}/{total} done · {active} active · {running} running · {blocked} blocked`

Accessible copy:

- Singular: `1 task; task not assigned to a logical run.`
- Plural: `{count} tasks; tasks not assigned to a logical run.`

Tooltip/help copy:

- `These tasks do not have logical run metadata. They remain visible so work is not hidden.`

Behavior rules:

- Show when populated.
- Do not hide active No run tasks by default.
- Place near the end of run rows after resolved runs.
- It can be collapsed/expanded like any other lane.
- Add-task affordance in this lane must not invent a run id unless the user explicitly selects one.

## 8. Unknown run lane copy and behavior

Visible label:

- `Unknown run`

Preferred title copy when a longer header is used:

- `Unknown run — referenced run metadata is missing or not visible`

Required visible warning copy:

- `Referenced run metadata is missing or not visible.`

Longer tooltip/help copy:

- `These tasks reference a run that cannot be found in this board or tenant scope. The tasks remain visible and actionable.`

Accessible copy:

- Singular: `1 task; referenced run metadata is missing or not visible.`
- Plural: `{count} tasks; referenced run metadata is missing or not visible.`

Required non-color indicators:

- Visible text: `Unknown run`
- Visible text badge: `warning` or `metadata issue`
- Visible explanatory copy above
- Optional icon is allowed, but the warning cannot rely on icon/color alone.

Behavior rules:

- Show when populated.
- Default expanded when populated.
- Place after resolved runs and before/near No run, unless existing ordering already places synthetic lanes last.
- It can be collapsed/expanded like any other lane.
- Add-task affordance should be disabled or route to No run; do not create new tasks with unresolved run metadata.
- Copy run id action is not required because the lane represents multiple dangling ids; if shown, it should copy a specific selected task's unresolved run id, not the synthetic lane id.

Acceptance test wording:

- Unknown run warning must be visible in row text content.
- Unknown run row must have an aria-label or equivalent accessible name containing `referenced run metadata is missing or not visible`.
- A color-only dashed border without text is not acceptable.

## 9. Row actions

Minimum required action:

- Expand/collapse.

Recommended actions where feasible:

- Copy run id.
- Open run detail.
- Filter to this run.

Copy action:

- Visible icon can be copy icon.
- Tooltip: `Copy run id {id}`
- Aria-label: `Copy run id {id}`
- On success, optional notice: `Copied run id`

Open action:

- Visible label/tooltip: `Open run detail`
- Aria-label: `Open run detail for {title}`
- If no dedicated run detail surface exists, omit this action rather than linking to a misleading page.

Filter action:

- Visible label/tooltip: `Filter to this run`
- Aria-label: `Show only tasks in {title}`
- Must preserve current board/project boundary.

Do not show unavailable actions as dead controls. If a capability is not implemented, omit it or keep it disabled with explanatory tooltip.

## 10. Drag/drop and add-task interaction notes

In-lane drag/drop:

- Moving a card between status columns within the same run lane follows existing Kanban status transition behavior.
- The run id/root run id should not change.

Cross-run drag/drop:

- Disabled/rejected in v1.
- Rejection copy: `Run reassignment is explicit-only in v1. Use task actions, CLI, or API to change run.`
- Tooltip copy on rejected target, if feasible: `Run cannot be changed by dragging between lanes.`
- Failed cross-run drag must restore the card position and must not mutate task metadata.

Add task:

- In normal run/status cell: if add-task defaults can safely populate the run property, prefill board/project, status, and run id.
- In No run: create without run id unless the user chooses one.
- In Unknown run: disable or redirect to No run; do not copy unknown metadata into new tasks.

## 11. Accessibility requirements

Run header toggle:

- Must be a real `button`.
- Required attributes:
  - `type="button"`
  - `aria-expanded="true|false"`
  - `aria-label="Collapse {title}"` or `aria-label="Expand {title}"`

Row accessible name:

- Normal expanded: `Run {title}, {total} tasks, {status}, expanded.`
- Normal collapsed: `Run {title}, {total} tasks, {status}, collapsed.`
- No run: `{count} tasks; tasks not assigned to a logical run.`
- Unknown run: `{count} tasks; referenced run metadata is missing or not visible.`

Collapsed count cells:

- Each count cell must expose the status name and count in text.
- Acceptable visible text: `blocked: 2`
- If compact visual text is shortened, provide aria-label: `Blocked: 2 tasks`.

Keyboard behavior:

- Tab reaches row toggles and row action buttons.
- Enter/Space toggles the focused row button.
- Focus order should not jump through hidden task cards in collapsed rows.

Color and icons:

- Blocked, review, and unknown states may use color/icon treatment, but must also include text.
- Unknown run specifically requires `Unknown run` plus `warning`/`metadata issue` or the explanatory warning sentence.

Motion:

- Collapse/expand animation should be minimal and respect reduced motion.

## 12. Preservation of existing affordances

Must preserve:

- Board/project selection as primary boundary.
- Existing status column labels, order, counts, WIP limits, unknown-status copy, and status controls.
- Existing assignee grouping when run grouping is off.
- Existing TaskNotes card actions and context menus.
- Existing dependency/relationship indicators on cards.
- Existing branch/worktree metadata display on cards or detail surfaces.
- Existing graph/dependency views as separate inspection modes.

Run grouping must not:

- Infer runs from branch/worktree/assignee.
- Replace dependency readiness semantics.
- Hide No run or Unknown run tasks when populated.
- Generate a separate Runs base/archive base per board.

## 13. Implementation acceptance checklist

A run-row implementation is acceptable when all of the following are true:

1. The user can select Run in the existing swimlane/grouping combobox.
2. Clearing that selection returns to normal Kanban/other grouping without metadata changes.
3. Active top-level/user/orchestrator runs default expanded.
4. Completed runs default collapsed.
5. Expanded rows render normal status cells and task cards.
6. Collapsed rows render no cards and show status-aligned counts in visible text.
7. Normal run headers include title/id fallback, type badge, derived status badge, and count summary.
8. No run lane is visible when populated and uses explicit copy.
9. Unknown run lane is visible when populated and uses text-based warning copy, not color-only styling.
10. Row toggles and row actions have clear accessible labels.
11. Copy/open/filter actions are present only where they are actually wired.
12. Cross-run drag/drop does not reassign tasks in v1 and communicates why.
13. Existing board/project/status/assignee/dependency/branch/worktree affordances continue to work.

## 14. QA scenarios

Reviewer-qa should exercise at least these scenarios:

1. Current board with run swimlane off: existing Kanban behavior unchanged.
2. Current board with Run selected in swimlane combobox: same task set grouped into run rows.
3. Active user/orchestrator run: starts expanded with cards visible.
4. Completed run: starts collapsed with per-status count summaries and no cards.
5. Manually expand completed run: cards appear under normal status columns.
6. No run tasks: lane appears with `No run` copy and counts.
7. Unknown run tasks: lane appears with visible `Unknown run` warning text and accessible aria copy.
8. Keyboard: tab to row toggle; Enter/Space toggles; collapsed row does not focus hidden cards.
9. Cross-run drag attempt: task run metadata does not change; explanatory copy/toast/tooltip appears if feasible.
10. Assignee grouping after clearing Run: still works.

## 15. Engineering handoff

Relevant current files from this workspace:

- `src/bases/KanbanView.ts` — render swimlane table, row headers, collapsed summaries, drag/drop, add buttons.
- `src/bases/kanbanRunSwimlanes.ts` — helper logic for lane ids, display title, derived status, default expansion, accessible copy, status counts, lane resolution, retry de-duplication, and explicit reassignment/attempt snapshots.
- `styles/bases-views.css` and/or `styles/kanban-view.css` — run lane, warning, collapsed-row styles.
- `tests/unit/bases/kanbanRunSwimlanes.test.ts` — helper and render tests for default expansion, No run/Unknown copy, collapsed rows, cross-run drop rejection, and collapse persistence scope.
- `tests/unit/bases/kanbanRunSwimlanesNonRegression.test.ts` — non-regression contract tests for board/project boundaries, status grouping invariants, branch/worktree non-inference, tenant isolation, root/direct scope, retry counts, and reassignment history stability.
- `tests/unit/hermes/hermesApiClient.test.ts` — board API grouping query and explicit reassignment request tests.
- `docs/development/hermes-run-swimlane-rollout.md` — rollout, rollback, backfill, and v1 reassignment semantics.
- `src/hermes/hermesCanonicalTaskNotes.ts` — canonical run frontmatter names such as `hermesRootRunId`, `hermesRunId`, `hermesRunTitle`, `hermesRunType`.

Implementation should align helper copy with this spec, especially the singular/plural accessible strings and Unknown run warning sentence.
