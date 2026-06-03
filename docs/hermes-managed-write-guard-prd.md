# Hermes Managed Write Guard PRD

## Summary

TaskNotes should prevent Hermes-managed task creation and editing when it cannot
confirm live communication with the Hermes Kanban API.

The user-facing behavior is simple:

- If Hermes is live, Hermes-managed TaskNotes can be created and edited.
- If Hermes is starting, degraded, or disconnected, Hermes-managed TaskNotes are
  readable but guarded against writes.
- Ordinary local TaskNotes that are not tied to Hermes remain editable.

This avoids silent drift between the local TaskNote mirror and the Hermes Kanban
board. The UI should make the unavailable state obvious by greying out affected
controls, but the core protection must live in the write path, not only in the
visual disabled state.

## Background

The Hermes integration currently gives TaskNotes a local Obsidian surface for
Hermes board work. Hermes-managed tasks are identified by the board-folder path
shape:

```text
TaskNotes/<board>/<task-id>.md
```

TaskNotes can read cached task information from the local note even when Hermes
is unavailable. That is useful for review and orientation, but it can also make
the interface look more live than it is. If the user edits a Hermes-managed
TaskNote while TaskNotes cannot reach the Kanban API, the local note can diverge
from the board state Hermes is using to dispatch and track work.

The integration already has an availability model with connected, degraded,
disconnected, and starting states. The next step is to make availability affect
write eligibility for Hermes-managed work.

## Problem

TaskNotes needs to show Hermes-managed tasks when Hermes is unavailable, but it
must not imply that local edits will update the Hermes board.

Without a guard, these failure modes are possible:

- A user edits status, title, assignee, priority, dependencies, or details in
  the local TaskNote mirror while Hermes is unavailable.
- A user creates a new task in a Hermes board folder while the Kanban API cannot
  accept or reconcile it.
- A command-palette, inline task, context-menu, batch, or direct-file-edit path
  bypasses UI affordances that were greyed out in one modal.
- On reconnect, TaskNotes and Hermes disagree about the current task state.
- The user cannot tell whether a field is live, cached, or locally changed only.

The product needs one clear invariant:

```text
Hermes-managed writes require confirmed live Hermes availability.
```

## Goals

- Prevent TaskNotes-initiated writes to Hermes-managed tasks when Hermes Kanban
  is not confirmed live.
- Keep Hermes-managed TaskNotes readable in offline or degraded states.
- Keep non-Hermes TaskNotes fully usable.
- Make disabled controls understandable through compact copy, tooltips, and
  Start/Recheck actions.
- Guard all TaskNotes mutation entry points, not just the edit modal.
- Prefer a fail-closed MVP over local queued writes or conflict resolution.
- Re-enable guarded controls quickly after a successful availability recheck.
- Provide testable acceptance criteria for create, edit, command, and direct
  file-change paths.

## Non-Goals

- Implementing a durable offline outbox.
- Automatically replaying local offline edits after Hermes reconnects.
- Designing a merge-conflict workflow between local TaskNotes and Hermes.
- Making ordinary non-Hermes TaskNotes read-only.
- Replacing the Hermes dashboard.
- Reworking the TaskNotes HTTP API and webhook sync architecture.
- Storing new Hermes identity fields as the primary board contract.
- Blocking a user from editing a markdown file directly in Obsidian. Direct file
  edits can be detected and warned about, but the plugin cannot fully prevent
  them.

## Definitions

| Term | Meaning |
| --- | --- |
| Hermes-managed task | A TaskNote whose path derives a Hermes board/task identity and whose tags or routing mark it as Hermes board work. |
| Live Hermes | The Hermes dashboard and Kanban API are reachable, authenticated if needed, and capable of reading the current board/task state. |
| Cache-only | TaskNotes can render local TaskNote data, but cannot confirm live Kanban state. |
| Guarded write | A create, update, archive, delete, relationship, comment, status, board, assignee, or priority change that could alter Hermes-managed state. |
| Local-only task | A normal TaskNote that does not map to a Hermes Kanban task. |
| Direct file edit | A markdown/frontmatter edit made outside TaskNotes modal controls, such as Obsidian source mode or another automation. |

## Product Rule

The guard should be based on task semantics, not on where the user clicked.

```text
If the target task or creation destination is Hermes-managed,
and Hermes is not live,
the write is blocked.
```

The UI can show this as greyed-out controls, but every write path should call
the same readiness check before mutation.

## Users

| User | Need |
| --- | --- |
| Obsidian operator | Read Hermes tasks even when Hermes is down, and know when edits are blocked. |
| Hermes dispatcher | Avoid consuming stale or divergent TaskNote state. |
| Reviewer | Inspect cached activity and task details without accidentally mutating board state. |
| Plugin maintainer | Have one write-readiness policy that applies across modals, commands, context menus, and services. |

## Scope

### In Scope

- Task creation modal when the selected creation target is a Hermes board or
  Hermes direct API target.
