import { App, TFile, TFolder } from "obsidian";
import type { TaskInfo } from "../types";
import type { UserMappedField } from "../types/settings";
import type { TaskCreationOptions } from "../modals/TaskCreationModal";
import type { TaskEditOptions } from "../modals/TaskEditModal";
import type { TaskCreationPrepopulatedValues } from "../modals/taskCreationFormState";
import type { ModalFieldConfigLike, ModalFieldsConfigLike } from "../modals/taskModalFieldConfig";

const HERMES_ROOT = "TaskNotes/Hermes";
const HERMES_VIEWS_ROOT = "TaskNotes/Views";
const HERMES_KANBAN_TAG = "hermes-kanban";
const HERMES_SUBMIT_TAG = "hermes-submit";
const DEFAULT_HERMES_BOARDS = [
	"obsidian-os",
	"hhmi",
	"job-hunt",
	"vault-change-review",
	"hermes-agent",
	"default",
];

type HermesModalField = ModalFieldConfigLike & {
	group: string;
	displayName: string;
	visibleInCreation: boolean;
	visibleInEdit: boolean;
	enabled: boolean;
	order: number;
	fieldType: "core" | "user" | "dependency" | "organization";
};

type HermesModalGroup = {
	id: string;
	displayName: string;
	order: number;
	collapsible: boolean;
	defaultCollapsed: boolean;
};

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

function customString(task: TaskInfo, key: string): string {
	const value = task.customProperties?.[key];
	return typeof value === "string" ? value.trim() : "";
}

function activeFile(app: App): TFile | null {
	const workspace = (app as Partial<App>).workspace;
	if (!workspace?.getActiveFile) return null;
	const file = workspace.getActiveFile();
	return file instanceof TFile ? file : null;
}

function boardFromHermesTaskPath(path: string): string | null {
	const match = path.match(/^TaskNotes\/Hermes\/([^/]+)\/[^/]+\.md$/);
	return match ? match[1] : null;
}

export function getHermesBoards(app: App): string[] {
	const boards = new Set(DEFAULT_HERMES_BOARDS);
	if (!app.vault?.getAbstractFileByPath) {
		return [...boards].sort((a, b) => a.localeCompare(b));
	}
	const root = app.vault.getAbstractFileByPath(HERMES_ROOT);
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
	knownBoards: readonly string[] = DEFAULT_HERMES_BOARDS
): string | null {
	const frontmatter = customFrontmatter(values);
	const board =
		typeof frontmatter.hermes_board === "string" ? frontmatter.hermes_board.trim() : "";
	if (board) return board;
	const contexts = asStringArray(values?.contexts);
	return contexts.find((context) => knownBoards.includes(context)) ?? null;
}

export function isHermesTask(task: TaskInfo): boolean {
	return (
		task.path.startsWith(`${HERMES_ROOT}/`) ||
		Boolean(customString(task, "hermes_id")) ||
		Boolean(customString(task, "hermes_board")) ||
		(task.tags ?? []).includes(HERMES_KANBAN_TAG)
	);
}

export function isHermesCreationContext(
	app: App,
	values?: TaskCreationPrepopulatedValues
): boolean {
	const frontmatter = customFrontmatter(values);
	if (frontmatter.hermes_submit || frontmatter.hermes_board) return true;
	if (asStringArray(values?.tags).includes(HERMES_KANBAN_TAG)) return true;
	if (boardFromPrepopulated(values, getHermesBoards(app))) return true;

	const file = activeFile(app);
	if (!file) return false;
	return (
		file.path.startsWith(`${HERMES_ROOT}/`) ||
		(file.path.startsWith(`${HERMES_VIEWS_ROOT}/`) && file.basename.startsWith("hermes"))
	);
}

function modalGroups(): HermesModalGroup[] {
	return [
		{
			id: "basic",
			displayName: "Task",
			order: 0,
			collapsible: false,
			defaultCollapsed: false,
		},
		{
			id: "routing",
			displayName: "Routing",
			order: 1,
			collapsible: false,
			defaultCollapsed: false,
		},
		{
			id: "dependencies",
			displayName: "Dependencies",
			order: 2,
			collapsible: true,
			defaultCollapsed: false,
		},
		{
			id: "writeback",
			displayName: "Hermes Actions",
			order: 3,
			collapsible: true,
			defaultCollapsed: false,
		},
	];
}

function field(
	id: string,
	fieldType: HermesModalField["fieldType"],
	group: string,
	order: number,
	displayName: string,
	visibleInCreation: boolean,
	visibleInEdit: boolean
): HermesModalField {
	return {
		id,
		fieldType,
		group,
		displayName,
		order,
		enabled: true,
		visibleInCreation,
		visibleInEdit,
	};
}

