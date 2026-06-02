import { TFile, stringifyYaml } from "obsidian";
import TaskNotesPlugin from "../main";
import type { TaskDependency, TaskInfo } from "../types";
import { getCurrentTimestamp } from "../utils/dateUtils";
import { ensureFolderExists, extractTaskInfo } from "../utils/helpers";
import type { HermesTaskRecord } from "./hermesApiClient";

export function hermesPriorityToTaskNotesPriority(priority: number | null | undefined): string {
	const value = Number(priority ?? 0);
	if (value <= 0) return "none";
	if (value <= 3) return "low";
	if (value >= 8) return "high";
	return "normal";
}

export function buildHermesMirrorUpdates(
	board: string,
	task: HermesTaskRecord,
	now = getCurrentTimestamp()
): Partial<TaskInfo> & { customFrontmatter: Record<string, unknown> } {
	const status = task.status || "triage";
	return {
		title: task.title,
		status,
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
	} = {}
): Promise<{ file: TFile; taskInfo: TaskInfo }> {
	const folder = `TaskNotes/${board}`;
	await ensureFolderExists(plugin.app.vault, folder);
	const path = `${folder}/${task.id}.md`;
	const existing = plugin.app.vault.getAbstractFileByPath(path);
	const existingTaskInfo =
		existing instanceof TFile ? await plugin.cacheManager.getTaskInfo(path) : null;
	const content = buildHermesMirrorContent(board, task, {
		...options,
		existingTaskInfo: existingTaskInfo ?? undefined,
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
		) ?? fallbackTaskInfo(file.path, board, task, options);

	taskInfo.details = splitBody(content);
	plugin.cacheManager.updateTaskInfoInCache(file.path, taskInfo);
	return { file, taskInfo };
}

export function buildHermesMirrorContent(
	board: string,
	task: HermesTaskRecord,
	options: {
		parents?: string[];
		children?: string[];
		existingTaskInfo?: Pick<TaskInfo, "dateCreated" | "completedDate">;
	} = {}
): string {
	const frontmatter = buildHermesMirrorFrontmatter(board, task, getCurrentTimestamp(), options);
	const yaml = stringifyYaml(frontmatter).trimEnd();
	return `---\n${yaml}\n---\n\n${buildHermesMirrorBody(task)}\n`;
}

function buildHermesMirrorFrontmatter(
	board: string,
	task: HermesTaskRecord,
	now: string,
	options: {
		parents?: string[];
		existingTaskInfo?: Pick<TaskInfo, "dateCreated" | "completedDate">;
	} = {}
): Record<string, unknown> {
	const hermesPriority = task.priority ?? 0;
	const tags = ["task", "hermes-kanban"];
	if (task.status === "archived") {
		tags.push("archived");
	}
	const status = task.status || "triage";
	const frontmatter: Record<string, unknown> = {
		type: "task",
		tags,
		title: task.title,
		status,
		priority: hermesPriorityToTaskNotesPriority(hermesPriority),
		projects: [`Hermes/${board}`],
		contexts: [board],
		assignee: task.assignee?.trim() || "none",
		dateCreated: options.existingTaskInfo?.dateCreated ?? now,
	};
	if (status === "done" || status === "archived") {
		frontmatter.completedDate = options.existingTaskInfo?.completedDate ?? now;
	}
	const blockedBy = buildHermesBlockedByLinks(board, options.parents ?? []);
	if (blockedBy.length > 0) {
		frontmatter.blockedBy = blockedBy;
	}
	return frontmatter;
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
	}
): TaskInfo {
	const frontmatter = buildHermesMirrorFrontmatter(board, task, getCurrentTimestamp(), options);
	return {
		title: task.title,
		status: task.status || "triage",
		priority: hermesPriorityToTaskNotesPriority(task.priority),
		path,
		tags: ["task", "hermes-kanban"],
		archived: task.status === "archived",
		contexts: [board],
		projects: [`Hermes/${board}`],
		customProperties: {
			assignee: task.assignee?.trim() || "none",
		},
		dateCreated:
			typeof frontmatter.dateCreated === "string" ? frontmatter.dateCreated : undefined,
		completedDate:
			typeof frontmatter.completedDate === "string" ? frontmatter.completedDate : undefined,
		blockedBy: buildHermesBlockedByDependencies(board, options.parents ?? []),
		details: buildHermesMirrorBody(task),
	};
}

function splitBody(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trimEnd();
}
