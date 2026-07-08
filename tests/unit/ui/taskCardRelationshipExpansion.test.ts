import { TFile } from "obsidian";
import type TaskNotesPlugin from "../../../src/main";
import type { TaskInfo } from "../../../src/types";
import {
	cleanupTaskCardExpansions,
	refreshParentTaskSubtasksExpansion,
	toggleBlockedByTasksExpansion,
	toggleBlockingTasksExpansion,
	toggleSubtasksExpansion,
	type TaskCardRelationshipExpansionContext,
} from "../../../src/ui/taskCardRelationshipExpansion";

function createTask(path: string, title = path): TaskInfo {
	return {
		title,
		status: "open",
		priority: "normal",
		path,
		archived: false,
	};
}

function createCard(path: string): HTMLElement {
	const card = document.createElement("div");
	card.className = "task-card";
	card.dataset.taskPath = path;
	(card as HTMLElement & { _taskPath?: string })._taskPath = path;
	return card;
}

function createRenderedCard(task: TaskInfo): HTMLElement {
	const card = createCard(task.path);
	card.textContent = task.title;
	return card;
}

function createPlugin(): TaskNotesPlugin {
	return {
		settings: {},
		app: {
			vault: {
				getAbstractFileByPath: jest.fn((path: string) => new TFile(path)),
			},
			metadataCache: {
				getFirstLinkpathDest: jest.fn(() => null),
			},
		},
		i18n: {
			translate: jest.fn((key: string) => {
				const translations: Record<string, string> = {
					"contextMenus.task.subtasks.loading": "Loading subtasks...",
					"contextMenus.task.subtasks.noSubtasks": "No subtasks found",
					"contextMenus.task.subtasks.loadFailed": "Failed to load subtasks",
					"ui.taskCard.loadingDependencies": "Loading dependencies...",
					"ui.taskCard.blockingEmpty": "No blocked tasks",
					"ui.taskCard.blockingLoadError": "Failed to load dependencies",
					"ui.taskCard.blockedBadge": "Blocked",
				};
				return translations[key] ?? key;
			}),
		},
		projectSubtasksService: {
			getTasksLinkedToProject: jest.fn(),
			sortTasks: jest.fn((tasks: TaskInfo[]) =>
				[...tasks].sort((a, b) => a.title.localeCompare(b.title))
			),
		},
		cacheManager: {
			getTaskInfo: jest.fn(),
			getTaskInfoFromFrontmatter: jest.fn(),
		},
	} as unknown as TaskNotesPlugin;
}

function createContext(
	plugin: TaskNotesPlugin,
	options = {},
	renderTaskCard = jest.fn(createRenderedCard)
): TaskCardRelationshipExpansionContext {
	return {
		plugin,
		getRelationshipOptions: jest.fn(() => options),
		renderTaskCard,
	};
}

