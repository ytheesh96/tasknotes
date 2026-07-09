# Hermes Activity Modal Frontmatter PRD

## Summary

The TaskNotes edit modal should render Hermes activity from a native,
frontmatter-backed activity model instead of parsing ad hoc comment text inside
`TaskEditModal`.

The activity model should mirror Hermes' conceptual storage boundaries:

- task identity and indexes live on the TaskNotes task note.
- runs live as linked run notes.
- events live as linked event notes.
- comments live as linked comment notes.
- attachments/artifacts live as linked artifact notes.
- raw metadata and payloads live in raw notes, linked from the relevant activity
  note.

All properties must use flat Obsidian-compatible frontmatter keys. Do not use
nested YAML objects for the core contract, because Obsidian's native Properties
UI does not support nested properties as first-class editable properties.

## Problem

The current Hermes activity area feels unlike TaskNotes:

- It renders a bespoke right-rail DOM instead of reusable modal field
  components.
- Structured run data is surfaced as comment-like cards or raw JSON previews.
- Comments, runs, events, artifacts, and decomposed child tasks blur together.
- The visual language does not reliably reuse TaskNotes task-card behavior,
  hover states, metadata rows, status dots, or dependency expansion.
- The data model is not rich enough in frontmatter, so the modal has to infer too
  much from raw comment bodies at render time.
- The activity rail feels cached/static rather than live, because the UI is not
  clearly backed by changing task/activity properties.

Hermes already models rich activity separately in its local database:

- `tasks`
- `task_runs`
- `task_events`
- `task_comments`
- `task_attachments`
- `task_links`

TaskNotes should preserve that conceptual separation without copying the
database schema 1:1.

## Goals

- Make the Hermes activity area a first-class TaskNotes modal field group.
- Back the activity UI with flat Obsidian frontmatter properties.
- Store rich run/comment/event/artifact data in linked activity notes.
- Keep the root task note compact, readable, and queryable.
- Use native TaskNotes fields for title, details/body, status, priority,
  projects, contexts/assignee, tags, and dependencies.
- Translate Hermes `task_links` into native TaskNotes dependencies through the
  configured TaskNotes field mapper/update path.
- Render run cards with TaskNotes task-card visual language:
  - status dot for run state/signals.
  - metadata row for board/profile/time.
  - badge rail for child tasks, artifacts, and run details.
  - shared hover/highlight behavior.
- Render comment cards as comments, with a profile/avatar affordance rather than
  a task status dot.
- Hide raw JSON by default while preserving access through raw linked notes.
- Support live-feeling updates when Hermes sync writes new frontmatter or linked
  activity notes.

## Non-Goals

- Rebuilding the Hermes dashboard inside the TaskNotes modal.
- Persisting large Hermes `metadata` or event `payload` blobs directly on the
  root task note.
- Inventing Hermes-only parent/child relationship fields for decomposed tasks.
- Hardcoding `blockedBy`, `blocking`, or any user-configurable TaskNotes
  frontmatter key in the Hermes sync layer.
- Requiring nested YAML/object properties in Obsidian frontmatter.
- Making comment cards carry run status semantics.
- Showing raw JSON as the default activity presentation.

## Product Principles

- TaskNotes owns task state.
- Hermes owns execution/runtime state.
- Obsidian properties stay flat and human-editable.
- Linked notes carry rich activity detail.
- TaskNotes-native relationships beat parallel Hermes-only relationship fields.
- Cards should answer "what happened, who did it, what needs attention, and
  where is the evidence?" in one scan.
- Raw data should remain available, but never be the primary UI.

## Users

| User | Need |
| --- | --- |
| Obsidian operator | Understand current task status, blockers, comments, runs, and artifacts from the edit modal. |
| Reviewer | See review-required evidence without reading raw JSON. |
| Agent operator | Inspect run status, signals, artifacts, and decomposed child tasks quickly. |
| TaskNotes power user | Keep custom frontmatter mappings, dependencies, filters, and task-card behavior working. |

## Data Contract

### Root Task Note

The root TaskNotes task note stores normal TaskNotes task fields plus a compact
Hermes identity and activity index.

Example:

