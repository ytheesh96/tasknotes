import { TFile, type App } from "obsidian";
import { normalizePath } from "obsidian";
import { ensureFolderHierarchy } from "../bootstrap/defaultBasesFiles";
import { createVaultFile, deleteVaultFile, modifyVaultFile } from "../core/VaultMutationService";
import { DEFAULT_STATUSES } from "../settings/defaults";
import type { FieldMapping } from "../types";
import type { TaskNotesSettings } from "../types/settings";
import {
	HERMES_ARCHIVED_FRONTMATTER,
	HERMES_BOARD_FRONTMATTER,
	HERMES_RUN_ID_FRONTMATTER,
	HERMES_RUN_TITLE_FRONTMATTER,
	HERMES_RUN_TYPE_FRONTMATTER,
	HERMES_ROOT_RUN_ID_FRONTMATTER,
	HERMES_TASK_ID_FRONTMATTER,
} from "./hermesCanonicalTaskNotes";

const TASKNOTES_ROOT = "TaskNotes";
const TASKNOTES_TASKS_FOLDER = `${TASKNOTES_ROOT}/Tasks`;
const TASKNOTES_VIEWS_FOLDER = `${TASKNOTES_ROOT}/Views`;
const SHARED_HERMES_KANBAN_VIEW_PATH = `${TASKNOTES_VIEWS_FOLDER}/kanban-default.base`;
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
			"adapter" | "create" | "createFolder" | "delete" | "getAbstractFileByPath" | "getFiles" | "modify" | "read"
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
	const validBoards = uniqueValidBoards(boards);

	await ensureFolderHierarchy(vault, TASKNOTES_VIEWS_FOLDER);

	for (const board of validBoards) {
		const folderPath = TASKNOTES_TASKS_FOLDER;
		const folderAlreadyExists = await vault.adapter.exists(folderPath);
		await ensureFolderHierarchy(vault, folderPath);
		if (folderAlreadyExists) {
			result.foldersSkipped.push(folderPath);
		} else {
			result.foldersCreated.push(folderPath);
		}
		await removeLegacyHermesBoardView(vault, board, result);
	}
	await removeGeneratedLegacyHermesBoardViews(vault, result);

	await ensureSharedHermesKanbanBase(host, validBoards, result);

	for (const board of boards) {
		const normalizedBoard = normalizeBoardSlug(board);
		if (!normalizedBoard) {
			result.boardsSkipped.push(board);
		}
	}

	return result;
}

export function getHermesBoardFolderPath(_board: string): string {
	return normalizePath(TASKNOTES_TASKS_FOLDER);
}

export function getHermesBoardKanbanViewPath(board: string): string {
	return normalizePath(SHARED_HERMES_KANBAN_VIEW_PATH);
}

export function getHermesBoardKanbanViewName(board: string): string | null {
	const normalizedBoard = normalizeBoardSlug(board);
	return normalizedBoard ? formatBoardTitle(normalizedBoard) : null;
}

