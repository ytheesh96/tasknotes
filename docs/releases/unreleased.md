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

- Added a Hermes availability service for the TaskNotes modal that checks localhost dashboard/API health, reports cache-only/read-only modes, and supports desktop-only startup with the safe localhost dashboard command.
- Added Hermes task edit modal availability indicators, cache-only labeling, disabled live controls when disconnected, and Start Hermes/Recheck actions that reload live board data after startup.
- Added implementation notes for Hermes availability states, cache-only labels, desktop startup behavior, and unavailable/startup failure copy in the TaskNotes modal.
- Added a `TaskNotes: Create hermes goal mode card` command that creates Hermes cards from the TaskNotes modal, records Goal Mode markers in Hermes comments, and writes Goal Mode frontmatter/tags to the Obsidian mirror note.
- Added #goal TaskNote sync so eligible notes can create Hermes Goal Mode cards with source-note idempotency and Hermes sync metadata backfilled after successful card creation.

## Changed

- Redesigned the Hermes section of the task edit modal as a review-thread activity rail with pinned handoffs, chat-style comments, compact run status chips, artifact links, and inline status updates while preserving the existing TaskNotes editing experience.
- Refined the Hermes task edit modal so the review comment Send button sits inside the composer, Hermes live status appears as a compact indicator, status updates appear inside the review thread, and the task information footer is hidden.
- Pinned the Hermes review comment composer to the bottom of the activity rail so only the review cards scroll, with a cleaner composer treatment for writing comments.
- Changed the Hermes task edit modal into a live API-backed surface by removing the legacy Save update/Cancel footer, autosaving supported title/status/priority/assignee/dependency edits through Hermes, and dropping the editable mirror-note Details field.
- Added Hermes Board and Assignee controls to task edit and creation modal top icon rows so routing metadata is visible beside status, priority, dates, recurrence, and reminders without duplicate fields below the title area.
- Tightened Hermes review-thread spacing so status updates use compact log rows with round indicators, structured review/handoff cards show collapsed previews instead of full reports, rely on the left-edge severity color instead of duplicate badges, and place the newest visible activity closest to the comment composer.
- Rendered Hermes handoff and review-required thread comments as compact structured cards with readable status chips, artifact actions, and a low-emphasis View raw affordance instead of showing raw JSON by default.
- Added a focused Hermes comment parser/presentation-model layer so review-thread comments with fenced JSON, prefixed prose, malformed payloads, or handoff metadata render as structured activity instead of raw JSON.
- Replaced the Hermes task edit footer archive/delete controls with a single Block/Unblock status button backed by the live Hermes API.
- Treat TaskNotes board folders as the native kanban control panel, using `TaskNotes/<board>/<task-id>.md` for board identity and removing empty Hermes-only modal field groups from settings.
- Improved Hermes Goal Mode card creation duplicate-submit and partial-success handling with in-flight submit disabling, stable create idempotency keys, and notices that name the existing card when post-create sync is incomplete.

## Fixed

- Fixed Hermes startup from the TaskNotes modal so it does not try to start a duplicate dashboard when localhost is already reachable but the Kanban API is degraded.
- Fixed newly created or rediscovered #goal TaskNotes not starting Hermes Goal Mode sync when they were first seen after the lifecycle snapshot.
