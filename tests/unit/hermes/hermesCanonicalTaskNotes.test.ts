import type { TaskInfo } from "../../../src/types";
import {
	HERMES_BOARD_FRONTMATTER,
	HERMES_BOARD_MOVE_API_PATH,
	HERMES_BOARD_MOVE_API_SUPPORT,
	HERMES_CANONICAL_SYNC_FRONTMATTER,
	HERMES_LEGACY_SYNC_FRONTMATTER_ALIASES,
	evaluateHermesBoardMovePolicy,
	readHermesArchivedFrontmatter,
	readHermesBoardFrontmatter,
	readHermesTaskIdFrontmatter,
} from "../../../src/hermes/hermesCanonicalTaskNotes";
import { getHermesTaskIdentity } from "../../../src/hermes/hermesApiClient";

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
		customProperties: {},
		...overrides,
	};
}

describe("Hermes canonical TaskNotes frontmatter", () => {
	it("centralizes camelCase canonical sync property names", () => {
		expect(HERMES_CANONICAL_SYNC_FRONTMATTER).toEqual({
			taskId: "hermesTaskId",
			board: "hermesBoard",
			archived: "hermesArchived",
		});
		expect(HERMES_BOARD_FRONTMATTER).toBe("hermesBoard");
	});

	it("reads legacy snake_case aliases without changing canonical defaults", () => {
		const frontmatter = {
			hermes_task_id: " t_legacy ",
			hermes_board: " developer ",
			hermes_archived: "true",
		};

		expect(readHermesTaskIdFrontmatter(frontmatter)).toBe("t_legacy");
		expect(readHermesBoardFrontmatter(frontmatter)).toBe("developer");
		expect(readHermesArchivedFrontmatter(frontmatter)).toBe(true);
		expect(HERMES_LEGACY_SYNC_FRONTMATTER_ALIASES.board).toContain("hermes_board");
	});

	it("prefers canonical camelCase values over legacy aliases", () => {
		const frontmatter = {
			hermesTaskId: "t_canonical",
			hermes_task_id: "t_legacy",
			hermesBoard: "default",
			hermes_board: "developer",
			hermesArchived: false,
			hermes_archived: true,
		};

		expect(readHermesTaskIdFrontmatter(frontmatter)).toBe("t_canonical");
		expect(readHermesBoardFrontmatter(frontmatter)).toBe("default");
		expect(readHermesArchivedFrontmatter(frontmatter)).toBe(false);
	});

	it("uses legacy aliases only to recover managed identity for migration/backfill", () => {
		const identity = getHermesTaskIdentity(
			createTask({
				path: "TaskNotes/Tasks/t_legacy.md",
				customProperties: { hermes_task_id: "t_legacy", hermes_board: "developer" },
			})
		);

		expect(identity).toEqual({ board: "developer", id: "t_legacy" });
	});

	it("blocks local board edits because Hermes exposes no board move API", () => {
		expect(HERMES_BOARD_MOVE_API_SUPPORT).toBe("unsupported");
		expect(HERMES_BOARD_MOVE_API_PATH).toBeNull();
		expect(evaluateHermesBoardMovePolicy("default", "default")).toEqual({
			action: "allow",
			sourceBoard: "default",
			desiredBoard: "default",
			reason: "Hermes board did not change.",
		});
		expect(evaluateHermesBoardMovePolicy("default", "developer")).toEqual({
			action: "revert",
			sourceBoard: "default",
			desiredBoard: "developer",
			revertToBoard: "default",
			reason: "Hermes Kanban API does not expose a task board-move endpoint; local hermesBoard edits must be reverted until an API-backed move is available.",
		});
	});
});