- Task edit modal for Hermes-managed tasks.
- Inline task creation when defaults or parent context route to a Hermes board.
- Command palette commands that create or mutate Hermes-managed tasks.
- Context-menu and batch operations on Hermes-managed tasks.
- Block/unblock, archive/delete, status, assignee, board, dependency, title,
  details, priority, and comment actions.
- Goal Mode creation when it would create or link a Hermes card.
- Lifecycle reconciliation paths that react to direct file edits.

### Out Of Scope

- Plain local TaskNotes outside Hermes board routing.
- Read-only display of cached Hermes activity.
- Obsidian's raw markdown editor preventing the user from typing.
- Network or dashboard process management beyond the existing Start/Recheck
  affordances.

## Availability Model

The write guard should consume the existing Hermes availability service.

| Availability | Read behavior | Write behavior |
| --- | --- | --- |
| `connected` + `live` | Render live data and local TaskNote fields. | Allow guarded writes. |
| `starting` | Render local cache with checking copy. | Block guarded writes until the recheck succeeds. |
| `degraded` | Render cached data and any confirmed live reads. | Block guarded writes unless capability-specific write health is proven. MVP blocks all writes. |
| `disconnected` | Render local TaskNote mirror only. | Block guarded writes. |
| `read-only` mode | Render local TaskNote mirror only. | Block guarded writes and hide startup actions when unavailable. |

MVP should treat `degraded` as read-only for Hermes-managed writes. A later
version may allow capability-level exceptions if the health model can prove, for
example, that task updates are live even though event streaming is down.

## UX Requirements

### Hermes Task Edit Modal

When a Hermes-managed task opens while Hermes is not live:

- Show the existing availability chip as `Hermes starting`, `Hermes degraded`,
  or `Cache only`.
- Keep task details and cached activity readable.
- Disable Save and all live mutation controls.
- Add a tooltip to disabled controls:

```text
Requires live Hermes. Showing the local TaskNote mirror.
```

- Change the primary save area copy or tooltip to:

```text
Editing is disabled until Hermes reconnects.
```

- Keep `Start Hermes` available only when desktop startup is supported.
- Keep `Recheck` available in all unavailable states.
- After a successful recheck, re-enable controls without requiring the modal to
  be closed and reopened.

### Hermes Task Creation Modal

When the selected creation destination is Hermes-managed and Hermes is not live:

- Disable the primary Create button.
- Show compact helper copy near the destination picker:

```text
Hermes is unavailable. Start or reconnect Hermes to create board tasks.
```

- Keep destination controls usable enough for the user to switch to a local-only
  TaskNotes destination if one is available.
- Do not silently create a Hermes-tagged local draft as a board task.

If the product later supports local drafts, it should be explicit:

- Button text: `Create local draft`
- Tags/routing should not mark it as a live Hermes board task.
- The draft should require an intentional later action to promote it to Hermes.

### Commands And Context Menus

Guarded commands should fail with a clear notice instead of opening a dead modal
or mutating the local file.

Notice copy:

```text
Hermes is unavailable. Start or reconnect Hermes before editing board tasks.
```

For batch operations, apply the guard per selected task:

- Non-Hermes tasks proceed normally.
- Hermes-managed tasks are skipped while Hermes is unavailable.
- The final notice should report how many Hermes tasks were skipped.

### Direct File Edits

TaskNotes cannot prevent a user from editing markdown directly, but it should
avoid converting that edit into a hidden Hermes write when Hermes is unavailable.

MVP behavior:

- Detect direct edits to Hermes-managed task files through lifecycle
  reconciliation.
- If Hermes is not live, do not attempt Hermes sync side effects.
- Log a warning with path, board, task ID, and availability state.
- Show a notice at most once per short cooldown:

```text
Hermes is unavailable. Local edits to board tasks may be stale until rechecked.
```

On reconnect, the system should prefer live Hermes state unless a future conflict
workflow is implemented.

## Write Readiness Service

Implement a small, shared guard API rather than duplicating checks in each UI
component.

Suggested shape:

```ts
type HermesWriteReadiness =
	| { allowed: true; board: string; taskId?: string }
	| {
			allowed: false;
			board: string;
			taskId?: string;
			status: HermesAvailabilityStatus;
			mode: HermesAvailabilityMode;
			reason: string;
	  };
```

Suggested checks:

- `canWriteHermesTask(task: TaskInfo): Promise<HermesWriteReadiness>`
- `canCreateHermesTask(board: string): Promise<HermesWriteReadiness>`
- `assertCanWriteHermesTask(task: TaskInfo): Promise<void>`
- `assertCanCreateHermesTask(board: string): Promise<void>`

The guard should:

- Use path-derived identity for existing Hermes tasks.
- Use the selected board/destination for creation.
- Reuse cached health briefly to avoid repeated health checks on every keystroke.
- Force a fresh check before final submit/save actions.
- Return copy-ready reasons for notices and tooltips.
- Avoid network checks for non-Hermes tasks.

## Guarded Mutation Points

The following paths must call the shared readiness service before writing:

