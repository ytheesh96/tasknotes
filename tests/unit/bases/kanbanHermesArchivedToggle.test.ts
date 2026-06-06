import {
	isHermesArchivedTask,
	filterKanbanTasksByHermesArchivedVisibility,
	getKanbanViewConfigOption,
} from "../../../src/bases/KanbanView";
import type { TaskInfo } from "../../../src/types";

function createTask(path: string, hermesArchived?: unknown): TaskInfo {
	return {
		title: path,
		status: "todo",
		priority: "normal",
		path,
		archived: false,
		customProperties:
			hermesArchived === undefined
				? undefined
				: {
						hermesArchived,
				  },
	};
}

describe("KanbanView Hermes archived visibility", () => {
	it("treats boolean true and legacy string true as Hermes archived", () => {
		expect(isHermesArchivedTask(createTask("boolean.md", true))).toBe(true);
		expect(isHermesArchivedTask(createTask("string.md", "true"))).toBe(true);
		expect(isHermesArchivedTask(createTask("false.md", false))).toBe(false);
		expect(isHermesArchivedTask(createTask("string-false.md", "false"))).toBe(false);
		expect(isHermesArchivedTask(createTask("missing.md"))).toBe(false);
	});

	it("hides Hermes archived tasks by default and shows them when configured", () => {
		const tasks = [
			createTask("active.md", false),
			createTask("missing.md"),
			createTask("boolean-archived.md", true),
			createTask("string-archived.md", "true"),
		];

		expect(filterKanbanTasksByHermesArchivedVisibility(tasks, false).map((task) => task.path)).toEqual([
			"active.md",
			"missing.md",
		]);
		expect(filterKanbanTasksByHermesArchivedVisibility(tasks, true).map((task) => task.path)).toEqual([
			"active.md",
			"missing.md",
			"boolean-archived.md",
			"string-archived.md",
		]);
	});

	it("reads the archived toggle from nested Bases view options", () => {
		const config = {
			get: jest.fn((key: string) =>
				key === "options" ? { showHermesArchivedTasks: true } : undefined
			),
		};

		expect(getKanbanViewConfigOption(config, "showHermesArchivedTasks")).toBe(true);
	});

	it("falls back to nested Bases view options when direct config returns null", () => {
		const config = {
			get: jest.fn((key: string) => {
				if (key === "showHermesArchivedTasks") return null;
				if (key === "options") return { showHermesArchivedTasks: true };
				return undefined;
			}),
		};

		expect(getKanbanViewConfigOption(config, "showHermesArchivedTasks")).toBe(true);
	});

	it("prefers direct view config values over nested options", () => {
		const config = {
			get: jest.fn((key: string) => {
				if (key === "showHermesArchivedTasks") return false;
				if (key === "options") return { showHermesArchivedTasks: true };
				return undefined;
			}),
		};

		expect(getKanbanViewConfigOption(config, "showHermesArchivedTasks")).toBe(false);
	});
});
