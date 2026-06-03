# Hermes review-thread card QA report

Task: t_09c011b7 — QA the Hermes review-thread card behavior
Workspace: /Users/yt/Developer/tasknotes-hermes

## Verdict

PASS with no merge-blocking issues found.

Post-QA follow-up: pinned review-required cards now preserve the original comment text behind `View raw`, including prefixes/fences/prose, while keeping raw JSON hidden by default.

## Acceptance criteria

- Review-required JSON: PASS
  - Parser test covers prefixed fenced review-required JSON and raw JSON with `needs_review: true`.
  - Modal test verifies raw review-required JSON renders as a structured pinned card, not as primary raw JSON.

- Handoff JSON: PASS
  - Parser tests cover prefixed prose plus JSON and plain JSON handoffs.
  - Modal test covers non-pinned handoff comments as structured cards.

- Run/artifact style payloads: PASS
  - Existing modal tests cover event payload objects rendered as visual fields instead of raw JSON.
  - Event/action tests cover artifact and task-id actions from run/event payload rows.

- Fenced JSON: PASS
  - Parser tests cover fenced JSON in both review-required and handoff examples.

- Prefixed prose plus JSON: PASS
  - Parser test confirms first valid JSON object is parsed after malformed prose braces.

- Malformed JSON: PASS
  - Parser test confirms malformed JSON does not throw and falls back to `kind: comment`.
  - Missing polish test: no TaskEditModal render-level malformed-JSON assertion; parser-level coverage is sufficient for this requirement because modal rendering keys off parser `kind`.

- Ordinary comments: PASS
  - Parser test covers ordinary user comment.
  - Modal test verifies ordinary/non-Hermes comment keeps plain rendering and has no View raw/action controls.

- Raw JSON hidden behind View raw: PASS
  - Modal tests assert JSON field names are absent before clicking `View raw` and present after clicking it.
  - Implementation uses `renderHermesRawToggle`, initially only rendering the toggle button and inserting `<pre>` after click.

- Artifact actions use existing behavior where possible: PASS
  - Modal action handler calls `plugin.openHermesArtifactPath(action.value)` for artifact actions and `plugin.openHermesTaskEditModalById(...)` for task actions.
  - Tests verify local path and URL artifact buttons call `openHermesArtifactPath`.

- Unrelated TaskEditModal behavior unchanged: PASS based on targeted regression coverage.
  - TaskEditModal unsaved-changes, projects-with-commas, and Hermes layout tests all pass.

## Verification commands run

- `npm test -- tests/unit/hermes/hermesCommentParser.test.ts tests/unit/modals/TaskEditModal.hermes-activity-layout.test.ts --runInBand`
  - PASS: 2 suites, 20 tests.

- `npm run typecheck && npm run build:test`
  - PASS: TypeScript check passed; build/test copy completed.

- `npm test -- tests/unit/modals/TaskEditModal.unsaved-changes.test.ts tests/unit/modals/TaskEditModal.projects-with-commas.test.ts tests/unit/modals/TaskEditModal.hermes-activity-layout.test.ts --runInBand`
  - PASS: 3 suites, 36 tests.

- `npm run lint`
  - FAIL, but not attributed to this review-thread card behavior. Output matches previously reported unrelated/pre-existing issues: 8 ESLint warnings in i18n/taskCreationSuggest/projectsPropertyCard plus 3 architecture-conformance violations in `src/hermes/hermesBoardProvisioning.ts`.

## Blocking issues

None.

## Follow-up polish

1. Consider adding a TaskEditModal malformed-JSON render test to complement the parser malformed-JSON fallback test.
