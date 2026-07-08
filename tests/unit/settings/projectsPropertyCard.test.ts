import { App, MockObsidian, TFile } from "obsidian";
import { renderProjectsPropertyCard } from "../../../src/settings/tabs/taskProperties/projectsPropertyCard";
import { HermesKanbanApiClient } from "../../../src/hermes/hermesApiClient";
import { showTextInputModal } from "../../../src/modals/TextInputModal";
import { showConfirmationModal } from "../../../src/modals/ConfirmationModal";
import { readHermesBoardRegistry } from "../../../src/hermes/hermesBoardRegistry";

jest.mock("../../../src/modals/TextInputModal", () => ({
	showTextInputModal: jest.fn(),
}));

jest.mock("../../../src/modals/ConfirmationModal", () => ({
	showConfirmationModal: jest.fn(),
}));

function makePlugin(app: App) {
	return {
		app,
		settings: {
			enableDebugLogging: false,
			fieldMapping: {
				projects: "projects",
				status: "status",
				priority: "priority",
				contexts: "contexts",
				due: "due",
				scheduled: "scheduled",
				blockedBy: "blockedBy",
				sortOrder: "tasknotes_manual_order",
			},
			taskCreationDefaults: {
				defaultProjects: "",
				useParentNoteAsProject: false,
				useParentHeaderAsProject: false,
				inheritParentTaskProperties: false,
			},
			taskTag: "task",
		},
	} as any;
}

const translate = (key: string): string => key;

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 10; index += 1) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Projects property Hermes board controls", () => {
	beforeEach(() => {
		MockObsidian.reset();
		jest.restoreAllMocks();
		(showTextInputModal as jest.Mock).mockReset();
		(showConfirmationModal as jest.Mock).mockReset();
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("creates a TaskNotes-native board from Settings while the dashboard is unavailable", async () => {
		const app = new App();
		const plugin = makePlugin(app);
		const save = jest.fn();
		const createBoard = jest
			.spyOn(HermesKanbanApiClient.prototype, "createBoard")
			.mockRejectedValue(new Error("dashboard offline"));
		jest.spyOn(HermesKanbanApiClient.prototype, "listBoards").mockRejectedValue(
			new Error("dashboard offline")
		);
		(showTextInputModal as jest.Mock).mockResolvedValue("Local Settings Board");
		const container = document.createElement("div");

		renderProjectsPropertyCard(container, plugin, save, translate);
		const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.title === "Create a Hermes board"
		);
		expect(createButton).toBeTruthy();
		createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushPromises();

		expect(showTextInputModal).toHaveBeenCalledTimes(1);
		expect(createBoard).not.toHaveBeenCalled();
		expect(plugin.settings.taskCreationDefaults.defaultProjects).toBe(
			"Hermes/local-settings-board"
		);
		expect(save).toHaveBeenCalled();
		const registry = await readHermesBoardRegistry({ app } as any);
		expect(registry).toMatchObject([
			{ slug: "local-settings-board", archived: false, source: "registry" },
		]);
		expect(app.vault.getAbstractFileByPath("TaskNotes/Boards/local-settings-board.md")).toBeInstanceOf(TFile);
		const base = app.vault.getAbstractFileByPath("TaskNotes/Views/kanban-default.base") as TFile;
		expect(await app.vault.read(base)).toContain('name: "Local Settings Board"');
	});

	it("archives the selected board locally without dashboard delete access", async () => {
		const app = new App();
		const plugin = makePlugin(app);
		plugin.settings.taskCreationDefaults.defaultProjects = "Hermes/old-board";
		plugin.cacheManager = {
			getAllTasks: jest.fn(async () => []),
			clearCacheEntry: jest.fn(),
		};
		plugin.emitter = { trigger: jest.fn() };
		const save = jest.fn();
		await app.vault.create(
			"TaskNotes/Boards/old-board.md",
			`---
type: hermes-board
hermesBoard: old-board
hermesBoardArchived: false
---

# Hermes/old-board
`
		);
		await app.vault.create(
			"TaskNotes/Tasks/old-board--t_cleanup.md",
			`---
title: Mirror to remove
hermesTaskId: t_cleanup
hermesBoard: old-board
---
`
		);
		const deleteBoard = jest
			.spyOn(HermesKanbanApiClient.prototype, "deleteBoard")
			.mockRejectedValue(new Error("dashboard offline"));
		jest.spyOn(HermesKanbanApiClient.prototype, "listBoards").mockRejectedValue(
			new Error("dashboard offline")
		);
		(showConfirmationModal as jest.Mock).mockResolvedValue(true);
		const container = document.createElement("div");

		renderProjectsPropertyCard(container, plugin, save, translate);
		await flushPromises();
		const deleteButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.title === "Delete the selected Hermes board"
		);
		expect(deleteButton).toBeTruthy();
		deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushPromises();

		expect(deleteBoard).not.toHaveBeenCalled();
		expect(plugin.settings.taskCreationDefaults.defaultProjects).toBe("");
		expect(save).toHaveBeenCalled();
		const registry = await readHermesBoardRegistry({ app } as any, { includeArchived: true });
		expect(registry).toMatchObject([
			{ slug: "old-board", archived: true, source: "registry" },
		]);
		expect(app.vault.getAbstractFileByPath("TaskNotes/Tasks/old-board--t_cleanup.md")).toBeNull();
		expect(plugin.cacheManager.clearCacheEntry).toHaveBeenCalledWith(
			"TaskNotes/Tasks/old-board--t_cleanup.md"
		);
	});
});
