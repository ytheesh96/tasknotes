import { App } from "obsidian";
import { UnscheduledTasksSelectorModal } from "../../../src/modals/UnscheduledTasksSelectorModal";
import type TaskNotesPlugin from "../../../src/main";
import type { TaskInfo } from "../../../src/types";

jest.mock("obsidian");

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

function createPlugin(frontmatterTask: TaskInfo, staleTask: TaskInfo): TaskNotesPlugin {
	return {
		i18n: {
			translate: jest.fn((key: string) => key),
		},
		statusManager: {
			isCompletedStatus: jest.fn((status: string) => status === "done"),
		},
		cacheManager: {
			getAllTaskPaths: jest.fn(() => new Set([staleTask.path])),
			getTaskInfoFromFrontmatter: jest.fn(async () => frontmatterTask),
			getTaskInfo: jest.fn(async () => staleTask),
		},
	} as unknown as TaskNotesPlugin;
}

describe("UnscheduledTasksSelectorModal note-first loading", () => {
	it("filters unscheduled tasks from note frontmatter before pending cache data", async () => {
		const staleTask = createTask({
			title: "Stale pending task",
			scheduled: "2026-06-04",
		});
		const frontmatterTask = createTask({
			title: "Fresh frontmatter task",
			path: staleTask.path,
			scheduled: undefined,
		});
		const plugin = createPlugin(frontmatterTask, staleTask);
		const modal = new UnscheduledTasksSelectorModal(
			new App(),
			plugin,
			jest.fn()
		);

		await modal.loadUnscheduledTasks();

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			staleTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect((modal as unknown as { tasks: TaskInfo[] }).tasks).toEqual([frontmatterTask]);
	});
});
