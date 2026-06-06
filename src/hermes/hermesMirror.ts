import { TFile } from "obsidian";
import { stringify as stringifyYaml } from "yaml";
import TaskNotesPlugin from "../main";
import type { TaskDependency, TaskInfo } from "../types";
import { getCurrentTimestamp } from "../utils/dateUtils";
import { ensureFolderExists, extractTaskInfo } from "../utils/helpers";
import { serializeDependencies } from "../utils/dependencyUtils";
import {
	HERMES_ACTIVITY_FIELD_KEYS,
	buildHermesActivityFrontmatterProperties,
	buildHermesActivityNoteSpecs,
	getHermesActivitySnapshotFromTask,
	type HermesActivitySnapshot,
	type HermesActivityNoteSpec,
} from "./hermesActivityFrontmatter";
import {
	HERMES_ARCHIVED_FRONTMATTER,
	HERMES_ASSIGNEE_FRONTMATTER,
	HERMES_BOARD_FRONTMATTER,
	HERMES_CANONICAL_SYNC_VERSION,
	HERMES_LIST_FRONTMATTER,
	HERMES_PRIORITY_FRONTMATTER,
	HERMES_RUN_ID_FRONTMATTER,
	HERMES_RUN_TITLE_FRONTMATTER,
	HERMES_RUN_TYPE_FRONTMATTER,
	HERMES_ROOT_RUN_ID_FRONTMATTER,
	HERMES_SYNC_VERSION_FRONTMATTER,
	HERMES_TASK_ID_FRONTMATTER,
	HERMES_TASKNOTES_TASKS_FOLDER,
	HERMES_VISIBLE_FRONTMATTER,
	canonicalHermesTaskPath,
	legacyHermesBoardTaskPath,
} from "./hermesCanonicalTaskNotes";
import type { HermesTaskRecord } from "./hermesApiClient";

export const HERMES_DEPENDENCY_EDGES_FIELD = "hermesDependencyEdges";

export function hermesPriorityToTaskNotesPriority(priority: number | null | undefined): string {
	const value = Number(priority ?? 0);
	if (value <= 0) return "none";
	if (value <= 3) return "low";
	if (value >= 8) return "high";
	return "normal";
}

export function hermesStatusToTaskNotesStatus(status: string | null | undefined): string {
	const normalized = status?.trim() || "triage";
	return normalized === "archived" ? "done" : normalized;
}

export function buildHermesMirrorUpdates(
	board: string,
	task: HermesTaskRecord,
	now = getCurrentTimestamp()
): Partial<TaskInfo> & { customFrontmatter: Record<string, unknown> } {
	return {
		title: task.title,
		status: hermesStatusToTaskNotesStatus(task.status),
		priority: hermesPriorityToTaskNotesPriority(task.priority),
		customFrontmatter: buildHermesMirrorFrontmatter(board, task, now),
	};
}

export async function createOrUpdateHermesMirrorNote(
	plugin: TaskNotesPlugin,
	board: string,
	task: HermesTaskRecord,
	options: {
		parents?: string[];
		children?: string[];
		activity?: HermesActivitySnapshot;
		extraFrontmatter?: Record<string, unknown>;
		extraTags?: string[];
	} = {}
): Promise<{ file: TFile; taskInfo: TaskInfo; changed: boolean }> {
	const folder = HERMES_TASKNOTES_TASKS_FOLDER;
	await ensureFolderExists(plugin.app.vault, folder);
	const path = canonicalHermesTaskPath(task.id);
	const canonicalExisting = plugin.app.vault.getAbstractFileByPath(path);
	const existingMirror = await getExistingHermesMirror(plugin, board, task.id, canonicalExisting);
	const existingTaskInfo = existingMirror.taskInfo;
	const existingActivity = existingTaskInfo
		? getHermesActivitySnapshotFromTask(plugin, existingTaskInfo)
		: null;
	const blockedByField = plugin.fieldMapper?.toUserField("blockedBy") ?? "blockedBy";
	const content = buildHermesMirrorContent(board, task, {
		...options,
		existingTaskInfo: existingTaskInfo ?? undefined,
		existingActivity,
		blockedByField,
	});
	let file: TFile;
	let mainNoteChanged = false;
	if (canonicalExisting instanceof TFile) {
		const existingContent = await plugin.app.vault.read(canonicalExisting);
		if (existingContent !== content) {
			await plugin.app.vault.modify(canonicalExisting, content);
			mainNoteChanged = true;
		}
		file = canonicalExisting;
	} else {
		file = await plugin.app.vault.create(path, content);
		mainNoteChanged = true;
	}

	const taskInfo =
		extractTaskInfo(
			plugin.app,
			content,
			file.path,
			file,
			plugin.fieldMapper,
			plugin.settings.storeTitleInFilename,
			plugin.settings.defaultTaskStatus
		) ?? fallbackTaskInfo(file.path, board, task, {
			...options,
			existingActivity,
			blockedByField,
			existingTaskInfo: existingTaskInfo ?? undefined,
		});

	taskInfo.details = splitBody(content);
	const activityForCache = options.activity ?? existingActivity ?? null;
	let activityNotesChanged = false;
	if (activityForCache) {
		activityNotesChanged = await createOrUpdateHermesActivityNotes(
			plugin,
			board,
			task.id,
			activityForCache
		);
	}
	if (activityForCache) {
		taskInfo.customProperties = {
			...(taskInfo.customProperties ?? {}),
			...buildHermesActivityFrontmatterProperties(activityForCache, { board, taskId: task.id }),
		};
	}
	const changed = mainNoteChanged || activityNotesChanged;
	if (changed || !existingTaskInfo) {
		plugin.cacheManager.updateTaskInfoInCache(file.path, taskInfo);
	}
	return { file, taskInfo, changed };
}

