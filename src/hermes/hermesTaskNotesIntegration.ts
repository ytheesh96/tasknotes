import { App, TFile, TFolder } from "obsidian";
import type { TaskInfo } from "../types";
import type { UserMappedField } from "../types/settings";
import type { TaskCreationOptions } from "../modals/TaskCreationModal";
import type { TaskEditOptions } from "../modals/TaskEditModal";
import type { TaskCreationPrepopulatedValues } from "../modals/taskCreationFormState";
import type { ModalFieldConfigLike, ModalFieldsConfigLike } from "../modals/taskModalFieldConfig";
import {
	normalizeHermesModalFieldsConfig,
	normalizeHermesUserFields,
	normalizeHermesAssignee,
} from "./hermesAssignee";
import { HERMES_DEFAULT_BOARDS } from "./hermesRouting";

const TASKNOTES_ROOT = "TaskNotes";

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
	const projects = asStringArray(values?.projects);
	for (const project of projects) {
		const match = project.match(/^Hermes\/([^/]+)$/);
		if (match && knownBoards.includes(match[1])) {
			return match[1];
		}
	}
	const contexts = asStringArray(values?.contexts);
	return contexts.find((context) => knownBoards.includes(context)) ?? null;
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

export function createHermesCreationFieldConfig(
	userFields: readonly UserMappedField[] = []
): ModalFieldsConfigLike {
	void userFields;
	const fields: HermesModalField[] = [
		field("title", "core", "basic", 0, "Title", true, true),
		field("details", "core", "basic", 1, "Details", true, true),
		field("projects", "core", "routing", 0, "Board", true, true),
		field("contexts", "core", "routing", 1, "Assignee", true, true),
		field("blocked-by", "dependency", "dependencies", 0, "Blocked By", true, true),
		field("blocking", "dependency", "dependencies", 1, "Blocking", true, true),
	];

	return { groups: modalGroups(), fields };
}

export function createHermesEditFieldConfig(
	userFields: readonly UserMappedField[] = []
): ModalFieldsConfigLike {
	void userFields;
	const fields: HermesModalField[] = [
		field("title", "core", "basic", 0, "Title", true, true),
		field("details", "core", "basic", 1, "Details", true, true),
		field("projects", "core", "routing", 0, "Board", true, true),
		field("contexts", "core", "routing", 1, "Assignee", true, true),
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

export {
	normalizeHermesModalFieldsConfig,
	normalizeHermesUserFields,
};

export function buildHermesTaskEditOptions(
	task: TaskInfo,
	userFields: readonly UserMappedField[] = [],
	onTaskUpdated?: (task: TaskInfo) => void
): TaskEditOptions {
	return {
		task,
		onTaskUpdated,
		modalTitle: "Update task",
		saveButtonText: "Save update",
		modalFieldsConfig: createHermesEditFieldConfig(userFields),
	};
}
