import * as fs from "fs";
import * as path from "path";
import type { App } from "obsidian";
import { HermesKanbanApiClient } from "../../../src/hermes/hermesApiClient";
import { TaskEditModal } from "../../../src/modals/TaskEditModal";
import type { TaskInfo } from "../../../src/types";
import { MockObsidian } from "../../__mocks__/obsidian";

jest.mock("obsidian");

const cssFilePath = path.resolve(__dirname, "../../../styles/task-modal.css");

class TestTaskEditModal extends TaskEditModal {
	renderAdditionalSections(container: HTMLElement): void {
		this.createAdditionalSections(container);
	}

	setSplitContainers(options: {
		detailsContainer: HTMLElement;
		splitRightColumn: HTMLElement;
		splitContentWrapper: HTMLElement;
	}): void {
		this.detailsContainer = options.detailsContainer;
		this.splitRightColumn = options.splitRightColumn;
		this.splitContentWrapper = options.splitContentWrapper;
	}
}

function createHermesTask(): TaskInfo {
	const longEventSummary = [
		"Event payload summary with enough content to be clipped in the compact card.",
		"It should expand when the user clicks the card itself instead of a separate button.",
		"This final sentence proves the full text is restored after expansion.",
	].join(" ");

	return {
		title: "Hermes activity task",
		status: "open",
		priority: "normal",
		path: "TaskNotes/default/t_activity.md",
		archived: false,
		tags: ["hermes-kanban"],
		contexts: [],
		projects: [],
		details: [
			"## Latest Comment",
			"",
			"- orchestrator: Looks good.",
			"",
			"## Latest Event",
			"",
			`- ${longEventSummary}`,
		].join("\n"),
	} as TaskInfo;
}

function createPlugin(app: App) {
	return {
		app,
		i18n: {
			translate: (key: string) => key,
			getCurrentLocale: () => "en",
		},
		settings: {
			enableModalSplitLayout: true,
			calendarViewSettings: { firstDay: 0 },
		},
		statusManager: {
			isCompletedStatus: jest.fn(() => false),
		},
		cacheManager: {
			getTaskInfo: jest.fn(),
			isTaskFile: jest.fn(() => true),
		},
		fieldMapper: {
			toUserField: jest.fn((key: string) => key),
		},
		taskService: {
			deleteTask: jest.fn(),
			toggleArchive: jest.fn(),
			updateTask: jest.fn(),
		},
		openHermesArtifactPath: jest.fn(),
		openHermesTaskEditModalById: jest.fn(),
	};
}

