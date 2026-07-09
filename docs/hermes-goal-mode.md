# Hermes Goal Mode cards

TaskNotes can create a Hermes goal mode card directly from Obsidian.

## Setup

1. Run Hermes with the Kanban HTTP plugin available at the default local endpoint:

    `http://127.0.0.1:9119/api/plugins/kanban`

    The TaskNotes bridge uses the existing `HermesKanbanApiClient`; if the Hermes session requires auth, the client loads the browser session token from the Hermes web UI root page and retries once with a bearer authorization header.

2. In Obsidian, enable this plugin and open the command palette.

3. Run `TaskNotes: Create hermes goal mode card`.

## What gets created

The command opens the normal TaskNotes creation modal in a Goal Mode variant. On submit it:

- validates that a Hermes board is selected;
- validates the selected assignee against Hermes routing rules;
- maps TaskNotes title, details/body, status, priority, assignee, board, and dependencies to the Hermes card create request;
- creates the Hermes card through the Kanban API;
- adds a Hermes card comment containing the Goal Mode markers `hermes_card_mode: goal` and `hermes_mode: goal` plus TaskNotes metadata (Hermes Kanban does not currently expose arbitrary per-task metadata on open cards);
- creates or updates the Obsidian mirror note at `TaskNotes/<board>/<task-id>.md`;
- marks the mirror note with `hermesCardMode: goal`, `hermesMode: goal`, and the `hermes-goal` tag so the card ID/link is visible in Obsidian.

## Field mapping

| TaskNotes field                    | Hermes field                              |
| ---------------------------------- | ----------------------------------------- |
| title                              | `title`                                   |
| details                            | `body`                                    |
| status                             | `status` (`triage` when missing)          |
| priority `high` / `normal` / `low` | `8` / `5` / `2`                           |
| contexts/assignee                  | `assignee`                                |
| board project `Hermes/<board>`     | Kanban API `board` query parameter        |
| blocked-by items                   | `parents`                                 |
| blocking items                     | links created with the new card as parent |

## Error handling

The modal surfaces failures and partial successes as Obsidian notices:

- missing board: `Choose a board before submitting.`
- invalid board/assignee routing: validation error from the routing helper
- failed auth or failed card creation: Hermes API error text, including 401/403 responses when a session token cannot be loaded
- duplicate/rapid submit protection: the submit action is disabled while a request is in flight, and Goal Mode creates include a stable `idempotency_key` derived from the board and submitted card content so a retry of the same card does not create another Hermes card
- partial post-create sync failure: if the Hermes card exists but TaskNotes cannot finish the Goal Mode comment, dependency links, task detail fetch, or mirror note sync, the notice names the existing card ID and tells the user not to submit again until the mirror/comment is reconciled
- unresolved dependencies: the card is created, then a notice lists dependencies that could not be linked

No API secrets or session tokens are stored in notes. The generated mirror note only stores stable task metadata and the Hermes task ID in its path.
