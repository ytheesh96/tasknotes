import {
	HERMES_ACTIVITY_FIELD_KEYS,
	buildHermesActivityFrontmatterProperties,
	buildHermesActivityNoteSpecs,
	buildHermesActivitySnapshot,
	hasHermesActivitySnapshotContentChanged,
	normalizeHermesActivitySnapshot,
} from "../../../src/hermes/hermesActivityFrontmatter";

describe("Hermes activity frontmatter snapshots", () => {
	it("serializes recent review-thread activity with stable counts", () => {
		const snapshot = buildHermesActivitySnapshot(
			{
				comments: [{ author: "reviewer", body: "Needs review.", created_at: 1770000000 }],
				runs: [{ id: "7", status: "blocked", profile: "reviewer-qa" }],
				events: [{ kind: "review_required", payload: { summary: "Open the diff." } }],
			},
			{ now: "2026-06-02T02:00:00Z" }
		);

		expect(snapshot).toMatchObject({
			syncedAt: "2026-06-02T02:00:00Z",
			commentCount: 1,
			runCount: 1,
			eventCount: 1,
		});
		expect(snapshot.comments[0]).toEqual(
			expect.objectContaining({ author: "reviewer", body: "Needs review." })
		);
		expect(snapshot.events[0]).toEqual(
			expect.objectContaining({ kind: "review_required", payload: { summary: "Open the diff." } })
		);
	});

	it("preserves syncedAt when activity content is unchanged", () => {
		const existing = normalizeHermesActivitySnapshot({
			syncedAt: "2026-06-02T01:00:00Z",
			commentCount: 1,
			runCount: 0,
			eventCount: 0,
			comments: [{ body: "same" }],
			runs: [],
			events: [],
		});

		const next = buildHermesActivitySnapshot(
			{
				comments: [{ body: "same" }],
				runs: [],
				events: [],
			},
			{ now: "2026-06-02T02:00:00Z", existing }
		);

		expect(next.syncedAt).toBe("2026-06-02T01:00:00Z");
		expect(hasHermesActivitySnapshotContentChanged(existing, next)).toBe(false);
	});

	it("curates raw activity into user-field-compatible frontmatter properties", () => {
		const snapshot = buildHermesActivitySnapshot(
			{
				comments: [
					{
						id: 94,
						author: "auto-decomposer",
						body: "Decomposed into t_e775e4d5, t_867d671a. Root will wake when all children complete.",
					},
					{
						id: 107,
						author: "orchestrator",
						body: [
							"review-required handoff:",
							"```json",
							JSON.stringify({
								summary: "Review the generated card.",
								changed_files: ["src/modals/TaskEditModal.ts"],
								qa_report: "hermes-review-thread-card-qa-report.md",
								artifacts: [
									"/Users/yt/Developer/tasknotes-hermes/hermes-review-thread-card-qa-report.md",
								],
								needs_review: true,
							}),
							"```",
						].join("\n"),
					},
				],
				runs: [
					{
						id: 12,
						profile: "orchestrator",
						outcome: "blocked",
						summary: "Lint blocked. See /Users/yt/Developer/tasknotes-hermes/run-12.md.",
					},
				],
				events: [
					{ kind: "heartbeat", payload: null },
					{ id: 200, kind: "blocked", payload: { reason: "Run blocked." }, run_id: 12 },
					{ id: 201, kind: "unblocked", payload: { reason: "Human review complete." } },
					{ id: 202, kind: "handoff", payload: { summary: "Continue from t_e775e4d5." } },
				],
			},
			{ now: "2026-06-02T02:00:00Z" }
		);

		const frontmatter = buildHermesActivityFrontmatterProperties(snapshot, {
			board: "default",
			taskId: "t_2b5e2172",
		});

		expect(frontmatter).toMatchObject({
			[HERMES_ACTIVITY_FIELD_KEYS.comments]: [
				"[[TaskNotes/default/activity/comments/comment94|Comment 94]]",
				"[[TaskNotes/default/activity/comments/comment107|Comment 107]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.runs]: [
				"[[TaskNotes/default/activity/runs/run12|Run 12]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.events]: [
				"[[TaskNotes/default/activity/events/event201|Event 201]]",
				"[[TaskNotes/default/activity/events/event202|Event 202]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.artifacts]: [
				"[[hermes-review-thread-card-qa-report.md]]",
				"file:///Users/yt/Developer/tasknotes-hermes/hermes-review-thread-card-qa-report.md",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.changedFiles]: ["src/modals/TaskEditModal.ts"],
		});
		expect(frontmatter).not.toHaveProperty("hermesActivityComments");
		expect(frontmatter).not.toHaveProperty("hermesActivityRuns");
		expect(frontmatter).not.toHaveProperty("hermesComments");
		expect(frontmatter).not.toHaveProperty("hermesRuns");
		expect(frontmatter).not.toHaveProperty("comment94Summary");
		expect(frontmatter).not.toHaveProperty("run12Summary");
		expect(frontmatter).not.toHaveProperty("event202Summary");
		expect(frontmatter).not.toHaveProperty("hermesActivityCommentCount");
		expect(frontmatter).not.toHaveProperty("hermesActivityLatestComment");

		const notes = buildHermesActivityNoteSpecs(snapshot, {
			board: "default",
			taskId: "t_2b5e2172",
		});
		expect(notes.map((note) => note.path)).toEqual([
			"TaskNotes/default/activity/comments/comment94.md",
			"TaskNotes/default/activity/comments/comment107.md",
			"TaskNotes/default/activity/runs/run12.md",
			"TaskNotes/default/activity/events/event201.md",
			"TaskNotes/default/activity/events/event202.md",
		]);
		expect(notes.find((note) => note.path.endsWith("comment94.md"))?.frontmatter).toMatchObject({
			type: "hermes-comment",
			task: "[[TaskNotes/default/t_2b5e2172|t_2b5e2172]]",
			commentId: "94",
			author: "auto-decomposer",
			kind: "comment",
			summary:
				"Decomposed into t_e775e4d5, t_867d671a. Root will wake when all children complete.",
			tasks: [
				"[[TaskNotes/default/t_e775e4d5|t_e775e4d5]]",
				"[[TaskNotes/default/t_867d671a|t_867d671a]]",
			],
		});
		expect(notes.find((note) => note.path.endsWith("comment107.md"))?.frontmatter).toMatchObject({
			type: "hermes-comment",
			kind: "review-required",
			summary: "Review the generated card.",
			artifacts: [
				"[[hermes-review-thread-card-qa-report.md]]",
				"file:///Users/yt/Developer/tasknotes-hermes/hermes-review-thread-card-qa-report.md",
			],
		});
		expect(notes.find((note) => note.path.endsWith("run12.md"))?.frontmatter).toMatchObject({
			type: "hermes-run",
			runId: "12",
			profile: "orchestrator",
			outcome: "blocked",
			summary: "Lint blocked. See /Users/yt/Developer/tasknotes-hermes/run-12.md.",
			artifacts: ["file:///Users/yt/Developer/tasknotes-hermes/run-12.md"],
		});
		expect(notes.find((note) => note.path.endsWith("event202.md"))?.frontmatter).toMatchObject({
			type: "hermes-event",
			eventId: "202",
			kind: "handoff",
			summary: "Continue from t_e775e4d5.",
			tasks: ["[[TaskNotes/default/t_e775e4d5|t_e775e4d5]]"],
		});
	});
});
