import { EVENT_TASK_UPDATED, type TaskInfo } from "../../../src/types";
import {
	getHermesManagedBoardFromTaskEvent,
	shouldHandleHermesTaskEvent,
	syncHermesManagedTaskFromHermes,
	syncHermesManagedTasksFromHermes,
} from "../../../src/hermes/hermesTaskSync";
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

	it("backfills remote Hermes tasks that do not have TaskNotes notes yet", async () => {
		const knownLocalTask = createTask({
			path: "TaskNotes/default/t_known.md",
		});
		const remoteTask = createRemoteTask({
			id: "t_missing",
			title: "Created in Hermes",
			status: "todo",
		});
		const mirroredTask = createTask({
			path: "TaskNotes/default/t_missing.md",
			title: "Created in Hermes",
			status: "todo",
		});
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: mirroredTask });
		const plugin = createPlugin([knownLocalTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.updated).toBe(1);
		expect(result.skipped).toBe(1);
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_missing" });
		expect(mirrorWriter).toHaveBeenCalledWith(plugin, "default", remoteTask, {
			parents: [],
			children: [],
		});
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: mirroredTask.path,
			updatedTask: mirroredTask,
		});
	});

	it("refreshes one native note from a Hermes task event", async () => {
		const localTask = createTask({ status: "running" });
		const remoteTask = createRemoteTask({ status: "done" });
		const updatedTask = { ...localTask, status: "done" };
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: updatedTask });
		const plugin = createPlugin([localTask]);

		const changed = await syncHermesManagedTaskFromHermes(
			plugin,
			{ board: "default", id: "t_sync" },
			{ api, mirrorWriter }
		);

		expect(changed).toBe(true);
		expect(plugin.cacheManager.getTaskInfo).toHaveBeenCalledWith("TaskNotes/default/t_sync.md");
		expect(api.getBoard).not.toHaveBeenCalled();
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(mirrorWriter).toHaveBeenCalledWith(plugin, "default", remoteTask, {
			parents: [],
			children: [],
		});
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: updatedTask.path,
			originalTask: localTask,
			updatedTask,
		});
	});

	it("creates a native note for a Hermes task event when the note is missing", async () => {
		const remoteTask = createRemoteTask({
			title: "Created by Hermes event",
			status: "todo",
		});
		const mirroredTask = createTask({
			title: "Created by Hermes event",
			status: "todo",
		});
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: mirroredTask });
		const plugin = createPlugin([]);

		const changed = await syncHermesManagedTaskFromHermes(
			plugin,
			{ board: "default", id: "t_sync" },
			{ api, mirrorWriter }
		);

		expect(changed).toBe(true);
		expect(plugin.cacheManager.getTaskInfo).toHaveBeenCalledWith("TaskNotes/default/t_sync.md");
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(mirrorWriter).toHaveBeenCalledWith(plugin, "default", remoteTask, {
			parents: [],
			children: [],
		});
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: mirroredTask.path,
			updatedTask: mirroredTask,
		});
	});

	it("ignores one-task event refreshes for local tasks outside Hermes management", async () => {
		const localTask = createTask({ tags: ["task"] });
		const api = createApi({
			boardTasks: [createRemoteTask()],
			detailTask: createRemoteTask({ status: "done" }),
		});
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask]);

		const changed = await syncHermesManagedTaskFromHermes(
			plugin,
			{ board: "default", id: "t_sync" },
			{ api, mirrorWriter }
		);

		expect(changed).toBe(false);
		expect(api.getTask).not.toHaveBeenCalled();
		expect(mirrorWriter).not.toHaveBeenCalled();
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

	it("treats Hermes archived tasks as done tasks with the native archive tag", async () => {
		const localTask = createTask({
			status: "done",
			priority: "normal",
			tags: ["task", "hermes-kanban", "archived"],
			archived: true,
		});
		const remoteTask = createRemoteTask({
			status: "archived",
			priority: 5,
		});
		const api = createApi({ boardTasks: [remoteTask], detailTask: remoteTask });
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.tasksChecked).toBe(1);
		expect(result.updated).toBe(0);
		expect(api.getTask).not.toHaveBeenCalled();
		expect(mirrorWriter).not.toHaveBeenCalled();
	});

	it("ignores direct TaskNotes task ids that are not tagged as Hermes managed", async () => {
		const localTask = createTask({ tags: ["task"] });
		const api = createApi({ boardTasks: [createRemoteTask()], detailTask: createRemoteTask() });
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api });

		expect(result.tasksSeen).toBe(0);
		expect(api.getBoard).not.toHaveBeenCalled();
	});

	it("detects Hermes boards from TaskNotes update events for immediate stream subscription", () => {
		expect(
			getHermesManagedBoardFromTaskEvent({
				updatedTask: createTask({ path: "TaskNotes/default/t_sync.md" }),
			})
		).toBe("default");
		expect(
			getHermesManagedBoardFromTaskEvent({
				taskInfo: createTask({ path: "TaskNotes/job-hunt/t_job.md" }),
			})
		).toBe("job-hunt");
		expect(
			getHermesManagedBoardFromTaskEvent({
				updatedTask: createTask({
					path: "TaskNotes/default/t_plain.md",
					tags: ["task"],
				}),
			})
		).toBeNull();
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

	it("ignores noisy Hermes task events", () => {
		expect(shouldHandleHermesTaskEvent("heartbeat")).toBe(false);
		expect(shouldHandleHermesTaskEvent("spawned")).toBe(true);
		expect(shouldHandleHermesTaskEvent("completed")).toBe(true);
		expect(shouldHandleHermesTaskEvent("claimed")).toBe(true);
	});
});

function createPlugin(tasks: TaskInfo[]) {
	return {
		cacheManager: {
			getAllTasks: jest.fn().mockResolvedValue(tasks),
			getTaskInfo: jest.fn().mockImplementation((path: string) => {
				return Promise.resolve(tasks.find((task) => task.path === path) ?? null);
			}),
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
