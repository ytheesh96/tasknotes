# Integrations Settings

These settings control the integration with other plugins and services, such as Bases and external calendars.


![Integrations Settings](../assets/settings-integrations.png)

## Hermes

Hermes settings live under **Settings → TaskNotes → Integrations → Hermes**. They control how TaskNotes starts Hermes and how **Submit to Hermes** creates Kanban cards.

### Submission mode

Set **Kanban task creation transport** (`hermesKanbanTransport`) to `kanban-cli` for normal use. This keeps **Submit to Hermes** on the local Kanban CLI path instead of making task creation depend on the Hermes dashboard API.

| Mode | Use when | Must be available |
| --- | --- | --- |
| `kanban-cli` | Recommended for TaskNotes submissions. Use this when TaskNotes should create Kanban cards directly through `hermes kanban`, including when the dashboard/API is not running. | Desktop Obsidian with Node `child_process`, a working `hermes` CLI, and a selected board that the CLI can open. |
| `dashboard-api` | Only use this if you intentionally want task creation to go through the dashboard API alongside dashboard-backed live reads. | Hermes dashboard at `http://127.0.0.1:9119/` and Kanban API at `http://127.0.0.1:9119/api/plugins/kanban`. |

`kanban-cli` is the preferred write path for creating cards. Dashboard-backed reads are separate: live board lists, assignee lists, activity, comments, run history, and mirror/detail sync still require the dashboard/API. After CLI creation, TaskNotes may show a partial-success notice until the dashboard is reachable and can sync details back.

### Required configuration

- **Kanban task creation transport** (`hermesKanbanTransport`): set to `kanban-cli` to create cards directly through the Hermes CLI. `dashboard-api` remains available only when you explicitly want API-backed writes.
- For `kanban-cli`, ensure the Obsidian environment can find `hermes`. TaskNotes checks `HERMES_EXECUTABLE`, `PATH`, `~/.local/bin/hermes`, `~/.hermes/hermes-agent/venv/bin/hermes`, `/opt/homebrew/bin/hermes`, and `/usr/local/bin/hermes`.
- For `kanban-cli`, choose a Hermes board before submitting. TaskNotes validates it with `hermes kanban --board <board> list --json` and creates cards with `hermes kanban --board <board> create <title> ... --json`.
- **Start command** (`hermesStartCommand`): command used by **Start Hermes** for dashboard-backed reads. Default: `hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build`.
- **Auto-start after Hermes task changes** (`hermesAutoStartOnTaskChange`): optional desktop-only attempt to start the dashboard after Hermes-linked task changes; not required for CLI task creation.

### Common messages

| Message | Likely fix |
| --- | --- |
| `Hermes dashboard is not reachable at http://127.0.0.1:9119/.` | Start Hermes, fix the start command, or switch to `kanban-cli` if you only need task creation. |
| `Hermes dashboard root is reachable, but the Kanban API is unavailable.` | Restart Hermes or inspect dashboard/plugin logs; the root server is up but the Kanban endpoint is not healthy. |
| `Multiple Hermes dashboard processes detected; using healthy localhost:9119.` | A healthy dashboard is being used; clean up duplicate dashboard processes when convenient. |
| `Hermes CLI is not available on PATH.` | Install Hermes or expose it to Obsidian's environment. |
| `Hermes CLI is not available from HERMES_EXECUTABLE or PATH.` | Check `HERMES_EXECUTABLE` and the normal lookup paths; the configured executable was not usable. |
| `Hermes CLI is not executable: ...` | Run `hermes --version` from a terminal and fix permissions, installation, or environment errors. |
| `Choose a Hermes board before writing through the CLI.` | Select a board in the modal or Hermes board view before submitting. |
| `Hermes board <board> is not available through the CLI: ...` | Verify the current Hermes profile/board database and run `hermes kanban --board <board> list --json` from the same environment. |
| `Hermes Kanban CLI returned invalid JSON for create task: ...` | Ensure the installed Hermes supports `--json` and is not printing non-JSON output for the command. |
| `Hermes Kanban CLI failed (exit <code>): ...` | Read the sanitized detail, then retry the equivalent `hermes kanban ... --json` command in a terminal. |

For developer smoke-test steps and implementation notes, see [Hermes Kanban task creation transports](../development/hermes-kanban-transports.md).

## Bases Integration
## Bases

TaskNotes v4 uses Obsidian's Bases core plugin for its main views. For setup instructions, see [Core Concepts](../core-concepts.md#bases-integration).

### View Commands Configuration

View command settings map TaskNotes commands and ribbon actions to specific `.base` files. This is useful when you maintain custom variants of the default views and want first-class command access to those files.

