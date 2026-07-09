import {
	HermesBoardsView,
	buildHermesBoardSummaries,
	getHermesBoardKanbanOpenPath,
	type HermesBoardSummary,
	type HermesBoardsViewOptions,
} from "../../../src/bases/HermesBoardsView";
import { App, MockObsidian, TFile } from "../../helpers/obsidian-runtime";
import type { TaskInfo } from "../../../src/types";
import { HermesKanbanApiClient } from "../../../src/hermes/hermesApiClient";
import { showConfirmationModal } from "../../../src/modals/ConfirmationModal";
import { showTextInputModal } from "../../../src/modals/TextInputModal";
import { readHermesBoardRegistry } from "../../../src/hermes/hermesBoardRegistry";

jest.mock("../../../src/modals/ConfirmationModal", () => ({
	showConfirmationModal: jest.fn(),
}));

jest.mock("../../../src/modals/TextInputModal", () => ({
	showTextInputModal: jest.fn(),
}));

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

function readFrontmatterValue(content: string, key: string): string | undefined {
	return content.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
}

describe("HermesBoardsView", () => {
	beforeEach(() => {
		MockObsidian.reset();
		jest.restoreAllMocks();
		(showConfirmationModal as jest.Mock).mockReset();
		(showTextInputModal as jest.Mock).mockReset();
	});

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

	it("shows TaskNotes-native board records even when they have zero tasks", () => {
		const summaries = buildHermesBoardSummaries(
			[],
			[
				{ slug: "empty-local", archived: false, source: "registry" },
				{ slug: "archived-local", archived: true, source: "registry" },
			] as any,
			options
		);

		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			slug: "empty-local",
			source: "local",
			taskCount: 0,
			mirrorCount: 0,
		});
	});

	it("imports live Hermes boards into TaskNotes-native board records", async () => {
		const app = new App();
		jest.spyOn(HermesKanbanApiClient.prototype, "listBoards").mockResolvedValue([
			{ slug: "live-only", name: "Live Only", archived: false },
			{ slug: "archived-live", name: "Archived Live", archived: true },
		] as any);
		const container = document.createElement("div");
		const view = new HermesBoardsView({}, container, {
			app,
			settings: { enableDebugLogging: false },
			fieldMapper: {},
		} as any);
		(view as any).rootElement = container;
		(view as any).contentEl = container;

		await view.render();

		const registry = await readHermesBoardRegistry({ app } as any, { includeArchived: true });
		expect(registry).toMatchObject([
			{ slug: "archived-live", archived: true, source: "registry" },
			{ slug: "live-only", archived: false, source: "registry" },
		]);
		expect(app.vault.getAbstractFileByPath("TaskNotes/Boards/live-only.md")).toBeInstanceOf(TFile);
		expect(container.textContent).toContain("live-only");
		expect(container.textContent).not.toContain("archived-live");
	});

	it("does not rewrite TaskNotes-native board records on unchanged live board renders", async () => {
		jest.useFakeTimers();
		try {
			const app = new App();
			const listBoards = jest
				.spyOn(HermesKanbanApiClient.prototype, "listBoards")
				.mockResolvedValue([{ slug: "live-only", name: "Live Only", archived: false }] as any);
			const container = document.createElement("div");
			const view = new HermesBoardsView({}, container, {
				app,
				settings: { enableDebugLogging: false },
				fieldMapper: {},
			} as any);
			(view as any).rootElement = container;
			(view as any).contentEl = container;

			jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			await view.render();
			const boardFile = app.vault.getAbstractFileByPath("TaskNotes/Boards/live-only.md") as TFile;
			const firstContent = await app.vault.read(boardFile);
			const firstDateModified = readFrontmatterValue(firstContent, "dateModified");
			const modifySpy = jest.spyOn(app.vault, "modify");

			jest.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
			await view.render();

			expect(listBoards).toHaveBeenCalledTimes(2);
			expect(modifySpy).not.toHaveBeenCalled();
			expect(await app.vault.read(boardFile)).toBe(firstContent);
			expect(readFrontmatterValue(firstContent, "dateModified")).toBe(firstDateModified);

			listBoards.mockResolvedValue([
				{ slug: "live-only", name: "Live Renamed", archived: false },
			] as any);
			jest.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
			await view.render();

			expect(modifySpy).toHaveBeenCalledTimes(1);
			const updatedContent = await app.vault.read(boardFile);
			expect(readFrontmatterValue(updatedContent, "hermesBoardName")).toBe("Live Renamed");
			expect(readFrontmatterValue(updatedContent, "dateModified")).not.toBe(firstDateModified);
		} finally {
			jest.useRealTimers();
		}
	});

	it("ignores stale E2E fixture live boards in user-facing summaries", () => {
		const summaries = buildHermesBoardSummaries(
			[],
			[
				{ slug: "tasknotes-dashboardless-e2e-fixture", archived: false, source: "live" },
				{ slug: "default", archived: false, source: "live" },
			] as any,
			options
		);

		expect(summaries.map((summary) => summary.slug)).toEqual(["default"]);
	});

	it("ignores stale E2E fixture board records in user-facing board reads", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Boards/tasknotes-dashboardless-e2e-fixture.md",
			`---
type: hermes-board
hermesBoard: tasknotes-dashboardless-e2e-fixture
hermesBoardName: TaskNotes Dashboardless E2E Fixture
hermesBoardArchived: false
---

# Hermes/tasknotes-dashboardless-e2e-fixture
`
		);
		await app.vault.create(
			"TaskNotes/Boards/default.md",
			`---
type: hermes-board
hermesBoard: default
hermesBoardName: Default
hermesBoardArchived: false
---

# Hermes/default
`
		);

		const registry = await readHermesBoardRegistry({ app } as any);

		expect(registry.map((record) => record.slug)).toEqual(["default"]);
	});

	it("skips vanished E2E fixture board files left in Obsidian's file cache", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Boards/default.md",
			`---
type: hermes-board
hermesBoard: default
hermesBoardName: Default
hermesBoardArchived: false
---

# Hermes/default
`
		);
		const defaultFile = app.vault.getAbstractFileByPath("TaskNotes/Boards/default.md") as TFile;
		jest.spyOn(app.vault, "getFiles").mockReturnValue([
			new TFile("TaskNotes/Boards/e2e-archive-vanished.md"),
			defaultFile,
		]);

		const registry = await readHermesBoardRegistry({ app } as any);

		expect(registry.map((record) => record.slug)).toEqual(["default"]);
	});

	it("renders TaskNotes-native boards when the Hermes dashboard is unavailable", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Boards/offline-board.md",
			`---
type: hermes-board
hermesBoard: offline-board
hermesBoardName: Offline Board
hermesBoardArchived: false
---

# Hermes/offline-board
`
		);
		jest.spyOn(HermesKanbanApiClient.prototype, "listBoards").mockRejectedValue(
			new Error("dashboard offline")
		);
		const container = document.createElement("div");
		const view = new HermesBoardsView({}, container, {
			app,
			settings: { enableDebugLogging: false },
			fieldMapper: {},
		} as any);
		(view as any).rootElement = container;
		(view as any).contentEl = container;

		await view.render();

		expect(container.textContent).toContain("offline-board");
		expect(container.textContent).toContain("Local only");
		expect(container.textContent).toContain("Live board list unavailable");
	});

	it("keeps archived TaskNotes-native board tombstones from reappearing via live or task-derived boards", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Boards/old-board.md",
			`---
type: hermes-board
hermesBoard: old-board
hermesBoardArchived: true
---

# Hermes/old-board
`
		);
		jest.spyOn(HermesKanbanApiClient.prototype, "listBoards").mockResolvedValue([
			{ slug: "old-board", name: "Old Board", archived: false },
		] as any);
		const container = document.createElement("div");
		const view = new HermesBoardsView({}, container, {
			app,
			settings: { enableDebugLogging: false },
			fieldMapper: {},
		} as any);
		(view as any).rootElement = container;
		(view as any).contentEl = container;
		(view as any).resolveTasks = jest.fn(async () => [
			task({
				title: "Archived board should stay hidden",
				path: "TaskNotes/Tasks/old-board--t_hidden.md",
				projects: ["Hermes/old-board"],
				customProperties: { hermesBoard: "old-board" },
			}),
		]);

		await view.render();

		expect(container.textContent).not.toContain("old-board");
		expect(container.textContent).toContain("No Hermes boards found");
	});

	it("creates a TaskNotes-native board object and shared Kanban view without dashboard access", async () => {
		const app = new App();
		(showTextInputModal as jest.Mock).mockResolvedValue("Empty Board");
		const createBoard = jest
			.spyOn(HermesKanbanApiClient.prototype, "createBoard")
			.mockRejectedValue(new Error("dashboard offline"));
		const container = document.createElement("div");
		const view = new HermesBoardsView({}, container, {
			app,
			settings: { enableDebugLogging: false },
			fieldMapper: {},
		} as any);
		(view as any).rootElement = container;
		(view as any).contentEl = container;
		(view as any).refresh = jest.fn();

		await (view as any).createBoard();

		expect(createBoard).not.toHaveBeenCalled();
		const boardFile = app.vault.getAbstractFileByPath("TaskNotes/Boards/empty-board.md");
		expect(boardFile).toBeInstanceOf(TFile);
		const registry = await readHermesBoardRegistry({ app } as any);
		expect(registry).toMatchObject([
			{ slug: "empty-board", archived: false, source: "registry" },
		]);
		const base = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		expect(await app.vault.read(base)).toContain('name: "Empty Board"');
	});

	it("archives the TaskNotes-native board object and keeps local cleanup explicit on delete", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Boards/old-board.md",
			`---
type: hermes-board
hermesBoard: old-board
hermesBoardArchived: false
---

# Hermes/old-board
`
		);
		await app.vault.create(
			"TaskNotes/Tasks/old-board--t_cleanup.md",
			`---
title: Mirror to remove
hermesTaskId: t_cleanup
hermesBoard: old-board
---
`
		);
		(showConfirmationModal as jest.Mock).mockResolvedValue(true);
		const deleteBoard = jest
			.spyOn(HermesKanbanApiClient.prototype, "deleteBoard")
			.mockRejectedValue(new Error("dashboard offline"));
		const clearCacheEntry = jest.fn();
		const trigger = jest.fn();
		const container = document.createElement("div");
		const view = new HermesBoardsView({}, container, {
			app,
			settings: { enableDebugLogging: false },
			fieldMapper: {},
			cacheManager: {
				// Simulate the live TaskNotes cache lagging behind a freshly-written
				// Hermes mirror; board deletion should still scan canonical mirror paths.
				getAllTasks: jest.fn(async () => []),
				clearCacheEntry,
			},
			emitter: { trigger },
		} as any);
		(view as any).rootElement = container;
		(view as any).contentEl = container;
		(view as any).refresh = jest.fn();

		await (view as any).deleteBoard("old-board");

		expect(deleteBoard).not.toHaveBeenCalled();
		const registry = await readHermesBoardRegistry({ app } as any, { includeArchived: true });
		expect(registry).toMatchObject([
			{ slug: "old-board", archived: true, source: "registry" },
		]);
		expect(app.vault.getAbstractFileByPath("TaskNotes/Tasks/old-board--t_cleanup.md")).toBeNull();
		expect(clearCacheEntry).toHaveBeenCalledWith("TaskNotes/Tasks/old-board--t_cleanup.md");
		expect(trigger).toHaveBeenCalledWith("task-deleted", expect.any(Object));
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
