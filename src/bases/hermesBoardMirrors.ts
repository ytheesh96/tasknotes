import { TFile } from "obsidian";
import type TaskNotesPlugin from "../main";
import { EVENT_TASK_DELETED, type TaskInfo } from "../types";
import { HERMES_BOARD_FRONTMATTER, canonicalHermesBoardValue } from "../hermes/hermesCanonicalTaskNotes";

function getBoardMirrorPathPrefix(board: string): string {
	return `TaskNotes/${board}/`;
}

export function getLocalHermesMirrorTasksForBoard(
	tasks: readonly TaskInfo[],
	board: string
): TaskInfo[] {
	const prefix = getBoardMirrorPathPrefix(board);
	return tasks.filter((task) => {
		const canonicalBoard = canonicalHermesBoardValue(
			task.customProperties?.[HERMES_BOARD_FRONTMATTER]
		);
		if (canonicalBoard) {
			return canonicalBoard === board;
		}
		if (!task.path.startsWith(prefix)) {
			return false;
		}
		return /^t_[^/]+\.md$/.test(task.path.slice(prefix.length));
	});
}

export async function deleteLocalHermesMirrorsForBoard(
	plugin: TaskNotesPlugin,
	board: string
): Promise<number> {
	const tasks = await plugin.cacheManager.getAllTasks();
	const mirrorTasks = getLocalHermesMirrorTasksForBoard(tasks, board);
	let deleted = 0;

	for (const task of mirrorTasks) {
		const file = plugin.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) {
			continue;
		}
		await plugin.app.fileManager.trashFile(file);
		plugin.cacheManager.clearCacheEntry(task.path);
		plugin.emitter.trigger(EVENT_TASK_DELETED, {
			path: task.path,
			deletedTask: task,
		});
		deleted += 1;
	}

	return deleted;
}

export function formatDeletedBoardNotice(board: string, deletedMirrors: number): string {
	if (deletedMirrors === 0) {
		return `Deleted Hermes board "${board}"`;
	}
	const noun = deletedMirrors === 1 ? "local mirror" : "local mirrors";
	return `Deleted Hermes board "${board}" and ${deletedMirrors} ${noun}`;
}
