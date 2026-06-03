import { App, TFile, TFolder } from "obsidian";
import type { TaskInfo } from "../types";
import type { UserMappedField } from "../types/settings";
import type { TaskCreationOptions } from "../modals/TaskCreationModal";
import type { TaskCreationPrepopulatedValues } from "../modals/taskCreationFormState";
import {
	normalizeHermesModalFieldsConfig,
	normalizeHermesUserFields,
	normalizeHermesAssignee,
} from "./hermesAssignee";
import { HERMES_DEFAULT_BOARDS, normalizeHermesBoardValue, splitHermesList } from "./hermesRouting";
import { HERMES_TASKNOTES_LOCAL_CREATION_TARGET } from "./hermesTaskNotesApiSync";

const TASKNOTES_ROOT = "TaskNotes";

function asStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function customFrontmatter(
	values?: TaskCreationPrepopulatedValues | Partial<TaskInfo>
): Record<string, unknown> {
	if (!values || !("customFrontmatter" in values) || !values.customFrontmatter) {
		return {};
	}
	return values.customFrontmatter;
}

function activeFile(app: App): TFile | null {
	const workspace = (app as Partial<App>).workspace;
	if (!workspace?.getActiveFile) return null;
	const file = workspace.getActiveFile();
	return file instanceof TFile ? file : null;
}

function boardFromHermesTaskPath(path: string): string | null {
	const match = path.match(/^TaskNotes\/([^/]+)\/t_[^/]+\.md$/);
	return match ? match[1] : null;
}

export function getHermesBoards(app: App): string[] {
	const boards = new Set<string>(HERMES_DEFAULT_BOARDS);
	if (!app.vault?.getAbstractFileByPath) {
		return [...boards].sort((a, b) => a.localeCompare(b));
	}
	const root = app.vault.getAbstractFileByPath(TASKNOTES_ROOT);
	if (root instanceof TFolder) {
		for (const child of root.children) {
			if (child instanceof TFolder) {
				boards.add(child.name);
			}
		}
	}
	return [...boards].sort((a, b) => a.localeCompare(b));
}

export function getActiveHermesBoard(app: App): string | null {
	const file = activeFile(app);
	if (!file) return null;
	return boardFromHermesTaskPath(file.path);
}

function preferredBoard(app: App): string {
	const boards = getHermesBoards(app);
	return (
		getActiveHermesBoard(app) ??
		boards.find((board) => board === "obsidian-os") ??
		boards[0] ??
		"default"
	);
}

function boardFromPrepopulated(
	values?: TaskCreationPrepopulatedValues,
	knownBoards: readonly string[] = HERMES_DEFAULT_BOARDS
): string | null {
	const projectBoard = boardFromProjectsValue(values?.projects, knownBoards);
	if (projectBoard) return projectBoard;
	const contexts = asStringArray(values?.contexts);
	return contexts.find((context) => knownBoards.includes(context)) ?? null;
}

function boardFromProjectsValue(
	value: unknown,
	knownBoards: readonly string[] = HERMES_DEFAULT_BOARDS
): string | null {
	for (const project of splitHermesList(value)) {
		const board = normalizeHermesBoardValue(project);
		if (board && knownBoards.includes(board)) {
			return board;
		}
	}
	return null;
}

export function buildHermesTaskCreationOptions(
	app: App,
	userFields: readonly UserMappedField[] = [],
	prePopulatedValues?: TaskCreationPrepopulatedValues,
	onTaskCreated?: (task: TaskInfo) => void,
	defaultProjects?: unknown
): TaskCreationOptions {
	void userFields;
	const boards = getHermesBoards(app);
	const explicitBoard = boardFromPrepopulated(prePopulatedValues, boards);
	const defaultBoard = boardFromProjectsValue(defaultProjects, boards);
	const board = explicitBoard ?? defaultBoard ?? getActiveHermesBoard(app) ?? preferredBoard(app);
	const boardOptions = uniqueStrings([board, ...boards]);
	const incomingFrontmatter = customFrontmatter(prePopulatedValues);
	const legacyAssignee = normalizeHermesAssignee(incomingFrontmatter.assignee);
	const custom = {
		...incomingFrontmatter,
	};
	delete custom.assignee;
	const status =
		typeof prePopulatedValues?.status === "string" && prePopulatedValues.status.trim()
			? prePopulatedValues.status
			: "triage";

	return {
		prePopulatedValues: {
			...prePopulatedValues,
			status,
			projects: [`Hermes/${board}`],
			contexts: uniqueStrings([
				...(legacyAssignee ? [legacyAssignee] : []),
				...asStringArray(prePopulatedValues?.contexts).filter(
					(context) => !boards.includes(context) && context !== "hermes-kanban"
				),
			]),
			tags: uniqueStrings([...asStringArray(prePopulatedValues?.tags), "hermes-kanban"]),
			customFrontmatter: custom,
		},
		onTaskCreated,
		modalTitle: "Create task",
		saveButtonText: "Create task",
		creationTargetPicker: {
			boards: boardOptions,
			selectedTarget: HERMES_TASKNOTES_LOCAL_CREATION_TARGET,
		},
		hermesBoardPicker: {
			boards: boardOptions,
			selectedBoard: board,
		},
	};
}

export { normalizeHermesModalFieldsConfig, normalizeHermesUserFields };
