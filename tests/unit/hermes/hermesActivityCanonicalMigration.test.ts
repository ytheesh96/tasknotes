import type { TaskInfo } from "../../../src/types";
import { planHermesActivityMirrorMigration } from "../../../src/hermes/hermesCanonicalMigration";

function activityNote(path: string, customProperties: Record<string, unknown>): TaskInfo {
	return {
		title: path.split("/").pop() ?? path,
		status: "done",
		priority: "normal",
		path,
		tags: [],
		contexts: [],
		projects: [],
		archived: false,
		customProperties,
	};
}

describe("Hermes canonical activity mirror migration", () => {
	it("inventories legacy per-board activity by hermesTaskId without treating board folders as identity", () => {
		const plan = planHermesActivityMirrorMigration([
			activityNote("TaskNotes/default/activity/comments/t_activity-comment11.md", {
				type: "hermes-comment",
				hermesTaskId: "t_activity",
				hermesBoard: "developer",
				hermesCommentId: "11",
			}),
			activityNote("TaskNotes/old-board/activity/runs/t_activity-run142.md", {
				type: "hermes-run",
				hermesTaskId: "t_activity",
				hermesBoard: "developer",
				hermesRunId: "142",
			}),
			activityNote("TaskNotes/Activity/t_activity/comments/t_activity-comment11.md", {
				type: "hermes-comment",
				hermesTaskId: "t_activity",
				hermesBoard: "developer",
				hermesCommentId: "11",
			}),
		]);

		expect(plan.legacy.length).toBe(1);
		expect(plan.legacy.map((item) => item.fromPath)).toEqual([
			"TaskNotes/old-board/activity/runs/t_activity-run142.md",
		]);
		expect(plan.legacy.map((item) => item.toPath)).toEqual([
			"TaskNotes/Activity/t_activity/runs/t_activity-run142.md",
		]);
		expect(plan.legacy.every((item) => item.action === "copy" && item.destructive === false)).toBe(true);
		expect(plan.duplicates).toEqual([
			{
				taskId: "t_activity",
				activityType: "comments",
				canonicalPath: "TaskNotes/Activity/t_activity/comments/t_activity-comment11.md",
				paths: [
					"TaskNotes/Activity/t_activity/comments/t_activity-comment11.md",
					"TaskNotes/default/activity/comments/t_activity-comment11.md",
				],
			},
		]);
	});

	it("deduplicates repeated legacy entries that map to the same canonical activity path", () => {
		const plan = planHermesActivityMirrorMigration([
			activityNote("TaskNotes/default/activity/comments/t_repeat-comment1.md", {
				type: "hermes-comment",
				hermesTaskId: "t_repeat",
				hermesCommentId: "1",
			}),
			activityNote("TaskNotes/default/activity/comments/t_repeat-comment1.md", {
				type: "hermes-comment",
				hermesTaskId: "t_repeat",
				hermesCommentId: "1",
			}),
		]);

		expect(plan.legacy).toHaveLength(1);
		expect(plan.duplicates).toEqual([]);
	});
});
