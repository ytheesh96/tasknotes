import type { FieldGroup, TaskModalFieldsConfig, UserMappedField } from "../types/settings";
import { DEFAULT_FIELD_GROUPS } from "../utils/fieldConfigDefaults";
import { HERMES_ACTIVITY_USER_FIELDS } from "./hermesActivityFields";

export const HERMES_DEFAULT_ASSIGNEES = [
	"default",
	"ops-steward",
	"orchestrator",
	"peacock",
	"product-designer",
	"research-librarian",
	"reviewer-qa",
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
	"hermes_status",
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
const TASK_MODAL_GROUP_IDS = new Set<FieldGroup>(DEFAULT_FIELD_GROUPS.map((group) => group.id));
const LEGACY_HERMES_REVIEW_RAIL_FIELD_ID = "hermes-review-rail";
const HERMES_ACTIVITY_USER_FIELD_IDS = new Set(
	HERMES_ACTIVITY_USER_FIELDS.flatMap((field) => [field.id, field.key])
);
const HERMES_ACTIVITY_USER_FIELD_BY_ID = new Map(
	HERMES_ACTIVITY_USER_FIELDS.flatMap((field) => [
		[field.id, field],
		[field.key, field],
	])
);
const RETIRED_HERMES_ACTIVITY_USER_FIELD_IDS = new Set([
	"hermesActivityComments",
	"hermesActivityRuns",
	"hermesActivityEvents",
	"hermesActivityArtifacts",
	"hermesActivityChangedFiles",
	"hermesComments",
	"hermesRuns",
	"hermesEvents",
	"hermesArtifacts",
	"hermesChangedFiles",
	"hermesActivitySyncedAt",
	"hermesActivityCommentCount",
	"hermesActivityRunCount",
	"hermesActivityEventCount",
	"hermesActivityNeedsReview",
	"hermesActivityLatestComment",
	"hermesActivityLatestRun",
	"hermesActivityLatestEvent",
]);

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
	if (HERMES_ACTIVITY_USER_FIELD_IDS.has(field.id) || HERMES_ACTIVITY_USER_FIELD_IDS.has(field.key)) {
		return false;
	}
	return (
		LEGACY_HERMES_USER_FIELD_IDS.has(field.id) ||
		LEGACY_HERMES_USER_FIELD_IDS.has(field.key) ||
		RETIRED_HERMES_ACTIVITY_USER_FIELD_IDS.has(field.id) ||
		RETIRED_HERMES_ACTIVITY_USER_FIELD_IDS.has(field.key)
	);
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
	return Boolean(
		id &&
			(id === LEGACY_HERMES_REVIEW_RAIL_FIELD_ID ||
				LEGACY_HERMES_USER_FIELD_IDS.has(id) ||
				RETIRED_HERMES_ACTIVITY_USER_FIELD_IDS.has(id))
	);
}

function normalizeModalFieldGroup(group: unknown): FieldGroup {
	const groupId = typeof group === "string" ? group : "";
	return LEGACY_MODAL_GROUP_MAP.get(groupId) ?? (TASK_MODAL_GROUP_IDS.has(groupId as FieldGroup)
		? (groupId as FieldGroup)
		: "custom");
}

function normalizeModalField(
	field: TaskModalFieldsConfig["fields"][number],
	legacyReviewRailField: TaskModalFieldsConfig["fields"][number] | undefined
): TaskModalFieldsConfig["fields"][number] {
	const activityField = HERMES_ACTIVITY_USER_FIELD_BY_ID.get(field.id);
	const isActivityField = Boolean(activityField);
	const legacyRailHidden =
		legacyReviewRailField &&
		(!legacyReviewRailField.enabled || !legacyReviewRailField.visibleInEdit);
	return {
		...field,
		...(activityField
			? {
					id: activityField.id,
					fieldType: "user" as const,
					displayName: activityField.displayName,
					visibleInCreation: false,
				}
			: {}),
		group: isActivityField ? "activity" : normalizeModalFieldGroup(field.group),
		...(isActivityField && legacyRailHidden ? { enabled: false, visibleInEdit: false } : {}),
	};
}

