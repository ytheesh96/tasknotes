import type { TaskInfo } from "../../../src/types";
import {
	HERMES_TASKNOTES_TASK_EVENTS,
	buildHermesTaskNotesBoardQuery,
	buildHermesTaskNotesExecutionUpdatePayload,
	buildHermesTaskNotesWebhookConfig,
	getHermesTaskNotesBoardFromTaskEvent,
	getHermesTaskNotesEligibleBoards,
	isHermesTaskNotesEligibleTask,
} from "../../../src/hermes/hermesTaskNotesApiSync";

describe("Hermes TaskNotes API sync contract", () => {
	it("treats TaskNotes board-folder paths as eligible without requiring legacy frontmatter", () => {
		const task = createTask({
			path: "TaskNotes/hhmi/t_123.md",
			tags: ["task"],
			projects: ["Hermes/hhmi"],
		});

		expect(isHermesTaskNotesEligibleTask(task)).toBe(true);
		expect(
			isHermesTaskNotesEligibleTask(task, {
				boards: ["hhmi"],
				tags: ["hermes-kanban"],
			})
		).toBe(false);
		expect(
			isHermesTaskNotesEligibleTask(
				{ ...task, tags: ["task", "hermes-kanban"] },
				{
					boards: ["hhmi"],
					tags: ["hermes-kanban"],
				}
			)
		).toBe(true);
	});

	it("collects eligible boards from TaskNotes tasks", () => {
		const tasks = [
			createTask({ path: "TaskNotes/hhmi/t_1.md", status: "ready" }),
			createTask({ path: "TaskNotes/default/t_2.md", status: "done" }),
			createTask({ path: "TaskNotes/hhmi/t_3.md", archived: true }),
			createTask({ path: "Other/t_4.md", status: "ready" }),
		];

		expect(getHermesTaskNotesEligibleBoards(tasks, { statuses: ["ready", "done"] })).toEqual([
			"default",
			"hhmi",
		]);
	});

	it("extracts board identity from task lifecycle webhook-style event data", () => {
		const task = createTask({
			path: "TaskNotes/job-hunt/t_abc.md",
			tags: ["task", "hermes-kanban"],
		});

		expect(
			getHermesTaskNotesBoardFromTaskEvent({ updatedTask: task }, { tags: ["hermes-kanban"] })
		).toBe("job-hunt");
		expect(
			getHermesTaskNotesBoardFromTaskEvent({ deletedTask: { ...task, archived: true } })
		).toBeNull();
	});

	it("builds a TaskNotes webhook config for task lifecycle events", () => {
		const webhook = buildHermesTaskNotesWebhookConfig({
			url: "http://127.0.0.1:9120/tasknotes/webhook",
			secret: "secret",
			createdAt: "2026-06-03T12:00:00.000Z",
		});

		expect(webhook).toMatchObject({
			id: "hermes-tasknotes-sync",
			url: "http://127.0.0.1:9120/tasknotes/webhook",
			secret: "secret",
			active: true,
			corsHeaders: true,
			createdAt: "2026-06-03T12:00:00.000Z",
			failureCount: 0,
			successCount: 0,
		});
		expect(webhook.events).toEqual(HERMES_TASKNOTES_TASK_EVENTS);
		expect(webhook.events).not.toContain("time.started");
	});

	it("builds the HTTP API query Hermes should use for board reconciliation", () => {
		const query = buildHermesTaskNotesBoardQuery({
			board: "hhmi",
			tag: "hermes-kanban",
			statuses: ["ready", "review"],
		});

		expect(query).toMatchObject({
			type: "group",
			id: "hermes-tasknotes-root",
			conjunction: "and",
			sortKey: "dateModified",
			sortDirection: "desc",
		});
		expect(query.children).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "not-archived",
					property: "archived",
					operator: "is-not-checked",
				}),
				expect.objectContaining({
					id: "project",
					property: "projects",
					operator: "contains",
					value: "Hermes/hhmi",
				}),
				expect.objectContaining({
					id: "tag",
					property: "tags",
					operator: "contains",
					value: "hermes-kanban",
				}),
				expect.objectContaining({
					id: "statuses",
					conjunction: "or",
				}),
			])
		);
	});

	it("builds a conservative TaskNotes API update payload for Hermes writeback", () => {
		const payload = buildHermesTaskNotesExecutionUpdatePayload({
			status: "review",
			assignee: "yt",
			priority: "high",
			blockedBy: [{ uid: "[[TaskNotes/hhmi/t_parent]]", reltype: "FINISHTOSTART" }],
			artifactFieldKey: "hermesArtifacts",
			artifactLinks: ["file:///tmp/result.md"],
			activitySummaryFieldKey: "hermesLatestActivity",
			activitySummary: "Ready for review",
		});

		expect(payload).toEqual({
			status: "review",
			contexts: ["yt"],
			priority: "high",
			blockedBy: [{ uid: "[[TaskNotes/hhmi/t_parent]]", reltype: "FINISHTOSTART" }],
			customProperties: {
				hermesArtifacts: ["file:///tmp/result.md"],
				hermesLatestActivity: "Ready for review",
			},
		});
	});
});

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Task",
		status: "ready",
		priority: "normal",
		path: "TaskNotes/default/t_123.md",
		archived: false,
		tags: ["task", "hermes-kanban"],
		contexts: [],
		projects: ["Hermes/default"],
		...overrides,
	};
}
