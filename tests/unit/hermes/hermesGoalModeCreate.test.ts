import { Notice } from "obsidian";
import {
	TaskCreationModal,
	buildHermesGoalModeCreateIdempotencyKey,
	getHermesPartialSuccessNoticeMessage,
} from "../../../src/modals/TaskCreationModal";
import { HermesAvailabilityService } from "../../../src/hermes/hermesAvailabilityService";

const mockHermesApi = {
	createTask: jest.fn(),
	getTask: jest.fn(),
	addComment: jest.fn(),
	addLink: jest.fn(),
	listBoards: jest.fn(),
	listAssignees: jest.fn(),
};

const mockCreateOrUpdateHermesMirrorNote = jest.fn();
const mockExecFile = jest.fn();

jest.mock("child_process", () => ({
	execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.mock("../../../src/hermes/hermesApiClient", () => ({
	HermesKanbanApiClient: jest.fn(() => mockHermesApi),
	getHermesTaskIdentity: jest.fn(() => null),
}));

jest.mock("../../../src/hermes/hermesMirror", () => ({
	createOrUpdateHermesMirrorNote: (...args: unknown[]) =>
		mockCreateOrUpdateHermesMirrorNote(...args),
}));

const basePayload = {
	title: "Clarify research goal",
	body: "Goal details",
	status: "triage",
	assignee: "peacock",
	priority: 5,
	parents: ["t_parent"],
	triage: true,
};

describe("Hermes Goal Mode create behavior", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockHermesApi.createTask.mockReset();
		mockHermesApi.getTask.mockReset();
		mockHermesApi.addComment.mockReset();
		mockHermesApi.addLink.mockReset();
		mockHermesApi.listBoards.mockReset();
		mockHermesApi.listAssignees.mockReset();
		mockCreateOrUpdateHermesMirrorNote.mockReset();
		mockExecFile.mockReset();
		jest.spyOn(HermesAvailabilityService.prototype, "recheckHealth").mockResolvedValue({
			status: "connected",
			mode: "live",
			rootUrl: "http://127.0.0.1:9119/",
			apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
			canStart: true,
		});
	});

	it("builds the same idempotency key for identical create submissions", () => {
		const first = buildHermesGoalModeCreateIdempotencyKey("default", basePayload);
		const second = buildHermesGoalModeCreateIdempotencyKey("default", {
			...basePayload,
			parents: ["t_parent"],
		});

		expect(first).toBe(second);
		expect(first).toMatch(/^tasknotes:goal:default:/);
	});

	it("changes the idempotency key when submitted card content changes", () => {
		const first = buildHermesGoalModeCreateIdempotencyKey("default", basePayload);
		const second = buildHermesGoalModeCreateIdempotencyKey("default", {
			...basePayload,
			title: "Clarify a different goal",
		});

		expect(second).not.toBe(first);
	});

	it("warns that a card exists when post-create reconciliation fails", () => {
		expect(
			getHermesPartialSuccessNoticeMessage({
				mode: "goal",
				title: "Clarify research goal",
				id: "t_created",
				error: new Error("mirror write failed"),
			})
		).toBe(
			"Created Goal Mode card Clarify research goal (t_created), but TaskNotes could not finish syncing the comment or mirror note: mirror write failed. Do not submit again; use the existing Hermes card or retry after reconciling the mirror note."
		);
	});

	it("blocks direct Hermes card creation while Hermes is unavailable", async () => {
		(
			HermesAvailabilityService.prototype.recheckHealth as jest.MockedFunction<
				HermesAvailabilityService["recheckHealth"]
			>
		).mockResolvedValueOnce({
			status: "disconnected",
			mode: "cache-only",
			rootUrl: "http://127.0.0.1:9119/",
			apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
			canStart: true,
		});
		const app = {} as never;
		const plugin = {
			settings: {
				customStatuses: [],
				customPriorities: [],
				nlpDefaultToScheduled: true,
				nlpLanguage: "en",
				nlpTriggers: undefined,
				userFields: [],
				taskIdentificationMethod: "none",
				taskTag: "task",
				openTaskAfterCreation: "none",
				defaultTaskStatus: "open",
			},
			i18n: {
				translate: (key: string, params?: Record<string, string | number>) =>
					params?.message ? `${key}: ${params.message}` : key,
			},
			cacheManager: {
				getTaskInfo: jest.fn(),
			},
		} as never;
		const modal = new TaskCreationModal(app, plugin, {
			hermesBoardPicker: { boards: ["default"], selectedBoard: "default" },
			creationTargetPicker: { boards: ["default"], selectedTarget: "hermes:default" },
		});
		const modalHarness = modal as never as Record<string, unknown>;
		modalHarness.title = "Clarify research goal";
		modalHarness.validateHermesCreationRouting = jest
			.fn()
			.mockResolvedValue({ assignee: "peacock" });

		await expect((modalHarness.handleHermesApiCreate as () => Promise<void>)()).rejects.toThrow(
			"Hermes is unavailable"
		);

		expect(mockHermesApi.createTask).not.toHaveBeenCalled();
	});

	it("submits a native TaskNotes card through the Hermes CLI when dashboard health is down", async () => {
		mockExecFile.mockImplementation((_command, _args, _options, callback) => {
			callback(
				null,
				JSON.stringify({ id: "t_cli", title: "Native CLI task", status: "triage" }),
				""
			);
		});
		(
			HermesAvailabilityService.prototype.recheckHealth as jest.MockedFunction<
				HermesAvailabilityService["recheckHealth"]
			>
		).mockResolvedValueOnce({
			status: "connected",
			mode: "live",
			transport: "kanban-cli",
			writeStatus: "writable-via-cli",
			message: "Hermes Kanban CLI is available for board developer.",
		});
		mockHermesApi.getTask.mockResolvedValue({
			task: { id: "t_cli", title: "Native CLI task", status: "triage" },
			links: { parents: [], children: [] },
		});
		mockCreateOrUpdateHermesMirrorNote.mockResolvedValue({
			file: { path: "TaskNotes/developer/t_cli.md" },
			taskInfo: { title: "Native CLI task", path: "TaskNotes/developer/t_cli.md" },
		});
		const app = {} as never;
		const plugin = {
			settings: {
				customStatuses: [],
				customPriorities: [],
				nlpDefaultToScheduled: true,
				nlpLanguage: "en",
				nlpTriggers: undefined,
				userFields: [],
				taskIdentificationMethod: "none",
				taskTag: "task",
				openTaskAfterCreation: "none",
				defaultTaskStatus: "open",
				hermesKanbanTransport: "kanban-cli",
			},
			i18n: {
				translate: (key: string, params?: Record<string, string | number>) =>
					params?.message ? `${key}: ${params.message}` : key,
			},
			cacheManager: {
				getTaskInfo: jest.fn(),
			},
		} as never;
		const modal = new TaskCreationModal(app, plugin, {
			hermesBoardPicker: { boards: ["developer"], selectedBoard: "developer" },
			creationTargetPicker: { boards: ["developer"], selectedTarget: "hermes:developer" },
		});
		const modalHarness = modal as never as Record<string, unknown>;
		modalHarness.title = "Native CLI task";
		modalHarness.details = "created while the dashboard API is down";
		modalHarness.contexts = "";
		modalHarness.status = "open";
		modalHarness.validateHermesCreationRouting = jest
			.fn()
			.mockResolvedValue({ assignee: null });
		modalHarness.resolveHermesDependencyIds = jest
			.fn()
			.mockResolvedValue({ ids: [], unresolved: [] });

		await (modalHarness.handleHermesApiCreate as () => Promise<void>)();

		expect(HermesAvailabilityService.prototype.recheckHealth).toHaveBeenCalledWith({
			board: "developer",
			transport: "kanban-cli",
		});
		expect(mockHermesApi.createTask).not.toHaveBeenCalled();
		expect(mockExecFile).toHaveBeenCalledWith(
			"hermes",
			expect.arrayContaining([
				"kanban",
				"--board",
				"developer",
				"create",
				"Native CLI task",
				"--body",
				"created while the dashboard API is down",
				"--triage",
				"--created-by",
				"tasknotes",
				"--json",
			]),
			expect.objectContaining({ shell: false }),
			expect.any(Function)
		);
		const cliArgs = mockExecFile.mock.calls[0][1] as string[];
		expect(cliArgs).not.toContain("--assignee");
	});

	it("passes explicit TaskNotes routing metadata to the Hermes CLI", async () => {
		mockExecFile.mockImplementation((_command, _args, _options, callback) => {
			callback(null, JSON.stringify({ id: "t_routed", title: "Routed", status: "triage" }), "");
		});
		mockHermesApi.getTask.mockResolvedValue({
			task: { id: "t_routed", title: "Routed", status: "triage", assignee: "peacock" },
			links: { parents: ["t_parent"], children: [] },
		});
		mockCreateOrUpdateHermesMirrorNote.mockResolvedValue({
			file: { path: "TaskNotes/developer/t_routed.md" },
			taskInfo: { title: "Routed", path: "TaskNotes/developer/t_routed.md" },
		});
		const app = {} as never;
		const plugin = {
			settings: {
				customStatuses: [],
				customPriorities: [],
				nlpDefaultToScheduled: true,
				nlpLanguage: "en",
				nlpTriggers: undefined,
				userFields: [],
				taskIdentificationMethod: "none",
				taskTag: "task",
				openTaskAfterCreation: "none",
				defaultTaskStatus: "open",
				hermesKanbanTransport: "kanban-cli",
			},
			i18n: {
				translate: (key: string, params?: Record<string, string | number>) =>
					params?.message ? `${key}: ${params.message}` : key,
			},
			cacheManager: {
				getTaskInfo: jest.fn(),
			},
		} as never;
		const modal = new TaskCreationModal(app, plugin, {
			hermesBoardPicker: { boards: ["developer"], selectedBoard: "developer" },
			creationTargetPicker: { boards: ["developer"], selectedTarget: "hermes:developer" },
		});
		const modalHarness = modal as never as Record<string, unknown>;
		modalHarness.title = "Routed";
		modalHarness.details = "route me";
		modalHarness.contexts = "peacock";
		modalHarness.status = "triage";
		modalHarness.blockedByItems = [{ type: "hermes", board: "developer", id: "t_parent" }];
		modalHarness.validateHermesCreationRouting = jest
			.fn()
			.mockResolvedValue({ assignee: "peacock" });
		modalHarness.resolveHermesDependencyIds = jest
			.fn()
			.mockResolvedValueOnce({ ids: ["t_parent"], unresolved: [] })
			.mockResolvedValueOnce({ ids: [], unresolved: [] });

		await (modalHarness.handleHermesApiCreate as () => Promise<void>)();

		const cliArgs = mockExecFile.mock.calls[0][1] as string[];
		expect(cliArgs).toEqual(
			expect.arrayContaining([
				"--board",
				"developer",
				"--body",
				"route me",
				"--triage",
				"--assignee",
				"peacock",
				"--parent",
				"t_parent",
				"--created-by",
				"tasknotes",
				"--json",
			])
		);
	});

	it("keeps the created Hermes card visible when goal-tag comment sync fails after create", async () => {
		const app = {} as never;
		const plugin = {
			settings: {
				customStatuses: [],
				customPriorities: [],
				nlpDefaultToScheduled: true,
				nlpLanguage: "en",
				nlpTriggers: undefined,
				userFields: [],
				taskIdentificationMethod: "none",
				taskTag: "task",
				openTaskAfterCreation: "none",
				defaultTaskStatus: "open",
			},
			i18n: {
				translate: (key: string, params?: Record<string, string | number>) =>
					params?.message ? `${key}: ${params.message}` : key,
			},
			cacheManager: {
				getTaskInfo: jest.fn(),
			},
			} as never;
			const modal = new TaskCreationModal(app, plugin, {
				hermesBoardPicker: { boards: ["default"], selectedBoard: "default" },
				creationTargetPicker: { boards: ["default"], selectedTarget: "hermes:default" },
			});
		const modalHarness = modal as never as Record<string, unknown>;
		modalHarness.title = "Clarify research goal";
		modalHarness.details = "Goal details";
			modalHarness.status = "triage";
			modalHarness.contexts = "peacock";
			modalHarness.tags = "goal";
			modalHarness.priority = "normal";
		modalHarness.validateHermesCreationRouting = jest
			.fn()
			.mockResolvedValue({ assignee: "peacock" });
		modalHarness.resolveHermesDependencyIds = jest
			.fn()
			.mockResolvedValue({ ids: [], unresolved: [] });
		modalHarness.addHermesGoalModeComment = jest
			.fn()
			.mockRejectedValue(new Error("comment write failed"));

		mockHermesApi.createTask.mockResolvedValue({
			id: "t_created",
			title: "Clarify research goal",
			status: "triage",
		});
		mockHermesApi.getTask.mockResolvedValue({
			task: { id: "t_created", title: "Clarify research goal", status: "triage" },
			links: { parents: [], children: [] },
		});
		mockCreateOrUpdateHermesMirrorNote.mockResolvedValue({
			file: { path: "TaskNotes/default/t_created.md" },
			taskInfo: { title: "Clarify research goal", path: "TaskNotes/default/t_created.md" },
		});

		await (modalHarness.handleHermesApiCreate as () => Promise<void>)();

		expect(mockHermesApi.createTask).toHaveBeenCalledWith(
			"default",
			expect.objectContaining({
				title: "Clarify research goal",
				assignee: "peacock",
				idempotency_key: expect.stringMatching(/^tasknotes:goal:default:/),
			})
		);
		expect(mockHermesApi.createTask).toHaveBeenCalledTimes(1);
		expect(mockCreateOrUpdateHermesMirrorNote).toHaveBeenCalledTimes(1);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(
				"Created Goal Mode card Clarify research goal (t_created), but TaskNotes could not finish syncing the comment or mirror note"
			)
		);
		expect(Notice).toHaveBeenCalledWith(expect.stringContaining("Do not submit again"));
		expect(Notice).not.toHaveBeenCalledWith(
			expect.stringContaining("Failed to create task")
		);
	});
});
