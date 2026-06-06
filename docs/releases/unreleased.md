# TaskNotes - Unreleased

<!--

**Added** for new features.
**Changed** for changes in existing functionality.
**Deprecated** for soon-to-be removed features.
**Removed** for now removed features.
**Fixed** for any bug fixes.
**Security** in case of vulnerabilities.

Always acknowledge contributors and those who report issues.

Example:

```
## Fixed

- (#768) Fixed calendar view appearing empty in week and day views due to invalid time configuration values
  - Added time validation in settings UI with proper error messages and debouncing
  - Prevents "Cannot read properties of null (reading 'years')" error from FullCalendar
  - Thanks to @userhandle for reporting and help debugging
```

-->

## Added

- Added Kanban column and swimlane header checkboxes for selecting or clearing all visible tasks in that column or column/swimlane section.
- Added a Hermes availability service for the TaskNotes modal that checks localhost dashboard/API health, reports cache-only/read-only modes, and supports desktop-only startup with the safe localhost dashboard command.
- Added Hermes task edit modal availability indicators, cache-only labeling, disabled live controls when disconnected, and Start Hermes/Recheck actions that reload live board data after startup.
- Added implementation notes for Hermes availability states, cache-only labels, desktop startup behavior, and unavailable/startup failure copy in the TaskNotes modal.
- Added a `TaskNotes: Create goal task` command that opens the normal task creation modal with the `goal` tag prefilled.
- Added #goal TaskNote sync so eligible notes can create Hermes Goal Mode cards with source-note idempotency and Hermes sync metadata backfilled after successful card creation.
- Added a configurable `TaskNotes: Start Hermes` command, settings controls, and optional auto-start after Hermes-linked task note changes.
- Added an Activity group in Modal Fields so Hermes comments, runs, events, artifacts, and changed files can be enabled or disabled independently.
- Added a TaskNotes Agent Roster Bases view for reviewing agent queues and opening delegated Hermes task submissions from grouped roster cards.
- Added a dedicated Hermes Boards Bases view for creating, refreshing, opening, and deleting Hermes boards, including local mirror cleanup after a board is archived through Hermes.
- Added dry-run Hermes canonical migration/backfill tooling that inventories legacy mirrors, duplicate and orphan candidates, property backfills, and non-destructive activity relocation plans before any writes are enabled.
- Added a Kanban CLI-backed Hermes task creation transport for TaskNotes submissions when the dashboard API is not the selected write path, with concise transport setup and troubleshooting documentation.
- Added Hermes run swimlanes in Kanban bases with run headers, expanded/collapsed states, status-aligned collapsed counts, and visible No run/Unknown run copy, selectable through the existing Kanban grouping controls rather than a separate generated Runs view.
- Added Hermes run swimlane rollout guidance covering safe rollback, conservative backfill, v1 explicit reassignment semantics, and non-regression coverage expectations.

## Changed

