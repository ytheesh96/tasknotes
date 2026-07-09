import { TFile } from "obsidian";
import type TaskNotesPlugin from "../../../src/main";
import { ProjectSubtasksService } from "../../../src/services/ProjectSubtasksService";
import type { TaskInfo } from "../../../src/types";

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Task",
		status: "open",
		priority: "normal",
		path: "TaskNotes/Child.md",
		archived: false,
		projects: ["[[Project]]"],
		...overrides,
	};
}

describe("ProjectSubtasksService", () => {
	it("hydrates expanded subtask rows from frontmatter before pending cache data", async () => {
		const projectFile = new TFile("TaskNotes/Project.md");
		const childFile = new TFile("TaskNotes/Child.md");
		const stalePendingTask = createTask({
			title: "Stale pending title",
			status: "open",
		});
		const freshFrontmatterTask = createTask({
			title: "Fresh frontmatter title",
			status: "done",
		});
		const getTaskInfoFromFrontmatter = jest.fn(async () => freshFrontmatterTask);
		const getTaskInfo = jest.fn(async () => stalePendingTask);
		const plugin = {
			app: {
				vault: {
					getAbstractFileByPath: jest.fn((path: string) =>
						path === childFile.path ? childFile : null
					),
				},
				metadataCache: {
					resolvedLinks: {
						[childFile.path]: {
							[projectFile.path]: 1,
						},
					},
					unresolvedLinks: {},
					getFileCache: jest.fn((file: TFile) =>
						file.path === childFile.path
							? {
									frontmatter: {
										projects: ["[[Project]]"],
									},
								}
							: null
					),
					getFirstLinkpathDest: jest.fn((linkPath: string, sourcePath: string) =>
						linkPath === "Project" && sourcePath === childFile.path ? projectFile : null
					),
				},
			},
			cacheManager: {
				getTaskInfo,
				getTaskInfoFromFrontmatter,
			},
			fieldMapper: {
				toUserField: jest.fn((field: string) => field),
			},
		} as unknown as TaskNotesPlugin;
		const service = new ProjectSubtasksService(plugin);

		await expect(service.getTasksLinkedToProject(projectFile)).resolves.toEqual([
			freshFrontmatterTask,
		]);
		expect(getTaskInfoFromFrontmatter).toHaveBeenCalledWith(childFile.path);
		expect(getTaskInfo).not.toHaveBeenCalled();
	});
});
