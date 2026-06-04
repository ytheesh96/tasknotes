import {
	buildAgentRoster,
	type AgentRosterViewOptions,
} from "../../../src/bases/AgentRosterView";
import { getLocalHermesMirrorTasksForBoard } from "../../../src/bases/hermesBoardMirrors";
import type { TaskInfo } from "../../../src/types";

const options: AgentRosterViewOptions = {
	agentProperty: "assignee",
	agentFallbackProperty: "contexts",
	boardProperty: "projects",
	statusProperty: "status",
	submitStatus: "triage",
	submitTag: "hermes-submit",
	defaultBoard: "default",
	maxTasksPerAgent: 4,
	readyStatuses: new Set(["triage", "todo", "scheduled", "ready"]),
	busyStatuses: new Set(["running"]),
	reviewStatuses: new Set(["review"]),
	ignoredAgentValues: new Set(["hermes-kanban"]),
};

function task(overrides: Partial<TaskInfo>): TaskInfo {
	return {
		title: "Task",
		status: "ready",
		priority: "normal",
		path: "TaskNotes/default/t_1.md",
		archived: false,
		...overrides,
	};
}

describe("AgentRosterView", () => {
	it("groups tasks by assignee and derives Hermes boards from projects", () => {
		const roster = buildAgentRoster(
			[
				task({
					title: "Run implementation",
					status: "running",
					projects: ["Hermes/obsidian-os"],
					customProperties: { assignee: "codex" },
				}),
				task({
					title: "Review result",
					status: "review",
					projects: ["Hermes/obsidian-os"],
					customProperties: { assignee: "codex" },
				}),
			],
			options
		);

		expect(roster).toHaveLength(1);
		expect(roster[0]).toMatchObject({
			name: "codex",
			primaryBoard: "obsidian-os",
			status: "busy",
			runningCount: 1,
			reviewCount: 1,
		});
	});

	it("falls back to contexts while ignoring Hermes system context values", () => {
		const roster = buildAgentRoster(
			[
				task({
					title: "Specify task",
					status: "ready",
					contexts: ["hermes-kanban", "planner"],
					projects: ["Hermes/default"],
				}),
			],
			options
		);

		expect(roster).toHaveLength(1);
		expect(roster[0].name).toBe("planner");
		expect(roster[0].readyCount).toBe(1);
	});

	it("skips archived tasks", () => {
		const roster = buildAgentRoster(
			[
				task({
					archived: true,
					customProperties: { assignee: "codex" },
					projects: ["Hermes/default"],
				}),
			],
			options
		);

		expect(roster).toEqual([]);
	});

	it("selects only local Hermes mirror notes for board deletion cleanup", () => {
		const mirror = task({
			path: "TaskNotes/job-hunt/t_abc12345.md",
			projects: ["Hermes/job-hunt"],
		});
		const otherBoardMirror = task({
			path: "TaskNotes/default/t_abc12345.md",
			projects: ["Hermes/default"],
		});
		const ordinaryNote = task({
			path: "Notes/job-hunt.md",
			projects: ["Hermes/job-hunt"],
		});
		const nestedNote = task({
			path: "TaskNotes/job-hunt/nested/t_nested.md",
			projects: ["Hermes/job-hunt"],
		});

		expect(
			getLocalHermesMirrorTasksForBoard(
				[mirror, otherBoardMirror, ordinaryNote, nestedNote],
				"job-hunt"
			)
		).toEqual([mirror]);
	});
});
