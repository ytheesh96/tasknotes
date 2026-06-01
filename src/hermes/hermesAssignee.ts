import type { TaskModalFieldsConfig, UserMappedField } from "../types/settings";

export const HERMES_ASSIGNEE_FIELD: UserMappedField = {
	id: "assignee",
	displayName: "Assignee",
	key: "assignee",
	type: "text",
};

const HUMAN_ASSIGNEES = new Set(["human", "user", "yt", "vaitheesh"]);
const LEGACY_HERMES_USER_FIELD_IDS = new Set([
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

export function ensureHermesAssigneeUserField(
	userFields: readonly UserMappedField[] | undefined
): UserMappedField[] {
	const fields = [...(userFields ?? [])];
	const existing = fields.find((field) => field.id === "assignee" || field.key === "assignee");
	if (existing) {
		return fields;
	}
	return [...fields, { ...HERMES_ASSIGNEE_FIELD }];
}

export function hasHermesAssigneeUserField(
	userFields: readonly UserMappedField[] | undefined
): boolean {
	return (userFields ?? []).some((field) => field.id === "assignee" || field.key === "assignee");
}

export function isLegacyHermesUserField(field: Pick<UserMappedField, "id" | "key">): boolean {
	return LEGACY_HERMES_USER_FIELD_IDS.has(field.id) || LEGACY_HERMES_USER_FIELD_IDS.has(field.key);
}

function isLegacyHermesFieldId(id: string | undefined): boolean {
	return Boolean(id && LEGACY_HERMES_USER_FIELD_IDS.has(id));
}

export function normalizeHermesUserFields(
	userFields: readonly UserMappedField[] | undefined
): { fields: UserMappedField[]; changed: boolean } {
	const fieldsWithoutLegacy = (userFields ?? []).filter((field) => !isLegacyHermesUserField(field));
	const fields = ensureHermesAssigneeUserField(fieldsWithoutLegacy);
	return {
		fields,
		changed:
			fields.length !== (userFields ?? []).length ||
			fields.some((field, index) => field !== userFields?.[index]),
	};
}

export function normalizeHermesModalFieldsConfig(
	config: TaskModalFieldsConfig | undefined
): { config: TaskModalFieldsConfig | undefined; changed: boolean } {
	if (!config) {
		return { config, changed: false };
	}
	const fieldsWithoutLegacy = config.fields.filter((field) => !isLegacyHermesFieldId(field.id));
	const hasAssignee = fieldsWithoutLegacy.some((field) => field.id === "assignee");
	const fields = hasAssignee
		? fieldsWithoutLegacy
		: [
				...fieldsWithoutLegacy,
				{
					id: "assignee",
					fieldType: "user" as const,
					group: "organization" as const,
					displayName: "Assignee",
					visibleInCreation: false,
					visibleInEdit: true,
					order: 99,
					enabled: true,
				},
			];
	const changed =
		fields.length !== config.fields.length ||
		fields.some((field, index) => field !== config.fields[index]);
	return {
		config: changed ? { ...config, fields } : config,
		changed,
	};
}

export function normalizeHermesAssignee(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number") {
		return null;
	}
	const assignee = String(value).trim();
	return assignee && assignee.toLowerCase() !== "none" ? assignee : null;
}

export function isHumanHermesAssignee(value: unknown): boolean {
	const assignee = normalizeHermesAssignee(value);
	return assignee ? HUMAN_ASSIGNEES.has(assignee.toLowerCase()) : false;
}

export function buildHumanAssigneeBlockReason(assignee: string): string {
	return `Waiting on human: ${assignee}`;
}

export function buildHermesAssigneeUpdatePayload(
	value: unknown
): { assignee: string | null; status?: string; block_reason?: string } | null {
	const assignee = normalizeHermesAssignee(value);
	if (!assignee) {
		return { assignee: null };
	}
	if (isHumanHermesAssignee(assignee)) {
		return {
			assignee,
			status: "blocked",
			block_reason: buildHumanAssigneeBlockReason(assignee),
		};
	}
	return { assignee };
}
