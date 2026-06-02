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

- Added a `TaskNotes: Create hermes goal mode card` command that creates Hermes cards from the TaskNotes modal, records Goal Mode markers in Hermes comments, and writes Goal Mode frontmatter/tags to the Obsidian mirror note.
- Added #goal TaskNote sync so eligible notes can create Hermes Goal Mode cards with source-note idempotency and Hermes sync metadata backfilled after successful card creation.

## Changed

- Treat TaskNotes board folders as the native kanban control panel, using `TaskNotes/<board>/<task-id>.md` for board identity and removing empty Hermes-only modal field groups from settings.
- Improved Hermes Goal Mode card creation duplicate-submit and partial-success handling with in-flight submit disabling, stable create idempotency keys, and notices that name the existing card when post-create sync is incomplete.

## Fixed

- Fixed newly created or rediscovered #goal TaskNotes not starting Hermes Goal Mode sync when they were first seen after the lifecycle snapshot.
