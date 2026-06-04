import { TFile } from "obsidian";
import { EVENT_TASK_DELETED, EVENT_TASK_UPDATED, type TaskInfo } from "../../../src/types";
import {
	getHermesManagedBoardFromTaskEvent,
	shouldHandleHermesTaskEvent,
	syncHermesManagedTaskFromHermes,
	syncHermesManagedTasksFromHermes,
} from "../../../src/hermes/hermesTaskSync";
import { HermesApiError, type HermesTaskRecord } from "../../../src/hermes/hermesApiClient";

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
			comments: [{ author: "worker", body: "done", created_at: 1770000000 }],
			runs: [{ id: "1", status: "done", profile: "default" }],
			events: [{ kind: "completed", payload: { summary: "done" } }],
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: updatedTask });
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.updated).toBe(1);
		expect(api.getBoard).toHaveBeenCalledWith("default", { includeArchived: true });
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			remoteTask,
			expect.objectContaining({
				parents: ["t_parent"],
				children: ["t_child"],
					activity: expect.objectContaining({
						commentCount: 1,
						runCount: 1,
						eventCount: 1,
					}),
				})
			);
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
		const localTaskDeleter = jest.fn().mockResolvedValue(undefined);
		const plugin = createPlugin([knownLocalTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, {
			api,
			mirrorWriter,
			localTaskDeleter,
		});

		expect(result.updated).toBe(1);
		expect(result.deleted).toBe(1);
		expect(result.skipped).toBe(0);
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_missing" });
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			remoteTask,
			expect.objectContaining({
				parents: [],
				children: [],
			})
		);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: mirroredTask.path,
			updatedTask: mirroredTask,
		});
		expect(localTaskDeleter).toHaveBeenCalledWith(plugin, knownLocalTask);
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
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			remoteTask,
			expect.objectContaining({
				parents: [],
				children: [],
			})
		);
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
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			remoteTask,
			expect.objectContaining({
				parents: [],
				children: [],
			})
		);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: mirroredTask.path,
			updatedTask: mirroredTask,
		});
	});

	it("deletes a local mirror when a Hermes task event reports the live task is gone", async () => {
		const localTask = createTask();
		const api = {
			getTask: jest
				.fn()
				.mockRejectedValue(new HermesApiError("task t_sync not found", 404, "Not Found")),
		};
		const localTaskDeleter = jest.fn().mockResolvedValue(undefined);
		const plugin = createPlugin([localTask]);

		const changed = await syncHermesManagedTaskFromHermes(
			plugin,
			{ board: "default", id: "t_sync" },
			{ api, localTaskDeleter }
		);

		expect(changed).toBe(true);
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(localTaskDeleter).toHaveBeenCalledWith(plugin, localTask);
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

	it("does not rewrite a task that already matches Hermes activity", async () => {
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
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			comments: [],
			runs: [],
			events: [],
		});
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.tasksChecked).toBe(1);
		expect(result.updated).toBe(0);
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(mirrorWriter).not.toHaveBeenCalled();
		expect(plugin.emitter.trigger).not.toHaveBeenCalled();
	});

	it("refreshes a matching task when only Hermes review-thread activity changed", async () => {
		const localTask = createTask({
			status: "done",
			priority: "normal",
			contexts: ["codex"],
			customProperties: {
				hermesActivity: {
					syncedAt: "2026-06-02T01:00:00Z",
					commentCount: 0,
					runCount: 0,
					eventCount: 0,
					comments: [],
					runs: [],
					events: [],
				},
			},
		});
		const remoteTask = createRemoteTask({
			status: "done",
			priority: 5,
			assignee: "codex",
		});
		const updatedTask = {
			...localTask,
			customProperties: {
				hermesActivity: {
					syncedAt: "2026-06-02T02:00:00Z",
					commentCount: 1,
					runCount: 0,
					eventCount: 0,
					comments: [{ author: "reviewer", body: "Needs review." }],
					runs: [],
					events: [],
				},
			},
		};
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			comments: [{ author: "reviewer", body: "Needs review." }],
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: updatedTask });
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.updated).toBe(1);
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			remoteTask,
			expect.objectContaining({
				activity: expect.objectContaining({
					commentCount: 1,
					comments: [expect.objectContaining({ body: "Needs review." })],
				}),
			})
		);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: updatedTask.path,
			originalTask: localTask,
			updatedTask,
		});
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
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			comments: [],
			runs: [],
			events: [],
		});
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.tasksChecked).toBe(1);
		expect(result.updated).toBe(0);
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
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

	it("deletes local Hermes mirrors that are missing from a loaded board", async () => {
		const staleTask = createTask({
			path: "TaskNotes/default/t_gone.md",
			title: "Gone from Hermes",
		});
		const api = createApi({ boardTasks: [], detailTask: createRemoteTask() });
		const localTaskDeleter = jest.fn().mockResolvedValue(undefined);
		const plugin = createPlugin([staleTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, localTaskDeleter });

		expect(result.deleted).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.failed).toBe(0);
		expect(api.getBoard).toHaveBeenCalledWith("default", { includeArchived: true });
		expect(api.getTask).not.toHaveBeenCalled();
		expect(localTaskDeleter).toHaveBeenCalledWith(plugin, staleTask);
	});

	it("emits a deletion event when using the default local mirror deleter", async () => {
		const staleTask = createTask({
			path: "TaskNotes/default/t_gone.md",
			title: "Gone from Hermes",
		});
		const staleFile = new TFile(staleTask.path);
		const api = createApi({ boardTasks: [], detailTask: createRemoteTask() });
		const plugin = createPlugin([staleTask], staleFile);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api });

		expect(result.deleted).toBe(1);
		expect(plugin.app.fileManager.trashFile).toHaveBeenCalledWith(staleFile);
		expect(plugin.cacheManager.clearCacheEntry).toHaveBeenCalledWith(staleTask.path);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_DELETED, {
			path: staleTask.path,
			deletedTask: staleTask,
		});
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
			detailTasks: {
				t_same: sameRemote,
				t_changed: changedRemote,
			},
			comments: [],
			runs: [],
			events: [],
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
		expect(api.getTask).toHaveBeenCalledTimes(2);
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_same" });
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_changed" });
	});

	it("ignores noisy Hermes task events", () => {
		expect(shouldHandleHermesTaskEvent("heartbeat")).toBe(false);
		expect(shouldHandleHermesTaskEvent("spawned")).toBe(true);
		expect(shouldHandleHermesTaskEvent("completed")).toBe(true);
		expect(shouldHandleHermesTaskEvent("claimed")).toBe(true);
	});
});

