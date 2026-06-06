import * as fs from "fs";
import * as path from "path";
import { Modal, type App } from "obsidian";
import { HermesApiError, HermesKanbanApiClient } from "../../../src/hermes/hermesApiClient";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
} from "../../../src/hermes/hermesAvailabilityService";
import {
	HERMES_ACTIVITY_FIELD_KEYS,
	HERMES_ACTIVITY_USER_FIELDS,
} from "../../../src/hermes/hermesActivityFrontmatter";
import { TaskEditModal } from "../../../src/modals/TaskEditModal";
import type { TaskInfo } from "../../../src/types";
import type { ModalFieldConfig, TaskModalFieldsConfig } from "../../../src/types/settings";
import { createDefaultFieldConfig } from "../../../src/utils/fieldConfigDefaults";
import { MockObsidian } from "../../__mocks__/obsidian";

jest.mock("obsidian");

const cssFilePath = path.resolve(__dirname, "../../../styles/task-modal.css");

type ModalFieldOverride = Partial<ModalFieldConfig> & { id: string };

function createModalFieldsConfig(
	overrides: readonly ModalFieldOverride[] = []
): TaskModalFieldsConfig {
	const config = createDefaultFieldConfig();
	for (const override of overrides) {
		const fieldIndex = config.fields.findIndex((field) => field.id === override.id);
		if (fieldIndex >= 0) {
			config.fields[fieldIndex] = {
				...config.fields[fieldIndex],
				...override,
			};
		}
	}
	return config;
}

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

	async refreshTaskDataForTest(): Promise<void> {
		await (this as unknown as { refreshTaskData: () => Promise<void> }).refreshTaskData();
	}

	getTaskForTest(): TaskInfo {
		return this.task;
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

function createPlugin(app: App, overrides: Record<string, unknown> = {}) {
	const plugin = {
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
			getCompletedStatuses: jest.fn(() => ["done"]),
			getNextStatus: jest.fn(() => "open"),
			getStatusConfig: jest.fn((status: string) => ({
				value: status,
				label: status,
				color: status === "done" ? "#16a34a" : "#9ca3af",
			})),
		},
		priorityManager: {
			getPriorityConfig: jest.fn((priority: string | undefined) => ({
				value: priority ?? "normal",
				label: priority ?? "normal",
				color: "#cccccc",
			})),
		},
		cacheManager: {
			getTaskInfo: jest.fn(),
			getTaskInfoFromFrontmatter: jest.fn().mockResolvedValue(null),
			isTaskFile: jest.fn(() => true),
		},
		fieldMapper: {
			toUserField: jest.fn((key: string) => key),
			getMapping: jest.fn(() => ({
				status: "status",
				priority: "priority",
				projects: "projects",
				contexts: "contexts",
				due: "due",
				scheduled: "scheduled",
			})),
			isPropertyForField: jest.fn((propertyId: string, internalField: string) =>
				propertyId === internalField
			),
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
			ensureHermesDashboardRunning: jest.fn(
				async (options?: { force?: boolean }) =>
					options?.force
						? new HermesAvailabilityService().startDashboard()
						: {
								started: false,
								command: HERMES_DASHBOARD_START_COMMAND,
								health: await new HermesAvailabilityService().recheckHealth(),
					}
			),
			getActiveTimeSession: jest.fn(() => null),
		};
	return Object.assign(plugin, overrides);
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
				modalFieldsConfig: createModalFieldsConfig(),
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
			expect(modal.contentEl.textContent).toContain("modals.task.detailsLabel");
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
				modalFieldsConfig: createModalFieldsConfig(),
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

	it("renders Hermes task titles as read-only context", async () => {
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
				modalFieldsConfig: createModalFieldsConfig(),
			});
		const forceClose = jest.spyOn(modal, "forceClose");
		modal.setFormStateForTest(task);
		modal.renderContentForTest();

		expect(modal.contentEl.querySelector(".title-input-detailed")).toBeNull();
		expect(
			modal.contentEl.querySelector(".tn-task-modal__hermes-readonly-title")?.textContent
		).toBe(task.title);
		expect(
			modal.contentEl.querySelector(".tn-task-modal__hermes-readonly-tag")?.textContent
		).toBe("#hermes-kanban");
		expect(
			modal.contentEl.querySelector(".tn-task-modal__hermes-readonly-tags-setting input")
		).toBeNull();
		expect(
			(modal as unknown as { getChanges: () => Partial<TaskInfo> }).getChanges()
		).not.toHaveProperty("title");

		expect(plugin.taskService.updateTask).not.toHaveBeenCalled();
		expect(updateTask).not.toHaveBeenCalled();
		expect(forceClose).not.toHaveBeenCalled();
	});

	it("refreshes Hermes modal state from note frontmatter before using pending cache data", async () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const path = "TaskNotes/default/t_activity.md";
		MockObsidian.createTestFile(
			path,
			[
				"---",
				"title: Fresh frontmatter title",
				"status: done",
				"tags:",
				"  - task",
				"  - hermes-kanban",
				"projects:",
				"  - Hermes/default",
				"---",
				"",
				"Fresh body details.",
			].join("\n")
		);
		const staleTask = {
			...createHermesTask(),
			path,
			title: "Stale pending title",
			status: "in-progress",
		};
		const freshTask = {
			...staleTask,
			title: "Fresh frontmatter title",
			status: "done",
			projects: ["Hermes/default"],
			tags: ["task", "hermes-kanban"],
		};
		const plugin = createPlugin(app);
		plugin.cacheManager.getTaskInfoFromFrontmatter.mockResolvedValue(freshTask);
		plugin.cacheManager.getTaskInfo.mockResolvedValue(staleTask);
		const modal = new TestTaskEditModal(app, plugin as never, { task: staleTask });

		await modal.refreshTaskDataForTest();

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(path);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(modal.getTaskForTest()).toMatchObject({
			title: "Fresh frontmatter title",
			status: "done",
			details: "Fresh body details.",
		});
	});

	it("refreshes standard task modal state from note frontmatter before pending cache data", async () => {
		const app = MockObsidian.createMockApp() as unknown as App;
		const path = "Tasks/plain.md";
		MockObsidian.createTestFile(
			path,
			[
				"---",
				"title: Fresh standard title",
				"status: done",
				"tags:",
				"  - task",
				"---",
				"",
				"Fresh standard details.",
			].join("\n")
		);
		const staleTask = {
			...createHermesTask(),
			path,
			title: "Stale pending title",
			status: "in-progress",
			tags: ["task"],
		};
		const freshTask = {
			...staleTask,
			title: "Fresh standard title",
			status: "done",
		};
		const plugin = createPlugin(app);
		plugin.cacheManager.getTaskInfoFromFrontmatter.mockResolvedValue(freshTask);
		plugin.cacheManager.getTaskInfo.mockResolvedValue(staleTask);
		const modal = new TestTaskEditModal(app, plugin as never, { task: staleTask });

		await modal.refreshTaskDataForTest();

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(path);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(modal.getTaskForTest()).toMatchObject({
			title: "Fresh standard title",
			status: "done",
			details: "Fresh standard details.",
		});
	});

	it("keeps tasks without board identity on the standard icon set", () => {
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
		expect(rightColumn.textContent).toContain("Activity");
		expect(rightColumn.textContent).toContain("orchestrator");
		expect(rightColumn.querySelector(".tn-task-modal__hermes-composer")).not.toBeNull();
		const commentInput = rightColumn.querySelector<HTMLTextAreaElement>(
			".tn-task-modal__hermes-composer .modal-form__input"
		);
		expect(commentInput).not.toBeNull();
		expect(commentInput!.placeholder).toBe("Add a review comment...");
		expect(commentInput!.placeholder).not.toContain("Shift+Enter");
		expect(
			rightColumn.querySelector(".tn-task-modal__hermes-composer button[aria-label='Send comment']")
		).not.toBeNull();
		expect(
			rightColumn
				.querySelector(".tn-task-modal__hermes-composer button[aria-label='Send comment']")
				?.classList.contains("clickable-icon")
		).toBe(true);
		expect(rightColumn.querySelector(".tn-task-modal__hermes-thread-card.task-card")).not.toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-thread-avatar")).toBeNull();
		expect(rightColumn.textContent).toContain("Event payload summary");
		expect(rightColumn.textContent).not.toContain("Status update");
		expect(rightColumn.textContent).not.toContain("Run history");
		expect(rightColumn.textContent).not.toContain("Events");
		expect(rightColumn.textContent).not.toContain("Worker log");
		expect(leftColumn.textContent).not.toContain("Task Information");
		expect(detailsContainer.querySelector(".task-card__status-dot")).toBeNull();
		expect(
			rightColumn.querySelector(
				".tn-task-modal__hermes-status-toggle .task-card__status-dot"
			)
		).not.toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-expand")).toBeNull();
	});

		it("hides the activity rail when all Activity fields are disabled in Modal Fields", () => {
			const app = MockObsidian.createMockApp() as unknown as App;
			const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
				task: createHermesTask(),
				modalFieldsConfig: createModalFieldsConfig(
					HERMES_ACTIVITY_USER_FIELDS.map((field) => ({
						id: field.id,
						enabled: false,
						visibleInEdit: true,
					}))
				),
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

		it("hides comments while preserving other enabled Activity fields", () => {
			const app = MockObsidian.createMockApp() as unknown as App;
			const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
				task: createHermesTask(),
				modalFieldsConfig: createModalFieldsConfig([
					{
						id: HERMES_ACTIVITY_FIELD_KEYS.comments,
						enabled: false,
						visibleInEdit: true,
					},
				]),
			});
		const { rightColumn } = renderHermesSections(modal);

		expect(rightColumn.querySelector(".tn-task-modal__hermes-review-thread")).not.toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-composer")).toBeNull();
		expect(rightColumn.textContent).not.toContain("orchestrator");
		expect(rightColumn.textContent).not.toContain("Looks good.");
		expect(rightColumn.textContent).toContain("Event payload summary");
	});

	it("respects Title and Details Modal Fields settings in task edit modals", () => {
			const app = MockObsidian.createMockApp() as unknown as App;
			const task = createHermesTask();
			const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
				task,
				modalFieldsConfig: createModalFieldsConfig([
					{
						id: "title",
						enabled: false,
						visibleInEdit: true,
					},
					{
						id: "details",
						enabled: true,
						visibleInEdit: true,
					},
					...HERMES_ACTIVITY_USER_FIELDS.map((field) => ({
						id: field.id,
						enabled: false,
						visibleInEdit: true,
					})),
				]),
			});
		modal.setFormStateForTest(task);

		modal.renderContentForTest();

		expect(modal.contentEl.textContent).not.toContain("modals.task.titleLabel");
		expect(modal.contentEl.querySelector(".title-input-detailed")).toBeNull();
		expect(modal.contentEl.textContent).toContain("modals.task.detailsLabel");
		expect(modal.contentEl.textContent).not.toContain("Activity");
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
			".tn-task-modal__hermes-activity-card--status.task-card"
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
		expect(rightColumn.textContent).toContain("Run 12 - reviewer-qa - blocked");
		expect(rightColumn.textContent).not.toContain("Cached YAML event summary.");
		expect(rightColumn.textContent).not.toContain("No activity yet.");
	});

	it("keeps linked cached run artifacts as a tray when the live activity payload has no runs", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [],
			events: [],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		MockObsidian.createTestFile(
			"TaskNotes/default/activity/runs/run142.md",
			[
				"---",
				"type: hermes-run",
				'runId: "142"',
				"profile: peacock",
				"status: blocked",
				"outcome: blocked",
				"summary: Cached run note summary with artifact evidence.",
				'endedAt: "2026-06-02T11:00:00.000Z"',
				"artifacts:",
				"  - _Artifacts/hermes-review.md",
				"changedFiles:",
				"  - src/modals/TaskEditModal.ts",
				"  - styles/task-modal.css",
				"---",
				"",
				"# Raw run",
			].join("\n")
		);
		(
			app.metadataCache as unknown as {
				setCache: (path: string, metadata: { frontmatter: Record<string, unknown> }) => void;
			}
		).setCache("TaskNotes/default/activity/runs/run142.md", {
			frontmatter: {
				type: "hermes-run",
				runId: "142",
				profile: "peacock",
				status: "blocked",
				outcome: "blocked",
				summary: "Cached run note summary with artifact evidence.",
				endedAt: "2026-06-02T11:00:00.000Z",
				artifacts: ["_Artifacts/hermes-review.md"],
				changedFiles: ["src/modals/TaskEditModal.ts", "styles/task-modal.css"],
			},
		});
		expect(
			(
				app.metadataCache as unknown as {
					getCache: (path: string) => { frontmatter?: Record<string, unknown> } | null;
				}
			).getCache("TaskNotes/default/activity/runs/run142.md")?.frontmatter?.summary
		).toBe("Cached run note summary with artifact evidence.");
		const plugin = createPlugin(app);
		const task = {
			...createHermesTask(),
			details: "",
			customProperties: {
				[HERMES_ACTIVITY_FIELD_KEYS.runs]: [
					"[[TaskNotes/default/activity/runs/run142|Run 142]]",
				],
			},
		};
		const modal = new TestTaskEditModal(app, plugin as never, { task });
		const { rightColumn } = renderHermesSections(modal);

		await flushPromises();

		const artifactTray = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-artifact-tray"
		);
		expect(artifactTray).not.toBeNull();
		expect(artifactTray!.getAttribute("aria-label")).toBe("Linked artifacts tray");
		expect(artifactTray!.textContent).toContain("Artifacts");
		expect(artifactTray!.textContent).toContain("3 linked artifacts");
		expect(artifactTray!.textContent).toContain("hermes-review.md");
		expect(artifactTray!.textContent).toContain("_Artifacts/hermes-review.md");
		expect(artifactTray!.textContent).toContain("TaskEditModal.ts");
		expect(rightColumn.querySelector(".tn-task-modal__hermes-run-card.task-card")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-drawer-toggle")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-drawer")).toBeNull();
		const artifactButton = Array.from(
			artifactTray!.querySelectorAll<HTMLButtonElement>(
				".tn-task-modal__hermes-artifact-open"
			)
		).find((button) => button.getAttribute("aria-label")?.includes("hermes-review.md"));
		expect(artifactButton).not.toBeUndefined();
		artifactButton!.click();
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith("_Artifacts/hermes-review.md");
	});

	it("hydrates cached activity from the primary Hermes activity feed", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [],
			events: [],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		MockObsidian.createTestFile(
			"TaskNotes/default/activity/comments/t_activity-comment11.md",
			[
				"---",
				"type: hermes-comment",
				"hermesCommentId: 11",
				"hermesCommentAuthor: orchestrator",
				"hermesCommentSummary: Feed-backed summary fallback.",
				'hermesCommentCreatedAt: "2026-06-02T10:00:00.000Z"',
				"---",
				"",
				"Full markdown comment body from linked note.",
			].join("\n")
		);
		MockObsidian.createTestFile(
			"TaskNotes/default/activity/runs/t_activity-run142.md",
			[
				"---",
				"type: hermes-run",
				"hermesRunId: 142",
				"hermesRunProfile: peacock",
				"hermesRunStatus: blocked",
				"hermesRunOutcome: blocked",
				"hermesRunSummary: Feed-backed run card summary.",
				'hermesRunEndedAt: "2026-06-02T11:00:00.000Z"',
				"hermesRunArtifacts:",
				"  - '[[TaskNotes/default/activity/artifacts/t_activity-run142-feed-review|feed-review.md]]'",
				"---",
			].join("\n")
		);
		MockObsidian.createTestFile(
			"TaskNotes/default/activity/artifacts/t_activity-run142-feed-review.md",
			[
				"---",
				"type: hermes-artifact",
				"hermesArtifactLabel: feed-review.md",
				"hermesArtifactStoredPath: _Artifacts/feed-review.md",
				"---",
			].join("\n")
		);
		(
			app.metadataCache as unknown as {
				setCache: (path: string, metadata: { frontmatter: Record<string, unknown> }) => void;
			}
		).setCache("TaskNotes/default/activity/comments/t_activity-comment11.md", {
			frontmatter: {
				type: "hermes-comment",
				hermesCommentId: "11",
				hermesCommentAuthor: "orchestrator",
				hermesCommentSummary: "Feed-backed summary fallback.",
				hermesCommentCreatedAt: "2026-06-02T10:00:00.000Z",
			},
		});
		(
			app.metadataCache as unknown as {
				setCache: (path: string, metadata: { frontmatter: Record<string, unknown> }) => void;
			}
		).setCache("TaskNotes/default/activity/runs/t_activity-run142.md", {
			frontmatter: {
				type: "hermes-run",
				hermesRunId: "142",
				hermesRunProfile: "peacock",
				hermesRunStatus: "blocked",
				hermesRunOutcome: "blocked",
				hermesRunSummary: "Feed-backed run card summary.",
				hermesRunEndedAt: "2026-06-02T11:00:00.000Z",
				hermesRunArtifacts: [
					"[[TaskNotes/default/activity/artifacts/t_activity-run142-feed-review|feed-review.md]]",
				],
			},
		});
		(
			app.metadataCache as unknown as {
				setCache: (path: string, metadata: { frontmatter: Record<string, unknown> }) => void;
			}
		).setCache("TaskNotes/default/activity/artifacts/t_activity-run142-feed-review.md", {
			frontmatter: {
				type: "hermes-artifact",
				hermesArtifactLabel: "feed-review.md",
				hermesArtifactStoredPath: "_Artifacts/feed-review.md",
			},
		});
		const plugin = createPlugin(app);
		const task = {
			...createHermesTask(),
			details: "",
			customProperties: {
				[HERMES_ACTIVITY_FIELD_KEYS.feed]: [
					"[[TaskNotes/default/activity/comments/t_activity-comment11|Comment 11]]",
					"[[TaskNotes/default/activity/runs/t_activity-run142|Run 142]]",
				],
			},
		};
		const modal = new TestTaskEditModal(app, plugin as never, { task });
		const { rightColumn } = renderHermesSections(modal);

		await flushPromises();

		expect(rightColumn.textContent).toContain("Full markdown comment body from linked note.");
		expect(rightColumn.textContent).not.toContain("Feed-backed summary fallback.");
		const artifactTray = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-artifact-tray"
		);
		expect(artifactTray).not.toBeNull();
		expect(artifactTray!.textContent).toContain("Artifacts");
		expect(artifactTray!.textContent).toContain("feed-review.md");
		expect(artifactTray!.textContent).toContain("_Artifacts/feed-review.md");
		expect(rightColumn.querySelector(".tn-task-modal__hermes-run-card.task-card")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-drawer-toggle")).toBeNull();
		const artifactAction = Array.from(
			artifactTray!.querySelectorAll<HTMLButtonElement>(".tn-task-modal__hermes-artifact-open")
		).find((button) => button.textContent?.includes("feed-review.md"));
		expect(artifactAction).not.toBeUndefined();
		artifactAction!.click();
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith("_Artifacts/feed-review.md");
		expect(rightColumn.textContent).not.toContain("No activity yet.");
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
						created_at: Math.floor((Date.now() - 36 * 60 * 60 * 1000) / 1000),
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
		await flushPromises();

		expect(rightColumn.textContent).toContain("orchestrator");
		expect(rightColumn.textContent).toContain("5 mins ago");
		expect(rightColumn.textContent).toContain("1 hour ago");
		expect(rightColumn.textContent).not.toContain("Event payload.");
		expect(detailsContainer.textContent).not.toContain("Jun");
		expect(rightColumn.textContent).not.toContain("Jun");
	});

	it("renders Hermes run artifacts as a simple tray without run-card drawers", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [],
			runs: [
				{
					id: 146,
					profile: "peacock",
					status: "review_required",
					summary: "Completed parser/card pass and kept raw preservation intact.",
					ended_at: Math.floor(new Date("2026-06-02T11:00:00.000Z").getTime() / 1000),
					metadata: {
						changed_files: [
							"src/modals/TaskEditModal.ts",
							"styles/task-modal.css",
						],
						artifacts: ["/tmp/hermes-review-thread-card-qa-report.md"],
					},
				},
			],
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

		expect(rightColumn.querySelector(".tn-task-modal__hermes-run-card.task-card")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-drawer-toggle")).toBeNull();
		expect(rightColumn.querySelector(".tn-task-modal__hermes-activity-drawer")).toBeNull();
		const artifactTray = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-artifact-tray"
		);
		expect(artifactTray).not.toBeNull();
		expect(artifactTray!.getAttribute("aria-label")).toBe("Linked artifacts tray");
		expect(artifactTray!.textContent).toContain("Artifacts");
		expect(artifactTray!.textContent).toContain("3 linked artifacts");
		expect(artifactTray!.textContent).toContain("TaskEditModal.ts");
		expect(artifactTray!.textContent).toContain("styles/task-modal.css");
		expect(artifactTray!.textContent).toContain("hermes-review-thread-card-qa-report.md");
		expect(
			artifactTray!.querySelectorAll(".tn-task-modal__hermes-artifact-row")
		).toHaveLength(3);

		const artifactButton = Array.from(
			artifactTray!.querySelectorAll<HTMLButtonElement>(".tn-task-modal__hermes-artifact-open")
		).find((button) => button.textContent?.includes("qa-report.md"));
		expect(artifactButton).not.toBeUndefined();
		artifactButton!.click();
		await flushPromises();
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith(
			"/tmp/hermes-review-thread-card-qa-report.md"
		);
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
		expect(threadList.querySelector(".tn-task-modal__hermes-status-indicator")).toBeNull();
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
			visibleCards[visibleCards.length - 2].querySelector(
				".tn-task-modal__hermes-activity-card--status.task-card"
			)
		).not.toBeNull();
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
		await flushPromises();

		expect(rightColumn.textContent).toContain("Completed");
		expect(rightColumn.textContent).toContain("Root triage/synthesis is complete.");
		expect(rightColumn.textContent).toContain("+Hermes/default");
		expect(
			rightColumn.querySelector(".tn-task-modal__hermes-activity-card .task-card__title")
		).toBeNull();
		expect(
			rightColumn.querySelector(".tn-task-modal__hermes-status-pill--success")
		).toBeNull();
		expect(
			rightColumn.querySelector(
				".tn-task-modal__hermes-status-toggle .tn-task-modal__hermes-run-status-dot--success"
			)
		).not.toBeNull();
		expect(
			rightColumn.querySelector(".tn-task-modal__hermes-activity-drawer[data-drawer='signals']")
		).not.toBeNull();
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
		await flushPromises();

		const pinnedCard = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-review-card--pinned"
		);
		expect(pinnedCard).not.toBeNull();
		expect(pinnedCard!.querySelector(".tn-task-modal__hermes-review-badge")).toBeNull();
		expect(pinnedCard!.classList.contains("tn-task-modal__hermes-activity-card--openable")).toBe(true);
		expect(pinnedCard!.getAttribute("aria-haspopup")).toBe("dialog");
		expect(pinnedCard!.getAttribute("aria-expanded")).toBeNull();
		expect(pinnedCard!.querySelector(".task-card__title")).toBeNull();
		expect(pinnedCard!.querySelector(".tn-task-modal__hermes-activity-label")).toBeNull();
		expect(pinnedCard!.querySelector(".tn-task-modal__hermes-comment-avatar")).not.toBeNull();
		expect(pinnedCard!.textContent).toContain("+Hermes/default");
		expect(pinnedCard!.querySelector(".task-card__metadata-property--projects")?.textContent).toBe(
			"+Hermes/default"
		);
		expect(pinnedCard!.querySelector(".context-tag")?.textContent).toBe("@peacock");
			expect(
				pinnedCard!.querySelector(".tn-task-modal__hermes-activity-time")?.textContent
			).toContain("ago");
		expect(pinnedCard!.textContent).toContain("Pinned");
		expect(pinnedCard!.textContent).toContain("comments live in right rail");
		expect(pinnedCard!.textContent).not.toContain("Changed files");
		expect(pinnedCard!.textContent).not.toContain("Tests run");
		expect(pinnedCard!.textContent).not.toContain("Open review.md");
		expect(pinnedCard!.querySelector(".tn-task-modal__hermes-activity-details")).toBeNull();
		expect(pinnedCard!.querySelector(".tn-task-modal__hermes-activity-action")).toBeNull();
		expect(pinnedCard!.querySelector(".tn-task-modal__hermes-raw-toggle")).toBeNull();
		expect(pinnedCard!.textContent).not.toContain('"changed_files"');
		expect(
			pinnedCard!.querySelectorAll(".tn-task-modal__hermes-activity-detail-row--overflow")
		).toHaveLength(0);

		const openSpy = jest.spyOn(Modal.prototype, "open");
		pinnedCard!.click();
		expect(openSpy).toHaveBeenCalledTimes(1);
		const detailModal = openSpy.mock.instances[0] as Modal;
		expect(detailModal.contentEl.textContent).toContain("Review required");
		expect(detailModal.contentEl.textContent).toContain("Decisions");
		expect(detailModal.contentEl.textContent).toContain("Open review.md");
		expect(detailModal.contentEl.textContent).toContain("View raw");
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
		expect(structuredCard!.querySelector(".task-card__title")).toBeNull();
		expect(structuredCard!.querySelector(".tn-task-modal__hermes-activity-label")).toBeNull();
		expect(structuredCard!.querySelector(".tn-task-modal__hermes-comment-avatar")).not.toBeNull();
		expect(structuredCard!.textContent).toContain("Feature is implemented but needs review.");
		expect(structuredCard!.textContent).not.toContain("Changed files");
		expect(structuredCard!.textContent).not.toContain("Open review.md");
		expect(structuredCard!.textContent).not.toContain("Open review.pdf");
		expect(structuredCard!.textContent).not.toContain("View raw");
		expect(structuredCard!.querySelector(".tn-task-modal__hermes-activity-details")).toBeNull();
		expect(structuredCard!.querySelector(".tn-task-modal__hermes-activity-action")).toBeNull();
		expect(structuredCard!.textContent).not.toContain('"needs_review"');

		const openSpy = jest.spyOn(Modal.prototype, "open");
		structuredCard!.click();
		expect(openSpy).toHaveBeenCalledTimes(1);
		const detailModal = openSpy.mock.instances[0] as Modal;
		expect(detailModal.contentEl.textContent).toContain("Changed files");
		expect(detailModal.contentEl.textContent).toContain("1 file");
		expect(detailModal.contentEl.textContent).toContain("Open review.md");
		expect(detailModal.contentEl.textContent).toContain("Open review.pdf");
		expect(detailModal.contentEl.textContent).toContain("View raw");

		const artifactButtons = Array.from(
			detailModal.contentEl.querySelectorAll<HTMLButtonElement>(
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
		await flushPromises();
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith("/tmp/review.md");
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith(
			"https://example.com/review.pdf"
		);

		detailModal.contentEl.querySelector<HTMLButtonElement>(".tn-task-modal__hermes-raw-toggle")!.click();
		expect(detailModal.contentEl.textContent).toContain('"needs_review"');
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
		expect(plainComment!.classList.contains("task-card")).toBe(true);
		expect(plainComment!.querySelector(".tn-task-modal__hermes-comment-avatar")).not.toBeNull();
		expect(plainComment!.querySelector(".task-card__title")).toBeNull();
		expect(plainComment!.textContent).toContain("yt");
		expect(plainComment!.textContent).toContain("+Hermes/default");
		expect(plainComment!.querySelector(".context-tag")?.textContent).toBe("@yt");
		expect(plainComment!.textContent).toContain("Looks good to me — no Hermes payload here.");
		expect(plainComment!.textContent).not.toContain("View raw");
		expect(plainComment!.querySelector(".tn-task-modal__hermes-activity-action")).toBeNull();
		expect(plainComment!.querySelector(".tn-task-modal__hermes-thread-avatar")).toBeNull();
		expect(plainComment!.classList.contains("tn-task-modal__hermes-thread-card--openable")).toBe(true);

		const openSpy = jest.spyOn(Modal.prototype, "open");
		plainComment!.click();
		expect(openSpy).toHaveBeenCalledTimes(1);
		const detailModal = openSpy.mock.instances[0] as Modal;
		expect(detailModal.contentEl.textContent).toContain("Looks good to me — no Hermes payload here.");
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
		expect(structuredCard!.textContent).toContain("+Hermes/default");
		expect(structuredCard!.querySelector(".context-tag")?.textContent).toBe("@peacock");
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
		await flushPromises();
		expect(plugin.openHermesArtifactPath).toHaveBeenCalledWith("/tmp/tasknotes-hermes.diff");

		structuredCard!.querySelector<HTMLButtonElement>(".tn-task-modal__hermes-raw-toggle")!.click();
		expect(structuredCard!.textContent).toContain('"changed_files"');
	});

	it("hides duplicate child task action buttons when the child-task toggle is available", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "auto-decomposer",
					body: [
						"handoff:",
						"```json",
						JSON.stringify({
							summary: "Decomposed into child cards.",
							children: ["t_e775e4d5", "t_867d671a"],
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
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
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
		const bodyEl = structuredCard!.querySelector<HTMLElement>(
			".tn-task-modal__hermes-activity-body"
		);
		const metadataEl = structuredCard!.querySelector<HTMLElement>(".task-card__metadata");
		expect(bodyEl).not.toBeNull();
		expect(metadataEl).not.toBeNull();
		expect(
			Boolean(bodyEl!.compareDocumentPosition(metadataEl!) & Node.DOCUMENT_POSITION_FOLLOWING)
		).toBe(true);
		const childToggle = structuredCard!.querySelector<HTMLElement>(
			".tn-task-modal__hermes-child-toggle"
		);
		expect(childToggle).not.toBeNull();
		expect(childToggle!.dataset.count).toBe("2");
		expect(childToggle!.getAttribute("role")).toBe("button");
		expect(childToggle!.getAttribute("tabindex")).toBe("0");
		expect(childToggle!.closest(".task-card__badges")).not.toBeNull();
		expect(childToggle!.closest(".task-card__metadata")).toBeNull();
		expect(
			structuredCard!.querySelector(".tn-task-modal__hermes-activity-actions")
		).toBeNull();
		expect(structuredCard!.textContent).not.toContain("Edit t_e775e4d5");
		expect(structuredCard!.textContent).not.toContain("Edit t_867d671a");
	});

	it("expands Hermes child tasks from note frontmatter before pending cache data", async () => {
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [
				{
					author: "auto-decomposer",
					body: [
						"handoff:",
						"```json",
						JSON.stringify({
							summary: "Decomposed into child cards.",
							children: ["t_e775e4d5"],
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
		const frontmatterChild = {
			...createHermesTask(),
			path: "TaskNotes/default/t_e775e4d5.md",
			title: "Fresh frontmatter child",
			status: "done",
		};
		const stalePendingChild = {
			...frontmatterChild,
			title: "Stale pending child",
			status: "open",
		};
		const plugin = createPlugin(app);
		plugin.cacheManager.getTaskInfoFromFrontmatter.mockImplementation(async (path: string) =>
			path === frontmatterChild.path ? frontmatterChild : null
		);
		plugin.cacheManager.getTaskInfo.mockResolvedValue(stalePendingChild);
		const modal = new TestTaskEditModal(app, plugin as never, {
			task: {
				...createHermesTask(),
				path: "TaskNotes/default/t_activity.md",
			},
		});
		const { rightColumn } = renderHermesSections(modal);
		await flushPromises();

		plugin.cacheManager.getTaskInfoFromFrontmatter.mockClear();
		plugin.cacheManager.getTaskInfo.mockClear();
		const childToggle = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-child-toggle"
		);
		childToggle!.click();
		await flushPromises();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			frontmatterChild.path
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		const childTasks = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-child-tasks"
		);
		expect(childTasks).not.toBeNull();
		const childCard = childTasks!.querySelector<HTMLElement>(".task-card");
		expect(childCard).not.toBeNull();
		expect(childCard!.dataset.taskPath).toBe(frontmatterChild.path);
		expect(childCard!.dataset.status).toBe("done");
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
		await flushPromises();

		const pinnedCard = rightColumn.querySelector<HTMLElement>(
			".tn-task-modal__hermes-review-card--pinned"
		);
		expect(pinnedCard).not.toBeNull();
		expect(pinnedCard!.textContent).toContain("Blocked: choose whether to merge");
		expect(pinnedCard!.textContent).not.toContain("No activity yet");
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
		await flushPromises();

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
		await flushPromises();

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

	it("treats missing live Hermes tasks as stale local mirrors without warning", async () => {
		jest.spyOn(HermesAvailabilityService.prototype, "recheckHealth").mockResolvedValue(
			hermesHealth({ status: "connected", mode: "live", canStart: true })
		);
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockRejectedValue(
			new HermesApiError("task t_activity not found", 404, "Not Found")
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
		expect(footer.textContent).toContain("Hermes degraded");
		expect(footer.textContent).toContain("Degraded");
		expect(footer.textContent).toContain("cache-only");
		expect(modal.contentEl.textContent).toContain("Activity (cache-only)");
		expect(
			modal.contentEl.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
				?.disabled
		).toBe(true);
		expect(
			warn.mock.calls.some((call) =>
				call.some((value) => String(value).includes("Failed to load Hermes activity"))
			)
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
		const getTask = jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockRejectedValue(
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
			expect(modal.contentEl.textContent).toContain("Activity (cache-only)");
			expect(
				modal.contentEl.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
					?.disabled
			).toBe(true);
			expect(
				modal.contentEl.querySelector<HTMLButtonElement>("button[aria-label='Send comment']")
					?.disabled
			).toBe(true);
			expect(getTask).not.toHaveBeenCalled();
		});

	it("auto-starts Hermes before loading live activity when disconnected on open", async () => {
		jest.spyOn(HermesAvailabilityService.prototype, "recheckHealth").mockResolvedValue(
			hermesHealth({
				status: "disconnected",
				mode: "cache-only",
				canStart: true,
				message: "Hermes dashboard is not reachable at http://127.0.0.1:9119/.",
			})
		);
		const ensureHermesDashboardRunning = jest.fn(async () => ({
			started: true,
			pid: 123,
			command: HERMES_DASHBOARD_START_COMMAND,
			health: hermesHealth({ status: "connected", mode: "live", canStart: true }),
		}));
		const getTask = jest.spyOn(HermesKanbanApiClient.prototype, "getTask").mockResolvedValue({
			task: null,
			comments: [{ author: "peacock", body: "Live after auto-start", created_at: 1780430000 }],
			runs: [],
			events: [],
		});
		const app = MockObsidian.createMockApp() as unknown as App;
		const task = createHermesTask();
		const modal = new TestTaskEditModal(
			app,
			createPlugin(app, { ensureHermesDashboardRunning }) as never,
			{ task }
		);
		modal.setFormStateForTest(task);
		modal.renderContentForTest();

		await flushPromises();
		await flushPromises();

		expect(ensureHermesDashboardRunning).toHaveBeenCalledWith({ showNotice: false });
		expect(getTask).toHaveBeenCalledWith({ board: "default", id: "t_activity" });
		expect(modal.contentEl.textContent).toContain("Hermes live");
		expect(modal.contentEl.textContent).toContain("Live after auto-start");
	});

	it("starts Hermes from the modal, rechecks health, and reloads live activity", async () => {
		const disconnectedHealth = hermesHealth({
			status: "disconnected",
			mode: "cache-only",
			canStart: true,
		});
		const recheckHealth = jest
			.spyOn(HermesAvailabilityService.prototype, "recheckHealth")
			.mockResolvedValueOnce(disconnectedHealth)
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
			const ensureHermesDashboardRunning = jest.fn(async (options?: { force?: boolean }) =>
				options?.force
					? new HermesAvailabilityService().startDashboard()
					: {
							started: false,
							command: HERMES_DASHBOARD_START_COMMAND,
							health: disconnectedHealth,
						}
			);
				const app = MockObsidian.createMockApp() as unknown as App;
				const task = createHermesTask();
				const modal = new TestTaskEditModal(
					app,
					createPlugin(app, { ensureHermesDashboardRunning }) as never,
					{ task }
				);
				modal.setFormStateForTest(task);
				modal.renderContentForTest();
				await flushPromises();

				const footer = getHermesFooter(modal);
			footer.querySelector<HTMLButtonElement>("button[aria-label='Start Hermes dashboard']")!.click();
			await flushPromises();

				expect(startDashboard).toHaveBeenCalledTimes(1);
				expect(ensureHermesDashboardRunning).toHaveBeenCalledWith({
					showNotice: false,
					force: true,
				});
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
		expect(composerBlock).toContain("background: transparent");
		expect(composerBlock).toContain("border-top: 1px solid var(--background-modifier-border)");
		expect(composerBlock).not.toContain("box-shadow");
		expect(detailsEditorBlock).toContain("flex: 0 0 auto");
		expect(detailsEditorBlock).toContain("max-height: min(40vh, 360px)");
	});

	it("styles Hermes activity as TaskNotes task-card rows", () => {
		const cssContent = fs.readFileSync(cssFilePath, "utf-8");
		const threadListBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-list"
		);
		const threadCardBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-card.task-card"
		);
		const activityCardBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-activity-card.task-card"
		);
		const activityBodyBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-activity-body"
		);
		const activityBadgesBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-activity-card.task-card .task-card__badges"
		);
		const structuredBodyBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-thread-body--structured"
		);
		const commentBodyBlock = extractCssBlock(
			cssContent,
			".tasknotes-plugin .tn-task-modal__hermes-comment-body"
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

		expect(threadListBlock).toContain("gap: var(--size-2-2)");
		expect(activityCardBlock).toContain("background-color: transparent");
		expect(activityCardBlock).toContain("border: none");
		expect(threadCardBlock).toContain("display: flex");
		expect(threadCardBlock).toContain("background-color: transparent");
		expect(threadCardBlock).toContain("padding: var(--size-2-3) var(--size-4-2)");
		expect(activityBadgesBlock).toContain("align-self: flex-start");
		expect(activityBadgesBlock).toContain("gap: 5px");
		expect(activityBadgesBlock).toContain("margin-top: 1px");
		expect(cssContent).toContain(
			".tasknotes-plugin .tn-task-modal__hermes-activity-card.task-card:hover"
		);
		expect(cssContent).toContain(
			".tasknotes-plugin .tn-task-modal__hermes-activity-card.task-card:focus-within"
		);
		expect(activityBodyBlock).toContain("-webkit-line-clamp: 2");
		expect(structuredBodyBlock).toContain("-webkit-line-clamp: 2");
		expect(commentBodyBlock).toContain("-webkit-line-clamp: 3");
		expect(commentBodyBlock).toContain("overflow: hidden");
		expect(cssContent).toContain("tn-task-modal__hermes-activity-label");
		expect(cssContent).toContain("tn-task-modal__hermes-status-pill");
		expect(cssContent).toContain("tn-task-modal__hermes-status-pill--success");
		expect(activityOpenableBlock).toContain("cursor: pointer");
		expect(threadOpenableBlock).toContain("cursor: pointer");
		expect(detailModalContentBlock).toContain("max-height: min(72vh, 760px)");
		expect(detailModalContentBlock).toContain("overflow: auto");
		expect(cssContent).not.toContain(".tasknotes-plugin .tn-task-modal__hermes-status-item");
		expect(cssContent).not.toContain("tn-task-modal__hermes-thread-avatar");
		expect(cssContent).not.toContain("tn-task-modal__hermes-activity-title");
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
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

function extractCssBlock(css: string, selector: string): string {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`${escapedSelector}\\s*\\{([^}]*?)\\}`, "s");
	const match = css.match(regex);
	return match ? match[1] : "";
}
