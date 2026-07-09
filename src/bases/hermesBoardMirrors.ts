import { TFile } from "obsidian";
import type TaskNotesPlugin from "../main";
import { EVENT_TASK_DELETED, type TaskInfo } from "../types";
import {
	HERMES_BOARD_FRONTMATTER,
	canonicalHermesBoardValue,
	canonicalHermesTaskPath,
} from "../hermes/hermesCanonicalTaskNotes";

function getLegacyBoardMirrorPathPrefix(board: string): string {
	return `TaskNotes/${board}/`;
}

export function getLocalHermesMirrorTasksForBoard(
	tasks: readonly TaskInfo[],
	board: string
): TaskInfo[] {
	const legacyPrefix = getLegacyBoardMirrorPathPrefix(board);
	return tasks.filter((task) => {
		const canonicalBoard = canonicalHermesBoardValue(
			task.customProperties?.[HERMES_BOARD_FRONTMATTER]
		);
		if (canonicalBoard) {
			return canonicalBoard === board;
		}
		const canonicalMatch = task.path.match(/^TaskNotes\/Tasks\/([^/]+)--(t_[^/]+)\.md$/);
		if (canonicalMatch) {
			const [, pathBoard, taskId] = canonicalMatch;
			return pathBoard === board && task.path === canonicalHermesTaskPath(pathBoard, taskId);
		}
		if (!task.path.startsWith(legacyPrefix)) {
			return false;
		}
		return /^t_[^/]+\.md$/.test(task.path.slice(legacyPrefix.length));
	});
}

export async function deleteLocalHermesMirrorsForBoard(
	plugin: TaskNotesPlugin,
	board: string
): Promise<number> {
	const tasks = await plugin.cacheManager.getAllTasks();
	const mirrorTasks = getLocalHermesMirrorTasksForBoard(tasks, board);
	const mirrorTargets = new Map<string, { file: TFile; task?: TaskInfo }>();

	for (const task of mirrorTasks) {
		const file = plugin.app.vault.getAbstractFileByPath(task.path);
		if (file instanceof TFile) {
			mirrorTargets.set(task.path, { file, task });
		}
	}

	// The live TaskNotes cache can lag behind freshly-created or externally synced
	// Hermes mirrors. Deleting a board is a cleanup boundary, so scan the local
	// vault paths too instead of trusting only the in-memory task cache.
	for (const file of plugin.app.vault.getFiles()) {
		if (!(file instanceof TFile) || mirrorTargets.has(file.path)) {
			continue;
		}
		if (isLocalHermesMirrorPathForBoard(file.path, board)) {
			mirrorTargets.set(file.path, { file });
		}
	}

	let deleted = 0;
	for (const { file, task } of mirrorTargets.values()) {
		await plugin.app.fileManager.trashFile(file);
		plugin.cacheManager.clearCacheEntry(file.path);
		plugin.emitter.trigger(EVENT_TASK_DELETED, {
			path: file.path,
			deletedTask: task ?? fallbackDeletedTaskInfo(file),
		});
		deleted += 1;
	}

	return deleted;
}

function isLocalHermesMirrorPathForBoard(path: string, board: string): boolean {
	const canonicalMatch = path.match(/^TaskNotes\/Tasks\/([^/]+)--(t_[^/]+)\.md$/);
	if (canonicalMatch) {
		const [, pathBoard, taskId] = canonicalMatch;
		return pathBoard === board && path === canonicalHermesTaskPath(pathBoard, taskId);
	}
	const legacyPrefix = getLegacyBoardMirrorPathPrefix(board);
	if (!path.startsWith(legacyPrefix)) {
		return false;
	}
	return /^t_[^/]+\.md$/.test(path.slice(legacyPrefix.length));
}

function fallbackDeletedTaskInfo(file: TFile): TaskInfo {
	return {
		title: file.basename,
		path: file.path,
		status: "",
		priority: "normal",
		archived: false,
	};
}

export function formatDeletedBoardNotice(board: string, deletedMirrors: number): string {
	if (deletedMirrors === 0) {
		return `Deleted Hermes board "${board}"`;
	}
	const noun = deletedMirrors === 1 ? "local mirror" : "local mirrors";
	return `Deleted Hermes board "${board}" and ${deletedMirrors} ${noun}`;
}
