# Hermes Availability UX States and Copy

## Scope

This spec defines how TaskNotes should communicate Hermes availability in the Obsidian modal, header/status snapshot, and Hermes-specific right rail. It applies only to Hermes-backed TaskNotes mirror notes, identified by `getHermesTaskIdentity(task)` returning `{ board, id }` for paths like `TaskNotes/<board>/<task-id>.md`.

The UX must make one distinction unmissable:

- Live Hermes data/actions come from the local Hermes dashboard API at `127.0.0.1:9119`.
- The TaskNote file is a local mirror that may remain readable when Hermes is unavailable, but may be stale.

Non-Hermes tasks should not show Hermes availability chrome, Start Hermes actions, or cache-only warnings.

## Availability model

Implement one normalized availability object for the modal/header/right rail instead of scattering error strings across components.

Suggested states:

| State | Meaning | Primary source |
| --- | --- | --- |
| `starting` | User or app is trying to start/reconnect to Hermes; no confirmed healthy API response yet. | Start/retry controller |
| `connected` | Hermes API responds successfully and the current task detail fetch succeeds. | `HermesKanbanApiClient.getTask(identity)` |
| `degraded` | Port/API is reachable, but one or more live capabilities failed or returned incomplete data. | Partial API failures, auth/session issues, event stream failure |
| `disconnected` | Hermes API cannot be reached or startup failed. TaskNotes can only render the local mirror/cache. | Network/startup error |

Use a `lastLiveAt` timestamp whenever a live API fetch succeeds. Use a `lastCheckedAt` timestamp for every availability check, successful or failed.

## Global placement

### Modal header / status snapshot

For Hermes tasks, put availability in the compact Hermes status snapshot above the title field, before task status/board/assignee chips.

Header anatomy:

1. Availability chip.
2. Short one-line explanation.
3. Inline action slot on the right: `Recheck`, `Start Hermes`, `Starting...`, or `Retry` depending on state/platform.

Keep this row visible even when the right rail is collapsed. It is the primary signal for whether the user is editing live Hermes state or a cached mirror.

### Right rail

At the top of the Hermes right rail, above `Review thread`, render a small availability banner only when state is not `connected`.

- `degraded`: warning banner, compact.
- `disconnected`: cache-only banner, prominent.
- `starting`: progress banner.

Do not duplicate long failure copy in both header and rail. Header gets the short status; rail gets the actionable explanation.

### Retry/recheck placement

Place `Recheck`/`Retry` in two places:

- Primary: right side of the header availability row.
- Secondary: right side of the right-rail availability banner when visible.

Button text rules:

- `Recheck` for passive health checks after disconnected/degraded states.
- `Retry` after a user-initiated Start Hermes attempt failed.
- `Start Hermes` only on Obsidian desktop when TaskNotes can launch a local process.
- `Starting...` while a start attempt is in flight; disabled and shows spinner/progress affordance.

## State specs

### 1. Connected / live

Chip:

- Label: `Hermes live`
- Color: green/success
- Tooltip: `Connected to Hermes at 127.0.0.1:9119. Task details and actions are live.`

Header copy:

- `Live from Hermes · checked just now`
- If not just now: `Live from Hermes · checked 2 min ago`

Right rail:

- No availability banner by default.
- Optional subtle metadata near rail title: `Live · updated 2 min ago`.

Controls:

- Live controls are enabled, subject to existing task status/permission rules.
- Enabled controls include status, board, assignee, priority, blocked-by/blocking links, comment composer, create/link/delete board actions, run/history refresh, and Agent Shell links when supported.
- If an individual action fails while overall availability remains healthy, show the specific action error inline and transition to `degraded` only if the failure affects a class of live controls.

Cached mirror labels:

- Do not label ordinary fields as cached in this state.
- If a field is rendered from the TaskNote mirror before the live fetch completes, treat that transient as `starting`, not `connected`.

### 2. Starting

Use this while checking availability on modal open, while reconnecting, or while launching Hermes on desktop.

Chip:

- Label: `Hermes starting`
- Color: blue/info or yellow/pending
- Tooltip: `TaskNotes is checking the local Hermes dashboard.`

Header copy variants:

- Initial modal load: `Checking Hermes... showing the local TaskNote for now.`
- After pressing Start Hermes: `Starting Hermes... this may take a few seconds.`
- After pressing Recheck: `Rechecking Hermes...`

Right-rail banner:

Title: `Checking Hermes`

Body: `TaskNotes is trying to reach the local Hermes dashboard. Until it connects, values shown here come from the local TaskNote mirror.`

Primary action:

- `Starting...` disabled when a launch is in flight.
- `Rechecking...` disabled when only a health check is in flight.

Controls:

- Local-only TaskNotes fields may remain readable.
- Guard live controls during the pending check to prevent duplicate or stale writes:
  - Disable status/board/assignee live updates.
  - Disable comment composer submit.
  - Disable block/unblock/complete/archive/delete/link actions.
  - Disable Agent Shell actions that require a run/session lookup.
  - Disable `Show full run log` if it requires an API fetch and no cached run payload exists.
- If the user edits ordinary local note content while starting, label the save path clearly as local-only unless the implementation can safely replay/sync later. Preferred: do not offer replay; keep Hermes-managed fields read-only until live.

Desktop Start Hermes behavior:

- If Obsidian desktop can launch Hermes, pressing `Start Hermes` enters `starting` immediately and polls health until success/failure/timeout.
- Show at most one start attempt at a time.
- While starting, replace `Start Hermes` with disabled `Starting...`.

Timeout:

- If no healthy response after the implementation timeout, transition to `disconnected` with failed-start copy below.

### 3. Degraded

Use when Hermes is reachable but the experience is incomplete. Examples: current task fetch works but event stream fails; board list fails; comment post fails due to auth/session; task detail returns but comments/runs/events are missing; port 9119 is healthy but a capability endpoint returns 500.

Chip:

- Label: `Hermes degraded`
- Color: yellow/warning
- Tooltip: `Hermes is reachable, but some live data or actions failed.`

Header copy:

- `Hermes partially available · some actions may fail`
- If specific: `Hermes partially available · comments could not load`

Right-rail banner:

Title: `Hermes is partially available`

Body: `Task details loaded, but some live data or actions did not. You can keep reading this task; guarded controls will stay disabled until the next successful check.`

Secondary detail line:

- `Last live update: 2 min ago` if `lastLiveAt` exists.
- `Last checked: just now` always available after check.

Actions:

- Primary: `Recheck`
- Optional low-emphasis: `Show details` expands the raw error class/message, not a full stack trace.

Controls:

- Enable controls backed by endpoints that are currently known healthy.
- Disable or guard controls backed by failed capabilities.
- If capability health is not tracked granularly, prefer conservative behavior: keep reads enabled, disable writes.
- Disabled controls must include a tooltip/explanation: `Unavailable while Hermes is partially available. Recheck to try again.`
- Comment composer placeholder: `Comments are unavailable until Hermes reconnects.` when comments endpoint failed.
- Event/run history placeholder: `Run history could not be refreshed. Showing cached mirror values only.` if no live history is available.

Cached mirror labels:

- For fields rendered from live task detail, no cached label needed.
- For fields rendered from the TaskNote file because a specific API segment failed, append a small source label:
  - `from TaskNote mirror`
  - Tooltip: `This value is from the local TaskNote file and may be stale.`

### 4. Disconnected / cache-only

Use when Hermes API cannot be reached, session/bootstrap fails completely, or startup failed/timed out. The modal should remain useful as a local TaskNote reader, but must not imply live Hermes control.

Chip:

- Label: `Cache only`
- Color: muted/yellow warning
- Tooltip: `Hermes is unavailable. Values are from the local TaskNote mirror and may be stale.`

Header copy:

- `Hermes unavailable · showing TaskNote mirror`
- With prior live timestamp: `Hermes unavailable · mirror may be stale since 3:42 PM`
- Without prior live timestamp: `Hermes unavailable · mirror may be stale`

