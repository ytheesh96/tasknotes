import type { TaskInfo } from "../types";

export type NoteFirstTaskInfoReader = {
	cacheManager: {
		getTaskInfo?: (path: string) => Promise<TaskInfo | null>;
		getCachedTaskInfo?: (path: string) => Promise<TaskInfo | null>;
		getTaskInfoFromFrontmatter?: (path: string) => Promise<TaskInfo | null>;
	};
};

export type NoteFirstTaskInfoListReader = {
	cacheManager: NoteFirstTaskInfoReader["cacheManager"] & {
		getAllTasks(): Promise<TaskInfo[]>;
	};
};

/**
 * Read task state for UI surfaces that should trust the note/frontmatter first.
 * Falls back to the standard TaskNotes lookup for compatibility with non-file or
 * test-only readers that do not expose direct frontmatter hydration.
 */
export async function getTaskInfoFromNoteFirst(
	source: NoteFirstTaskInfoReader,
	path: string
): Promise<TaskInfo | null> {
	if (source.cacheManager.getTaskInfoFromFrontmatter) {
		const frontmatterTask = await source.cacheManager.getTaskInfoFromFrontmatter(path);
		if (frontmatterTask) {
			return frontmatterTask;
		}
	}
	if (source.cacheManager.getCachedTaskInfo) {
		const cachedTask = await source.cacheManager.getCachedTaskInfo(path);
		if (cachedTask) {
			return cachedTask;
		}
	}
	if (source.cacheManager.getTaskInfo) {
		return source.cacheManager.getTaskInfo(path);
	}
	return null;
}

export async function getAllTasksFromNoteFirst(
	source: NoteFirstTaskInfoListReader
): Promise<TaskInfo[]> {
	const tasks = await source.cacheManager.getAllTasks();
	return Promise.all(
		tasks.map(async (task) => (await getTaskInfoFromNoteFirst(source, task.path)) ?? task)
	);
}
