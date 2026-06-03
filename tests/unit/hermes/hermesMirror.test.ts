import {
	buildHermesMirrorContent,
	buildHermesMirrorUpdates,
	hermesStatusToTaskNotesStatus,
} from "../../../src/hermes/hermesMirror";
import type { HermesTaskRecord } from "../../../src/hermes/hermesApiClient";

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
		expect(content).toContain("- task");
		expect(content).toContain("- hermes-kanban");
		expect(content).toContain("projects:");
		expect(content).toContain("- Hermes/job-hunt");
		expect(content).toContain("contexts:\n  - research-librarian");
		expect(content).not.toContain("assignee: research-librarian");
		expect(content).toContain("blockedBy:");
		expect(content).toContain("[[TaskNotes/job-hunt/t_parent]]");
		expect(content).toContain("comments:");
		expect(content).toContain("runs:");
		expect(content).toContain("events:");
		expect(content).toContain("[[TaskNotes/job-hunt/activity/comments/comment1|Comment 1]]");
		expect(content).toContain("[[TaskNotes/job-hunt/activity/runs/run12|Run 12]]");
		expect(content).toContain("[[TaskNotes/job-hunt/activity/events/event1|Event 1]]");
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

	it("mirrors Hermes archived tasks through the native TaskNotes archive tag", () => {
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
		expect(content).toContain("- archived");
		expect(content).not.toContain("status: archived");
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

		expect(content).toContain("comments:");
		expect(content).toContain("[[TaskNotes/default/activity/comments/comment1|Comment 1]]");
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
});