```yaml
---
type: task
title: Verify TaskNotes activity modal rendering path and report findings
status: done
priority: normal
projects:
  - Hermes/default
contexts:
  - reviewer-qa

hermesTaskId: t_82f04f0f
hermesCreatedBy: dashboard
hermesWorkspaceKind: scratch
hermesWorkspacePath: /Users/yt/.hermes/kanban/workspaces/t_82f04f0f
hermesCurrentRun: "[[TaskNotes/default/activity/runs/t_82f04f0f-run990|Run 990]]"
hermesLastEvent: "[[TaskNotes/default/activity/events/t_82f04f0f-event10740|completed]]"
hermesLastSyncedAt: 2026-06-04T17:49:08Z
hermesLiveStatus: connected
hermesActivityVersion: 2

hermesActivityFeed:
  - "[[TaskNotes/default/activity/comments/t_82f04f0f-comment10739|Comment]]"
  - "[[TaskNotes/default/activity/runs/t_82f04f0f-run990|Run 990]]"
  - "[[TaskNotes/default/activity/events/t_82f04f0f-event10740|completed]]"

hermesRuns:
  - "[[TaskNotes/default/activity/runs/t_82f04f0f-run990|Run 990]]"
hermesEvents:
  - "[[TaskNotes/default/activity/events/t_82f04f0f-event10740|completed]]"
hermesComments:
  - "[[TaskNotes/default/activity/comments/t_82f04f0f-comment10739|Comment]]"
hermesAttachments:
  - "[[TaskNotes/default/activity/artifacts/t_82f04f0f-report|Report]]"
---
```

Notes:

- Board identity should continue to be derived from the native board path:
  `TaskNotes/<board>/<task-id>.md`.
- `hermesActivityFeed` is the primary ordered index used by the modal.
- `hermesRuns`, `hermesEvents`, `hermesComments`, and `hermesAttachments` are
  secondary indexes for Bases, search, filters, and field configuration.
- `hermesLiveStatus` is display state for the modal, not a replacement for task
  `status`.
- SQLite epoch timestamps from Hermes must be converted to ISO strings before
  writing to Obsidian properties.

### Dependencies From Hermes task_links

Hermes `task_links` represent dependency edges:

```sql
task_links.parent_id = root task
task_links.child_id = decomposed child task
```

TaskNotes should translate those edges into native TaskNotes dependencies.

For the default TaskNotes field mapping, a decomposed root task can look like:

```yaml
blockedBy:
  - uid: "[[TaskNotes/default/t_child1]]"
    reltype: FINISHTOSTART
  - uid: "[[TaskNotes/default/t_child2]]"
    reltype: FINISHTOSTART
```

This example is illustrative only. The Hermes sync implementation must not
hardcode `blockedBy`. It must call TaskNotes' native relationship/update path or
field mapper so custom frontmatter keys continue to work.

Requirements:

- Persist the dependency on the blocked task as TaskNotes `blockedBy`.
- Treat `blocking` as derived unless the TaskNotes core explicitly requires an
  inverse write.
- Preserve human-authored dependencies that are not owned by Hermes.
- When Hermes removes a `task_links` row, remove only the matching Hermes-owned
  dependency edge.
- The branch drawer must read the native TaskNotes dependency graph and render
  real TaskCards for related tasks.

### Run Note

Run notes map closely to Hermes `task_runs`.

Path:

```text
TaskNotes/<board>/activity/runs/<task-id>-run<run-id>.md
```

Example:

```yaml
---
type: hermes-run
hermesTask: "[[TaskNotes/default/t_82f04f0f|t_82f04f0f]]"
hermesTaskId: t_82f04f0f
hermesRunId: 990
hermesRunProfile: reviewer-qa
hermesRunStatus: done
hermesRunOutcome: completed
hermesRunSummary: Completed the TaskNotes activity modal UX smoke verification.
hermesRunStartedAt: 2026-06-04T17:41:48Z
hermesRunEndedAt: 2026-06-04T17:49:08Z
hermesRunLastHeartbeatAt: 2026-06-04T17:48:55Z
hermesRunDurationMs: 440000

hermesRunSignals:
  - "[[TaskNotes/default/activity/events/t_82f04f0f-event10738|claimed]]"
  - "[[TaskNotes/default/activity/events/t_82f04f0f-event10740|completed]]"

hermesRunArtifacts:
  - "[[TaskNotes/default/activity/artifacts/t_82f04f0f-report|Report]]"
hermesRunChangedFiles:
  - src/modals/TaskEditModal.ts
  - styles/task-modal.css

hermesRunVerification: Focused modal tests passed
hermesRunRawMetadata: "[[TaskNotes/default/activity/raw/t_82f04f0f-run990-metadata|Run metadata]]"
---
```

