# Hermes Control Layer MVP PRD

## Summary

TaskNotes should act as the local control layer for Hermes kanban work. Users create, organize, and act on tasks from familiar TaskNotes surfaces, while Hermes remains the authoritative execution system. Mirror notes stay native to TaskNotes so they are searchable, linkable, and usable in Bases/Kanban views without carrying duplicate Hermes state.

## Problem

The current workflow splits intent across two systems:

- TaskNotes can display and edit task-like notes.
- Hermes owns agent execution, board state, comments, run history, and task dependencies.
- Mirror notes have historically carried Hermes-specific frontmatter, which turns the note into a second partial database.
- Local TaskNotes edits can look real before Hermes accepts them.
- Human-owned work needs to be visible in TaskNotes but should not be picked up by Hermes agents as runnable.

The MVP should remove this ambiguity. TaskNotes actions that affect Hermes work should call Hermes first, then refresh the mirror note from Hermes.

## Goals

- Use TaskNotes as the main UI for creating and controlling Hermes kanban tasks.
- Submit new Hermes-targeted TaskNotes tasks directly to Hermes via API.
- Keep Hermes mirror notes native to TaskNotes frontmatter conventions.
- Derive Hermes identity from mirror path: `TaskNotes/Hermes/<board>/<task-id>.md`.
- Sync TaskNotes status values to Hermes kanban status values.
- Add a native `assignee` organizational property.
- Treat human/user assignees as non-runnable work and block them in Hermes.
- Support core actions: create, update title/body, change status, assign, comment, link blockers, archive/delete, and refresh.

## Non-Goals

- Replacing the Hermes dashboard.
- Rebuilding Hermes run execution inside TaskNotes.
- Supporting offline-first divergent edits for Hermes tasks.
- Adding swimlanes for full task runs.
- Encoding all Hermes event/run history into mirror-note body/frontmatter.

## Users

- Primary user: an Obsidian user who manages agent work from TaskNotes and Bases views.
- Secondary users: Hermes worker agents and orchestration logic that consume the Hermes kanban API.

## Product Principles

- API first: every Hermes mutation goes to Hermes before mirror notes change.
- Mirror notes are cache and control surface, not source of truth.
- Native TaskNotes fields should be preferred over custom Hermes fields.
- If a TaskNotes action cannot be safely translated to a Hermes API call, fail visibly.
- Read-only Hermes metadata belongs in the modal activity UI, not in the mirror body.

## Native Mirror Note Contract

Mirror notes should use TaskNotes-native frontmatter only:

```yaml
---
type: task
tags:
  - task
  - hermes-kanban
title: Example task
status: triage
priority: normal
projects:
  - Hermes/default
contexts:
  - hermes-kanban
assignee: orchestrator
blockedBy:
  - "[[TaskNotes/Hermes/default/t_parent]]"
dateCreated: 2026-06-01T12:00:00.000Z
completedDate: 2026-06-01T13:00:00.000Z
---
```

The Markdown body contains only the Hermes task body.

Do not write these fields to mirror notes:

- `hermes_id`
- `hermes_board`
- `hermes_status`
- `hermes_assignee`
- `hermes_priority`
- `blocked_by`
- `blocks`
- `sync_origin`
- `sync_hash`
- `last_synced`
- writeback fields

## Status Model

TaskNotes status values for Hermes work should match Hermes kanban values:

| Value | Label | Completed |
| --- | --- | --- |
| `triage` | Triage | No |
| `todo` | Todo | No |
| `scheduled` | Scheduled | No |
| `ready` | Ready | No |
| `running` | In Progress | No |
| `blocked` | Blocked | No |
| `review` | Review | No |
| `done` | Done | Yes |

Legacy or non-Hermes statuses like `open`, `none`, and `in-progress` may remain globally for ordinary TaskNotes tasks, but Hermes views should not depend on them.

## Assignee Model

Add a native organizational field:

```yaml
assignee: orchestrator
```

MVP assignee classes:

- Human: `human`, `user`, `yt`, `vaitheesh`
- Agent: `orchestrator`, `codex`, `peacock`, `research-librarian`, `reviewer-qa`, `ops-steward`, `default`

Rules:

- Human assignee means the task is waiting on a person.
- When `assignee` is set to a human value, TaskNotes should call Hermes API to set:
  - `assignee`: human value
  - `status`: `blocked`
  - `block_reason`: `Waiting on human: <assignee>`
- When `assignee` changes from human to an agent, TaskNotes should call Hermes API to update assignee and offer to move status to `ready` or `triage`.
- The mirror note should reflect the accepted Hermes response.

## Create Flow

1. User opens TaskNotes create modal.
2. User chooses a Hermes board via the board control, or creates from a Hermes board/lane context.
3. User enters title/body and optional assignee, priority, blockers.
4. On save, TaskNotes calls Hermes:

```http
POST /api/plugins/kanban/tasks?board=<board>
```