export function buildHermesBoardKanbanBaseHeader(
	settings?: Pick<TaskNotesSettings, "fieldMapping" | "taskTag">
): string {
	const fieldMapping = settings?.fieldMapping;
	const statusProperty = getMappedField(fieldMapping, "status", "status");
	const priorityProperty = getMappedField(fieldMapping, "priority", "priority");
	const projectsProperty = getMappedField(fieldMapping, "projects", "projects");
	const contextsProperty = getMappedField(fieldMapping, "contexts", "contexts");
	const dueProperty = getMappedField(fieldMapping, "due", "due");
	const scheduledProperty = getMappedField(fieldMapping, "scheduled", "scheduled");
	const blockedByProperty = getMappedField(fieldMapping, "blockedBy", "blockedBy");

	return `# Kanban Board

filters:
  and:
    - ${HERMES_TASK_ID_FRONTMATTER}.isEmpty() == false

properties:
  file.name:
    displayName: Task
  ${HERMES_TASK_ID_FRONTMATTER}:
    displayName: Hermes Task ID
  ${HERMES_BOARD_FRONTMATTER}:
    displayName: Hermes Board
  ${HERMES_ARCHIVED_FRONTMATTER}:
    displayName: Hermes Archived
  ${HERMES_RUN_ID_FRONTMATTER}:
    displayName: Hermes Run ID
  ${HERMES_ROOT_RUN_ID_FRONTMATTER}:
    displayName: Hermes Root Run
  ${HERMES_RUN_TITLE_FRONTMATTER}:
    displayName: Hermes Run
  ${HERMES_RUN_TYPE_FRONTMATTER}:
    displayName: Hermes Run Type
  ${statusProperty}:
    displayName: Status
  ${priorityProperty}:
    displayName: Priority
  ${contextsProperty}:
    displayName: Assignee
  ${projectsProperty}:
    displayName: Projects
  ${dueProperty}:
    displayName: Due
  ${scheduledProperty}:
    displayName: Scheduled
  ${blockedByProperty}:
    displayName: Blocked By

views:
`;
}

