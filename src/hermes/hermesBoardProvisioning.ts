import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import { ensureFolderHierarchy } from "../bootstrap/defaultBasesFiles";
import { DEFAULT_STATUSES } from "../settings/defaults";
import type { FieldMapping } from "../types";
import type { TaskNotesSettings } from "../types/settings";
import { canonicalHermesBoardProjects } from "./hermesRouting";

const TASKNOTES_ROOT = "TaskNotes";
const TASKNOTES_VIEWS_FOLDER = `${TASKNOTES_ROOT}/Views`;
const HERMES_BOARD_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type HermesBoardProvisionResult = {
	foldersCreated: string[];
	foldersSkipped: string[];
	viewsCreated: string[];
	viewsSkipped: string[];
	boardsSkipped: string[];
};

type HermesBoardProvisionHost = {
	app: {
		vault: Pick<App["vault"], "adapter" | "create" | "createFolder">;
	};
	settings?: Pick<TaskNotesSettings, "fieldMapping" | "taskTag">;
};

export async function provisionHermesBoardSurfaces(
	host: HermesBoardProvisionHost,
	boards: readonly string[]
): Promise<HermesBoardProvisionResult> {
	const result: HermesBoardProvisionResult = {
		foldersCreated: [],
		foldersSkipped: [],
		viewsCreated: [],
		viewsSkipped: [],
		boardsSkipped: [],
	};
	const vault = host.app.vault;

	await ensureFolderHierarchy(vault, TASKNOTES_VIEWS_FOLDER);

	for (const board of uniqueValidBoards(boards)) {
		const folderPath = getHermesBoardFolderPath(board);
		const folderAlreadyExists = await vault.adapter.exists(folderPath);
		await ensureFolderHierarchy(vault, folderPath);
		if (folderAlreadyExists) {
			result.foldersSkipped.push(folderPath);
		} else {
			result.foldersCreated.push(folderPath);
		}

		const viewPath = getHermesBoardKanbanViewPath(board);
		if (await vault.adapter.exists(viewPath)) {
			result.viewsSkipped.push(viewPath);
			continue;
		}

		await vault.create(viewPath, buildHermesBoardKanbanBase(board, host.settings));
		result.viewsCreated.push(viewPath);
	}

	for (const board of boards) {
		const normalizedBoard = normalizeBoardSlug(board);
		if (!normalizedBoard) {
			result.boardsSkipped.push(board);
		}
	}

	return result;
}

export function getHermesBoardFolderPath(board: string): string {
	return normalizePath(`${TASKNOTES_ROOT}/${normalizeBoardSlug(board) ?? board.trim()}`);
}

export function getHermesBoardKanbanViewPath(board: string): string {
	return normalizePath(
		`${TASKNOTES_VIEWS_FOLDER}/kanban-board-${normalizeBoardSlug(board) ?? board.trim()}.base`
	);
}

export function buildHermesBoardKanbanBase(
	board: string,
	settings?: Pick<TaskNotesSettings, "fieldMapping" | "taskTag">
): string {
	const normalizedBoard = normalizeBoardSlug(board) ?? board.trim();
	const folderPath = getHermesBoardFolderPath(normalizedBoard);
	const boardProject = canonicalHermesBoardProjects(normalizedBoard);
	const fieldMapping = settings?.fieldMapping;
	const statusProperty = getMappedField(fieldMapping, "status", "status");
	const priorityProperty = getMappedField(fieldMapping, "priority", "priority");
	const projectsProperty = getMappedField(fieldMapping, "projects", "projects");
	const contextsProperty = getMappedField(fieldMapping, "contexts", "contexts");
	const dueProperty = getMappedField(fieldMapping, "due", "due");
	const scheduledProperty = getMappedField(fieldMapping, "scheduled", "scheduled");
	const blockedByProperty = getMappedField(fieldMapping, "blockedBy", "blockedBy");
	const sortOrderProperty = getMappedField(fieldMapping, "sortOrder", "tasknotes_manual_order");
	const taskTag = settings?.taskTag?.trim() || "task";
	const title = formatBoardTitle(normalizedBoard);
	const statusColumns = DEFAULT_STATUSES.map((status) => status.value).join(",");

	return `# ${title} Kanban

filters:
  and:
    - file.hasTag("${escapeBasesStringLiteral(taskTag)}")
    - or:
        - file.inFolder("${escapeBasesStringLiteral(folderPath)}")
        - list(${formatPropertyReference(projectsProperty)}).contains("${escapeBasesStringLiteral(boardProject)}")

properties:
  file.name:
    displayName: Task
  ${statusProperty}:
    displayName: Status
  ${priorityProperty}:
    displayName: Priority
  ${contextsProperty}:
    displayName: Assignee
  ${projectsProperty}:
    displayName: Board
  ${dueProperty}:
    displayName: Due
  ${scheduledProperty}:
    displayName: Scheduled
  ${blockedByProperty}:
    displayName: Blocked By

views:
  - type: tasknotesKanban
    name: "${escapeBasesStringLiteral(title)}"
    groupBy:
      property: ${statusProperty}
      direction: ASC
    order:
      - ${statusProperty}
      - ${priorityProperty}
      - file.name
      - ${contextsProperty}
      - ${projectsProperty}
      - ${dueProperty}
      - ${scheduledProperty}
      - ${blockedByProperty}
      - file.tags
    sort:
      - property: ${sortOrderProperty}
        direction: DESC
    options:
      columnWidth: 280
      hideEmptyColumns: false
    hideEmptyColumns: false
    pinnedColumns: ${statusColumns}
`;
}

export function summarizeHermesBoardProvisionResult(
	result: HermesBoardProvisionResult
): string {
	const parts: string[] = [];
	if (result.foldersCreated.length > 0) {
		parts.push(`${result.foldersCreated.length} folder(s)`);
	}
	if (result.viewsCreated.length > 0) {
		parts.push(`${result.viewsCreated.length} Kanban view(s)`);
	}
	return parts.length > 0 ? `Created ${parts.join(" and ")}.` : "Board folders and views already exist.";
}

function uniqueValidBoards(boards: readonly string[]): string[] {
	return [...new Set(boards.map(normalizeBoardSlug).filter(isPresent))].sort((left, right) =>
		left.localeCompare(right)
	);
}

function normalizeBoardSlug(board: string): string | null {
	const normalized = board.trim();
	if (!HERMES_BOARD_SLUG_PATTERN.test(normalized)) {
		return null;
	}
	return normalized;
}

function getMappedField(
	fieldMapping: Partial<FieldMapping> | undefined,
	key: keyof FieldMapping,
	fallback: string
): string {
	return fieldMapping?.[key]?.trim() || fallback;
}

function formatPropertyReference(propertyName: string): string {
	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(propertyName)) {
		return propertyName;
	}
	return `note["${escapeBasesStringLiteral(propertyName)}"]`;
}

function formatBoardTitle(board: string): string {
	return board
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function escapeBasesStringLiteral(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isPresent(value: string | null): value is string {
	return typeof value === "string" && value.length > 0;
}
