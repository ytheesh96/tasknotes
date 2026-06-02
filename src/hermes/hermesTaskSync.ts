import type TaskNotesPlugin from "../main";
import { EVENT_TASK_UPDATED, type TaskInfo } from "../types";
import {
	HermesKanbanApiClient,
	type HermesTaskIdentity,
	type HermesTaskDetailResponse,
	type HermesTaskRecord,
	getHermesTaskIdentity,
} from "./hermesApiClient";
import {
	createOrUpdateHermesMirrorNote,
	hermesPriorityToTaskNotesPriority,
	hermesStatusToTaskNotesStatus,
} from "./hermesMirror";

export const HERMES_MANAGED_TASK_RECONCILE_INTERVAL_MS = 120_000;

type HermesTaskSyncApi = Pick<HermesKanbanApiClient, "getBoard" | "getTask">;

type HermesMirrorWriter = (
	plugin: TaskNotesPlugin,
	board: string,
	task: HermesTaskRecord,
	options?: {
		parents?: string[];
		children?: string[];
	}
) => Promise<{ taskInfo: TaskInfo }>;

export interface HermesManagedTaskSyncResult {
	boardsChecked: number;
	tasksSeen: number;
	tasksChecked: number;
	updated: number;
	skipped: number;
	failed: number;
}

export function getHermesManagedBoards(tasks: readonly TaskInfo[]): string[] {
	return [...getHermesManagedTasksByBoard(tasks).keys()];
}

export function getHermesManagedBoardFromTaskEvent(eventData: unknown): string | null {
	const task = getTaskFromTaskEvent(eventData);
	if (!task || !isHermesManagedTask(task)) {
		return null;
	}
	return getHermesTaskIdentity(task)?.board ?? null;
}

export async function syncHermesManagedTasksFromHermes(
	plugin: TaskNotesPlugin,
	options: {
		api?: HermesTaskSyncApi;
		tasks?: readonly TaskInfo[];
		mirrorWriter?: HermesMirrorWriter;
	} = {}
): Promise<HermesManagedTaskSyncResult> {
	const result: HermesManagedTaskSyncResult = {
		boardsChecked: 0,
		tasksSeen: 0,
		tasksChecked: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
	};
	const tasks = options.tasks ?? (await plugin.cacheManager.getAllTasks());
	const tasksByBoard = getHermesManagedTasksByBoard(tasks);
	const api = options.api ?? new HermesKanbanApiClient();
	const mirrorWriter = options.mirrorWriter ?? createOrUpdateHermesMirrorNote;

	for (const [board, localTasksById] of tasksByBoard.entries()) {
		result.tasksSeen += localTasksById.size;
		let remoteTasksById: Map<string, HermesTaskRecord>;
		try {
			const boardState = await api.getBoard(board, { includeArchived: true });
			result.boardsChecked += 1;
			remoteTasksById = getRemoteTasksById(boardState.columns ?? []);
		} catch {
			result.failed += localTasksById.size;
			continue;
		}

		for (const [id, remoteTask] of remoteTasksById.entries()) {
			const localTask = localTasksById.get(id) ?? null;
			result.tasksChecked += 1;
			if (localTask && !shouldRefreshFromHermes(board, localTask, remoteTask)) {
				result.skipped += 1;
				continue;
			}

			let detail: HermesTaskDetailResponse;
			try {
				detail = await api.getTask({ board, id });
			} catch {
				result.failed += 1;
				continue;
			}
			if (!detail.task) {
				result.skipped += 1;
				continue;
			}

			const { taskInfo } = await mirrorWriter(plugin, board, detail.task, {
				parents: detail.links?.parents ?? [],
				children: detail.links?.children ?? [],
			});
			triggerHermesTaskUpdated(plugin, taskInfo, localTask);
			result.updated += 1;
		}

		for (const id of localTasksById.keys()) {
			if (!remoteTasksById.has(id)) {
				result.skipped += 1;
			}
		}
	}

	return result;
}

