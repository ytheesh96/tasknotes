import { Notice } from "obsidian";
import type { TaskInfo } from "../../../src/types";
import {
	createHermesTaskReviewSurface,
	isHermesManagedTaskNote,
} from "../../../src/editor/HermesTaskReviewSurface";

jest.mock("obsidian", () => {
	const actual = jest.requireActual("obsidian");
	return {
		...actual,
		Notice: jest.fn(),
	};
});

function task(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Implement review surface",
		status: "review",
		priority: "normal",
		path: "TaskNotes/Tasks/default--t_review123.md",
		archived: false,
		customProperties: {
			hermesTaskId: "t_review123",
			hermesBoard: "default",
			hermesAssignee: "peacock",
			hermesRunId: "1110",
			hermesActivityChangedFiles: ["src/editor/HermesTaskReviewSurface.ts", "styles.css"],
			hermesActivityComments: [
				"[[TaskNotes/Activity/default--t_review123/comments/t_review123-comment1|Comment 1]]",
			],
			hermesActivityRuns: ["Run 1110 — 3/3 tests passed"],
			hermesActivityEvents: ["heartbeat", "commit pushed — abc123", "focused tests passed"],
			hermesLoopHandoffId: "17",
			hermesLoopHandoffKind: "worker_completed",
			hermesLoopHandoffState: "reviewing",
			hermesLoopVerificationState: "fresh_pass",
			hermesLoopReviewBatchId: "loop-review:tenant:t_root:1770",
			hermesLoopQueuePosition: "2",
			hermesLoopPendingCount: "3",
			hermesLoopActiveCount: "1",
			hermesLoopTotalCount: "6",
			hermesLoopReviewerSessionId: "20260613_review",
			hermesLoopWorkerSessionId: "20260613_worker",
			hermesLoopAuditLink: "Hermes/default/handoffs/17",
			hermesLoopAutoActions: ["released t_child"],
			...overrides.customProperties,
		},
		...overrides,
	};
}

