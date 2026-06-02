import { buildHermesMirrorContent } from "../../../src/hermes/hermesMirror";
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
		});
		const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

		expect(body).toBe("Do the actual work.\n\nKeep this content visible.");
		expect(content).toContain("type: task");
		expect(content).toContain("- task");
		expect(content).toContain("- hermes-kanban");
		expect(content).toContain("projects:");
		expect(content).toContain("- Hermes/job-hunt");
		expect(content).toContain("assignee: research-librarian");
		expect(content).toContain("blockedBy:");
		expect(content).toContain("[[TaskNotes/job-hunt/t_parent]]");
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
		expect(body).not.toContain("tasknotes-hermes-api");
	});
});
