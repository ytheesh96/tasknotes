import { HERMES_DEFAULT_ASSIGNEES, mergeHermesAssigneeDefaultValues } from "./hermesAssignee";

export const HERMES_BOARD_PROJECT_PREFIX = "Hermes/";

export const HERMES_DEFAULT_BOARDS = [
	"default",
	"hermes-agent",
	"hhmi",
	"job-hunt",
	"obsidian-os",
	"vault-change-review",
] as const;

export function splitHermesList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => splitHermesList(item));
	}
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
		return [];
	}
	return String(value)
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function uniqueHermesValues(values: readonly unknown[]): string[] {
	return mergeHermesAssigneeDefaultValues(values);
}

export function hermesBoardProject(board: string): string {
	return `${HERMES_BOARD_PROJECT_PREFIX}${board.trim()}`;
}

export function normalizeHermesBoardValue(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.startsWith(HERMES_BOARD_PROJECT_PREFIX)) {
		const board = trimmed.slice(HERMES_BOARD_PROJECT_PREFIX.length).trim();
		return board || null;
	}
	return trimmed;
}

export function getHermesBoardFromProjects(
	projects: unknown,
	acceptedBoards: readonly string[]
): string | null {
	const accepted = createLowercaseLookup(acceptedBoards);
	for (const project of splitHermesList(projects)) {
		const board = normalizeHermesBoardValue(project);
		if (!board) {
			continue;
		}
		const acceptedBoard = accepted.get(board.toLowerCase());
		if (acceptedBoard) {
			return acceptedBoard;
		}
	}
	return null;
}

export function canonicalHermesBoardProjects(board: string): string {
	return hermesBoardProject(board);
}

export function defaultHermesAssignees(): string[] {
	return [...HERMES_DEFAULT_ASSIGNEES];
}

export function defaultHermesBoards(): string[] {
	return [...HERMES_DEFAULT_BOARDS];
}

export function validateHermesAssigneeSelection(
	contexts: unknown,
	acceptedAssignees: readonly string[]
): { assignee: string | null; error?: string } {
	const selected = splitHermesList(contexts).filter((value) => value.toLowerCase() !== "none");
	if (selected.length === 0) {
		return { assignee: null };
	}
	if (selected.length > 1) {
		return { assignee: null, error: "Choose one Hermes assignee." };
	}

	const accepted = createLowercaseLookup(acceptedAssignees);
	const assignee = accepted.get(selected[0].toLowerCase());
	if (!assignee) {
		return {
			assignee: null,
			error: `Assignee must be one of: ${acceptedAssignees.join(", ")}`,
		};
	}
	return { assignee };
}

export function validateHermesBoardSelection(
	projects: unknown,
	acceptedBoards: readonly string[],
	expectedBoard?: string
): { board: string | null; error?: string } {
	const selected = splitHermesList(projects);
	if (selected.length !== 1) {
		return { board: null, error: "Choose one Hermes board." };
	}

	const accepted = createLowercaseLookup(acceptedBoards);
	const boardValue = normalizeHermesBoardValue(selected[0]);
	const board = boardValue ? accepted.get(boardValue.toLowerCase()) : undefined;
	if (!board) {
		return {
			board: null,
			error: `Board must be one of: ${acceptedBoards.join(", ")}`,
		};
	}

	if (expectedBoard && board !== expectedBoard) {
		return {
			board: null,
			error: `This task belongs to ${expectedBoard}. Board moves are not supported here.`,
		};
	}

	return { board };
}

function createLowercaseLookup(values: readonly string[]): Map<string, string> {
	return new Map(values.map((value) => [value.toLowerCase(), value]));
}
