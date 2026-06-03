import * as fs from "fs";
import * as path from "path";
import { Modal, type App } from "obsidian";
import { HermesKanbanApiClient } from "../../../src/hermes/hermesApiClient";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
} from "../../../src/hermes/hermesAvailabilityService";
import { HERMES_ACTIVITY_FIELD_KEYS } from "../../../src/hermes/hermesActivityFrontmatter";
import { TaskEditModal } from "../../../src/modals/TaskEditModal";
import { createHermesEditFieldConfig } from "../../../src/hermes/hermesTaskNotesIntegration";
import { HERMES_REVIEW_RAIL_FIELD_ID } from "../../../src/hermes/hermesAssignee";
import type { TaskInfo } from "../../../src/types";
import { MockObsidian } from "../../__mocks__/obsidian";

jest.mock("obsidian");

const cssFilePath = path.resolve(__dirname, "../../../styles/task-modal.css");

class TestTaskEditModal extends TaskEditModal {
	renderAdditionalSections(container: HTMLElement): void {
		this.createAdditionalSections(container);
	}

	renderActionBarForTest(container: HTMLElement): void {
		this.createActionBar(container);
	}

	renderRoutingFieldsForTest(container: HTMLElement): void {
		this.createProjectsField(container);
		this.createContextsField(container);
	}

	renderContentForTest(): void {
		const workspace = this.app.workspace as unknown as { getActiveFile?: () => null };
		workspace.getActiveFile ??= () => null;
		this.createModalContent();
	}

	setFormStateForTest(task: TaskInfo): void {
		this.title = task.title;
		this.status = task.status || "open";
		this.priority = task.priority || "normal";
		this.contexts = (task.contexts || []).join(", ");
		this.projects = "Hermes/default";
		this.tags = (task.tags || []).join(", ");
		this.details = task.details || "";
		this.originalDetails = this.details;
	}

	setRoutingState(options: { contexts?: string }): void {
		if (options.contexts !== undefined) {
			this.contexts = options.contexts;
		}
	}

	setTitleForTest(title: string): void {
		this.title = title;
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
			deleteTask: jest.fn(async () => undefined),
			toggleArchive: jest.fn(async (task: TaskInfo) => ({ ...task, archived: !task.archived })),
			updateTask: jest.fn(async (task: TaskInfo, changes: Partial<TaskInfo>) => ({
				...task,
				...changes,
			})),
			updateBlockingRelationships: jest.fn(async () => undefined),
			},
			openHermesArtifactPath: jest.fn(),
			openHermesTaskEditModalById: jest.fn(),
			getHermesDashboardStartCommand: jest.fn(() => HERMES_DASHBOARD_START_COMMAND),
			startHermesDashboard: jest.fn(async () =>
				new HermesAvailabilityService().startDashboard()
			),
		};
	}