- Redesigned the Hermes section of the task edit modal as a review-thread activity rail with pinned handoffs, chat-style comments, compact run status chips, artifact links, and inline status updates while preserving the existing TaskNotes editing experience.
- Updated the Hermes TaskNotes API and webhook sync PRD for the dashboardless architecture, with TaskNotes HTTP API reads as authoritative, webhooks as wake-up signals, board-qualified `hermesBoard`/`hermesTaskId` identity, and legacy dashboard sync documented as a gated fallback.
- Added a Hermes managed write guard PRD that defines read-only cache behavior and live-Hermes requirements for board task creation and editing.
- Changed Hermes-managed task creation and editing so board writes are blocked while Hermes is disconnected, starting, or degraded.
- Refined the Hermes task edit modal so the review comment Send button sits inside the composer, Hermes live status appears as a compact indicator, status updates appear inside the review thread, and the task information footer is hidden.
- Pinned the Hermes review comment composer to the bottom of the activity rail so only the review cards scroll, with a cleaner composer treatment for writing comments.
- Updated the Hermes task edit modal so Hermes-managed titles display as read-only context, comment cards use avatar-style author rows, and run/activity cards expose status signals from the right-side status dot instead of duplicate status pills.
- Rendered Hermes run history as distinct run cards with right-side status, artifact, and details rails, including artifacts discovered from run metadata.
- Kept pinned Hermes review comments as clean authored previews, with raw payloads and artifact evidence available from the detail dialog instead of inline in the activity rail.
- Backed Hermes activity with a primary `hermesActivityFeed` index and linked run, comment, event, artifact, and raw payload notes so cached task modals can render richer activity without showing raw JSON by default.
- Reworked the Hermes activity rail to reuse TaskNotes task-card rows and standard modal form controls, with board, agent, time, and status metadata visible on comments and status updates.
- Removed the extra title row from Hermes activity cards so review labels and status appear in the metadata line instead of a separate header.
- Removed duplicate child-task action buttons from Hermes activity cards when the child-task toggle already exposes those tasks as TaskNotes cards.
- Moved Hermes activity metadata below the activity summary and placed child-task toggles in the task-card badge area.
- Matched Hermes activity row hover and focus highlighting to TaskNotes task cards.
- Changed the Hermes task edit modal to autosave supported status/priority/assignee/dependency edits through TaskNotes, leaving Hermes to consume those changes through the API/webhook sync path.
- Added Hermes Board and Assignee controls to task edit and creation modal top icon rows so routing metadata is visible beside status, priority, dates, recurrence, and reminders without duplicate fields below the title area.
- Tightened Hermes review-thread spacing so status updates use compact log rows with round indicators, structured review/handoff cards show collapsed previews that open full detail dialogs, rely on the left-edge severity color instead of duplicate badges, and place the newest visible activity closest to the comment composer.
- Rendered Hermes handoff and review-required thread comments as compact structured cards with readable status chips, artifact actions, and a low-emphasis View raw affordance instead of showing raw JSON by default.
- Added a focused Hermes comment parser/presentation-model layer so review-thread comments with fenced JSON, prefixed prose, malformed payloads, or handoff metadata render as structured activity instead of raw JSON.
- Replaced the Hermes task edit footer archive/delete controls with a single TaskNotes-backed Block/Unblock status button and moved the Hermes live availability indicator into the footer.
- Synced Hermes review-thread activity into plain reusable TaskNote frontmatter fields such as `comments`, `runs`, `events`, `artifacts`, and `changedFiles`, using the task note as a linked index into `activity/comments`, `activity/runs`, and `activity/events` notes that hold the detailed activity frontmatter.
- Treat TaskNotes board folders as the native kanban control panel, using `TaskNotes/<board>/<task-id>.md` for board identity and removing empty Hermes-only modal field groups from settings.
- Shifted the Hermes MVP toward TaskNotes-owned task state by defaulting board task creation and property updates back through TaskNotes, leaving Hermes to consume changes through the HTTP API and webhooks.
- Improved Hermes Goal Mode card creation duplicate-submit and partial-success handling with in-flight submit disabling, stable create idempotency keys, and notices that name the existing card when post-create sync is incomplete.
- Simplified modal field handling so Activity fields are part of the shared TaskNotes Modal Fields configuration and edit modals no longer use a separate Hermes field layout.
- Changed generated Hermes board Kanban surfaces to add board-specific views to the shared `TaskNotes/Views/kanban-default.base` file instead of creating a separate `.base` file for each board.
- Changed generated Hermes board Bases views to filter on canonical `hermesTaskId` and `hermesBoard` properties, with Hermes archived-task visibility controlled by the TaskNotes Kanban view's new archived-task toggle instead of separate archive views.

## Fixed

