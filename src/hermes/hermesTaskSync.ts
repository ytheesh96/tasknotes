import { TFile } from "obsidian";
import type TaskNotesPlugin from "../main";
import { EVENT_TASK_DELETED, EVENT_TASK_UPDATED, type TaskInfo } from "../types";
import {
	HermesKanbanApiClient,
	type HermesBoardRecord,
	type HermesTaskIdentity,
	type HermesTaskDetailResponse,
	type HermesTaskRecord,
	getHermesTaskIdentity,
	isHermesTaskNotFoundError,
} from "./hermesApiClient";
import {
	buildHermesActivitySnapshot,
	getHermesActivityFrontmatterStateFromTask,
	getHermesActivitySnapshotFromTask,
	hasHermesActivityFrontmatterPropertiesChanged,
	hasHermesActivityNotesChanged,
	type HermesActivitySnapshot,
} from "./hermesActivityFrontmatter";
import {
	HERMES_ARCHIVED_FRONTMATTER,
	HERMES_ASSIGNEE_FRONTMATTER,
	HERMES_LIST_FRONTMATTER,
	HERMES_PRIORITY_FRONTMATTER,
	HERMES_TASK_ID_FRONTMATTER,
	canonicalHermesTaskPath,
	readHermesBoardFrontmatter,
} from "./hermesCanonicalTaskNotes";
import {
	HERMES_DEPENDENCY_EDGES_FIELD,
	createOrUpdateHermesMirrorNote,
	hermesPriorityToTaskNotesPriority,
	hermesStatusToTaskNotesStatus,
	updateHermesActivityForTaskNote,
} from "./hermesMirror";

export const HERMES_MANAGED_TASK_RECONCILE_INTERVAL_MS = 120_000;
export const HERMES_TASKNOTES_ACTIVITY_RECONCILE_INTERVAL_MS = 120_000;

type HermesTaskSyncApi = Pick<HermesKanbanApiClient, "getBoard" | "getTask"> &
	Partial<Pick<HermesKanbanApiClient, "listBoards">>;
type HermesActivitySyncApi = Pick<HermesKanbanApiClient, "getTask">;

type HermesMirrorWriter = (
	plugin: TaskNotesPlugin,
	board: string,
	task: HermesTaskRecord,
	options?: {
		parents?: string[];
		children?: string[];
		activity?: HermesActivitySnapshot;
	}
) => Promise<{ taskInfo: TaskInfo; changed?: boolean }>;

type HermesLocalTaskDeleter = (plugin: TaskNotesPlugin, task: TaskInfo) => Promise<void>;
type HermesActivityWriter = (
	plugin: TaskNotesPlugin,
	board: string,
	taskId: string,
	task: TaskInfo,
	activity: HermesActivitySnapshot
) => Promise<TaskInfo>;

export interface HermesManagedTaskSyncResult {
	boardsChecked: number;
	tasksSeen: number;
	tasksChecked: number;
	updated: number;
	deleted: number;
	skipped: number;
	failed: number;
}

export interface HermesTaskNotesActivitySyncResult {
	tasksSeen: number;
	tasksChecked: number;
	updated: number;
	missing: number;
	skipped: number;
	failed: number;
}

export function getHermesManagedBoards(tasks: readonly TaskInfo[]): string[] {
	return [...getHermesManagedTasksByBoard(tasks).keys()];
}

async function getHermesManagedBoardsToReconcile(
	tasksByBoard: Map<string, Map<string, TaskInfo>>,
	api: HermesTaskSyncApi
): Promise<string[]> {
	const boards = new Set(tasksByBoard.keys());
	// Bootstrap empty TaskNotes board folders from live Hermes boards; otherwise a board
	// with no existing local mirrors (for example TaskNotes/developer/) is never imported.
	if (api.listBoards) {
		try {
			const liveBoards = await api.listBoards();
			for (const board of liveBoards) {
				if (isActiveHermesBoard(board)) {
					boards.add(board.slug);
				}
			}
		} catch {
			// Preserve the previous local-only reconciliation behavior if board discovery fails.
		}
	}
	return [...boards];
}