async function getExistingHermesMirror(
	plugin: TaskNotesPlugin,
	board: string,
	taskId: string,
	canonicalExisting: unknown
): Promise<{ file: TFile | null; taskInfo: TaskInfo | null }> {
	if (canonicalExisting instanceof TFile) {
		return {
			file: canonicalExisting,
			taskInfo: await plugin.cacheManager.getTaskInfoFromFrontmatter(canonicalExisting.path),
		};
	}
	const legacyPath = legacyHermesBoardTaskPath(board, taskId);
	const legacyExisting = plugin.app.vault.getAbstractFileByPath(legacyPath);
	if (legacyExisting instanceof TFile) {
		return {
			file: legacyExisting,
			taskInfo: await plugin.cacheManager.getTaskInfoFromFrontmatter(legacyPath),
		};
	}
	return { file: null, taskInfo: null };
}

export async function updateHermesActivityForTaskNote(
	plugin: TaskNotesPlugin,
	board: string,
	taskId: string,
	task: TaskInfo,
	activity: HermesActivitySnapshot
): Promise<TaskInfo> {
	const file = plugin.app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) {
		throw new Error(`Cannot find task file: ${task.path}`);
	}

	const activityProperties = buildHermesActivityFrontmatterProperties(activity, { board, taskId });
	const activityKeys = Object.values(HERMES_ACTIVITY_FIELD_KEYS);
	const activityNotesChanged = await createOrUpdateHermesActivityNotes(plugin, board, taskId, activity);
	if (
		!activityNotesChanged &&
		sameActivityFrontmatterProperties(task.customProperties ?? {}, activityProperties, activityKeys)
	) {
		return task;
	}

	await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
		for (const key of activityKeys) {
			if (Object.prototype.hasOwnProperty.call(activityProperties, key)) {
				frontmatter[key] = activityProperties[key];
			} else {
				delete frontmatter[key];
			}
		}
	});

	const frontmatterTaskInfo =
		(await plugin.cacheManager.getTaskInfoFromFrontmatter(file.path)) ?? task;
	const customProperties: Record<string, unknown> = {
		...(frontmatterTaskInfo.customProperties ?? {}),
	};
	for (const key of activityKeys) {
		if (Object.prototype.hasOwnProperty.call(activityProperties, key)) {
			customProperties[key] = activityProperties[key];
		} else {
			delete customProperties[key];
		}
	}

	const taskInfo: TaskInfo = {
		...frontmatterTaskInfo,
		customProperties:
			Object.keys(customProperties).length > 0 ? customProperties : undefined,
	};
	plugin.cacheManager.updateTaskInfoInCache(file.path, taskInfo);
	return taskInfo;
}

function sameActivityFrontmatterProperties(
	current: Record<string, unknown>,
	next: Record<string, unknown>,
	keys: readonly string[]
): boolean {
	for (const key of keys) {
		const currentHasKey = Object.prototype.hasOwnProperty.call(current, key);
		const nextHasKey = Object.prototype.hasOwnProperty.call(next, key);
		if (currentHasKey !== nextHasKey) {
			return false;
		}
		if (nextHasKey && JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
			return false;
		}
	}
	return true;
}

