import { TFile } from "obsidian";
import { createTaskNotesCommandDefinitions } from "../../../src/commands/taskNotesCommands";
import {
	addTaskToProject,
	assignTaskAsSubtask,
} from "../../../src/services/taskRelationshipActions";
import { EVENT_USER_NOTICE } from "../../../src/core/userNotices";
import type { TaskInfo } from "../../../src/types";

jest.mock("obsidian");

function makePlugin(
	options: {
		frontmatterTasks?: Record<string, TaskInfo | null>;
		cachedTasks?: Record<string, TaskInfo | null>;
	} = {}
) {
	return {
		app: {
			metadataCache: {
				fileToLinktext: (file: TFile) => file.path.replace(/\.md$/i, ""),
			},
		},
		settings: {
			useFrontmatterMarkdownLinks: false,
		},
		i18n: {
			translate: (key: string, params?: Record<string, string | number>) =>
				params ? `${key}:${Object.values(params).join(",")}` : key,
		},
		emitter: {
			trigger: jest.fn(),
		},
		cacheManager: {
			getTaskInfoFromFrontmatter: jest.fn(
				async (path: string) => options.frontmatterTasks?.[path] ?? null
			),
			getTaskInfo: jest.fn(async (path: string) => options.cachedTasks?.[path] ?? null),
		},
		updateTaskProperty: jest.fn(
			async (task: TaskInfo, property: keyof TaskInfo, value: unknown) => ({
				...task,
				[property]: value,
			})
		),
	};
}

describe("Issue #1835: current note relationship commands", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("registers hotkeyable commands for current-note project and subtask actions", async () => {
		const definitions = createTaskNotesCommandDefinitions({} as any);
		const addProject = definitions.find(
			(definition) => definition.id === "add-project-to-current-task"
		);
		const addSubtask = definitions.find(
			(definition) => definition.id === "add-subtask-to-current-note"
		);
		const ctx = {
			addProjectToCurrentTask: jest.fn(),
			addSubtaskToCurrentNote: jest.fn(),
		};

		expect(addProject?.nameKey).toBe("commands.addProjectToCurrentTask");
		expect(addSubtask?.nameKey).toBe("commands.addSubtaskToCurrentNote");

		await addProject?.callback?.(ctx as any);
		await addSubtask?.callback?.(ctx as any);

		expect(ctx.addProjectToCurrentTask).toHaveBeenCalledTimes(1);
		expect(ctx.addSubtaskToCurrentNote).toHaveBeenCalledTimes(1);
	});

	it("adds a selected project to a task using the same relationship update path", async () => {
		const plugin = makePlugin();
		const task = {
			title: "Task",
			path: "Tasks/task.md",
			projects: [],
		} as TaskInfo;
		const projectFile = new TFile("Projects/Alpha.md");

		const updatedTask = await addTaskToProject(plugin as any, task, projectFile);

		expect(plugin.updateTaskProperty).toHaveBeenCalledWith(task, "projects", [
			"[[Projects/Alpha]]",
		]);
		expect(updatedTask?.projects).toEqual(["[[Projects/Alpha]]"]);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(
			EVENT_USER_NOTICE,
			expect.objectContaining({
				message: "contextMenus.task.organization.notices.addedToProject:Alpha",
			})
		);
	});

	it("adds a project from fresh frontmatter instead of stale task arguments", async () => {
		const staleTask = {
			title: "Task",
			path: "Tasks/task.md",
			projects: ["[[Stale Project]]"],
		} as TaskInfo;
		const frontmatterTask = {
			...staleTask,
			projects: ["[[Fresh Project]]"],
		} as TaskInfo;
		const plugin = makePlugin({
			frontmatterTasks: {
				[staleTask.path]: frontmatterTask,
			},
		});
		const projectFile = new TFile("Projects/Alpha.md");

		const updatedTask = await addTaskToProject(plugin as any, staleTask, projectFile);

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(staleTask.path);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(plugin.updateTaskProperty).toHaveBeenCalledWith(frontmatterTask, "projects", [
			"[[Fresh Project]]",
			"[[Projects/Alpha]]",
		]);
		expect(updatedTask?.projects).toEqual(["[[Fresh Project]]", "[[Projects/Alpha]]"]);
	});

	it("adds the current note as the selected task's project when assigning a subtask", async () => {
		const plugin = makePlugin();
		const parentFile = new TFile("Projects/Alpha.md");
		const subtask = {
			title: "Subtask",
			path: "Tasks/subtask.md",
			projects: [],
		} as TaskInfo;

		const updatedTask = await assignTaskAsSubtask(plugin as any, parentFile, subtask);

		expect(plugin.updateTaskProperty).toHaveBeenCalledWith(subtask, "projects", [
			"[[Projects/Alpha]]",
		]);
		expect(updatedTask?.projects).toEqual(["[[Projects/Alpha]]"]);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(
			EVENT_USER_NOTICE,
			expect.objectContaining({
				message: "contextMenus.task.organization.notices.addedAsSubtask:Subtask,Alpha",
			})
		);
	});

	it("assigns a subtask from fresh frontmatter instead of stale task arguments", async () => {
		const parentFile = new TFile("Projects/Alpha.md");
		const staleSubtask = {
			title: "Stale Subtask",
			path: "Tasks/subtask.md",
			projects: ["[[Stale Parent]]"],
		} as TaskInfo;
		const frontmatterSubtask = {
			...staleSubtask,
			title: "Fresh Subtask",
			projects: ["[[Fresh Parent]]"],
		} as TaskInfo;
		const plugin = makePlugin({
			frontmatterTasks: {
				[staleSubtask.path]: frontmatterSubtask,
			},
		});

		const updatedTask = await assignTaskAsSubtask(plugin as any, parentFile, staleSubtask);

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			staleSubtask.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(plugin.updateTaskProperty).toHaveBeenCalledWith(frontmatterSubtask, "projects", [
			"[[Fresh Parent]]",
			"[[Projects/Alpha]]",
		]);
		expect(updatedTask?.projects).toEqual(["[[Fresh Parent]]", "[[Projects/Alpha]]"]);
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(
			EVENT_USER_NOTICE,
			expect.objectContaining({
				message:
					"contextMenus.task.organization.notices.addedAsSubtask:Fresh Subtask,Alpha",
			})
		);
	});

	it("does not rewrite a task that is already linked to the selected project", async () => {
		const plugin = makePlugin();
		const task = {
			title: "Task",
			path: "Tasks/task.md",
			projects: ["[[Alpha]]"],
		} as TaskInfo;
		const projectFile = new TFile("Projects/Alpha.md");

		const updatedTask = await addTaskToProject(plugin as any, task, projectFile);

		expect(updatedTask).toBeNull();
		expect(plugin.updateTaskProperty).not.toHaveBeenCalled();
		expect(plugin.emitter.trigger).toHaveBeenCalledWith(
			EVENT_USER_NOTICE,
			expect.objectContaining({
				message: "contextMenus.task.organization.notices.alreadyInProject",
			})
		);
	});
});