function isActiveHermesBoard(board: HermesBoardRecord): boolean {
	return board.slug.trim().length > 0 && board.archived !== true;
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
		localTaskDeleter?: HermesLocalTaskDeleter;
	} = {}
): Promise<HermesManagedTaskSyncResult> {
	const result: HermesManagedTaskSyncResult = {
		boardsChecked: 0,
		tasksSeen: 0,
		tasksChecked: 0,
		updated: 0,
		deleted: 0,
		skipped: 0,
		failed: 0,
	};
	const tasks = await getFrontmatterTasks(
		plugin,
		options.tasks ?? (await plugin.cacheManager.getAllTasks())
	);
	const tasksByBoard = getHermesManagedTasksByBoard(tasks);
	const api = options.api ?? new HermesKanbanApiClient();
	const boards = await getHermesManagedBoardsToReconcile(tasksByBoard, api);
	const mirrorWriter = options.mirrorWriter ?? createOrUpdateHermesMirrorNote;
	const localTaskDeleter = options.localTaskDeleter ?? deleteLocalHermesMirrorNote;

	for (const board of boards) {
		const localTasksById = tasksByBoard.get(board) ?? new Map<string, TaskInfo>();
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
			const existingActivity = localTask
				? getHermesActivitySnapshotFromTask(plugin, localTask)
				: null;
			const existingActivityFrontmatter = localTask
				? getHermesActivityFrontmatterStateFromTask(plugin, localTask)
				: null;
			const activity = buildHermesActivitySnapshot(detail, { existing: existingActivity });
			if (
				localTask &&
				!shouldRefreshFromHermes(board, localTask, remoteTask) &&
				!hasHermesActivityFrontmatterPropertiesChanged(existingActivityFrontmatter, activity, {
					board,
					taskId: id,
				}) &&
				!hasHermesActivityNotesChanged(plugin, activity, { board, taskId: id })
			) {
				result.skipped += 1;
				continue;
			}

			const { taskInfo, changed } = await mirrorWriter(plugin, board, detail.task, {
				parents: detail.links?.parents ?? [],
				children: detail.links?.children ?? [],
				activity,
			});
			if (changed !== false) {
				triggerHermesTaskUpdated(plugin, taskInfo, localTask);
				result.updated += 1;
			} else {
				result.skipped += 1;
			}
		}

		for (const id of localTasksById.keys()) {
			if (!remoteTasksById.has(id)) {
				const localTask = localTasksById.get(id);
				if (!localTask) {
					result.skipped += 1;
					continue;
				}
				try {
					await localTaskDeleter(plugin, localTask);
					result.deleted += 1;
				} catch {
					result.failed += 1;
				}
			}
		}
	}

	return result;
}

