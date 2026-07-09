# Hermes Review Thread UI Mapping for TaskEditModal

## Scope

This spec defines the Hermes-only right rail for `TaskEditModal`. It applies only when `getHermesTaskIdentity(task)` returns `{ board, id }` for a native board note path like `TaskNotes/<board>/<task-id>.md`.

Non-Hermes tasks must keep the existing TaskNotes edit modal behavior: no review-thread rail, no Hermes status snapshot, no Hermes activity API calls, and no changed placement for ordinary details, comments, completions, or metadata sections.

Design inputs used: local mockup `.ops/mockups/task-update-redesign.html`, image concept `.ops/mockups/task-update-chat-imagegen.png`, and prior design card `t_aa60dc8d`. Do not modify or commit `.ops` assets as part of implementing this spec.

## UX intent

The rail should answer, in order:

1. Why is this task blocked or waiting for review?
2. What did the latest agent run hand off?
3. What should the human or next agent open next: Agent Shell, artifact, linked task, or raw details?
4. What is the recent conversation and status timeline?
5. Where can I find the full run/event history if I need debugging depth?

The rail is a compact review thread, not a JSON/event dump.

## Layout

Use the existing split-layout architecture:

- Left column: editable TaskNotes fields and compact task controls.
- Right column: Hermes review thread and secondary history.

For Hermes tasks with split layout enabled, the right column should be active even if ordinary TaskNotes read-only content would otherwise be empty. Use/extend the current `modal-split-right--with-readonly` pattern.

Suggested right-rail order:

1. Header row: `Review thread` title, optional `Show full run log` action.
2. Pinned review/handoff card, only when a review-required or blocked handoff exists.
3. Latest run status strip, if run data exists.
4. Chat/event thread: recent comments plus selected important system events.
5. Composer: add comment input.
6. Collapsed secondary sections: run history and events.

## Data sources

Fetch `HermesTaskDetailResponse` via `HermesKanbanApiClient.getTask(identity)` and render from:

- `detail.task`: title/body/status/assignee/priority/result/latest_summary/metadata.
- `detail.comments`: author/body/created_at.
- `detail.runs`: id/profile/status/outcome/summary/error/started_at/ended_at/metadata when available.
- `detail.events`: kind/payload/created_at/run_id.
- `detail.links.parents`: blocked-by task ids.
- `detail.links.children`: blocking task ids.

Keep the existing markdown fallback sections (`Latest Comment`, `Latest Event`) only as initial placeholders before API data arrives or if the API call fails.

## Left-column compact controls

The left column should show a compact Hermes status snapshot above the title field.

Required controls:

- Status chip: current task status with color. Blocked/review statuses use red/yellow emphasis.
- Board chip: board slug from identity; opens existing board-change affordance if implemented, otherwise disabled with tooltip.
- Assignee chip: avatar initials plus assignee; opens existing assignee picker.
- Blocked by counter: count from `links.parents` or local `blockedByItems`; clicking scrolls/focuses Blocked by section.
- Comment counter: count from `detail.comments`; clicking scrolls/focuses right rail.
- Event counter: count from `detail.events`; clicking expands Events section.
- Agent Shell action: shown when the latest run has an id/session handle or when the current implementation can route to the run/session. If not available, omit rather than showing a dead button.

For blocked/review-required tasks, the first row should include a one-line reason next to the status chip, e.g. `Review required before merge`, `Blocked: waiting on t_123`, or the first sentence of the latest review-required handoff.

## Right-rail components

### 1. Header

Render:

- Title: `Review thread`.
- Small count metadata when useful: `3 comments · 2 runs · 8 events`.
- Optional action: `Show full run log` or `Show all history`.

The action should expand the collapsed run/event history inside the modal. It should not open raw JSON directly.

### 2. Pinned review/handoff card

Show this first for review-required or blocked tasks.

Trigger conditions, in priority order:

1. Latest comment body starts with `review-required` or contains `review-required handoff`.
2. Latest block reason/event payload starts with `review-required:`.
3. Task status is `blocked` and latest run summary/error exists.
4. Latest completed run has outcome/status indicating blocked, failed, crashed, timed out, or review.

Visual treatment:

- Card label: `PINNED` above the card.
- Soft red/yellow tint and left border for blocked/review-required.
- Avatar, author, relative time on the first line.
- Status badge on the right: `Review required`, `Blocked`, `Failed`, or `Needs input`.
- Bold title derived from the handoff: first short heading/sentence, stripped of `review-required:` prefix.
- Body preview: 1-3 concise lines; preserve code spans, task ids, and artifact names.
- Actions row:
  - `Open in Agent Shell` if a run/session target exists.
  - `Resume from handoff` only if an actual board action exists; otherwise omit.
  - Artifact/task links extracted from metadata/body.
  - `View raw` as a low-emphasis affordance.

Do not display a JSON blob by default. If a review-required comment is JSON or contains JSON after a prose prefix, summarize top fields first:

- `changed_files`: show `N changed files` and first 1-2 basenames.
- `tests_run` / `tests_passed`: show `14/14 tests passed`.
- `diff_path` / `pr_url` / `artifacts`: show links.
- `decisions`: show first decision sentence.
- Any remaining payload: hidden behind `View raw`.

### 3. Latest run status strip

Below the pinned card, render a horizontal compact status row when `runs.length > 0`.

Segments:

- Outcome/status chip: `Running`, `Completed`, `Blocked`, `Timed out`, `Crashed`, `Failed`, `Review required`.
- Verification chip, derived from run metadata or summary:
  - `all checks passed`
  - `partial verification`
  - `not verified`
  - `verification blocked`
- Run id/profile/time segment: `Run 125 · peacock · 11 mins ago`.

Color rules:

- green: completed with passed verification.
- yellow: partial verification, review, or running.
- red: blocked, crashed, failed, timed out.
- muted: unknown/no summary.

Each segment can be a chip/row, but the whole strip should stay under two lines at 360px rail width.

### 4. Chat-like comment cards

All Hermes comments should look like a conversation thread.

Card anatomy:

- Avatar: circular initials or role icon.
  - agent/profile authors: initials from `author`.
  - `system`/event pseudo-cards: gear icon.
  - `tasknotes`: local/user-style avatar.
- Header: author name + relative timestamp.
- Body: rendered plain text/markdown-lite with safe code spans and links.
- Optional status badge if the comment is classified as review-required, blocker, handoff, or user comment.
- Optional attachments/artifacts block below body.

Classification:

- `review-required`: body starts with `review-required`, `review-required handoff`, or contains structured handoff metadata with that status.
- `agent handoff`: body contains `handoff`, `summary`, `changed_files`, `tests_run`, `diff_path`, or was written by an agent at run completion/block time.
- `human comment`: author is `tasknotes`, `yt`, `user`, or does not match a known worker profile.
- `system`: generated from selected event rows, not from comments.

Default visible comments:

- Always show pinned card separately if applicable.
- Then show the latest 5 meaningful thread entries, newest at bottom, preserving chronological chat flow.
- If there are more than 5, show `Show earlier activity (N)` above the visible thread.

### 5. Artifact links

Artifacts should be visible as compact attachment cards, not raw paths.

Sources:

- `event.payload.artifacts`, `event.payload.changed_files`, `event.payload.diff_path`, `event.payload.working_files`, `event.payload.file/path`.
- Run metadata fields with the same keys.
- Comment JSON/prose containing absolute paths, vault paths, URLs, or known file extensions.

Attachment card fields:

- Icon by extension or generic file icon.
- Label: basename, e.g. `goal-mode-sync-qa-report.md`.
- Subtitle: short context such as `QA summary`, `diff path`, `changed file`, or `artifact`.
- Button/link: `Open`.

