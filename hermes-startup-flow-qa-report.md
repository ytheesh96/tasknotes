# Hermes availability/startup flow QA report

Task: t_eff79527 — QA Hermes startup flow in Obsidian
Workspace: /Users/yt/Developer/tasknotes-hermes
Branch: codex/hermes-native-tasknotes
Date: 2026-06-02

## Verdict

PASS — ready for human review/merge.

No merge-blocking feature bugs found in the Hermes availability/startup flow. One non-feature Obsidian desktop error is still present in `errors:obsidian` (`this.owner.syncScroll is not a function`); it did not prevent reload, modal DOM verification, dashboard startup, or live recheck.

## Commands and run steps

### Automated checks

- `TASKNOTES_OBSIDIAN_PLUGIN_PATH=/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes npm test -- --runInBand tests/unit/hermes/hermesAvailabilityService.test.ts tests/unit/modals/TaskCreationModal.test.ts tests/unit/modals/TaskEditModal.hermes-activity-layout.test.ts`
  - PASS: 3 suites passed; 49 tests passed; 6 skipped.

- `TASKNOTES_OBSIDIAN_PLUGIN_PATH=/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes npm run typecheck`
  - PASS: `tsc --noEmit` completed successfully.

- `TASKNOTES_OBSIDIAN_PLUGIN_PATH=/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes npm run build:test`
  - PASS: CSS bundle generated 22586 lines; release notes bundle generated; 3 files copied to `tasknotes-e2e-vault/.obsidian/plugins/tasknotes`.

### Obsidian live plugin reload/status

- `HOME=/Users/yt TASKNOTES_OBSIDIAN_PLUGIN_PATH=/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes npm run obsidian:status`
  - PASS: vault `Obsidian`; plugin path `/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes`; TaskNotes enabled; version `4.9.2`.

- `HOME=/Users/yt TASKNOTES_OBSIDIAN_PLUGIN_PATH=/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes npm run verify:obsidian`
  - PASS exit code 0: build, copy, reload, and errors command completed.
  - Note: `errors:obsidian` output still contained repeated Obsidian app-level errors: `Uncaught TypeError: this.owner.syncScroll is not a function` at `app://obsidian.md/app.js`; no TaskNotes/Hermes-specific stack was observed in the captured tail.

### Live Obsidian modal checks

Obsidian CLI flow used because `computer_use`/CuaDriver window capture could not reliably target the off-screen Obsidian window; DOM evaluation against live Obsidian desktop did work.

- Opened the task modal:
  - `HOME=/Users/yt obsidian vault=Obsidian eval code="app.plugins.plugins.tasknotes.openHermesTaskEditModalById('t_eff79527','default'); 'opened'"`

- Rechecked health from the modal:
  - `HOME=/Users/yt obsidian vault=Obsidian eval code="Array.from(document.querySelectorAll('.modal-container button')).find(b=>b.textContent.trim()==='Recheck')?.click(); 'clicked-recheck'"`

- Queried modal state with DOM snapshots while Hermes was running, while `127.0.0.1:9119` was stopped, and after clicking `Start Hermes`.

- Stopped dashboard listener for the down-state check:
  - `kill $(lsof -tiTCP:9119 -sTCP:LISTEN)`

- Started Hermes from Obsidian modal:
  - DOM-clicked the `Start Hermes` button (`aria-label="Start Hermes dashboard"`).
  - Port `127.0.0.1:9119` began listening again within 4 half-second checks.
  - New listener observed: `Python ... TCP 127.0.0.1:9119 (LISTEN)`.

## Acceptance criteria

- Hermes already running: PASS
  - Modal availability text: `Hermes live`, `Connected`, `Live board, profile, status, and comment controls are enabled from http://127.0.0.1:9119/api/plugins/kanban.`
  - Comment textarea enabled with live placeholder.
  - `Recheck` enabled.
  - Send `Comment` button disabled only while textarea is empty; tooltip `Send comment`.

- Hermes stopped/down state: PASS
  - After killing the localhost listener and clicking `Recheck`, modal availability text showed `Cache only`, `Disconnected`, and `Hermes dashboard is not reachable at http://127.0.0.1:9119/.`
  - Review section label changed to `Review thread (cache-only)`.
  - Run strip showed cached activity.

- Live toggles disabled or guarded while disconnected: PASS
  - Comment textarea disabled with placeholder: `Hermes is disconnected; comments are cache-only until reconnected.`
  - Send `Comment` button disabled with title `Hermes is disconnected`.
  - Code-level guard `ensureHermesLiveForAction()` displays a Notice instructing the user to run the exact dashboard command then recheck if a live action is attempted while disconnected.

- `Start Hermes` runs localhost-only dashboard command: PASS
  - Constant verified in source/tests: `hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui`.
  - Unit test verifies spawn call with `hermes`, `dashboard`, `--host`, `127.0.0.1`, `--port`, `9119`, `--no-open`, `--skip-build`, `--tui`.
  - Live Obsidian desktop click on `Start Hermes` restarted the API on `127.0.0.1:9119`.

- Retry/recheck works after startup: PASS
  - After `Start Hermes`, port `9119` listened again; clicking `Recheck` returned the modal to `Hermes live` / `Connected`.

- Live boards/profiles/statuses refresh after successful startup: PASS
  - After startup/recheck, live activity reloaded (`Run 148`, recent heartbeat events, live review thread status visible).
  - Board select retained live board `default`; assignee field showed `reviewer-qa`; status/run chips refreshed from Hermes.
  - Unit test `starts Hermes from the modal, rechecks health, and reloads live activity` asserts `startDashboard`, two `recheckHealth` calls, live `getTask`, live comment rendering, and comment input re-enabled.

- Failure/unavailable paths show actionable manual command copy: PASS with note
  - Down-state modal displayed an actionable manual command: `Manual start: hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui`.
  - Unit test verifies startup-unavailable error action: `Run hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui from a local terminal, then recheck health.`
  - Note: I verified selectable/manual command text, not a dedicated one-click copy button; if the product requirement means a copy-to-clipboard button, that control is not present.

- Mirror notes remain cache/index surfaces only while API is down: PASS
  - While disconnected, modal explicitly said `Mirrored TaskNotes values are cache-only until Hermes reconnects.`
  - The mirror note `/Users/yt/Documents/Obsidian/TaskNotes/default/t_eff79527.md` contains local TaskNotes frontmatter/body only (`status: running`, `projects: Hermes/default`, `contexts: reviewer-qa`, etc.) and no claim that values are live.
  - The board cards remain local mirror/index surfaces; live-only comments/status controls are gated by the Hermes availability state.

## Bugs found

No merge-blocking Hermes availability/startup bugs found.

Non-blocking observations:

1. `verify:obsidian` exits 0 but `errors:obsidian` continues to report repeated Obsidian app-level `this.owner.syncScroll is not a function` errors. This appears unrelated to the Hermes availability feature based on the stack captured, but it should remain visible to the human reviewer.
2. Obsidian CLI `dev:screenshot` captured the board view rather than the modal overlay, so modal verification relied on live DOM evaluation. The DOM checks were deterministic and exercised the actual desktop plugin instance.
3. The manual command is rendered as text, not a dedicated copy-to-clipboard button. Treat as acceptable unless the acceptance wording requires one-click copy.

## Readiness

Ready for human review/merge from QA perspective. The only caveats are the unrelated Obsidian `syncScroll` error noise and the manual-command-as-text interpretation noted above.
