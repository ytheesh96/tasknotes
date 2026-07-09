import {
	AgentRosterView,
	buildAgentRoster,
	splitAgentRosterHistory,
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
	doneStatuses: new Set(["done", "completed"]),
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

	it("hides completed history from actionable roster tasks by default", () => {
		const roster = buildAgentRoster(
			[
				task({
					title: "Ship active work",
					status: "ready",
					projects: ["Hermes/default"],
					customProperties: { assignee: "codex" },
				}),
				task({
					title: "Past done work",
					status: "done",
					projects: ["Hermes/default"],
					customProperties: { assignee: "codex" },
				}),
				task({
					title: "Completed handoff",
					status: "completed",
					projects: ["Hermes/default"],
					customProperties: { assignee: "codex" },
				}),
			],
			options
		);

		expect(roster).toHaveLength(1);
		expect(roster[0].tasks.map((item) => item.title)).toEqual(["Ship active work"]);
		expect(roster[0].completedTasks.map((item) => item.title)).toEqual([
			"Completed handoff",
			"Past done work",
		]);
		expect(roster[0].completedCount).toBe(2);
		expect(roster[0].activeCount).toBe(1);
	});

	it("splits completed-only agents out of the default active roster", () => {
		const roster = buildAgentRoster(
			[
				task({
					title: "Active codex task",
					status: "ready",
					projects: ["Hermes/default"],
					customProperties: { assignee: "codex" },
				}),
				task({
					title: "Past reviewer task",
					status: "done",
					projects: ["Hermes/default"],
					customProperties: { assignee: "reviewer" },
				}),
			],
			options
		);

		const { activeRoster, completedOnlyRoster } = splitAgentRosterHistory(roster);

		expect(activeRoster.map((agent) => agent.name)).toEqual(["codex"]);
		expect(completedOnlyRoster.map((agent) => agent.name)).toEqual(["reviewer"]);
	});

	it("renders only the completed-only affordance when every agent has only history", async () => {
		const contentEl = document.createElement("div");
		const view = {
			contentEl,
			rootElement: document.createElement("div"),
			data: { data: true },
			dataAdapter: {
				extractDataItems: jest.fn(() => [
					{
						path: "TaskNotes/default/t_done.md",
						properties: {
							title: "Past reviewer task",
							status: "done",
							projects: ["Hermes/default"],
							assignee: "reviewer",
						},
					},
				]),
			},
			plugin: undefined,
			config: null,
			options,
			setupSearch: jest.fn(),
			applySearchFilter: jest.fn((tasks) => tasks),
			renderEmptyState: jest.fn(),
			renderSummary: jest.fn(),
			renderAgentCard: jest.fn(),
			renderCompletedAgentsHistory: jest.fn(function (this: { contentEl: HTMLElement }, agents) {
				(AgentRosterView.prototype as any).renderCompletedAgentsHistory.call(this, agents);
			}),
			renderError: jest.fn(),
		} as any;

		await AgentRosterView.prototype.render.call(view);

		expect(view.renderEmptyState).not.toHaveBeenCalled();
		expect(view.renderSummary).not.toHaveBeenCalled();
		expect(view.renderAgentCard).not.toHaveBeenCalled();
		expect(view.renderCompletedAgentsHistory).toHaveBeenCalledWith([
			expect.objectContaining({ name: "reviewer", activeCount: 0, completedCount: 1 }),
		]);
		expect(
			contentEl.querySelector(".agent-roster-view__completed-agents-toggle")?.textContent
		).toBe("Completed-only agents (1)");
		expect(contentEl.textContent).not.toContain("No agents found");
		expect(contentEl.querySelector(".agent-roster-view__agent")).toBeNull();
	});

	it("renders completed-only agents only after the history affordance is opened", () => {
		const [completedOnlyAgent] = buildAgentRoster(
			[
				task({
					title: "Past reviewer task",
					status: "done",
					path: "TaskNotes/default/t_done.md",
					projects: ["Hermes/default"],
					customProperties: { assignee: "reviewer" },
				}),
			],
			options
		);
		const contentEl = document.createElement("div");
		const renderedAgents: string[] = [];
		const view = {
			contentEl,
			renderAgentCard: jest.fn((_container: HTMLElement, agent) => {
				renderedAgents.push(agent.name);
			}),
		} as any;

		(AgentRosterView.prototype as any).renderCompletedAgentsHistory.call(view, [completedOnlyAgent]);

		expect(
			contentEl.querySelector(".agent-roster-view__completed-agents-toggle")?.textContent
		).toBe("Completed-only agents (1)");
		expect(contentEl.querySelector(".agent-roster-view__agent")).toBeNull();
		expect(renderedAgents).toEqual([]);

		const details = contentEl.querySelector<HTMLDetailsElement>(
			".agent-roster-view__completed-agents"
		);
		details!.open = true;
		details!.dispatchEvent(new Event("toggle"));

		expect(renderedAgents).toEqual(["reviewer"]);
	});

	it("renders active agent completed task rows only after completed history is opened", () => {
		const [agent] = buildAgentRoster(
			[
				task({
					title: "Active codex task",
					status: "ready",
					path: "TaskNotes/default/t_ready.md",
					projects: ["Hermes/default"],
					customProperties: { assignee: "codex" },
				}),
				task({
					title: "Past codex task",
					status: "done",
					path: "TaskNotes/default/t_done.md",
					projects: ["Hermes/default"],
					customProperties: { assignee: "codex" },
				}),
			],
			options
		);
		const contentEl = document.createElement("div");
		const view = {
			options,
			plugin: {},
			formatAgentStatus: (AgentRosterView.prototype as any).formatAgentStatus,
			renderAgentMetric: (AgentRosterView.prototype as any).renderAgentMetric,
			renderTaskRow: (AgentRosterView.prototype as any).renderTaskRow,
			openTask: jest.fn(),
			openSubmitTaskModal: jest.fn(),
		} as any;

		(AgentRosterView.prototype as any).renderAgentCard.call(view, contentEl, agent);

		expect(contentEl.textContent).toContain("Active codex task");
		expect(contentEl.textContent).toContain("Completed history (1)");
		expect(contentEl.textContent).not.toContain("Past codex task");
		expect(contentEl.querySelector('[data-task-path="TaskNotes/default/t_ready.md"]')).not.toBeNull();
		expect(contentEl.querySelector('[data-task-path="TaskNotes/default/t_done.md"]')).toBeNull();

		const details = contentEl.querySelector<HTMLDetailsElement>(".agent-roster-view__history");
		details!.open = true;
		details!.dispatchEvent(new Event("toggle"));

		expect(contentEl.textContent).toContain("Past codex task");
		expect(contentEl.querySelector('[data-task-path="TaskNotes/default/t_done.md"]')).not.toBeNull();
	});

	it("selects only local Hermes mirror notes for board deletion cleanup", () => {
		const mirror = task({
			path: "TaskNotes/Tasks/job-hunt--t_abc12345.md",
			projects: ["Hermes/job-hunt"],
		});
		const otherBoardMirror = task({
			path: "TaskNotes/Tasks/default--t_abc12345.md",
			projects: ["Hermes/default"],
		});
		const legacyDirectBoardMirror = task({
			path: "TaskNotes/job-hunt/t_legacy123.md",
			projects: ["Hermes/job-hunt"],
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
				[mirror, otherBoardMirror, legacyDirectBoardMirror, ordinaryNote, nestedNote],
				"job-hunt"
			)
		).toEqual([mirror, legacyDirectBoardMirror]);
	});
});
