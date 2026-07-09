import {
	buildHermesMirrorContent,
	buildHermesMirrorUpdates,
	createOrUpdateHermesMirrorNote,
	hermesStatusToTaskNotesStatus,
	updateHermesActivityForTaskNote,
} from "../../../src/hermes/hermesMirror";
import type { HermesTaskRecord } from "../../../src/hermes/hermesApiClient";
import type { TaskInfo } from "../../../src/types";
import { TFile } from "obsidian";

describe("Hermes mirror note content", () => {
	it("keeps the Markdown body limited to the board task body", () => {
		const task: HermesTaskRecord = {
			id: "t_body_only",
			title: "Mirror body only",
			status: "done",
			priority: 4,
			body: "Do the actual work.\n\nKeep this content visible.",
			assignee: "research-librarian",
			latest_summary: "This should stay in Hermes activity, not the mirror body.",
		};

		const content = buildHermesMirrorContent("job-hunt", task, {
			parents: ["t_parent"],
			children: ["t_child"],
			activity: {
				syncedAt: "2026-06-02T02:00:00Z",
				commentCount: 1,
				runCount: 1,
				eventCount: 1,
				comments: [{ author: "reviewer", body: "Please review.", created_at: 1770000000 }],
				runs: [{ id: "12", status: "blocked", profile: "reviewer-qa" }],
				events: [{ kind: "review_required", payload: { summary: "Needs human review." } }],
			},
		});
		const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

		expect(body).toBe("Do the actual work.\n\nKeep this content visible.");
		expect(content).toContain("type: task");
		expect(content).not.toContain("tags:");
		expect(content).not.toContain("hermes-kanban");
		expect(content).toContain("hermesBoard: job-hunt");
		expect(content).toContain("hermesAssignee: research-librarian");
		expect(content).toContain("blockedBy:");
		expect(content).toContain("[[TaskNotes/Tasks/job-hunt--t_parent.md]]");
		expect(content).not.toContain("[[TaskNotes/Tasks/job-hunt--t_child.md]]");
		expect(content).toContain("hermesDependencyEdges:");
		expect(content).toContain("t_body_only->t_child");
		expect(content).toContain("hermesActivityFeed:");
		expect(content).toContain("hermesComments:");
		expect(content).toContain("hermesRuns:");
		expect(content).toContain("hermesEvents:");
		expect(content).toContain("[[TaskNotes/Activity/job-hunt--t_body_only/comments/t_body_only-comment1|Comment 1]]");
		expect(content).toContain("[[TaskNotes/Activity/job-hunt--t_body_only/runs/t_body_only-run12|Run 12]]");
		expect(content).toContain("[[TaskNotes/Activity/job-hunt--t_body_only/events/t_body_only-event1|Event 1]]");
		expect(content).not.toContain("comments:");
		expect(content).not.toContain("runs:");
		expect(content).not.toContain("events:");
		expect(content).not.toContain("Please review.");
		expect(content).not.toContain("hermesActivitySyncedAt:");
		expect(content).not.toContain("hermesActivityCommentCount:");
		expect(content).not.toContain("hermesActivityLatestComment:");
		expect(content).not.toContain("hermesActivity:");
		expect(content).not.toContain("hermes_board:");
		expect(content).not.toContain("hermes_id:");
		expect(content).not.toContain("hermes_status:");
		expect(content).not.toContain("hermes_assignee:");
		expect(content).not.toContain("blocked_by:");
		expect(content).not.toContain("blocks:");
		expect(content).not.toContain("sync_origin:");
		expect(content).not.toContain("last_synced:");
		expect(body).not.toContain("Hermes Snapshot");
		expect(body).not.toContain("Dependency Links");
		expect(body).not.toContain("Latest Run");
		expect(body).not.toContain("Please review.");
		expect(body).not.toContain("review_required");
		expect(body).not.toContain("tasknotes-hermes-api");
	});

	it("mirrors Hermes archived tasks through canonical hermesArchived frontmatter", () => {
		const task: HermesTaskRecord = {
			id: "t_archived",
			title: "Archived without archived status column",
			status: "archived",
			priority: 5,
		};

		const content = buildHermesMirrorContent("default", task);
		const updates = buildHermesMirrorUpdates("default", task, "2026-06-02T00:00:00Z");

		expect(hermesStatusToTaskNotesStatus("archived")).toBe("done");
		expect(updates.status).toBe("done");
		expect(content).toContain("status: done");
		expect(content).toContain("hermesArchived: true");
		expect(content).not.toContain("- archived");
		expect(content).not.toContain("status: archived");
	});

	it("migrates existing per-board mirrors into the canonical task folder without losing stable frontmatter", async () => {
		const task: HermesTaskRecord = {
			id: "t_migrate",
			title: "Migrated mirror",
			status: "done",
			priority: 5,
		};
		const legacyPath = "TaskNotes/default/t_migrate.md";
		const canonicalPath = "TaskNotes/Tasks/default--t_migrate.md";
		const legacyFile = Object.assign(new TFile(), { path: legacyPath });
		const legacyTaskInfo: TaskInfo = {
			title: "Migrated mirror",
			status: "done",
			priority: "normal",
			path: legacyPath,
			tags: ["task"],
			contexts: [],
			projects: [],
			archived: false,
			dateCreated: "2026-06-01T00:00:00Z",
			completedDate: "2026-06-01T01:00:00Z",
			customProperties: {
				hermesTaskId: "t_migrate",
				hermesBoard: "default",
			},
		};
		const createdNotes: Array<{ path: string; content: string }> = [];
		const plugin = {
			app: {
				metadataCache: { getFileCache: jest.fn(() => null) },
				vault: {
					adapter: { exists: jest.fn().mockResolvedValue(true) },
					createFolder: jest.fn(),
					getAbstractFileByPath: jest.fn((path: string) =>
						path === legacyPath ? legacyFile : null
					),
					read: jest.fn(),
					modify: jest.fn(),
					create: jest.fn(async (path: string, content: string) => {
						createdNotes.push({ path, content });
						const file = new TFile();
						(file as { path: string }).path = path;
						return file;
					}),
				},
			},
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn(async (path: string) =>
					path === legacyPath ? legacyTaskInfo : null
				),
				updateTaskInfoInCache: jest.fn(),
			},
			fieldMapper: { toUserField: jest.fn((field: string) => field) },
			settings: { storeTitleInFilename: false, defaultTaskStatus: "triage" },
		};

		const result = await createOrUpdateHermesMirrorNote(plugin as never, "default", task);

		expect(result.changed).toBe(true);
		expect(createdNotes[0]?.path).toBe(canonicalPath);
		expect(createdNotes[0]?.content).toContain("dateCreated: 2026-06-01T00:00:00Z");
		expect(createdNotes[0]?.content).toContain("completedDate: 2026-06-01T01:00:00Z");
		expect(plugin.app.vault.modify).not.toHaveBeenCalledWith(legacyFile, expect.any(String));
		expect(plugin.cacheManager.updateTaskInfoInCache).toHaveBeenCalledWith(
			canonicalPath,
			expect.objectContaining({ path: canonicalPath })
		);
	});

	it("ignores an unqualified legacy mirror from a different board with the same task id", async () => {
		const task: HermesTaskRecord = {
			id: "t_shared",
			title: "Job hunt shared id",
			status: "done",
			priority: 5,
		};
		const wrongLegacyPath = "TaskNotes/Tasks/t_shared.md";
		const canonicalPath = "TaskNotes/Tasks/job-hunt--t_shared.md";
		const wrongLegacyFile = Object.assign(new TFile(), { path: wrongLegacyPath });
		const wrongLegacyTaskInfo: TaskInfo = {
			title: "Default shared id",
			status: "done",
			priority: "normal",
			path: wrongLegacyPath,
			tags: ["task"],
			contexts: [],
			projects: [],
			archived: false,
			dateCreated: "2026-01-01T00:00:00Z",
			completedDate: "2026-01-01T01:00:00Z",
			blockedBy: [{ type: "note", uid: "TaskNotes/Tasks/default--t_parent.md" }],
			customProperties: {
				hermesTaskId: "t_shared",
				hermesBoard: "default",
				hermesActivityFeed: [
					"[[TaskNotes/Activity/default--t_shared/comments/t_shared-comment1|Comment 1]]",
				],
				hermesComments: [
					"[[TaskNotes/Activity/default--t_shared/comments/t_shared-comment1|Comment 1]]",
				],
				hermesActivitySyncedAt: "2026-01-01T02:00:00Z",
				hermesActivityCommentCount: 1,
				hermesActivityRunCount: 0,
				hermesActivityEventCount: 0,
			},
		};
		const createdNotes: Array<{ path: string; content: string }> = [];
		const plugin = {
			app: {
				metadataCache: { getFileCache: jest.fn(() => null) },
				vault: {
					adapter: { exists: jest.fn().mockResolvedValue(true) },
					createFolder: jest.fn(),
					getAbstractFileByPath: jest.fn((path: string) =>
						path === wrongLegacyPath ? wrongLegacyFile : null
					),
					read: jest.fn(),
					modify: jest.fn(),
					create: jest.fn(async (path: string, content: string) => {
						createdNotes.push({ path, content });
						const file = new TFile();
						(file as { path: string }).path = path;
						return file;
					}),
				},
			},
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn(async (path: string) =>
					path === wrongLegacyPath ? wrongLegacyTaskInfo : null
				),
				updateTaskInfoInCache: jest.fn(),
			},
			fieldMapper: { toUserField: jest.fn((field: string) => field) },
			settings: { storeTitleInFilename: false, defaultTaskStatus: "triage" },
		};

		const result = await createOrUpdateHermesMirrorNote(plugin as never, "job-hunt", task);

		expect(result.changed).toBe(true);
		expect(createdNotes[0]?.path).toBe(canonicalPath);
		expect(createdNotes[0]?.content).toContain("hermesBoard: job-hunt");
		expect(createdNotes[0]?.content).toContain("hermesTaskId: t_shared");
		expect(createdNotes[0]?.content).not.toContain("2026-01-01T00:00:00Z");
		expect(createdNotes[0]?.content).not.toContain("2026-01-01T01:00:00Z");
		expect(createdNotes[0]?.content).not.toContain("TaskNotes/Tasks/default--t_parent.md");
		expect(createdNotes[0]?.content).not.toContain("TaskNotes/Activity/default--t_shared");
		expect(plugin.app.vault.modify).not.toHaveBeenCalledWith(wrongLegacyFile, expect.any(String));
		expect(plugin.cacheManager.updateTaskInfoInCache).toHaveBeenCalledWith(
			canonicalPath,
			expect.objectContaining({ path: canonicalPath })
		);
	});

	it("skips an unchanged mirror rewrite when stable timestamps only exist in frontmatter properties", async () => {
		const task: HermesTaskRecord = {
			id: "t_stable",
			title: "Stable mirror",
			status: "done",
			priority: 5,
			body: "No semantic changes.",
		};
		const path = "TaskNotes/Tasks/default--t_stable.md";
		const file = Object.assign(new TFile(), { path });
		const existingContent = buildHermesMirrorContent("default", task, {
			existingTaskInfo: {
				dateCreated: "2026-06-01T00:00:00Z",
				completedDate: "2026-06-01T01:00:00Z",
				customProperties: {},
			},
		});
		const plugin = {
			app: {
				metadataCache: { getFileCache: jest.fn(() => null) },
				vault: {
					adapter: { exists: jest.fn().mockResolvedValue(true) },
					createFolder: jest.fn(),
					getAbstractFileByPath: jest.fn((candidate: string) => (candidate === path ? file : null)),
					read: jest.fn().mockResolvedValue(existingContent),
					modify: jest.fn(),
					create: jest.fn(),
				},
			},
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn().mockResolvedValue(null),
				updateTaskInfoInCache: jest.fn(),
			},
			fieldMapper: { toUserField: jest.fn((field: string) => field) },
			settings: { storeTitleInFilename: false, defaultTaskStatus: "triage" },
		};

		const result = await createOrUpdateHermesMirrorNote(plugin as never, "default", task);

		expect(result.changed).toBe(false);
		expect(plugin.app.vault.modify).not.toHaveBeenCalled();
		expect(plugin.cacheManager.updateTaskInfoInCache).not.toHaveBeenCalled();
	});

	it("preserves cached Hermes activity when rewriting an existing mirror note", () => {
		const task: HermesTaskRecord = {
			id: "t_existing",
			title: "Existing mirror",
			status: "done",
			priority: 5,
		};

		const content = buildHermesMirrorContent("default", task, {
			existingActivity: {
				syncedAt: "2026-06-02T03:00:00Z",
				commentCount: 2,
				runCount: 0,
				eventCount: 0,
				comments: [
					{ author: "orchestrator", body: "review-required handoff" },
				],
				runs: [],
				events: [],
			},
		});

		expect(content).toContain("hermesActivityFeed:");
		expect(content).toContain("hermesComments:");
		expect(content).toContain("[[TaskNotes/Activity/default--t_existing/comments/t_existing-comment1|Comment 1]]");
		expect(content).not.toContain("comments:");
		expect(content).not.toContain("review-required handoff");
		expect(content).not.toContain("hermesActivityCommentCount:");
		expect(content).not.toContain("hermesActivity:");
	});

	it("marks Goal Mode mirror notes with stable frontmatter and tags", () => {
		const task: HermesTaskRecord = {
			id: "t_goal",
			title: "Goal card",
			status: "triage",
			priority: 5,
			body: "Shape the work into a persistent goal.",
			metadata: {
				hermes_card_mode: "goal",
			},
		};

		const content = buildHermesMirrorContent("default", task, {
			extraTags: ["hermes-goal"],
		});

		expect(content).toContain("hermesCardMode: goal");
		expect(content).toContain("hermesMode: goal");
		expect(content).toContain("- hermes-goal");
		expect(content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim()).toBe(
			"Shape the work into a persistent goal."
		);
	});

	it("updates activity indexes without rewriting the task note body", async () => {
		const task: TaskInfo = {
			title: "Sync me",
			status: "done",
			priority: "normal",
			path: "TaskNotes/Tasks/default--t_sync.md",
			tags: ["task"],
			contexts: [],
			projects: [],
			archived: false,
			customProperties: {
				comments: ["[[TaskNotes/default/activity/comments/comment-old|Old comment]]"],
				keep: "preserved",
			},
		};
		const frontmatter: Record<string, unknown> = {
			type: "task",
			status: "done",
			comments: ["[[TaskNotes/default/activity/comments/comment-old|Old comment]]"],
			runs: ["[[TaskNotes/default/activity/runs/run-old|Old run]]"],
			events: ["[[TaskNotes/default/activity/events/event-old|Old event]]"],
			artifacts: ["old artifact"],
			changedFiles: ["old file"],
			keep: "preserved",
		};
		const taskFile = new TFile();
		(taskFile as { path: string }).path = task.path;
		const createdNotes: Array<{ path: string; content: string }> = [];
		const plugin = {
			app: {
				fileManager: {
					processFrontMatter: jest.fn(async (_file: TFile, updater: (fm: Record<string, unknown>) => void) => {
						updater(frontmatter);
					}),
				},
				vault: {
					adapter: {
						exists: jest.fn().mockResolvedValue(true),
					},
					createFolder: jest.fn(),
					getAbstractFileByPath: jest.fn((path: string) =>
						path === task.path ? taskFile : null
					),
					create: jest.fn(async (path: string, content: string) => {
						createdNotes.push({ path, content });
						const file = new TFile();
						(file as { path: string }).path = path;
						return file;
					}),
					modify: jest.fn(),
					read: jest.fn(),
				},
			},
			cacheManager: {
				getTaskInfoFromFrontmatter: jest.fn().mockResolvedValue(null),
				updateTaskInfoInCache: jest.fn(),
			},
		};

		const updated = await updateHermesActivityForTaskNote(
			plugin as never,
			"default",
			"t_sync",
			task,
			{
				syncedAt: "2026-06-04T12:00:00Z",
				commentCount: 1,
				runCount: 1,
				eventCount: 1,
				comments: [{ author: "reviewer", body: "Ready", created_at: 1770000000 }],
				runs: [{ id: "7", status: "done", profile: "reviewer-qa" }],
				events: [{ id: 9, kind: "completed", payload: { summary: "Done" } }],
			}
		);

		expect(plugin.app.vault.modify).not.toHaveBeenCalledWith(
			taskFile,
			expect.any(String)
		);
		expect(frontmatter.status).toBe("done");
		expect(frontmatter.keep).toBe("preserved");
		expect(frontmatter.hermesActivityFeed).toEqual([
			"[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]",
			"[[TaskNotes/Activity/default--t_sync/runs/t_sync-run7|Run 7]]",
			"[[TaskNotes/Activity/default--t_sync/events/t_sync-event9|Event 9]]",
		]);
		expect(frontmatter.hermesComments).toEqual([
			"[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]",
		]);
		expect(frontmatter.hermesRuns).toEqual(["[[TaskNotes/Activity/default--t_sync/runs/t_sync-run7|Run 7]]"]);
		expect(frontmatter.hermesEvents).toEqual([
			"[[TaskNotes/Activity/default--t_sync/events/t_sync-event9|Event 9]]",
		]);
		expect(frontmatter.hermesAttachments).toBeUndefined();
		expect(frontmatter.hermesChangedFiles).toBeUndefined();
		expect(frontmatter.comments).toBeUndefined();
		expect(frontmatter.runs).toBeUndefined();
		expect(frontmatter.events).toBeUndefined();
		expect(frontmatter.artifacts).toBeUndefined();
		expect(frontmatter.changedFiles).toBeUndefined();
		expect(createdNotes.map((note) => note.path)).toEqual([
			"TaskNotes/Activity/default--t_sync/comments/t_sync-comment1.md",
			"TaskNotes/Activity/default--t_sync/runs/t_sync-run7.md",
			"TaskNotes/Activity/default--t_sync/events/t_sync-event9.md",
			"TaskNotes/Activity/default--t_sync/raw/t_sync-event9-payload.md",
		]);
		expect(createdNotes.find((note) => note.path.endsWith("event9-payload.md"))?.content).toContain(
			"type: hermes-raw"
		);
		expect(createdNotes.find((note) => note.path.endsWith("event9-payload.md"))?.content).toContain(
			'"summary": "Done"'
		);
		expect(updated.customProperties).toMatchObject({
			hermesActivityFeed: [
				"[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]",
				"[[TaskNotes/Activity/default--t_sync/runs/t_sync-run7|Run 7]]",
				"[[TaskNotes/Activity/default--t_sync/events/t_sync-event9|Event 9]]",
			],
			hermesComments: ["[[TaskNotes/Activity/default--t_sync/comments/t_sync-comment1|Comment 1]]"],
			hermesRuns: ["[[TaskNotes/Activity/default--t_sync/runs/t_sync-run7|Run 7]]"],
			hermesEvents: ["[[TaskNotes/Activity/default--t_sync/events/t_sync-event9|Event 9]]"],
			keep: "preserved",
		});
		expect(updated.customProperties?.comments).toBeUndefined();
		expect(plugin.cacheManager.updateTaskInfoInCache).toHaveBeenCalledWith(
			task.path,
			updated
		);
	});
});
