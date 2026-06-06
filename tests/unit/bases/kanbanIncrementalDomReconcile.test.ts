import { KanbanView } from "../../../src/bases/KanbanView";
import type { TaskInfo } from "../../../src/types";

function createTask(path: string, overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: path,
		status: "todo",
		priority: "normal",
		path,
		archived: false,
		...overrides,
	};
}

function makeView(): KanbanView {
	return new KanbanView(
		{},
		document.createElement("div"),
		{
			app: {},
			fieldMapper: {
				toUserField: (field: string) => field,
				isRecognizedProperty: () => true,
			},
			priorityManager: {
				getAllPriorities: () => [],
			},
			settings: {
				customStatuses: [],
				fieldMapping: {
					sortOrder: "sort_order",
				},
			},
			i18n: {
				translate: (key: string) => key,
			},
		} as any
	);
}

function createBoard(view: KanbanView, groupKeys: string[]): Record<string, HTMLElement> {
	const board = document.createElement("div");
	const containers: Record<string, HTMLElement> = {};
	for (const groupKey of groupKeys) {
		const column = document.createElement("div");
		column.className = "kanban-view__column";
		column.setAttribute("data-group", groupKey);
		const cards = document.createElement("div");
		cards.className = "kanban-view__cards";
		column.appendChild(cards);
		board.appendChild(column);
		containers[groupKey] = cards;
	}
	(view as any).boardEl = board;
	return containers;
}

function createWrapper(path: string): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "kanban-view__card-wrapper";
	wrapper.setAttribute("data-task-path", path);
	return wrapper;
}

function createFlatState(tasksByGroup: Record<string, TaskInfo[]>) {
	const groups = new Map<string, TaskInfo[]>(Object.entries(tasksByGroup));
	const orderedKeys = Object.keys(tasksByGroup);
	return {
		taskNotes: orderedKeys.flatMap((groupKey) => tasksByGroup[groupKey]),
		filteredTasks: orderedKeys.flatMap((groupKey) => tasksByGroup[groupKey]),
		groups,
		allGroups: groups,
		groupByPropertyId: "status",
		orderedKeys,
		visibleProperties: [],
		cardOptions: { layout: "default" },
		cardRenderSignature: "card-config",
		structuralSignature: "same-board",
		scopes: orderedKeys.map((groupKey) => ({
			key: groupKey,
			paths: tasksByGroup[groupKey].map((task) => task.path),
			usesVirtualScrolling: false,
		})),
	};
}

