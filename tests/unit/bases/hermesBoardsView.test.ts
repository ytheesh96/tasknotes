import {
	HermesBoardsView,
	buildHermesBoardSummaries,
	getHermesBoardKanbanOpenPath,
	type HermesBoardSummary,
	type HermesBoardsViewOptions,
} from "../../../src/bases/HermesBoardsView";
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
			"default",
			"job-hunt",
			"local-only",
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
			"TaskNotes/Views/kanban-board-job-hunt.base"
		);
		expect(getHermesBoardKanbanOpenPath("Job Hunt")).toBe(
			"TaskNotes/Views/kanban-board-job-hunt.base"
		);
		expect(getHermesBoardKanbanOpenPath("not valid!")).toBeNull();
	});

	it("opens a board card while keeping the delete button separate", () => {
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
		expect(card?.getAttribute("role")).toBe("button");
		expect(card?.tabIndex).toBe(0);

		card?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(openBoardKanban).toHaveBeenCalledWith("job-hunt");

		const deleteButton = container.querySelector<HTMLButtonElement>(
			".hermes-boards-view__delete-button"
		);
		deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(deleteBoard).toHaveBeenCalledWith("job-hunt");
		expect(openBoardKanban).toHaveBeenCalledTimes(1);

		card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(openBoardKanban).toHaveBeenCalledTimes(2);
	});
});