Payload:

```json
{
  "title": "Example task",
  "body": "Task body",
  "priority": 3,
  "assignee": "orchestrator",
  "parents": ["t_parent"],
  "triage": true,
  "idempotency_key": "<stable-client-key>"
}
```

5. Hermes returns task ID and accepted state.
6. TaskNotes writes or refreshes mirror note at:

```text
TaskNotes/Hermes/<board>/<task-id>.md
```

7. TaskNotes opens or highlights the new mirror note according to existing TaskNotes settings.

## Update Flow

For an existing mirror note, TaskNotes derives identity from path:

```text
TaskNotes/Hermes/default/t_123.md
```

Identity:

```json
{ "board": "default", "id": "t_123" }
```

When user edits task fields:

| TaskNotes Action | Hermes API Action |
| --- | --- |
| Title edit | `PATCH /tasks/:id` with `title` |
| Body/details edit | `PATCH /tasks/:id` with `body` |
| Status change | `PATCH /tasks/:id` with `status` |
| Priority change | `PATCH /tasks/:id` with numeric priority |
| Assignee change | `PATCH /tasks/:id` with `assignee`; human assignee also blocks |
| Add blocked-by task | Kanban link API with parent ID |
| Remove blocked-by task | Kanban unlink API |
| Add blocking task | Kanban link API with child ID |
| Comment | Comment API |
| Archive | Archive API or `PATCH status=archived` if supported |
| Delete | Delete API, then remove or archive mirror |

After every accepted action, TaskNotes refreshes the mirror note from Hermes detail response.

## Modal MVP

The Hermes-aware edit modal should include:

- Native TaskNotes title/details controls.
- Status controls using Hermes status vocabulary.
- Board display derived from path.
- Assignee field.
- Blocked By section using native TaskNotes dependency cards.
- Blocking section using inverse native dependency cards and/or Hermes API child links.
- Comments section with native-looking cards and an Add comment button.
- Worker Log section.
- Run History section.
- Events section.

Comments, worker logs, run history, and events are displayed from Hermes API response and are not written into mirror note body.

## Error Handling

- If Hermes API call fails, keep local mirror unchanged and show a clear notice.
- If refresh fails after a successful mutation, show “Hermes accepted action, mirror refresh failed” and offer manual refresh.
- If identity cannot be derived from path, disable Hermes actions and show “Not a Hermes mirror note.”
- If a status is disallowed by Hermes, show Hermes error text.
- Use idempotency keys on creation to avoid duplicate cards after retries.

## MVP Acceptance Criteria

- Creating a task with a Hermes board selected creates the task in Hermes first.
- A successful create writes a native mirror note under `TaskNotes/Hermes/<board>/<task-id>.md`.
- Mirror notes contain no `hermes_*`, `sync_*`, `blocked_by`, `blocks`, or writeback fields.
- Mirror note body contains only the Hermes task body.
- Status changes in TaskNotes call Hermes API and refresh the mirror note.
- The Hermes status values available in TaskNotes match Hermes kanban values.
- `assignee` exists as a TaskNotes-visible property.
- Setting `assignee` to a human value blocks the Hermes task with a clear block reason.
- Adding/removing blockers from TaskNotes updates Hermes links via API.
- Comments can be added from the modal and appear after refresh.
- Archive/delete actions call Hermes before changing the local mirror.
- Failed API calls do not silently mutate mirror notes.
- Existing focused Hermes unit tests pass.

## Implementation Phases

### Phase 1: Contract Stabilization

- Keep mirror notes native-only.
- Derive identity from path.
- Add regression coverage for no custom Hermes fields.
- Add `assignee` as a user-visible TaskNotes field.

### Phase 2: API-First Mutations

- Route title/body/status/priority changes through Hermes API.
- Refresh mirrors after accepted updates.
- Add clear failure notices.
- Use idempotency keys for create.

### Phase 3: Assignee and Human Blocking

- Implement human/agent assignee classification.
- On human assignment, block task in Hermes.
- On agent assignment, update assignee and optionally return to ready/triage.
- Add tests for human blocking behavior.

### Phase 4: Dependencies and Activity

- Convert blocked-by/blocking UI actions to Hermes link/unlink calls.
- Render comments, worker log, run history, and events as native-feeling TaskNotes cards.
- Keep activity read-only except comments.

### Phase 5: End-to-End Verification

- Test create, update, status change, human block, agent unblock, comment, link, archive, delete.
- Verify Hermes dashboard and TaskNotes views stay in sync.
- Verify no duplicate Hermes task on retry.

## Open Questions

- Should ordinary non-Hermes TaskNotes tasks keep `open`/`none` statuses globally?
- What is the exact Hermes API shape for archive vs delete?
- Should `assignee` be a core fork field or a default custom user field?
- Should human assignment always force blocked, or ask when current status is `done`?
- Should moving from human to agent automatically choose `ready` or preserve prior status?

