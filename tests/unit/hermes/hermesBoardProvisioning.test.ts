import { App, MockObsidian, TFile } from "obsidian";
import {
	buildHermesBoardKanbanBase,
	buildHermesBoardKanbanBaseHeader,
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

	it("creates TaskNotes folders and shared Kanban base views for synced boards", async () => {
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

		expect(result.foldersCreated).toEqual(["TaskNotes/Tasks"]);
		expect(result.viewsCreated).toEqual(["TaskNotes/Views/kanban-default.base"]);
		expect(app.vault.getAbstractFileByPath("TaskNotes/Tasks")).not.toBeNull();
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base")).toBeInstanceOf(
			TFile
		);

		const view = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(view);
		expect(content).toContain('name: "Default"');
		expect(content).toContain('name: "Obsidian Os"');
		expect(content).toContain('hermesTaskId.isEmpty() == false');
		expect(content).toContain('hermesBoard == "obsidian-os"');
		expect(content).toContain("hermesArchived != true");
		expect(content).toContain('name: "Default Archive"');
		expect(content).toContain('hermesBoard == "default"');
		expect(content).toContain("hermesArchived == true");
		expect(content).not.toContain('file.inFolder("TaskNotes/Tasks")');
		expect(content).not.toContain('file.hasTag("task")');
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-board-default.base")).toBeNull();
	});

	it("preserves existing custom shared base content while adding missing board views", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Views/kanban-default.base",
			`# Custom Kanban

filters:
  and:
    - file.hasTag("task")

views:
  - type: tasknotesKanban
    name: "Custom"
`
		);

		const result = await provisionHermesBoardSurfaces({ app }, ["default"]);

		expect(result.viewsCreated).toEqual([]);
		expect(result.viewsUpdated).toEqual(["TaskNotes/Views/kanban-default.base"]);
		const existing = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(existing);
		expect(content).toContain('name: "Custom"');
		expect(content).toContain('name: "Default"');
		expect(content).toContain('hermesTaskId.isEmpty() == false');
		expect(content).toContain('hermesBoard == "default"');
		expect(content).toContain("hermesArchived != true");
		expect(content).toContain('name: "Default Archive"');
		expect(content).not.toContain('file.inFolder("TaskNotes/Tasks")');
	});

	it("preserves stock shared Kanban root filters and formulas while adding Hermes board views", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Views/kanban-default.base",
			`# Kanban Board

filters:
  and:
    - file.hasTag("task")
    - status != "completed"

formulas:
  task_url: file.path

properties:
  status:
    displayName: Status

views:
  - type: tasknotesKanban
    name: "Kanban Board"
    order:
      - status
    groupBy:
      property: status
      direction: ASC
`
		);

		const result = await provisionHermesBoardSurfaces({ app }, ["default"]);

		expect(result.viewsCreated).toEqual([]);
		expect(result.viewsUpdated).toEqual(["TaskNotes/Views/kanban-default.base"]);
		const existing = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(existing);
		expect(content).toContain('file.hasTag("task")');
		expect(content).toContain('status != "completed"');
		expect(content).toContain("formulas:\n  task_url: file.path");
		expect(content).toContain("properties:\n  status:\n    displayName: Status");
		expect(content).toContain("hermesRootRunId:\n    displayName: Hermes Root Run");
		expect(content).toContain("hermesRunTitle:\n    displayName: Hermes Run");
		expect(content).toContain('name: "Kanban Board"');
		expect(content).toContain('name: "Default"');
		expect(content).toContain('hermesBoard == "default"');
		expect(content).toContain('name: "Default Archive"');
	});

	it("adds Hermes run properties to legacy shared bases so Run is available in the swimlane picker", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Views/kanban-default.base",
			`filters:
  and:
    - file.inFolder("TaskNotes/Tasks")
formulas:
  priorityWeight: if(priority=="none",0,1)
properties:
  note.hermesAssignee:
    displayName: Assignee
views:
  - type: tasknotesKanban
    name: Kanban Board
    groupBy:
      property: status
      direction: ASC
`
		);

		const result = await provisionHermesBoardSurfaces({ app }, ["hermes-agent"]);

		expect(result.viewsCreated).toEqual([]);
		expect(result.viewsUpdated).toEqual(["TaskNotes/Views/kanban-default.base"]);
		const existing = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(existing);
		expect(content).toContain("note.hermesAssignee:\n    displayName: Assignee");
		expect(content).toContain("hermesRootRunId:\n    displayName: Hermes Root Run");
		expect(content).toContain("hermesRunTitle:\n    displayName: Hermes Run");
		expect(content).toContain('name: "Hermes Agent"');
		expect(content).toContain('hermesBoard == "hermes-agent"');
	});

	it("generates property-only active and archive/history views without a separate run-swimlane view", () => {
		const content = buildHermesBoardKanbanBase("job-hunt", {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: "task",
		});

		expect(content).toContain('name: "Job Hunt"');
		expect(content).not.toContain('name: "Job Hunt Runs"');
		expect(content).toContain('name: "Job Hunt Archive"');
		expect(content).toContain("hermesTaskId.isEmpty() == false");
		expect(content).toContain('hermesBoard == "job-hunt"');
		expect(content).toContain("hermesArchived != true");
		expect(content).toContain("hermesArchived == true");
		expect(content).toContain("property: hermesArchived");
		expect(content).not.toContain("swimLane: hermesRootRunId");
		expect(content).not.toContain("hideEmptySwimLanes: true");
		expect(content).not.toContain("file.inFolder(");
		expect(content).not.toContain("Hermes/job-hunt");
		expect(content).not.toContain('file.hasTag("task")');
		expect(content).not.toContain("hermes_board");
	});

	it("updates unquoted generated board views without appending quoted duplicates", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Views/kanban-default.base",
			`# Kanban Board

filters:
  and:
    - file.hasTag("task")

views:
  - type: tasknotesKanban
    name: Default
    filters:
      and:
        - file.inFolder("TaskNotes/default")
`
		);

		const result = await provisionHermesBoardSurfaces(
			{
				app,
				settings: {
					fieldMapping: DEFAULT_FIELD_MAPPING,
					taskTag: DEFAULT_SETTINGS.taskTag,
				},
			},
			["default"]
		);

		expect(result.viewsCreated).toEqual([]);
		expect(result.viewsUpdated).toEqual(["TaskNotes/Views/kanban-default.base"]);
		const existing = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(existing);
		expect(content).toContain('name: "Default"');
		expect(content.match(/^    name:\s*"?Default"?$/gm)).toHaveLength(1);
		expect(content).toContain('hermesTaskId.isEmpty() == false');
		expect(content).not.toContain('file.hasTag("task")');
		expect(content).toContain("pinnedColumns: triage,todo,ready,running,blocked,done");
	});

	it("re-provisioning a full generated board block is idempotent for active and archive views", async () => {
		const app = new App();
		const path = "TaskNotes/Views/kanban-default.base";
		const settings = {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: DEFAULT_SETTINGS.taskTag,
		};
		await app.vault.create(
			path,
			`${buildHermesBoardKanbanBaseHeader(settings)}${buildHermesBoardKanbanBase("default", settings)}`
		);

		await provisionHermesBoardSurfaces({ app, settings }, ["default"]);

		const file = app.vault.getAbstractFileByPath(path) as TFile;
		const content = await app.vault.read(file);
		expect(content.match(/^    name:\s*"Default"$/gm)).toHaveLength(1);
		expect(content.match(/^    name:\s*"Default Runs"$/gm)).toBeNull();
		expect(content.match(/^    name:\s*"Default Archive"$/gm)).toHaveLength(1);
	});

	it("removes generated run swimlane views during re-provisioning while preserving active and archive views", async () => {
		const app = new App();
		const path = "TaskNotes/Views/kanban-default.base";
		const settings = {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: DEFAULT_SETTINGS.taskTag,
		};
		await app.vault.create(
			path,
			`${buildHermesBoardKanbanBaseHeader(settings)}${buildHermesBoardKanbanBase("default", settings).replace(
				'name: "Default Archive"',
				'name: "Default Runs"\n    swimLane: hermesRootRunId\n    # legacy generated run view\n    name: "Default Archive"'
			)}`
		);

		await provisionHermesBoardSurfaces({ app, settings }, ["default"]);

		const file = app.vault.getAbstractFileByPath(path) as TFile;
		const content = await app.vault.read(file);
		expect(content).toContain('name: "Default"');
		expect(content).toContain('name: "Default Archive"');
		expect(content).not.toContain('name: "Default Runs"');
		expect(content).not.toContain("swimLane: hermesRootRunId");
	});

	it("removes duplicate generated board views while preserving custom shared base views", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Views/kanban-default.base",
			`# Kanban Board

filters:
  and:
    - file.hasTag("task")

views:
  - type: table
    name: Agent Roster
  - type: tasknotesKanban
    name: Default
    filters:
      and:
        - file.inFolder("TaskNotes/default")
  - type: tasknotesKanban
    name: "Default"
    filters:
      and:
        - file.inFolder("TaskNotes/default")
`
		);

		const result = await provisionHermesBoardSurfaces(
			{
				app,
				settings: {
					fieldMapping: DEFAULT_FIELD_MAPPING,
					taskTag: DEFAULT_SETTINGS.taskTag,
				},
			},
			["default"]
		);

		expect(result.viewsCreated).toEqual([]);
		expect(result.viewsUpdated).toEqual(["TaskNotes/Views/kanban-default.base"]);
		const existing = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(existing);
		expect(content).toContain("name: Agent Roster");
		expect(content.match(/^    name:\s*"?Default"?$/gm)).toHaveLength(1);
		expect(content).toContain("pinnedColumns: triage,todo,ready,running,blocked,done");
	});

	it("keeps YAML view blocks separated when updating a generated view before another view", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Views/kanban-default.base",
			`# Kanban Board

filters:
  and:
    - file.hasTag("task")

views:
  - type: tasknotesKanban
    name: Default
    filters:
      and:
        - file.inFolder("TaskNotes/default")
    sort:
      - property: tasknotes_manual_order
        direction: DESC
    pinnedColumns: triage,todo,ready,running,blocked,done
  - type: tasknotesKanban
    name: Developer
    filters:
      and:
        - file.inFolder("TaskNotes/developer")
`
		);

		await provisionHermesBoardSurfaces(
			{
				app,
				settings: {
					fieldMapping: DEFAULT_FIELD_MAPPING,
					taskTag: DEFAULT_SETTINGS.taskTag,
				},
			},
			["default"]
		);

		const existing = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(existing);
		expect(content).toContain(
			"pinnedColumns: triage,todo,ready,running,blocked,done\n  - type: table"
		);
		expect(content).toContain('name: "Default Archive"');
		expect(content).toContain('name: Developer');
		expect(content).not.toContain(
			"pinnedColumns: triage,todo,ready,running,blocked,done  - type: tasknotesKanban"
		);
	});

	it("removes non-adjacent duplicate generated board views", async () => {
		const app = new App();
		await app.vault.create(
			"TaskNotes/Views/kanban-default.base",
			`# Kanban Board

filters:
  and:
    - file.hasTag("task")

views:
  - type: tasknotesKanban
    name: Developer
    filters:
      and:
        - file.inFolder("TaskNotes/developer")
    sort:
      - property: tasknotes_manual_order
        direction: DESC
  - type: tasknotesKanban
    name: "Default"
  - type: tasknotesKanban
    name: "Developer"
    filters:
      and:
        - file.inFolder("TaskNotes/developer")
    sort:
      - property: tasknotes_manual_order
        direction: DESC
`
		);

		await provisionHermesBoardSurfaces(
			{
				app,
				settings: {
					fieldMapping: DEFAULT_FIELD_MAPPING,
					taskTag: DEFAULT_SETTINGS.taskTag,
				},
			},
			["developer"]
		);

		const existing = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const content = await app.vault.read(existing);
		expect(content.match(/^    name:\s*"?Developer"?$/gm)).toHaveLength(1);
		expect(content).toContain('name: "Default"');
	});

	it("updates stale generated board views and removes legacy generated board views", async () => {
		const app = new App();
		const staleView = `# Job Hunt Kanban

filters:
  and:
    - file.hasTag("task")
    - or:
        - file.inFolder("TaskNotes/job-hunt")
        - list(projects).contains("Hermes/job-hunt")

views:
  - type: tasknotesKanban
    name: "Job Hunt"
`;
		await app.vault.create("TaskNotes/Views/kanban-default.base", staleView);
		await app.vault.create("TaskNotes/Views/kanban-board-job-hunt.base", staleView);
		await app.vault.create("TaskNotes/Views/kanban-job-hunt.base", staleView);

		const result = await provisionHermesBoardSurfaces(
			{
				app,
				settings: {
					fieldMapping: DEFAULT_FIELD_MAPPING,
					taskTag: DEFAULT_SETTINGS.taskTag,
				},
			},
			["job-hunt"]
		);

		expect(result.viewsCreated).toEqual([]);
		expect(result.viewsUpdated).toEqual(["TaskNotes/Views/kanban-default.base"]);
		expect(result.legacyViewsRemoved).toEqual([
			"TaskNotes/Views/kanban-board-job-hunt.base",
			"TaskNotes/Views/kanban-job-hunt.base",
		]);

		const updated = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		const updatedContent = await app.vault.read(updated);
		expect(updatedContent).toContain('hermesTaskId.isEmpty() == false');
		expect(updatedContent).toContain('hermesBoard == "job-hunt"');
		expect(updatedContent).toContain("hermesArchived != true");
		expect(updatedContent).toContain('name: "Job Hunt Archive"');
		expect(updatedContent).not.toContain('file.inFolder("TaskNotes/Tasks")');
		expect(updatedContent).not.toContain('list(projects).contains("Hermes/job-hunt")');
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-board-job-hunt.base")).toBeNull();
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-job-hunt.base")).toBeNull();
	});

	it("removes generated legacy board-prefixed views even when that board is no longer active", async () => {
		const app = new App();
		const generatedArchivedBoardView = `filters:
  and:
    - file.hasTag("task")
    - file.inFolder("TaskNotes/old-board")

views:
  - type: tasknotesKanban
    name: "Old BOARD"
    sort:
      - property: tasknotes_manual_order
        direction: DESC
    options:
      columnWidth: 280
`;
		const customBoardView = `# Custom

views:
  - type: table
    name: "Old Custom"
`;
		await app.vault.create("TaskNotes/Views/kanban-board-old-board.base", generatedArchivedBoardView);
		await app.vault.create("TaskNotes/Views/kanban-board-old-custom.base", customBoardView);

		const result = await provisionHermesBoardSurfaces({ app }, ["default"]);

		expect(result.legacyViewsRemoved).toContain("TaskNotes/Views/kanban-board-old-board.base");
		expect(result.legacyViewsSkipped).toContain("TaskNotes/Views/kanban-board-old-custom.base");
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-board-old-board.base")).toBeNull();
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-board-old-custom.base")).toBeInstanceOf(TFile);
	});

	it("uses the reserved TaskNotes default Kanban file as the shared board view", async () => {
		const app = new App();
		await app.vault.create("TaskNotes/Views/kanban-default.base", "tasknotes command view\nviews:\n");

		const result = await provisionHermesBoardSurfaces(
			{
				app,
				settings: {
					fieldMapping: DEFAULT_FIELD_MAPPING,
					taskTag: DEFAULT_SETTINGS.taskTag,
				},
			},
			["default"]
		);

		expect(result.legacyViewsRemoved).toEqual([]);
		const reservedView = app.vault.getAbstractFileByPath(
			"TaskNotes/Views/kanban-default.base"
		) as TFile;
		await expect(app.vault.read(reservedView)).resolves.toContain("tasknotes command view");
		await expect(app.vault.read(reservedView)).resolves.toContain('name: "Default"');
		expect(app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-board-default.base")).toBeNull();
	});

	it("builds a native TaskNotes board view with the Hermes status columns", () => {
		const content = buildHermesBoardKanbanBase("job-hunt", {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: "task",
		});

		expect(content).toContain('name: "Job Hunt"');
		expect(content).toContain('hermesTaskId.isEmpty() == false');
		expect(content).toContain('hermesBoard == "job-hunt"');
		expect(content).toContain("hermesArchived != true");
		expect(content).toContain('name: "Job Hunt Archive"');
		expect(content).toContain("hermesArchived == true");
		expect(content).not.toContain('file.inFolder("TaskNotes/Tasks")');
		expect(content).not.toContain('list(projects).contains("Hermes/job-hunt")');
		expect(content).toContain("pinnedColumns: triage,todo,ready,running,blocked,done");
		expect(content).not.toContain("hermes_board");
	});

	it("summarizes created and unchanged surfaces for settings notices", () => {
		expect(
			summarizeHermesBoardProvisionResult({
				foldersCreated: ["TaskNotes/Tasks"],
				foldersSkipped: [],
				viewsCreated: ["TaskNotes/Views/kanban-default.base"],
				viewsUpdated: [],
				viewsSkipped: [],
				legacyViewsRemoved: [],
				legacyViewsSkipped: [],
				boardsSkipped: [],
			})
		).toBe("Created 1 folder(s) and 1 Kanban view(s).");

		expect(
			summarizeHermesBoardProvisionResult({
				foldersCreated: [],
				foldersSkipped: ["TaskNotes/Tasks"],
				viewsCreated: [],
				viewsUpdated: [],
				viewsSkipped: ["TaskNotes/Views/kanban-default.base"],
				legacyViewsRemoved: [],
				legacyViewsSkipped: [],
				boardsSkipped: [],
			})
		).toBe("Board folders and views already exist.");
	});

	it("normalizes the expected board paths", () => {
		expect(getHermesBoardFolderPath("obsidian-os")).toBe("TaskNotes/Tasks");
		expect(getHermesBoardKanbanViewPath("obsidian-os")).toBe("TaskNotes/Views/kanban-default.base");
	});
});
