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
	it("treats canonical TaskNotes task mirrors as eligible without requiring legacy tags", () => {
		const task = createTask({
			path: "TaskNotes/Tasks/t_123.md",
			tags: ["task"],
			projects: [],
			customProperties: { hermesTaskId: "t_123", hermesBoard: "hhmi" },
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
			createTask({ path: "TaskNotes/Tasks/t_1.md", status: "ready", customProperties: { hermesTaskId: "t_1", hermesBoard: "hhmi" } }),
			createTask({ path: "TaskNotes/Tasks/t_2.md", status: "done", customProperties: { hermesTaskId: "t_2", hermesBoard: "default" } }),
			createTask({ path: "TaskNotes/Tasks/t_3.md", archived: true, customProperties: { hermesTaskId: "t_3", hermesBoard: "hhmi" } }),
			createTask({ path: "Other/t_4.md", status: "ready" }),
		];

		expect(getHermesTaskNotesEligibleBoards(tasks, { statuses: ["ready", "done"] })).toEqual([
			"default",
			"hhmi",
		]);
	});

	it("extracts board identity from task lifecycle webhook-style event data", () => {
		const task = createTask({
			path: "TaskNotes/Tasks/t_abc.md",
			tags: ["task"],
			customProperties: { hermesTaskId: "t_abc", hermesBoard: "job-hunt" },
		});

		expect(
			getHermesTaskNotesBoardFromTaskEvent({ updatedTask: task })
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
					id: "board",
					property: "hermesBoard",
					operator: "is",
					value: "hhmi",
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
			blockedBy: [{ uid: "[[TaskNotes/Tasks/t_parent.md]]", reltype: "FINISHTOSTART" }],
			artifactFieldKey: "hermesArtifacts",
			artifactLinks: ["file:///tmp/result.md"],
			activitySummaryFieldKey: "hermesLatestActivity",
			activitySummary: "Ready for review",
		});

		expect(payload).toEqual({
			status: "review",
			contexts: ["yt"],
			priority: "high",
			blockedBy: [{ uid: "[[TaskNotes/Tasks/t_parent.md]]", reltype: "FINISHTOSTART" }],
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
		path: "TaskNotes/Tasks/t_123.md",
		archived: false,
		tags: ["task"],
		contexts: [],
		projects: [],
		customProperties: { hermesTaskId: "t_123", hermesBoard: "default" },
		...overrides,
	};
}
