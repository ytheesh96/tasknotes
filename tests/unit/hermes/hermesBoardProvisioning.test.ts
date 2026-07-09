import { App, MockObsidian, TFile } from "../../helpers/obsidian-runtime";
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
		expect(content).not.toContain("hermesArchived != true");
		expect(content).toContain("showHermesArchivedTasks: false");
		expect(content).not.toContain('name: "Default Archive"');
		expect(content).toContain('hermesBoard == "default"');
		expect(content).not.toContain("hermesArchived == true");
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
    - hermesArchived != true

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
		const rootBlock = extractRootBlock(content);
		expect(content).toContain('name: "Custom"');
		expect(content).toContain('name: "Default"');
		expect(content).toContain('hermesTaskId.isEmpty() == false');
		expect(content).toContain('hermesBoard == "default"');
		expect(rootBlock).toContain("hermesArchived != true");
		expect(content).not.toContain('name: "Default Archive"');
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
		expect(content).not.toContain('name: "Default Archive"');
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

	it("generates a property-only Kanban view with archived visibility controlled by a view option", () => {
		const content = buildHermesBoardKanbanBase("job-hunt", {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: "task",
		});

		expect(content).toContain('name: "Job Hunt"');
		expect(content).not.toContain('name: "Job Hunt Runs"');
		expect(content).not.toContain('name: "Job Hunt Archive"');
		expect(content).toContain("hermesTaskId.isEmpty() == false");
		expect(content).toContain('hermesBoard == "job-hunt"');
		expect(content).not.toContain("hermesArchived != true");
		expect(content).not.toContain('hermesArchived != "true"');
		expect(content).not.toContain("hermesArchived == true");
		expect(content).not.toContain('hermesArchived == "true"');
		expect(content).toContain("showHermesArchivedTasks: false");
		expect(content).not.toContain("swimLane: hermesRootRunId");
		expect(content).not.toContain("hideEmptySwimLanes: true");
		expect(content).not.toContain("file.inFolder(");
		expect(content).not.toContain("Hermes/job-hunt");
		expect(content).not.toContain('file.hasTag("task")');
		expect(content).not.toContain("hermes_board");
	});

	it("generates active board filters broad enough for the archived toggle to reveal archived tasks", () => {
		const content = buildHermesBoardKanbanBase("job-hunt", {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: "task",
		});

		const activeView = extractViewBlock(content, "Job Hunt");
		expect(activeView).not.toContain("hermesArchived != true");
		expect(activeView).not.toContain('hermesArchived != "true"');
		expect(activeView).not.toContain("hermesArchived == true");
		expect(activeView).toContain("showHermesArchivedTasks: false");
		expect(content).not.toContain('name: "Job Hunt Archive"');
	});

	it("removes archived exclusions from generated root and view filters so the Kanban toggle can reveal archived tasks", async () => {
		const app = new App();
		const path = "TaskNotes/Views/kanban-default.base";
		await app.vault.create(
			path,
			`${buildHermesBoardKanbanBaseHeader().replace(
				"    - hermesTaskId.isEmpty() == false",
				'    - hermesTaskId.isEmpty() == false\n    - hermesArchived != true\n    - hermesArchived != "true"'
			)}${buildHermesBoardKanbanBase("default")}`
		);

		const result = await provisionHermesBoardSurfaces({ app }, ["default"]);

		expect(result.viewsUpdated).toEqual([path]);
		const existing = app.vault.getAbstractFileByPath(path) as TFile;
		const content = await app.vault.read(existing);
		const rootBlock = extractRootBlock(content);
		const activeView = extractViewBlock(content, "Default");
		expect(rootBlock).not.toContain("hermesArchived != true");
		expect(rootBlock).not.toContain('hermesArchived != "true"');
		expect(rootBlock).not.toContain("hermesArchived == true");
		expect(rootBlock).not.toContain('hermesArchived == "true"');
		expect(rootBlock).toContain("hermesTaskId.isEmpty() == false");
		expect(activeView).not.toContain("hermesArchived != true");
		expect(activeView).not.toContain('hermesArchived != "true"');
		expect(activeView).not.toContain("hermesArchived == true");
		expect(activeView).toContain("showHermesArchivedTasks: false");
		expect(content).not.toContain('name: "Default Archive"');
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
		expect(content.match(/^    name:\s*"Default Archive"$/gm)).toBeNull();
	});

	it("removes generated run swimlane and archive views during re-provisioning while preserving the active view", async () => {
		const app = new App();
		const path = "TaskNotes/Views/kanban-default.base";
		const settings = {
			fieldMapping: DEFAULT_FIELD_MAPPING,
			taskTag: DEFAULT_SETTINGS.taskTag,
		};
		await app.vault.create(
			path,
			`${buildHermesBoardKanbanBaseHeader(settings)}${buildHermesBoardKanbanBase("default", settings)}
  - type: tasknotesKanban
    name: "Default Runs"
    filters:
      and:
        - hermesBoard == "default"
    swimLane: hermesRootRunId
  - type: table
    name: "Default Archive"
    filters:
      and:
        - hermesBoard == "default"
        - or:
            - hermesArchived == true
            - hermesArchived == "true"
`
		);

		await provisionHermesBoardSurfaces({ app, settings }, ["default"]);

		const file = app.vault.getAbstractFileByPath(path) as TFile;
		const content = await app.vault.read(file);
		expect(content).toContain('name: "Default"');
		expect(content).not.toContain('name: "Default Archive"');
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
			"pinnedColumns: triage,todo,ready,running,blocked,done\n  - type: tasknotesKanban"
		);
		expect(content).not.toContain('name: "Default Archive"');
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

	it("removes stale generated fixture board views from the shared Kanban base", async () => {
		const app = new App();
		const path = "TaskNotes/Views/kanban-default.base";
		await app.vault.create(
			path,
			`${buildHermesBoardKanbanBaseHeader()}${buildHermesBoardKanbanBase("default")}
  - type: table
    name: "Manual Fixture Audit"
    filters:
      and:
        - hermesBoard == "e2e-archive-mq2ymeh9"
  - type: tasknotesKanban
    name: "E2e Archive Mq2ymeh9"
    filters:
      and:
        - hermesTaskId.isEmpty() == false
        - hermesBoard == "e2e-archive-mq2ymeh9"
    groupBy:
      property: status
      direction: ASC
    sort:
      - property: tasknotes_manual_order
        direction: DESC
    options:
      columnWidth: 280
      hideEmptyColumns: false
      showHermesArchivedTasks: false
    hideEmptyColumns: false
    pinnedColumns: triage,todo,ready,running,blocked,done
  - type: tasknotesKanban
    name: "Tasknotes Dashboardless E2e Fixture"
    filters:
      and:
        - hermesTaskId.isEmpty() == false
        - hermesBoard == "tasknotes-dashboardless-e2e-fixture"
    groupBy:
      property: status
      direction: ASC
    sort:
      - property: tasknotes_manual_order
        direction: DESC
    options:
      columnWidth: 280
      hideEmptyColumns: false
      showHermesArchivedTasks: false
    hideEmptyColumns: false
    pinnedColumns: triage,todo,ready,running,blocked,done
`
		);

		const result = await provisionHermesBoardSurfaces({ app }, ["default"]);

		expect(result.viewsUpdated).toEqual([path]);
		const existing = app.vault.getAbstractFileByPath(path) as TFile;
		const content = await app.vault.read(existing);
		expect(content).toContain('name: "Default"');
		expect(content).toContain('hermesBoard == "default"');
		expect(content).toContain('name: "Manual Fixture Audit"');
		expect(content).not.toContain('name: "E2e Archive Mq2ymeh9"');
		expect(content).not.toContain('name: "Tasknotes Dashboardless E2e Fixture"');
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
		expect(updatedContent).not.toContain("hermesArchived != true");
		expect(updatedContent).toContain("showHermesArchivedTasks: false");
		expect(updatedContent).not.toContain('name: "Job Hunt Archive"');
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
		expect(content).not.toContain("hermesArchived != true");
		expect(content).toContain("showHermesArchivedTasks: false");
		expect(content).not.toContain('name: "Job Hunt Archive"');
		expect(content).not.toContain("hermesArchived == true");
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

function extractViewBlock(content: string, viewName: string): string {
	const viewStartPattern = new RegExp(`^  - type: (?:tasknotesKanban|table)\\n    name: "${viewName}"`, "m");
	const startMatch = content.match(viewStartPattern);
	expect(startMatch?.index).toBeDefined();
	const start = startMatch?.index ?? 0;
	const remainingContent = content.slice(start + 1);
	const nextViewMatch = remainingContent.match(/^  - type: (?:tasknotesKanban|table)\s*$/m);
	const end = nextViewMatch?.index === undefined ? content.length : start + 1 + nextViewMatch.index;
	return content.slice(start, end).trimEnd();
}

function extractRootBlock(content: string): string {
	const viewsMatch = content.match(/^views:\s*$/m);
	expect(viewsMatch?.index).toBeDefined();
	return content.slice(0, viewsMatch?.index ?? 0);
}
