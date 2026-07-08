import {
	applyTaskArchiveFrontmatterChange,
	buildTaskArchiveMovePlan,
	buildTaskArchiveState,
} from "../../../src/services/task-service/taskArchivePlanning";
import type { TaskInfo } from "../../../src/types";

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Archive me",
		status: "open",
		priority: "normal",
		path: "TaskNotes/Archive me.md",
		archived: false,
		tags: ["task"],
		...overrides,
	} as TaskInfo;
}

describe("taskArchivePlanning", () => {
	it("toggles native archived state without changing tags when archiving", () => {
		const plan = buildTaskArchiveState(
			createTask({ archived: false, tags: ["task"] }),
			"archived",
			"2026-05-19T06:45:00+10:00"
		);

		expect(plan.isCurrentlyArchived).toBe(false);
		expect(plan.operation).toBe("archiving");
		expect(plan.updatedTask).toEqual(
			expect.objectContaining({
				archived: true,
				tags: ["task"],
				dateModified: "2026-05-19T06:45:00+10:00",
			})
		);
	});

	it("toggles native archived state without removing tags when unarchiving", () => {
		const plan = buildTaskArchiveState(
			createTask({ archived: true, tags: ["task", "archived"] }),
			"archived",
			"2026-05-19T06:45:00+10:00"
		);

		expect(plan.isCurrentlyArchived).toBe(true);
		expect(plan.operation).toBe("unarchiving");
		expect(plan.updatedTask.archived).toBe(false);
		expect(plan.updatedTask.tags).toEqual(["task", "archived"]);
	});

	it("uses hermesArchived instead of native archived state for Hermes-managed tasks", () => {
		const plan = buildTaskArchiveState(
			createTask({
				archived: false,
				tags: ["task"],
				customProperties: {
					hermesTaskId: "t_1234abcd",
					hermesBoard: "default",
					hermesArchived: false,
					hermesList: "done",
					hermesVisible: true,
				},
			}),
			"archived",
			"2026-05-19T06:45:00+10:00"
		);

		expect(plan.stateSource).toBe("hermes-archived");
		expect(plan.updatedTask).toEqual(
			expect.objectContaining({
				archived: true,
				tags: ["task"],
				dateModified: "2026-05-19T06:45:00+10:00",
			})
		);
		expect(plan.updatedTask.customProperties).toMatchObject({
			hermesArchived: true,
			hermesList: "archived",
			hermesVisible: false,
		});
	});

	it("lets hermesArchived false override native archived state when archive state is read", () => {
		const plan = buildTaskArchiveState(
			createTask({
				archived: true,
				status: "done",
				tags: ["task", "archived"],
				customProperties: {
					hermesTaskId: "t_1234abcd",
					hermesBoard: "default",
					hermesArchived: false,
				},
			}),
			"archived",
			"2026-05-19T06:45:00+10:00"
		);

		expect(plan.isCurrentlyArchived).toBe(false);
		expect(plan.operation).toBe("archiving");
		expect(plan.updatedTask.tags).toEqual(["task", "archived"]);
		expect(plan.updatedTask.customProperties?.hermesArchived).toBe(true);
	});

	it("updates native archived frontmatter and dateModified for archive changes", () => {
		const frontmatter: Record<string, unknown> = {
			tags: "task",
		};

		applyTaskArchiveFrontmatterChange({
			frontmatter,
			archiveTag: "archived",
			isCurrentlyArchived: false,
			dateModified: "2026-05-19T06:45:00+10:00",
			dateModifiedField: "dateModified",
		});

		expect(frontmatter.tags).toBe("task");
		expect(frontmatter.archived).toBe(true);
		expect(frontmatter.dateModified).toBe("2026-05-19T06:45:00+10:00");
	});

	it("sets native archived frontmatter false when unarchiving", () => {
		const frontmatter: Record<string, unknown> = {
			tags: ["archived"],
		};

		applyTaskArchiveFrontmatterChange({
			frontmatter,
			archiveTag: "archived",
			isCurrentlyArchived: true,
			dateModified: "2026-05-19T06:45:00+10:00",
			dateModifiedField: "dateModified",
		});

		expect(frontmatter.tags).toEqual(["archived"]);
		expect(frontmatter.archived).toBe(false);
		expect(frontmatter.dateModified).toBe("2026-05-19T06:45:00+10:00");
	});

	it("updates Hermes archived frontmatter without touching tags", () => {
		const frontmatter: Record<string, unknown> = {
			tags: "task",
			status: "done",
			hermesTaskId: "t_1234abcd",
			hermesBoard: "default",
			hermesArchived: false,
			hermesList: "done",
			hermesVisible: true,
		};

		applyTaskArchiveFrontmatterChange({
			frontmatter,
			archiveTag: "archived",
			isCurrentlyArchived: false,
			dateModified: "2026-05-19T06:45:00+10:00",
			dateModifiedField: "dateModified",
			stateSource: "hermes-archived",
			hermesListOnUnarchive: "done",
		});

		expect(frontmatter.tags).toBe("task");
		expect(frontmatter.hermesArchived).toBe(true);
		expect(frontmatter.hermesList).toBe("archived");
		expect(frontmatter.hermesVisible).toBe(false);
		expect(frontmatter.dateModified).toBe("2026-05-19T06:45:00+10:00");
	});

	it("restores Hermes list visibility when unarchiving through Hermes metadata", () => {
		const frontmatter: Record<string, unknown> = {
			tags: ["task", "archived"],
			hermesTaskId: "t_1234abcd",
			hermesBoard: "default",
			hermesArchived: true,
			hermesList: "archived",
			hermesVisible: false,
		};

		applyTaskArchiveFrontmatterChange({
			frontmatter,
			archiveTag: "archived",
			isCurrentlyArchived: true,
			dateModified: "2026-05-19T06:45:00+10:00",
			dateModifiedField: "dateModified",
			stateSource: "hermes-archived",
			hermesListOnUnarchive: "blocked",
		});

		expect(frontmatter.tags).toEqual(["task", "archived"]);
		expect(frontmatter.hermesArchived).toBe(false);
		expect(frontmatter.hermesList).toBe("blocked");
		expect(frontmatter.hermesVisible).toBe(true);
	});

	it("builds archive and unarchive move plans from resolved folder templates", () => {
		const processFolderTemplate = jest.fn((template: string) => `${template}/resolved`);

		expect(
			buildTaskArchiveMovePlan({
				isCurrentlyArchived: false,
				moveArchivedTasks: true,
				archiveFolderTemplate: "Archive/{{year}}",
				tasksFolderTemplate: "Tasks",
				fileName: "Archive me.md",
				taskData: { title: "Archive me", status: "open" },
				processFolderTemplate,
			})
		).toEqual({
			operation: "archiving",
			destinationKind: "archive",
			destinationFolder: "Archive/{{year}}/resolved",
			newPath: "Archive/{{year}}/resolved/Archive me.md",
		});

		expect(
			buildTaskArchiveMovePlan({
				isCurrentlyArchived: true,
				moveArchivedTasks: true,
				archiveFolderTemplate: "Archive",
				tasksFolderTemplate: "Tasks/{{project}}",
				fileName: "Archive me.md",
				taskData: { title: "Archive me", projects: ["Project"] },
				processFolderTemplate,
			})
		).toEqual({
			operation: "unarchiving",
			destinationKind: "tasks",
			destinationFolder: "Tasks/{{project}}/resolved",
			newPath: "Tasks/{{project}}/resolved/Archive me.md",
		});
	});

	it("does not build move plans when moving is disabled or the relevant folder is blank", () => {
		const processFolderTemplate = jest.fn();

		expect(
			buildTaskArchiveMovePlan({
				isCurrentlyArchived: false,
				moveArchivedTasks: false,
				archiveFolderTemplate: "Archive",
				fileName: "Archive me.md",
				taskData: {},
				processFolderTemplate,
			})
		).toBeNull();

		expect(
			buildTaskArchiveMovePlan({
				isCurrentlyArchived: true,
				moveArchivedTasks: true,
				archiveFolderTemplate: "Archive",
				tasksFolderTemplate: " ",
				fileName: "Archive me.md",
				taskData: {},
				processFolderTemplate,
			})
		).toBeNull();
	});
});
