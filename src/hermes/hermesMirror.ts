import { TFile } from "obsidian";
import { stringify as stringifyYaml } from "yaml";
import TaskNotesPlugin from "../main";
import type { TaskDependency, TaskInfo } from "../types";
import { getCurrentTimestamp } from "../utils/dateUtils";
import { ensureFolderExists, extractTaskInfo } from "../utils/helpers";
import {
	buildHermesActivityFrontmatterProperties,
	buildHermesActivityNoteSpecs,
	getHermesActivitySnapshotFromTask,
	type HermesActivitySnapshot,
	type HermesActivityNoteSpec,
} from "./hermesActivityFrontmatter";
import type { HermesTaskRecord } from "./hermesApiClient";

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
): Promise<{ file: TFile; taskInfo: TaskInfo }> {
	const folder = `TaskNotes/${board}`;
	await ensureFolderExists(plugin.app.vault, folder);
	const path = `${folder}/${task.id}.md`;
	const existing = plugin.app.vault.getAbstractFileByPath(path);
	const existingTaskInfo =
		existing instanceof TFile ? await plugin.cacheManager.getTaskInfo(path) : null;
	const existingActivity = existingTaskInfo
		? getHermesActivitySnapshotFromTask(plugin, existingTaskInfo)
		: null;
	const content = buildHermesMirrorContent(board, task, {
		...options,
		existingTaskInfo: existingTaskInfo ?? undefined,
		existingActivity,
	});
	let file: TFile;
	if (existing instanceof TFile) {
		await plugin.app.vault.modify(existing, content);
		file = existing;
	} else {
		file = await plugin.app.vault.create(path, content);
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
		) ?? fallbackTaskInfo(file.path, board, task, { ...options, existingActivity });

	taskInfo.details = splitBody(content);
	const activityForCache = options.activity ?? existingActivity ?? null;
	if (activityForCache) {
		await createOrUpdateHermesActivityNotes(plugin, board, task.id, activityForCache);
	}
	if (activityForCache) {
		taskInfo.customProperties = {
			...(taskInfo.customProperties ?? {}),
			...buildHermesActivityFrontmatterProperties(activityForCache, { board, taskId: task.id }),
		};
	}
	plugin.cacheManager.updateTaskInfoInCache(file.path, taskInfo);
	return { file, taskInfo };
}

async function createOrUpdateHermesActivityNotes(
	plugin: TaskNotesPlugin,
	board: string,
	taskId: string,
	activity: HermesActivitySnapshot
): Promise<void> {
	const specs = buildHermesActivityNoteSpecs(activity, { board, taskId });
	for (const spec of specs) {
		await createOrUpdateHermesActivityNote(plugin, spec);
	}
}

async function createOrUpdateHermesActivityNote(
	plugin: TaskNotesPlugin,
	spec: HermesActivityNoteSpec
): Promise<void> {
	await ensureFolderExists(plugin.app.vault, parentFolder(spec.path));
	const content = buildHermesActivityNoteContent(spec);
	const existing = plugin.app.vault.getAbstractFileByPath(spec.path);
	if (existing instanceof TFile) {
		await plugin.app.vault.modify(existing, content);
		return;
	}
	await plugin.app.vault.create(spec.path, content);
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
		existingTaskInfo?: Pick<TaskInfo, "dateCreated" | "completedDate">;
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
		existingTaskInfo?: Pick<TaskInfo, "dateCreated" | "completedDate">;
		extraFrontmatter?: Record<string, unknown>;
		extraTags?: string[];
	} = {}
): Record<string, unknown> {
	const hermesPriority = task.priority ?? 0;
	const tags = [...new Set(["task", "hermes-kanban", ...(options.extraTags ?? [])])];
	if (task.status === "archived") {
		tags.push("archived");
	}
	const status = hermesStatusToTaskNotesStatus(task.status);
	const assignee = task.assignee?.trim();
	const frontmatter: Record<string, unknown> = {
		type: "task",
		tags,
		title: task.title,
		status,
		priority: hermesPriorityToTaskNotesPriority(hermesPriority),
		projects: [`Hermes/${board}`],
		contexts: assignee && assignee !== "none" ? [assignee] : [],
		dateCreated: options.existingTaskInfo?.dateCreated ?? now,
	};
	if (status === "done") {
		frontmatter.completedDate = options.existingTaskInfo?.completedDate ?? now;
	}
	const blockedBy = buildHermesBlockedByLinks(board, options.parents ?? []);
	if (blockedBy.length > 0) {
		frontmatter.blockedBy = blockedBy;
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

function buildHermesBlockedByLinks(board: string, parents: readonly string[]): string[] {
	return [...new Set(parents.map((parent) => parent.trim()).filter(Boolean))].map(
		(parent) => `[[TaskNotes/${board}/${parent}]]`
	);
}

function buildHermesBlockedByDependencies(
	board: string,
	parents: readonly string[]
): TaskDependency[] {
	return buildHermesBlockedByLinks(board, parents).map((uid) => ({
		uid,
		reltype: "FINISHTOSTART",
	}));
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
		extraFrontmatter?: Record<string, unknown>;
	}
): TaskInfo {
	const frontmatter = buildHermesMirrorFrontmatter(board, task, getCurrentTimestamp(), options);
	const activity = options.activity ?? options.existingActivity ?? null;
	const tags = Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : ["task", "hermes-kanban"];
	return {
		title: task.title,
		status: hermesStatusToTaskNotesStatus(task.status),
		priority: hermesPriorityToTaskNotesPriority(task.priority),
		path,
		tags,
		archived: task.status === "archived",
		contexts:
			task.assignee?.trim() && task.assignee.trim() !== "none" ? [task.assignee.trim()] : [],
		projects: [`Hermes/${board}`],
		dateCreated:
			typeof frontmatter.dateCreated === "string" ? frontmatter.dateCreated : undefined,
		completedDate:
			typeof frontmatter.completedDate === "string" ? frontmatter.completedDate : undefined,
		blockedBy: buildHermesBlockedByDependencies(board, options.parents ?? []),
		details: buildHermesMirrorBody(task),
		customProperties: {
			...(options.extraFrontmatter ?? {}),
			...(activity ? buildHermesActivityFrontmatterProperties(activity, { board, taskId: task.id }) : {}),
		},
	};
}

function splitBody(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trimEnd();
}