describe("TaskEditModal Hermes activity layout", () => {
	beforeEach(() => {
		MockObsidian.reset();
		document.body.innerHTML = "";
	});

	afterEach(() => {
		document.body.innerHTML = "";
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it("keeps editable comments in the left details area and read-only activity in the right panel", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
		});
		const splitContentWrapper = document.createElement("div");
		const leftColumn = document.createElement("div");
		const detailsContainer = document.createElement("div");
		const rightColumn = document.createElement("div");
		splitContentWrapper.classList.add("modal-split-content--right-empty");
		leftColumn.append(detailsContainer, rightColumn);
		splitContentWrapper.append(leftColumn);
		modal.setSplitContainers({
			detailsContainer,
			splitRightColumn: rightColumn,
			splitContentWrapper,
		});

		modal.renderAdditionalSections(leftColumn);

		expect(detailsContainer.querySelector(".tn-task-modal__hermes-comments")).not.toBeNull();
		expect(detailsContainer.textContent).toContain("Comments");
		expect(detailsContainer.textContent).toContain("orchestrator");
		expect(detailsContainer.textContent).not.toContain("Worker log");
		expect(rightColumn.classList.contains("modal-split-right--with-readonly")).toBe(true);
		expect(splitContentWrapper.classList.contains("modal-split-content--right-empty")).toBe(
			false
		);
		expect(rightColumn.textContent).not.toContain("Worker log");
		expect(rightColumn.textContent).toContain("Run history");
		expect(rightColumn.textContent).toContain("Events");
		expect(detailsContainer.querySelector(".task-card__status-dot")).toBeNull();
		expect(detailsContainer.querySelector(".task-card__priority-dot")).toBeNull();
		expect(rightColumn.querySelector(".task-card__status-dot")).toBeNull();
		expect(rightColumn.querySelector(".task-card__priority-dot")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-dot")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-priority-dot")).toBeNull();
		expect(detailsContainer.querySelector(".tn-task-modal__hermes-activity-pill")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-pill")).toBeNull();
		expect(detailsContainer.querySelector(".tn-task-modal__hermes-activity-expand")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-expand")).toBeNull();
	});

	it("expands activity by clicking the card instead of a separate button", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
		});
		const splitContentWrapper = document.createElement("div");
		const leftColumn = document.createElement("div");
		const detailsContainer = document.createElement("div");
		const rightColumn = document.createElement("div");
		splitContentWrapper.classList.add("modal-split-content--right-empty");
		leftColumn.append(detailsContainer, rightColumn);
		splitContentWrapper.append(leftColumn);
		modal.setSplitContainers({
			detailsContainer,
			splitRightColumn: rightColumn,
			splitContentWrapper,
		});

		modal.renderAdditionalSections(leftColumn);

		const card = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-activity-card--expandable"
		);
		expect(card).not.toBeNull();
		expect(rightColumn.textContent).not.toContain(
			"This final sentence proves the full text is restored after expansion."
		);

		card!.click();

		expect(card!.getAttribute("aria-expanded")).toBe("true");
		expect(rightColumn.textContent).toContain(
			"This final sentence proves the full text is restored after expansion."
		);
	});

	it("shows relative activity timestamps", async () => {
		jest.useFakeTimers().setSystemTime(new Date("2026-06-02T12:00:00.000Z"));
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "orchestrator",
					body: "Fresh comment.",
					created_at: Math.floor(new Date("2026-06-02T11:55:00.000Z").getTime() / 1000),
				},
			],
			runs: [
				{
					profile: "reviewer-qa",
					status: "done",
					summary: "Run completed.",
					started_at: Math.floor(new Date("2026-06-02T11:00:00.000Z").getTime() / 1000),
				},
			],
			events: [
				{
					id: 1,
					kind: "commented",
					payload: "Event payload.",
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/default/t_activity.md",
			},
		});
		const splitContentWrapper = document.createElement("div");
		const leftColumn = document.createElement("div");
		const detailsContainer = document.createElement("div");
		const rightColumn = document.createElement("div");
		splitContentWrapper.classList.add("modal-split-content--right-empty");
		leftColumn.append(detailsContainer, rightColumn);
		splitContentWrapper.append(leftColumn);
		modal.setSplitContainers({
			detailsContainer,
			splitRightColumn: rightColumn,
			splitContentWrapper,
		});

		modal.renderAdditionalSections(leftColumn);
		await Promise.resolve();
		await Promise.resolve();

		expect(detailsContainer.textContent).toContain("orchestrator - 5 mins ago");
		expect(rightColumn.textContent).toContain("1 hour ago");
		expect(rightColumn.textContent).toContain("now");
		expect(detailsContainer.textContent).not.toContain("Jun");
		expect(rightColumn.textContent).not.toContain("Jun");
	});

	it("renders event payload objects as visual fields instead of raw JSON", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [],
			events: [
				{
					id: 1,
					kind: "run_completed",
					payload: {
						result_len: 0,
						summary: "Root triage/synthesis is complete.",
						changed_files: [
							"/Users/yt/Documents/Obsidian/TaskNotes/default/t_a.md",
							"/Users/yt/Documents/Obsidian/TaskNotes/default/t_b.md",
						],
						verification: ["unit tests passed", "build passed"],
					},
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/default/t_activity.md",
			},
		});
		const splitContentWrapper = document.createElement("div");
		const leftColumn = document.createElement("div");
		const detailsContainer = document.createElement("div");
		const rightColumn = document.createElement("div");
		splitContentWrapper.classList.add("modal-split-content--right-empty");
		leftColumn.append(detailsContainer, rightColumn);
		splitContentWrapper.append(leftColumn);
		modal.setSplitContainers({
			detailsContainer,
			splitRightColumn: rightColumn,
			splitContentWrapper,
		});

		modal.renderAdditionalSections(leftColumn);
		await Promise.resolve();
		await Promise.resolve();

		expect(rightColumn.textContent).toContain("Run Completed");
		expect(rightColumn.textContent).toContain("Root triage/synthesis is complete.");
		expect(rightColumn.textContent).toContain("Result length");
		expect(rightColumn.textContent).toContain("0");
		expect(rightColumn.textContent).toContain("Changed files");
		expect(rightColumn.textContent).toContain("2 files");
		expect(rightColumn.textContent).toContain("Verification");
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-details")).not.toBeNull();
		expect(rightColumn.textContent).not.toContain('{"result_len"');
		expect(rightColumn.textContent).not.toContain('"changed_files"');
	});

	it("opens artifacts and task ids from event action rows", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [],
			events: [
				{
					id: 1,
					kind: "run_completed",
					payload: {
						summary: "Created follow-up t_4cd03c0f.",
						artifacts: [
							"/Users/yt/Documents/Obsidian/30 Projects/demo/artifact.html",
						],
					},
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const plugin = createPlugin(app);
		const modal = new TestTaskEditModal(app, plugin as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/default/t_activity.md",
			},
		});
		const splitContentWrapper = document.createElement("div");
		const leftColumn = document.createElement("div");
		const detailsContainer = document.createElement("div");
		const rightColumn = document.createElement("div");
		splitContentWrapper.classList.add("modal-split-content--right-empty");
		leftColumn.append(detailsContainer, rightColumn);
		splitContentWrapper.append(leftColumn);
		modal.setSplitContainers({
			detailsContainer,
			splitRightColumn: rightColumn,
			splitContentWrapper,
		});

		modal.renderAdditionalSections(leftColumn);
		await Promise.resolve();
		await Promise.resolve();

		const actions = Array.from(
			rightColumn.querySelectorAll<HTMLButtonElement>(
				".tn-task-modal__hermes-activity-action"
			)
		);
		const artifactAction = actions.find((action) =>
			action.textContent?.includes("artifact.html")
		);
		const taskAction = actions.find((action) => action.textContent === "Edit t_4cd03c0f");

		expect(artifactAction).not.toBeUndefined();
		expect(taskAction).not.toBeUndefined();

		artifactAction!.click();
		taskAction!.click();
		await Promise.resolve();

		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith(
			"/Users/yt/Documents/Obsidian/30 Projects/demo/artifact.html"
		);
		expect(plugin.openHermesTaskEditModalById).toHaveBeenCalledWith("t_4cd03c0f", "default");
	});

	it("lets the wide right panel scroll when it contains read-only activity", () => {
		const cssContent = fs.readFileSync(cssFilePath, "utf-8");
		const rightPanelBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin.minimalist-task-modal.split-layout-enabled.expanded .modal-split-right.modal-split-right--with-readonly"
		);
		const detailsEditorBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin.minimalist-task-modal.split-layout-enabled.expanded .modal-split-right.modal-split-right--with-readonly .tn-task-modal__markdown-editor--details"
		);

		expect(rightPanelBlock).toContain("overflow-y: auto");
		expect(rightPanelBlock).toContain("overflow-x: hidden");
		expect(detailsEditorBlock).toContain("flex: 0 0 auto");
		expect(detailsEditorBlock).toContain("max-height: min(40vh, 360px)");
	});
});

function extractCssBlock(css: string, selector: string): string {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`${escapedSelector}\\s*\\{([^}]*?)\\}`, "s");
	const match = css.match(regex);
	return match ? match[1] : "";
}
