import { TaskSelectionService } from "../../../src/services/TaskSelectionService";
import type { TaskInfo } from "../../../src/types";

function createSelectionService(): TaskSelectionService {
	return new TaskSelectionService({} as never);
}

describe("Issue #1885: Shift+arrow range selection", () => {
	it("extends the selected range to the next visible task", () => {
		const service = createSelectionService();
		const visiblePaths = ["Tasks/a.md", "Tasks/b.md", "Tasks/c.md"];

		service.selectTask("Tasks/a.md");
		service.selectAdjacentRange(1, visiblePaths);
		service.selectAdjacentRange(1, visiblePaths);

		expect(service.getSelectedPaths()).toEqual(["Tasks/a.md", "Tasks/b.md", "Tasks/c.md"]);
	});

	it("extends the selected range to the previous visible task", () => {
		const service = createSelectionService();
		const visiblePaths = ["Tasks/a.md", "Tasks/b.md", "Tasks/c.md"];

		service.selectTask("Tasks/c.md");
		service.selectAdjacentRange(-1, visiblePaths);

		expect(service.getSelectedPaths()).toEqual(["Tasks/c.md", "Tasks/b.md"]);
	});

	it("uses the first visible task when selection mode has no active endpoint", () => {
		const service = createSelectionService();
		const visiblePaths = ["Tasks/a.md", "Tasks/b.md"];

		service.selectAdjacentRange(1, visiblePaths);

		expect(service.getSelectedPaths()).toEqual(["Tasks/a.md"]);
	});

	it("selects and deselects task path groups without replacing unrelated selections", () => {
		const service = createSelectionService();
		service.selectTask("Tasks/existing.md");

		service.selectPaths(["Tasks/a.md", "Tasks/b.md"]);

		expect(service.isSelectionModeActive()).toBe(true);
		expect(service.getSelectedPaths()).toEqual([
			"Tasks/existing.md",
			"Tasks/a.md",
			"Tasks/b.md",
		]);

		service.deselectPaths(["Tasks/a.md", "Tasks/missing.md"]);

		expect(service.getSelectedPaths()).toEqual(["Tasks/existing.md", "Tasks/b.md"]);

		service.deselectPaths(["Tasks/existing.md", "Tasks/b.md"]);

		expect(service.getSelectedPaths()).toEqual([]);
		expect(service.isSelectionModeActive()).toBe(false);
	});

	it("hydrates selected tasks from note frontmatter before pending cache data", async () => {
		const staleTask = {
			title: "Stale pending title",
			status: "open",
			priority: "normal",
			path: "Tasks/a.md",
			archived: false,
		} as TaskInfo;
		const frontmatterTask = {
			...staleTask,
			title: "Fresh frontmatter title",
			status: "done",
		};
		const plugin = {
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn(async () => frontmatterTask),
				getTaskInfo: jest.fn(async () => staleTask),
			},
		};
		const service = new TaskSelectionService(plugin as never);
		service.selectTask(staleTask.path);

		await expect(service.getSelectedTasks()).resolves.toEqual([frontmatterTask]);
		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			staleTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
	});
});
