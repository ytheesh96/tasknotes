import { TFile } from "obsidian";
import { KanbanView } from "../../../src/bases/KanbanView";
import { TaskListView } from "../../../src/bases/TaskListView";
import type { TaskInfo } from "../../../src/types";

jest.mock("obsidian");
jest.mock(
	"tasknotes-nlp-core",
	() => ({
		NaturalLanguageParserCore: class {},
	}),
	{ virtual: true }
);

const createTask = (overrides: Partial<TaskInfo> = {}): TaskInfo => ({
	title: "Task",
	status: "todo",
	priority: "normal",
	path: "tasks/dragged.md",
	archived: false,
	sortOrder: "tnmmmmmmmmmm",
	...overrides,
});

function createController() {
	return {
		viewName: "Board",
		query: {
			views: [{ name: "Board", groupBy: "status" }],
		},
	};
}

function createPlugin({
	frontmatterTask,
	staleTask,
}: {
	frontmatterTask: TaskInfo;
	staleTask: TaskInfo;
}) {
	const draggedFile = new TFile(staleTask.path);
	const targetFile = new TFile("tasks/target.md");
	const frontmatterByPath = new Map<string, Record<string, unknown>>([
		[
			staleTask.path,
			{
				status: staleTask.status,
				sort_order: staleTask.sortOrder,
			},
		],
		[
			targetFile.path,
			{
				status: "done",
				sort_order: "tnnnnnnnnnnn",
			},
		],
	]);

	const plugin = {
		app: {
			metadataCache: {
				getFileCache: jest.fn((file: TFile) => ({
					frontmatter: frontmatterByPath.get(file.path) ?? {},
				})),
			},
			vault: {
				getAbstractFileByPath: jest.fn((path: string) =>
					path === staleTask.path ? draggedFile : null
				),
				getMarkdownFiles: jest.fn(() => [draggedFile, targetFile]),
			},
			fileManager: {
				processFrontMatter: jest.fn(
					async (file: TFile, updater: (fm: Record<string, unknown>) => void) => {
						const frontmatter = frontmatterByPath.get(file.path) ?? {};
						updater(frontmatter);
						frontmatterByPath.set(file.path, frontmatter);
					}
				),
			},
		},
		cacheManager: {
			getTaskInfoFromFrontmatter: jest.fn(async () => frontmatterTask),
			getTaskInfo: jest.fn(async () => staleTask),
		},
		fieldMapper: {
			lookupMappingKey: jest.fn((property: string) =>
				property === "status" ? "status" : null
			),
			toUserField: jest.fn((field: string) =>
				field === "sortOrder" ? "sort_order" : field
			),
			isRecognizedProperty: jest.fn(() => true),
		},
		i18n: {
			translate: jest.fn((key: string) => key),
		},
		priorityManager: {
			getAllPriorities: jest.fn(() => []),
		},
		settings: {
			customStatuses: [],
			enableDebugLogging: false,
			fieldMapping: {
				sortOrder: "sort_order",
			},
			userFields: [],
		},
		statusManager: {
			isCompletedStatus: jest.fn((status: string) => status === "done"),
		},
		taskService: {
			applyPropertyChangeSideEffects: jest.fn(),
			updateCompletedDateInFrontmatter: jest.fn(),
		},
	};

	return { draggedFile, plugin };
}

describe("Bases drag/drop post-write side-effect hydration", () => {
	it("uses note/frontmatter task info before Kanban side effects", async () => {
		const staleTask = createTask({ priority: "stale-cache" });
		const frontmatterTask = createTask({ priority: "fresh-note" });
		const { draggedFile, plugin } = createPlugin({ frontmatterTask, staleTask });
		const view = new KanbanView(
			createController(),
			document.createElement("div"),
			plugin as any
		);

		(view as any).dataAdapter.getSortConfig = jest.fn(() => []);
		(view as any).schedulePostDropRender = jest.fn();
		(view as any).draggedFromColumn = "todo";
		(view as any).taskInfoCache.set(staleTask.path, staleTask);

		await (view as any).handleTaskDrop(staleTask.path, "done", null);

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			staleTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(plugin.taskService.applyPropertyChangeSideEffects).toHaveBeenCalledWith(
			draggedFile,
			frontmatterTask,
			expect.objectContaining({
				path: staleTask.path,
				priority: "fresh-note",
				status: "done",
			}),
			"status",
			"todo",
			"done"
		);
	});

	it("uses note/frontmatter task info before Task List side effects", async () => {
		const staleTask = createTask({ priority: "stale-cache" });
		const frontmatterTask = createTask({ priority: "fresh-note" });
		const { draggedFile, plugin } = createPlugin({ frontmatterTask, staleTask });
		const view = new TaskListView(
			createController(),
			document.createElement("div"),
			plugin as any
		);

		(view as any).debouncedRefresh = jest.fn();
		(view as any).taskInfoCache.set(staleTask.path, staleTask);

		await (view as any).handleSortOrderDrop(
			staleTask.path,
			"tasks/target.md",
			true,
			"done",
			"todo",
			["tasks/target.md"]
		);

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			staleTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(plugin.taskService.applyPropertyChangeSideEffects).toHaveBeenCalledWith(
			draggedFile,
			frontmatterTask,
			expect.objectContaining({
				path: staleTask.path,
				priority: "fresh-note",
				status: "done",
			}),
			"status",
			"todo",
			"done"
		);
	});
});
