import type { FieldGroup, TaskModalFieldsConfig, UserMappedField } from "../types/settings";

const CONTROL_PANEL_FIELD_GROUPS: TaskModalFieldsConfig["groups"] = [
	{
		id: "basic",
		displayName: "Task",
		order: 0,
		collapsible: false,
		defaultCollapsed: false,
	},
	{
		id: "routing",
		displayName: "Routing",
		order: 1,
		collapsible: true,
		defaultCollapsed: false,
	},
	{
		id: "dependencies",
		displayName: "Dependencies",
		order: 2,
		collapsible: true,
		defaultCollapsed: true,
	},
	{
		id: "metadata",
		displayName: "TaskNotes Metadata",
		order: 3,
		collapsible: true,
		defaultCollapsed: true,
	},
	{
		id: "organization",
		displayName: "TaskNotes Organization",
		order: 4,
		collapsible: true,
		defaultCollapsed: true,
	},
	{
		id: "custom",
		displayName: "Other Fields",
		order: 5,
		collapsible: true,
		defaultCollapsed: true,
	},
];

export const HERMES_DEFAULT_ASSIGNEES = [
	"orchestrator",
	"research-librarian",
	"peacock",
	"reviewer-qa",
	"codex",
	"human",
	"user",
] as const;

export const HERMES_ASSIGNEE_FIELD: UserMappedField = {
	id: "assignee",
	displayName: "Assignee",
	key: "assignee",
	type: "list",
	defaultValue: [...HERMES_DEFAULT_ASSIGNEES],
};

export const HERMES_ASSIGNEE_PROPERTY_ID = `user:${HERMES_ASSIGNEE_FIELD.id}`;

const LEGACY_HERMES_USER_FIELD_IDS = new Set([
	"assignee",
	"hermes_id",
	"hermes_board",
	"hermes_assignee",
	"hermes_priority",
	"hermes_tenant",
	"hermes_created_by",
	"hermes_workspace_kind",
	"hermes_workspace_path",
	"hermes_branch_name",
	"blocks",
	"blocked_by",
	"handoff_to",
	"requires_human_decision",
	"writeback_mode",
	"sync_origin",
	"sync_hash",
	"last_synced",
	"writeback_reason",
	"writeback_result",
	"writeback_summary",
	"writeback_comment",
	"hermes_parent",
	"hermes_submit_key",
	"hermes_submit",
]);
const LEGACY_MODAL_GROUP_MAP = new Map<string, FieldGroup>([
	["hermes-intake", "routing"],
	["hermes-actions", "routing"],
	["hermes-state", "routing"],
	["hermes-system", "routing"],
]);
const CONTROL_PANEL_BOARD_PATH = /^TaskNotes\/[^/]+\/t_[^/]+\.md$/;
const CONTROL_PANEL_GROUP_IDS = new Set<FieldGroup>(
	CONTROL_PANEL_FIELD_GROUPS.map((group) => group.id)
);

export function ensureHermesAssigneeUserField(
	userFields: readonly UserMappedField[] | undefined,
	_defaultValueSeeds: readonly unknown[] = []
): UserMappedField[] {
	return (userFields ?? []).filter((field) => !isHermesAssigneeUserField(field));
}

export function hasHermesAssigneeUserField(
	userFields: readonly UserMappedField[] | undefined
): boolean {
	return (userFields ?? []).some(isHermesAssigneeUserField);
}

export function isHermesAssigneeUserField(
	field: Pick<UserMappedField, "id" | "key"> | undefined
): boolean {
	return Boolean(field && (field.id === "assignee" || field.key === "assignee"));
}

export function findHermesAssigneeUserField(
	userFields: readonly UserMappedField[] | undefined
): UserMappedField | undefined {
	return (userFields ?? []).find(isHermesAssigneeUserField);
}

export function getHermesAssigneePropertyId(
	field: Pick<UserMappedField, "id" | "key"> | undefined
): `user:${string}` {
	return `user:${field?.id || HERMES_ASSIGNEE_FIELD.id}`;
}

export function isHermesAssigneePropertyId(propertyId: string | undefined): boolean {
	return propertyId === HERMES_ASSIGNEE_PROPERTY_ID || propertyId === "user:assignee";
}

export function isLegacyHermesUserField(field: Pick<UserMappedField, "id" | "key">): boolean {
	return LEGACY_HERMES_USER_FIELD_IDS.has(field.id) || LEGACY_HERMES_USER_FIELD_IDS.has(field.key);
}

export function mergeHermesAssigneeDefaultValues(...sources: readonly unknown[]): string[] {
	const values: string[] = [];
	const seen = new Set<string>();

	const add = (item: unknown) => {
		if (Array.isArray(item)) {
			for (const child of item) {
				add(child);
			}
			return;
		}
		if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
			return;
		}

		const candidates =
			typeof item === "string" ? item.split(",").map((part) => part.trim()) : [String(item)];
		for (const candidate of candidates) {
			const key = candidate.toLowerCase();
			if (!candidate || key === "none" || seen.has(key)) {
				continue;
			}
			seen.add(key);
			values.push(candidate);
		}
	};

	for (const source of sources) {
		add(source);
	}

	return values;
}