Access these settings in **Settings → TaskNotes → General → Views & base files**.

Default mappings:

- **Open Mini Calendar View** → `TaskNotes/Views/mini-calendar-default.base`
- **Open Kanban View** → `TaskNotes/Views/kanban-default.base`
- **Open Tasks View** → `TaskNotes/Views/tasks-default.base`
- **Open Calendar View** → `TaskNotes/Views/calendar-default.base`
- **Open Agenda View** → `TaskNotes/Views/agenda-default.base`
- **Pomodoro Statistics Base** → `TaskNotes/Views/pomodoro-stats.base`
- **Relationships Widget** → `TaskNotes/Views/relationships.base`

Each command allows you to specify a custom `.base` file path and includes a reset button to restore the default path.

**Auto-create default files**: When enabled, TaskNotes creates missing default `.base` files automatically on startup.

**Create files**: Button to generate all default `.base` files in the `TaskNotes/Views/` directory. Existing files are not overwritten.

The generated Pomodoro statistics Base reads Pomodoro sessions from daily notes frontmatter. If your Pomodoro history is still stored in plugin data, migrate it from **Settings → TaskNotes → Features** before using that Base file.

## OAuth Calendar Integration

Connect Google Calendar or Microsoft Outlook to sync events bidirectionally with TaskNotes. Events automatically refresh every 15 minutes and sync when local changes are made (such as dragging events to reschedule).

Enable **Disable calendar integrations on mobile** when you sync TaskNotes settings between desktop and mobile but do not want Obsidian Mobile to load external calendars on startup. The setting only affects mobile devices; desktop calendar integrations continue to run normally.

### Setup Requirements

OAuth integration requires creating your own OAuth application with Google and/or Microsoft. Initial setup takes approximately 15 minutes per provider.

**Setup Guide**: See [Calendar Integration Setup](../calendar-setup.md) for detailed instructions on creating OAuth credentials with Google Cloud Console and Azure Portal.

### Google Calendar

Provide **Client ID** and **Client Secret** from Google Cloud Console, then use **Connect Google Calendar** to complete OAuth loopback authentication. **Disconnect** revokes local credentials.

The **Target calendar** setting used for exporting tasks to Google Calendar is also used as the default selection when creating a manual external calendar event from the calendar view. If the target calendar is unavailable, TaskNotes falls back to the provider's primary calendar.

For timed task exports, **Default reminder** accepts one or more minute offsets separated by commas, such as `60, 1440`. All-day task exports use the target Google Calendar's default reminder settings.

When connected, displays:
- Connected account email
- Connection time
- Last sync time
- Manual refresh button

### Microsoft Outlook Calendar

Provide **Client ID** and **Client Secret** from Azure App Registration, then use **Connect Microsoft Calendar** to authenticate. **Disconnect** removes stored credentials and sync access.

When connected, displays:
- Connected account email
- Connection time
- Last sync time

### Security

- OAuth credentials are stored locally in Obsidian's data folder
- Access tokens refresh automatically
- Calendar data syncs directly between Obsidian and the calendar provider (no intermediary servers)
- Disconnect at any time to revoke access

## Calendar subscriptions (ICS)

ICS settings define how subscribed calendar events are represented in your vault. You can set a default template, destination folder, filename strategy, and custom filename template for generated notes. Use **Add Calendar Subscription** to register URLs or local files, and **Refresh all subscriptions** for manual synchronization.

**Recurring event related notes** controls how notes linked from recurring external calendar events are matched. **Series-wide** keeps the current behavior: a note linked to one loaded recurrence can appear on the other loaded recurrences from the same Google, Microsoft, or ICS event series. **Selected instance only** limits related notes and counts to the exact recurrence instance that was linked.

## Automatic ICS export

Automatic export keeps an ICS feed of your tasks updated on a schedule. Configure whether it is enabled, where the file is written (vault-relative path), the refresh interval, and use **Export now** for immediate output.

Export filters can omit archived tasks, completed tasks, tasks without due dates, or tasks without scheduled dates. When both due-date and scheduled-date requirements are enabled, exported tasks must have both dates.

## HTTP API

HTTP API settings control the local server lifecycle, listening port, and request authentication token.

Changes to API enablement or port require an Obsidian restart to take effect.

!!! warning
    The HTTP API binds to loopback only and browser CORS is limited to loopback origins. If the authentication token is empty, local API requests are still unauthenticated. Set a token unless your local environment is fully trusted.

## Webhooks

- **Add Webhook**: Register a new webhook endpoint.