export async function syncHermesManagedTaskFromHermes(
	plugin: TaskNotesPlugin,
	identity: HermesTaskIdentity,
	options: {
		api?: Pick<HermesKanbanApiClient, "getTask">;
		localTask?: TaskInfo | null;
		mirrorWriter?: HermesMirrorWriter;
	} = {}
): Promise<boolean> {
	const path = `TaskNotes/${identity.board}/${identity.id}.md`;
	const localTask = options.localTask ?? (await plugin.cacheManager.getTaskInfo(path));
	if (localTask && !isHermesManagedTask(localTask)) {
		return false;
	}
	const api = options.api ?? new HermesKanbanApiClient();
	const detail = await api.getTask(identity);
	if (!detail.task || (localTask && !shouldRefreshFromHermes(identity.board, localTask, detail.task))) {
		return false;
	}

	const mirrorWriter = options.mirrorWriter ?? createOrUpdateHermesMirrorNote;
	const { taskInfo } = await mirrorWriter(plugin, identity.board, detail.task, {
		parents: detail.links?.parents ?? [],
		children: detail.links?.children ?? [],
	});
	triggerHermesTaskUpdated(plugin, taskInfo, localTask);
	return true;
}

export function shouldHandleHermesTaskEvent(kind: string | null | undefined): boolean {
	return kind !== "heartbeat";
}

function getTaskFromTaskEvent(eventData: unknown): TaskInfo | null {
	if (!isRecord(eventData)) {
		return null;
	}
	for (const key of ["updatedTask", "task", "taskInfo"] as const) {
		const value = eventData[key];
		if (isTaskInfoLike(value)) {
			return value;
		}
	}
	return null;
}

function isTaskInfoLike(value: unknown): value is TaskInfo {
	return isRecord(value) && typeof value.path === "string";
}

function getHermesManagedTasksByBoard(
	tasks: readonly TaskInfo[]
): Map<string, Map<string, TaskInfo>> {
	const tasksByBoard = new Map<string, Map<string, TaskInfo>>();
	for (const task of tasks) {
		if (!isHermesManagedTask(task)) {
			continue;
		}
		const identity = getHermesTaskIdentity(task);
		if (!identity) {
			continue;
		}
		let boardTasks = tasksByBoard.get(identity.board);
		if (!boardTasks) {
			boardTasks = new Map<string, TaskInfo>();
			tasksByBoard.set(identity.board, boardTasks);
		}
		if (!boardTasks.has(identity.id)) {
			boardTasks.set(identity.id, task);
		}
	}
	return tasksByBoard;
}

function isHermesManagedTask(task: TaskInfo): boolean {
	return (task.tags ?? []).includes("hermes-kanban");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRemoteTasksById(
	columns: readonly { tasks?: readonly HermesTaskRecord[] }[]
): Map<string, HermesTaskRecord> {
	const tasksById = new Map<string, HermesTaskRecord>();
	for (const column of columns) {
		for (const task of column.tasks ?? []) {
			tasksById.set(task.id, task);
		}
	}
	return tasksById;
}

function triggerHermesTaskUpdated(
	plugin: TaskNotesPlugin,
	updatedTask: TaskInfo,
	originalTask: TaskInfo | null | undefined
): void {
	plugin.emitter.trigger(EVENT_TASK_UPDATED, {
		path: updatedTask.path,
		...(originalTask ? { originalTask } : {}),
		updatedTask,
	});
}

function shouldRefreshFromHermes(
	board: string,
	localTask: TaskInfo,
	remoteTask: HermesTaskRecord
): boolean {
	const remoteStatus = remoteTask.status || "triage";
	const taskNotesStatus = hermesStatusToTaskNotesStatus(remoteStatus);
	if (localTask.status !== taskNotesStatus) {
		return true;
	}
	if (localTask.title !== remoteTask.title) {
		return true;
	}
	if (localTask.priority !== hermesPriorityToTaskNotesPriority(remoteTask.priority)) {
		return true;
	}
	if (!sameStringList(localTask.contexts ?? [], getHermesAssigneeContexts(remoteTask))) {
		return true;
	}
	if (!sameStringList(localTask.projects ?? [], [`Hermes/${board}`])) {
		return true;
	}
	const hasArchivedTag = (localTask.tags ?? []).includes("archived");
	return (remoteStatus === "archived") !== hasArchivedTag;
}

function getHermesAssigneeContexts(task: HermesTaskRecord): string[] {
	const assignee = task.assignee?.trim();
	return assignee && assignee !== "none" ? [assignee] : [];
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}