export async function createOrUpdateHermesActivityNotes(
	plugin: TaskNotesPlugin,
	board: string,
	taskId: string,
	activity: HermesActivitySnapshot
): Promise<boolean> {
	const specs = buildHermesActivityNoteSpecs(activity, { board, taskId });
	let changed = false;
	for (const spec of specs) {
		changed = (await createOrUpdateHermesActivityNote(plugin, spec)) || changed;
	}
	return changed;
}

async function createOrUpdateHermesActivityNote(
	plugin: TaskNotesPlugin,
	spec: HermesActivityNoteSpec
): Promise<boolean> {
	await ensureFolderExists(plugin.app.vault, parentFolder(spec.path));
	const content = buildHermesActivityNoteContent(spec);
	const existing = plugin.app.vault.getAbstractFileByPath(spec.path);
	if (existing instanceof TFile) {
		const existingContent = await plugin.app.vault.read(existing);
		if (existingContent !== content) {
			await plugin.app.vault.modify(existing, content);
			return true;
		}
		return false;
	}
	await plugin.app.vault.create(spec.path, content);
	return true;
}

function buildHermesActivityNoteContent(spec: HermesActivityNoteSpec): string {
	const yaml = stringifyHermesMirrorYaml(spec.frontmatter).trimEnd();
	const body = spec.body.trimEnd();
	return `---\n${yaml}\n---\n\n${body ? `${body}\n` : ""}`;
}

function parentFolder(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

export function buildHermesMirrorContent(
	board: string,
	task: HermesTaskRecord,
	options: {
		parents?: string[];
		children?: string[];
		activity?: HermesActivitySnapshot;
		existingActivity?: HermesActivitySnapshot | null;
		existingTaskInfo?: Pick<TaskInfo, "dateCreated" | "completedDate" | "blockedBy" | "customProperties">;
		blockedByField?: string;
		extraFrontmatter?: Record<string, unknown>;
		extraTags?: string[];
	} = {}
): string {
	const frontmatter = buildHermesMirrorFrontmatter(board, task, getCurrentTimestamp(), options);
	const yaml = stringifyHermesMirrorYaml(frontmatter).trimEnd();
	return `---\n${yaml}\n---\n\n${buildHermesMirrorBody(task)}\n`;
}

function stringifyHermesMirrorYaml(frontmatter: Record<string, unknown>): string {
	const yaml = stringifyYaml(frontmatter);
	if (!yaml.includes("[object Object]")) {
		return yaml;
	}
	return stringifyNestedYaml(frontmatter);
}

function stringifyNestedYaml(value: unknown, indent = 0): string {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "[]";
		}
		return value
			.map((item) => {
				if (isPlainObject(item)) {
					const nested = stringifyNestedYaml(item, indent + 2);
					return `${" ".repeat(indent)}-\n${nested}`;
				}
				return `${" ".repeat(indent)}- ${formatYamlScalar(item)}`;
			})
			.join("\n");
	}
	if (isPlainObject(value)) {
		return Object.entries(value)
			.map(([key, item]) => {
				if (Array.isArray(item)) {
					return `${" ".repeat(indent)}${key}:\n${stringifyNestedYaml(item, indent + 2)}`;
				}
				if (isPlainObject(item)) {
					return `${" ".repeat(indent)}${key}:\n${stringifyNestedYaml(item, indent + 2)}`;
				}
				return `${" ".repeat(indent)}${key}: ${formatYamlScalar(item)}`;
			})
			.join("\n");
	}
	return formatYamlScalar(value);
}

