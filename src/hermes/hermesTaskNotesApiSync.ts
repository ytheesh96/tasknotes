import type { TaskDependency, TaskInfo, WebhookConfig, WebhookEvent } from "../types";
import { getHermesTaskIdentity, type HermesTaskIdentity } from "./hermesApiClient";
import { HERMES_BOARD_FRONTMATTER } from "./hermesCanonicalTaskNotes";

export const HERMES_TASKNOTES_WEBHOOK_ID = "hermes-tasknotes-sync";
export const HERMES_TASKNOTES_LOCAL_CREATION_TARGET = "tasknotes";

export const HERMES_TASKNOTES_TASK_EVENTS: WebhookEvent[] = [
	"task.created",
	"task.updated",
	"task.deleted",
	"task.completed",
	"task.archived",
	"task.unarchived",
];

export type TaskNotesFilterOperator =
	| "is"
	| "is-not"
	| "contains"
	| "does-not-contain"
	| "is-before"
	| "is-after"
	| "is-on-or-before"
	| "is-on-or-after"
	| "is-empty"
	| "is-not-empty"
	| "is-checked"
	| "is-not-checked"
	| "is-greater-than"
	| "is-less-than"
	| "is-greater-than-or-equal"
	| "is-less-than-or-equal";

export interface TaskNotesFilterCondition {
	type: "condition";
	id: string;
	property: string;
	operator: TaskNotesFilterOperator;
	value?: unknown;
}

export interface TaskNotesFilterGroup {
	type: "group";
	id: string;
	conjunction: "and" | "or";
	children: Array<TaskNotesFilterCondition | TaskNotesFilterGroup>;
	sortKey?: string;
	sortDirection?: "asc" | "desc";
	groupKey?: string;
	subgroupKey?: string;
}

export interface HermesTaskNotesEligibilityOptions {
	boards?: readonly string[];
	tags?: readonly string[];
	projects?: readonly string[];
	contexts?: readonly string[];
	statuses?: readonly string[];
	includeArchived?: boolean;
}

export interface HermesWebhookConfigInput {
	url: string;
	secret: string;
	id?: string;
	createdAt?: string;
	active?: boolean;
	corsHeaders?: boolean;
}

export interface HermesTaskNotesQueryInput {
	board?: string;
	tag?: string;
	project?: string;
	context?: string;
	statuses?: readonly string[];
	includeArchived?: boolean;
	sortKey?: string;
	sortDirection?: "asc" | "desc";
}

export interface HermesTaskNotesExecutionUpdateInput {
	status?: string;
	assignee?: string | null;
	priority?: string | number | null;
	blockedBy?: readonly TaskDependency[];
	artifactLinks?: readonly string[];
	activitySummary?: string;
	artifactFieldKey?: string;
	activitySummaryFieldKey?: string;
}

export function getHermesTaskNotesIdentity(task: TaskInfo): HermesTaskIdentity | null {
	return getHermesTaskIdentity(task);
}

export function isHermesTaskNotesEligibleTask(
	task: TaskInfo,
	options: HermesTaskNotesEligibilityOptions = {}
): boolean {
	const identity = getHermesTaskNotesIdentity(task);
	if (!identity) {
		return false;
	}
	if (!options.includeArchived && task.archived) {
		return false;
	}
	if (hasConfiguredValues(options.boards) && !options.boards.includes(identity.board)) {
		return false;
	}
	if (hasConfiguredValues(options.statuses) && !options.statuses.includes(task.status)) {
		return false;
	}
	if (hasConfiguredValues(options.tags) && !hasAnyValue(task.tags, options.tags)) {
		return false;
	}
	if (hasConfiguredValues(options.projects) && !hasAnyValue(task.projects, options.projects)) {
		return false;
	}
	if (hasConfiguredValues(options.contexts) && !hasAnyValue(task.contexts, options.contexts)) {
		return false;
	}
	return true;
}

export function getHermesTaskNotesEligibleBoards(
	tasks: readonly TaskInfo[],
	options: HermesTaskNotesEligibilityOptions = {}
): string[] {
	const boards = new Set<string>();
	for (const task of tasks) {
		if (!isHermesTaskNotesEligibleTask(task, options)) {
			continue;
		}
		const identity = getHermesTaskNotesIdentity(task);
		if (identity) {
			boards.add(identity.board);
		}
	}
	return [...boards].sort((left, right) => left.localeCompare(right));
}

export function getHermesTaskNotesBoardFromTaskEvent(
	eventData: unknown,
	options: HermesTaskNotesEligibilityOptions = {}
): string | null {
	const task = getTaskFromTaskEvent(eventData);
	if (!task || !isHermesTaskNotesEligibleTask(task, options)) {
		return null;
	}
	return getHermesTaskNotesIdentity(task)?.board ?? null;
}

