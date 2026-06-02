import { EVENT_TASK_UPDATED, type TaskInfo } from "../../../src/types";
import { syncHermesManagedTasksFromHermes } from "../../../src/hermes/hermesTaskSync";
import type { HermesTaskRecord } from "../../../src/hermes/hermesApiClient";

describe("Hermes managed task sync", () => {
	it("updates the native TaskNotes note when Hermes status changes", async () => {
		const localTask = createTask({ status: "triage" });
		const remoteTask = createRemoteTask({ status: "done" });
		const updatedTask = { ...localTask, status: "done", completedDate: "2026-06-02T01:00:00Z" };
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			parents: ["t_parent"],
			children: ["t_child"],
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: updatedTask });
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.updated).toBe(1);
		expect(api.getBoard).toHaveBeenCalledWith("default", { includeArchived: true });
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(mirrorWriter).toHaveBeenCalledWith(plugin, "default", remoteTask, {
			parents: ["t_parent"],
			children: ["t_child"],
		});
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: updatedTask.path,
			originalTask: localTask,
			updatedTask,
		});
	});

	it("does not rewrite a task that already matches Hermes", async () => {
		const localTask = createTask({
			status: "done",
			priority: "normal",
			contexts: ["codex"],
		});
		const remoteTask = createRemoteTask({
			status: "done",
			priority: 5,
			assignee: "codex",
		});
		const api = createApi({ boardTasks: [remoteTask], detailTask: remoteTask });
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.tasksChecked).toBe(1);
		expect(result.updated).toBe(0);
		expect(api.getTask).not.toHaveBeenCalled();
		expect(mirrorWriter).not.toHaveBeenCalled();
		expect(plugin.emitter.trigger).not.toHaveBeenCalled();
	});

	it("ignores direct TaskNotes task ids that are not tagged as Hermes managed", async () => {
		const localTask = createTask({ tags: ["task"] });
		const api = createApi({ boardTasks: [createRemoteTask()], detailTask: createRemoteTask() });
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api });

		expect(result.tasksSeen).toBe(0);
		expect(api.getBoard).not.toHaveBeenCalled();
	});

	it("checks each Hermes board once and refreshes only changed tasks", async () => {
		const unchanged = createTask({
			path: "TaskNotes/default/t_same.md",
			status: "ready",
			title: "Same",
		});
		const changed = createTask({
			path: "TaskNotes/default/t_changed.md",
			status: "triage",
			title: "Changed",
		});
		const sameRemote = createRemoteTask({ id: "t_same", title: "Same", status: "ready" });
		const changedRemote = createRemoteTask({
			id: "t_changed",
			title: "Changed",
			status: "done",
		});
		const api = createApi({
			boardTasks: [sameRemote, changedRemote],
			detailTask: changedRemote,
		});
		const mirrorWriter = jest.fn().mockResolvedValue({
			taskInfo: { ...changed, status: "done" },
		});
		const plugin = createPlugin([unchanged, changed]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.boardsChecked).toBe(1);
		expect(result.tasksChecked).toBe(2);
		expect(result.updated).toBe(1);
		expect(api.getBoard).toHaveBeenCalledTimes(1);
		expect(api.getTask).toHaveBeenCalledTimes(1);
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_changed" });
	});
});

function createPlugin(tasks: TaskInfo[]) {
	return {
		cacheManager: {
			getAllTasks: jest.fn().mockResolvedValue(tasks),
		},
		emitter: {
			trigger: jest.fn(),
		},
	} as never;
}

function createApi(options: {
	boardTasks: HermesTaskRecord[];
	detailTask: HermesTaskRecord;
	parents?: string[];
	children?: string[];
}) {
	return {
		getBoard: jest.fn().mockResolvedValue({
			columns: [{ name: "all", tasks: options.boardTasks }],
		}),
		getTask: jest.fn().mockResolvedValue({
			task: options.detailTask,
			links: {
				parents: options.parents ?? [],
				children: options.children ?? [],
			},
		}),
	};
}

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Sync me",
		status: "triage",
		priority: "normal",
		path: "TaskNotes/default/t_sync.md",
		archived: false,
		tags: ["task", "hermes-kanban"],
		contexts: [],
		projects: ["Hermes/default"],
		...overrides,
	};
}

function createRemoteTask(overrides: Partial<HermesTaskRecord> = {}): HermesTaskRecord {
	return {
		id: "t_sync",
		title: "Sync me",
		status: "triage",
		priority: 5,
		assignee: null,
		...overrides,
	};
}
