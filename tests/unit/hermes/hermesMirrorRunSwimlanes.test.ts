import { buildHermesMirrorUpdates } from "../../../src/hermes/hermesMirror";
import type { HermesTaskRecord } from "../../../src/hermes/hermesApiClient";

describe("Hermes mirror logical run fields", () => {
	it("mirrors logical run metadata for run swimlane grouping", () => {
		const updates = buildHermesMirrorUpdates(
			"developer",
			{
				id: "t_run",
				title: "Task in run",
				status: "running",
				run_id: "run_root",
				run_title: "User request: run swimlanes",
				run_type: "user",
				root_run_id: "run_root",
			} as HermesTaskRecord,
			"2026-06-05T00:00:00.000Z"
		);

		expect(updates.customFrontmatter).toMatchObject({
			hermesRunId: "run_root",
			hermesRootRunId: "run_root",
			hermesRunTitle: "User request: run swimlanes",
			hermesRunType: "user",
		});
	});
});
