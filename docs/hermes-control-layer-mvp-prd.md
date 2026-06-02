# TaskNotes as Hermes Kanban Frontend MVP PRD

## Summary

TaskNotes should become the primary Obsidian frontend for Hermes Kanban. Users should create, view, route, and update Hermes board tasks from normal TaskNotes surfaces: the task modal, Kanban/Bases views, task cards, task menus, and property controls.

The MVP removes the idea that Hermes tasks are a separate classification of TaskNotes task. A TaskNotes board folder is a Hermes board surface. Ownership and execution routing are expressed through normal task properties, especially `assignee`.

## Problem

The current implementation still carries old Hermes bridge concepts:

- Some code treats Hermes tasks as a separate task class.
- Some paths still assume old mirror-folder conventions instead of the native board folder.
- Some creation routes can collapse ordinary view defaults into triage submission.
- Human-owned work can be treated as an exceptional blocked state instead of first-class board work.
- The settings UI can expose stale Hermes-specific modal groups that are no longer useful.

This creates ambiguity. Users should not need to understand whether a task is “TaskNotes-local,” “Hermes-classified,” or “Hermes-mirror.” If TaskNotes is the frontend, then TaskNotes task actions should either create or update Hermes Kanban tasks directly, then reflect the accepted board state in the note.

## MVP Goal

Ship a coherent MVP where TaskNotes is the usable control panel for Hermes Kanban tasks.

The user can create a task from TaskNotes, assign it to themself or an agent, see it on the appropriate TaskNotes board, update task fields, comment, manage blockers, and trust that Hermes is the system of record.

## Product Principles

- TaskNotes is the frontend; Hermes is the board state and execution backend.
- Board identity comes from the TaskNotes board folder: `TaskNotes/<board>/<task-id>.md`.
- There is no separate reserved local task folder model for board tasks in the MVP.
- `assignee` controls ownership and execution routing.
- Self-assigned work is valid board work, not an error case.
- Agent-runnable work and human-owned work use the same task surfaces.
- View defaults from Bases/Kanban creation must be preserved.
- Local notes are a durable cache and interaction surface, not a second source of truth.

## Users

- Primary user: an Obsidian user managing personal and agent work from TaskNotes boards.
- Secondary users: Hermes workers and dispatchers that consume board tasks through the Hermes API.

## Definitions

| Term | Meaning |
| --- | --- |
| Board task | A Hermes Kanban task represented in TaskNotes. |
| Board folder | A TaskNotes folder representing a Hermes board, for example `TaskNotes/hhmi/`. |
| Self-assigned task | A board task whose `assignee` is the user, for example `yt`, `user`, or `human`. |
| Agent-assigned task | A board task whose `assignee` is an executable worker, for example `codex` or `peacock`. |
| Mirror note | The local markdown note that reflects the accepted Hermes task state. |

## Data Contract

Board task notes live at:

```text
TaskNotes/<board>/<task-id>.md
```

Example:

```yaml
---
type: task
tags:
  - task
  - hermes-kanban
title: Draft packet cleanup
status: ready
priority: normal
projects:
  - Hermes/hhmi
contexts:
  - hhmi
assignee: yt
blockedBy:
  - "[[TaskNotes/hhmi/t_parent]]"
dateCreated: 2026-06-02T12:00:00.000Z
---
```

The markdown body contains the task details/body accepted by Hermes.

### Fields To Avoid

New board notes should not use old bridge fields as the primary contract:

- `hermes_id`
- `hermes_board`
- `hermes_status`
- `hermes_assignee`
- `blocked_by`
- `blocks`
- `sync_origin`
- `sync_hash`
- `last_synced`
- writeback fields

The MVP does not use these fields for identity or routing. Existing legacy notes should be moved into the native board folder shape by a separate migration or manual cleanup pass.

## Assignee Model

`assignee` is the primary routing property.

Examples:

```yaml
assignee: yt
```

```yaml
assignee: codex
```

### Self-Assignee

Self-assigned tasks remain on the board and are visible in TaskNotes Kanban/Bases views. They are not agent-runnable unless the user changes the assignee to an agent.

Self-assigned work should not automatically mean `blocked`. The user can still use statuses such as `triage`, `todo`, `ready`, `review`, or `done`.

### Agent Assignee

Agent-assigned tasks are eligible for Hermes dispatcher/worker handling when their status and backend policy allow it.

### Suggested MVP Assignee Values

- Self/human: `yt`, `user`, `human`, `vaitheesh`
- Agents: `codex`, `orchestrator`, `peacock`, `research-librarian`, `reviewer-qa`

The actual list should be configurable through TaskNotes user-field settings.

## Status Model

The MVP should use Hermes-compatible status values for board tasks:

| Value | Meaning |
| --- | --- |
| `triage` | Needs routing or clarification |
| `todo` | Accepted but not ready to run |
| `scheduled` | Planned for a future time |
| `ready` | Ready for the assigned owner |
| `running` | Claimed or in progress |
| `blocked` | Cannot proceed until blocker is resolved |
| `review` | Awaiting review |
| `done` | Completed |
| `archived` | Hidden from active board surfaces |

TaskNotes may still support broader global statuses, but board tasks should round-trip cleanly through Hermes status values.

## Create Flow

### Default Create

1. User creates a task from TaskNotes, a TaskNotes board, or a Bases/Kanban view.
2. TaskNotes preserves any view-derived defaults:
   - status
   - priority
   - project
   - context/board
   - custom fields
   - assignee
3. If no board is explicit, TaskNotes chooses the active board or configured default board.
4. If no status is explicit, TaskNotes defaults to `triage`.
5. If no assignee is explicit, TaskNotes leaves it blank or uses the configured default.
6. TaskNotes calls Hermes create API.
7. Hermes returns the accepted task state and task ID.
8. TaskNotes writes or refreshes the note at `TaskNotes/<board>/<task-id>.md`.

### Create API Shape

```http
POST /api/plugins/kanban/tasks?board=<board>
```

Payload:

```json
{
  "title": "Draft packet cleanup",
  "body": "Clean up repeated claims and rebuild from facts.",
  "status": "triage",
  "priority": 3,
  "assignee": "yt",
  "parents": ["t_parent"],
  "idempotency_key": "<stable-client-key>"
}
```

The MVP should preserve a user-specified status instead of forcing every create into `triage`.

## Update Flow

For an existing board task, TaskNotes derives identity from the path:

```text
TaskNotes/hhmi/t_123.md
```

Identity:

```json
{ "board": "hhmi", "id": "t_123" }
```

Supported MVP actions:

| TaskNotes action | Hermes behavior |
| --- | --- |
| Edit title | Patch title |
| Edit details/body | Patch body or add comment if body is read-only |
| Change status | Patch status |
| Change priority | Patch priority |
| Change assignee | Patch assignee |
| Add blocker | Create parent link |
| Remove blocker | Remove parent link |
| Add comment | Create comment |
| Archive | Patch status to `archived` or call archive endpoint |
| Delete | Confirm and call Hermes delete/archive policy |

After every accepted mutation, TaskNotes refreshes the note from Hermes.

## Modal MVP

The task modal should feel like TaskNotes, not a Hermes admin panel.

Required sections:

- Title
- Details
- Status
- Board/context
- Assignee
- Priority
- Blocked By
- Blocking
- Comments
- Run History
- Events

The settings modal should use stable TaskNotes groups:

- Task
- Routing
- Dependencies
- TaskNotes Metadata
- TaskNotes Organization
- Other Fields

There should be no empty Hermes-only groups in the modal fields configuration.

## Bases and Kanban MVP

Bases/Kanban creation must preserve the user’s current view context.

Examples:

- Creating from a `done` column should create with `status: done`.
- Creating from a `Project Alpha` filtered view should preserve `projects: [[Project Alpha]]`.
- Creating from a swimlane should preserve both column and swimlane defaults.
- Creating from a board folder should infer that board.

This is critical because TaskNotes is the frontend. A board submission path must not erase the meaning of the current TaskNotes view.

## Execution Routing

Hermes workers should decide runnable work from `assignee` plus backend policy.

MVP rule:

- `assignee` in self/human list: visible board work, not auto-claimed by workers.
- `assignee` in agent list: eligible for worker handling if status allows.
- blank assignee: remains triage/unassigned until routed.

The UI should not need a separate “Hermes task classification” toggle.

## Error Handling

- If Hermes create/update fails, TaskNotes should not silently mutate the local note.
- If Hermes accepts a mutation but note refresh fails, show a clear notice and keep the task discoverable.
- If identity cannot be derived from the native board path, disable board actions and show a direct message.
- If a task is self-assigned, do not warn that it is not agent-runnable; that is expected.
- If a worker-only status is selected for a self-assigned task, show a soft warning only when needed.

## MVP Acceptance Criteria

- New board task notes are written under `TaskNotes/<board>/<task-id>.md`.
- `TaskNotes/Hermes/<board>/<task-id>.md` is not part of the MVP identity contract.
- TaskNotes creation calls Hermes first, then writes/refreshes the note.
- Bases/Kanban creation preserves column, swimlane, project, status, priority, and custom defaults.
- User can set `assignee` to themself and keep the task on the board.
- Self-assigned tasks are not treated as invalid or automatically blocked.
- Agent-assigned tasks remain eligible for Hermes execution.
- Modal field settings do not show empty Hermes-only groups.
- Assignee appears as a first-class TaskNotes organization/routing field.
- Comments can be added from the modal.
- Run history and events render in the modal without being written into task body/frontmatter.
- Blocker links round-trip through Hermes.
- Archive/delete calls Hermes policy before changing local notes.
- Focused unit tests pass for creation, identity, modal activity, assignee suggestions, and Bases/Kanban defaults.
- Full suite passes under the repo’s expected test timezone.

## Non-Goals

- Rebuilding the Hermes dashboard.
- Making TaskNotes the backend source of truth.
- Offline divergent edits that later merge into Hermes.
- Full execution monitoring beyond comments, run history, and event display.
- Multi-user permissioning.
- Migrating every legacy note automatically.

## Implementation Plan

### Phase 1: Identity and Settings Contract

- Use `TaskNotes/<board>/<task-id>.md` as the canonical identity path.
- Remove legacy path identity fallback from the MVP path.
- Remove Hermes-only modal field groups.
- Promote `assignee` to a visible TaskNotes routing/organization field.

### Phase 2: Create and Update Routing

- Route TaskNotes creates through Hermes.
- Preserve Bases/Kanban defaults on create.
- Patch title, status, priority, assignee, comments, and blocker links through Hermes.
- Refresh note after accepted mutations.

### Phase 3: Self-Assignee Workflow

- Add configurable self/human assignee values.
- Prevent self-assigned tasks from being auto-claimed by workers.
- Keep self-assigned tasks visible and actionable in TaskNotes boards.
- Add tests for self-assigned board tasks.

### Phase 4: Modal Activity

- Render comments, run history, and events in the edit modal.
- Open linked artifacts/tasks from activity cards.
- Keep read-only activity out of task body/frontmatter.

## Open Questions

- What is the default self-assignee value: `yt`, `user`, or a setting?
- Should blank assignee create as `triage`, or should TaskNotes prompt for owner?
- Should self-assigned `ready` be allowed without warning?
- Is `projects: Hermes/<board>` still useful, or should `contexts: [<board>]` be the only board marker?
- Should delete mean true delete, archive, or move to `archived` status?