export function buildHermesTaskNotesWebhookConfig(input: HermesWebhookConfigInput): WebhookConfig {
	return {
		id: input.id ?? HERMES_TASKNOTES_WEBHOOK_ID,
		url: input.url,
		events: [...HERMES_TASKNOTES_TASK_EVENTS],
		secret: input.secret,
		active: input.active ?? true,
		createdAt: input.createdAt ?? new Date().toISOString(),
		failureCount: 0,
		successCount: 0,
		corsHeaders: input.corsHeaders ?? true,
	};
}

export function buildHermesTaskNotesBoardQuery(
	input: HermesTaskNotesQueryInput = {}
): TaskNotesFilterGroup {
	const children: Array<TaskNotesFilterCondition | TaskNotesFilterGroup> = [];
	if (!input.includeArchived) {
		children.push({
			type: "condition",
			id: "not-archived",
			property: "archived",
			operator: "is-not-checked",
		});
	}
	if (input.board) {
		children.push({
			type: "condition",
			id: "board",
			property: HERMES_BOARD_FRONTMATTER,
			operator: "is",
			value: input.board,
		});
	}
	const project = input.project;
	if (project) {
		children.push({
			type: "condition",
			id: "project",
			property: "projects",
			operator: "contains",
			value: project,
		});
	}
	if (input.context) {
		children.push({
			type: "condition",
			id: "context",
			property: "contexts",
			operator: "contains",
			value: input.context,
		});
	}
	if (input.tag) {
		children.push({
			type: "condition",
			id: "tag",
			property: "tags",
			operator: "contains",
			value: input.tag,
		});
	}
	if (input.statuses && input.statuses.length > 0) {
		children.push(buildStatusQuery(input.statuses));
	}
	return {
		type: "group",
		id: "hermes-tasknotes-root",
		conjunction: "and",
		children,
		sortKey: input.sortKey ?? "dateModified",
		sortDirection: input.sortDirection ?? "desc",
	};
}

export function buildHermesTaskNotesExecutionUpdatePayload(
	input: HermesTaskNotesExecutionUpdateInput
): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (input.status) {
		payload.status = input.status;
	}
	if (input.assignee !== undefined) {
		payload.contexts = input.assignee ? [input.assignee] : [];
	}
	if (input.priority !== undefined && input.priority !== null) {
		payload.priority = String(input.priority);
	}
	if (input.blockedBy) {
		payload.blockedBy = [...input.blockedBy];
	}
	const customProperties: Record<string, unknown> = {};
	if (input.artifactFieldKey && input.artifactLinks) {
		customProperties[input.artifactFieldKey] = [...input.artifactLinks];
	}
	if (input.activitySummaryFieldKey && input.activitySummary) {
		customProperties[input.activitySummaryFieldKey] = input.activitySummary;
	}
	if (Object.keys(customProperties).length > 0) {
		payload.customProperties = customProperties;
	}
	return payload;
}

function buildStatusQuery(
	statuses: readonly string[]
): TaskNotesFilterCondition | TaskNotesFilterGroup {
	const uniqueStatuses = [...new Set(statuses.map((status) => status.trim()).filter(Boolean))];
	if (uniqueStatuses.length === 1) {
		return {
			type: "condition",
			id: "status",
			property: "status",
			operator: "is",
			value: uniqueStatuses[0],
		};
	}
	return {
		type: "group",
		id: "statuses",
		conjunction: "or",
		children: uniqueStatuses.map((status) => ({
			type: "condition",
			id: `status-${status}`,
			property: "status",
			operator: "is",
			value: status,
		})),
	};
}

function getTaskFromTaskEvent(eventData: unknown): TaskInfo | null {
	if (!isRecord(eventData)) {
		return null;
	}
	for (const key of ["updatedTask", "task", "taskInfo", "deletedTask"] as const) {
		const value = eventData[key];
		if (isTaskInfoLike(value)) {
			return value;
		}
	}
	return null;
}

function isTaskInfoLike(value: unknown): value is TaskInfo {
	return isRecord(value) && typeof value.path === "string";
}

function hasConfiguredValues(values: readonly string[] | undefined): values is readonly string[] {
	return Array.isArray(values) && values.length > 0;
}

function hasAnyValue(
	taskValues: readonly string[] | undefined,
	configuredValues: readonly string[]
): boolean {
	if (!taskValues || taskValues.length === 0) {
		return false;
	}
	const taskValueSet = new Set(taskValues);
	return configuredValues.some((value) => taskValueSet.has(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