export function buildHermesBoardKanbanBase(
	board: string,
	settings?: Pick<TaskNotesSettings, "fieldMapping" | "taskTag">
): string {
	const normalizedBoard = normalizeBoardSlug(board) ?? board.trim();
	const fieldMapping = settings?.fieldMapping;
	const statusProperty = getMappedField(fieldMapping, "status", "status");
	const priorityProperty = getMappedField(fieldMapping, "priority", "priority");
	const projectsProperty = getMappedField(fieldMapping, "projects", "projects");
	const contextsProperty = getMappedField(fieldMapping, "contexts", "contexts");
	const dueProperty = getMappedField(fieldMapping, "due", "due");
	const scheduledProperty = getMappedField(fieldMapping, "scheduled", "scheduled");
	const blockedByProperty = getMappedField(fieldMapping, "blockedBy", "blockedBy");
	const sortOrderProperty = getMappedField(fieldMapping, "sortOrder", "tasknotes_manual_order");
	const title = formatBoardTitle(normalizedBoard);
	const statusColumns = DEFAULT_STATUSES.map((status) => status.value).join(",");

	return `  - type: tasknotesKanban
    name: "${escapeBasesStringLiteral(title)}"
    filters:
      and:
        - ${HERMES_TASK_ID_FRONTMATTER}.isEmpty() == false
        - ${HERMES_BOARD_FRONTMATTER} == "${escapeBasesStringLiteral(normalizedBoard)}"
    groupBy:
      property: ${statusProperty}
      direction: ASC
    order:
      - ${statusProperty}
      - ${priorityProperty}
      - file.name
      - ${contextsProperty}
      - ${projectsProperty}
      - ${HERMES_BOARD_FRONTMATTER}
      - ${HERMES_ARCHIVED_FRONTMATTER}
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
      showHermesArchivedTasks: false
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

async function ensureSharedHermesKanbanBase(
	host: HermesBoardProvisionHost,
	boards: readonly string[],
	result: HermesBoardProvisionResult
): Promise<void> {
	if (boards.length === 0) {
		return;
	}

	const viewPath = normalizePath(SHARED_HERMES_KANBAN_VIEW_PATH);
	const vault = host.app.vault;
	const existingView = vault.getAbstractFileByPath(viewPath);
	const desiredContent = buildSharedHermesKanbanBase(boards, host.settings);

	if (!(existingView instanceof TFile)) {
		await createVaultFile(host.app, viewPath, desiredContent);
		result.viewsCreated.push(viewPath);
		return;
	}

	const originalContent = await vault.read(existingView);
	const existingContent = normalizeSharedHermesTaskScopeFilter(originalContent);
	let nextContent = normalizeRootHermesArchivedExclusionFilters(existingContent);
	nextContent = normalizeGeneratedSharedHermesKanbanBaseHeader(nextContent, host.settings);
	nextContent = ensureHermesBoardBaseProperties(nextContent);
	nextContent = removeGeneratedFixtureHermesBoardViews(nextContent);

	if (boards.some((board) => isGeneratedHermesBoardStandaloneFile(nextContent, board))) {
		nextContent = desiredContent;
	} else {
		for (const board of boards) {
			nextContent = upsertHermesBoardView(nextContent, board, host.settings);
		}
	}

	if (nextContent === originalContent) {
		result.viewsSkipped.push(viewPath);
		return;
	}

	await modifyVaultFile(host.app, existingView, nextContent);
	result.viewsUpdated.push(viewPath);
}

function buildSharedHermesKanbanBase(
	boards: readonly string[],
	settings?: Pick<TaskNotesSettings, "fieldMapping" | "taskTag">
): string {
	return `${buildHermesBoardKanbanBaseHeader(settings)}${boards
		.map((board) => buildHermesBoardKanbanBase(board, settings))
		.join("\n")}`;
}

function normalizeGeneratedSharedHermesKanbanBaseHeader(
	content: string,
	settings?: Pick<TaskNotesSettings, "fieldMapping" | "taskTag">
): string {
	if (!isGeneratedHermesOnlySharedKanbanBase(content)) {
		return content;
	}
	const viewsMatch = content.match(/^views:\s*$/m);
	if (!viewsMatch || viewsMatch.index === undefined) {
		return content;
	}
	const viewsStart = viewsMatch.index + viewsMatch[0].length;
	const viewsTail = content.slice(viewsStart).replace(/^\n?/, "");
	return `${buildHermesBoardKanbanBaseHeader(settings).trimEnd()}\n${viewsTail}`;
}

function normalizeSharedHermesTaskScopeFilter(content: string): string {
	if (!isGeneratedHermesOnlySharedKanbanBase(content)) {
		return content;
	}
	return content.replace(/^\s*- file\.inFolder\("TaskNotes\/Tasks"\)\n/m, "");
}

function normalizeRootHermesArchivedExclusionFilters(content: string): string {
	if (!isGeneratedHermesOnlySharedKanbanBase(content)) {
		return content;
	}
	const viewsMatch = content.match(/^views:\s*$/m);
	if (!viewsMatch || viewsMatch.index === undefined) {
		return content;
	}

	const rootContent = content.slice(0, viewsMatch.index);
	const viewsContent = content.slice(viewsMatch.index);
	const normalizedRootContent = rootContent
		.replace(new RegExp(`^\\s*- ${HERMES_ARCHIVED_FRONTMATTER} != true\\n`, "gm"), "")
		.replace(new RegExp(`^\\s*- ${HERMES_ARCHIVED_FRONTMATTER} != "true"\\n`, "gm"), "");
	return `${normalizedRootContent}${viewsContent}`;
}

function ensureHermesBoardBaseProperties(content: string): string {
	const requiredProperties = [
		[HERMES_TASK_ID_FRONTMATTER, "Hermes Task ID"],
		[HERMES_BOARD_FRONTMATTER, "Hermes Board"],
		[HERMES_ARCHIVED_FRONTMATTER, "Hermes Archived"],
		[HERMES_RUN_ID_FRONTMATTER, "Hermes Run ID"],
		[HERMES_ROOT_RUN_ID_FRONTMATTER, "Hermes Root Run"],
		[HERMES_RUN_TITLE_FRONTMATTER, "Hermes Run"],
		[HERMES_RUN_TYPE_FRONTMATTER, "Hermes Run Type"],
	];
	const missingProperties = requiredProperties.filter(
		([property]) => !new RegExp(`^  ${escapeRegExp(property)}:\\s*$`, "m").test(content)
	);
	if (missingProperties.length === 0) {
		return content;
	}

	const propertyBlock = missingProperties
		.map(([property, displayName]) => `  ${property}:\n    displayName: ${displayName}`)
		.join("\n");
	const propertiesMatch = content.match(/^properties:\s*$/m);
	if (propertiesMatch?.index !== undefined) {
		const sectionStart = propertiesMatch.index + propertiesMatch[0].length;
		const nextRootSection = content.slice(sectionStart).match(/\n(?:filters|formulas|views):\s*$/m);
		const insertAt = nextRootSection?.index !== undefined ? sectionStart + nextRootSection.index : content.length;
		return `${content.slice(0, insertAt).trimEnd()}\n${propertyBlock}${content.slice(insertAt)}`;
	}

	const viewsMatch = content.match(/^views:\s*$/m);
	if (viewsMatch?.index !== undefined) {
		return `${content.slice(0, viewsMatch.index).trimEnd()}\nproperties:\n${propertyBlock}\n${content.slice(
			viewsMatch.index
		)}`;
	}

	return `${content.trimEnd()}\n\nproperties:\n${propertyBlock}\n`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGeneratedHermesOnlySharedKanbanBase(content: string): boolean {
	if (!content.trimStart().startsWith("# Kanban Board")) {
		return false;
	}
	const viewsMatch = content.match(/^views:\s*$/m);
	if (!viewsMatch || viewsMatch.index === undefined) {
		return false;
	}
	const rootContent = content.slice(0, viewsMatch.index);
	const viewsContent = content.slice(viewsMatch.index);
	const hasGeneratedHermesRoot =
		rootContent.includes(`${HERMES_TASK_ID_FRONTMATTER}.isEmpty() == false`) &&
		rootContent.includes(`${HERMES_TASK_ID_FRONTMATTER}:`) &&
		rootContent.includes(`${HERMES_BOARD_FRONTMATTER}:`) &&
		rootContent.includes(`${HERMES_ARCHIVED_FRONTMATTER}:`);
	const hasSharedTaskNotesRootContent = /^(?:formulas|properties):\s*$/m.test(rootContent);
	const hasLegacyHermesBoardView =
		viewsContent.includes("type: tasknotesKanban") &&
		(/file\.inFolder\("TaskNotes\/[a-z0-9][a-z0-9_-]{0,63}"\)/.test(viewsContent) ||
			/list\([^)]+\)\.contains\("Hermes\/[a-z0-9][a-z0-9_-]{0,63}"\)/.test(viewsContent));
	return hasGeneratedHermesRoot || (!hasSharedTaskNotesRootContent && hasLegacyHermesBoardView);
}

function upsertHermesBoardView(
	content: string,
	board: string,
	settings?: Pick<TaskNotesSettings, "fieldMapping" | "taskTag">
): string {
	const desiredView = buildHermesBoardKanbanBase(board, settings).trimEnd();
	const existingBlocks = findHermesBoardViewBlocks(content, board);
	const generatedBlocks = existingBlocks.filter((block) => isGeneratedHermesBoardView(block.block, board));
	if (generatedBlocks.length === 0) {
		if (existingBlocks.length > 0) {
			return content;
		}
		const contentWithViews = /^views:\s*$/m.test(content)
			? content.trimEnd()
			: `${content.trimEnd()}\n\nviews:`;
		return `${contentWithViews}\n${desiredView}\n`;
	}

	const [primaryBlock, ...duplicateBlocks] = generatedBlocks;
	let nextContent = content;
	for (const duplicateBlock of duplicateBlocks.slice().reverse()) {
		nextContent = `${nextContent.slice(0, duplicateBlock.start)}${nextContent.slice(
			duplicateBlock.end
		)}`;
	}

	if (primaryBlock.block === desiredView && duplicateBlocks.length === 0) {
		return content;
	}

	const tail = nextContent.slice(primaryBlock.end);
	const separator = tail.length > 0 && !tail.startsWith("\n") ? "\n" : "";
	return `${nextContent.slice(0, primaryBlock.start)}${desiredView}${separator}${tail}`;
}

type HermesBoardViewBlock = { start: number; end: number; block: string };

function removeGeneratedFixtureHermesBoardViews(content: string): string {
	const generatedFixtureBlocks = findAllHermesBoardViewBlocks(content).filter((block) => {
		const board = getHermesBoardSlugFromViewBlock(block.block);
		return Boolean(board && isHermesBoardFixtureSlug(board) && isGeneratedHermesBoardView(block.block, board));
	});

	if (generatedFixtureBlocks.length === 0) {
		return content;
	}

	let nextContent = content;
	for (const block of generatedFixtureBlocks.slice().reverse()) {
		nextContent = `${nextContent.slice(0, block.start)}${nextContent.slice(block.end)}`;
	}
	return nextContent;
}

function findHermesBoardViewBlocks(content: string, board: string): HermesBoardViewBlock[] {
	const title = formatBoardTitle(board);
	return findAllHermesBoardViewBlocks(content).filter((block) => {
		const blockName = getHermesBoardViewBlockName(block.block);
		return blockName === title || blockName === `${title} Runs` || blockName === `${title} Archive`;
	});
}

function findAllHermesBoardViewBlocks(content: string): HermesBoardViewBlock[] {
	const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const blocks: HermesBoardViewBlock[] = [];
	let offset = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!/^ {2}- type: (?:tasknotesKanban|table)\s*$/.test(line)) {
			offset += line.length;
			continue;
		}

		const start = offset;
		let end = offset + line.length;
		let nextIndex = index + 1;
		while (nextIndex < lines.length && !/^ {2}- /.test(lines[nextIndex])) {
			end += lines[nextIndex].length;
			nextIndex += 1;
		}

		const block = content.slice(start, end).trimEnd();
		blocks.push({ start, end, block });

		offset = end;
		index = nextIndex - 1;
	}

	return blocks;
}

function getHermesBoardSlugFromViewBlock(block: string): string | null {
	const boardFilterMatch = block.match(/^\s*-?\s*(?:hermesBoard|hermes_board)\s*==\s*(.+?)\s*$/m);
	const boardFromFilter = boardFilterMatch ? normalizeBoardSlug(parseBasesYamlScalar(boardFilterMatch[1])) : null;
	if (boardFromFilter) {
		return boardFromFilter;
	}

	const hermesProjectMatch = block.match(/Hermes\/([a-z0-9][a-z0-9_-]{0,63})/);
	if (hermesProjectMatch) {
		return normalizeBoardSlug(hermesProjectMatch[1]);
	}

	const folderMatch = block.match(/file\.inFolder\("TaskNotes\/([a-z0-9][a-z0-9_-]{0,63})"\)/);
	return folderMatch ? normalizeBoardSlug(folderMatch[1]) : null;
}

function getHermesBoardViewBlockName(block: string): string | null {
	const nameMatch = block.match(/^ {4}name:\s*(.+?)\s*$/m);
	if (!nameMatch) {
		return null;
	}
	return parseBasesYamlScalar(nameMatch[1]);
}

function parseBasesYamlScalar(value: string): string {
	const trimmedValue = value.trim();
	if (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) {
		try {
			return JSON.parse(trimmedValue) as string;
		} catch {
			return trimmedValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
	}
	return trimmedValue;
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
	for (const legacyPath of getLegacyHermesBoardViewPaths(board)) {
		const legacyView = vault.getAbstractFileByPath(legacyPath);
		if (!(legacyView instanceof TFile)) {
			continue;
		}

		const legacyContent = await vault.read(legacyView);
		if (!isGeneratedLegacyHermesBoardView(legacyContent, board, legacyPath)) {
			result.legacyViewsSkipped.push(legacyPath);
			continue;
		}

		await deleteVaultFile({ vault }, legacyView);
		result.legacyViewsRemoved.push(legacyPath);
	}
}

function getLegacyHermesBoardViewPaths(board: string): string[] {
	return [
		normalizePath(`${TASKNOTES_VIEWS_FOLDER}/kanban-board-${board}.base`),
		normalizePath(`${TASKNOTES_VIEWS_FOLDER}/kanban-${board}.base`),
	].filter((path) => path !== SHARED_HERMES_KANBAN_VIEW_PATH);
}

async function removeGeneratedLegacyHermesBoardViews(
	vault: HermesBoardProvisionHost["app"]["vault"],
	result: HermesBoardProvisionResult
): Promise<void> {
	const legacyViews = vault
		.getFiles()
		.filter((file) => file.path.startsWith(`${TASKNOTES_VIEWS_FOLDER}/kanban-board-`))
		.filter((file) => file.path.endsWith(".base"));

	for (const legacyView of legacyViews) {
		if (result.legacyViewsRemoved.includes(legacyView.path) || result.legacyViewsSkipped.includes(legacyView.path)) {
			continue;
		}

		const board = getBoardSlugFromLegacyBoardViewPath(legacyView.path);
		if (!board) {
			result.legacyViewsSkipped.push(legacyView.path);
			continue;
		}

		const legacyContent = await vault.read(legacyView);
		if (!isGeneratedLegacyHermesBoardView(legacyContent, board, legacyView.path)) {
			result.legacyViewsSkipped.push(legacyView.path);
			continue;
		}

		await deleteVaultFile({ vault }, legacyView);
		result.legacyViewsRemoved.push(legacyView.path);
	}
}

function getBoardSlugFromLegacyBoardViewPath(path: string): string | null {
	const match = normalizePath(path).match(/^TaskNotes\/Views\/kanban-board-(.+)\.base$/);
	return match ? normalizeBoardSlug(match[1]) : null;
}

function isGeneratedLegacyHermesBoardView(content: string, board: string, path: string): boolean {
	if (isGeneratedHermesBoardView(content, board)) {
		return true;
	}
	return isLegacyBoardPrefixedViewPath(path) && isGeneratedHermesBoardPrefixedLegacyView(content, board);
}

function isLegacyBoardPrefixedViewPath(path: string): boolean {
	return /^TaskNotes\/Views\/kanban-board-.+\.base$/.test(normalizePath(path));
}

function isGeneratedHermesBoardPrefixedLegacyView(content: string, board: string): boolean {
	return (
		content.includes("type: tasknotesKanban") &&
		hasHermesBoardFilter(content, board) &&
		(content.includes("pinnedColumns: triage,todo,ready,running,blocked,done") ||
			content.includes("tasknotes_manual_order") ||
			content.includes("columnWidth: 280"))
	);
}

function isGeneratedHermesBoardStandaloneFile(content: string, board: string): boolean {
	return content.trimStart().startsWith(`# ${formatBoardTitle(board)} Kanban`) &&
		isGeneratedHermesBoardView(content, board);
}