The run note body can contain a human-readable run summary. Raw `metadata` must
go in a linked raw note, not inline frontmatter.

### Event Note

Event notes map to Hermes `task_events`.

Path:

```text
TaskNotes/<board>/activity/events/<task-id>-event<event-id>.md
```

Example:

```yaml
---
type: hermes-event
hermesTask: "[[TaskNotes/default/t_82f04f0f|t_82f04f0f]]"
hermesTaskId: t_82f04f0f
hermesRun: "[[TaskNotes/default/activity/runs/t_82f04f0f-run990|Run 990]]"
hermesRunId: 990
hermesEventId: 10740
hermesEventKind: completed
hermesEventStatus: success
hermesEventLabel: run completed
hermesEventCreatedAt: 2026-06-04T17:49:08Z
hermesEventRawPayload: "[[TaskNotes/default/activity/raw/t_82f04f0f-event10740-payload|Event payload]]"
---
```

The modal should use event notes to populate run signals and compact event rows.
Only important events should appear as top-level timeline entries; noisy
heartbeat/spawn events should be hidden or available only in details.

### Comment Note

Comment notes map to Hermes `task_comments`.

Path:

```text
TaskNotes/<board>/activity/comments/<task-id>-comment<comment-id>.md
```

Example:

```yaml
---
type: hermes-comment
hermesTask: "[[TaskNotes/default/t_82f04f0f|t_82f04f0f]]"
hermesTaskId: t_82f04f0f
hermesCommentId: 10739
hermesCommentAuthor: orchestrator
hermesCommentAvatar: _Artifacts/hermes/agents/orchestrator.png
hermesCommentKind: review
hermesCommentSeverity: warning
hermesCommentPinned: true
hermesCommentCreatedAt: 2026-06-04T17:48:30Z
hermesLinkedRun: "[[TaskNotes/default/activity/runs/t_82f04f0f-run990|Run 990]]"
---
```

Body:

```md
Review handoff is ready. Raw JSON is preserved, structured cards render cleanly,
and run evidence is attached below.
```

The modal should render comment notes as comment cards with a profile/avatar
area, author metadata, body text, and optional links. Comment cards should not
pretend to be run cards.

### Attachment / Artifact Note

Artifact notes map to Hermes `task_attachments` plus generated run artifacts.

Path:

```text
TaskNotes/<board>/activity/artifacts/<task-id>-<artifact-slug>.md
```

Example:

```yaml
---
type: hermes-artifact
hermesTask: "[[TaskNotes/default/t_82f04f0f|t_82f04f0f]]"
hermesTaskId: t_82f04f0f
hermesSourceRun: "[[TaskNotes/default/activity/runs/t_82f04f0f-run990|Run 990]]"
hermesAttachmentId: 441
hermesArtifactKind: report
hermesArtifactLabel: Review report
hermesArtifactFilename: review-report.md
hermesArtifactStoredPath: _Artifacts/hermes/t_82f04f0f/review-report.md
hermesArtifactContentType: text/markdown
hermesArtifactSize: 4812
hermesArtifactUploadedBy: reviewer-qa
hermesArtifactCreatedAt: 2026-06-04T17:49:08Z
---
```

The artifact drawer should show compact rows for linked artifacts, not inline
path buttons in the main card body.

### Raw Note

Raw notes store large JSON payloads and metadata.

Path:

```text
TaskNotes/<board>/activity/raw/<task-id>-<source>-<kind>.md
```

Example body:

````md
```json
{
  "changed_files": ["src/modals/TaskEditModal.ts"],
  "tests_run": ["focused modal tests"],
  "verification": "Focused modal tests passed"
}
```
````

Raw notes should be linked from run/event/comment notes through explicit
`hermesRunRawMetadata`, `hermesEventRawPayload`, or equivalent fields.

## Modal Components

### HermesActivityField

Frontmatter-backed modal field renderer for the activity group.

Responsibilities:

- Read `hermesActivityFeed` from the root task note.
- Resolve linked activity notes and their frontmatter.
- Sort by activity timestamps when explicit ordering is missing.
- Render typed cards by note `type`.
- Re-render when the root task or linked activity note metadata changes.
- Show live status from `hermesLiveStatus` and `hermesLastSyncedAt`.
- Show a compact empty/degraded state when Hermes is offline or no activity
  exists.

### HermesRunCard

Represents a `type: hermes-run` note.

Required UI:

- TaskCard-like shell and hover behavior.
- Status dot derived from `hermesRunStatus` / `hermesRunOutcome`.
- Clicking the status dot opens the signals drawer.
- Metadata row:
  - `+Hermes/<board>`
  - `@<hermesRunProfile>`
  - relative time from `hermesRunEndedAt` or `hermesRunStartedAt`
- Main body from `hermesRunSummary`.
- Badge rail:
  - branch icon: native dependency drawer for decomposed child tasks.
  - paperclip/file icon: artifacts drawer.
  - terminal/activity icon: run details drawer.
- No inline artifact button pile in the main card body.

### HermesSignalsDrawer

Backed by `hermesRunSignals` linked event notes.

Shows:

- signal label.
- status color.
- relative timestamp.
- optional source event kind.

Default max visible rows should be small. Full details can live behind the run
details drawer or raw event links.

### HermesArtifactsDrawer

Backed by `hermesRunArtifacts` and linked artifact notes.

Shows:

- icon by kind/content type.
- artifact label or filename.
- short subtitle from kind/path/source run.
- action to open the artifact target.

### HermesRunDetailsDrawer

Backed by run note frontmatter.

Shows:

- run id.
- profile.
- status/outcome.
- duration.
- verification.
- changed files.
- raw metadata link.

### HermesCommentCard

Represents a `type: hermes-comment` note.

Required UI:

- Profile/avatar icon on the left, vertically centered relative to the comment
  body.
- Author/time metadata.
- Comment body from note markdown body.
- Optional pinned/review severity chips.
- Optional linked run/artifact affordances.
- No run status dot unless the comment is explicitly transformed into a system
  event card.

### HermesEventRow

Represents selected `type: hermes-event` notes.

Use as:

- signal rows inside run cards.
- compact timeline entries for important task-level events.

Do not render every event as a full card by default.

### HermesLiveStatusField

Small status component backed by:

- `hermesLiveStatus`
- `hermesLastSyncedAt`
- current API availability, when available.

States:

- connected
- syncing
- degraded
- disconnected
- cache-only

This component should make the activity rail feel alive without replacing the
task's actual status.

## Sync Requirements

### Activity Sync

Hermes activity sync should:

1. Fetch or receive Hermes task details.
2. Ensure the root TaskNotes task note exists.
3. Write/update run notes for `task_runs`.
4. Write/update event notes for `task_events`.
5. Write/update comment notes for `task_comments`.
6. Write/update artifact notes for `task_attachments` and generated artifacts.
7. Write raw notes for large `metadata` and `payload` values.
8. Update root task indexes:
   - `hermesCurrentRun`
   - `hermesLastEvent`
   - `hermesActivityFeed`
   - `hermesRuns`
   - `hermesEvents`
   - `hermesComments`
   - `hermesAttachments`
   - `hermesLastSyncedAt`
   - `hermesLiveStatus`

Updates must be idempotent. Replaying the same Hermes rows should not duplicate
activity links.

### Relationship Sync

Hermes `task_links` sync should:

- Resolve parent and child Hermes task IDs to TaskNotes task paths.
- For each parent/root task, update its native TaskNotes `blockedBy`
  dependencies to include decomposed child tasks.
- Use TaskNotes' field mapper/update path, not hardcoded frontmatter keys.
- Preserve non-Hermes dependency entries.
- Remove only Hermes-owned dependency edges when Hermes removes task links.
- Let TaskNotes derive reverse `blocking` relationships.

### Ownership Marking For Synced Dependency Edges

Because TaskNotes dependencies are user-editable, the sync needs a way to know
which edges it owns.

Preferred approach:

- Maintain an internal sync state keyed by Hermes `task_links` rows and resolved
  TaskNotes paths.
- Do not expose Hermes-owned edge markers in normal task frontmatter unless
  necessary.

Fallback, only if internal state is insufficient:

```yaml
hermesDependencyEdges:
  - t_parent1->t_child1
  - t_parent1->t_child2
```

This fallback field is an implementation aid only. The modal must not use it as
the dependency graph source.

