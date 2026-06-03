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
	HERMES_REVIEW_RAIL_FIELD_ID,
} from "./hermesAssignee";
import { HERMES_ACTIVITY_USER_FIELDS } from "./hermesActivityFrontmatter";
import { HERMES_DEFAULT_BOARDS, normalizeHermesBoardValue, splitHermesList } from "./hermesRouting";
import { HERMES_TASKNOTES_LOCAL_CREATION_TARGET } from "./hermesTaskNotesApiSync";

const TASKNOTES_ROOT = "TaskNotes";

type HermesModalField = ModalFieldConfigLike & {
	group: string;
	displayName: string;
	visibleInCreation: boolean;
	visibleInEdit: boolean;
	enabled: boolean;
	order: number;
	fieldType: "core" | "user" | "dependency" | "organization" | "integration";
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
			id: "custom",
			displayName: "Other Fields",
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
	userFields: readonly UserMappedField[] = [],
	modalFieldsConfig?: ModalFieldsConfigLike
): ModalFieldsConfigLike {
	const fields: HermesModalField[] = [
		field("title", "core", "basic", 0, "Title", true, true),
		{
			...field("details", "core", "basic", 1, "Details", true, false),
			enabled: false,
		},
		field("projects", "core", "routing", 0, "Board", true, true),
		field("contexts", "core", "routing", 1, "Assignee", true, true),
		field("blocked-by", "dependency", "dependencies", 0, "Blocked By", true, true),
		field("blocking", "dependency", "dependencies", 1, "Blocking", true, true),
		getHermesReviewRailModalField(modalFieldsConfig),
		...getHermesActivityModalFields(userFields, modalFieldsConfig),
	];

	return { groups: modalGroups(), fields };
}

function getHermesReviewRailModalField(
	modalFieldsConfig?: ModalFieldsConfigLike
): HermesModalField {
	const configuredField = modalFieldsConfig?.fields?.find(
		(fieldConfig) => fieldConfig.id === HERMES_REVIEW_RAIL_FIELD_ID
	);
	return {
		id: HERMES_REVIEW_RAIL_FIELD_ID,
		fieldType: "integration",
		group: "custom",
		displayName: "Hermes review rail",
		order: configuredField?.order ?? 90,
		enabled: configuredField?.enabled ?? true,
		visibleInCreation: false,
		visibleInEdit: configuredField?.visibleInEdit ?? true,
	};
}

function getHermesActivityModalFields(
	userFields: readonly UserMappedField[],
	modalFieldsConfig?: ModalFieldsConfigLike
): HermesModalField[] {
	return HERMES_ACTIVITY_USER_FIELDS.flatMap((activityField, index) => {
		const isRegistered = userFields.some(
			(userField) => userField.id === activityField.id || userField.key === activityField.key
		);
		if (!isRegistered) {
			return [];
		}

		const configuredField = modalFieldsConfig?.fields?.find(
			(fieldConfig) => fieldConfig.id === activityField.id
		);
		if (configuredField && (!configuredField.enabled || !configuredField.visibleInEdit)) {
			return [];
		}

		return [
			field(
				activityField.id,
				"user",
				"custom",
				configuredField?.order ?? index,
				activityField.displayName,
				false,
				true
			),
		];
	});
}

export function buildHermesTaskCreationOptions(
	app: App,
	userFields: readonly UserMappedField[] = [],
	prePopulatedValues?: TaskCreationPrepopulatedValues,
	onTaskCreated?: (task: TaskInfo) => void,
	defaultProjects?: unknown
): TaskCreationOptions {
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
		modalFieldsConfig: createHermesCreationFieldConfig(userFields),
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

export function buildHermesGoalModeTaskCreationOptions(
	app: App,
	userFields: readonly UserMappedField[] = [],
	prePopulatedValues?: TaskCreationPrepopulatedValues,
	onTaskCreated?: (task: TaskInfo) => void,
	defaultProjects?: unknown
): TaskCreationOptions {
	const options = buildHermesTaskCreationOptions(
		app,
		userFields,
		prePopulatedValues,
		onTaskCreated,
		defaultProjects
	);
	return {
		...options,
		hermesCreationMode: "goal",
		modalTitle: "Create Goal Mode card",
		saveButtonText: "Create Goal Mode card",
		prePopulatedValues: {
			...options.prePopulatedValues,
			tags: uniqueStrings([
				...asStringArray(options.prePopulatedValues?.tags),
				"hermes-goal",
			]),
			customFrontmatter: {
				...customFrontmatter(options.prePopulatedValues),
				hermesCardMode: "goal",
				hermesMode: "goal",
			},
		},
	};
}

export { normalizeHermesModalFieldsConfig, normalizeHermesUserFields };

export function buildHermesTaskEditOptions(
	task: TaskInfo,
	userFields: readonly UserMappedField[] = [],
	onTaskUpdated?: (task: TaskInfo) => void,
	modalFieldsConfig?: ModalFieldsConfigLike
): TaskEditOptions {
	return {
		task,
		onTaskUpdated,
		modalTitle: "Update task",
		modalFieldsConfig: createHermesEditFieldConfig(userFields, modalFieldsConfig),
	};
}
