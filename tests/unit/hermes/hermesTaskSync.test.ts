import { TFile } from "obsidian";
import { EVENT_TASK_DELETED, EVENT_TASK_UPDATED, type TaskInfo } from "../../../src/types";
import {
	getHermesManagedBoardFromTaskEvent,
	shouldHandleHermesTaskEvent,
	syncHermesManagedTaskFromHermes,
	syncHermesManagedTasksFromHermes,
	syncHermesTaskNotesActivityFromHermes,
} from "../../../src/hermes/hermesTaskSync";
import { HermesApiError, type HermesTaskRecord } from "../../../src/hermes/hermesApiClient";
import {
	HERMES_ACTIVITY_FIELD_KEYS,
	buildHermesActivityNoteSpecs,
	buildHermesActivitySnapshot,
} from "../../../src/hermes/hermesActivityFrontmatter";

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

	it("bootstraps remote tasks for active Hermes boards with no local TaskNotes notes yet", async () => {
		const remoteTask = createRemoteTask({
			id: "t_developer",
			title: "Developer board task",
			status: "todo",
		});
		const mirroredTask = createTask({
			path: "TaskNotes/developer/t_developer.md",
			title: "Developer board task",
			status: "todo",
			projects: ["Hermes/developer"],
		});
		const api = createApi({
			boards: [{ slug: "developer", archived: false }],
			boardTasks: [remoteTask],
			detailTask: remoteTask,
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: mirroredTask });
		const plugin = createPlugin([]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result).toMatchObject({
			boardsChecked: 1,
			tasksSeen: 0,
			tasksChecked: 1,
			updated: 1,
			deleted: 0,
		});
		expect(api.listBoards).toHaveBeenCalled();
		expect(api.getBoard).toHaveBeenCalledWith("developer", { includeArchived: true });
		expect(api.getTask).toHaveBeenCalledWith({ board: "developer", id: "t_developer" });
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"developer",
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
		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			"TaskNotes/Tasks/default--t_sync.md"
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
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
		expect(plugin.cacheManager.getTaskInfo).toHaveBeenCalledWith("TaskNotes/Tasks/default--t_sync.md");
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

	it("refreshes one native note when the cache has stale tags for a board-path mirror", async () => {
		const localTask = createTask({
			status: "triage",
			tags: ["task"],
			projects: [],
		});
		const remoteTask = createRemoteTask({ status: "running", assignee: "ops-steward" });
		const updatedTask = { ...localTask, status: "in-progress", contexts: ["ops-steward"] };
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

	it("ignores explicit one-task refreshes for local tasks outside Hermes management", async () => {
		const localTask = createTask({
			path: "Notes/t_sync.md",
			tags: ["task"],
			projects: [],
			customProperties: { hermesBoard: undefined },
		});
		const api = createApi({
			boardTasks: [createRemoteTask()],
			detailTask: createRemoteTask({ status: "done" }),
		});
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask]);

		const changed = await syncHermesManagedTaskFromHermes(
			plugin,
			{ board: "default", id: "t_sync" },
			{ api, localTask, mirrorWriter }
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

	it("preserves stored curated activity sync timestamps when deciding a managed task is unchanged", async () => {
		const storedSyncedAt = "2026-06-02T01:00:00Z";
		const localTask = createTask({
			status: "done",
			priority: "normal",
			contexts: ["codex"],
			customProperties: {
				[HERMES_ACTIVITY_FIELD_KEYS.feed]: [
					"[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]",
				],
				[HERMES_ACTIVITY_FIELD_KEYS.comments]: [
					"[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]",
				],
				[HERMES_ACTIVITY_FIELD_KEYS.lastSyncedAt]: storedSyncedAt,
				[HERMES_ACTIVITY_FIELD_KEYS.version]: 2,
			},
		});
		const remoteTask = createRemoteTask({
			status: "done",
			priority: 5,
			assignee: "codex",
		});
		const activityDetail = {
			comments: [{ id: 1, author: "reviewer", body: "Comment 1", created_at: 1770000000 }],
			runs: [],
			events: [],
		};
		const existingActivityNoteFrontmatter = buildActivityNoteFrontmatterByPath(
			activityDetail,
			storedSyncedAt
		);
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			...activityDetail,
		});
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask], null, existingActivityNoteFrontmatter);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.tasksChecked).toBe(1);
		expect(result.updated).toBe(0);
		expect(result.skipped).toBe(1);
		expect(mirrorWriter).not.toHaveBeenCalled();
		expect(plugin.emitter.trigger).not.toHaveBeenCalled();
	});

	it("does not run activity-only writes when curated activity indexes are unchanged", async () => {
		const storedSyncedAt = "2026-06-02T01:00:00Z";
		const localTask = createTask({
			status: "done",
			priority: "normal",
			contexts: ["codex"],
			customProperties: {
				[HERMES_ACTIVITY_FIELD_KEYS.feed]: [
					"[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]",
				],
				[HERMES_ACTIVITY_FIELD_KEYS.comments]: [
					"[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]",
				],
				[HERMES_ACTIVITY_FIELD_KEYS.lastSyncedAt]: storedSyncedAt,
				[HERMES_ACTIVITY_FIELD_KEYS.version]: 2,
			},
		});
		const remoteTask = createRemoteTask({
			status: "done",
			priority: 5,
			assignee: "codex",
		});
		const activityDetail = {
			comments: [{ id: 1, author: "reviewer", body: "Comment 1", created_at: 1770000000 }],
			runs: [],
			events: [],
		};
		const existingActivityNoteFrontmatter = buildActivityNoteFrontmatterByPath(
			activityDetail,
			storedSyncedAt
		);
		const api = createApi({
			detailTask: remoteTask,
			boardTasks: [remoteTask],
			...activityDetail,
		});
		const activityWriter = jest.fn();
		const mirrorWriter = jest.fn();
		const plugin = createPlugin([localTask], null, existingActivityNoteFrontmatter);

		const result = await syncHermesTaskNotesActivityFromHermes(plugin, {
			api,
			activityWriter,
			mirrorWriter,
		});

		expect(result).toMatchObject({
			tasksSeen: 1,
			tasksChecked: 1,
			updated: 0,
			skipped: 1,
			failed: 0,
		});
		expect(activityWriter).not.toHaveBeenCalled();
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

	it("treats Hermes archived tasks as done tasks with native archived state", async () => {
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

	it("does not emit TaskNotes update events when Hermes-managed fields are unchanged", async () => {
		const localTask = createTask({
			status: "done",
			priority: "normal",
		});
		const remoteTask = createRemoteTask({
			status: "done",
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
		expect(mirrorWriter).not.toHaveBeenCalled();
		expect(plugin.emitter.trigger).not.toHaveBeenCalled();
	});

	it("recognizes canonical TaskNotes board paths when tags are stale", async () => {
		const localTask = createTask({ tags: ["task"], projects: [] });
		const remoteTask = createRemoteTask({ status: "done" });
		const updatedTask = { ...localTask, status: "done" };
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			comments: [],
			runs: [],
			events: [],
		});
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: updatedTask });
		const plugin = createPlugin([localTask]);

		const result = await syncHermesManagedTasksFromHermes(plugin, { api, mirrorWriter });

		expect(result.tasksSeen).toBe(1);
		expect(result.boardsChecked).toBe(1);
		expect(result.updated).toBe(1);
		expect(api.getBoard).toHaveBeenCalledWith("default", { includeArchived: true });
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			remoteTask,
			expect.any(Object)
		);
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
				updatedTask: createTask({ path: "TaskNotes/Tasks/default--t_sync.md" }),
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
					path: "TaskNotes/Tasks/t_plain.md",
					tags: ["task"],
					customProperties: { hermesBoard: undefined },
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

	it("refreshes Hermes activity indexes without running the legacy mirror import", async () => {
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
		const updatedTask = {
			...localTask,
			customProperties: {
				comments: ["[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]"],
			},
		};
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			comments: [{ id: 1, author: "reviewer", body: "Ready", created_at: 1770000000 }],
			runs: [],
			events: [],
		});
		const activityWriter = jest.fn().mockResolvedValue(updatedTask);
		const plugin = createPlugin([localTask]);

		const result = await syncHermesTaskNotesActivityFromHermes(plugin, {
			api,
			activityWriter,
		});

		expect(result).toMatchObject({
			tasksSeen: 1,
			tasksChecked: 1,
			updated: 1,
			missing: 0,
			failed: 0,
		});
		expect(api.getBoard).not.toHaveBeenCalled();
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(activityWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			"t_sync",
			localTask,
			expect.objectContaining({
				commentCount: 1,
				comments: [expect.objectContaining({ body: "Ready" })],
			})
		);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(EVENT_TASK_UPDATED, {
			path: updatedTask.path,
			originalTask: localTask,
			updatedTask,
		});
	});

	it("refreshes TaskNotes kanban fields from the activity detail pull when Hermes changed them", async () => {
		const localTask = createTask({
			status: "triage",
			priority: "normal",
			contexts: [],
		});
		const remoteTask = createRemoteTask({
			status: "todo",
			priority: 5,
			assignee: "orchestrator",
		});
		const updatedTask = {
			...localTask,
			status: "todo",
			contexts: ["orchestrator"],
			blockedBy: [
				{ uid: "[[TaskNotes/default/t_parent]]", reltype: "FINISHTOSTART" as const },
			],
		};
		const api = createApi({
			boardTasks: [remoteTask],
			detailTask: remoteTask,
			parents: ["t_parent"],
			children: ["t_child"],
			comments: [{ id: 1, author: "auto-decomposer", body: "Decomposed", created_at: 1770000000 }],
			runs: [],
			events: [{ id: 7, kind: "decomposed", payload: { root_assignee: "orchestrator" } }],
		});
		const activityWriter = jest.fn();
		const mirrorWriter = jest.fn().mockResolvedValue({ taskInfo: updatedTask });
		const plugin = createPlugin([localTask]);

		const result = await syncHermesTaskNotesActivityFromHermes(plugin, {
			api,
			activityWriter,
			mirrorWriter,
		});

		expect(result).toMatchObject({
			tasksSeen: 1,
			tasksChecked: 1,
			updated: 1,
			missing: 0,
			failed: 0,
		});
		expect(api.getBoard).not.toHaveBeenCalled();
		expect(api.getTask).toHaveBeenCalledWith({ board: "default", id: "t_sync" });
		expect(activityWriter).not.toHaveBeenCalled();
		expect(mirrorWriter).toHaveBeenCalledWith(
			plugin,
			"default",
			remoteTask,
			expect.objectContaining({
				parents: ["t_parent"],
				children: ["t_child"],
				activity: expect.objectContaining({
					commentCount: 1,
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

	it("does not delete local TaskNotes notes when activity sync cannot find the Hermes task", async () => {
		const localTask = createTask();
		const api = {
			getTask: jest
				.fn()
				.mockRejectedValue(new HermesApiError("task t_sync not found", 404, "Not Found")),
		};
		const activityWriter = jest.fn();
		const plugin = createPlugin([localTask]);

		const result = await syncHermesTaskNotesActivityFromHermes(plugin, {
			api,
			activityWriter,
		});

		expect(result).toMatchObject({
			tasksSeen: 1,
			tasksChecked: 1,
			updated: 0,
			missing: 1,
			failed: 0,
		});
		expect(activityWriter).not.toHaveBeenCalled();
		expect(plugin.emitter.trigger).not.toHaveBeenCalled();
		expect(plugin.app.fileManager.trashFile).not.toHaveBeenCalled();
	});
});

function buildActivityNoteFrontmatterByPath(
	detail: { comments: unknown[]; runs: unknown[]; events: unknown[] },
	now: string
): Record<string, Record<string, unknown>> {
	return Object.fromEntries(
		buildHermesActivityNoteSpecs(buildHermesActivitySnapshot(detail, { now }), {
			board: "default",
			taskId: "t_sync",
		}).map((spec) => [spec.path, spec.frontmatter])
	);
}

function createPlugin(
	tasks: TaskInfo[],
	file: unknown = null,
	extraFrontmatterByPath: Record<string, Record<string, unknown>> = {}
): any {
	const frontmatterByPath = new Map([
		...tasks.map(
			(task) =>
				[
					task.path,
					{
						frontmatter: {
							...(task.customProperties ?? {}),
						},
					},
				] as const
		),
		...Object.entries(extraFrontmatterByPath).map(
			([path, frontmatter]) => [path, { frontmatter }] as const
		),
	]);
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
				getTaskInfoFromFrontmatter: jest.fn().mockImplementation((path: string) => {
					return Promise.resolve(tasks.find((task) => task.path === path) ?? null);
				}),
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
	boards?: { slug: string; archived?: boolean | null }[];
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
		listBoards: jest.fn().mockResolvedValue(options.boards ?? [{ slug: "default" }]),
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
	const path = overrides.path ?? "TaskNotes/Tasks/default--t_sync.md";
	const canonicalMatch = path.match(/^TaskNotes\/Tasks\/(.+)--(t_[^/]+)\.md$/);
	const legacyUnqualifiedMatch = path.match(/^TaskNotes\/Tasks\/(t_[^/]+)\.md$/);
	const legacyMatch = path.match(/^TaskNotes\/([^/]+)\/(t_[^/]+)\.md$/);
	const board = canonicalMatch ? canonicalMatch[1] : legacyUnqualifiedMatch ? "default" : legacyMatch ? legacyMatch[1] : null;
	const taskId = canonicalMatch?.[2] ?? legacyUnqualifiedMatch?.[1] ?? legacyMatch?.[2] ?? null;
	const assignee = overrides.contexts?.find((value) => value && value !== "hermes-kanban");
	const baseCustomProperties = taskId && board
		? {
			hermesTaskId: taskId,
			hermesBoard: board,
			hermesArchived: (overrides.archived ?? overrides.status === "archived") === true,
			hermesList: overrides.archived ? "archived" : overrides.status ?? "triage",
			hermesPriority: 5,
			...(assignee ? { hermesAssignee: assignee } : {}),
		}
		: {};
	const customProperties = {
		...baseCustomProperties,
		...(overrides.customProperties ?? {}),
	};
	return {
		title: "Sync me",
		status: "triage",
		priority: "normal",
		archived: false,
		tags: ["task"],
		contexts: [],
		projects: [],
		...overrides,
		path,
		customProperties,
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
