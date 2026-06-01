import { FieldMapper } from "../../../src/services/FieldMapper";
import { DEFAULT_FIELD_MAPPING, DEFAULT_SETTINGS } from "../../../src/settings/defaults";
import { DependencyCache } from "../../../src/utils/DependencyCache";
import { TaskManager } from "../../../src/utils/TaskManager";
import { MockObsidian } from "../../__mocks__/obsidian";

jest.mock("obsidian");

describe("Issue #1878: completed blockers should not appear as active blockers", () => {
	beforeEach(() => {
		MockObsidian.reset();
	});

	it("does not report dependent tasks as actively blocked by a completed task", async () => {
		const app = MockObsidian.createMockApp();
		MockObsidian.createTestFile(
			"Tasks/blocker.md",
			"---\ntitle: Blocker\nstatus: done\ntags:\n  - task\n---\n"
		);
		MockObsidian.createTestFile(
			"Tasks/dependent.md",
			"---\ntitle: Dependent\nstatus: open\ntags:\n  - task\nblockedBy:\n  - uid: '[[blocker]]'\n    reltype: FINISHTOSTART\n---\n"
		);

		const blockerFile = app.vault.getAbstractFileByPath("Tasks/blocker.md");
		const dependentFile = app.vault.getAbstractFileByPath("Tasks/dependent.md");
		app.metadataCache.setCache("Tasks/blocker.md", {
			frontmatter: { title: "Blocker", status: "done", tags: ["task"] },
		});
		app.metadataCache.setCache("Tasks/dependent.md", {
			frontmatter: {
				title: "Dependent",
				status: "open",
				tags: ["task"],
				blockedBy: [{ uid: "[[blocker]]", reltype: "FINISHTOSTART" }],
			},
		});
		app.metadataCache.getFirstLinkpathDest = jest.fn((linkpath: string) => {
			if (linkpath === "blocker") return blockerFile;
			if (linkpath === "dependent") return dependentFile;
			return null;
		});

		const dependencyCache = new DependencyCache(
			app,
			{} as never,
			new FieldMapper(DEFAULT_FIELD_MAPPING),
			{ isCompletedStatus: jest.fn((status: string) => status === "done") } as never,
			(frontmatter) => Array.isArray((frontmatter as { tags?: unknown }).tags)
		);

		await dependencyCache.buildIndexes();

		expect(dependencyCache.isTaskBlocked("Tasks/dependent.md")).toBe(false);
		expect(dependencyCache.getBlockedTaskPaths("Tasks/blocker.md")).toEqual([]);
	});

	it("keeps completed Hermes mirror blocking relationships visible for faded related cards", async () => {
		const app = MockObsidian.createMockApp();
		MockObsidian.createTestFile(
			"TaskNotes/Hermes/default/t_done.md",
			"---\ntitle: Done Hermes blocker\nstatus: done\ntags:\n  - task\n  - hermes-kanban\n---\n"
		);
		MockObsidian.createTestFile(
			"TaskNotes/Hermes/default/t_child.md",
			"---\ntitle: Done Hermes child\nstatus: done\ntags:\n  - task\n  - hermes-kanban\nblockedBy:\n  - uid: '[[TaskNotes/Hermes/default/t_done|Done Hermes blocker]]'\n    reltype: FINISHTOSTART\n---\n"
		);

		const blockerFile = app.vault.getAbstractFileByPath("TaskNotes/Hermes/default/t_done.md");
		const childFile = app.vault.getAbstractFileByPath("TaskNotes/Hermes/default/t_child.md");
		app.metadataCache.setCache("TaskNotes/Hermes/default/t_done.md", {
			frontmatter: {
				title: "Done Hermes blocker",
				status: "done",
				tags: ["task", "hermes-kanban"],
			},
		});
		app.metadataCache.setCache("TaskNotes/Hermes/default/t_child.md", {
			frontmatter: {
				title: "Done Hermes child",
				status: "done",
				tags: ["task", "hermes-kanban"],
				blockedBy: [
					{
						uid: "[[TaskNotes/Hermes/default/t_done|Done Hermes blocker]]",
						reltype: "FINISHTOSTART",
					},
				],
			},
		});
		app.metadataCache.getFirstLinkpathDest = jest.fn((linkpath: string) => {
			if (linkpath === "TaskNotes/Hermes/default/t_done") return blockerFile;
			if (linkpath === "TaskNotes/Hermes/default/t_child") return childFile;
			return null;
		});

		const fieldMapper = new FieldMapper(DEFAULT_FIELD_MAPPING);
		const dependencyCache = new DependencyCache(
			app,
			{
				...DEFAULT_SETTINGS,
				taskIdentificationMethod: "tag",
				taskTag: "task",
			},
			fieldMapper,
			{ isCompletedStatus: jest.fn((status: string) => status === "done") } as never,
			(frontmatter) => Array.isArray((frontmatter as { tags?: unknown }).tags)
		);
		await dependencyCache.buildIndexes();

		const taskManager = new TaskManager(
			app,
			{
				...DEFAULT_SETTINGS,
				taskIdentificationMethod: "tag",
				taskTag: "task",
				storeTitleInFilename: false,
			},
			fieldMapper
		);
		taskManager.setDependencyCache(dependencyCache);

		expect(dependencyCache.getBlockedTaskPaths("TaskNotes/Hermes/default/t_done.md")).toEqual([]);

		await expect(taskManager.getTaskInfo("TaskNotes/Hermes/default/t_done.md")).resolves.toMatchObject({
			blocking: ["TaskNotes/Hermes/default/t_child.md"],
			isBlocking: true,
		});
	});
});
