import { selectiveUpdateForListView } from "../../../src/utils/viewOptimizations";
import type TaskNotesPlugin from "../../../src/main";
import type { TaskInfo } from "../../../src/types";
import { updateTaskCard } from "../../../src/ui/TaskCard";

jest.mock("../../../src/ui/TaskCard", () => ({
	updateTaskCard: jest.fn(),
}));

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

describe("selectiveUpdateForListView note-first redraws", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("updates visible task cards from note frontmatter before pending cache data", async () => {
		const staleTask = createTask({ title: "Stale pending title" });
		const frontmatterTask = createTask({ title: "Fresh frontmatter title", status: "done" });
		const plugin = {
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn(async () => frontmatterTask),
				getTaskInfo: jest.fn(async () => staleTask),
			},
		} as unknown as TaskNotesPlugin;
		const taskElement = document.createElement("div");
		const view = {
			plugin,
			taskElements: new Map([[staleTask.path, taskElement]]),
			getCurrentVisibleProperties: jest.fn(() => ["status"]),
			getVisiblePropertyLabels: jest.fn(() => ({ status: "Status" })),
		};

		await selectiveUpdateForListView(view, staleTask.path, "update");

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			staleTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(updateTaskCard).toHaveBeenCalledWith(
			taskElement,
			frontmatterTask,
			plugin,
			["status"],
			{ propertyLabels: { status: "Status" } }
		);
	});
});
