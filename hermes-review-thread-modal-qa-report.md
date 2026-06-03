# Hermes review-thread modal QA report

Task: t_274bd8a9 — Verify the Hermes review-thread modal implementation
Workspace: /Users/yt/Developer/tasknotes-hermes
Verdict: REQUEST CHANGES

## Summary

Most of the review-thread modal implementation is working: automated build/typecheck/focused tests pass, live Obsidian reload works, blocked/review-required Hermes tasks show a right-rail review thread with a pinned review card, raw JSON is hidden behind View raw, artifact actions are wired, cache-only/startup controls are covered, non-Hermes modal regressions passed, and running-state writeback is still guarded.

One acceptance criterion is not satisfied: submitting a comment from the Hermes review-thread composer writes through the Hermes API, but it closes the task modal instead of refreshing the thread in place. Reopening the modal shows the new comment, so persistence works; the modal UX/refresh behavior needs a focused fix.

## Commands run

- `npm run build:test`
  - PASS. Built CSS, generated release notes bundle, TypeScript build completed, esbuild production bundle completed, and copied 3 files to `/Users/yt/Developer/tasknotes-hermes/tasknotes-e2e-vault/.obsidian/plugins/tasknotes`.

- `obsidian vault=test plugin:reload id=tasknotes`
  - FAIL / blocker for exact requested command. Output: `Unable to connect to main process`.
  - This matches the updated AGENTS.md warning that `vault=test` should not be used unless that vault alias is registered and open.

- `npm test -- tests/unit/modals/TaskEditModal.hermes-activity-layout.test.ts tests/unit/hermes/hermesAvailabilityService.test.ts tests/unit/hermes/hermesCommentParser.test.ts --runInBand`
  - PASS. 3 suites, 29 tests.

- `npm run typecheck && npm run obsidian:status`
  - PASS. `tsc --noEmit` passed. Live Obsidian status found vault `Obsidian`, plugin path `/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes`, TaskNotes version 4.9.2 enabled.

- `npm run verify:obsidian`
  - PASS exit code 0. Built, copied 3 files to `/Users/yt/Documents/Obsidian/.obsidian/plugins/tasknotes`, reloaded plugin, and ran `errors:obsidian`.
  - Caveat: `errors:obsidian` continues to print repeated Obsidian app-level `this.owner.syncScroll is not a function` stacks at `app://obsidian.md/app.js`. No TaskNotes/Hermes stack appeared in the captured output.

- `npm test -- tests/unit/modals/TaskEditModal.unsaved-changes.test.ts tests/unit/modals/TaskEditModal.projects-with-commas.test.ts tests/unit/issues/issue-1921-direct-frontmatter-lifecycle-side-effects.test.ts --runInBand`
  - PASS. 3 suites, 31 tests.

- `npm run lint`
  - FAIL, matching known/pre-existing lint/architecture issues documented by previous QA: 8 ESLint warnings in i18n/taskCreationSuggest/projectsPropertyCard and 3 architecture conformance violations in `src/hermes/hermesBoardProvisioning.ts`.

## Live Obsidian checks

- Opened Hermes task modals via Obsidian CLI with `HOME=/Users/yt obsidian vault=Obsidian eval ...` because the raw `obsidian vault=Obsidian ...` command inherits the Hermes profile HOME and cannot connect.

- Blocked/review-required modal behavior: PASS.
  - The parent implementation modal showed `.tn-task-modal__hermes-review-thread`, a pinned `.tn-task-modal__hermes-review-card--pinned`, chat/thread cards, composer, run history, events, and artifact action buttons.
  - Raw JSON was hidden by default; clicking `.tn-task-modal__hermes-raw-toggle` exposed the raw handoff payload.

- Raw JSON handoffs summarized by default: PASS.
  - Unit tests and live DOM both show readable fields/chips instead of raw `"changed_files"` in primary card text.

- Artifact actions: PASS.
  - Unit tests verify artifact buttons call `plugin.openHermesArtifactPath(...)` for local files and URLs, and task-id actions call `openHermesTaskEditModalById(...)`.
  - Live pinned card displayed artifact buttons such as `Open unreleased.md`, `Open TaskEditModal.ts`, and a diff artifact.

- Board/assignee/status/blocked-by/comments/events/latest run scannability: PASS.
  - Live modal for t_274bd8a9 exposed board/project identity, assignee `reviewer-qa`, status `running`, blocked/dependency surface, comments, events, and latest run chips (`Run 155`, `not verified`).

- Cache-only/startup scope update from t_037ffc04: PASS by focused tests and prior live report.
  - Tests cover disconnected cache-only labeling, disabled comment controls, Start Hermes action, health recheck, live activity reload after startup, and duplicate-start prevention in `HermesAvailabilityService.startDashboard()`.

- Non-Hermes task modal behavior: PASS based on focused regression tests.
  - Unsaved changes and projects-with-commas modal tests passed.

- Running-task writeback guards: PASS by source inspection and regression coverage.
  - `hermesUpdatePayloadFromChanges()` still rejects `status === "running"` with `Running state is claimed by the dispatcher, not TaskNotes.`
  - Live actions are guarded by `ensureHermesLiveForAction()` and unsaved modal changes are checked before action sends.

## Blocking regression / requested change

1. Comment composer closes the modal instead of refreshing the thread in place.

   Evidence:
   - Source: `src/modals/TaskEditModal.ts:1982-1993` calls `sendHermesAction("Comment", ...)` for comment submission.
   - Source: `src/modals/TaskEditModal.ts:1923-1955` implements `sendHermesAction()` and calls `this.forceClose()` after a successful action.
   - Live test: I entered `QA modal comment smoke from reviewer-qa: verifying Hermes API write-through and refresh behavior.` in the t_274bd8a9 review-thread composer and clicked Send. The API write succeeded; `kanban_show(t_274bd8a9)` shows the new `tasknotes` comment. However, the modal count dropped from 3 to 2 immediately after submission. Reopening t_274bd8a9 then showed the new comment in the thread.

   Expected:
   - For review-thread comments, `addComment()` should write through Hermes API, then re-render/refresh `threadList`, run chips, run history/events as appropriate, clear/re-enable the textarea, and keep the modal open.
   - Reserve `forceClose()` for board state actions where closing is intentional.

## Recommendation

Request changes before accepting the implementation. The fix should be narrow: make `handleHermesCommentSubmit()` refresh the current Hermes activity elements in-place after `api.addComment()`/`api.getTask()` instead of routing through the shared `sendHermesAction()` close-on-success helper. Add a modal unit test that asserts successful comment submission calls `addComment`, reloads/render the returned comment, clears/enables the composer, and does not close the modal.
