import { buildKanbanSwimlaneColumns } from "../../../src/bases/kanbanGrouping";
import {
	HERMES_NO_RUN_LANE_ID,
	HERMES_UNKNOWN_RUN_LANE_ID,
	getDefaultHermesRunLaneExpanded,
	getHermesRunLaneAccessibleCopy,
	getHermesRunLaneDisplayTitle,
	getHermesRunLaneStatus,
	getHermesRunLaneTaskCountByStatus,
	buildHermesRunLaneCollapseStorageKey,
	isHermesRunLaneDropRejected,
	HERMES_RUN_REASSIGNMENT_EXPLICIT_ONLY_COPY,
	type HermesRunLaneLike,
} from "../../../src/bases/kanbanRunSwimlanes";
import { Notice } from "obsidian";
import { KanbanView } from "../../../src/bases/KanbanView";
import type { TaskInfo } from "../../../src/types";

function createTask(path: string, status: string, overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: path,
		status,
		priority: "normal",
		path,
		archived: status === "archived",
		...overrides,
	};
}

function createKanbanView(): KanbanView {
	const view = new KanbanView({}, document.createElement("div"), {
		app: {
			metadataCache: {
				getFirstLinkpathDest: () => null,
				getCache: () => null,
			},
			vault: { getAbstractFileByPath: () => null },
			workspace: { trigger: jest.fn() },
		},
		fieldMapper: {
			toUserField: (field: string) => field,
			isRecognizedProperty: () => true,
			isPropertyForField: (propertyId: string, internalField: string) =>
				propertyId === internalField,
			getMapping: () => ({}),
		},
		priorityManager: {
			getPriorityWeight: () => 0,
			getAllPriorities: () => [],
			getPriorityConfig: () => null,
		},
		statusManager: {
			getStatusConfig: () => null,
			getStatusOrder: () => 0,
			getCompletedStatuses: () => ["done"],
			isCompletedStatus: (status: string) => status === "done",
			getNextStatus: (status: string) => (status === "done" ? "todo" : "done"),
		},
		settings: {
			customStatuses: [],
			fieldMapping: {},
			defaultTaskStatus: "todo",
			showCompletedTaskStrikethrough: true,
			enableDebugLogging: false,
		},
		getActiveTimeSession: () => null,
		projectSubtasksService: { isTaskUsedAsProjectSync: () => false },
		i18n: { translate: (key: string) => key },
	} as any);
	(view as any).config = {
		getOrder: () => [],
		get: () => undefined,
		getAsPropertyId: () => null,
	};
	return view;
}

function attachSelectionService(view: KanbanView, selectedPaths: Set<string> = new Set()) {
	const service = {
		isSelected: jest.fn((path: string) => selectedPaths.has(path)),
		getPrimarySelectedPath: jest.fn(() => selectedPaths.values().next().value ?? null),
		selectPaths: jest.fn((paths: string[]) => {
			for (const path of paths) {
				selectedPaths.add(path);
			}
		}),
		deselectPaths: jest.fn((paths: string[]) => {
			for (const path of paths) {
				selectedPaths.delete(path);
			}
		}),
	};
	(view as any).plugin.taskSelectionService = service;
	return service;
}