function formatYamlScalar(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "symbol") {
		return JSON.stringify(value.description ?? "");
	}
	if (typeof value !== "string") {
		return JSON.stringify(value ?? null);
	}
	const text = value;
	if (text === "" || /[:[\]{},#&*!|>'"%@`\n\r]/.test(text) || /^\s|\s$/.test(text)) {
		return JSON.stringify(text);
	}
	return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildHermesMirrorFrontmatter(
	board: string,
	task: HermesTaskRecord,
	now: string,
	options: {
		parents?: string[];
		activity?: HermesActivitySnapshot;
		existingActivity?: HermesActivitySnapshot | null;
		children?: string[];
		existingTaskInfo?: Pick<TaskInfo, "dateCreated" | "completedDate" | "blockedBy" | "customProperties">;
		blockedByField?: string;
		extraFrontmatter?: Record<string, unknown>;
		extraTags?: string[];
	} = {}
): Record<string, unknown> {
	const hermesPriority = task.priority ?? 0;
	const status = hermesStatusToTaskNotesStatus(task.status);
	const assignee = task.assignee?.trim();
	const tags = [
		...new Set(
			(options.extraTags ?? []).filter(
				(tag) => tag !== "task" && tag !== "hermes-kanban" && tag !== "archived"
			)
		),
	];
	const frontmatter: Record<string, unknown> = {
		type: "task",
		...(tags.length > 0 ? { tags } : {}),
		title: task.title,
		status,
		priority: hermesPriorityToTaskNotesPriority(hermesPriority),
		[HERMES_TASK_ID_FRONTMATTER]: task.id,
		[HERMES_BOARD_FRONTMATTER]: board,
		[HERMES_ARCHIVED_FRONTMATTER]: task.status === "archived",
		[HERMES_SYNC_VERSION_FRONTMATTER]: HERMES_CANONICAL_SYNC_VERSION,
		[HERMES_LIST_FRONTMATTER]: task.status || status,
		[HERMES_VISIBLE_FRONTMATTER]: task.status !== "archived",
		[HERMES_PRIORITY_FRONTMATTER]: hermesPriority,
		dateCreated: options.existingTaskInfo?.dateCreated ?? now,
	};
	if (assignee && assignee !== "none") {
		frontmatter[HERMES_ASSIGNEE_FRONTMATTER] = assignee;
	}
	const runId = task.run_id?.trim();
	if (runId) {
		frontmatter[HERMES_RUN_ID_FRONTMATTER] = runId;
	}
	const rootRunId = task.root_run_id?.trim();
	if (rootRunId) {
		frontmatter[HERMES_ROOT_RUN_ID_FRONTMATTER] = rootRunId;
	}
	const runTitle = task.run_title?.trim();
	if (runTitle) {
		frontmatter[HERMES_RUN_TITLE_FRONTMATTER] = runTitle;
	}
	const runType = task.run_type?.trim();
	if (runType) {
		frontmatter[HERMES_RUN_TYPE_FRONTMATTER] = runType;
	}
	if (status === "done") {
		frontmatter.completedDate = options.existingTaskInfo?.completedDate ?? now;
	}
	const dependencyUpdate = buildHermesDependencyFrontmatter(board, task.id, {
		parents: options.parents ?? [],
		children: options.children ?? [],
		existingTaskInfo: options.existingTaskInfo,
	});
	if (dependencyUpdate.blockedBy.length > 0) {
		frontmatter[options.blockedByField ?? "blockedBy"] = serializeDependencies(
			dependencyUpdate.blockedBy
		);
	}
	if (dependencyUpdate.edges.length > 0) {
		frontmatter[HERMES_DEPENDENCY_EDGES_FIELD] = dependencyUpdate.edges;
	}
	const activity = options.activity ?? options.existingActivity ?? null;
	return {
		...frontmatter,
		...frontmatterFromHermesMetadata(task.metadata),
		...(options.extraFrontmatter ?? {}),
		...(activity ? buildHermesActivityFrontmatterProperties(activity, { board, taskId: task.id }) : {}),
	};
}

function frontmatterFromHermesMetadata(
	metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
	if (!metadata || metadata.hermes_card_mode !== "goal") {
		return {};
	}
	return {
		hermesCardMode: "goal",
		hermesMode: "goal",
	};
}

function buildHermesMirrorBody(task: HermesTaskRecord): string {
	return task.body?.trim() ?? "";
}

function buildHermesDependencyFrontmatter(
	board: string,
	taskId: string,
	options: {
		parents: readonly string[];
		children: readonly string[];
		existingTaskInfo?: Pick<TaskInfo, "blockedBy" | "customProperties">;
	}
): { blockedBy: TaskDependency[]; edges: string[] } {
	const desiredParentIds = uniqueHermesTaskIds(options.parents);
	const desiredChildIds = uniqueHermesTaskIds(options.children);
	const desiredEdges = desiredChildIds.map((childId) => formatHermesDependencyEdge(taskId, childId));
	const previousEdges = getHermesDependencyEdges(options.existingTaskInfo?.customProperties);
	const previousChildIds = previousEdges
		.map((edge) => parseHermesDependencyEdge(edge, taskId))
		.filter((childId): childId is string => Boolean(childId));
	const staleChildPaths = new Set(
		previousChildIds
			.filter((childId) => !desiredChildIds.includes(childId))
			.map((childId) => hermesTaskPath(board, childId))
	);
	const desiredParentPaths = new Set(desiredParentIds.map((parentId) => hermesTaskPath(board, parentId)));
	const blockedBy: TaskDependency[] = [];

	for (const dependency of options.existingTaskInfo?.blockedBy ?? []) {
		const normalizedPath = normalizeDependencyUidPath(dependency.uid);
		if (
			normalizedPath &&
			(staleChildPaths.has(normalizedPath) ||
				(isCanonicalHermesTaskPath(normalizedPath) && !desiredParentPaths.has(normalizedPath)))
		) {
			continue;
		}
		blockedBy.push({ ...dependency });
	}

	for (const parentId of desiredParentIds) {
		const parentPath = hermesTaskPath(board, parentId);
		if (
			blockedBy.some(
				(dependency) => normalizeDependencyUidPath(dependency.uid) === parentPath
			)
		) {
			continue;
		}
		blockedBy.push({
			uid: `[[${parentPath}]]`,
			reltype: "FINISHTOSTART",
		});
	}

	return {
		blockedBy,
		edges: desiredEdges,
	};
}

function uniqueHermesTaskIds(values: readonly string[]): string[] {
	return Array.from(
		new Set(
			values
				.map((value) => value.trim())
				.filter((value) => /^t_[A-Za-z0-9]+$/.test(value))
		)
	);
}

function formatHermesDependencyEdge(parentId: string, childId: string): string {
	return `${parentId}->${childId}`;
}

function parseHermesDependencyEdge(edge: string, parentId: string): string | null {
	const prefix = `${parentId}->`;
	return edge.startsWith(prefix) ? edge.slice(prefix.length) : null;
}

function getHermesDependencyEdges(customProperties: Record<string, unknown> | undefined): string[] {
	const value = customProperties?.[HERMES_DEPENDENCY_EDGES_FIELD];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function hermesTaskPath(_board: string, taskId: string): string {
	return canonicalHermesTaskPath(taskId);
}

function isCanonicalHermesTaskPath(path: string): boolean {
	return /^TaskNotes\/Tasks\/t_[A-Za-z0-9]+\.md$/.test(path);
}

function normalizeDependencyUidPath(uid: string): string {
	const wikiLinkMatch = uid.match(/^\[\[([^|\]#]+)(?:#[^|\]]*)?(?:\|[^\]]*)?\]\]$/);
	const path = (wikiLinkMatch?.[1] ?? uid).trim().replace(/\\/g, "/");
	if (!path) {
		return "";
	}
	return path.endsWith(".md") ? path : `${path}.md`;
}

function fallbackTaskInfo(
	path: string,
	board: string,
	task: HermesTaskRecord,
	options: {
		parents?: string[];
		children?: string[];
		activity?: HermesActivitySnapshot;
		existingActivity?: HermesActivitySnapshot | null;
		existingTaskInfo?: Pick<TaskInfo, "blockedBy" | "customProperties">;
		blockedByField?: string;
		extraFrontmatter?: Record<string, unknown>;
	}
): TaskInfo {
	const frontmatter = buildHermesMirrorFrontmatter(board, task, getCurrentTimestamp(), options);
	const activity = options.activity ?? options.existingActivity ?? null;
	const tags = Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : [];
	return {
		title: task.title,
		status: hermesStatusToTaskNotesStatus(task.status),
		priority: hermesPriorityToTaskNotesPriority(task.priority),
		path,
		tags,
		archived: task.status === "archived",
		contexts: [],
		projects: [],
		dateCreated:
			typeof frontmatter.dateCreated === "string" ? frontmatter.dateCreated : undefined,
		completedDate:
			typeof frontmatter.completedDate === "string" ? frontmatter.completedDate : undefined,
		blockedBy: buildHermesDependencyFrontmatter(board, task.id, {
			parents: options.parents ?? [],
			children: options.children ?? [],
			existingTaskInfo: options.existingTaskInfo,
		}).blockedBy,
		details: buildHermesMirrorBody(task),
		customProperties: {
			...frontmatter,
			...(options.extraFrontmatter ?? {}),
			...(activity ? buildHermesActivityFrontmatterProperties(activity, { board, taskId: task.id }) : {}),
		},
	};
}

function splitBody(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trimEnd();
}
