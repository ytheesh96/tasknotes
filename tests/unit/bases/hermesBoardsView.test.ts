import {
	HermesBoardsView,
	buildHermesBoardSummaries,
	getHermesBoardKanbanOpenPath,
	type HermesBoardSummary,
	type HermesBoardsViewOptions,
} from "../../../src/bases/HermesBoardsView";
import { TFile } from "obsidian";
import type { TaskInfo } from "../../../src/types";

const options: HermesBoardsViewOptions = {
	boardProperty: "projects",
	statusProperty: "status",
	agentProperty: "contexts",
	defaultBoard: "default",
	doneStatuses: new Set(["done", "completed"]),
	busyStatuses: new Set(["running"]),
	reviewStatuses: new Set(["review"]),
};

function task(overrides: Partial<TaskInfo>): TaskInfo {
	return {
		title: "Task",
		status: "ready",
		priority: "normal",
		path: "TaskNotes/default/t_1.md",
		archived: false,
		...overrides,
	};
}

describe("HermesBoardsView", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("combines live boards with local TaskNotes mirrors", () => {
		const summaries = buildHermesBoardSummaries(
			[
				task({
					title: "Run implementation",
					path: "TaskNotes/job-hunt/t_run.md",
					status: "running",
					projects: ["Hermes/job-hunt"],
					contexts: ["codex"],
				}),
				task({
					title: "Review result",
					path: "TaskNotes/job-hunt/t_review.md",
					status: "review",
					projects: ["Hermes/job-hunt"],
					customProperties: { assignee: "planner" },
				}),
				task({
					title: "Archived local note",
					path: "TaskNotes/default/t_done.md",
					status: "done",
					projects: ["Hermes/default"],
				}),
				task({
					title: "Local-only board task",
					path: "TaskNotes/local-only/t_local.md",
					status: "blocked",
					projects: ["Hermes/local-only"],
				}),
			],
			[
				{ slug: "job-hunt", archived: false },
				{ slug: "empty-live", archived: false },
				{ slug: "archived-live", archived: true },
			],
			options
		);

		expect(summaries.map((summary) => summary.slug)).toEqual([
			"job-hunt",
			"local-only",
			"default",
			"empty-live",
		]);

		expect(summaries.find((summary) => summary.slug === "job-hunt")).toMatchObject({
			source: "both",
			taskCount: 2,
			activeCount: 2,
			runningCount: 1,
			reviewCount: 1,
			mirrorCount: 2,
			agents: ["codex", "planner"],
		});

		expect(summaries.find((summary) => summary.slug === "local-only")).toMatchObject({
			source: "local",
			blockedCount: 1,
			mirrorCount: 1,
		});

		expect(summaries.find((summary) => summary.slug === "empty-live")).toMatchObject({
			source: "live",
			taskCount: 0,
			mirrorCount: 0,
		});
		expect(summaries.some((summary) => summary.slug === "archived-live")).toBe(false);
	});

	it("opens the board Kanban target path for a board slug", () => {
		expect(getHermesBoardKanbanOpenPath("job-hunt")).toBe(
			"TaskNotes/Views/kanban-default.base"
		);
		expect(getHermesBoardKanbanOpenPath("Job Hunt")).toBe(
			"TaskNotes/Views/kanban-default.base"
		);
		expect(getHermesBoardKanbanOpenPath("not valid!")).toBeNull();
	});

	it("opens the shared Kanban base with the requested board view selected", async () => {
		const file = new TFile("TaskNotes/Views/kanban-default.base");
		const openFile = jest.fn(async () => undefined);
		const view = new HermesBoardsView({}, document.createElement("div"), {
			app: {
				vault: {
					adapter: { exists: jest.fn(async () => true) },
					createFolder: jest.fn(async () => undefined),
					getAbstractFileByPath: jest.fn(() => file),
					getFiles: jest.fn(() => []),
					read: jest.fn(async () => ""),
					modify: jest.fn(async () => undefined),
				},
				workspace: {
					getLeaf: jest.fn(() => ({ openFile })),
					trigger: jest.fn(),
				},
			},
			settings: { enableDebugLogging: false },
			fieldMapper: {},
		} as any);

		await (view as any).openBoardKanban("job-hunt");

		expect(openFile).toHaveBeenCalledWith(file, {
			active: true,
			state: {
				file: "TaskNotes/Views/kanban-default.base",
				viewName: "Job Hunt",
			},
		});
	});

	it("clarifies board, TaskNotes, and local mirror counts in summary copy", () => {
		const view = new HermesBoardsView({}, document.createElement("div"), {
			app: {},
			settings: { enableDebugLogging: false },
			fieldMapper: {},
		} as any);
		const container = document.createElement("div");
		(view as any).contentEl = container;

		(view as any).renderSummary([
			{
				slug: "default",
				source: "both",
				taskCount: 126,
				activeCount: 3,
				doneCount: 100,
				runningCount: 1,
				reviewCount: 1,
				blockedCount: 1,
				mirrorCount: 121,
				agents: [],
			},
			{
				slug: "job-hunt",
				source: "live",
				taskCount: 2,
				activeCount: 2,
				doneCount: 0,
				runningCount: 0,
				reviewCount: 0,
				blockedCount: 0,
				mirrorCount: 2,
				agents: [],
			},
		], 128);

		expect(container.textContent).toContain("2 boards from 128 TaskNotes");
		expect(container.textContent).toContain("123 local mirrors");
	});

	it("does not replace missing Bases rows with a broad TaskNotes cache scan", async () => {
		const getAllTasks = jest.fn(async () => [
			task({
				title: "Should not be read",
				path: "TaskNotes/default/t_cache.md",
				projects: ["Hermes/default"],
			}),
		]);
		const view = new HermesBoardsView({}, document.createElement("div"), {
			app: {},
			settings: { enableDebugLogging: false },
			fieldMapper: {},
			cacheManager: { getAllTasks },
		} as any);

		const tasks = await (view as any).resolveTasks();

		expect(tasks).toEqual([]);
		expect(getAllTasks).not.toHaveBeenCalled();
	});

	it("renders visible open and secondary delete affordances without nested card buttons", () => {
		const view = new HermesBoardsView({}, document.createElement("div"), {
			app: {},
			settings: { enableDebugLogging: false },
			fieldMapper: {},
		} as any);
		const openBoardKanban = jest.fn();
		const deleteBoard = jest.fn();
		(view as any).openBoardKanban = openBoardKanban;
		(view as any).deleteBoard = deleteBoard;
		(view as any).options = options;

		const container = document.createElement("div");
		const summary: HermesBoardSummary = {
			slug: "job-hunt",
			source: "both",
			taskCount: 2,
			activeCount: 2,
			doneCount: 0,
			runningCount: 1,
			reviewCount: 1,
			blockedCount: 0,
			mirrorCount: 2,
			agents: ["codex"],
		};

		(view as any).renderBoardCard(container, summary);

		const card = container.querySelector<HTMLElement>(".hermes-boards-view__board");
		expect(card?.hasAttribute("role")).toBe(false);
		expect(card?.tabIndex).toBe(-1);

		const openButton = container.querySelector<HTMLButtonElement>(
			".hermes-boards-view__open-button"
		);
		expect(openButton?.textContent).toContain("Open kanban");
		expect(openButton?.getAttribute("aria-label")).toBe("Open Hermes/job-hunt kanban");
		openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(openBoardKanban).toHaveBeenCalledWith("job-hunt");

		const actions = container.querySelector<HTMLDetailsElement>(
			".hermes-boards-view__board-actions"
		);
		expect(actions?.textContent).toContain("Actions");
		const deleteButton = container.querySelector<HTMLButtonElement>(
			".hermes-boards-view__delete-button"
		);
		deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(deleteBoard).toHaveBeenCalledWith("job-hunt");
		expect(openBoardKanban).toHaveBeenCalledTimes(1);
	});
});