function deduplicateUserFieldsByIdOrKey(
	fields: readonly UserMappedField[]
): { fields: UserMappedField[]; changed: boolean } {
	const seen = new Set<string>();
	const deduplicated: UserMappedField[] = [];
	for (const field of fields) {
		const keys = [field.id, field.key].filter(Boolean);
		if (keys.some((key) => seen.has(key))) {
			continue;
		}
		for (const key of keys) {
			seen.add(key);
		}
		deduplicated.push(field);
	}
	return { fields: deduplicated, changed: deduplicated.length !== fields.length };
}

function deduplicateModalFieldsById(
	fields: readonly TaskModalFieldsConfig["fields"][number][]
): { fields: TaskModalFieldsConfig["fields"]; changed: boolean } {
	const seen = new Set<string>();
	const deduplicated: TaskModalFieldsConfig["fields"] = [];
	for (const field of fields) {
		if (seen.has(field.id)) {
			continue;
		}
		seen.add(field.id);
		deduplicated.push(field);
	}
	return { fields: deduplicated, changed: deduplicated.length !== fields.length };
}

export function normalizeHermesUserFields(
	userFields: readonly UserMappedField[] | undefined
): { fields: UserMappedField[]; changed: boolean } {
	const fieldsWithoutLegacy = deduplicateUserFieldsByIdOrKey(
		(userFields ?? []).filter((field) => !isLegacyHermesUserField(field))
	);
	const fields = [...fieldsWithoutLegacy.fields];
	for (const activityField of HERMES_ACTIVITY_USER_FIELDS) {
		const existingIndex = fields.findIndex(
			(field) => field.id === activityField.id || field.key === activityField.key
		);
		if (existingIndex >= 0) {
			fields[existingIndex] = {
				...fields[existingIndex],
				id: activityField.id,
				displayName: activityField.displayName,
				key: activityField.key,
				type: activityField.type,
			};
		} else {
			fields.push({ ...activityField });
		}
	}
	return {
		fields,
		changed:
			fieldsWithoutLegacy.changed ||
			JSON.stringify(fields) !== JSON.stringify(userFields ?? []),
	};
}

export function normalizeHermesModalFieldsConfig(
	config: TaskModalFieldsConfig | undefined
): { config: TaskModalFieldsConfig | undefined; changed: boolean } {
	if (!config) {
		return { config, changed: false };
	}
	const legacyReviewRailField = config.fields.find(
		(field) => field.id === LEGACY_HERMES_REVIEW_RAIL_FIELD_ID
	);
	const legacyReviewRailHidden =
		legacyReviewRailField &&
		(!legacyReviewRailField.enabled || !legacyReviewRailField.visibleInEdit);
	const normalizedFields = config.fields
		.filter((field) => !isLegacyHermesFieldId(field.id))
		.map((field) => normalizeModalField(field, legacyReviewRailField));
	const fieldsWithoutLegacy = deduplicateModalFieldsById(normalizedFields);
	const fields = [...fieldsWithoutLegacy.fields];
	for (const [index, activityField] of HERMES_ACTIVITY_USER_FIELDS.entries()) {
		if (fields.some((field) => field.id === activityField.id)) {
			continue;
		}
		fields.push({
			id: activityField.id,
			fieldType: "user",
			group: "activity",
				displayName: activityField.displayName,
				visibleInCreation: false,
				visibleInEdit: legacyReviewRailHidden ? false : true,
				order: index,
				enabled: legacyReviewRailHidden ? false : true,
			});
	}
	const changed =
		JSON.stringify(config.groups) !== JSON.stringify(DEFAULT_FIELD_GROUPS) ||
		fieldsWithoutLegacy.changed ||
		JSON.stringify(fields) !== JSON.stringify(config.fields);
	return {
		config: changed
			? { ...config, groups: [...DEFAULT_FIELD_GROUPS], fields }
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