describe("TaskEditModal Hermes activity layout", () => {
	beforeEach(() => {
		MockObsidian.reset();
		document.body.innerHTML = "";
		jest.spyOn(HermesAvailabilityService.prototype, "recheckHealth").mockResolvedValue(
			hermesHealth({ status: "connected", mode: "live", canStart: true })
		);
		jest.spyOn(HermesAvailabilityService.prototype, "getOptions").mockResolvedValue({
			boards: ["default"],
			assignees: ["peacock"],
			statuses: ["triage", "todo", "running", "blocked", "done"],
			health: hermesHealth({ status: "connected", mode: "live", canStart: true }),
		});
	});

	afterEach(() => {
		document.body.innerHTML = "";
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it("adds Hermes board and assignee icons to the top edit action row", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/job-hunt-team/t_activity.md",
			},
		});
		modal.setRoutingState({ contexts: "orchestrator" });
		const container = document.createElement("div");

		modal.renderActionBarForTest(container);

		const icons = Array.from(container.querySelectorAll<HTMLElement>(".action-icon"));
		expect(icons.map((icon) => icon.dataset.type)).toEqual([
			"hermes-board",
			"hermes-assignee",
			"status",
			"priority",
			"due-date",
			"scheduled-date",
			"recurrence",
			"reminders",
		]);
		const boardIcon = container.querySelector<HTMLElement>('[data-type="hermes-board"]')!;
		const assigneeIcon = container.querySelector<HTMLElement>(
			'[data-type="hermes-assignee"]'
		)!;
		expect(boardIcon.classList.contains("has-value")).toBe(true);
		expect(boardIcon.getAttribute("data-tooltip")).toBe("Board: job-hunt-team");
		expect(assigneeIcon.classList.contains("has-value")).toBe(true);
		expect(assigneeIcon.getAttribute("data-tooltip")).toBe("Assignee: orchestrator");
	});

	it("does not render duplicate Hermes board and assignee fields below the title area", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/job-hunt-team/t_activity.md",
			},
		});
		const container = document.createElement("div");

		modal.renderRoutingFieldsForTest(container);

		expect(container.textContent).not.toContain("Board");
		expect(container.textContent).not.toContain("Assignee");
		expect(container.querySelector("select")).toBeNull();
		expect(container.querySelector("input")).toBeNull();
	});

	it("renders Hermes edit actions without legacy save update or cancel controls", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const task = createHermesTask();
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task,
			saveButtonText: "Save update",
			modalFieldsConfig: createHermesEditFieldConfig([]),
		});
		modal.setFormStateForTest(task);

		modal.renderContentForTest();

		const buttonBar = modal.contentEl.querySelector<HTMLElement>(
			".tn-task-modal__button-bar--hermes-live"
		)!;
		const buttonTexts = Array.from(buttonBar.querySelectorAll("button")).map((button) =>
			button.textContent?.trim()
		);
		expect(buttonTexts).toEqual(["Recheck", "modals.task.buttons.openNote", "Block"]);
		expect(buttonBar.querySelector(".tn-task-modal__hermes-availability")).not.toBeNull();
		expect(buttonTexts).not.toContain("modals.taskEdit.buttons.archive");
		expect(buttonTexts).not.toContain("contextMenus.task.delete");
		expect(buttonTexts).not.toContain("Save update");
		expect(buttonTexts).not.toContain("common.cancel");
		expect(modal.contentEl.textContent).not.toContain("modals.task.detailsLabel");
	});

	it("toggles a Hermes task between blocked and ready from the same footer button", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [],
			events: [],
		});
		const updateTask = jest
			.spyOn(HermesKanbanApiClient.prototype, "updateTask")
			.mockResolvedValue({ id: "t_activity", title: "Hermes activity task" });
		const app = MockObsidian.createMockApp() as unknown as App;
		const plugin = createPlugin(app);
		const task = { ...createHermesTask(), status: "todo" };
		const modal = new TestTaskEditModal(app, plugin as never, {
			task,
			modalFieldsConfig: createHermesEditFieldConfig([]),
		});
		const forceClose = jest.spyOn(modal, "forceClose");
		jest.spyOn(
			modal as unknown as { hasUnsavedHermesModalChanges: () => boolean },
			"hasUnsavedHermesModalChanges"
		).mockReturnValue(false);
		modal.setFormStateForTest(task);
		modal.renderContentForTest();
		await flushPromises();

		const blockToggleButton = modal.contentEl.querySelector<HTMLButtonElement>(
			".tn-task-modal__hermes-block-toggle-button"
		)!;
		expect(blockToggleButton.textContent).toBe("Block");

		await (modal as unknown as {
			toggleHermesBlockedStatus: (button: HTMLButtonElement) => Promise<void>;
		}).toggleHermesBlockedStatus(blockToggleButton);
		expect(plugin.taskService.updateTask).toHaveBeenLastCalledWith(task, { status: "blocked" });
		expect(updateTask).not.toHaveBeenCalled();
		expect(blockToggleButton.textContent).toBe("Unblock");
		expect(blockToggleButton.disabled).toBe(false);

		await (modal as unknown as {
			toggleHermesBlockedStatus: (button: HTMLButtonElement) => Promise<void>;
		}).toggleHermesBlockedStatus(blockToggleButton);
		expect(plugin.taskService.updateTask).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: "blocked" }),
			{ status: "ready" }
		);
		expect(updateTask).not.toHaveBeenCalled();
		expect(blockToggleButton.textContent).toBe("Block");
		expect(forceClose).not.toHaveBeenCalled();
	});

	it("commits Hermes title edits through TaskNotes without closing the modal", async () => {
		const updateTask = jest
			.spyOn(HermesKanbanApiClient.prototype, "updateTask")
			.mockResolvedValue(undefined);
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [],
			events: [],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const plugin = createPlugin(app);
		const task = createHermesTask();
		const modal = new TestTaskEditModal(app, plugin as never, {
			task,
			modalFieldsConfig: createHermesEditFieldConfig([]),
		});
		const forceClose = jest.spyOn(modal, "forceClose");
		modal.setFormStateForTest(task);
		modal.renderContentForTest();

		const titleInput = modal.contentEl.querySelector<HTMLTextAreaElement>(
			".title-input-detailed"
		)!;
		titleInput.value = "Updated live title";
		titleInput.dispatchEvent(new Event("input", { bubbles: true }));
		modal.setTitleForTest("Updated live title");
		expect(
			(modal as unknown as { getChanges: () => Partial<TaskInfo> }).getChanges()
		).toMatchObject({ title: "Updated live title" });
		await (
			modal as unknown as {
				flushHermesLiveSave: (options?: { showSuccessNotice?: boolean }) => Promise<boolean>;
			}
		).flushHermesLiveSave();

		expect(plugin.taskService.updateTask).toHaveBeenCalledWith(
			task,
			expect.objectContaining({ title: "Updated live title" })
		);
		expect(updateTask).not.toHaveBeenCalled();
		expect(forceClose).not.toHaveBeenCalled();
	});

	it("keeps non-Hermes edit action rows on the standard icon set", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: {
				...createHermesTask(),
				path: "Tasks/plain.md",
			},
		});
		const container = document.createElement("div");

		modal.renderActionBarForTest(container);

		expect(container.querySelector('[data-type="hermes-board"]')).toBeNull();
		expect(container.querySelector('[data-type="hermes-assignee"]')).toBeNull();
	});

	it("renders Hermes comments as the right-rail review thread instead of left-side details", () => {
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

		expect(detailsContainer.querySelector(".tn-task-modal__hermes-comments")).toBeNull();
		expect(detailsContainer.textContent).not.toContain("orchestrator");
		expect(rightColumn.classList.contains("modal-split-right--with-readonly")).toBe(true);
		expect(splitContentWrapper.classList.contains("modal-split-content--right-empty")).toBe(
			false
		);
		expect(rightColumn.querySelector(".tn-task-modal__hermes-review-thread")).not.toBeNull();
		expect(rightColumn.textContent).toContain("Review thread");
		expect(rightColumn.textContent).toContain("orchestrator");
		expect(rightColumn.querySelector(".tn-task-modal__hermes-composer")).not.toBeNull();
		expect(
			rightColumn.querySelector(".tn-task-modal__hermes-composer button[aria-label='Send comment']")
		).not.toBeNull();
		expect(rightColumn.textContent).toContain("Event payload summary");
		expect(rightColumn.textContent).not.toContain("Status update");
		expect(rightColumn.textContent).not.toContain("Run history");
		expect(rightColumn.textContent).not.toContain("Events");
		expect(rightColumn.textContent).not.toContain("Worker log");
		expect(leftColumn.textContent).not.toContain("Task Information");
		expect(detailsContainer.querySelector(".task-card__status-dot")).toBeNull();
		expect(rightColumn.querySelector(".task-card__status-dot")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-expand")).toBeNull();
	});

	it("hides the Hermes review rail when disabled in Modal Fields", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
			modalFieldsConfig: createHermesEditFieldConfig([], {
				fields: [
					{
						id: HERMES_REVIEW_RAIL_FIELD_ID,
						enabled: false,
						visibleInEdit: true,
					},
				],
			}),
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

		expect(rightColumn.querySelector(".tn-task-modal__hermes-review-thread")).toBeNull();
		expect(rightColumn.classList.contains("modal-split-right--with-readonly")).toBe(false);
		expect(splitContentWrapper.classList.contains("modal-split-content--right-empty")).toBe(
			true
		);
	});

	it("renders cached fallback activity as a compact card", () => {
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
			".tn-task-modal__hermes-status-item"
		);
		expect(card).not.toBeNull();
		expect(card!.textContent).toContain("Event payload summary");
	});

	it("renders cached Hermes activity from task frontmatter", () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const task = {
			...createHermesTask(),
			details: "",
			customProperties: {
				[HERMES_ACTIVITY_FIELD_KEYS.comments]: ["reviewer-qa: Cached YAML review comment."],
				[HERMES_ACTIVITY_FIELD_KEYS.runs]: ["Run 12 - reviewer-qa - blocked"],
				[HERMES_ACTIVITY_FIELD_KEYS.events]: ["review_required: Cached YAML event summary."],
			},
		};
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, { task });
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

		expect(rightColumn.textContent).toContain("Cached YAML review comment.");
		expect(rightColumn.textContent).toContain("Cached YAML event summary.");
		expect(rightColumn.textContent).not.toContain("No review activity yet.");
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

		expect(rightColumn.textContent).toContain("orchestrator - 5 mins ago");
		expect(rightColumn.textContent).toContain("1 hour ago");
		expect(rightColumn.textContent).toContain("now");
		expect(detailsContainer.textContent).not.toContain("Jun");
		expect(rightColumn.textContent).not.toContain("Jun");
	});

	it("keeps the newest thread entries closest to the comment composer", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "orchestrator",
					body: "Older implementation note.",
					created_at: Math.floor(new Date("2026-06-02T11:05:00.000Z").getTime() / 1000),
				},
				{
					author: "yt",
					body: "Latest human note.",
					created_at: Math.floor(new Date("2026-06-02T11:55:00.000Z").getTime() / 1000),
				},
			],
			runs: [],
			events: [
				{
					id: 1,
					kind: "claimed",
					payload: { summary: "Oldest status update." },
					created_at: Math.floor(new Date("2026-06-02T11:00:00.000Z").getTime() / 1000),
				},
				{
					id: 2,
					kind: "spawned",
					payload: { summary: "Spawned worker." },
					created_at: Math.floor(new Date("2026-06-02T11:10:00.000Z").getTime() / 1000),
				},
				{
					id: 3,
					kind: "heartbeat",
					payload: { summary: "Heartbeat update." },
					created_at: Math.floor(new Date("2026-06-02T11:20:00.000Z").getTime() / 1000),
				},
				{
					id: 4,
					kind: "run_completed",
					payload: { summary: "Completed refresh-failure regression." },
					created_at: Math.floor(new Date("2026-06-02T11:50:00.000Z").getTime() / 1000),
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
		const { rightColumn } = renderHermesSections(modal);
		await flushPromises();

		const threadList = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-thread-list"
		)!;
		const composer = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-composer"
		)!;
		expect(threadList.nextElementSibling).toBe(composer);

		const earlierButton = threadList.querySelector<HTMLButtonElement>(
			".tn-task-modal__hermes-earlier-activity"
		)!;
		const earlierList = threadList.querySelector<HTMLElement>(
			".tn-task-modal__hermes-earlier-activity-list"
		)!;
		expect(earlierButton.textContent).toBe("Show earlier activity (1)");
		expect(earlierList.hidden).toBe(true);
		expect(threadList.querySelector(".tn-task-modal__hermes-status-indicator")).not.toBeNull();
		expect(threadList.textContent).not.toContain("Status update");

		const visibleCards = Array.from(threadList.children).filter(
			(child): child is HTMLElement =>
				child instanceof HTMLElement &&
				!child.classList.contains("tn-task-modal__hermes-earlier-activity") &&
				!child.classList.contains("tn-task-modal__hermes-earlier-activity-list")
		);
		expect(visibleCards[visibleCards.length - 1].textContent).toContain("Latest human note.");
		expect(visibleCards[visibleCards.length - 2].textContent).toContain(
			"Completed refresh-failure regression."
		);
		expect(
			visibleCards[visibleCards.length - 2].classList.contains(
				"tn-task-modal__hermes-status-item--success"
			)
		).toBe(true);
		expect(visibleCards[visibleCards.length - 2].textContent).not.toContain("Run");
		expect(visibleCards[0].textContent).not.toContain("Oldest status update.");

		earlierButton.click();
		expect(earlierButton.textContent).toBe("Hide earlier activity");
		expect(earlierList.hidden).toBe(false);
		expect(earlierList.textContent).toContain("Oldest status update.");
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

		expect(rightColumn.textContent).toContain("Completed");
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

	it("pins review-required handoffs and summarizes JSON payloads as readable cards", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "peacock",
					body: [
						"review-required handoff:",
						JSON.stringify({
							changed_files: ["src/modals/TaskEditModal.ts"],
							tests_run: ["npm test -- TaskEditModal.hermes-activity-layout.test.ts"],
							artifacts: ["/tmp/review.md"],
							decisions: ["comments live in right rail"],
						}),
					].join("\n"),
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
			runs: [],
			events: [],
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

		const pinnedCard = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-review-card--pinned"
		);
		expect(pinnedCard).not.toBeNull();
		expect(pinnedCard!.querySelector(".tn-task-modal__hermes-review-badge")).toBeNull();
		expect(pinnedCard!.classList.contains("tn-task-modal__hermes-activity-card--openable")).toBe(true);
		expect(pinnedCard!.getAttribute("aria-haspopup")).toBe("dialog");
		expect(pinnedCard!.getAttribute("aria-expanded")).toBeNull();
		expect(pinnedCard!.textContent).toContain("Review required");
		expect(pinnedCard!.textContent).toContain("Changed files");
		expect(pinnedCard!.textContent).toContain("1 file");
		expect(pinnedCard!.textContent).toContain("Tests run");
		expect(pinnedCard!.textContent).toContain("1 item");
		expect(pinnedCard!.textContent).toContain("Open review.md");
		expect(pinnedCard!.textContent).not.toContain('"changed_files"');
		expect(
			pinnedCard!.querySelectorAll(".tn-task-modal__hermes-activity-detail-row--overflow")
		).toHaveLength(2);

		const openSpy = jest.spyOn(Modal.prototype, "open");
		pinnedCard!.click();
		expect(openSpy).toHaveBeenCalledTimes(1);
		const detailModal = openSpy.mock.instances[0] as Modal;
		expect(detailModal.contentEl.textContent).toContain("Review required");
		expect(detailModal.contentEl.textContent).toContain("Decisions");
		expect(detailModal.contentEl.textContent).toContain("Open review.md");

		pinnedCard!.querySelector<HTMLButtonElement>(".tn-task-modal__hermes-raw-toggle")!.click();
		expect(pinnedCard!.textContent).toContain("review-required handoff:");
		expect(pinnedCard!.textContent).toContain('"changed_files"');
	});

	it("renders a raw review-required JSON blob as a structured card with raw content collapsed", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "peacock",
					body: JSON.stringify({
						summary: "Feature is implemented but needs review.",
						needs_review: true,
						run_id: 144,
						profile: "peacock",
						changed_files: ["src/modals/TaskEditModal.ts"],
						artifacts: ["/tmp/review.md", "https://example.com/review.pdf"],
					}),
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
			runs: [],
			events: [],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const plugin = createPlugin(app);
		const modal = new TestTaskEditModal(app, plugin as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/default/t_activity.md",
			},
		});
		const { rightColumn } = renderHermesSections(modal);
		await flushPromises();

		const structuredCard = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-review-card--pinned"
		);
		expect(structuredCard).not.toBeNull();
		expect(structuredCard!.querySelector(".tn-task-modal__hermes-review-badge")).toBeNull();
		expect(structuredCard!.textContent).toContain("Review required");
		expect(structuredCard!.textContent).toContain("Feature is implemented but needs review.");
		expect(structuredCard!.textContent).toContain("Changed files");
		expect(structuredCard!.textContent).toContain("1 file");
		expect(structuredCard!.textContent).toContain("Open review.md");
		expect(structuredCard!.textContent).toContain("Open review.pdf");
		expect(structuredCard!.textContent).toContain("View raw");
		expect(structuredCard!.textContent).not.toContain('"needs_review"');

		const artifactButtons = Array.from(
			structuredCard!.querySelectorAll<HTMLButtonElement>(
				".tn-task-modal__hermes-activity-action"
			)
		);
		const localArtifact = artifactButtons.find((button) =>
			button.textContent?.includes("review.md")
		);
		const remoteArtifact = artifactButtons.find((button) =>
			button.textContent?.includes("review.pdf")
		);
		expect(localArtifact).not.toBeUndefined();
		expect(remoteArtifact).not.toBeUndefined();

		localArtifact!.click();
		remoteArtifact!.click();
		await Promise.resolve();
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith("/tmp/review.md");
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith(
			"https://example.com/review.pdf"
		);

		structuredCard!.querySelector<HTMLButtonElement>(".tn-task-modal__hermes-raw-toggle")!.click();
		expect(structuredCard!.textContent).toContain('"needs_review"');
	});

	it("renders ordinary comments with the plain comment card treatment", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "yt",
					body: "Looks good to me — no Hermes payload here.",
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
			runs: [],
			events: [],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/default/t_activity.md",
			},
		});
		const { rightColumn } = renderHermesSections(modal);
		await flushPromises();

		const plainComment = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-thread-card:not(.tn-task-modal__hermes-thread-card--structured)"
		);
		expect(plainComment).not.toBeNull();
		expect(plainComment!.textContent).toContain("yt");
		expect(plainComment!.textContent).toContain("Looks good to me — no Hermes payload here.");
		expect(plainComment!.textContent).not.toContain("View raw");
		expect(plainComment!.querySelector(".tn-task-modal__hermes-activity-action")).toBeNull();
	});

	it("renders non-pinned handoff comments as structured cards with raw content collapsed", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "peacock",
					body: [
						"handoff:",
						"```json",
						JSON.stringify({
							summary: "Implementation is ready for QA.",
							profile: "peacock",
							run_id: 139,
							changed_files: ["src/modals/TaskEditModal.ts", "styles/task-modal.css"],
							tests_passed: 12,
							tests_run: 12,
							diff_path: "/tmp/tasknotes-hermes.diff",
						}),
						"```",
					].join("\n"),
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
			runs: [],
			events: [],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const plugin = createPlugin(app);
		const modal = new TestTaskEditModal(app, plugin as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/default/t_activity.md",
			},
		});
		const { rightColumn } = renderHermesSections(modal);
		await flushPromises();

		const structuredCard = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-thread-card--structured"
		);
		expect(structuredCard).not.toBeNull();
		expect(structuredCard!.querySelector(".tn-task-modal__hermes-review-badge")).toBeNull();
		expect(structuredCard!.textContent).toContain("Agent handoff");
		expect(structuredCard!.textContent).toContain("Implementation is ready for QA.");
		expect(structuredCard!.textContent).not.toContain("Run");
		expect(structuredCard!.textContent).not.toContain("139");
		expect(structuredCard!.textContent).toContain("Changed files");
		expect(structuredCard!.textContent).toContain("2 files");
		expect(structuredCard!.textContent).toContain("Tests");
		expect(structuredCard!.textContent).toContain("12/12 passed");
		expect(structuredCard!.textContent).toContain("Open tasknotes-hermes.diff");
		expect(structuredCard!.textContent).toContain("View raw");
		expect(structuredCard!.textContent).not.toContain('"changed_files"');
		expect(structuredCard!.classList.contains("tn-task-modal__hermes-thread-card--openable")).toBe(true);
		expect(structuredCard!.getAttribute("aria-haspopup")).toBe("dialog");
		expect(structuredCard!.getAttribute("aria-expanded")).toBeNull();
		expect(
			structuredCard!.querySelectorAll(".tn-task-modal__hermes-activity-detail-row--overflow")
		).toHaveLength(1);

		const openSpy = jest.spyOn(Modal.prototype, "open");
		structuredCard!.click();
		expect(openSpy).toHaveBeenCalledTimes(1);
		const detailModal = openSpy.mock.instances[0] as Modal;
		expect(detailModal.contentEl.textContent).toContain("Agent handoff");
		expect(detailModal.contentEl.textContent).toContain("Run");
		expect(detailModal.contentEl.textContent).toContain("139");
		expect(detailModal.contentEl.textContent).toContain("Open tasknotes-hermes.diff");

		const diffAction = Array.from(
			structuredCard!.querySelectorAll<HTMLButtonElement>(
				".tn-task-modal__hermes-activity-action"
			)
		).find((action) => action.textContent?.includes("tasknotes-hermes.diff"));
		expect(diffAction).not.toBeUndefined();
		diffAction!.click();
		await Promise.resolve();
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith("/tmp/tasknotes-hermes.diff");

		structuredCard!.querySelector<HTMLButtonElement>(".tn-task-modal__hermes-raw-toggle")!.click();
		expect(structuredCard!.textContent).toContain('"changed_files"');
	});

	it("pins blocked task context even when no run history exists", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: {
				id: "t_activity",
				title: "Needs decision",
				status: "blocked",
				body: "Blocked: choose whether to merge this review-thread UI.",
			},
			comments: [],
			runs: [],
			events: [],
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

		const pinnedCard = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-review-card--pinned"
		);
		expect(pinnedCard).not.toBeNull();
		expect(pinnedCard!.textContent).toContain("Blocked: choose whether to merge");
		expect(pinnedCard!.textContent).not.toContain("No review activity yet");
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

	it("submits Hermes comments in-place without closing the modal", async () => {
		const initialDetail = { task: null, comments: [], runs: [], events: [] };
		const refreshedDetail = {
			task: null,
			comments: [
				{
					author: "tasknotes",
					body: "Modal stays open after comment.",
					created_at: Math.floor(new Date("2026-06-02T12:00:00.000Z").getTime() / 1000),
				},
			],
			runs: [],
			events: [],
		};
		const getTask = jest
			.spyOn(HermesKanbanApiClient.prototype, "getTask")
			.mockResolvedValueOnce(initialDetail)
			.mockResolvedValueOnce(initialDetail)
			.mockResolvedValue(refreshedDetail);
		const addComment = jest
			.spyOn(HermesKanbanApiClient.prototype, "addComment")
			.mockResolvedValue(undefined);
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
		});
		const forceClose = jest.spyOn(modal, "forceClose");
		jest.spyOn(
			modal as unknown as { hasUnsavedHermesModalChanges: () => boolean },
			"hasUnsavedHermesModalChanges"
		).mockReturnValue(false);
		const { rightColumn } = renderHermesSections(modal);
		await flushPromises();
		await flushPromises();

		const input = rightColumn.querySelector<HTMLTextAreaElement>(
			".tn-task-modal__hermes-comment-input"
		)!;
		const button = rightColumn.querySelector<HTMLButtonElement>(
			"button[aria-label='Send comment']"
		)!;
		input.value = "Modal stays open after comment.";
		input.dispatchEvent(new Event("input"));
		await (modal as unknown as {
			handleHermesCommentSubmit: (
				input: HTMLTextAreaElement,
				button: HTMLButtonElement
			) => Promise<void>;
		}).handleHermesCommentSubmit(input, button);
		await flushPromises();

		expect(addComment).toHaveBeenCalledWith(
			{ board: "default", id: "t_activity" },
			{ body: "Modal stays open after comment.", author: "tasknotes" }
		);
		expect(getTask).toHaveBeenCalledWith({ board: "default", id: "t_activity" });
		expect(rightColumn.textContent).toContain("Modal stays open after comment.");
		expect(input.value).toBe("");
		expect(input.disabled).toBe(false);
		expect(button.disabled).toBe(true);
		expect(forceClose).not.toHaveBeenCalled();
	});

	it("clears the Hermes comment composer after a sent comment even if refresh fails", async () => {
		jest
			.spyOn(HermesKanbanApiClient.prototype, "getTask")
			.mockResolvedValueOnce({ task: null, comments: [], runs: [], events: [] })
			.mockResolvedValueOnce({ task: null, comments: [], runs: [], events: [] })
			.mockRejectedValue(new Error("refresh unavailable"));
		const addComment = jest
			.spyOn(HermesKanbanApiClient.prototype, "addComment")
			.mockResolvedValue(undefined);
		const app = MockObsidian.createMockApp() as unknown as App;
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
		});
		const forceClose = jest.spyOn(modal, "forceClose");
		jest.spyOn(
			modal as unknown as { hasUnsavedHermesModalChanges: () => boolean },
			"hasUnsavedHermesModalChanges"
		).mockReturnValue(false);
		const { rightColumn } = renderHermesSections(modal);
		await flushPromises();
		await flushPromises();

		const input = rightColumn.querySelector<HTMLTextAreaElement>(
			".tn-task-modal__hermes-comment-input"
		)!;
		const button = rightColumn.querySelector<HTMLButtonElement>(
			"button[aria-label='Send comment']"
		)!;
		input.value = "Already persisted before refresh failed.";
		await (modal as unknown as {
			handleHermesCommentSubmit: (
				input: HTMLTextAreaElement,
				button: HTMLButtonElement
			) => Promise<void>;
		}).handleHermesCommentSubmit(input, button);

		expect(addComment).toHaveBeenCalledWith(
			{ board: "default", id: "t_activity" },
			{ body: "Already persisted before refresh failed.", author: "tasknotes" }
		);
		expect(input.value).toBe("");
		expect(input.disabled).toBe(false);
		expect(button.disabled).toBe(true);
		expect(forceClose).not.toHaveBeenCalled();
	});

	it("shows live Hermes availability and keeps live comment controls enabled", async () => {
		jest.spyOn(HermesAvailabilityService.prototype, "recheckHealth").mockResolvedValue(
			hermesHealth({ status: "connected", mode: "live", canStart: true })
		);
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [],
			events: [],
		});
			const app = MockObsidian.createMockApp() as unknown as App;
			const task = createHermesTask();
			const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
				task,
			});
			modal.setFormStateForTest(task);
			modal.renderContentForTest();

			await flushPromises();

			const footer = getHermesFooter(modal);
			expect(footer.textContent).toContain("Hermes live");
			expect(footer.textContent).toContain("Connected");
			expect(footer.querySelector(".tn-task-modal__hermes-availability-chip")).not.toBeNull();
			expect(
				modal.contentEl.querySelector(".modal-split-left .tn-task-modal__hermes-availability")
			).toBeNull();
			expect(footer.textContent).not.toContain("Live board, profile, status");
			expect(modal.contentEl.textContent).not.toContain("Cache only");
			expect(
				modal.contentEl.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
					?.disabled
			).toBe(false);
		});

	it("labels cached Hermes mirrors, disables live controls, and offers desktop startup when disconnected", async () => {
		jest.spyOn(HermesAvailabilityService.prototype, "recheckHealth").mockResolvedValue(
			hermesHealth({
				status: "disconnected",
				mode: "cache-only",
				canStart: true,
				message: "Hermes dashboard is not reachable at http://127.0.0.1:9119/.",
			})
		);
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockRejectedValue(
			new Error("offline")
			);
			const app = MockObsidian.createMockApp() as unknown as App;
			const task = createHermesTask();
			const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
				task,
			});
			modal.setFormStateForTest(task);
			modal.renderContentForTest();

			await flushPromises();

			const footer = getHermesFooter(modal);
			expect(footer.textContent).toContain("Cache only");
			expect(footer.textContent).toContain("Disconnected");
			expect(footer.textContent).not.toContain(HERMES_DASHBOARD_START_COMMAND);
			expect(footer.textContent).toContain("Start");
			expect(footer.textContent).not.toContain("Start Hermes");
			expect(footer.textContent).toContain("Recheck");
			expect(modal.contentEl.textContent).toContain("Cached Hermes activity");
			expect(modal.contentEl.textContent).toContain("Review thread (cache-only)");
			expect(
				modal.contentEl.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
					?.disabled
			).toBe(true);
			expect(
				modal.contentEl.querySelector<HTMLButtonElement>("button[aria-label='Send comment']")
					?.disabled
			).toBe(true);
		});

	it("starts Hermes from the modal, rechecks health, and reloads live activity", async () => {
		const recheckHealth = jest
			.spyOn(HermesAvailabilityService.prototype, "recheckHealth")
			.mockResolvedValueOnce(
				hermesHealth({ status: "disconnected", mode: "cache-only", canStart: true })
			)
			.mockResolvedValue(hermesHealth({ status: "connected", mode: "live", canStart: true }));
		const startDashboard = jest.spyOn(HermesAvailabilityService.prototype, "startDashboard").mockResolvedValue({
			started: true,
			pid: 123,
			command: HERMES_DASHBOARD_START_COMMAND,
			health: hermesHealth({ status: "connected", mode: "live", canStart: true }),
		});
		const getTask = jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [{ author: "peacock", body: "Live comment", created_at: 1780430000 }],
			runs: [],
			events: [],
			});
			const app = MockObsidian.createMockApp() as unknown as App;
			const task = createHermesTask();
			const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
				task,
			});
			modal.setFormStateForTest(task);
			modal.renderContentForTest();
			await flushPromises();

			const footer = getHermesFooter(modal);
			footer.querySelector<HTMLButtonElement>("button[aria-label='Start Hermes dashboard']")!.click();
			await flushPromises();

			expect(startDashboard).toHaveBeenCalledTimes(1);
			expect(recheckHealth).toHaveBeenCalledTimes(2);
			expect(getTask).toHaveBeenCalled();
			expect(footer.textContent).toContain("Hermes live");
			expect(modal.contentEl.textContent).toContain("Live comment");
			expect(
				modal.contentEl.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
					?.disabled
			).toBe(false);
		});

	it("pins the Hermes composer while only the thread cards scroll", () => {
		const cssContent = fs.readFileSync(cssFilePath, "utf-8");
		const rightPanelBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin.minimalist-task-modal.split-layout-enabled.expanded .modal-split-right.modal-split-right--with-readonly"
		);
		const reviewThreadBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-review-thread"
		);
		const threadListBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-list"
		);
		const specificThreadListBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .task-projects-list.tn-task-modal__hermes-comment-list.tn-task-modal__hermes-thread-list"
		);
		const composerBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-composer"
		);
		const detailsEditorBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin.minimalist-task-modal.split-layout-enabled.expanded .modal-split-right.modal-split-right--with-readonly .tn-task-modal__markdown-editor--details"
		);

		expect(rightPanelBlock).toContain("overflow: hidden");
		expect(reviewThreadBlock).toContain("display: flex");
		expect(reviewThreadBlock).toContain("flex-direction: column");
		expect(reviewThreadBlock).toContain("overflow: hidden");
		expect(threadListBlock).toContain("flex: 1 1 auto");
		expect(threadListBlock).toContain("overflow-y: auto");
		expect(specificThreadListBlock).toContain("overflow-y: auto");
		expect(specificThreadListBlock).toContain("overflow-x: hidden");
		expect(composerBlock).toContain("flex: 0 0 auto");
		expect(detailsEditorBlock).toContain("flex: 0 0 auto");
		expect(detailsEditorBlock).toContain("max-height: min(40vh, 360px)");
	});

	it("styles status updates as compact log rows", () => {
		const cssContent = fs.readFileSync(cssFilePath, "utf-8");
		const statusItemBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-status-item"
		);
		const statusIndicatorBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-status-indicator"
		);
		const threadListBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-list"
		);
		const threadCardBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-card"
		);
		const activityBodyBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-activity-body"
		);
		const structuredBodyBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-body--structured"
		);
		const activityOpenableBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-activity-card--openable"
		);
		const threadOpenableBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-card--openable"
		);
		const detailModalContentBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-activity-detail-modal-content"
		);

		expect(statusItemBlock).toContain("display: grid");
		expect(statusItemBlock).toContain("grid-template-columns: 22px minmax(0, 1fr)");
		expect(statusItemBlock).toContain("padding: var(--size-2-1) var(--size-4-2)");
		expect(statusIndicatorBlock).toContain("border-radius: 50%");
		expect(statusIndicatorBlock).toContain("height: 10px");
		expect(threadListBlock).toContain("gap: var(--size-2-2)");
		expect(threadCardBlock).toContain("grid-template-columns: 22px minmax(0, 1fr)");
		expect(threadCardBlock).toContain("padding: var(--size-2-2) var(--size-4-2)");
		expect(activityBodyBlock).toContain("-webkit-line-clamp: 2");
		expect(structuredBodyBlock).toContain("-webkit-line-clamp: 2");
		expect(activityOpenableBlock).toContain("cursor: pointer");
		expect(threadOpenableBlock).toContain("cursor: pointer");
		expect(detailModalContentBlock).toContain("max-height: min(72vh, 760px)");
		expect(detailModalContentBlock).toContain("overflow: auto");
		expect(cssContent).toContain("tn-task-modal__hermes-activity-detail-row--overflow");
		expect(cssContent).toContain("tn-task-modal__hermes-activity-action--overflow");
		expect(cssContent).toContain("tn-task-modal__hermes-activity-overflow-summary");
		expect(
			cssContent.lastIndexOf(
				".tasknotes-plugin .tn-task-modal__hermes-activity-detail-row--overflow"
			)
		).toBeGreaterThan(
			cssContent.indexOf(
				".tasknotes-plugin .tn-task-modal__hermes-activity-detail-row {"
			)
		);
	});
	});

function getHermesFooter(modal: TestTaskEditModal): HTMLElement {
	return modal.contentEl.querySelector<HTMLElement>(".tn-task-modal__button-bar--hermes-live")!;
}

function renderHermesSections(modal: TestTaskEditModal): {
	leftColumn: HTMLElement;
	detailsContainer: HTMLElement;
	rightColumn: HTMLElement;
} {
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
	return { leftColumn, detailsContainer, rightColumn };
}

function hermesHealth(overrides: Partial<HermesAvailabilityHealth>): HermesAvailabilityHealth {
	return {
		status: "connected",
		mode: "live",
		rootUrl: "http://127.0.0.1:9119/",
		apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
		canStart: true,
		...overrides,
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function extractCssBlock(css: string, selector: string): string {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`${escapedSelector}\\s*\\{([^}]*?)\\}`, "s");
	const match = css.match(regex);
	return match ? match[1] : "";
}