export async function syncHermesTaskNotesActivityFromHermes(
	plugin: TaskNotesPlugin,
	options: {
		api?: HermesActivitySyncApi;
		tasks?: readonly TaskInfo[];
		activityWriter?: HermesActivityWriter;
		mirrorWriter?: HermesMirrorWriter;
	} = {}
): Promise<HermesTaskNotesActivitySyncResult> {
	const result: HermesTaskNotesActivitySyncResult = {
		tasksSeen: 0,
		tasksChecked: 0,
		updated: 0,
		missing: 0,
		skipped: 0,
		failed: 0,
	};
	const tasks = await getFrontmatterTasks(
		plugin,
		options.tasks ?? (await plugin.cacheManager.getAllTasks())
	);
	const api = options.api ?? new HermesKanbanApiClient();
	const activityWriter = options.activityWriter ?? updateHermesActivityForTaskNote;
	const mirrorWriter = options.mirrorWriter ?? createOrUpdateHermesMirrorNote;

	for (const task of tasks) {
		if (!isHermesManagedTask(task)) {
			continue;
		}
		const identity = getHermesTaskIdentity(task);
		if (!identity) {
			continue;
		}
		result.tasksSeen += 1;
		result.tasksChecked += 1;

		let detail: HermesTaskDetailResponse;
		try {
			detail = await api.getTask(identity);
		} catch (error) {
			if (isHermesTaskNotFoundError(error, identity.id)) {
				result.missing += 1;
				continue;
			}
			result.failed += 1;
			continue;
		}
		if (!detail.task) {
			result.skipped += 1;
			continue;
		}

		const existingActivity = getHermesActivitySnapshotFromTask(plugin, task);
		const existingActivityFrontmatter = getHermesActivityFrontmatterStateFromTask(
			plugin,
			task
		);
		const activity = buildHermesActivitySnapshot(detail, { existing: existingActivity });
		if (shouldRefreshFromHermesDetail(identity.board, task, detail)) {
			try {
				const { taskInfo: updatedTask, changed } = await mirrorWriter(
					plugin,
					identity.board,
					detail.task,
					{
						parents: detail.links?.parents ?? [],
						children: detail.links?.children ?? [],
						activity,
					}
				);
				if (changed !== false) {
					triggerHermesTaskUpdated(plugin, updatedTask, task);
					result.updated += 1;
				} else {
					result.skipped += 1;
				}
			} catch {
				result.failed += 1;
			}
			continue;
		}

		if (
			!hasHermesActivityFrontmatterPropertiesChanged(existingActivityFrontmatter, activity, {
				board: identity.board,
				taskId: identity.id,
			}) &&
			!hasHermesActivityNotesChanged(plugin, activity, {
				board: identity.board,
				taskId: identity.id,
			})
		) {
			result.skipped += 1;
			continue;
		}

		try {
			const updatedTask = await activityWriter(
				plugin,
				identity.board,
				identity.id,
				task,
				activity
			);
			if (updatedTask === task) {
				result.skipped += 1;
			} else {
				triggerHermesTaskUpdated(plugin, updatedTask, task);
				result.updated += 1;
			}
		} catch {
			result.failed += 1;
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
		localTaskDeleter?: HermesLocalTaskDeleter;
	} = {}
): Promise<boolean> {
	const path = canonicalHermesTaskPath(identity.id);
	const localTask =
		options.localTask === undefined
			? (await plugin.cacheManager.getTaskInfoFromFrontmatter(path)) ??
				(await plugin.cacheManager.getTaskInfo(path))
			: options.localTask
				? await getFrontmatterTask(plugin, options.localTask)
				: null;
	if (localTask && !isHermesManagedTask(localTask)) {
		return false;
	}
	const api = options.api ?? new HermesKanbanApiClient();
	let detail: HermesTaskDetailResponse;
	try {
		detail = await api.getTask(identity);
	} catch (error) {
		if (localTask && isHermesTaskNotFoundError(error, identity.id)) {
			await (options.localTaskDeleter ?? deleteLocalHermesMirrorNote)(plugin, localTask);
			return true;
		}
		throw error;
	}
	if (!detail.task) {
		return false;
	}
	const existingActivity = localTask
		? getHermesActivitySnapshotFromTask(plugin, localTask)
		: null;
	const existingActivityFrontmatter = localTask
		? getHermesActivityFrontmatterStateFromTask(plugin, localTask)
		: null;
	const activity = buildHermesActivitySnapshot(detail, { existing: existingActivity });
	if (
		localTask &&
		!shouldRefreshFromHermes(identity.board, localTask, detail.task) &&
		!hasHermesActivityFrontmatterPropertiesChanged(existingActivityFrontmatter, activity, {
			board: identity.board,
			taskId: identity.id,
		}) &&
		!hasHermesActivityNotesChanged(plugin, activity, {
			board: identity.board,
			taskId: identity.id,
		})
	) {
		return false;
	}

	const mirrorWriter = options.mirrorWriter ?? createOrUpdateHermesMirrorNote;
	const { taskInfo, changed } = await mirrorWriter(plugin, identity.board, detail.task, {
		parents: detail.links?.parents ?? [],
		children: detail.links?.children ?? [],
		activity,
	});
	if (changed === false) {
		return false;
	}
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

async function getFrontmatterTasks(
	plugin: TaskNotesPlugin,
	tasks: readonly TaskInfo[]
): Promise<TaskInfo[]> {
	const hydratedTasks: TaskInfo[] = [];
	for (const task of tasks) {
		hydratedTasks.push(await getFrontmatterTask(plugin, task));
	}
	return hydratedTasks;
}

async function getFrontmatterTask(
	plugin: TaskNotesPlugin,
	task: TaskInfo
): Promise<TaskInfo> {
	if (!isHermesManagedTask(task)) {
		return task;
	}
	return (await plugin.cacheManager.getTaskInfoFromFrontmatter(task.path)) ?? task;
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
	return getHermesTaskIdentity(task) !== null;
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

async function deleteLocalHermesMirrorNote(plugin: TaskNotesPlugin, task: TaskInfo): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) {
		throw new Error(`Cannot find task file: ${task.path}`);
	}
	await plugin.app.fileManager.trashFile(file);
	plugin.cacheManager.clearCacheEntry(task.path);
	triggerHermesTaskDeleted(plugin, task);
}

function triggerHermesTaskDeleted(plugin: TaskNotesPlugin, deletedTask: TaskInfo): void {
	plugin.emitter.trigger(EVENT_TASK_DELETED, {
		path: deletedTask.path,
		deletedTask,
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
	const props = localTask.customProperties ?? {};
	if (props[HERMES_TASK_ID_FRONTMATTER] !== remoteTask.id) {
		return true;
	}
	if (readHermesBoardFrontmatter(props) !== board) {
		return true;
	}
	if (props[HERMES_ARCHIVED_FRONTMATTER] !== (remoteStatus === "archived")) {
		return true;
	}
	if (props[HERMES_LIST_FRONTMATTER] !== remoteStatus) {
		return true;
	}
	if (Number(props[HERMES_PRIORITY_FRONTMATTER] ?? 0) !== Number(remoteTask.priority ?? 0)) {
		return true;
	}
	const remoteAssignee = remoteTask.assignee?.trim();
	const localAssignee = typeof props[HERMES_ASSIGNEE_FRONTMATTER] === "string"
		? props[HERMES_ASSIGNEE_FRONTMATTER].trim()
		: "";
	return (remoteAssignee && remoteAssignee !== "none" ? remoteAssignee : "") !== localAssignee;
}

function shouldRefreshFromHermesDetail(
	board: string,
	localTask: TaskInfo,
	detail: HermesTaskDetailResponse
): boolean {
	if (!detail.task) {
		return false;
	}
	if (shouldRefreshFromHermes(board, localTask, detail.task)) {
		return true;
	}
	return !sameStringSet(
		getHermesDependencyChildIds(board, localTask, detail.task.id),
		detail.links?.children ?? []
	);
}

function getHermesDependencyChildIds(board: string, task: TaskInfo, taskId: string): string[] {
	const ownedEdges = getHermesOwnedDependencyEdges(task, taskId);
	if (ownedEdges.length > 0) {
		return ownedEdges;
	}
	return getHermesBlockedByTaskIds(board, task);
}

function getHermesOwnedDependencyEdges(task: TaskInfo, taskId: string): string[] {
	const value = task.customProperties?.[HERMES_DEPENDENCY_EDGES_FIELD];
	if (!Array.isArray(value)) {
		return [];
	}
	const prefix = `${taskId}->`;
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter((item) => item.startsWith(prefix))
		.map((item) => item.slice(prefix.length))
		.filter((item) => item.startsWith("t_"));
}

function getHermesBlockedByTaskIds(_board: string, task: TaskInfo): string[] {
	const prefix = "[[TaskNotes/Tasks/";
	return (task.blockedBy ?? [])
		.map((dependency) => {
			if (!dependency.uid.startsWith(prefix)) {
				return null;
			}
			const pathTail = dependency.uid.slice(prefix.length);
			const separatorIndex = pathTail.search(/[\]|#]/);
			const id = separatorIndex >= 0 ? pathTail.slice(0, separatorIndex) : pathTail;
			return id.startsWith("t_") ? id : null;
		})
		.filter((value): value is string => Boolean(value));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const rightValues = new Set(right);
	return left.every((value) => rightValues.has(value));
}
