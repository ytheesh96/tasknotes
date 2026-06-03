import type { UserMappedField } from "../types/settings";

export const HERMES_ACTIVITY_FIELD_KEYS = {
	comments: "comments",
	runs: "runs",
	events: "events",
	artifacts: "artifacts",
	changedFiles: "changedFiles",
} as const;

export const HERMES_ACTIVITY_USER_FIELDS: readonly UserMappedField[] = [
	{
		id: HERMES_ACTIVITY_FIELD_KEYS.comments,
		displayName: "Comments",
		key: HERMES_ACTIVITY_FIELD_KEYS.comments,
		type: "list",
	},
	{
		id: HERMES_ACTIVITY_FIELD_KEYS.runs,
		displayName: "Runs",
		key: HERMES_ACTIVITY_FIELD_KEYS.runs,
		type: "list",
	},
	{
		id: HERMES_ACTIVITY_FIELD_KEYS.events,
		displayName: "Events",
		key: HERMES_ACTIVITY_FIELD_KEYS.events,
		type: "list",
	},
	{
		id: HERMES_ACTIVITY_FIELD_KEYS.artifacts,
		displayName: "Artifacts",
		key: HERMES_ACTIVITY_FIELD_KEYS.artifacts,
		type: "list",
	},
	{
		id: HERMES_ACTIVITY_FIELD_KEYS.changedFiles,
		displayName: "Changed files",
		key: HERMES_ACTIVITY_FIELD_KEYS.changedFiles,
		type: "list",
	},
];