Right-rail banner:

Title: `Hermes is unavailable`

Body: `TaskNotes cannot reach the local Hermes dashboard at 127.0.0.1:9119. This modal is showing the local TaskNote mirror, which may be stale.`

Cached mirror label rules:

- Label the whole modal/read section once, not every field, unless individual cached/live fields are mixed.
- Use section label: `TaskNote mirror (cache-only)`.
- Use field/source label where compact: `from TaskNote mirror`.
- Tooltip: `This value was read from the Obsidian note, not from the live Hermes API.`
- For mirrored status/board/assignee row, show `Status from mirror`, `Board from path`, and `Assignee from mirror` when space allows.

Disabled live controls:

Disable all controls that would call Hermes or imply live board state:

- Status changes for Hermes board status.
- Board changes / move card.
- Assignee changes.
- Priority changes if intended to patch Hermes.
- Blocked-by/blocking link add/remove.
- Comment composer submit.
- Block/unblock/complete/archive/delete card actions.
- Create child card / create linked card.
- Run/Agent Shell actions that require live run/session lookup.
- `Show full run log` refresh when no cached run data exists.
- Event stream/live refresh toggles.

Disabled-state copy:

- Tooltip for disabled live fields: `Requires Hermes. Currently showing the local TaskNote mirror.`
- Comment composer placeholder: `Comments require Hermes. Start or reconnect Hermes to add a comment.`
- Agent Shell disabled tooltip: `Agent Shell requires a live Hermes run/session.`
- Board/assignee disabled tooltip: `Board and assignee changes require the live Hermes API.`

Local note editing:

- If the implementation permits editing local note-only fields, label the save action as local-only: `Save local note`.
- Do not silently queue or replay Hermes writes unless a future sync design explicitly specifies conflict handling.
- For Hermes-owned mirror fields, prefer read-only in cache-only mode. If editable for technical reasons, show a guard confirmation before save:
  - Title: `Edit local mirror only?`
  - Body: `Hermes is unavailable, so this change will update only the Obsidian TaskNote mirror. It will not update the Hermes board until a sync workflow exists.`
  - Buttons: `Edit mirror only` and `Cancel`

## Startup and failed-start copy

### Desktop-only Start Hermes

Show `Start Hermes` only when all are true:

- Running in Obsidian desktop, not mobile.
- The plugin has a safe local-process launch path for Hermes.
- No health check or launch attempt is already in flight.
- Hermes is `disconnected` or failed to start.

Do not show `Start Hermes` in browser/mobile contexts. Show `Recheck` instead.

Desktop disconnected banner with launch available:

Title: `Hermes is not running`

Body: `Start the local Hermes dashboard to enable live board actions. Until then, TaskNotes is showing the local mirror for this card.`

Primary button: `Start Hermes`

Secondary button: `Recheck`

Manual command disclosure/link text: `Run manually instead`

Expanded manual copy:

`If starting from TaskNotes does not work, run this command in Terminal:`

```bash
hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui
```

### Mobile/browser cache-only behavior

Mobile/browser disconnected banner:

Title: `Hermes unavailable on this device`

Body: `TaskNotes cannot start the local Hermes dashboard from mobile or browser Obsidian. You can read the local TaskNote mirror here; live board actions are available from desktop once Hermes is running.`

Primary button: `Recheck`

No `Start Hermes` button.

Mirror label: `TaskNote mirror (cache-only)`.

### Failed startup

Use this after the user presses `Start Hermes` and the health check still fails or the launch command reports an error.

Header copy:

- `Hermes failed to start · showing TaskNote mirror`

Right-rail/banner title:

- `Hermes did not start`

Body:

`TaskNotes could not start the local Hermes dashboard. Live board actions are disabled, but you can still read the local TaskNote mirror.`

Actionable copy:

`Try again, or start Hermes manually in Terminal:`

```bash
hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui
```

Buttons:

- Primary: `Retry`
- Secondary: `Recheck`
- Low-emphasis: `Copy command`

Optional error detail:

