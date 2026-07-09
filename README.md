# TaskNotes × Hermes Integration Fork

This fork of [TaskNotes for Obsidian](https://github.com/callumalpass/tasknotes) is focused on making TaskNotes the native Obsidian control surface for **Hermes Loop/Kanban work**.

The upstream plugin is a Markdown-note task manager powered by [Obsidian Bases](https://help.obsidian.md/bases). This branch keeps that foundation, but adds the local Hermes integration work needed for agents, reviewers, and operators to use TaskNotes as a durable task board, review surface, and synchronization layer.

> This repository is not a replacement for upstream TaskNotes documentation. For general TaskNotes installation and usage, see [tasknotes.dev](https://tasknotes.dev/) and the upstream project.

## What this fork is for

The goal is to let Hermes-managed work appear and behave like ordinary TaskNotes tasks while still preserving Hermes execution evidence.

This includes:

- **TaskNotes-native Hermes boards** — Hermes boards are represented as TaskNotes board records and Bases/Kanban views, so boards remain visible in Obsidian even when the dashboard is unavailable.
- **Board-qualified task mirrors** — Hermes tasks are mirrored into stable TaskNotes paths such as `TaskNotes/Tasks/<board>--<task-id>.md`, avoiding collisions when multiple boards contain the same task id.
- **Local-first review surface** — Hermes-managed task notes open with a review-oriented split surface: task brief, changed files, compact comment composer, decision actions, verification rows, activity timeline, run history, and dependency chips.
- **TaskNotes-owned state** — normal task properties such as status, priority, assignee, dependencies, archive state, and board routing are represented with TaskNotes frontmatter and Bases affordances.
- **Hermes execution evidence** — comments, runs, events, artifacts, changed files, worker sessions, reviewer handoffs, and audit/action links are cached as reusable TaskNote activity fields and linked activity notes.
- **Dashboardless sync path** — TaskNotes can use its HTTP API and webhook flow as the source of task state while Hermes consumes updates through API/webhook sync.
- **Safe degraded modes** — Hermes controls show availability, cache-only/read-only states, and local startup actions instead of silently writing through a missing dashboard.

## Current PR focus

The active PR branch publishes the local Hermes TaskNotes integration work that was not present in the public repository. It merges the local Hermes stack against current upstream `main` and includes conflict-resolution work to keep the PR mergeable.

Key areas touched by this branch:

- Hermes board registry and board provisioning.
- Hermes Boards Bases view behavior.
- Hermes task mirror canonicalization and activity sync.
- TaskNotes Kanban archive and refresh behavior for Hermes-managed tasks.
- Task creation/edit routing through Hermes transports.
- Project/property settings persistence for Hermes metadata.
- Native Hermes-managed TaskNote review surface and mockup/PRD documentation.
- Unit coverage for Hermes boards, provisioning, settings, archive planning, and related Bases behavior.

See also:

- [`docs/hermes-task-note-review-surface-prd.md`](docs/hermes-task-note-review-surface-prd.md)
- [`docs/releases/unreleased.md`](docs/releases/unreleased.md)
- [`docs/mdbase-tasknotes-cli.md`](docs/mdbase-tasknotes-cli.md)

## How Hermes uses TaskNotes

At a high level:

1. Hermes owns the execution runtime: Loop rows, Kanban state, worker runs, reviewer handoffs, artifacts, and audit events.
2. TaskNotes owns the Obsidian task surface: Markdown task notes, frontmatter fields, Bases/Kanban views, and the edit/review UI.
3. Sync code bridges the two by writing canonical Hermes identifiers and cached activity summaries into TaskNotes notes.
4. Reviewers can inspect and act on Hermes work from Obsidian without opening raw JSON, terminal logs, or a separate dashboard for every decision.

The intended UX is **show the work where the user already reviews tasks**: inside Obsidian notes and TaskNotes views.

## Development

This is still an Obsidian plugin. The plugin id remains:

```text
tasknotes
```

Install dependencies and run the normal project checks from the repository root:

```bash
npm install
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build:test
```

For live Obsidian verification, follow `AGENTS.md` and use the configured running vault/plugin path:

```bash
npm run verify:obsidian
```

The live-vault scripts default to the running vault named `Obsidian` and plugin path `~/Documents/Obsidian/.obsidian/plugins/tasknotes`.

## Relationship to upstream TaskNotes

This fork inherits TaskNotes' core model:

- each task is a Markdown note;
- task metadata lives in YAML frontmatter;
- views are powered by Obsidian Bases;
- task data remains portable and scriptable.

The fork-specific work is the Hermes integration layer on top of that model. General TaskNotes features such as recurring tasks, calendar views, time tracking, natural language task creation, dependencies, custom fields, localization, HTTP API, and webhooks come from upstream TaskNotes.

For the upstream product README, docs, screenshots, and user-facing installation guide, use:

- Upstream repository: https://github.com/callumalpass/tasknotes
- Documentation: https://tasknotes.dev/

## License

MIT — see [LICENSE](LICENSE). Upstream TaskNotes is © its original contributors; this fork preserves that license while adding Hermes integration work.
