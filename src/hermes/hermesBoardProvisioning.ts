import { TFile, type App } from "obsidian";
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
	viewsUpdated: string[];
	viewsSkipped: string[];
	legacyViewsRemoved: string[];
	legacyViewsSkipped: string[];
	boardsSkipped: string[];
};

type HermesBoardProvisionHost = {
	app: {
		vault: Pick<
			App["vault"],
			"adapter" | "create" | "createFolder" | "delete" | "getAbstractFileByPath" | "modify" | "read"
		>;
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
		viewsUpdated: [],
		viewsSkipped: [],
		legacyViewsRemoved: [],
		legacyViewsSkipped: [],
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
		const viewContent = buildHermesBoardKanbanBase(board, host.settings);
		const existingView = vault.getAbstractFileByPath(viewPath);
		if (existingView instanceof TFile) {
			const existingContent = await vault.read(existingView);
			if (existingContent !== viewContent && isGeneratedHermesBoardView(existingContent, board)) {
				await vault.modify(existingView, viewContent);
				result.viewsUpdated.push(viewPath);
			} else {
				result.viewsSkipped.push(viewPath);
			}
		} else {
			await vault.create(viewPath, viewContent);
			result.viewsCreated.push(viewPath);
		}

		await removeLegacyHermesBoardView(vault, board, result);
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
	if (result.viewsUpdated.length > 0) {
		parts.push(`${result.viewsUpdated.length} updated Kanban view(s)`);
	}
	if (result.legacyViewsRemoved.length > 0) {
		parts.push(`${result.legacyViewsRemoved.length} old Kanban view(s) removed`);
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

async function removeLegacyHermesBoardView(
	vault: HermesBoardProvisionHost["app"]["vault"],
	board: string,
	result: HermesBoardProvisionResult
): Promise<void> {
	const legacyPath = normalizePath(`${TASKNOTES_VIEWS_FOLDER}/kanban-${board}.base`);
	if (legacyPath === "TaskNotes/Views/kanban-default.base") {
		return;
	}

	const legacyView = vault.getAbstractFileByPath(legacyPath);
	if (!(legacyView instanceof TFile)) {
		return;
	}

	const legacyContent = await vault.read(legacyView);
	if (!isGeneratedHermesBoardView(legacyContent, board)) {
		result.legacyViewsSkipped.push(legacyPath);
		return;
	}

	await vault.delete(legacyView);
	result.legacyViewsRemoved.push(legacyPath);
}

function isGeneratedHermesBoardView(content: string, board: string): boolean {
	return (
		content.includes(`# ${formatBoardTitle(board)} Kanban`) &&
		content.includes(`Hermes/${board}`) &&
		content.includes("type: tasknotesKanban")
	);
}

function isPresent(value: string | null): value is string {
	return typeof value === "string" && value.length > 0;
}
