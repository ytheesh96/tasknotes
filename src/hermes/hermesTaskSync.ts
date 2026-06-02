import type TaskNotesPlugin from "../main";
import { EVENT_TASK_UPDATED, type TaskInfo } from "../types";
import {
	HermesKanbanApiClient,
	type HermesTaskDetailResponse,
	type HermesTaskRecord,
	getHermesTaskIdentity,
} from "./hermesApiClient";
import { createOrUpdateHermesMirrorNote, hermesPriorityToTaskNotesPriority } from "./hermesMirror";

export const HERMES_MANAGED_TASK_SYNC_INTERVAL_MS = 15_000;

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

		for (const [id, localTask] of localTasksById.entries()) {
			const remoteTask = remoteTasksById.get(id);
			if (!remoteTask) {
				result.skipped += 1;
				continue;
			}

			result.tasksChecked += 1;
			if (!shouldRefreshFromHermes(board, localTask, remoteTask)) {
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
			plugin.emitter.trigger(EVENT_TASK_UPDATED, {
				path: taskInfo.path,
				originalTask: localTask,
				updatedTask: taskInfo,
			});
			result.updated += 1;
		}
	}

	return result;
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

function shouldRefreshFromHermes(
	board: string,
	localTask: TaskInfo,
	remoteTask: HermesTaskRecord
): boolean {
	const remoteStatus = remoteTask.status || "triage";
	if (localTask.status !== remoteStatus) {
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
	return remoteStatus === "archived" && !hasArchivedTag;
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