## UX Requirements

### Activity Pane

The right rail should show:

1. Live status snapshot.
2. Pinned comment/handoff when present.
3. Recent run cards.
4. Recent comment cards.
5. Selected important event rows.
6. Sticky comment composer when comments are enabled.

The pane should not show raw JSON by default.

### Run Cards

Run cards must answer:

- What happened?
- Which profile/agent ran?
- What is the current run state?
- Are there child tasks?
- Are there artifacts?
- Where are the run details?

### Comment Cards

Comment cards must feel conversational:

- Profile/avatar first.
- Body text is the main content.
- Metadata is secondary.
- Attachments and linked run references are optional affordances.

### Branch Drawer

The branch drawer must use the native TaskNotes dependency graph and render real
TaskCards for dependent tasks.

### Composer

The comment composer should:

- Use a quiet TaskNotes-native input style.
- Stick near the bottom of the activity pane.
- Use an icon send button.
- Submit to Hermes when live.
- Fall back to disabled/cache-only state when disconnected.

## Acceptance Criteria

- A Hermes task note with `hermesActivityFeed` renders a typed activity timeline.
- A `hermes-run` linked note renders as a TaskCard-like run card with:
  - status dot.
  - metadata row.
  - signals drawer.
  - artifacts drawer.
  - run details drawer.
- A `hermes-comment` linked note renders as a comment card with profile/avatar,
  metadata, and body text.
- Raw JSON is hidden behind linked raw notes or explicit raw controls.
- Hermes `task_links` produce native TaskNotes dependency UI.
- The branch drawer renders real TaskCards from TaskNotes dependencies.
- Custom TaskNotes field mappings for dependencies are respected.
- Existing user-authored dependencies survive Hermes sync.
- Re-running sync does not duplicate activity links or dependency entries.
- Disconnected/cache-only activity still renders from frontmatter.
- Non-Hermes task modals keep existing behavior.

## Test Plan

### Unit Tests

- Frontmatter builder writes flat root activity properties.
- Frontmatter builder writes run/event/comment/artifact notes with flat keys.
- Activity feed normalization dedupes links and preserves ordering.
- Timestamp conversion from Hermes epoch integers produces ISO strings.
- Run card model derives status variant, metadata, signals, artifacts, and
  details from run note frontmatter.
- Comment card model derives author, avatar, pinned state, severity, and body.
- `task_links` sync computes TaskNotes `blockedBy` updates through the field
  mapper.
- Relationship sync preserves non-Hermes dependency entries.
- Relationship sync removes only Hermes-owned edges.

### Modal Render Tests

- Activity field renders run cards, comment cards, and event rows from linked
  activity notes.
- Run status dot opens the signals drawer.
- Branch icon opens native dependency TaskCards.
- Artifact icon opens artifact drawer.
- Details icon opens run details drawer.
- Comment cards use profile/avatar layout and no run status dot.
- Empty/degraded/cache-only states render without throwing.

### Integration / Smoke Tests

- Create or sync a decomposed Hermes root task.
- Verify root task has native TaskNotes dependencies pointing to child tasks.
- Open root task modal.
- Verify branch drawer shows child TaskCards with normal hover/highlight and
  metadata behavior.
- Add a Hermes run with artifacts/events/comments.
- Verify activity rail updates after sync without closing the modal.
- Disconnect Hermes and verify cached frontmatter activity remains readable.

## Open Questions

- Should `hermesActivityFeed` include only comments/runs/important events, or all
  event notes with UI filtering?
- Should generated activity notes be visible in normal Obsidian search by
  default, or marked with tags/properties that make hiding easy?
- Is internal sync state sufficient for Hermes-owned dependency edge tracking, or
  do we need a flat helper field on the task note?
- Should agent avatars be stored as vault paths, URLs, or resolved from a
  separate agent roster note?
- Should `hermesBoard` be written as a convenience index, or should all board
  identity be derived from path plus `projects`?

## Implementation Notes

- Use `TaskNotes/<board>/activity/...` paths for generated activity notes.
- Use flat `hermes*` property names for Hermes-specific metadata.
- Use existing TaskNotes field mapping for native task fields.
- Keep activity note bodies human-readable.
- Keep raw JSON in raw notes.
- Avoid adding modal-specific parsing rules that cannot be represented by the
  frontmatter model.
