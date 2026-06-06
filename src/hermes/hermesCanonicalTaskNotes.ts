export const HERMES_CANONICAL_SYNC_VERSION = 1;
export const HERMES_TASKNOTES_ROOT = "TaskNotes";
export const HERMES_TASKNOTES_TASKS_FOLDER = `${HERMES_TASKNOTES_ROOT}/Tasks`;
export const HERMES_TASKNOTES_ACTIVITY_FOLDER = `${HERMES_TASKNOTES_ROOT}/Activity`;

export const HERMES_CANONICAL_SYNC_FRONTMATTER = {
	taskId: "hermesTaskId",
	board: "hermesBoard",
	archived: "hermesArchived",
} as const;

export const HERMES_LEGACY_SYNC_FRONTMATTER_ALIASES = {
	// `hermes_id` appears in older planning docs; `hermes_task_id` is the explicit
	// snake_case alias for the canonical camelCase field.
	taskId: ["hermes_task_id", "hermes_id"],
	board: ["hermes_board"],
	archived: ["hermes_archived"],
} as const;

export const HERMES_TASK_ID_FRONTMATTER = HERMES_CANONICAL_SYNC_FRONTMATTER.taskId;
export const HERMES_BOARD_FRONTMATTER = HERMES_CANONICAL_SYNC_FRONTMATTER.board;
export const HERMES_ARCHIVED_FRONTMATTER = HERMES_CANONICAL_SYNC_FRONTMATTER.archived;
export const HERMES_SYNC_VERSION_FRONTMATTER = "hermesSyncVersion";
export const HERMES_LIST_FRONTMATTER = "hermesList";
export const HERMES_ORDER_FRONTMATTER = "hermesOrder";
export const HERMES_VISIBLE_FRONTMATTER = "hermesVisible";
export const HERMES_ASSIGNEE_FRONTMATTER = "hermesAssignee";
export const HERMES_PRIORITY_FRONTMATTER = "hermesPriority";
export const HERMES_RUN_ID_FRONTMATTER = "hermesRunId";
export const HERMES_ROOT_RUN_ID_FRONTMATTER = "hermesRootRunId";
export const HERMES_RUN_TITLE_FRONTMATTER = "hermesRunTitle";
export const HERMES_RUN_TYPE_FRONTMATTER = "hermesRunType";

export const HERMES_BOARD_MOVE_API_SUPPORT = "unsupported" as const;
export const HERMES_BOARD_MOVE_API_PATH = null;

const HERMES_TASK_ID_PATTERN = /^t_[A-Za-z0-9]+$/;

export function isHermesTaskId(value: string | null | undefined): value is string {
	return typeof value === "string" && HERMES_TASK_ID_PATTERN.test(value.trim());
}

export function readHermesTaskIdFrontmatter(
	frontmatter: Record<string, unknown> | null | undefined
): string | null {
	const value = readFrontmatterValue(
		frontmatter,
		HERMES_TASK_ID_FRONTMATTER,
		HERMES_LEGACY_SYNC_FRONTMATTER_ALIASES.taskId
	);
	const id = normalizeHermesScalar(value);
	return isHermesTaskId(id) ? id : null;
}

export function readHermesBoardFrontmatter(
	frontmatter: Record<string, unknown> | null | undefined
): string | null {
	return canonicalHermesBoardValue(
		readFrontmatterValue(
			frontmatter,
			HERMES_BOARD_FRONTMATTER,
			HERMES_LEGACY_SYNC_FRONTMATTER_ALIASES.board
		)
	);
}

export function readHermesArchivedFrontmatter(
	frontmatter: Record<string, unknown> | null | undefined
): boolean | null {
	const value = readFrontmatterValue(
		frontmatter,
		HERMES_ARCHIVED_FRONTMATTER,
		HERMES_LEGACY_SYNC_FRONTMATTER_ALIASES.archived
	);
	return normalizeHermesBoolean(value);
}

export interface HermesBoardMovePolicyDecision {
	action: "allow" | "revert";
	sourceBoard: string;
	desiredBoard: string;
	revertToBoard?: string;
	reason: string;
}

export function evaluateHermesBoardMovePolicy(
	sourceBoard: string,
	desiredBoard: string
): HermesBoardMovePolicyDecision {
	const normalizedSourceBoard = sourceBoard.trim();
	const normalizedDesiredBoard = desiredBoard.trim();
	if (normalizedSourceBoard === normalizedDesiredBoard) {
		return {
			action: "allow",
			sourceBoard: normalizedSourceBoard,
			desiredBoard: normalizedDesiredBoard,
			reason: "Hermes board did not change.",
		};
	}
	return {
		action: "revert",
		sourceBoard: normalizedSourceBoard,
		desiredBoard: normalizedDesiredBoard,
		revertToBoard: normalizedSourceBoard,
		reason: "Hermes Kanban API does not expose a task board-move endpoint; local hermesBoard edits must be reverted until an API-backed move is available.",
	};
}

export function canonicalHermesTaskPath(taskId: string): string {
	return `${HERMES_TASKNOTES_TASKS_FOLDER}/${taskId}.md`;
}

export function legacyHermesBoardTaskPath(board: string, taskId: string): string {
	return `${HERMES_TASKNOTES_ROOT}/${board.trim()}/${taskId}.md`;
}

export function canonicalHermesActivityFolder(taskId: string): string {
	return `${HERMES_TASKNOTES_ACTIVITY_FOLDER}/${taskId}`;
}

export function canonicalHermesActivityPath(
	taskId: string,
	folder: "comments" | "runs" | "events" | "artifacts" | "raw",
	basename: string
): string {
	return `${canonicalHermesActivityFolder(taskId)}/${folder}/${basename}.md`;
}

export function normalizeHermesScalar(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || null;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return null;
}

export function canonicalHermesBoardValue(value: unknown): string | null {
	const text = normalizeHermesScalar(value);
	return text ? text.trim() || null : null;
}

function readFrontmatterValue(
	frontmatter: Record<string, unknown> | null | undefined,
	canonicalKey: string,
	legacyKeys: readonly string[]
): unknown {
	if (!frontmatter) {
		return undefined;
	}
	if (Object.prototype.hasOwnProperty.call(frontmatter, canonicalKey)) {
		return frontmatter[canonicalKey];
	}
	for (const legacyKey of legacyKeys) {
		if (Object.prototype.hasOwnProperty.call(frontmatter, legacyKey)) {
			return frontmatter[legacyKey];
		}
	}
	return undefined;
}

function normalizeHermesBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "yes", "1"].includes(normalized)) {
			return true;
		}
		if (["false", "no", "0"].includes(normalized)) {
			return false;
		}
	}
	if (typeof value === "number") {
		if (value === 1) {
			return true;
		}
		if (value === 0) {
			return false;
		}
	}
	return null;
}
