import type { TaskInfo } from "../../../src/types";
import { planHermesCanonicalMirrorMigration } from "../../../src/hermes/hermesCanonicalMigration";

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Task",
		status: "ready",
		priority: "normal",
		path: "TaskNotes/Tasks/t_default.md",
		archived: false,
		tags: ["task"],
		contexts: [],
		projects: [],
		customProperties: { hermesTaskId: "t_default", hermesBoard: "default" },
		...overrides,
	};
}

describe("Hermes canonical mirror migration planning", () => {
	it("plans legacy board-prefixed mirrors for canonical TaskNotes/Tasks backfill", () => {
		const plan = planHermesCanonicalMirrorMigration([
			createTask({
				path: "TaskNotes/default/t_legacy.md",
				customProperties: { hermesTaskId: "t_legacy", hermesBoard: "default" },
			}),
			createTask({
				path: "TaskNotes/Tasks/t_current.md",
				customProperties: { hermesTaskId: "t_current", hermesBoard: "developer" },
			}),
		]);

		expect(plan.migrations).toEqual([
			{
				taskId: "t_legacy",
				board: "default",
				fromPath: "TaskNotes/default/t_legacy.md",
				toPath: "TaskNotes/Tasks/default--t_legacy.md",
				reason: "legacy-board-prefixed-path",
			},
			{
				taskId: "t_current",
				board: "developer",
				fromPath: "TaskNotes/Tasks/t_current.md",
				toPath: "TaskNotes/Tasks/developer--t_current.md",
				reason: "noncanonical-managed-path",
			},
		]);
		expect(plan.duplicates).toEqual([]);
		expect(plan.orphans).toEqual([]);
	});

	it("surfaces duplicate mirrors instead of choosing a destructive migration", () => {
		const plan = planHermesCanonicalMirrorMigration([
			createTask({
				path: "TaskNotes/default/t_dup.md",
				customProperties: { hermesTaskId: "t_dup", hermesBoard: "default" },
			}),
			createTask({
				path: "TaskNotes/Tasks/t_dup.md",
				customProperties: { hermesTaskId: "t_dup", hermesBoard: "default" },
			}),
		]);

		expect(plan.migrations).toEqual([]);
		expect(plan.duplicates).toEqual([
			{
				taskId: "t_dup",
				board: "default",
				canonicalPath: "TaskNotes/Tasks/default--t_dup.md",
				paths: ["TaskNotes/Tasks/t_dup.md", "TaskNotes/default/t_dup.md"],
			},
		]);
	});

	it("marks managed local mirrors as orphaned when Hermes no longer returns the task", () => {
		const plan = planHermesCanonicalMirrorMigration(
			[
				createTask({
					path: "TaskNotes/Tasks/t_live.md",
					customProperties: { hermesTaskId: "t_live", hermesBoard: "default" },
				}),
				createTask({
					path: "TaskNotes/Tasks/t_missing.md",
					customProperties: { hermesTaskId: "t_missing", hermesBoard: "default" },
				}),
			],
			{ remoteTaskIdsByBoard: { default: ["t_live"] } }
		);

		expect(plan.orphans).toEqual([
			{
				taskId: "t_missing",
				board: "default",
				path: "TaskNotes/Tasks/t_missing.md",
				reason: "missing-from-hermes-board",
			},
		]);
	});

	it("migrates an unqualified TaskNotes/Tasks note when hermesBoard makes the destination unambiguous", () => {
		const plan = planHermesCanonicalMirrorMigration([
			createTask({
				path: "TaskNotes/Tasks/t_unqualified.md",
				customProperties: { hermesTaskId: "t_unqualified", hermesBoard: "default" },
			}),
		]);

		expect(plan.migrations).toEqual([
			{
				taskId: "t_unqualified",
				board: "default",
				fromPath: "TaskNotes/Tasks/t_unqualified.md",
				toPath: "TaskNotes/Tasks/default--t_unqualified.md",
				reason: "noncanonical-managed-path",
			},
		]);
		expect(plan.duplicates).toEqual([]);
	});

	it("migrates an old board-directory TaskNotes/Tasks note when hermesBoard makes the destination unambiguous", () => {
		const plan = planHermesCanonicalMirrorMigration([
			createTask({
				path: "TaskNotes/Tasks/developer/t_partial.md",
				customProperties: { hermesTaskId: "t_partial", hermesBoard: "developer" },
			}),
		]);

		expect(plan.migrations).toEqual([
			{
				taskId: "t_partial",
				board: "developer",
				fromPath: "TaskNotes/Tasks/developer/t_partial.md",
				toPath: "TaskNotes/Tasks/developer--t_partial.md",
				reason: "noncanonical-managed-path",
			},
		]);
		expect(plan.duplicates).toEqual([]);
	});

	it("skips an unqualified TaskNotes/Tasks note safely when board identity is unknown", () => {
		const plan = planHermesCanonicalMirrorMigration([
			createTask({
				path: "TaskNotes/Tasks/t_unknown.md",
				customProperties: { hermesTaskId: "t_unknown" },
			}),
		]);

		expect(plan.migrations).toEqual([]);
		expect(plan.duplicates).toEqual([]);
		expect(plan.orphans).toEqual([]);
	});
});