| Area | Guard condition |
| --- | --- |
| Task edit modal save | Existing task is Hermes-managed. |
| Task creation modal submit | Selected destination is Hermes-managed or direct Hermes API create. |
| Inline task creation | Defaults or parent context route the new task to a Hermes board. |
| Task status toggles | Target task is Hermes-managed. |
| Archive/delete/block/unblock | Target task is Hermes-managed. |
| Dependency updates | Source or target task is Hermes-managed. |
| Context-menu operations | Any selected task is Hermes-managed. |
| Batch operations | Each selected Hermes-managed task is guarded individually. |
| Goal Mode sync | Task would create or attach a Hermes card. |
| Direct file reconciliation | Edited file is Hermes-managed. |

## Data Policy

MVP should not create a pending-write queue.

Reasons:

- Queueing implies replay and conflict handling.
- Hermes state can change while TaskNotes is offline.
- Users may believe queued writes are already accepted.
- The current integration has no durable merge policy.

Instead:

- Reads can use the local TaskNote mirror.
- Writes require live Hermes.
- Reconnect rechecks should refresh the local TaskNote from Hermes before
  enabling writes.

## Copy Guidelines

Use short, operational copy. Avoid implying that TaskNotes can safely sync later
unless a real sync workflow exists.

Preferred labels:

- `Hermes live`
- `Hermes starting`
- `Hermes degraded`
- `Cache only`
- `Recheck`
- `Start Hermes`

Preferred disabled reasons:

- `Requires live Hermes. Showing the local TaskNote mirror.`
- `Start or reconnect Hermes before editing board tasks.`
- `Hermes is partially available; writes are disabled until recheck succeeds.`

Avoid:

- `Will sync later`
- `Pending`
- `Offline edit saved`
- `Safe to edit`

## Acceptance Criteria

### Edit Modal

- Given a Hermes-managed task and live Hermes, Save and live controls are
  enabled.
- Given a Hermes-managed task and disconnected Hermes, Save is disabled and live
  controls are greyed out.
- Given a disconnected Hermes task, clicking disabled controls does not mutate
  the TaskNote.
- Given a disconnected Hermes task, pressing Recheck after Hermes becomes live
  re-enables guarded controls.
- Given a non-Hermes task, Save remains available regardless of Hermes health.

### Creation Modal

- Given a Hermes board destination and disconnected Hermes, Create is disabled.
- Given a local-only destination and disconnected Hermes, Create remains
  available.
- Given a Hermes board destination and reconnected Hermes, Create becomes
  available after Recheck.
- Direct Hermes API creation cannot run when Hermes is unavailable.

### Commands And Services

- Command-palette status toggles do not mutate Hermes-managed tasks while Hermes
  is unavailable.
- Context-menu and batch actions skip Hermes-managed tasks while Hermes is
  unavailable and report skipped counts.
- Goal Mode sync does not create Hermes cards while Hermes is unavailable.
- Lifecycle reconciliation does not attempt Hermes write side effects for direct
  file edits while Hermes is unavailable.

### Drift Prevention

- A blocked write should leave the TaskNote frontmatter unchanged.
- A failed readiness check should not create partial Hermes metadata.
- A reconnect should refresh from Hermes before enabling edits.

## Verification Plan

Unit tests:

- Readiness service returns allowed for live Hermes and blocked for starting,
  degraded, disconnected, and read-only modes.
- Non-Hermes tasks bypass Hermes readiness checks.
- Creation readiness uses the selected board, not only the active file.
- Edit modal disables Save and mutation controls from blocked readiness.
- Creation modal disables Create for Hermes destinations when blocked.
- Task service mutation paths throw or skip before writing blocked Hermes tasks.
- Lifecycle reconciliation skips Hermes sync side effects while blocked.

Integration/manual checks:

- Build and copy to the e2e vault with `npm run build:test`.
- With Hermes stopped, open a Hermes-managed task in Obsidian and verify read
  access plus disabled writes.
- Start Hermes from the modal, recheck, and verify controls re-enable.
- Stop Hermes again and verify command-palette and context-menu writes are
  blocked.
- Run `npm run verify:obsidian` with the live vault open.

## Rollout

1. Add shared write-readiness service and unit tests.
2. Wire the edit modal Save path and obvious live controls.
3. Wire the creation modal and direct Hermes create path.
4. Wire command, context-menu, batch, and service mutation paths.
5. Add lifecycle reconciliation handling for direct file edits.
6. Add release notes and update availability UX docs if copy changes.
7. Run build, focused tests, lint/typecheck as appropriate, `npm run
   build:test`, and `npm run verify:obsidian`.

## Open Questions

- Should degraded mode eventually support capability-level write permissions, or
  should all degraded states remain read-only for simplicity?
- Should the creation modal offer an explicit local draft mode, or should Hermes
  board creation be fully unavailable until live?
- Should direct file edits add a visible local warning marker to the note, or is
  a notice/log enough for MVP?
- On reconnect, should TaskNotes always refresh from Hermes before editing, or
  should it compare local and remote state and warn about differences?
