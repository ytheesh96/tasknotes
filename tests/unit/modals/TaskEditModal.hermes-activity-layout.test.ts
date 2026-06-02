import * as fs from "fs";
import * as path from "path";
import type { App } from "obsidian";
import { HermesKanbanApiClient } from "../../../src/hermes/hermesApiClient";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
} from "../../../src/hermes/hermesAvailabilityService";
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
		expect(rightColumn.textContent).toContain("Run history");
		expect(rightColumn.textContent).toContain("Events");
		expect(rightColumn.textContent).not.toContain("Worker log");
		expect(detailsContainer.querySelector(".task-card__status-dot")).toBeNull();
		expect(rightColumn.querySelector(".task-card__status-dot")).toBeNull();
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

		expect(rightColumn.textContent).toContain("orchestrator - 5 mins ago");
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
		expect(pinnedCard!.textContent).toContain("Review required");
		expect(pinnedCard!.textContent).toContain("Changed files");
		expect(pinnedCard!.textContent).toContain("1 file");
		expect(pinnedCard!.textContent).toContain("Tests run");
		expect(pinnedCard!.textContent).toContain("1 item");
		expect(pinnedCard!.textContent).toContain("Open review.md");
		expect(pinnedCard!.textContent).not.toContain('"changed_files"');
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
		expect(structuredCard!.textContent).toContain("Agent handoff");
		expect(structuredCard!.textContent).toContain("Implementation is ready for QA.");
		expect(structuredCard!.textContent).toContain("Run");
		expect(structuredCard!.textContent).toContain("139");
		expect(structuredCard!.textContent).toContain("Changed files");
		expect(structuredCard!.textContent).toContain("2 files");
		expect(structuredCard!.textContent).toContain("Tests");
		expect(structuredCard!.textContent).toContain("12/12 passed");
		expect(structuredCard!.textContent).toContain("Open tasknotes-hermes.diff");
		expect(structuredCard!.textContent).toContain("View raw");
		expect(structuredCard!.textContent).not.toContain('"changed_files"');

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
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
		});
		const { leftColumn, rightColumn } = renderHermesSections(modal);

		await flushPromises();

		expect(leftColumn.textContent).toContain("Hermes live");
		expect(leftColumn.textContent).toContain("Connected");
		expect(rightColumn.textContent).toContain("Live Hermes activity");
		expect(rightColumn.textContent).not.toContain("Cache only");
		expect(
			rightColumn.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
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
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
		});
		const { leftColumn, rightColumn } = renderHermesSections(modal);

		await flushPromises();

		expect(leftColumn.textContent).toContain("Cache only");
		expect(leftColumn.textContent).toContain("Disconnected");
		expect(leftColumn.textContent).toContain(HERMES_DASHBOARD_START_COMMAND);
		expect(leftColumn.textContent).toContain("Start Hermes");
		expect(leftColumn.textContent).toContain("Recheck");
		expect(rightColumn.textContent).toContain("Cached Hermes activity");
		expect(rightColumn.textContent).toContain("Review thread (cache-only)");
		expect(
			rightColumn.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
				?.disabled
		).toBe(true);
		expect(
			rightColumn.querySelector<HTMLButtonElement>("button[aria-label='Send Hermes comment']")
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
		const modal = new TestTaskEditModal(app, createPlugin(app) as never, {
			task: createHermesTask(),
		});
		const { leftColumn, rightColumn } = renderHermesSections(modal);
		await flushPromises();

		leftColumn.querySelector<HTMLButtonElement>("button[aria-label='Start Hermes dashboard']")!.click();
		await flushPromises();

		expect(startDashboard).toHaveBeenCalledTimes(1);
		expect(recheckHealth).toHaveBeenCalledTimes(2);
		expect(getTask).toHaveBeenCalled();
		expect(leftColumn.textContent).toContain("Hermes live");
		expect(rightColumn.textContent).toContain("Live comment");
		expect(
			rightColumn.querySelector<HTMLTextAreaElement>(".tn-task-modal__hermes-comment-input")
				?.disabled
		).toBe(false);
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