describe("HermesTaskReviewSurface", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(global as typeof globalThis & { activeDocument?: Document }).activeDocument = document;
		document.body.innerHTML = "";
	});

	it("detects only Hermes-managed TaskNotes task notes", () => {
		expect(isHermesManagedTaskNote(task())).toBe(true);
		expect(
			isHermesManagedTaskNote(
				task({ path: "Tasks/personal.md", customProperties: { hermesTaskId: undefined } })
			)
		).toBe(false);
	});

	it("renders the first-screen review brief, comments composer, rail actions, verification, and filtered activity", () => {
		const container = createHermesTaskReviewSurface({
			plugin: {
				app: {},
				settings: {},
			} as any,
			task: task(),
		});

		expect(container.classList.contains("hermes-task-review-surface")).toBe(true);
		expect(container.textContent).toContain("t_review123");
		expect(container.textContent).toContain("Implement review surface");
		expect(container.textContent).toContain("Assignee peacock");
		expect(container.textContent).toContain("Board default");
		expect(container.textContent).toContain("Changed files");
		expect(container.textContent).toContain("Composer status stack");
		expect(container.textContent).toContain("Pending 3");
		expect(container.textContent).toContain("Active 1");
		expect(container.textContent).toContain("Total 6");
		expect(container.textContent).toContain("Agents / Loop overlay");
		expect(container.textContent).toContain("Handoff review");
		expect(container.textContent).toContain("State Reviewing");
		expect(container.textContent).toContain("Evidence Fresh pass");
		expect(container.textContent).toContain("Queue #2");
		expect(container.textContent).toContain("Open reviewer session");
		expect(container.textContent).toContain("20260613_review");
		expect(container.textContent).toContain("Open worker transcript");
		expect(container.textContent).toContain("Open audit log");
		expect(container.textContent).toContain("routine green-path decisions update live status and audit only");
		expect(container.textContent).toContain("released t_child");
		expect(container.textContent).toContain("src/editor/HermesTaskReviewSurface.ts");
		expect(container.textContent).toContain("Comments");
		expect(container.querySelector("textarea")?.getAttribute("placeholder")).toBe(
			"Add a review comment..."
		);
		for (const label of [
			"Approve",
			"Request changes",
			"Mark blocked",
			"Ready",
			"Block",
			"Complete",
			"Archive",
			"Open worktree",
		]) {
			expect(container.textContent).toContain(label);
		}
		expect(container.textContent).toContain("Verification");
		expect(container.textContent).toContain("3/3 tests passed");
		expect(container.textContent).toContain("commit pushed — abc123");
		expect(container.textContent).toContain("focused tests passed");
		expect(container.textContent).not.toContain("heartbeat");
		expect(container.querySelector("details.hermes-task-review-surface__worker-log")?.hasAttribute("open")).toBe(false);
	});

	it("backs comments and status actions with existing Hermes/TaskNotes write paths", async () => {
		const addComment = jest.fn(async () => undefined);
		const updateTask = jest.fn(async () => undefined);
		const toggleArchive = jest.fn(async () => undefined);
		const trigger = jest.fn();
		const container = createHermesTaskReviewSurface({
			plugin: {
				app: { workspace: { trigger } },
				taskService: { toggleArchive },
				settings: {},
			} as any,
			task: task(),
			apiClient: { addComment, updateTask } as any,
		});

		const composer = container.querySelector<HTMLTextAreaElement>("textarea")!;
		composer.value = "Looks good";
		container.querySelector<HTMLButtonElement>("[data-hermes-review-action='send-comment']")?.click();
		await Promise.resolve();
		expect(addComment).toHaveBeenCalledWith(
			{ board: "default", id: "t_review123" },
			{ body: "Looks good", author: "tasknotes" }
		);

		container.querySelector<HTMLButtonElement>("[data-hermes-review-action='approve']")?.click();
		container.querySelector<HTMLButtonElement>("[data-hermes-review-action='ready']")?.click();
		container.querySelector<HTMLButtonElement>("[data-hermes-review-action='archive']")?.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(updateTask).toHaveBeenCalledWith(
			{ board: "default", id: "t_review123" },
			expect.objectContaining({ status: "done" })
		);
		expect(updateTask).toHaveBeenCalledWith(
			{ board: "default", id: "t_review123" },
			expect.objectContaining({ status: "ready" })
		);
		expect(toggleArchive).toHaveBeenCalled();
		expect(trigger).toHaveBeenCalledWith("tasknotes:refresh-views");
	});

	it("disables live-only actions with clear reasons when write paths are unavailable", () => {
		const container = createHermesTaskReviewSurface({
			plugin: { app: {}, settings: {} } as any,
			task: task({ customProperties: { hermesTaskId: "t_review123", hermesBoard: "default" } }),
			apiClient: null,
		});

		const approve = container.querySelector<HTMLButtonElement>(
			"[data-hermes-review-action='approve']"
		)!;
		expect(approve.disabled).toBe(true);
		expect(approve.getAttribute("aria-label")).toContain("Hermes API is unavailable");
		expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
		expect(container.textContent).toContain("Live comments unavailable");
		expect(Notice).not.toHaveBeenCalled();
	});

	it("disables archive when TaskNotes taskService does not expose toggleArchive", () => {
		const container = createHermesTaskReviewSurface({
			plugin: {
				app: {},
				taskService: {},
				settings: {},
			} as any,
			task: task(),
		});

		const archive = container.querySelector<HTMLButtonElement>(
			"[data-hermes-review-action='archive']"
		)!;
		expect(archive.disabled).toBe(true);
		expect(archive.getAttribute("aria-label")).toContain(
			"TaskNotes archive service is unavailable"
		);
		archive.click();
		expect(Notice).not.toHaveBeenCalled();
	});

	it("dereferences Hermes activity note frontmatter instead of showing index wikilinks", () => {
		const getCache = jest.fn((path: string) => {
			const frontmatterByPath: Record<string, Record<string, unknown>> = {
				"TaskNotes/Activity/default--t_review123/comments/t_review123-comment1.md": {
					hermesCommentKind: "review-required",
					hermesCommentSeverity: "warning",
					hermesCommentSummary:
						"review-required: confirm the archive fallback and activity rendering before merge",
					hermesCommentAuthor: "reviewer-qa",
				},
				"TaskNotes/Activity/default--t_review123/runs/t_review123-run1110.md": {
					hermesRunSummary: "Implemented review surface fixes",
					hermesRunVerification: "npx jest tests/unit/editor/HermesTaskReviewSurface.test.ts --runInBand passed",
					hermesRunChangedFiles: ["src/editor/HermesTaskReviewSurface.ts"],
				},
				"TaskNotes/Activity/default--t_review123/events/t_review123-event1.md": {
					hermesEventKind: "completed",
					hermesEventSummary: "review handoff posted with verification evidence",
				},
			};
			return { frontmatter: frontmatterByPath[path] };
		});
		const container = createHermesTaskReviewSurface({
			plugin: {
				app: { metadataCache: { getCache } },
				settings: {},
			} as any,
			task: task({
				customProperties: {
					hermesComments: [
						"[[TaskNotes/Activity/default--t_review123/comments/t_review123-comment1|Comment 1]]",
					],
					hermesRuns: [
						"[[TaskNotes/Activity/default--t_review123/runs/t_review123-run1110|Run 1110]]",
					],
					hermesEvents: [
						"[[TaskNotes/Activity/default--t_review123/events/t_review123-event1|completed]]",
					],
				},
			}),
		});

		expect(container.textContent).toContain(
			"confirm the archive fallback and activity rendering before merge"
		);
		expect(container.textContent).toContain("Implemented review surface fixes");
		expect(container.textContent).toContain("HermesTaskReviewSurface.test.ts --runInBand passed");
		expect(container.textContent).toContain("review handoff posted with verification evidence");
		expect(container.textContent).not.toContain("[[TaskNotes/Activity");
	});

	it("does not infer Loop handoff state from normal Hermes task state properties", () => {
		const container = createHermesTaskReviewSurface({
			plugin: { app: {}, settings: {} } as any,
			task: task({
				status: "running",
				customProperties: {
					hermesLoopHandoffId: undefined,
					hermesLoopHandoffKind: undefined,
					hermesLoopHandoffState: undefined,
					hermesLoopVerificationState: undefined,
					hermesLoopReviewBatchId: undefined,
					hermesLoopQueuePosition: undefined,
					hermesLoopPendingCount: undefined,
					hermesLoopActiveCount: undefined,
					hermesLoopTotalCount: undefined,
					hermesLoopReviewerSessionId: undefined,
					hermesLoopWorkerSessionId: undefined,
					hermesLoopAuditLink: undefined,
					hermesLoopAutoActions: undefined,
					state: "running",
					decision: "none",
				},
			}),
		});

		expect(container.textContent).toContain("No Loop handoff has been recorded");
		expect(container.textContent).not.toContain("State Running");
		expect(container.textContent).not.toContain("Agents / Loop overlay");
	});
});