function userFieldIds(userFields: readonly UserMappedField[], ids: readonly string[]): string[] {
	const existing = new Set(userFields.map((userField) => userField.id));
	return ids.filter((id) => existing.has(id));
}

export function createHermesCreationFieldConfig(
	userFields: readonly UserMappedField[] = []
): ModalFieldsConfigLike {
	const fields: HermesModalField[] = [
		field("title", "core", "basic", 0, "Title", true, true),
		field("details", "core", "basic", 1, "Details", true, true),
		field("contexts", "core", "routing", 0, "Board", true, true),
		field("blocked-by", "dependency", "dependencies", 0, "Blocked By", true, true),
		field("blocking", "dependency", "dependencies", 1, "Blocking", true, true),
	];

	for (const id of userFieldIds(userFields, [
		"hermes_assignee",
		"hermes_priority",
		"hermes_parent",
	])) {
		fields.push(field(id, "user", "routing", fields.length, id, false, false));
	}

	return { groups: modalGroups(), fields };
}

export function createHermesEditFieldConfig(
	_userFields: readonly UserMappedField[] = []
): ModalFieldsConfigLike {
	const fields: HermesModalField[] = [
		field("title", "core", "basic", 0, "Title", true, true),
		field("details", "core", "basic", 1, "Details", true, true),
		field("contexts", "core", "routing", 0, "Board", true, true),
		field("blocked-by", "dependency", "dependencies", 0, "Blocked By", true, true),
		field("blocking", "dependency", "dependencies", 1, "Blocking", true, true),
	];

	return { groups: modalGroups(), fields };
}

export function buildHermesTaskCreationOptions(
	app: App,
	userFields: readonly UserMappedField[] = [],
	prePopulatedValues?: TaskCreationPrepopulatedValues,
	onTaskCreated?: (task: TaskInfo) => void
): TaskCreationOptions {
	const boards = getHermesBoards(app);
	const explicitBoard =
		boardFromPrepopulated(prePopulatedValues, boards) ?? getActiveHermesBoard(app);
	const board = explicitBoard ?? preferredBoard(app);
	const boardOptions = uniqueStrings([board, ...boards]);
	const incomingFrontmatter = customFrontmatter(prePopulatedValues);
	const custom = {
		...incomingFrontmatter,
		hermes_submit: true,
		hermes_board: incomingFrontmatter.hermes_board ?? board,
		hermes_assignee: incomingFrontmatter.hermes_assignee ?? "none",
		hermes_priority: incomingFrontmatter.hermes_priority ?? "3",
		hermes_created_by: incomingFrontmatter.hermes_created_by ?? "tasknotes-native",
	};

	return {
		prePopulatedValues: {
			...prePopulatedValues,
			status: "triage",
			contexts: uniqueStrings([board, ...asStringArray(prePopulatedValues?.contexts)]),
			tags: uniqueStrings([...asStringArray(prePopulatedValues?.tags), HERMES_SUBMIT_TAG]),
			customFrontmatter: custom,
		},
		onTaskCreated,
		modalTitle: "Create Hermes task",
		saveButtonText: "Send to triage",
		modalFieldsConfig: createHermesCreationFieldConfig(userFields),
		creationTargetPicker: {
			boards: boardOptions,
			selectedTarget: `hermes:${board}`,
		},
		hermesBoardPicker: {
			boards: boardOptions,
			selectedBoard: board,
		},
	};
}

export function buildDefaultTaskCreationOptionsWithHermesTargets(
	app: App,
	prePopulatedValues?: TaskCreationPrepopulatedValues,
	onTaskCreated?: (task: TaskInfo) => void
): TaskCreationOptions {
	const boards = getHermesBoards(app);
	const board = boardFromPrepopulated(prePopulatedValues, boards) ?? preferredBoard(app);
	const boardOptions = uniqueStrings([board, ...boards]);

	return {
		prePopulatedValues,
		onTaskCreated,
		creationTargetPicker: {
			boards: boardOptions,
			selectedTarget: "default",
		},
		hermesBoardPicker: {
			boards: boardOptions,
			selectedBoard: board,
		},
	};
}

export function buildHermesTaskEditOptions(
	task: TaskInfo,
	userFields: readonly UserMappedField[] = [],
	onTaskUpdated?: (task: TaskInfo) => void
): TaskEditOptions {
	return {
		task,
		onTaskUpdated,
		modalTitle: "Update Hermes task",
		saveButtonText: "Save Hermes update",
		modalFieldsConfig: createHermesEditFieldConfig(userFields),
	};
}
