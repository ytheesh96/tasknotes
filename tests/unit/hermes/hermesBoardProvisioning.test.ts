import { App, MockObsidian, TFile } from "obsidian";
import {
	buildHermesBoardKanbanBase,
	getHermesBoardFolderPath,
	getHermesBoardKanbanViewPath,
	provisionHermesBoardSurfaces,
	summarizeHermesBoardProvisionResult,
} from "../../../src/hermes/hermesBoardProvisioning";
import { DEFAULT_FIELD_MAPPING, DEFAULT_SETTINGS } from "../../../src/settings/defaults";

describe("Hermes board surface provisioning", () => {
	beforeEach(() => {
		MockObsidian.reset();
	});

	it("creates a TaskNotes folder and board Kanban view for each synced board", async () => {
		const app = new App();

		const result = await provisionHermesBoardSurfaces(
			{
				app,
				settings: {
					fieldMapping: DEFAULT_FIELD_MAPPING,
					taskTag: DEFAULT_SETTINGS.taskTag,
				},
			},
			["default", "obsidian-os"]
		);

		expect(result.foldersCreated).toEqual(["TaskNotes/default", "TaskNotes/obsidian-os"]);
		expect(result.viewsCreated).toEqual([
			"TaskNotes/Views/kanban-board-default.base",
			"TaskNotes/Views/kanban-board-obsidian-os.base",
		]);
		expect(app.vault.getAbstractFileByPath("TaskNotes/default")).not.toBeNull();
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-board-default.base")).toBeInstanceOf(
			TFile
		);

		const view = app.vault.getAbstractFileByPath(
			"TaskNotes/Views/kanban-board-obsidian-os.base"
		) as TFile;
		await expect(app.vault.read(view)).resolves.toContain(
			'file.inFolder("TaskNotes/obsidian-os")'
		);
		await expect(app.vault.read(view)).resolves.toContain(
			'list(projects).contains("Hermes/obsidian-os")'
		);
	});

	it("does not overwrite existing board views", async () => {
		const app = new App();
		await app.vault.create("TaskNotes/Views/kanban-board-default.base", "custom view");

		const result = await provisionHermesBoardSurfaces({ app }, ["default"]);

		expect(result.viewsCreated).toEqual([]);
		expect(result.viewsSkipped).toEqual(["TaskNotes/Views/kanban-board-default.base"]);
		const existing = app.vault.getAbstractFileByPath(
			"TaskNotes/Views/kanban-board-default.base"
		) as TFile;
		await expect(app.vault.read(existing)).resolves.toBe("custom view");
	});

	it("builds a native TaskNotes board view with the Hermes status columns", () => {
		const content = buildHermesBoardKanbanBase("job-hunt", {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: "task",
		});

		expect(content).toContain("# Job Hunt Kanban");
		expect(content).toContain('file.hasTag("task")');
		expect(content).toContain('file.inFolder("TaskNotes/job-hunt")');
		expect(content).toContain('list(projects).contains("Hermes/job-hunt")');
		expect(content).toContain("pinnedColumns: triage,todo,ready,running,blocked,done");
		expect(content).not.toContain("hermes_board");
	});

	it("summarizes created and unchanged surfaces for settings notices", () => {
		expect(
			summarizeHermesBoardProvisionResult({
				foldersCreated: ["TaskNotes/default"],
				foldersSkipped: [],
				viewsCreated: ["TaskNotes/Views/kanban-default.base"],
				viewsSkipped: [],
				boardsSkipped: [],
			})
		).toBe("Created 1 folder(s) and 1 Kanban view(s).");

		expect(
			summarizeHermesBoardProvisionResult({
				foldersCreated: [],
				foldersSkipped: ["TaskNotes/default"],
				viewsCreated: [],
				viewsSkipped: ["TaskNotes/Views/kanban-default.base"],
				boardsSkipped: [],
			})
		).toBe("Board folders and views already exist.");
	});

	it("normalizes the expected board paths", () => {
		expect(getHermesBoardFolderPath("obsidian-os")).toBe("TaskNotes/obsidian-os");
		expect(getHermesBoardKanbanViewPath("obsidian-os")).toBe(
			"TaskNotes/Views/kanban-board-obsidian-os.base"
		);
	});
});
