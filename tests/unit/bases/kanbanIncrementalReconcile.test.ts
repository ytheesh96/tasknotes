import {
	planKanbanIncrementalUpdate,
	type KanbanIncrementalScopeSnapshot,
} from "../../../src/bases/kanbanIncrementalReconcile";

function scope(
	key: string,
	paths: string[],
	usesVirtualScrolling = false
): KanbanIncrementalScopeSnapshot {
	return { key, paths, usesVirtualScrolling };
}

describe("kanban incremental reconcile planning", () => {
	it("allows incremental updates when existing scopes remain stable", () => {
		const plan = planKanbanIncrementalUpdate({
			previousStructuralSignature: "status-flat",
			nextStructuralSignature: "status-flat",
			previousScopes: [scope("todo", ["a.md", "b.md"]), scope("done", ["c.md"])],
			nextScopes: [scope("todo", ["b.md"]), scope("done", ["a.md", "c.md"])],
		});

		expect(plan).toEqual({ kind: "incremental" });
	});

	it("requires a full render when the board structure changes", () => {
		const plan = planKanbanIncrementalUpdate({
			previousStructuralSignature: "status-flat",
			nextStructuralSignature: "priority-flat",
			previousScopes: [scope("todo", ["a.md"])],
			nextScopes: [scope("high", ["a.md"])],
		});

		expect(plan).toEqual({
			kind: "full-render",
			reason: "structural-signature-changed",
		});
	});

	it("requires a full render when visible scopes are added or removed", () => {
		const plan = planKanbanIncrementalUpdate({
			previousStructuralSignature: "status-flat",
			nextStructuralSignature: "status-flat",
			previousScopes: [scope("todo", ["a.md"])],
			nextScopes: [scope("todo", ["a.md"]), scope("done", ["b.md"])],
		});

		expect(plan).toEqual({
			kind: "full-render",
			reason: "scope-keys-changed",
		});
	});

	it("requires a full render when a scope crosses the virtual-scroll threshold", () => {
		const plan = planKanbanIncrementalUpdate({
			previousStructuralSignature: "status-flat",
			nextStructuralSignature: "status-flat",
			previousScopes: [scope("todo", ["a.md", "b.md"], false)],
			nextScopes: [scope("todo", ["a.md", "b.md", "c.md"], true)],
		});

		expect(plan).toEqual({
			kind: "full-render",
			reason: "virtualization-mode-changed",
		});
	});
});