function isGeneratedHermesBoardView(content: string, board: string): boolean {
	const blockName = getHermesBoardViewBlockName(content);
	const title = formatBoardTitle(board);
	const hasGeneratedName =
		content.includes(`# ${title} Kanban`) ||
		blockName === title ||
		blockName === `${title} Runs` ||
		blockName === `${title} Archive`;
	return (
		hasGeneratedName &&
		hasHermesBoardFilter(content, board) &&
		(content.includes("type: tasknotesKanban") || content.includes("type: table"))
	);
}

function hasHermesBoardFilter(content: string, board: string): boolean {
	return (
		content.includes(`Hermes/${board}`) ||
		content.includes(`file.inFolder("${TASKNOTES_ROOT}/${board}")`) ||
		content.includes(`${HERMES_BOARD_FRONTMATTER} == "${escapeBasesStringLiteral(board)}"`) ||
		content.includes(`hermesBoard == "${escapeBasesStringLiteral(board)}"`) ||
		content.includes(`file.inFolder("${TASKNOTES_ROOT}/Tasks")`)
	);
}

function isHermesBoardFixtureSlug(slug: string): boolean {
	return /(?:^e2e[-_]|[-_]e2e[-_]|[-_]e2e$|[-_]fixture$|^fixture[-_])/.test(slug);
}

function isPresent(value: string | null): value is string {
	return typeof value === "string" && value.length > 0;
}
