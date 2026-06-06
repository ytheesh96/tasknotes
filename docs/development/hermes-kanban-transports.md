# Hermes Kanban task creation transports

TaskNotes can create Hermes Kanban cards through either the local `hermes` CLI or the dashboard HTTP API. Prefer `kanban-cli` for TaskNotes submissions so card creation does not depend on the dashboard/API being up. Choose the transport in Settings -> Integrations -> Hermes -> Kanban task creation transport (`hermesKanbanTransport`).

## `dashboard-api`

Use `dashboard-api` only when TaskNotes should intentionally write through the local Hermes dashboard API, usually because the dashboard is already running and you want write behavior coupled to the live dashboard integration.

Requirements:

- Obsidian desktop for the Start Hermes action.
- A reachable dashboard at `http://127.0.0.1:9119/`.
- The Kanban plugin API available at `http://127.0.0.1:9119/api/plugins/kanban`.

Expected behavior:

- Health is `connected` when the dashboard root and Kanban API both respond.
- TaskNotes can list boards and assignees from the dashboard.
- Submit to Hermes creates the card through `POST /api/plugins/kanban/tasks?board=<board>` and then reads the created task back for local mirror sync.

Common messages:

- `Hermes dashboard is not reachable at http://127.0.0.1:9119/.` Start Hermes or switch to `kanban-cli` if only task creation is needed.
- `Hermes dashboard root is reachable, but the Kanban API is unavailable.` The dashboard process is up, but the Kanban plugin endpoint is not healthy; restart or inspect dashboard logs.
- `Multiple Hermes dashboard processes detected; using healthy localhost:9119.` Clean up duplicate dashboards when convenient.

## `kanban-cli`

Use `kanban-cli` as the direct TaskNotes write path when the local Hermes CLI and board database are available. This mode creates Kanban tasks without the dashboard/API. Dashboard-backed reads are separate: activity, live board lists, assignee lists, dependency link backfill, and local mirror detail sync still require the dashboard API.

Requirements:

- A desktop Obsidian environment with Node `child_process` access.
- A working `hermes` executable on `PATH`, `HERMES_EXECUTABLE`, or one of the built-in macOS/Linux fallback locations.
- A selected Hermes board. CLI health validates it with `hermes kanban --board <board> list --json`.

Expected behavior:

- Health is `connected` with `writeStatus: writable-via-cli` when the executable and board are available.
- Submit to Hermes runs `hermes kanban --board <board> create <title> ... --json` without shell interpolation.
- Native TaskNotes Hermes submissions default to `--triage` and omit an assignee unless routing metadata explicitly supplies one.
- If the dashboard is down, the Kanban card can still be created, but post-create mirror/detail sync may show a partial-success notice until the dashboard is available again.

Common messages:

- `Hermes CLI is not available on PATH.` Install Hermes, add it to the environment seen by Obsidian, or set `HERMES_EXECUTABLE`.
- `Hermes CLI is not available from HERMES_EXECUTABLE or PATH.` The configured executable and normal lookup paths were not usable.
- `Hermes CLI is not executable: ...` The executable was found but failed `hermes --version`.
- `Choose a Hermes board before writing through the CLI.` Select a board in the modal or board view before submitting.
- `Hermes board <board> is not available through the CLI: ...` The CLI ran, but the board could not be opened from the current Hermes profile/environment.
- `Hermes Kanban CLI returned invalid JSON for create task: ...` The CLI did not return parseable `--json` output.
- `Hermes Kanban CLI failed (exit <code>): ...` The CLI exited nonzero; TaskNotes sanitizes control characters, home paths, and common secret-like values before showing the message.

## Smoke-test checklist

1. Run `npm run build:test`.
2. Run focused transport tests:
   `npm test -- --runInBand tests/unit/hermes/hermesKanbanCliClient.test.ts tests/unit/hermes/hermesAvailabilityService.test.ts tests/unit/hermes/hermesWriteGuard.test.ts tests/unit/hermes/hermesGoalModeCreate.test.ts tests/unit/modals/TaskCreationModal.test.ts`.
3. Run `npm run verify:obsidian` when the live Obsidian vault is available.
4. For `dashboard-api`, verify the dashboard root and `/api/plugins/kanban/boards` respond, then create a disposable card through the dashboard API or the modal.
5. For `kanban-cli`, stop or disconnect the dashboard, confirm `hermes --version` and `hermes kanban --board <board> list --json` work, then create a disposable card and verify it appears in `hermes kanban --board <board> show <task-id> --json`.

Record any skipped live step with the exact blocker, especially when Obsidian is not running or stopping the dashboard would disrupt another active worker.
