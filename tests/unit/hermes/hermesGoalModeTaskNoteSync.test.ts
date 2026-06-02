import { TFile } from "../../__mocks__/obsidian";
import type { TaskInfo } from "../../../src/types";
import {
	buildGoalModeCreatePayloadFromTaskNote,
	getSyncedHermesGoalMetadata,
	isGoalModeTaskNoteSyncEligible,
	syncGoalModeTaskNoteToHermes,
} from "../../../src/hermes/hermesGoalModeTaskNoteSync";

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Clarify launch goal",
		status: "ready",
		priority: "normal",
		path: "TaskNotes/Inbox/clarify-launch-goal.md",
		archived: false,
		tags: ["task", "goal"],
		projects: ["Hermes/default"],
		contexts: ["peacock"],
		details: "Define the launch success criteria.",
		...overrides,
	} as TaskInfo;
}

function createPlugin(options: { processFrontMatterRejects?: boolean } = {}) {
	const file = new TFile("TaskNotes/Inbox/clarify-launch-goal.md");
	const frontmatter: Record<string, unknown> = {
		tags: ["task", "goal"],
		projects: ["Hermes/default"],
		contexts: ["peacock"],
	};
	const processFrontMatter = jest.fn(async (_file: TFile, callback: (fm: Record<string, unknown>) => void) => {
		if (options.processFrontMatterRejects) {
			throw new Error("frontmatter write failed");
		}
		callback(frontmatter);
	});
	const plugin = {
		app: {
			vault: {
				getAbstractFileByPath: jest.fn(() => file),
			},
			fileManager: {
				processFrontMatter,
			},
		},
		cacheManager: {
			updateTaskInfoInCache: jest.fn(),
		},
	} as any;
	return { file, frontmatter, plugin, processFrontMatter };
}

describe("#goal TaskNote to Hermes Goal Mode sync", () => {
	it("detects unsynced TaskNotes tagged with #goal or hermes-goal", () => {
		expect(isGoalModeTaskNoteSyncEligible(createTask({ tags: ["task", "goal"] }))).toBe(true);
		expect(isGoalModeTaskNoteSyncEligible(createTask({ tags: ["task", "#goal"] }))).toBe(true);
		expect(isGoalModeTaskNoteSyncEligible(createTask({ tags: ["task", "hermes-goal"] }))).toBe(true);
		expect(isGoalModeTaskNoteSyncEligible(createTask({ tags: ["task"] }))).toBe(false);
		expect(
			isGoalModeTaskNoteSyncEligible(
				createTask({ customProperties: { hermes: { cardId: "t_existing", mode: "goal" } } })
			)
		).toBe(false);
	});

	it("parses board, assignee, schedule metadata, and a stable source-note idempotency key", () => {
		const payload = buildGoalModeCreatePayloadFromTaskNote(
			createTask({ scheduled: "2026-06-03", due: "2026-06-10" })
		);

		expect(payload).toMatchObject({
			title: "Clarify launch goal",
			body: expect.stringContaining("Define the launch success criteria."),
			status: "triage",
			assignee: "peacock",
			triage: true,
		});
		expect(payload.body).toContain("Scheduled: 2026-06-03");
		expect(payload.body).toContain("Due: 2026-06-10");
		expect(payload.idempotency_key).toBe(
			"tasknotes:goal-note:TaskNotes/Inbox/clarify-launch-goal.md"
		);
	});

	it("creates one Goal Mode card and backfills Hermes metadata only after successful create", async () => {
		const { frontmatter, plugin, processFrontMatter } = createPlugin();
		const api = {
			createTask: jest.fn().mockResolvedValue({
				id: "t_created",
				title: "Clarify launch goal",
				status: "triage",
			}),
			addComment: jest.fn().mockResolvedValue(undefined),
		};

		const result = await syncGoalModeTaskNoteToHermes(plugin, createTask(), { api, now: "2026-06-02T12:00:00Z" });

		expect(result).toEqual({ status: "created", board: "default", cardId: "t_created" });
		expect(api.createTask).toHaveBeenCalledWith(
			"default",
			expect.objectContaining({
				idempotency_key: "tasknotes:goal-note:TaskNotes/Inbox/clarify-launch-goal.md",
			})
		);
		expect(api.createTask).toHaveBeenCalledTimes(1);
		expect(api.addComment).toHaveBeenCalledWith(
			{ board: "default", id: "t_created" },
			expect.objectContaining({ body: expect.stringContaining("Created from Obsidian TaskNote #goal sync.") })
		);
		expect(processFrontMatter).toHaveBeenCalledTimes(1);
		expect(frontmatter.hermes).toEqual({
			board: "default",
			cardId: "t_created",
			mode: "goal",
			syncedAt: "2026-06-02T12:00:00Z",
		});
		expect(frontmatter.hermesCardMode).toBe("goal");
		expect(frontmatter.hermesMode).toBe("goal");
	});

	it("skips duplicate sync when existing Hermes Goal Mode metadata is present", async () => {
		const { plugin } = createPlugin();
		const api = { createTask: jest.fn(), addComment: jest.fn() };
		const task = createTask({ customProperties: { hermes: { board: "default", cardId: "t_existing", mode: "goal" } } });

		const result = await syncGoalModeTaskNoteToHermes(plugin, task, { api });

		expect(result).toEqual({ status: "skipped", reason: "already-synced", board: "default", cardId: "t_existing" });
		expect(api.createTask).not.toHaveBeenCalled();
	});

	it("does not write misleading metadata when card creation fails", async () => {
		const { plugin, processFrontMatter } = createPlugin();
		const api = {
			createTask: jest.fn().mockRejectedValue(new Error("api down")),
			addComment: jest.fn(),
		};

		await expect(syncGoalModeTaskNoteToHermes(plugin, createTask(), { api })).rejects.toThrow("api down");

		expect(processFrontMatter).not.toHaveBeenCalled();
	});

	it("surfaces metadata write failure after create so retry remains explicit", async () => {
		const { plugin } = createPlugin({ processFrontMatterRejects: true });
		const api = {
			createTask: jest.fn().mockResolvedValue({ id: "t_created", title: "Clarify launch goal", status: "triage" }),
			addComment: jest.fn().mockResolvedValue(undefined),
		};

		await expect(syncGoalModeTaskNoteToHermes(plugin, createTask(), { api })).rejects.toThrow(
			"Created Hermes Goal Mode card t_created, but failed to write sync metadata"
		);
	});

	it("reads existing sync metadata from dotted compatibility keys", () => {
		expect(
			getSyncedHermesGoalMetadata(
				createTask({
					customProperties: {
						"hermes.board": "default",
						"hermes.cardId": "t_existing",
						"hermes.mode": "goal",
					},
				})
			)
		).toEqual({ board: "default", cardId: "t_existing", mode: "goal" });
	});
});
