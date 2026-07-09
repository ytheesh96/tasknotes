# TaskNotes for Hermes

This is a fork of [TaskNotes for Obsidian](https://github.com/callumalpass/tasknotes) with Hermes support added on top.

TaskNotes already has the right shape for this: every task is a Markdown note, and Obsidian Bases can turn those notes into lists, boards, calendars, and tables. This fork keeps that model. The Hermes work here makes Loop/Kanban tasks show up in Obsidian as normal TaskNotes items, instead of living off to the side in a separate dashboard.

## What changed

Hermes boards can be mirrored into TaskNotes, with one note per task and Bases views for browsing the work. A Hermes task keeps its board and task id in frontmatter, so TaskNotes can tell which Loop/Kanban card it belongs to and avoid mixing together tasks from different boards.

Hermes-managed notes also get a review-oriented reading surface. When you open one, the important parts are brought forward: the task brief, changed files, comments, verification, recent activity, dependencies, and the next action a reviewer needs to take. The raw activity data is still there, but it is no longer the first thing you have to read.

The fork also handles the less glamorous sync work: keeping board records around when Hermes is offline, preserving cached activity, avoiding pointless note rewrites, and making archive/status changes line up with TaskNotes' own fields.

## Why this exists

I wanted TaskNotes to be the place where Hermes work is reviewed, not just a storage layer for generated task files.

The useful bit is that Obsidian remains the surface. You can open a task note, inspect the work, follow links to evidence, leave a comment, and move on. Hermes still owns the execution side. TaskNotes owns the note, the fields, and the Bases views.

That split matters. It keeps the task data readable and portable, while still letting Hermes attach the context that makes a task reviewable: runs, comments, changed files, artifacts, handoffs, and verification.

## Main pieces

- Hermes board records in TaskNotes.
- Board-qualified task mirrors, using paths like `TaskNotes/Tasks/<board>--<task-id>.md`.
- Bases/Kanban views for Hermes boards.
- A Hermes-aware TaskNote review surface.
- Cached comments, runs, events, artifacts, and changed files.
- Local fallback behavior when the Hermes dashboard is unavailable.
- Safer archive, status, assignee, dependency, and board-routing handling.



## License

MIT. See [LICENSE](LICENSE).
