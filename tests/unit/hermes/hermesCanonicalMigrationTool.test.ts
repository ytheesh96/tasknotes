import {
	applyHermesCanonicalBackfill,
	createHermesCanonicalMigrationReport,
} from "../../../src/hermes/hermesCanonicalMigrationTool";

const LEGACY_TASK = `---
hermes_task_id: t_legacy
hermes_board: developer
hermes_archived: false
status: ready
---
# Legacy task
`;

const CANONICAL_TASK = `---
hermesTaskId: t_legacy
hermesBoard: developer
hermesArchived: false
---
# Canonical task
`;

const LEGACY_ACTIVITY = `---
type: hermes-comment
hermes_task_id: t_legacy
hermes_board: developer
hermes_comment_id: 42
---
Comment body
`;

describe("Hermes canonical migration tooling", () => {
	it("produces an inventory and duplicate/orphan report without modifying files in dry-run mode", async () => {
		const writes: Array<{ path: string; content: string }> = [];
		const files = new Map([
			["TaskNotes/developer/t_legacy.md", LEGACY_TASK],
			["TaskNotes/Tasks/t_legacy.md", CANONICAL_TASK],
			["TaskNotes/developer/t_orphan.md", LEGACY_TASK.replaceAll("t_legacy", "t_orphan")],
			["TaskNotes/developer/activity/comments/t_legacy-comment42.md", LEGACY_ACTIVITY],
		]);

		const result = await applyHermesCanonicalBackfill({
			dryRun: true,
			remoteTaskIdsByBoard: { developer: ["t_legacy"] },
			vault: {
				listMarkdownFiles: async () => [...files.keys()],
				read: async (path) => files.get(path) ?? "",
				write: async (path, content) => {
					writes.push({ path, content });
				},
			},
		});

		expect(writes).toEqual([]);
		expect(result.report.summary).toEqual({
			totalMarkdownFiles: 4,
			hermesTaskMirrors: 3,
			hermesActivityMirrors: 1,
			propertyBackfills: 4,
			mirrorRelocations: 1,
			activityRelocations: 1,
			duplicateTaskGroups: 1,
			duplicateActivityGroups: 0,
			orphanedTaskMirrors: 1,
			orphanedActivityMirrors: 0,
			destructiveCleanupCandidates: 2,
		});
		expect(result.writes).toEqual([]);
		expect(result.report.taskMirrorPlan.duplicates).toEqual([
			{
				taskId: "t_legacy",
				board: "developer",
				canonicalPath: "TaskNotes/Tasks/t_legacy.md",
				paths: ["TaskNotes/Tasks/t_legacy.md", "TaskNotes/developer/t_legacy.md"],
			},
		]);
		expect(result.report.taskMirrorPlan.orphans).toEqual([
			{
				taskId: "t_orphan",
				board: "developer",
				path: "TaskNotes/developer/t_orphan.md",
				reason: "missing-from-hermes-board",
			},
		]);
		expect(result.report.activityRelocations).toEqual([
			{
				taskId: "t_legacy",
				board: "developer",
				activityType: "comments",
				fromPath: "TaskNotes/developer/activity/comments/t_legacy-comment42.md",
				toPath: "TaskNotes/Activity/t_legacy/comments/t_legacy-comment42.md",
				action: "copy",
				destructive: false,
				reason: "legacy-board-activity-path",
			},
		]);
	});

	it("defaults to dry-run even if canonical property writes are requested", async () => {
		const writes: Array<{ path: string; content: string }> = [];
		const files = new Map([["TaskNotes/developer/t_legacy.md", LEGACY_TASK]]);

		const result = await applyHermesCanonicalBackfill({
			writeCanonicalProperties: true,
			vault: {
				listMarkdownFiles: async () => [...files.keys()],
				read: async (path) => files.get(path) ?? "",
				write: async (path, content) => {
					writes.push({ path, content });
				},
			},
		});

		expect(writes).toEqual([]);
		expect(result.writes).toEqual([]);
		expect(result.report.summary.propertyBackfills).toBe(1);
	});

	it("backfills canonical Hermes properties when writes are explicitly enabled", async () => {
		const writes: Array<{ path: string; content: string }> = [];
		const files = new Map([["TaskNotes/developer/t_legacy.md", LEGACY_TASK]]);

		const result = await applyHermesCanonicalBackfill({
			dryRun: false,
			writeCanonicalProperties: true,
			vault: {
				listMarkdownFiles: async () => [...files.keys()],
				read: async (path) => files.get(path) ?? "",
				write: async (path, content) => {
					writes.push({ path, content });
					files.set(path, content);
				},
			},
		});

		expect(result.writes).toEqual([
			{
				path: "TaskNotes/developer/t_legacy.md",
				action: "backfill-canonical-frontmatter",
				dryRun: false,
			},
		]);
		expect(writes).toHaveLength(1);
		expect(writes[0].content).toContain("hermesTaskId: t_legacy");
		expect(writes[0].content).toContain("hermesBoard: developer");
		expect(writes[0].content).toContain("hermesArchived: false");
		expect(writes[0].content).toContain("hermesSyncVersion: 1");
		expect(writes[0].content).toContain("hermes_task_id: t_legacy");
	});

	it("reports orphaned activity mirrors as gated cleanup candidates", () => {
		const report = createHermesCanonicalMigrationReport(
			[
				{
					path: "TaskNotes/developer/activity/comments/t_missing-comment42.md",
					content: LEGACY_ACTIVITY.replaceAll("t_legacy", "t_missing"),
				},
			],
			{ remoteTaskIdsByBoard: { developer: ["t_other"] } }
		);

		expect(report.summary.orphanedActivityMirrors).toBe(1);
		expect(report.activityOrphans).toEqual([
			{
				taskId: "t_missing",
				board: "developer",
				path: "TaskNotes/developer/activity/comments/t_missing-comment42.md",
				reason: "missing-task-mirror-or-remote-task",
			},
		]);
		expect(report.cleanupCandidates).toEqual([
			{
				path: "TaskNotes/developer/activity/comments/t_missing-comment42.md",
				taskId: "t_missing",
				board: "developer",
				reason: "orphaned-activity-mirror",
				destructive: true,
				requiresApproval: true,
			},
		]);
	});

	it("keeps destructive cleanup gated even when backfill writes are enabled", async () => {
		const report = createHermesCanonicalMigrationReport([
			{ path: "TaskNotes/developer/t_dup.md", content: LEGACY_TASK.replaceAll("t_legacy", "t_dup") },
			{ path: "TaskNotes/Tasks/t_dup.md", content: CANONICAL_TASK.replaceAll("t_legacy", "t_dup") },
		]);

		expect(report.cleanupCandidates).toEqual([
			{
				path: "TaskNotes/developer/t_dup.md",
				taskId: "t_dup",
				board: "developer",
				reason: "duplicate-task-mirror",
				destructive: true,
				requiresApproval: true,
			},
		]);
	});
});
