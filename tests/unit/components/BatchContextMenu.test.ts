import { BatchContextMenu } from "../../../src/components/BatchContextMenu";
import type TaskNotesPlugin from "../../../src/main";
import type { TaskInfo } from "../../../src/types";
import type { TaskCopyFormat } from "../../../src/utils/taskClipboard";

jest.mock("obsidian");
jest.mock("../../../src/components/DateContextMenu", () => ({
	DateContextMenu: jest.fn().mockImplementation(() => ({
		getDateOptions: jest.fn(() => [
			{
				label: "Today",
				value: "2026-06-04",
				category: "basic",
				icon: "calendar",
			},
		]),
	})),
}));

type TestableBatchContextMenu = BatchContextMenu & {
	batchUpdateProperty(property: keyof TaskInfo, value: unknown): Promise<void>;
	copySelectedTasks(format: TaskCopyFormat): Promise<void>;
};

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

function createPlugin(task: TaskInfo | null = createTask()): TaskNotesPlugin {
	return {
		settings: {
			customStatuses: [
				{ label: "Open", value: "open", order: 0 },
				{ label: "Done", value: "done", order: 1 },
			],
			enableDebugLogging: false,
		},
		i18n: {
			translate: jest.fn((key: string) => key),
		},
		app: {
			vault: {
				getAbstractFileByPath: jest.fn(() => null),
			},
			metadataCache: {
				fileToLinktext: jest.fn(),
			},
		},
		cacheManager: {
			getTaskInfo: jest.fn(async () => task),
		},
		priorityManager: {
			getPrioritiesByWeight: jest.fn(() => [
				{ label: "Normal", value: "normal", weight: 0 },
			]),
		},
		taskSelectionService: {
			clearSelection: jest.fn(),
			exitSelectionMode: jest.fn(),
		},
		taskService: {
			updateProperty: jest.fn(),
		},
	} as unknown as TaskNotesPlugin;
}

function createMenu(plugin: TaskNotesPlugin, selectedPaths: string[]): TestableBatchContextMenu {
	return new BatchContextMenu({ plugin, selectedPaths }) as unknown as TestableBatchContextMenu;
}

describe("BatchContextMenu", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: jest.fn(async () => undefined),
			},
		});
	});

	it("copies note frontmatter task titles before pending cache titles", async () => {
		const pendingTask = createTask({ title: "Pending title" });
		const frontmatterTask = createTask({ title: "Frontmatter title" });
		const plugin = createPlugin(pendingTask);
		plugin.cacheManager.getTaskInfoFromFrontmatter = jest.fn(async () => frontmatterTask);
		const menu = createMenu(plugin, [frontmatterTask.path]);

		await menu.copySelectedTasks("titles");

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			frontmatterTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Frontmatter title");
	});

	it("updates task properties with note frontmatter data before pending cache data", async () => {
		const pendingTask = createTask({ title: "Pending title" });
		const frontmatterTask = createTask({ title: "Frontmatter title" });
		const plugin = createPlugin(pendingTask);
		plugin.cacheManager.getTaskInfoFromFrontmatter = jest.fn(async () => frontmatterTask);
		const menu = createMenu(plugin, [frontmatterTask.path]);

		await menu.batchUpdateProperty("status", "done");

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			frontmatterTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(plugin.taskService.updateProperty).toHaveBeenCalledWith(
			frontmatterTask,
			"status",
			"done"
		);
	});
});
