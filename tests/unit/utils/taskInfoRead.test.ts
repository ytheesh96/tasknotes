import {
	getAllTasksFromNoteFirst,
	getTaskInfoFromNoteFirst,
} from "../../../src/utils/taskInfoRead";
import type { TaskInfo } from "../../../src/types";

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Task",
		status: "open",
		priority: "normal",
		path: "Tasks/task.md",
		archived: false,
		...overrides,
	};
}

describe("getTaskInfoFromNoteFirst", () => {
	it("returns frontmatter task data before pending cache data", async () => {
		const frontmatterTask = createTask({ title: "Frontmatter title" });
		const pendingTask = createTask({ title: "Pending title" });
		const source = {
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn(async () => frontmatterTask),
				getTaskInfo: jest.fn(async () => pendingTask),
			},
		};

		await expect(getTaskInfoFromNoteFirst(source, frontmatterTask.path)).resolves.toBe(
			frontmatterTask
		);
		expect(source.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			frontmatterTask.path
		);
		expect(source.cacheManager.getTaskInfo).not.toHaveBeenCalled();
	});

	it("falls back to pending cache data when frontmatter has no task", async () => {
		const pendingTask = createTask({ title: "Pending title" });
		const source = {
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn(async () => null),
				getTaskInfo: jest.fn(async () => pendingTask),
			},
		};

		await expect(getTaskInfoFromNoteFirst(source, pendingTask.path)).resolves.toBe(
			pendingTask
		);
		expect(source.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			pendingTask.path
		);
		expect(source.cacheManager.getTaskInfo).toHaveBeenCalledWith(pendingTask.path);
	});

	it("uses pending cache data when the frontmatter reader is unavailable", async () => {
		const pendingTask = createTask({ title: "Pending title" });
		const source = {
			cacheManager: {
				getTaskInfo: jest.fn(async () => pendingTask),
			},
		};

		await expect(getTaskInfoFromNoteFirst(source, pendingTask.path)).resolves.toBe(
			pendingTask
		);
		expect(source.cacheManager.getTaskInfo).toHaveBeenCalledWith(pendingTask.path);
	});

	it("hydrates all listed task paths from note frontmatter before pending cache data", async () => {
		const listedTask = createTask({ title: "Listed cache task" });
		const freshTask = createTask({ title: "Fresh frontmatter task" });
		const source = {
			cacheManager: {
				getAllTasks: jest.fn(async () => [listedTask]),
				getTaskInfoFromFrontmatter: jest.fn(async () => freshTask),
				getTaskInfo: jest.fn(async () => listedTask),
			},
		};

		await expect(getAllTasksFromNoteFirst(source)).resolves.toEqual([freshTask]);
		expect(source.cacheManager.getAllTasks).toHaveBeenCalledTimes(1);
		expect(source.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			listedTask.path
		);
		expect(source.cacheManager.getTaskInfo).not.toHaveBeenCalled();
	});
});