describe("taskCardRelationshipExpansion", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		jest.clearAllMocks();
	});

	it("renders filtered and ordered subtasks while skipping circular project chains", async () => {
		const plugin = createPlugin();
		const parent = createTask("Tasks/parent.md", "Parent");
		const alpha = createTask("Tasks/alpha.md", "Alpha");
		const beta = createTask("Tasks/beta.md", "Beta");
		(plugin.projectSubtasksService.getTasksLinkedToProject as jest.Mock).mockResolvedValue([
			parent,
			alpha,
			beta,
		]);
		const relationshipOptions = {
			expandedRelationshipTaskOrder: new Map([[beta.path, 0]]),
		};
		const renderTaskCard = jest.fn(createRenderedCard);
		const card = createCard(parent.path);

		await toggleSubtasksExpansion(
			createContext(plugin, relationshipOptions, renderTaskCard),
			card,
			parent,
			true
		);

		const rendered = Array.from(
			card.querySelectorAll<HTMLElement>(".task-card__subtasks > .task-card")
		);
		expect(rendered.map((subtaskCard) => subtaskCard.dataset.taskPath)).toEqual([
			beta.path,
			alpha.path,
		]);
		expect(rendered.every((subtaskCard) => subtaskCard.classList.contains("task-card--subtask"))).toBe(
			true
		);
		expect(renderTaskCard).toHaveBeenCalledWith(beta, relationshipOptions);
		expect(plugin.projectSubtasksService.sortTasks).toHaveBeenCalledWith([parent, alpha]);
	});

	it("renders blocking dependencies through the injected card renderer and removes them on collapse", async () => {
		const plugin = createPlugin();
		const dependent = createTask("Tasks/dependent.md", "Dependent");
		const hidden = createTask("Tasks/hidden.md", "Hidden");
		(plugin.cacheManager.getTaskInfo as jest.Mock).mockImplementation(async (path: string) => {
			if (path === dependent.path) return dependent;
			if (path === hidden.path) return hidden;
			return null;
		});
		const task = createTask("Tasks/blocker.md", "Blocker");
		task.blocking = [dependent.path, hidden.path];
		const card = createCard(task.path);
		card.classList.add("task-card--nested-interactive-hover");
		const parentDblClick = jest.fn();
		card.addEventListener("dblclick", parentDblClick);

		await toggleBlockingTasksExpansion(
			createContext(plugin, {
				expandedRelationshipTaskPaths: new Set([dependent.path]),
			}),
			card,
			task,
			true
		);

		const container = card.querySelector<HTMLElement>(".task-card__blocking");
		expect(container).not.toBeNull();
		expect(
			Array.from(container?.querySelectorAll<HTMLElement>(":scope > .task-card") ?? []).map(
				(dependencyCard) => dependencyCard.dataset.taskPath
			)
		).toEqual([dependent.path]);

		container?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		expect(parentDblClick).not.toHaveBeenCalled();

		await toggleBlockingTasksExpansion(createContext(plugin), card, task, false);
		expect(card.querySelector(".task-card__blocking")).toBeNull();
		expect(card.classList.contains("task-card--nested-interactive-hover")).toBe(false);
	});

	it("renders blocking dependencies from note frontmatter before falling back to pending cache data", async () => {
		const plugin = createPlugin();
		const freshDependent = createTask("Tasks/dependent.md", "Fresh frontmatter dependent");
		const staleDependent = createTask("Tasks/dependent.md", "Stale pending dependent");
		(plugin.cacheManager.getTaskInfoFromFrontmatter as jest.Mock).mockResolvedValue(
			freshDependent
		);
		(plugin.cacheManager.getTaskInfo as jest.Mock).mockResolvedValue(staleDependent);
		const task = createTask("Tasks/blocker.md", "Blocker");
		task.blocking = [freshDependent.path];
		const card = createCard(task.path);

		await toggleBlockingTasksExpansion(createContext(plugin), card, task, true);

		const rendered = card.querySelector<HTMLElement>(
			".task-card__blocking > .task-card"
		);
		expect(rendered?.textContent).toBe("Fresh frontmatter dependent");
		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			freshDependent.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
	});

	it("renders blocked-by dependencies from normalized dependency entries", async () => {
		const plugin = createPlugin();
		const blocker = createTask("Tasks/blocker.md", "Blocking prerequisite");
		(plugin.cacheManager.getTaskInfo as jest.Mock).mockImplementation(async (path: string) =>
			path === blocker.path ? blocker : null
		);
		const task = createTask("Tasks/blocked.md", "Blocked");
		task.blockedBy = [{ uid: "Tasks/blocker.md", reltype: "FINISHTOSTART" }];
		const card = createCard(task.path);

		await toggleBlockedByTasksExpansion(createContext(plugin), card, task, true);

		const rendered = Array.from(
			card.querySelectorAll<HTMLElement>(".task-card__blocked-by > .task-card")
		);
		expect(rendered.map((blockerCard) => blockerCard.dataset.taskPath)).toEqual([blocker.path]);
		expect(rendered[0]?.classList.contains("task-card--dependency")).toBe(true);
	});

	it("renders blocked-by dependencies from note frontmatter before pending cache data", async () => {
		const plugin = createPlugin();
		const freshBlocker = createTask("Tasks/blocker.md", "Fresh frontmatter blocker");
		const staleBlocker = createTask("Tasks/blocker.md", "Stale pending blocker");
		(plugin.cacheManager.getTaskInfoFromFrontmatter as jest.Mock).mockResolvedValue(
			freshBlocker
		);
		(plugin.cacheManager.getTaskInfo as jest.Mock).mockResolvedValue(staleBlocker);
		const task = createTask("Tasks/blocked.md", "Blocked");
		task.blockedBy = [{ uid: "Tasks/blocker.md", reltype: "FINISHTOSTART" }];
		const card = createCard(task.path);

		await toggleBlockedByTasksExpansion(createContext(plugin), card, task, true);

		const rendered = card.querySelector<HTMLElement>(
			".task-card__blocked-by > .task-card"
		);
		expect(rendered?.textContent).toBe("Fresh frontmatter blocker");
		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			freshBlocker.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
	});

	it("refreshes expanded parent subtasks from note frontmatter before pending cache data", async () => {
		const plugin = createPlugin();
		const updatedTask = createTask("Tasks/child.md", "Updated child");
		updatedTask.dateModified = "2026-06-04T10:00:00Z";
		updatedTask.projects = ["project"];
		const parentTask = createTask("Tasks/project.md", "Fresh frontmatter parent");
		const staleParentTask = createTask("Tasks/project.md", "Stale pending parent");
		(plugin.cacheManager.getTaskInfoFromFrontmatter as jest.Mock).mockImplementation(
			async (path: string) => {
				if (path === updatedTask.path) return updatedTask;
				if (path === parentTask.path) return parentTask;
				return null;
			}
		);
		(plugin.cacheManager.getTaskInfo as jest.Mock).mockResolvedValue(staleParentTask);
		(plugin.projectSubtasksService.getTasksLinkedToProject as jest.Mock).mockResolvedValue([
			updatedTask,
		]);
		const renderTaskCard = jest.fn(createRenderedCard);
		const root = document.createElement("div");
		const parentCard = createCard(parentTask.path);
		parentCard.createDiv({ cls: "task-card__chevron task-card__chevron--expanded" });
		parentCard.createDiv({ cls: "task-card__subtasks" });
		root.append(parentCard);

		await refreshParentTaskSubtasksExpansion(
			createContext(plugin, {}, renderTaskCard),
			updatedTask,
			root
		);

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			updatedTask.path
		);
		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			parentTask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(plugin.projectSubtasksService.getTasksLinkedToProject).toHaveBeenCalledWith(
			expect.objectContaining({ path: parentTask.path })
		);
		expect(renderTaskCard).toHaveBeenCalledWith(updatedTask, {});
	});

	it("cleans up stored relationship containers", async () => {
		const plugin = createPlugin();
		const child = createTask("Tasks/child.md", "Child");
		(plugin.projectSubtasksService.getTasksLinkedToProject as jest.Mock).mockResolvedValue([
			child,
		]);
		const task = createTask("Tasks/parent.md", "Parent");
		const card = createCard(task.path);

		await toggleSubtasksExpansion(createContext(plugin), card, task, true);

		expect(card.querySelector(".task-card__subtasks")).not.toBeNull();
		cleanupTaskCardExpansions(card);
		expect(card.querySelector(".task-card__subtasks")).toBeNull();
	});
});
