import { TFile, stringifyYaml } from "obsidian";
import TaskNotesPlugin from "../main";
import type { TaskInfo } from "../types";
import { getCurrentTimestamp } from "../utils/dateUtils";
import { ensureFolderExists, extractTaskInfo } from "../utils/helpers";
import type { HermesTaskRecord } from "./hermesApiClient";

export const HERMES_SYNC_ORIGIN = "tasknotes-hermes-api";

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
	const folder = `TaskNotes/Hermes/${board}`;
	await ensureFolderExists(plugin.app.vault, folder);
	const path = `${folder}/${task.id}.md`;
	const content = buildHermesMirrorContent(board, task, options);
	const existing = plugin.app.vault.getAbstractFileByPath(path);
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
	} = {}
): string {
	const frontmatter = buildHermesMirrorFrontmatter(board, task, getCurrentTimestamp(), options);
	const yaml = stringifyYaml(frontmatter);
	return `---\n${yaml}---\n\n${buildHermesMirrorBody(board, task, options)}\n`;
}

function buildHermesMirrorFrontmatter(
	board: string,
	task: HermesTaskRecord,
	now: string,
	options: {
		parents?: string[];
		children?: string[];
	} = {}
): Record<string, unknown> {
	const hermesPriority = task.priority ?? 0;
	const tags = ["task", "hermes-kanban"];
	if (task.status === "archived") {
		tags.push("archived");
	}
	return {
		type: "task",
		tags,
		title: task.title,
		status: task.status || "triage",
		priority: hermesPriorityToTaskNotesPriority(hermesPriority),
		projects: [`Hermes/${board}`],
		contexts: ["hermes-kanban"],
		hermes_id: task.id,
		hermes_board: board,
		hermes_status: task.status || "triage",
		hermes_assignee: task.assignee || "none",
		hermes_priority: String(hermesPriority),
		hermes_tenant: task.tenant || "",
		hermes_created_by: task.created_by || "tasknotes-native",
		hermes_workspace_kind: task.workspace_kind || "",
		hermes_workspace_path: task.workspace_path || "",
		hermes_branch_name: task.branch_name || "",
		blocked_by: options.parents ?? [],
		blocks: options.children ?? [],
		sync_origin: HERMES_SYNC_ORIGIN,
		writeback_mode: "active",
		last_synced: now,
	};
}

function buildHermesMirrorBody(
	board: string,
	task: HermesTaskRecord,
	options: {
		parents?: string[];
		children?: string[];
	} = {}
): string {
	const body = task.body?.trim() || "No Hermes body.";
	const parents = options.parents?.length ? options.parents.join(", ") : "None";
	const children = options.children?.length ? options.children.join(", ") : "None";
	const summary = task.latest_summary?.trim() || task.result?.trim() || "None";

	return `${task.title}
#task #hermes-kanban

## Hermes Snapshot

- Board: ${board}
- Task ID: ${task.id}
- Hermes status: ${task.status || "triage"}
- Assignee: ${task.assignee || "none"}
- Priority: ${task.priority ?? 0}
- Workspace: ${task.workspace_path || task.workspace_kind || "scratch"}

## Body

${body}

## Dependency Links

### Blocked By
- ${parents}

### Blocks
- ${children}

## Latest Run
- ${summary}

<!-- tasknotes-hermes-api: managed mirror. Use Hermes actions for board mutations. -->`;
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
		customProperties: frontmatter,
		details: buildHermesMirrorBody(board, task, options),
	};
}

function splitBody(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trimEnd();
}