describe("Hermes run swimlane helpers", () => {
	const activeLane: HermesRunLaneLike = {
		id: "run_active",
		title: "Implement run swimlanes",
		run_type: "user",
		status: "active",
		counts: { total: 3, done: 0, active: 3, running: 1, blocked: 1 },
		columns: [
			{ name: "todo", tasks: [{ id: "t_todo" }] },
			{ name: "running", tasks: [{ id: "t_running" }] },
			{ name: "blocked", tasks: [{ id: "t_blocked" }] },
		],
	};

	it("rejects cross-run drag/drop while allowing same-run status moves", () => {
		expect(
			isHermesRunLaneDropRejected({
				isRunSwimlaneView: true,
				sourceLaneId: "run_a",
				targetLaneId: "run_b",
			})
		).toBe(true);
		expect(
			isHermesRunLaneDropRejected({
				isRunSwimlaneView: true,
				sourceLaneId: "run_a",
				targetLaneId: "run_a",
			})
		).toBe(false);
		expect(
			isHermesRunLaneDropRejected({
				isRunSwimlaneView: false,
				sourceLaneId: "low",
				targetLaneId: "high",
			})
		).toBe(false);
		expect(HERMES_RUN_REASSIGNMENT_EXPLICIT_ONLY_COPY).toContain("explicit-only");
	});

	it("builds collapse storage keys scoped by profile board view tenant run scope and lane", () => {
		const base = buildHermesRunLaneCollapseStorageKey({
			profile: "peacock",
			board: "developer",
			view: "Kanban",
			tenant: "tenant-a",
			groupBy: "run",
			runScope: "root",
			laneId: "run_alpha",
		});
		expect(base).toBe(
			"tasknotes:hermes-run-collapse:v1:profile=peacock:board=developer:view=Kanban:tenant=tenant-a:group_by=run:run_scope=root:lane=run_alpha"
		);
		expect(
			buildHermesRunLaneCollapseStorageKey({
				profile: "peacock",
				board: "developer",
				view: "Kanban",
				tenant: "tenant-a",
				groupBy: "run",
				runScope: "direct",
				laneId: "run_alpha",
			})
		).not.toBe(base);
	});

	it("defaults active top-level, user, and orchestrator lanes expanded and completed lanes collapsed", () => {
		expect(getDefaultHermesRunLaneExpanded(activeLane)).toBe(true);
		expect(getDefaultHermesRunLaneExpanded({ ...activeLane, run_type: "orchestrator" })).toBe(
			true
		);
		expect(
			getDefaultHermesRunLaneExpanded({
				...activeLane,
				status: "done",
				counts: { total: 2, done: 2, active: 0, running: 0, blocked: 0 },
			})
		).toBe(false);
	});

	it("uses explicit singular and plural accessible copy for no-run and unknown-run lanes", () => {
		expect(
			getHermesRunLaneAccessibleCopy({
				id: HERMES_NO_RUN_LANE_ID,
				title: null,
				counts: { total: 1 },
				columns: [],
			})
		).toBe("1 task; task not assigned to a logical run.");
		expect(
			getHermesRunLaneAccessibleCopy({
				id: HERMES_NO_RUN_LANE_ID,
				title: null,
				counts: { total: 2 },
				columns: [],
			})
		).toBe("2 tasks; tasks not assigned to a logical run.");
		expect(
			getHermesRunLaneAccessibleCopy({
				id: HERMES_UNKNOWN_RUN_LANE_ID,
				title: null,
				counts: { total: 1 },
				columns: [],
			})
		).toBe("1 task; referenced run metadata is missing or not visible.");
		expect(
			getHermesRunLaneAccessibleCopy({
				id: HERMES_UNKNOWN_RUN_LANE_ID,
				title: null,
				counts: { total: 2 },
				columns: [],
			})
		).toBe("2 tasks; referenced run metadata is missing or not visible.");
	});

	it("falls back to the run id for missing titles and derives visible status text", () => {
		expect(getHermesRunLaneDisplayTitle({ ...activeLane, title: null })).toBe("run_active");
		expect(getHermesRunLaneStatus(activeLane)).toBe("blocked");
		expect(
			getHermesRunLaneStatus({
				...activeLane,
				counts: { total: 3, done: 3, active: 0, running: 0, blocked: 0 },
			})
		).toBe("done");
	});

	it("returns status-aligned counts for collapsed rows without reading task cards", () => {
		expect(
			getHermesRunLaneTaskCountByStatus(activeLane, ["todo", "running", "blocked", "done"])
		).toEqual({
			todo: 1,
			running: 1,
			blocked: 1,
			done: 0,
		});
	});

	it("keeps the same task set when status columns are additionally split by run swimlanes", () => {
		const todoInRun = createTask("tasks/todo-in-run.md", "todo");
		const runningInRun = createTask("tasks/running-in-run.md", "running");
		const todoWithoutRun = createTask("tasks/todo-no-run.md", "todo");
		const groups = new Map<string, TaskInfo[]>([
			["todo", [todoInRun, todoWithoutRun]],
			["running", [runningInRun]],
		]);
		const pathToRun = new Map<string, string[]>([
			[todoInRun.path, ["run_alpha"]],
			[runningInRun.path, ["run_alpha"]],
			[todoWithoutRun.path, ["None"]],
		]);

		const swimLanes = buildKanbanSwimlaneColumns(
			[todoInRun, runningInRun, todoWithoutRun],
			groups,
			(task) => pathToRun.get(task.path) ?? ["None"]
		);

		const flatTaskPaths = Array.from(groups.values())
			.flat()
			.map((task) => task.path)
			.sort();
		const swimLaneTaskPaths = Array.from(swimLanes.values())
			.flatMap((columns) => Array.from(columns.values()).flat())
			.map((task) => task.path)
			.sort();

		expect(swimLaneTaskPaths).toEqual(flatTaskPaths);
		expect(
			swimLanes
				.get("run_alpha")
				?.get("todo")
				?.map((task) => task.path)
		).toEqual([todoInRun.path]);
		expect(
			swimLanes
				.get("None")
				?.get("todo")
				?.map((task) => task.path)
		).toEqual([todoWithoutRun.path]);
	});

	it("renders flat assignee columns without swimlane rows when run grouping is off", async () => {
		const view = createKanbanView();
		const boardEl = document.createElement("div");
		(view as any).boardEl = boardEl;
		(view as any).swimLanePropertyId = null;

		const peacockTask = createTask("tasks/peacock.md", "todo", { contexts: ["peacock"] });
		const reviewerTask = createTask("tasks/reviewer.md", "todo", { contexts: ["reviewer-qa"] });
		const groups = new Map<string, TaskInfo[]>([
			["peacock", [peacockTask]],
			["reviewer-qa", [reviewerTask]],
		]);

		await (view as any).renderFlat({
			taskNotes: [peacockTask, reviewerTask],
			filteredTasks: [peacockTask, reviewerTask],
			groups,
			allGroups: groups,
			groupByPropertyId: "contexts",
			orderedKeys: ["peacock", "reviewer-qa"],
			visibleProperties: [],
			cardOptions: {},
			cardRenderSignature: "{}",
			structuralSignature: "assignee-flat",
			scopes: [
				{ key: "peacock", paths: [peacockTask.path], usesVirtualScrolling: false },
				{ key: "reviewer-qa", paths: [reviewerTask.path], usesVirtualScrolling: false },
			],
		});

		expect(boardEl.querySelector(".kanban-view__swimlane-row")).toBeNull();
		expect(
			Array.from(boardEl.querySelectorAll(".kanban-view__column")).map((column) =>
				column.getAttribute("data-group")
			)
		).toEqual(["peacock", "reviewer-qa"]);
		expect(
			Array.from(boardEl.querySelectorAll(".kanban-view__card-wrapper")).map((card) =>
				card.getAttribute("data-task-path")
			)
		).toEqual([peacockTask.path, reviewerTask.path]);
	});

	it("renders completed Hermes run swimlanes collapsed with count summaries instead of cards", async () => {
		const view = createKanbanView();
		const boardEl = document.createElement("div");
		(view as any).boardEl = boardEl;
		(view as any).swimLanePropertyId = "hermesRootRunId";

		const doneTask = createTask("tasks/done.md", "done");
		const swimLanes = new Map([
			[
				"run_done",
				new Map([
					["todo", []],
					["running", []],
					["blocked", []],
					["done", [doneTask]],
				]),
			],
		]);
		const pathToProps = new Map([
			[
				doneTask.path,
				{
					hermesRootRunId: "run_done",
					hermesRunTitle: "Completed run",
					hermesRunType: "user",
				},
			],
		]);

		await (view as any).renderSwimLaneTable(
			swimLanes,
			["todo", "running", "blocked", "done"],
			pathToProps,
			"status"
		);

		const cell = boardEl.querySelector<HTMLElement>("[data-run-lane-id='run_done']");
		expect(cell).not.toBeNull();
		expect(cell?.classList.contains("kanban-view__swimlane-column--collapsed")).toBe(true);
		expect(boardEl.querySelector(".kanban-view__swimlane-row")).toBeNull();
		expect(boardEl.querySelector(".kanban-view__card-wrapper")).toBeNull();
		expect(cell?.textContent).toContain("Completed run");
		expect(boardEl.textContent).toContain("done: 1");
	});

	it("renders expanded Hermes run swimlanes inside status columns with task cards", async () => {
		const view = createKanbanView();
		const boardEl = document.createElement("div");
		(view as any).boardEl = boardEl;
		(view as any).swimLanePropertyId = "hermesRootRunId";

		const todoTask = createTask("tasks/run-todo.md", "todo");
		const runningTask = createTask("tasks/run-running.md", "running");
		const pathToProps = new Map([
			[
				todoTask.path,
				{
					hermesRootRunId: "run_active",
					hermesRunTitle: "Active run",
					hermesRunType: "user",
				},
			],
			[
				runningTask.path,
				{
					hermesRootRunId: "run_active",
					hermesRunTitle: "Active run",
					hermesRunType: "user",
				},
			],
		]);

		await (view as any).renderSwimLaneTable(
			new Map([
				[
					"run_active",
					new Map([
						["todo", [todoTask]],
						["running", [runningTask]],
					]),
				],
			]),
			["todo", "running"],
			pathToProps,
			"status"
		);

		const cell = boardEl.querySelector<HTMLElement>("[data-run-lane-id='run_active']");
		expect(cell).not.toBeNull();
		expect(cell?.classList.contains("kanban-view__swimlane-column--collapsed")).toBe(false);
		expect(boardEl.querySelector(".kanban-view__swimlane-row")).toBeNull();
		expect(boardEl.querySelector(".kanban-view__swimlane-grid")).toBeNull();
		expect(
			Array.from(
				boardEl.querySelectorAll(
					".kanban-view__swimlane-column[data-swimlane='run_active']"
				)
			).map((cell) => cell.getAttribute("data-column"))
		).toEqual(["todo", "running"]);
		expect(
			Array.from(boardEl.querySelectorAll(".kanban-view__card-wrapper")).map((card) =>
				card.getAttribute("data-task-path")
			)
		).toEqual([todoTask.path, runningTask.path]);
		expect(boardEl.querySelector(".kanban-view__swimlane-column--collapsed-summary")).toBeNull();
	});

	it("groups swimlanes only inside columns that contain matching tasks", async () => {
		const view = createKanbanView();
		const selectedPaths = new Set<string>();
		const selectionService = attachSelectionService(view, selectedPaths);
		const boardEl = document.createElement("div");
		(view as any).boardEl = boardEl;
		(view as any).swimLanePropertyId = "hermesBoard";
		(view as any).hideEmptyColumns = true;
		(view as any).hideEmptySwimLanes = true;

		const defaultTodo = createTask("tasks/default-todo.md", "todo");
		const liveTodo = createTask("tasks/live-todo.md", "todo");
		const defaultRunning = createTask("tasks/default-running.md", "running");

		await (view as any).renderSwimLaneTable(
			new Map([
				[
					"default",
					new Map([
						["todo", [defaultTodo]],
						["running", [defaultRunning]],
					]),
				],
				[
					"live-archived-check",
					new Map([
						["todo", [liveTodo]],
						["running", []],
					]),
				],
			]),
			["triage", "todo", "ready", "running", "blocked"],
			new Map(),
			"status"
		);

		const columns = Array.from(boardEl.querySelectorAll<HTMLElement>(".kanban-view__column"));
		expect(columns.map((column) => column.getAttribute("data-column"))).toEqual([
			"todo",
			"running",
		]);
		expect(
			Array.from(
				columns[0].querySelectorAll<HTMLElement>(".kanban-view__swimlane-column")
			).map((cell) => cell.getAttribute("data-swimlane"))
		).toEqual(["default", "live-archived-check"]);
		const firstLane = columns[0].querySelector<HTMLElement>(
			".kanban-view__swimlane-column[data-swimlane='default']"
		);
		const headerButton = firstLane?.querySelector<HTMLElement>(
			".kanban-view__swimlane-section-header .kanban-view__swimlane-add-task-button"
		);
		expect(headerButton?.getAttribute("aria-label")).toBe("Add task to todo / default");
		const columnCheckbox = columns[0].querySelector<HTMLInputElement>(
			".kanban-view__column-header .kanban-view__scope-selection-checkbox"
		);
		expect(columnCheckbox?.checked).toBe(false);
		columnCheckbox!.checked = true;
		columnCheckbox!.dispatchEvent(new Event("change", { bubbles: true }));
		expect(selectionService.selectPaths).toHaveBeenCalledWith([
			defaultTodo.path,
			liveTodo.path,
		]);

		const swimlaneCheckbox = firstLane?.querySelector<HTMLInputElement>(
			".kanban-view__swimlane-section-header .kanban-view__scope-selection-checkbox"
		);
		selectedPaths.clear();
		selectedPaths.add(defaultTodo.path);
		(view as any).updateSelectionVisuals();
		expect(swimlaneCheckbox?.checked).toBe(true);
		expect(swimlaneCheckbox?.indeterminate).toBe(false);
		expect(columnCheckbox?.checked).toBe(false);
		expect(columnCheckbox?.indeterminate).toBe(true);
		swimlaneCheckbox!.checked = false;
		swimlaneCheckbox!.dispatchEvent(new Event("change", { bubbles: true }));
		expect(selectionService.deselectPaths).toHaveBeenCalledWith([defaultTodo.path]);
		expect(firstLane?.querySelector(".kanban-view__add-task-footer")).toBeNull();
		expect(
			Array.from(
				columns[1].querySelectorAll<HTMLElement>(".kanban-view__swimlane-column")
			).map((cell) => cell.getAttribute("data-swimlane"))
		).toEqual(["default"]);
		expect(boardEl.querySelector(".kanban-view__swimlane-row")).toBeNull();
		expect(boardEl.querySelector(".kanban-view__swimlane-grid")).toBeNull();
	});

	it("renders No run and Unknown run groups when populated", async () => {
		const view = createKanbanView();
		const boardEl = document.createElement("div");
		(view as any).boardEl = boardEl;
		(view as any).swimLanePropertyId = "hermesRootRunId";

		await (view as any).renderSwimLaneTable(
			new Map([
				["None", new Map([["todo", [createTask("tasks/no-run.md", "todo")]]])],
				[
					"__unknown_run__",
					new Map([["blocked", [createTask("tasks/unknown-run.md", "blocked")]]]),
				],
			]),
			["todo", "blocked"],
			new Map(),
			"status"
		);

		const noRunRow = boardEl.querySelector<HTMLElement>(
			`[data-run-lane-id='${HERMES_NO_RUN_LANE_ID}']`
		);
		const unknownRunRow = boardEl.querySelector<HTMLElement>(
			`[data-run-lane-id='${HERMES_UNKNOWN_RUN_LANE_ID}']`
		);
		expect(noRunRow?.textContent).toContain("No run");
		expect(noRunRow?.textContent).toContain("tasks not assigned to a logical run");
		expect(unknownRunRow?.textContent).toContain("Unknown run");
		expect(unknownRunRow?.textContent).toContain(
			"referenced run metadata is missing or not visible"
		);
		expect(boardEl.querySelectorAll(".kanban-view__card-wrapper")).toHaveLength(2);
	});

	it("renders Unknown run with visible text warning copy", async () => {
		const view = createKanbanView();
		const boardEl = document.createElement("div");
		(view as any).boardEl = boardEl;
		(view as any).swimLanePropertyId = "hermesRootRunId";
		(view as any).hermesRunLaneExpandedOverrides.set(HERMES_UNKNOWN_RUN_LANE_ID, false);

		await (view as any).renderSwimLaneTable(
			new Map([
				["__unknown_run__", new Map([["todo", [createTask("tasks/stale.md", "todo")]]])],
			]),
			["todo"],
			new Map(),
			"status"
		);

		const row = boardEl.querySelector<HTMLElement>(
			`[data-run-lane-id='${HERMES_UNKNOWN_RUN_LANE_ID}']`
		);
		expect(row).not.toBeNull();
		expect(row?.getAttribute("aria-label")).toContain(
			"referenced run metadata is missing or not visible"
		);
		expect(row?.textContent).toContain("Unknown run");
		expect(row?.textContent).toContain("referenced run metadata is missing or not visible");
	});

	it("rejects drop-on-card moves across Hermes run swimlanes before reordering or task updates", async () => {
		const view = createKanbanView();
		const task = createTask("tasks/target.md", "todo");
		const row = document.createElement("div");
		const column = document.createElement("div");
		const container = document.createElement("div");
		const card = document.createElement("div");

		row.dataset.swimlane = "run_target";
		column.dataset.column = "todo";
		container.className = "kanban-view__tasks-container";
		card.className = "kanban-view__card-wrapper";
		card.dataset.taskPath = task.path;
		Object.defineProperty(card, "getBoundingClientRect", {
			value: () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 100, width: 100 }),
		});

		container.appendChild(card);
		column.appendChild(container);
		row.appendChild(column);
		document.body.appendChild(row);

		(view as any).swimLanePropertyId = "hermesRootRunId";
		(view as any).draggedTaskPath = "tasks/source.md";
		(view as any).draggedTaskPaths = ["tasks/source.md"];
		(view as any).draggedFromColumn = "todo";
		(view as any).draggedFromSwimlane = "run_source";
		(view as any).performOptimisticReorder = jest.fn();
		(view as any).cleanupDragShift = jest.fn();
		(view as any).handleTaskDrop = jest.fn().mockResolvedValue(undefined);
		(view as any).debugLog = jest.fn();

		(view as any).setupCardDragHandlers(card, task);
		const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(dropEvent, "clientY", { value: 25 });
		Object.defineProperty(dropEvent, "dataTransfer", {
			value: { types: [] },
		});

		card.dispatchEvent(dropEvent);
		await Promise.resolve();
		await Promise.resolve();

		expect(Notice).toHaveBeenCalledWith(HERMES_RUN_REASSIGNMENT_EXPLICIT_ONLY_COPY);
		expect((view as any).debugLog).toHaveBeenCalledWith("CARD-DROP-REJECTED", {
			sourceSwimlane: "run_source",
			targetSwimlane: "run_target",
			reason: HERMES_RUN_REASSIGNMENT_EXPLICIT_ONLY_COPY,
		});
		expect((view as any).cleanupDragShift).toHaveBeenCalled();
		expect((view as any).performOptimisticReorder).not.toHaveBeenCalled();
		expect((view as any).handleTaskDrop).not.toHaveBeenCalled();
	});
});
