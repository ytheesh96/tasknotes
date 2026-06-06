export const HERMES_NO_RUN_LANE_ID = "__hermes_no_run__";
export const HERMES_UNKNOWN_RUN_LANE_ID = "__hermes_unknown_run__";
export const HERMES_RUN_REASSIGNMENT_EXPLICIT_ONLY_COPY =
	"Run reassignment is explicit-only in v1. Use task actions or CLI/API to change run.";

export type HermesRunLaneCounts = {
	total?: number;
	done?: number;
	active?: number;
	running?: number;
	blocked?: number;
	[key: string]: number | undefined;
};

export type HermesRunLaneColumnLike = {
	name?: string | null;
	status?: string | null;
	tasks?: unknown[] | null;
	count?: number | null;
};

export type HermesRunLaneLike = {
	id?: string | null;
	title?: string | null;
	name?: string | null;
	run_type?: string | null;
	runType?: string | null;
	status?: string | null;
	counts?: HermesRunLaneCounts | null;
	columns?: HermesRunLaneColumnLike[] | null;
};

const ACTIVE_RUN_TYPES = new Set(["top_level", "top-level", "user", "orchestrator"]);

function normalizeString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeStatus(value: unknown): string {
	return normalizeString(value).toLowerCase();
}

function safeCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.floor(value));
}

function normalizeStorageSegment(value: unknown, fallback: string): string {
	const normalized = normalizeString(value);
	return encodeURIComponent(normalized || fallback);
}

export type HermesRunLaneDropGuardInput = {
	isRunSwimlaneView: boolean;
	sourceLaneId: string | null | undefined;
	targetLaneId: string | null | undefined;
};

export function isHermesRunLaneDropRejected(input: HermesRunLaneDropGuardInput): boolean {
	if (!input.isRunSwimlaneView) {
		return false;
	}
	return normalizeString(input.sourceLaneId) !== normalizeString(input.targetLaneId);
}

export type HermesRunLaneCollapseStorageKeyInput = {
	profile?: string | null;
	board?: string | null;
	view?: string | null;
	tenant?: string | null;
	groupBy?: string | null;
	runScope?: string | null;
	laneId: string;
};

export function buildHermesRunLaneCollapseStorageKey(
	input: HermesRunLaneCollapseStorageKeyInput
): string {
	return [
		"tasknotes:hermes-run-collapse:v1",
		`profile=${normalizeStorageSegment(input.profile, "default")}`,
		`board=${normalizeStorageSegment(input.board, "default")}`,
		`view=${normalizeStorageSegment(input.view, "default")}`,
		`tenant=${normalizeStorageSegment(input.tenant, "none")}`,
		`group_by=${normalizeStorageSegment(input.groupBy, "run")}`,
		`run_scope=${normalizeStorageSegment(input.runScope, "root")}`,
		`lane=${normalizeStorageSegment(input.laneId, "unknown")}`,
	].join(":");
}

export function getHermesRunLaneDisplayTitle(lane: HermesRunLaneLike): string {
	const title = normalizeString(lane.title) || normalizeString(lane.name) || normalizeString(lane.id);
	if (title) {
		return title;
	}
	return "Unknown run";
}

export function getHermesRunLaneStatus(lane: HermesRunLaneLike): string {
	const counts = lane.counts ?? {};
	const blocked = safeCount(counts.blocked);
	const running = safeCount(counts.running);
	const active = safeCount(counts.active);
	const done = safeCount(counts.done);
	const total = safeCount(counts.total);

	if (blocked > 0) {
		return "blocked";
	}
	if (running > 0 || active > 0) {
		return "running";
	}
	if (total > 0 && done >= total) {
		return "done";
	}

	const explicitStatus = normalizeStatus(lane.status);
	if (explicitStatus) {
		return explicitStatus;
	}
	return "todo";
}

export function getDefaultHermesRunLaneExpanded(lane: HermesRunLaneLike): boolean {
	const id = normalizeString(lane.id);
	if (id === HERMES_NO_RUN_LANE_ID || id === HERMES_UNKNOWN_RUN_LANE_ID) {
		return true;
	}

	const status = getHermesRunLaneStatus(lane);
	if (status === "done" || status === "completed" || status === "archived") {
		return false;
	}

	const runType = normalizeStatus(lane.run_type ?? lane.runType);
	if (!runType) {
		return true;
	}
	return ACTIVE_RUN_TYPES.has(runType);
}

export function getHermesRunLaneAccessibleCopy(lane: HermesRunLaneLike): string {
	const id = normalizeString(lane.id);
	const title = getHermesRunLaneDisplayTitle(lane);
	const count = safeCount(lane.counts?.total);
	if (id === HERMES_NO_RUN_LANE_ID) {
		return `${count} ${count === 1 ? "task; task" : "tasks; tasks"} not assigned to a logical run.`;
	}
	if (id === HERMES_UNKNOWN_RUN_LANE_ID) {
		return `${count} ${count === 1 ? "task" : "tasks"}; referenced run metadata is missing or not visible.`;
	}
	return `${title}: ${count} ${count === 1 ? "task" : "tasks"}, ${getHermesRunLaneStatus(lane)}.`;
}