describe("KanbanView flat incremental DOM reconciliation", () => {
	it("moves an unchanged card between existing columns without recreating the wrapper", () => {
		const view = makeView();
		const containers = createBoard(view, ["todo", "done"]);
		const task = createTask("tasks/a.md", { status: "done" });
		const state = createFlatState({ todo: [], done: [task] });
		const wrapper = createWrapper(task.path);
		containers.todo.appendChild(wrapper);
		(view as any).currentTaskElements.set(task.path, wrapper);
		(view as any).lastTaskSignatures.set(
			task.path,
			(view as any).buildTaskRenderSignature(task, state)
		);
		(view as any).createRenderedTaskWrapper = jest.fn(createWrapper);

		const result = (view as any).applyFlatIncrementalUpdate(state);

		expect(result).toBe(true);
		expect((view as any).createRenderedTaskWrapper).not.toHaveBeenCalled();
		expect(containers.todo.querySelector(`[data-task-path="${task.path}"]`)).toBeNull();
		expect(containers.done.querySelector(`[data-task-path="${task.path}"]`)).toBe(wrapper);
		expect((view as any).currentTaskElements.get(task.path)).toBe(wrapper);
	});

	it("replaces only cards whose render signature changed", () => {
		const view = makeView();
		const containers = createBoard(view, ["todo"]);
		const oldTaskA = createTask("tasks/a.md", { title: "old" });
		const nextTaskA = createTask("tasks/a.md", { title: "new" });
		const taskB = createTask("tasks/b.md");
		const oldState = createFlatState({ todo: [oldTaskA, taskB] });
		const nextState = createFlatState({ todo: [nextTaskA, taskB] });
		const wrapperA = createWrapper(oldTaskA.path);
		const wrapperB = createWrapper(taskB.path);
		containers.todo.append(wrapperA, wrapperB);
		(view as any).currentTaskElements.set(oldTaskA.path, wrapperA);
		(view as any).currentTaskElements.set(taskB.path, wrapperB);
		(view as any).lastTaskSignatures.set(
			oldTaskA.path,
			(view as any).buildTaskRenderSignature(oldTaskA, oldState)
		);
		(view as any).lastTaskSignatures.set(
			taskB.path,
			(view as any).buildTaskRenderSignature(taskB, oldState)
		);
		const replacementA = createWrapper(nextTaskA.path);
		(view as any).createRenderedTaskWrapper = jest.fn(() => replacementA);

		const result = (view as any).applyFlatIncrementalUpdate(nextState);

		expect(result).toBe(true);
		expect((view as any).createRenderedTaskWrapper).toHaveBeenCalledTimes(1);
		expect((view as any).createRenderedTaskWrapper).toHaveBeenCalledWith(nextTaskA);
		expect(containers.todo.children[0]).toBe(replacementA);
		expect(containers.todo.children[1]).toBe(wrapperB);
		expect((view as any).currentTaskElements.get(nextTaskA.path)).toBe(replacementA);
		expect((view as any).currentTaskElements.get(taskB.path)).toBe(wrapperB);
	});

	it("reports no card replacements for a no-op data refresh", () => {
		const view = makeView();
		const containers = createBoard(view, ["todo"]);
		const taskA = createTask("tasks/a.md");
		const taskB = createTask("tasks/b.md");
		const state = createFlatState({ todo: [taskA, taskB] });
		const wrapperA = createWrapper(taskA.path);
		const wrapperB = createWrapper(taskB.path);
		containers.todo.append(wrapperA, wrapperB);
		(view as any).currentTaskElements.set(taskA.path, wrapperA);
		(view as any).currentTaskElements.set(taskB.path, wrapperB);
		(view as any).lastTaskSignatures.set(
			taskA.path,
			(view as any).buildTaskRenderSignature(taskA, state)
		);
		(view as any).lastTaskSignatures.set(
			taskB.path,
			(view as any).buildTaskRenderSignature(taskB, state)
		);
		const stats = (view as any).createIncrementalDebugStats();
		(view as any).createRenderedTaskWrapper = jest.fn(createWrapper);

		const result = (view as any).applyFlatIncrementalUpdate(state, stats);

		expect(result).toBe(true);
		expect(stats).toEqual({
			removedCards: 0,
			reusedCards: 2,
			replacedCards: 0,
			virtualScrollerUpdates: 0,
		});
		expect((view as any).createRenderedTaskWrapper).not.toHaveBeenCalled();
		expect(containers.todo.children[0]).toBe(wrapperA);
		expect(containers.todo.children[1]).toBe(wrapperB);
	});

	it("reports exactly one replacement for a one-card metadata/content change", () => {
		const view = makeView();
		const containers = createBoard(view, ["todo"]);
		const oldTaskA = createTask("tasks/a.md", { customProperties: { hermes_content_hash: "old" } });
		const nextTaskA = createTask("tasks/a.md", { customProperties: { hermes_content_hash: "new" } });
		const taskB = createTask("tasks/b.md");
		const oldState = createFlatState({ todo: [oldTaskA, taskB] });
		const nextState = createFlatState({ todo: [nextTaskA, taskB] });
		const wrapperA = createWrapper(oldTaskA.path);
		const wrapperB = createWrapper(taskB.path);
		const replacementA = createWrapper(nextTaskA.path);
		containers.todo.append(wrapperA, wrapperB);
		(view as any).currentTaskElements.set(oldTaskA.path, wrapperA);
		(view as any).currentTaskElements.set(taskB.path, wrapperB);
		(view as any).lastTaskSignatures.set(
			oldTaskA.path,
			(view as any).buildTaskRenderSignature(oldTaskA, oldState)
		);
		(view as any).lastTaskSignatures.set(
			taskB.path,
			(view as any).buildTaskRenderSignature(taskB, oldState)
		);
		const stats = (view as any).createIncrementalDebugStats();
		(view as any).createRenderedTaskWrapper = jest.fn(() => replacementA);

		const result = (view as any).applyFlatIncrementalUpdate(nextState, stats);

		expect(result).toBe(true);
		expect(stats).toEqual({
			removedCards: 0,
			reusedCards: 1,
			replacedCards: 1,
			virtualScrollerUpdates: 0,
		});
		expect((view as any).createRenderedTaskWrapper).toHaveBeenCalledTimes(1);
		expect(containers.todo.children[0]).toBe(replacementA);
		expect(containers.todo.children[1]).toBe(wrapperB);
	});
});