Opening behavior must reuse existing `plugin.openHermesArtifactPath(path)` so vault paths, absolute paths, file URLs, and web URLs behave consistently with current artifact-opening logic.

### 6. System event cards

Do not render every event as a full card by default.

Promote only high-signal events into the visible thread:

- `claimed` / `spawned` / `started`: compact `Run started` system row.
- `blocked`: compact `Blocked` system row with reason, status chip, and run id.
- `completed`: compact `Completed` system row with summary and artifacts if present.
- `commented`: skip if the actual comment is already rendered.
- `heartbeat`: hide from the primary thread unless it is the only recent activity for a long-running task.
- `created` / `promoted`: hide from primary thread; keep in Events history.

System event card anatomy:

- small gear icon/avatar.
- title: `Run started`, `Blocked`, `Completed`, `Timed out`, etc.
- one-line summary.
- relative timestamp aligned right or in metadata.
- optional chip: `Blocked`, `Review required`, `Run 125`.

### 7. Collapsed run history

Run history is secondary and should be collapsed by default when a pinned card or thread exists.

Collapsed header:

- `Run history`.
- Count: `3`.
- Latest state chip.
- `Show all` toggle.

Expanded rows:

- One compact row per run, newest first.
- Fields: run id, profile, outcome/status, start/end relative time, short summary/error.
- Actions: `Open in Agent Shell` when available, `Copy handoff` if summary/metadata exists, `View raw`.

Default visible count when expanded: latest 3; `Show all` reveals all available runs.

### 8. Collapsed events history

Events are debugging detail. Keep them collapsed below run history.

Collapsed header:

- `Events`.
- Count.
- Latest event label/time.
- `Show` toggle.

Expanded rows:

- Use the existing compact `HermesActivityCard` style.
- Summarize payload fields via current helper logic.
- Hide nested/large payloads behind `View raw`.
- Never show unformatted JSON as the row title.

## Raw JSON / raw payload affordance

Raw JSON should be available but never the default reading experience.

Use a `View raw` affordance on cards with structured payloads. On click:

- Expand inline below the card, or open a small modal/popover if inline would be too large.
- Show pretty-printed JSON in monospace.
- Include `Copy raw`.
- Collapse with `Hide raw`.

For long raw payloads, cap inline height and scroll inside the raw area.

## Empty and loading states

- While loading API detail, show local/fallback latest comment/event cards if available plus subtle `Loading Hermes activity...` text.
- If API fails, keep fallback cards and show a muted warning: `Could not load live Hermes activity.` Do not break normal modal editing.
- If no comments/runs/events exist, show a compact empty state: `No review activity yet.` plus the comment composer.

## What shows first by task state

### Blocked task

First visible content in the right rail:

1. Pinned blocker/review card with the block reason or latest blocked run summary.
2. Latest run status strip.
3. Most recent human/agent comments.
4. Collapsed history.

The user should not need to expand Events to learn why the task is blocked.

### Review-required task

First visible content:

1. Pinned `Review required` handoff card summarizing changed files, verification, artifact/diff link, and decision needed.
2. Latest run status strip showing verification status.
3. Comment composer so the reviewer can respond immediately.
4. Recent thread entries and collapsed history.

The review card should be visually stronger than normal comments but less disruptive than a modal alert.

### Running task

First visible content:

1. Latest run status strip with `Running` chip and elapsed/started time.
2. Latest heartbeat only if no richer run/comment content exists.
3. Recent comments.
4. Collapsed history.

### Done task

First visible content:

1. Latest completion summary card if available.
2. Artifact attachment cards from completion metadata.
3. Recent comments.
4. Collapsed history.

## Implementation notes for `TaskEditModal`

The current implementation already has useful helpers for normalization, relative timestamps, event summarization, artifact detection, and artifact/task actions. Reuse them, but reshape the presentation.

Recommended refactor:

1. Replace the generic `Comments`, `Run history`, and `Events` sections in `createHermesActivitySections` with one `tn-task-modal__hermes-review-thread` section in the right column.
2. Keep the comment composer in the right rail, not the left details column.
3. Build a derived view model from `HermesTaskDetailResponse`:
   - `pinnedReviewCard?: ReviewThreadCard`
   - `latestRunStatus?: RunStatusStripModel`
   - `threadEntries: ReviewThreadEntry[]`
   - `runHistory: RunHistoryRow[]`
   - `eventHistory: EventHistoryRow[]`
4. Extend `HermesRunCard` to accept optional `metadata?: Record<string, unknown>` so run-level artifacts/checks can render.
5. Add card variants/classes rather than overloading `task-card` only:
   - `tn-task-modal__hermes-review-thread`
   - `tn-task-modal__hermes-pinned-review-card`
   - `tn-task-modal__hermes-run-status-strip`
   - `tn-task-modal__hermes-thread-card`
   - `tn-task-modal__hermes-system-event-row`
   - `tn-task-modal__hermes-artifact-card`
   - `tn-task-modal__hermes-history-section--collapsed`
   - `tn-task-modal__hermes-raw-toggle`
6. Keep `renderHermesActivityCardItem` or a successor for collapsed history rows, but use a separate renderer for chat cards so comments get avatar/header/body hierarchy.
7. Preserve keyboard accessibility:
   - expandable cards: `role="button"`, `tabIndex=0`, Enter/Space toggles.
   - raw toggles: real `button` elements with `aria-expanded`.
   - collapsed history sections: real `button` headers or buttons in headers.
8. Keep actions side-effect safe: artifact opens use `openHermesArtifactPath`; task links use `openHermesTaskEditModalById`; comments use existing `addComment` API flow.

## Suggested parser rules

### Review/handoff title extraction

Given a comment or summary string:

1. Trim whitespace.
2. Remove leading labels: `review-required handoff:`, `review-required:`, `blocked:`, `handoff:`.
3. If markdown heading exists, use first heading text.
4. Else use first sentence up to 120 characters.
5. Fallback: `Review required` or `Latest handoff`.

### Structured handoff extraction

If body contains JSON after a prefix, try parsing the first balanced object. If parsing fails, keep the prose preview and expose full body behind `View raw`.

Recognized structured fields:

- `changed_files`: artifact/file chips.
- `tests_run`, `tests_passed`: verification chip.
- `verification`: verification summary list.
- `decisions`: compact decision bullets.
- `artifacts`, `diff_path`, `pr_url`: attachment/actions.
- `summary`, `result`, `error`: primary body text.

### Verification label

Derive in this order:

1. If metadata has `tests_run` and `tests_passed` equal: `all checks passed`.
2. If metadata/test summary says partial/skipped/blocked: `partial verification` or `verification blocked`.
3. If summary mentions tests/build/typecheck/lint pass: `checks passed`.
4. If no evidence: `not verified`.

## Acceptance criteria for implementation

- Non-Hermes TaskEditModal behavior is unchanged.
- Hermes tasks render a right rail titled `Review thread` when split layout is available.
- Comments render as chat-like cards with avatar, author, relative time, and body.
- Review-required/blocker handoffs are pinned above normal thread content.
- Blocked and review-required tasks show the reason/handoff before raw events or run history.
- Latest run status appears as compact chips/row, not a dense prose card.
- Artifact links render as attachment cards and call `openHermesArtifactPath`.
- Run history and Events are collapsed secondary sections by default.
- Raw JSON/payloads are hidden behind `View raw` / `Hide raw` with `Copy raw`.
- Existing expand-on-card-click behavior remains available for long history rows.
- Loading/API failure states do not block editing or normal modal actions.
- Unit tests cover: non-Hermes no-op, right-rail placement, pinned review card, comment card anatomy, artifact action, collapsed histories, and view-raw toggle.
