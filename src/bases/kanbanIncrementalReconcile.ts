export type KanbanIncrementalScopeSnapshot = {
	key: string;
	paths: readonly string[];
	usesVirtualScrolling: boolean;
};

export type KanbanIncrementalUpdatePlan =
	| { kind: "incremental" }
	| {
			kind: "full-render";
			reason:
				| "missing-previous-snapshot"
				| "structural-signature-changed"
				| "scope-keys-changed"
				| "virtualization-mode-changed";
	  };

export type PlanKanbanIncrementalUpdateInput = {
	previousStructuralSignature: string | null;
	nextStructuralSignature: string;
	previousScopes: readonly KanbanIncrementalScopeSnapshot[];
	nextScopes: readonly KanbanIncrementalScopeSnapshot[];
};

export function planKanbanIncrementalUpdate({
	previousStructuralSignature,
	nextStructuralSignature,
	previousScopes,
	nextScopes,
}: PlanKanbanIncrementalUpdateInput): KanbanIncrementalUpdatePlan {
	if (!previousStructuralSignature || previousScopes.length === 0) {
		return { kind: "full-render", reason: "missing-previous-snapshot" };
	}

	if (previousStructuralSignature !== nextStructuralSignature) {
		return { kind: "full-render", reason: "structural-signature-changed" };
	}

	if (previousScopes.length !== nextScopes.length) {
		return { kind: "full-render", reason: "scope-keys-changed" };
	}

	for (let index = 0; index < nextScopes.length; index += 1) {
		const previousScope = previousScopes[index];
		const nextScope = nextScopes[index];
		if (previousScope.key !== nextScope.key) {
			return { kind: "full-render", reason: "scope-keys-changed" };
		}
		if (previousScope.usesVirtualScrolling !== nextScope.usesVirtualScrolling) {
			return { kind: "full-render", reason: "virtualization-mode-changed" };
		}
	}

	return { kind: "incremental" };
}
