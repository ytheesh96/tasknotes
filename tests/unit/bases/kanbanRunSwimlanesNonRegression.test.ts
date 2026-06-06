import {
	HERMES_NO_RUN_LANE_ID,
	HERMES_UNKNOWN_RUN_LANE_ID,
	createHermesRunAttemptSnapshot,
	resolveHermesRunLaneId,
	reassignHermesTaskRunSnapshot,
	countDistinctHermesRunLaneTasks,
} from "../../../src/bases/kanbanRunSwimlanes";

describe("Hermes run swimlane non-regression contracts", () => {
	const runs = new Map([
		["run_root", { id: "run_root", tenant: "tenant-a" }],
		["run_child", { id: "run_child", root_run_id: "run_root", tenant: "tenant-a" }],
		["run_other_tenant", { id: "run_other_tenant", tenant: "tenant-b" }],
	]);

	it("keeps board/project boundary external by resolving only already-visible tasks", () => {
		const visibleTask = { id: "t_visible", run_id: "run_root", board: "developer" };
		const hiddenTask = { id: "t_hidden", run_id: "run_root", board: "other-board" };

		expect(resolveHermesRunLaneId(visibleTask, runs, { runScope: "root", tenant: "tenant-a" })).toBe(
			"run_root"
		);
		expect([visibleTask].map((task) => task.id)).not.toContain(hiddenTask.id);
	});

	it("does not infer run lanes from branch worktree or assignee metadata", () => {
		const taskA = {
			id: "t_a",
			run_id: null,
			branch_name: "feature/run-swimlanes",
			workspace_path: "/tmp/shared",
			workspace_kind: "worktree",
			assignee: "peacock",
		};
		const taskB = {
			id: "t_b",
			run_id: null,
			branch_name: "feature/run-swimlanes",
			workspace_path: "/tmp/shared",
			workspace_kind: "worktree",
			assignee: "peacock",
		};

		expect(resolveHermesRunLaneId(taskA, runs, { runScope: "root", tenant: "tenant-a" })).toBe(
			HERMES_NO_RUN_LANE_ID
		);
		expect(resolveHermesRunLaneId(taskB, runs, { runScope: "root", tenant: "tenant-a" })).toBe(
			HERMES_NO_RUN_LANE_ID
		);
	});

	it("separates No run and tenant-invisible Unknown run lanes", () => {
		expect(resolveHermesRunLaneId({ id: "t_none", run_id: null }, runs, { tenant: "tenant-a" })).toBe(
			HERMES_NO_RUN_LANE_ID
		);
		expect(
			resolveHermesRunLaneId({ id: "t_unknown", run_id: "missing" }, runs, { tenant: "tenant-a" })
		).toBe(HERMES_UNKNOWN_RUN_LANE_ID);
		expect(
			resolveHermesRunLaneId({ id: "t_cross", run_id: "run_other_tenant" }, runs, {
				tenant: "tenant-a",
			})
		).toBe(HERMES_UNKNOWN_RUN_LANE_ID);
	});

	it("supports nested root scope while direct scope keeps exact run assignment", () => {
		const task = { id: "t_child", run_id: "run_child" };

		expect(resolveHermesRunLaneId(task, runs, { runScope: "root", tenant: "tenant-a" })).toBe(
			"run_root"
		);
		expect(resolveHermesRunLaneId(task, runs, { runScope: "direct", tenant: "tenant-a" })).toBe(
			"run_child"
		);
	});

	it("counts retry attempts once per task for lane totals", () => {
		const laneTasks = [
			{ id: "t_retry", attempt_id: 1 },
			{ id: "t_retry", attempt_id: 2 },
			{ id: "t_other", attempt_id: 3 },
		];

		expect(countDistinctHermesRunLaneTasks(laneTasks)).toBe(2);
	});

	it("explicit reassignment updates task audit fields and future attempts only", () => {
		const task = { id: "t_reassign", run_id: "run_root" };
		const historicalAttempts = [
			{ id: 1, task_id: "t_reassign", logical_run_id: "run_root", attempt_number: 1 },
		];

		const reassigned = reassignHermesTaskRunSnapshot(task, {
			runId: "run_child",
			source: "dashboard_edit",
			actor: "tasknotes",
			assignedAt: 1780000000,
		});
		const futureAttempt = createHermesRunAttemptSnapshot(reassigned, historicalAttempts);

		expect(reassigned).toEqual({
			id: "t_reassign",
			run_id: "run_child",
			run_assigned_at: 1780000000,
			run_assignment_source: "dashboard_edit",
			run_assignment_actor: "tasknotes",
		});
		expect(historicalAttempts[0].logical_run_id).toBe("run_root");
		expect(futureAttempt).toEqual({
			task_id: "t_reassign",
			logical_run_id: "run_child",
			attempt_number: 2,
			retry_of_attempt_run_id: 1,
		});
	});
});