- Label: `Startup details`
- Body format: `Last error: <short sanitized error>`
- Do not show raw stack traces by default.

### Unavailable without launch support

Use this on desktop if no safe launcher is configured or the plugin intentionally does not launch processes.

Title: `Start Hermes in Terminal`

Body:

`TaskNotes cannot reach Hermes at 127.0.0.1:9119. Start the dashboard manually to enable live board actions:`

```bash
hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui
```

Buttons:

- Primary: `Recheck`
- Low-emphasis: `Copy command`

## Multiple dashboard process warning

Only show this warning if port `9119` is healthy and the app has evidence of multiple dashboard processes. Do not show it for ordinary healthy connections without evidence.

Placement:

- Compact warning in the right-rail availability/banner area.
- Do not block live controls solely because multiple processes are detected if the API on port `9119` is healthy.

Copy:

Title: `Multiple Hermes dashboards may be running`

Body: `TaskNotes is connected to the dashboard on port 9119, but another Hermes dashboard process may also be running. If board state looks inconsistent, stop the extra process and click Recheck.`

Action: `Recheck`

Optional detail: `Connected endpoint: 127.0.0.1:9119`

## Copy inventory

Use these exact labels/buttons unless implementation constraints require a shorter variant.

Availability chips:

- `Hermes live`
- `Hermes starting`
- `Hermes degraded`
- `Cache only`

Section/source labels:

- `TaskNote mirror (cache-only)`
- `from TaskNote mirror`
- `Status from mirror`
- `Board from path`
- `Assignee from mirror`
- `Live from Hermes`

Buttons/actions:

- `Start Hermes`
- `Starting...`
- `Recheck`
- `Rechecking...`
- `Retry`
- `Copy command`
- `Run manually instead`
- `Show details`

Disabled placeholders/tooltips:

- `Requires Hermes. Currently showing the local TaskNote mirror.`
- `Comments require Hermes. Start or reconnect Hermes to add a comment.`
- `Board and assignee changes require the live Hermes API.`
- `Agent Shell requires a live Hermes run/session.`
- `Unavailable while Hermes is partially available. Recheck to try again.`

Core unavailable copy:

- `Hermes unavailable · showing TaskNote mirror`
- `Hermes unavailable · mirror may be stale`
- `Hermes unavailable · mirror may be stale since <time>`
- `TaskNotes cannot reach the local Hermes dashboard at 127.0.0.1:9119. This modal is showing the local TaskNote mirror, which may be stale.`

Manual command:

```bash
hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui
```

## Implementation notes

- Treat API read failures and API write failures separately. A failed comment post should not necessarily make already loaded task details look stale, but it should disable/guard the comment composer until recheck.
- Prefer one top-level availability reducer/controller that owns transitions and timestamps, with components consuming derived booleans such as `canWriteHermes`, `canComment`, `canShowLiveRuns`, and `canStartHermes`.
- Do not show optimistic live state before the current task detail fetch succeeds. Initial modal render from local TaskInfo should be `starting` with mirror wording.
- Do not queue writes in cache-only mode. The UX copy above assumes no offline write replay.
- Sanitize errors before showing them. Include endpoint/status/error class, not secrets, tokens, environment variables, or raw stack traces.
- Keep availability independent from task status. A task can be `blocked` while Hermes is `connected`, or `running` while the modal is `cache-only`.

## Acceptance checklist

Implementation is complete when:

- The modal/header/right rail can render all four states: connected/live, degraded, disconnected/cache-only, and starting.
- Cached mirror values are labeled as `TaskNote mirror (cache-only)` or `from TaskNote mirror` whenever Hermes is unreachable or a segment is stale.
- Live write controls are disabled or guarded in starting/degraded/disconnected states according to the matrix above.
- Desktop shows `Start Hermes` only when local launch is supported; mobile/browser never shows it.
- Startup failure shows the manual command exactly: `hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui`.
- `Recheck`/`Retry` actions are available from the header row and from non-live banners.
- Optional multiple-process warning is shown only when port 9119 is healthy and there is evidence of another dashboard process.