- Fixed Hermes TaskNotes canonical paths so task mirrors and activity notes use `TaskNotes/Tasks/<board>--<task-id>.md` and `TaskNotes/Activity/<board>--<task-id>/...`, preventing two boards with the same Hermes task id from sharing the same mirror path and preserving safe migration reporting for older unqualified notes.
- Fixed Hermes mirror sync no-op churn by preserving existing stable mirror timestamps when cache metadata is missing, so unchanged periodic reconciles no longer rewrite TaskNotes mirror/activity files.
- Fixed TaskNotes Kanban Bases refreshes so debounced data updates cannot patch card DOM after a drag or post-drop suppression starts.
- Fixed Hermes run swimlane drag/drop so dropping onto an existing task card obeys the same explicit-only cross-run reassignment guard as dropping onto an empty lane.
- Fixed Hermes canonical sync metadata handling so TaskNotes reads legacy snake_case Hermes frontmatter aliases during migration while continuing to write camelCase `hermesTaskId`, `hermesBoard`, and `hermesArchived` fields in canonical board-qualified mirrors.
- Blocked unsupported local edits that move an existing Hermes-managed TaskNote from one `hermesBoard` to another until Hermes exposes an API-backed board move.
- Fixed Hermes activity migration planning so legacy per-board activity notes are inventoried by `hermesTaskId`, backfilled non-destructively into canonical board-qualified activity folders, and deduplicated against existing canonical activity notes.
- Fixed Hermes managed-task sync so active boards with no existing local TaskNotes mirrors are bootstrapped from the live Hermes board list, allowing developer-board tasks to appear in TaskNotes Kanban again without affecting existing board mirrors.
- Fixed Modal Fields settings so duplicated persisted Hermes activity fields are cleaned up on load and during Field Manager initialization, preventing duplicate draggable Activity cards from reappearing after settings refreshes or reorders.
- Fixed TaskNotes Kanban Bases views so ordinary data updates reconcile existing cards in place instead of rebuilding the full board, preserving DOM identity where safe and falling back to full render for structural changes.
- Fixed TaskNotes Kanban Bases updates so unchanged sync bursts are coalesced and skipped without moving existing card DOM, while reordered or changed cards still patch incrementally.
- Fixed more TaskNotes UI actions, including modal dependency cards, subtask rows, selectors, quick actions, reminders, batch actions, and relationship updates, so refreshed note frontmatter wins over stale pending cache data.
- Hardened Hermes activity loading so opening a Hermes-managed TaskNote can restart the local dashboard after an update stops it, and cached activity is shown until the live Kanban API is reachable.
- Added a startup notice when TaskNotes tries to bring Hermes online but the dashboard still does not become live, prompting a manual Hermes restart instead of failing silently.
- Hardened TaskNotes-started Hermes dashboards so they receive the TaskNotes API connection and webhook setup needed to keep TaskNotes board tasks in sync through the API/webhook path.
- Started Hermes managed-task event sync as soon as the dashboard is live and treat canonical `TaskNotes/<board>/t_*.md` paths as Hermes mirrors even when the live cache has not loaded their tags yet, so TaskNotes kanban cards can refresh from Hermes status and assignee events without waiting for the periodic reconciliation pass.
- Prevented Hermes sync from repeatedly rewriting unchanged Bases-backed task and activity notes by scoping activity note filenames to their source task, preserving stored task/activity sync timestamps for unchanged curated activity, preserving stable mirror timestamps, and suppressing no-op mirror writes, reducing kanban view flicker during background reconciliation.
- Fixed Hermes board task creation from TaskNotes kanban views so new cards are submitted to Hermes first and mirrored back into the correct board folder, avoiding orphan local TaskNotes notes that never receive Hermes activity.
- Fixed generated Hermes board views so they filter by their canonical `TaskNotes/<board>` mirror folder instead of broad `Hermes/<board>` project metadata, preventing board views from picking up orphan local notes outside the board folder.
- Fixed shared Hermes board provisioning so generated Kanban views with quoted or unquoted Bases `name` values are updated in place instead of duplicated.
- Fixed live Hermes board startup so TaskNotes provisions shared Kanban base views for the active board list as soon as the dashboard is connected, without requiring a manual Settings sync first.
- Fixed Hermes-to-TaskNotes polling so activity updates also refresh changed Kanban card fields like status, assignee, and blockers when the live event stream misses a Hermes update.
- Kept Hermes-managed TaskNotes in sync with the Kanban database by deleting stale local mirrors when their live task disappears, and by deleting the live Kanban task through the Hermes API before removing a local mirror.
- Reduced normal startup console noise from dependency indexing and virtualized task boards.
- Fixed Hermes review activity frontmatter so later mirror-note rewrites preserve cached activity summaries instead of removing them, and the Start Hermes action can find common local Hermes installs from Obsidian on macOS.
- Fixed Hermes startup from the TaskNotes modal so it does not try to start a duplicate dashboard when localhost is already reachable but the Kanban API is degraded.
- Fixed Hermes write availability checks so selected Kanban CLI transport submissions can be considered writable when the local `hermes` CLI and selected board are available, even if the dashboard API is down.
- Fixed newly created or rediscovered #goal TaskNotes not starting Hermes Goal Mode sync when they were first seen after the lifecycle snapshot.
- Fixed Hermes board surface provisioning so generated TaskNotes board views are created, updated, and removed through TaskNotes' standard vault mutation boundary.
- Fixed task edit modals so the Title and Details Modal Fields settings are respected when Activity fields are enabled.
- Fixed the live Obsidian verification helper on macOS so it can use the Obsidian app CLI when no separate `obsidian` binary is on `PATH`.
- Fixed Hermes activity visibility for TaskNotes board tasks by periodically pulling Hermes activity through the Kanban API and refreshing the task note's `hermesComments`, `hermesRuns`, `hermesEvents`, `hermesAttachments`, and `hermesChangedFiles` indexes without running the legacy full mirror import.
- Fixed Hermes-managed task modals and activity sync so they read TaskNote frontmatter before using TaskNotes' pending write-through fallback, preventing stale titles or statuses from reappearing after Hermes activity refreshes.
- Fixed task card status actions and dependency drawers so they prefer the TaskNote's frontmatter before pending TaskNotes fallback data when rendering or updating related task cards.
- Fixed TaskNotes property, recurring, and dependency writes so they hydrate from note frontmatter before pending fallback data, reducing stale overwrites in Hermes-backed board workflows.
- Fixed the Hermes Boards Bases view so it uses the Bases query rows as its local task source instead of falling back to a broad TaskNotes task scan during render.
- Fixed Hermes Boards `Open kanban` so opening a board selects that board's view inside the shared `TaskNotes/Views/kanban-default.base` file.
- Removed generated legacy `TaskNotes/Views/kanban-board-*.base` files during Hermes board provisioning now that board views live in the shared `TaskNotes/Views/kanban-default.base` file.
- Fixed Hermes board provisioning so updating one shared Kanban view keeps the next view on a separate YAML list item instead of merging the two view definitions.
- Fixed Hermes board provisioning so adding generated board views to the shared default Kanban base preserves existing TaskNotes root filters, formulas, and properties.
- Fixed Hermes archived-task filtering in generated Bases board views so the TaskNotes Kanban layout hides boolean and stringified archived flags by default and can reveal them with the per-view archived-task toggle; existing generated archive views are removed when board provisioning runs again.
- Fixed Hermes board provisioning so shared root filters no longer exclude archived tasks before the TaskNotes Kanban archived-task toggle can decide whether to show them.
- Fixed Hermes-managed TaskNotes archive handling so `hermesArchived` is the archive source of truth for task reads, Bases archived filters, and archive/unarchive actions instead of the generic archive tag.
- Fixed Kanban swimlane rendering so swimlanes are grouped inside shared status columns, hidden empty columns stay hidden, each column uses one shared scroll area without per-swimlane height caps, and compact add-task controls live in each swimlane header.
- Fixed the Agent Roster Bases view so completed-only agents and completed task history stay hidden until the user explicitly opens the history section.