export function normalizeHermesAssigneeUserField(
	field: UserMappedField,
	defaultValueSeeds: readonly unknown[] = []
): UserMappedField {
	const baseDefaultValue =
		field.defaultValue === undefined ? HERMES_DEFAULT_ASSIGNEES : field.defaultValue;
	const defaultValue = mergeHermesAssigneeDefaultValues(
		baseDefaultValue,
		defaultValueSeeds,
	);
	const normalizedField: UserMappedField = {
		...field,
		id: HERMES_ASSIGNEE_FIELD.id,
		displayName: HERMES_ASSIGNEE_FIELD.displayName,
		key: HERMES_ASSIGNEE_FIELD.key,
		type: "list",
		defaultValue,
	};
	const existingDefaults = Array.isArray(field.defaultValue) ? field.defaultValue : [];
	const sameDefaults =
		existingDefaults.length === defaultValue.length &&
		existingDefaults.every((value, index) => value === defaultValue[index]);

	if (
		field.id === normalizedField.id &&
		field.displayName === normalizedField.displayName &&
		field.key === normalizedField.key &&
		field.type === normalizedField.type &&
		sameDefaults
	) {
		return field;
	}

	return normalizedField;
}

export function collectHermesAssigneesFromMirrorNotes(app: unknown): string[] {
	if (!app) {
		return [];
	}

	const source = app as {
		vault?: { getMarkdownFiles?: () => Array<{ path: string }> };
		metadataCache?: {
			getFileCache?: (file: { path: string }) => { frontmatter?: Record<string, unknown> } | null;
			getCache?: (path: string) => { frontmatter?: Record<string, unknown> } | null;
		};
	};

	const files = source.vault?.getMarkdownFiles?.() ?? [];
	const values = mergeHermesAssigneeDefaultValues(
		files
			.filter((file) => CONTROL_PANEL_BOARD_PATH.test(file.path))
			.flatMap((file) => {
				const frontmatter =
					source.metadataCache?.getFileCache?.(file)?.frontmatter ??
					source.metadataCache?.getCache?.(file.path)?.frontmatter;
				const board = file.path.match(/^TaskNotes\/([^/]+)\//)?.[1];
				const contexts = Array.isArray(frontmatter?.contexts)
					? frontmatter.contexts.filter((context) => context !== board && context !== "hermes-kanban")
					: frontmatter?.contexts;
				return [contexts, frontmatter?.assignee];
			})
	);

	return values.sort((a, b) => a.localeCompare(b));
}

function isLegacyHermesFieldId(id: string | undefined): boolean {
	return Boolean(id && LEGACY_HERMES_USER_FIELD_IDS.has(id));
}

function normalizeModalFieldGroup(group: unknown): FieldGroup {
	const groupId = typeof group === "string" ? group : "";
	return LEGACY_MODAL_GROUP_MAP.get(groupId) ?? (CONTROL_PANEL_GROUP_IDS.has(groupId as FieldGroup)
		? (groupId as FieldGroup)
		: "custom");
}

export function normalizeHermesUserFields(
	userFields: readonly UserMappedField[] | undefined
): { fields: UserMappedField[]; changed: boolean } {
	const fieldsWithoutLegacy = (userFields ?? []).filter((field) => !isLegacyHermesUserField(field));
	return {
		fields: fieldsWithoutLegacy,
		changed:
			fieldsWithoutLegacy.length !== (userFields ?? []).length ||
			fieldsWithoutLegacy.some((field, index) => field !== userFields?.[index]),
	};
}

export function normalizeHermesModalFieldsConfig(
	config: TaskModalFieldsConfig | undefined
): { config: TaskModalFieldsConfig | undefined; changed: boolean } {
	if (!config) {
		return { config, changed: false };
	}
	const fieldsWithoutLegacy: TaskModalFieldsConfig["fields"] = config.fields
		.filter((field) => !isLegacyHermesFieldId(field.id))
		.map((field) => ({
			...field,
			group: normalizeModalFieldGroup(field.group),
		}));
	const changed =
		JSON.stringify(config.groups) !== JSON.stringify(CONTROL_PANEL_FIELD_GROUPS) ||
		fieldsWithoutLegacy.length !== config.fields.length ||
		fieldsWithoutLegacy.some((field, index) => field !== config.fields[index]);
	return {
		config: changed
			? { ...config, groups: [...CONTROL_PANEL_FIELD_GROUPS], fields: fieldsWithoutLegacy }
			: config,
		changed,
	};
}

export function normalizeHermesAssignee(value: unknown): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const assignee = normalizeHermesAssignee(item);
			if (assignee) {
				return assignee;
			}
		}
		return null;
	}
	if (typeof value !== "string" && typeof value !== "number") {
		return null;
	}
	const assignee = String(value).trim();
	return assignee && assignee.toLowerCase() !== "none" ? assignee : null;
}

export function buildHermesAssigneeUpdatePayload(
	value: unknown
): { assignee: string | null; status?: string; block_reason?: string } | null {
	const assignee = normalizeHermesAssignee(value);
	if (!assignee) {
		return { assignee: null };
	}
	return { assignee };
}
