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
						created_at: 1770000000,
						body: "Decomposed into t_e775e4d5, t_867d671a. Root will wake when all children complete.",
					},
					{
						id: 107,
						author: "orchestrator",
						created_at: 1770000100,
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
						started_at: 1770000200,
						ended_at: 1770000300,
						metadata: { verification: "Focused modal tests passed" },
						summary: "Lint blocked. See /Users/yt/Developer/tasknotes-hermes/run-12.md.",
					},
				],
				events: [
					{ kind: "heartbeat", payload: null },
					{ id: 200, kind: "blocked", payload: { reason: "Run blocked." }, run_id: 12 },
					{
						id: 201,
						kind: "unblocked",
						created_at: 1770000400,
						payload: { reason: "Human review complete." },
					},
					{
						id: 202,
						kind: "handoff",
						created_at: 1770000500,
						payload: { summary: "Continue from t_e775e4d5." },
					},
				],
			},
			{ now: "2026-06-02T02:00:00Z" }
		);

		const frontmatter = buildHermesActivityFrontmatterProperties(snapshot, {
			board: "default",
			taskId: "t_2b5e2172",
		});

		expect(frontmatter).toMatchObject({
			[HERMES_ACTIVITY_FIELD_KEYS.feed]: [
				"[[TaskNotes/Activity/t_2b5e2172/comments/t_2b5e2172-comment94|Comment 94]]",
				"[[TaskNotes/Activity/t_2b5e2172/comments/t_2b5e2172-comment107|Comment 107]]",
				"[[TaskNotes/Activity/t_2b5e2172/runs/t_2b5e2172-run12|Run 12]]",
				"[[TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event200|Event 200]]",
				"[[TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event201|Event 201]]",
				"[[TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event202|Event 202]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.comments]: [
				"[[TaskNotes/Activity/t_2b5e2172/comments/t_2b5e2172-comment94|Comment 94]]",
				"[[TaskNotes/Activity/t_2b5e2172/comments/t_2b5e2172-comment107|Comment 107]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.runs]: [
				"[[TaskNotes/Activity/t_2b5e2172/runs/t_2b5e2172-run12|Run 12]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.events]: [
				"[[TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event200|Event 200]]",
				"[[TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event201|Event 201]]",
				"[[TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event202|Event 202]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.artifacts]: [
				"[[TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-comment107-hermes-review-thread-card-qa-report-16a2e63f|hermes-review-thread-card-qa-report.md]]",
				"[[TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-comment107-hermes-review-thread-card-qa-report-2a79c8ec|hermes-review-thread-card-qa-report.md]]",
				"[[TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-run12-run-12-bb45ac14|run-12.md]]",
			],
			[HERMES_ACTIVITY_FIELD_KEYS.changedFiles]: ["src/modals/TaskEditModal.ts"],
			[HERMES_ACTIVITY_FIELD_KEYS.lastSyncedAt]: "2026-06-02T02:00:00Z",
			[HERMES_ACTIVITY_FIELD_KEYS.version]: 2,
		});
		expect(frontmatter).not.toHaveProperty("comments");
		expect(frontmatter).not.toHaveProperty("runs");
		expect(frontmatter).not.toHaveProperty("events");
		expect(frontmatter).not.toHaveProperty("artifacts");
		expect(frontmatter).not.toHaveProperty("changedFiles");
		expect(frontmatter).not.toHaveProperty("hermesActivityComments");
		expect(frontmatter).not.toHaveProperty("hermesActivityRuns");
		expect(frontmatter).not.toHaveProperty("hermesArtifacts");
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
			"TaskNotes/Activity/t_2b5e2172/comments/t_2b5e2172-comment94.md",
			"TaskNotes/Activity/t_2b5e2172/comments/t_2b5e2172-comment107.md",
			"TaskNotes/Activity/t_2b5e2172/runs/t_2b5e2172-run12.md",
			"TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event200.md",
			"TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event201.md",
			"TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event202.md",
			"TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-comment107-hermes-review-thread-card-qa-report-16a2e63f.md",
			"TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-comment107-hermes-review-thread-card-qa-report-2a79c8ec.md",
			"TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-run12-run-12-bb45ac14.md",
			"TaskNotes/Activity/t_2b5e2172/raw/t_2b5e2172-run12-metadata.md",
			"TaskNotes/Activity/t_2b5e2172/raw/t_2b5e2172-event200-payload.md",
			"TaskNotes/Activity/t_2b5e2172/raw/t_2b5e2172-event201-payload.md",
			"TaskNotes/Activity/t_2b5e2172/raw/t_2b5e2172-event202-payload.md",
		]);
		expect(notes.find((note) => note.path.endsWith("comment94.md"))?.frontmatter).toMatchObject({
			type: "hermes-comment",
			hermesTask: "[[TaskNotes/Tasks/t_2b5e2172|t_2b5e2172]]",
			hermesTaskId: "t_2b5e2172",
			hermesCommentId: "94",
			hermesCommentAuthor: "auto-decomposer",
			hermesCommentKind: "comment",
			hermesCommentCreatedAt: "2026-02-02T02:40:00Z",
			hermesCommentSummary:
				"Decomposed into t_e775e4d5, t_867d671a. Root will wake when all children complete.",
			hermesCommentTasks: [
				"[[TaskNotes/Tasks/t_e775e4d5|t_e775e4d5]]",
				"[[TaskNotes/Tasks/t_867d671a|t_867d671a]]",
			],
		});
		expect(notes.find((note) => note.path.endsWith("comment107.md"))?.frontmatter).toMatchObject({
			type: "hermes-comment",
			hermesCommentKind: "review-required",
			hermesCommentSummary: "Review the generated card.",
			hermesCommentArtifacts: [
				"[[TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-comment107-hermes-review-thread-card-qa-report-16a2e63f|hermes-review-thread-card-qa-report.md]]",
				"[[TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-comment107-hermes-review-thread-card-qa-report-2a79c8ec|hermes-review-thread-card-qa-report.md]]",
			],
		});
		expect(notes.find((note) => note.path.endsWith("run12.md"))?.frontmatter).toMatchObject({
			type: "hermes-run",
			hermesRunId: "12",
			hermesRunProfile: "orchestrator",
			hermesRunOutcome: "blocked",
			hermesRunSummary: "Lint blocked. See /Users/yt/Developer/tasknotes-hermes/run-12.md.",
			hermesRunStartedAt: "2026-02-02T02:43:20Z",
			hermesRunEndedAt: "2026-02-02T02:45:00Z",
			hermesRunSignals: [
				"[[TaskNotes/Activity/t_2b5e2172/events/t_2b5e2172-event200|Event 200]]",
			],
			hermesRunArtifacts: [
				"[[TaskNotes/Activity/t_2b5e2172/artifacts/t_2b5e2172-run12-run-12-bb45ac14|run-12.md]]",
			],
			hermesRunRawMetadata:
				"[[TaskNotes/Activity/t_2b5e2172/raw/t_2b5e2172-run12-metadata|Run metadata]]",
		});
		expect(notes.find((note) => note.path.endsWith("event202.md"))?.frontmatter).toMatchObject({
			type: "hermes-event",
			hermesEventId: "202",
			hermesEventKind: "handoff",
			hermesEventSummary: "Continue from t_e775e4d5.",
			hermesEventCreatedAt: "2026-02-02T02:48:20Z",
			hermesEventTasks: ["[[TaskNotes/Tasks/t_e775e4d5|t_e775e4d5]]"],
		});
		expect(
			notes.find((note) =>
				note.path.endsWith("comment107-hermes-review-thread-card-qa-report-2a79c8ec.md")
			)?.frontmatter
		).toMatchObject({
			type: "hermes-artifact",
			hermesTask: "[[TaskNotes/Tasks/t_2b5e2172|t_2b5e2172]]",
			hermesTaskId: "t_2b5e2172",
			hermesArtifactKind: "report",
			hermesArtifactLabel: "hermes-review-thread-card-qa-report.md",
			hermesArtifactStoredPath:
				"/Users/yt/Developer/tasknotes-hermes/hermes-review-thread-card-qa-report.md",
			hermesArtifactSourceType: "comment",
			hermesArtifactSourceId: "107",
		});
		expect(notes.find((note) => note.path.endsWith("run12-metadata.md"))).toMatchObject({
			frontmatter: {
				type: "hermes-raw",
				hermesTask: "[[TaskNotes/Tasks/t_2b5e2172|t_2b5e2172]]",
				hermesTaskId: "t_2b5e2172",
				hermesRawSourceType: "run",
				hermesRawSourceId: "12",
				hermesRawKind: "metadata",
			},
			body: expect.stringContaining('"verification": "Focused modal tests passed"'),
		});
		expect(notes.find((note) => note.path.endsWith("event202-payload.md"))).toMatchObject({
			frontmatter: {
				type: "hermes-raw",
				hermesTaskId: "t_2b5e2172",
				hermesRawSourceType: "event",
				hermesRawSourceId: "202",
				hermesRawKind: "payload",
			},
			body: expect.stringContaining('"summary": "Continue from t_e775e4d5."'),
		});
	});

	it("scopes activity note paths by task id to avoid cross-task collisions", () => {
		const snapshot = buildHermesActivitySnapshot(
			{
				comments: [{ id: 1, author: "reviewer", body: "Same comment id" }],
				runs: [{ id: 1, status: "done" }],
				events: [{ id: 1, kind: "completed" }],
			},
			{ now: "2026-06-04T02:00:00Z" }
		);

		const firstPaths = buildHermesActivityNoteSpecs(snapshot, {
			board: "default",
			taskId: "t_first123",
		}).map((note) => note.path);
		const secondPaths = buildHermesActivityNoteSpecs(snapshot, {
			board: "default",
			taskId: "t_second45",
		}).map((note) => note.path);

		expect(firstPaths).toEqual([
			"TaskNotes/Activity/t_first123/comments/t_first123-comment1.md",
			"TaskNotes/Activity/t_first123/runs/t_first123-run1.md",
			"TaskNotes/Activity/t_first123/events/t_first123-event1.md",
		]);
		expect(secondPaths).toEqual([
			"TaskNotes/Activity/t_second45/comments/t_second45-comment1.md",
			"TaskNotes/Activity/t_second45/runs/t_second45-run1.md",
			"TaskNotes/Activity/t_second45/events/t_second45-event1.md",
		]);
		expect(new Set([...firstPaths, ...secondPaths]).size).toBe(6);
	});
});