export function getHermesRunLaneTaskCountByStatus(
	lane: HermesRunLaneLike,
	statuses: string[]
): Record<string, number> {
	const result: Record<string, number> = {};
	for (const status of statuses) {
		result[status] = 0;
	}

	for (const column of lane.columns ?? []) {
		const status = normalizeString(column.status) || normalizeString(column.name);
		if (!status || !(status in result)) {
			continue;
		}
		const explicitCount = safeCount(column.count);
		result[status] += explicitCount || safeCount(column.tasks?.length);
	}

	return result;
}

export type HermesRunAssignmentTaskLike = {
	id?: string | null;
	run_id?: string | null;
	[key: string]: unknown;
};

export type HermesLogicalRunLike = {
	id?: string | null;
	root_run_id?: string | null;
	tenant?: string | null;
	archived_at?: number | null;
	[key: string]: unknown;
};

export type HermesRunLaneResolutionOptions = {
	runScope?: string | null;
	tenant?: string | null;
};

export function resolveHermesRunLaneId(
	task: HermesRunAssignmentTaskLike,
	runsById: Map<string, HermesLogicalRunLike>,
	options: HermesRunLaneResolutionOptions = {}
): string {
	const runId = normalizeString(task.run_id);
	if (!runId) {
		return HERMES_NO_RUN_LANE_ID;
	}

	const run = runsById.get(runId);
	if (!isHermesRunVisibleInTenant(run, options.tenant)) {
		return HERMES_UNKNOWN_RUN_LANE_ID;
	}

	if (options.runScope === "direct") {
		return runId;
	}

	const rootRunId = normalizeString(run?.root_run_id);
	if (!rootRunId || rootRunId === runId) {
		return runId;
	}

	const rootRun = runsById.get(rootRunId);
	return isHermesRunVisibleInTenant(rootRun, options.tenant) ? rootRunId : runId;
}

function isHermesRunVisibleInTenant(
	run: HermesLogicalRunLike | undefined,
	tenant?: string | null
): boolean {
	if (!run) {
		return false;
	}
	const requestedTenant = normalizeString(tenant);
	if (!requestedTenant) {
		return true;
	}
	return normalizeString(run.tenant) === requestedTenant;
}

export function countDistinctHermesRunLaneTasks(
	tasks: HermesRunAssignmentTaskLike[],
	getTaskId: (task: HermesRunAssignmentTaskLike) => string = (task) =>
		normalizeString(task.id)
): number {
	const taskIds = new Set<string>();
	for (const task of tasks) {
		const taskId = getTaskId(task);
		if (taskId) {
			taskIds.add(taskId);
		}
	}
	return taskIds.size;
}

export type HermesRunReassignmentInput = {
	runId: string | null;
	source: string;
	actor?: string | null;
	assignedAt: number;
};

export function reassignHermesTaskRunSnapshot<T extends HermesRunAssignmentTaskLike>(
	task: T,
	input: HermesRunReassignmentInput
): T & {
	run_id: string | null;
	run_assigned_at: number;
	run_assignment_source: string;
	run_assignment_actor?: string;
} {
	return {
		...task,
		run_id: input.runId,
		run_assigned_at: input.assignedAt,
		run_assignment_source: input.source,
		...(input.actor ? { run_assignment_actor: input.actor } : {}),
	};
}

export type HermesAttemptSnapshotLike = {
	id?: number | null;
	task_id?: string | null;
	logical_run_id?: string | null;
	attempt_number?: number | null;
	[key: string]: unknown;
};

export function createHermesRunAttemptSnapshot(
	task: HermesRunAssignmentTaskLike,
	existingAttempts: HermesAttemptSnapshotLike[] = []
): {
	task_id: string;
	logical_run_id: string | null;
	attempt_number: number;
	retry_of_attempt_run_id?: number;
} {
	const taskId = normalizeString(task.id);
	const attemptsForTask = existingAttempts.filter(
		(attempt) => normalizeString(attempt.task_id) === taskId
	);
	const latestAttempt = attemptsForTask[attemptsForTask.length - 1];
	const latestAttemptNumber = safeCount(latestAttempt?.attempt_number);
	return {
		task_id: taskId,
		logical_run_id: normalizeString(task.run_id) || null,
		attempt_number: latestAttemptNumber + 1,
		...(typeof latestAttempt?.id === "number"
			? { retry_of_attempt_run_id: latestAttempt.id }
			: {}),
	};
}
