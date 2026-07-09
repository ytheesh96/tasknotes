import type TaskNotesPlugin from "../main";
import { HermesKanbanApiClient } from "./hermesApiClient";
import { defaultHermesBoards } from "./hermesRouting";

export async function getHermesBoardSuggestionValues(
	plugin: TaskNotesPlugin
): Promise<string[]> {
	try {
		const boards = (await new HermesKanbanApiClient().listBoards())
			.filter((board) => !board.archived)
			.map((board) => board.slug);
		if (boards.length > 0) {
			return uniqueSortedBoards(boards);
		}
	} catch {
		// Fall back to canonical local boards when the Hermes dashboard is unavailable.
	}
	return uniqueSortedBoards(defaultHermesBoards());
}

export function filterHermesBoardSuggestionValues(
	boards: readonly string[],
	query: string,
	limit = 10
): string[] {
	const normalizedQuery = query.trim().toLowerCase();
	return boards
		.filter((board) => !normalizedQuery || board.toLowerCase().includes(normalizedQuery))
		.slice(0, limit);
}

function uniqueSortedBoards(boards: readonly string[]): string[] {
	return [...new Set(boards.map((board) => board.trim()).filter(Boolean))].sort((left, right) =>
		left.localeCompare(right)
	);
}