function createPlugin(tasks: TaskInfo[], file: unknown = null): any {
	const frontmatterByPath = new Map(
		tasks.map((task) => [
			task.path,
			{
				frontmatter: {
					...(task.customProperties ?? {}),
				},
			},
		])
	);
	return {
		app: {
			metadataCache: {
				getCache: jest.fn((path: string) => frontmatterByPath.get(path) ?? null),
				getFileCache: jest.fn((file: { path: string }) => frontmatterByPath.get(file.path) ?? null),
			},
			vault: {
				getAbstractFileByPath: jest.fn(() => file),
			},
			fileManager: {
				trashFile: jest.fn().mockResolvedValue(undefined),
			},
		},
			cacheManager: {
				getAllTasks: jest.fn().mockResolvedValue(tasks),
				getTaskInfo: jest.fn().mockImplementation((path: string) => {
					return Promise.resolve(tasks.find((task) => task.path === path) ?? null);
				}),
				clearCacheEntry: jest.fn(),
			},
		emitter: {
			trigger: jest.fn(),
		},
	} as never;
}

function createApi(options: {
	boardTasks: HermesTaskRecord[];
	detailTask: HermesTaskRecord;
	detailTasks?: Record<string, HermesTaskRecord>;
	parents?: string[];
	children?: string[];
	comments?: unknown[];
	runs?: unknown[];
	events?: unknown[];
}) {
	return {
		getBoard: jest.fn().mockResolvedValue({
			columns: [{ name: "all", tasks: options.boardTasks }],
		}),
		getTask: jest.fn().mockImplementation(({ id }: { id: string }) => ({
			task: options.detailTasks?.[id] ?? options.detailTask,
			links: {
				parents: options.parents ?? [],
				children: options.children ?? [],
			},
			comments: options.comments ?? [{ author: "worker", body: "done", created_at: 1770000000 }],
			runs: options.runs ?? [{ id: "1", status: "done", profile: "default" }],
			events: options.events ?? [{ kind: "completed", payload: { summary: "done" } }],
		})),
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
