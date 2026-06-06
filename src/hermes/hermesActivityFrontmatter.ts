import { TFile } from "obsidian";
import type { JsonValue, TaskInfo } from "../types";
import { getCurrentTimestamp } from "../utils/dateUtils";
import type TaskNotesPlugin from "../main";

import type { HermesTaskDetailResponse } from "./hermesApiClient";
import { HERMES_ACTIVITY_FIELD_KEYS } from "./hermesActivityFields";
import { parseHermesComment } from "./hermesCommentParser";
import {
	canonicalHermesActivityPath,
	canonicalHermesTaskPath,
} from "./hermesCanonicalTaskNotes";

export { HERMES_ACTIVITY_FIELD_KEYS, HERMES_ACTIVITY_USER_FIELDS } from "./hermesActivityFields";

const HERMES_ACTIVITY_FRONTMATTER_KEY = "hermesActivity";
const HERMES_ACTIVITY_ITEM_LIMIT = 20;
const HERMES_ACTIVITY_SUMMARY_LIMIT = 8;
const HERMES_ACTIVITY_LIST_LIMIT = 12;
const HERMES_TASK_ID_REGEX = /(?:TaskNotes\/([^/\]\s]+)\/)?(t_[a-z0-9]{8})(?:\.md)?/gi;
const ITEM_DETAIL_PROPERTY_REGEX =
	/^(?:hermes(?:Run|Comment|Event)[A-Za-z0-9]*|(?:(?:hermesActivityRun|hermesRun|run)[A-Za-z0-9]+(?:Artifacts|ChangedFiles|EndedAt|Outcome|Profile|StartedAt|Status|Summary)|comment[A-Za-z0-9]+(?:Artifacts|Author|CreatedAt|Kind|Summary|Tasks)|event[A-Za-z0-9]+(?:Artifacts|CreatedAt|Kind|Run|Summary|Tasks)))$/;
const ARTIFACT_PATH_KEYS = [
	"artifact",
	"artifacts",
	"diff_path",
	"qa_report",
	"report",
	"path",
	"paths",
] as const;

const HERMES_ACTIVITY_FRONTMATTER_KEYS = Object.values(HERMES_ACTIVITY_FIELD_KEYS);
const HERMES_ACTIVITY_INDEX_KEY_ALIASES = {
	comments: [
		HERMES_ACTIVITY_FIELD_KEYS.comments,
		HERMES_ACTIVITY_FIELD_KEYS.retiredComments,
		HERMES_ACTIVITY_FIELD_KEYS.retiredActivityComments,
	],
	runs: [
		HERMES_ACTIVITY_FIELD_KEYS.runs,
		HERMES_ACTIVITY_FIELD_KEYS.retiredRuns,
		HERMES_ACTIVITY_FIELD_KEYS.retiredActivityRuns,
	],
	events: [
		HERMES_ACTIVITY_FIELD_KEYS.events,
		HERMES_ACTIVITY_FIELD_KEYS.retiredEvents,
		HERMES_ACTIVITY_FIELD_KEYS.retiredActivityEvents,
	],
	artifacts: [
		HERMES_ACTIVITY_FIELD_KEYS.artifacts,
		HERMES_ACTIVITY_FIELD_KEYS.retiredArtifacts,
		HERMES_ACTIVITY_FIELD_KEYS.retiredHermesArtifacts,
		HERMES_ACTIVITY_FIELD_KEYS.retiredActivityArtifacts,
	],
	changedFiles: [
		HERMES_ACTIVITY_FIELD_KEYS.changedFiles,
		HERMES_ACTIVITY_FIELD_KEYS.retiredChangedFiles,
		HERMES_ACTIVITY_FIELD_KEYS.retiredActivityChangedFiles,
	],
} as const;

type JsonRecord = Record<string, JsonValue>;

export interface HermesActivitySnapshot {
	syncedAt: string;
	commentCount: number;
	runCount: number;
	eventCount: number;
	comments: JsonRecord[];
	runs: JsonRecord[];
	events: JsonRecord[];
}

interface HermesActivityFrontmatterState {
	properties: Record<string, unknown>;
	hasLegacyRawActivity: boolean;
}

interface HermesActivityFrontmatterOptions {
	board?: string;
	taskId?: string;
}

interface HermesActivityNoteOptions {
	board: string;
	taskId: string;
}

export interface HermesActivityNoteSpec {
	path: string;
	label: string;
	link: string;
	frontmatter: Record<string, unknown>;
	body: string;
}

interface HermesActivityItem {
	label: string;
	link?: string;
	path?: string;
	frontmatter?: Record<string, unknown>;
	body?: string;
	sortTimestampMs?: number | null;
}

interface HermesArtifactReference {
	value: string;
	label: string;
	sourceType: "comment" | "run" | "event";
	sourceId: string;
	sourceLabel: string;
}

export function buildHermesActivityFrontmatterProperties(
	snapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions = {}
): Record<string, unknown> {
	const items = buildHermesActivityItems(snapshot, options);
	const artifacts = buildActivityArtifactLinks(snapshot, options).slice(0, HERMES_ACTIVITY_LIST_LIMIT);
	const changedFiles = collectActivityChangedFiles(snapshot).slice(0, HERMES_ACTIVITY_LIST_LIMIT);
	const hasActivityContent = Boolean(
		items.comments.length ||
			items.runs.length ||
			items.events.length ||
			artifacts.length ||
			changedFiles.length
	);

	return removeEmptyFrontmatterValues({
		[HERMES_ACTIVITY_FIELD_KEYS.feed]: buildHermesActivityFeedItems(items).map(activityIndexValue),
		[HERMES_ACTIVITY_FIELD_KEYS.comments]: items.comments.map(activityIndexValue),
		[HERMES_ACTIVITY_FIELD_KEYS.runs]: items.runs.map(activityIndexValue),
		[HERMES_ACTIVITY_FIELD_KEYS.events]: items.events.map(activityIndexValue),
		[HERMES_ACTIVITY_FIELD_KEYS.artifacts]: artifacts,
		[HERMES_ACTIVITY_FIELD_KEYS.changedFiles]: changedFiles,
		[HERMES_ACTIVITY_FIELD_KEYS.lastSyncedAt]: hasActivityContent ? snapshot.syncedAt : undefined,
		[HERMES_ACTIVITY_FIELD_KEYS.version]: hasActivityContent ? 2 : undefined,
	});
}

export function buildHermesActivityNoteSpecs(
	snapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions
): HermesActivityNoteSpec[] {
	const items = buildHermesActivityItems(snapshot, options);
	const activityNoteSpecs = [...items.comments, ...items.runs, ...items.events].flatMap((item) => {
		if (!item.path || !item.link || !item.frontmatter || item.body === undefined) {
			return [];
		}
		return [{
			path: item.path,
			label: item.label,
			link: item.link,
			frontmatter: item.frontmatter,
			body: item.body,
		}];
	});
	return uniqueActivityNoteSpecs([
		...activityNoteSpecs,
		...buildArtifactActivityNoteSpecs(snapshot, options),
		...buildRawActivityNoteSpecs(snapshot, options),
	]);
}

export function hasHermesActivityNotesChanged(
	plugin: Pick<TaskNotesPlugin, "app">,
	snapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions
): boolean {
	for (const spec of buildHermesActivityNoteSpecs(snapshot, options)) {
		const frontmatter = getTaskFrontmatter(plugin, spec.path);
		if (
			!frontmatter ||
			(frontmatter.hermesSourceDigest ?? frontmatter.sourceDigest) !==
				spec.frontmatter.hermesSourceDigest
		) {
			return true;
		}
	}
	return false;
}

export function getHermesActivityFrontmatterStateFromTask(
	plugin: Pick<TaskNotesPlugin, "app">,
	task: TaskInfo
): HermesActivityFrontmatterState | null {
	const customState = normalizeHermesActivityFrontmatterState(task.customProperties);
	if (customState) {
		return customState;
	}

	const frontmatter = getTaskFrontmatter(plugin, task.path);
	return normalizeHermesActivityFrontmatterState(frontmatter);
}

export function hasHermesActivityFrontmatterPropertiesChanged(
	existing: HermesActivityFrontmatterState | null | undefined,
	nextSnapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions = {}
): boolean {
	const nextProperties = buildHermesActivityFrontmatterProperties(nextSnapshot, options);
	if (!existing || existing.hasLegacyRawActivity) {
		return Object.keys(nextProperties).length > 0 || Boolean(existing?.hasLegacyRawActivity);
	}
	if (stableStringify(existing.properties) === stableStringify(nextProperties)) {
		return false;
	}
	return !sameActivityFrontmatterExceptLastSyncedAt(existing.properties, nextProperties);
}

function sameActivityFrontmatterExceptLastSyncedAt(
	existing: Record<string, unknown>,
	next: Record<string, unknown>
): boolean {
	const lastSyncedAtKey = HERMES_ACTIVITY_FIELD_KEYS.lastSyncedAt;
	if (
		!Object.prototype.hasOwnProperty.call(existing, lastSyncedAtKey) ||
		!Object.prototype.hasOwnProperty.call(next, lastSyncedAtKey)
	) {
		return false;
	}
	const existingComparable = { ...existing };
	const nextComparable = { ...next };
	delete existingComparable[lastSyncedAtKey];
	delete nextComparable[lastSyncedAtKey];
	return stableStringify(existingComparable) === stableStringify(nextComparable);
}

export function buildHermesActivitySnapshot(
	detail: Pick<HermesTaskDetailResponse, "comments" | "runs" | "events">,
	options: {
		now?: string;
		existing?: HermesActivitySnapshot | null;
	} = {}
): HermesActivitySnapshot {
	const snapshot: HermesActivitySnapshot = {
		syncedAt: options.now ?? getCurrentTimestamp(),
		commentCount: Array.isArray(detail.comments) ? detail.comments.length : 0,
		runCount: Array.isArray(detail.runs) ? detail.runs.length : 0,
		eventCount: Array.isArray(detail.events) ? detail.events.length : 0,
		comments: toFrontmatterRecords(detail.comments).slice(-HERMES_ACTIVITY_ITEM_LIMIT),
		runs: toFrontmatterRecords(detail.runs).slice(-HERMES_ACTIVITY_ITEM_LIMIT),
		events: toFrontmatterRecords(detail.events).slice(-HERMES_ACTIVITY_ITEM_LIMIT),
	};

	if (
		options.existing &&
		!hasHermesActivitySnapshotContentChanged(options.existing, snapshot)
	) {
		return {
			...snapshot,
			syncedAt: options.existing.syncedAt,
		};
	}

	return snapshot;
}

export function getHermesActivitySnapshotFromTask(
	plugin: Pick<TaskNotesPlugin, "app">,
	task: TaskInfo
): HermesActivitySnapshot | null {
	const customSnapshot = normalizeHermesActivitySnapshot(
		task.customProperties?.[HERMES_ACTIVITY_FRONTMATTER_KEY]
	);
	if (customSnapshot) {
		return customSnapshot;
	}
	const customCuratedSnapshot = normalizeHermesActivitySnapshotFromProperties(
		task.customProperties
	);
	if (customCuratedSnapshot) {
		return customCuratedSnapshot;
	}

	const frontmatter = getTaskFrontmatter(plugin, task.path);
	return (
		normalizeHermesActivitySnapshot(frontmatter?.[HERMES_ACTIVITY_FRONTMATTER_KEY]) ??
		normalizeHermesActivitySnapshotFromProperties(frontmatter)
	);
}

export function normalizeHermesActivitySnapshot(value: unknown): HermesActivitySnapshot | null {
	if (!isRecord(value)) {
		return null;
	}
	const hasActivityShape = [
		"comments",
		"runs",
		"events",
		"commentCount",
		"runCount",
		"eventCount",
	].some((key) => Object.prototype.hasOwnProperty.call(value, key));
	if (!hasActivityShape) {
		return null;
	}

	const comments = toFrontmatterRecords(value.comments);
	const runs = toFrontmatterRecords(value.runs);
	const events = toFrontmatterRecords(value.events);
	return {
		syncedAt:
			typeof value.syncedAt === "string" && value.syncedAt.trim()
				? value.syncedAt.trim()
				: getCurrentTimestamp(),
		commentCount: numberValue(value.commentCount) ?? comments.length,
		runCount: numberValue(value.runCount) ?? runs.length,
		eventCount: numberValue(value.eventCount) ?? events.length,
		comments,
		runs,
		events,
	};
}

export function hasHermesActivitySnapshotContentChanged(
	existing: HermesActivitySnapshot | null | undefined,
	next: HermesActivitySnapshot
): boolean {
	if (!existing) {
		return true;
	}
	return stableStringify(comparableSnapshot(existing)) !== stableStringify(comparableSnapshot(next));
}

function normalizeHermesActivitySnapshotFromProperties(
	value: unknown
): HermesActivitySnapshot | null {
	if (!isRecord(value)) {
		return null;
	}
	const hasCuratedShape = [
		...HERMES_ACTIVITY_FRONTMATTER_KEYS,
	].some((key) => Object.prototype.hasOwnProperty.call(value, key));
	if (!hasCuratedShape) {
		return null;
	}
	const commentSummaries = firstStringListValue(value, HERMES_ACTIVITY_INDEX_KEY_ALIASES.comments);
	const runSummaries = firstStringListValue(value, HERMES_ACTIVITY_INDEX_KEY_ALIASES.runs);
	const eventSummaries = firstStringListValue(value, HERMES_ACTIVITY_INDEX_KEY_ALIASES.events);

	return {
		syncedAt: stringValue(value[HERMES_ACTIVITY_FIELD_KEYS.lastSyncedAt]) ?? getCurrentTimestamp(),
		commentCount: commentSummaries.length,
		runCount: runSummaries.length,
		eventCount: eventSummaries.length,
		comments: commentSummaries.map((body) => ({ body })),
		runs: runSummaries.map((summary) => ({ summary })),
		events: eventSummaries.map((summary) => ({ kind: "summary", summary, payload: { summary } })),
	};
}

function normalizeHermesActivityFrontmatterState(
	value: unknown
): HermesActivityFrontmatterState | null {
	if (!isRecord(value)) {
		return null;
	}
	const properties = pickHermesActivityFrontmatterProperties(value);
	const legacySnapshot = normalizeHermesActivitySnapshot(value[HERMES_ACTIVITY_FRONTMATTER_KEY]);
	if (legacySnapshot) {
		return {
			properties:
				Object.keys(properties).length > 0
					? properties
					: buildHermesActivityFrontmatterProperties(legacySnapshot),
			hasLegacyRawActivity: true,
		};
	}
	return Object.keys(properties).length > 0
		? { properties, hasLegacyRawActivity: false }
		: null;
}

function pickHermesActivityFrontmatterProperties(
	value: Record<string, JsonValue>
): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	for (const key of HERMES_ACTIVITY_FRONTMATTER_KEYS) {
		if (value[key] !== undefined) {
			properties[key] = value[key];
		}
	}
	for (const [key, item] of Object.entries(value)) {
		if (ITEM_DETAIL_PROPERTY_REGEX.test(key)) {
			properties[key] = item;
		}
	}
	return properties;
}

function getTaskFrontmatter(
	plugin: Pick<TaskNotesPlugin, "app">,
	path: string
): Record<string, unknown> | undefined {
	const metadataCache = plugin.app.metadataCache as typeof plugin.app.metadataCache & {
		getCache?: (path: string) => { frontmatter?: Record<string, unknown> } | null;
	};
	const cachedByPath = metadataCache.getCache?.(path)?.frontmatter;
	if (cachedByPath) {
		return cachedByPath;
	}

	const file = plugin.app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		return undefined;
	}
	return plugin.app.metadataCache.getFileCache(file)?.frontmatter;
}

function toFrontmatterRecords(value: unknown): JsonRecord[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item) => {
		const normalized = toFrontmatterValue(item);
		return isRecord(normalized) ? [normalized] : [];
	});
}

function toFrontmatterValue(value: unknown, depth = 0): JsonValue | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "symbol") return value.description ?? "";
	if (depth > 8) return "[truncated]";
	if (Array.isArray(value)) {
		return value
			.map((item) => toFrontmatterValue(item, depth + 1))
			.filter((item): item is JsonValue => item !== undefined);
	}
	if (isRecord(value)) {
		const record: JsonRecord = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			const normalized = toFrontmatterValue(nestedValue, depth + 1);
			if (normalized !== undefined) {
				record[key] = normalized;
			}
		}
		return record;
	}
	return undefined;
}

function comparableSnapshot(snapshot: HermesActivitySnapshot): Omit<HermesActivitySnapshot, "syncedAt"> {
	return {
		commentCount: snapshot.commentCount,
		runCount: snapshot.runCount,
		eventCount: snapshot.eventCount,
		comments: snapshot.comments,
		runs: snapshot.runs,
		events: snapshot.events,
	};
}

function buildHermesActivityItems(
	snapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions
): { comments: HermesActivityItem[]; runs: HermesActivityItem[]; events: HermesActivityItem[] } {
	const noteOptions = normalizeActivityNoteOptions(options);
	return {
		comments: buildCommentActivityItems(
			snapshot.comments.slice(-HERMES_ACTIVITY_SUMMARY_LIMIT),
			options,
			noteOptions
		),
		runs: buildRunActivityItems(
			snapshot.runs.slice(-HERMES_ACTIVITY_SUMMARY_LIMIT),
			noteOptions,
			snapshot.events
		),
		events: buildEventActivityItems(
			getSignalEvents(snapshot.events).slice(-HERMES_ACTIVITY_SUMMARY_LIMIT),
			options,
			noteOptions
		),
	};
}

function buildCommentActivityItems(
	comments: JsonRecord[],
	options: HermesActivityFrontmatterOptions,
	noteOptions: HermesActivityNoteOptions | null
): HermesActivityItem[] {
	const items: HermesActivityItem[] = [];
	for (const [commentIndex, comment] of comments.entries()) {
		const commentId = stringValue(comment.id) ?? stringValue(comment.comment_id) ?? String(commentIndex + 1);
		const body = stringValue(comment.body) ?? stringValue(comment.comment) ?? "";
		const author = stringValue(comment.author);
		const createdAt = timestampValue(comment.created_at) ?? timestampValue(comment.createdAt);
		const runId = stringValue(comment.run_id) ?? stringValue(comment.runId);
		const model = parseHermesComment(body, { author, createdAt });
		const summary = compactText(model.summary || body, 360);
		const label = `Comment ${commentId}`;
		const artifacts = buildArtifactLinksForValues(
			collectCommentArtifacts(comment),
			noteOptions,
			"comment",
			commentId
		).slice(0, HERMES_ACTIVITY_LIST_LIMIT);
		const tasks = collectHermesTaskReferenceLinksFromValue([body, model.payload], options.board);
		items.push(
			buildActivityItem(
				"comments",
				"comment",
				commentId,
				commentIndex,
				label,
				removeEmptyFrontmatterValues({
					type: "hermes-comment",
					hermesTask: noteOptions ? buildHermesTaskLink(noteOptions) : undefined,
					hermesTaskId: noteOptions?.taskId,
					hermesCommentId: commentId,
					hermesCommentAuthor: author,
					hermesCommentKind: model.kind,
					hermesCommentSeverity: model.severity,
					hermesCommentSummary: summary,
					hermesCommentCreatedAt: createdAt,
					hermesLinkedRun:
						noteOptions && runId
							? buildActivityLink(noteOptions, "runs", "run", runId, `Run ${runId}`)
							: undefined,
					hermesRunId: runId,
					hermesCommentTasks: tasks,
					hermesCommentArtifacts: artifacts,
					hermesSourceDigest: activityDigest(comment),
				}),
				body.trim() ? `${body.trim()}\n` : buildRawRecordBody("Raw comment", comment),
				noteOptions,
				createdAt
			)
		);
	}
	return uniqueActivityItems(items);
}

function buildRunActivityItems(
	runs: JsonRecord[],
	noteOptions: HermesActivityNoteOptions | null,
	events: JsonRecord[]
): HermesActivityItem[] {
	const items: HermesActivityItem[] = [];
	for (const [runIndex, run] of runs.entries()) {
		const runId = stringValue(run.id) ?? stringValue(run.run_id) ?? String(runIndex + 1);
		const profile = stringValue(run.profile);
		const status = stringValue(run.status);
		const outcome = stringValue(run.outcome);
		const summary =
			stringValue(run.summary) ??
			stringValue(run.result) ??
			stringValue(run.error) ??
			summarizePayload(run.metadata);
		const startedAt = timestampValue(run.started_at) ?? timestampValue(run.startedAt);
		const endedAt = timestampValue(run.ended_at) ?? timestampValue(run.endedAt);
		const lastHeartbeatAt =
			timestampValue(run.last_heartbeat_at) ??
			timestampValue(run.lastHeartbeatAt) ??
			timestampValue(run.heartbeat_at) ??
			timestampValue(run.heartbeatAt);
		const durationMs = numberValue(run.duration_ms) ?? numberValue(run.durationMs);
		const verification =
			stringValue(run.verification) ??
			(isRecord(run.metadata) ? stringValue(run.metadata.verification) : undefined);
		const label = `Run ${runId}`;
		items.push(
			buildActivityItem(
				"runs",
				"run",
				runId,
				runIndex,
				label,
				removeEmptyFrontmatterValues({
					type: "hermes-run",
					hermesTask: noteOptions ? buildHermesTaskLink(noteOptions) : undefined,
					hermesTaskId: noteOptions?.taskId,
					hermesRunId: runId,
					hermesRunProfile: profile,
					hermesRunStatus: status,
					hermesRunOutcome: outcome,
					hermesRunSummary: summary ? compactText(summary, 360) : undefined,
					hermesRunStartedAt: startedAt,
					hermesRunEndedAt: endedAt,
					hermesRunLastHeartbeatAt: lastHeartbeatAt,
					hermesRunDurationMs: durationMs,
					hermesRunSignals: buildRunSignalLinks(events, runId, noteOptions).slice(
						0,
						HERMES_ACTIVITY_LIST_LIMIT
					),
					hermesRunArtifacts: buildArtifactLinksForValues(
						collectRunArtifacts(run),
						noteOptions,
						"run",
						runId
					).slice(0, HERMES_ACTIVITY_LIST_LIMIT),
					hermesRunChangedFiles: uniqueStrings(collectRunChangedFiles(run)).slice(
						0,
						HERMES_ACTIVITY_LIST_LIMIT
					),
					hermesRunVerification: verification,
					hermesRunRawMetadata:
						noteOptions && run.metadata !== undefined && run.metadata !== null
							? buildRawActivityLink(noteOptions, "run", runId, "metadata", "Run metadata")
							: undefined,
					hermesSourceDigest: activityDigest(run),
				}),
				buildRawRecordBody("Raw run", run),
				noteOptions,
				endedAt ?? startedAt
			)
		);
	}
	return uniqueActivityItems(items);
}

function buildRunSignalLinks(
	events: JsonRecord[],
	runId: string,
	noteOptions: HermesActivityNoteOptions | null
): string[] {
	if (!noteOptions || !runId) {
		return [];
	}
	return getSignalEvents(events)
		.map((event, eventIndex) => ({ event, eventIndex }))
		.filter(({ event }) => {
			const eventRunId = stringValue(event.run_id) ?? stringValue(event.runId);
			return eventRunId === runId;
		})
		.map(({ event, eventIndex }) => {
			const eventId = stringValue(event.id) ?? String(eventIndex + 1);
			return buildActivityLink(noteOptions, "events", "event", eventId, `Event ${eventId}`);
		});
}

function buildRawActivityNoteSpecs(
	snapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions
): HermesActivityNoteSpec[] {
	const noteOptions = normalizeActivityNoteOptions(options);
	if (!noteOptions) {
		return [];
	}

	const specs: HermesActivityNoteSpec[] = [];
	const recentRuns = snapshot.runs.slice(-HERMES_ACTIVITY_SUMMARY_LIMIT);
	for (const [runIndex, run] of recentRuns.entries()) {
		if (run.metadata === undefined || run.metadata === null) {
			continue;
		}
		const runId = stringValue(run.id) ?? stringValue(run.run_id) ?? String(runIndex + 1);
		specs.push(
			buildRawActivityNoteSpec(noteOptions, "run", runId, "metadata", "Run metadata", run.metadata)
		);
	}

	const recentEvents = getSignalEvents(snapshot.events).slice(
		-HERMES_ACTIVITY_SUMMARY_LIMIT
	);
	for (const [eventIndex, event] of recentEvents.entries()) {
		if (event.payload === undefined || event.payload === null) {
			continue;
		}
		const eventId = stringValue(event.id) ?? String(eventIndex + 1);
		specs.push(
			buildRawActivityNoteSpec(noteOptions, "event", eventId, "payload", "Event payload", event.payload)
		);
	}

	return specs;
}

function buildRawActivityNoteSpec(
	options: HermesActivityNoteOptions,
	source: "run" | "event" | "comment",
	rawId: string,
	kind: string,
	label: string,
	value: unknown
): HermesActivityNoteSpec {
	const path = buildRawActivityPath(options, source, rawId, kind);
	return {
		path,
		label,
		link: `[[${path.replace(/\.md$/i, "")}|${label}]]`,
		frontmatter: removeEmptyFrontmatterValues({
			type: "hermes-raw",
			hermesTask: buildHermesTaskLink(options),
			hermesTaskId: options.taskId,
			hermesRawSourceType: source,
			hermesRawSourceId: rawId,
			hermesRawKind: kind,
			hermesSourceDigest: activityDigest(value),
		}),
		body: buildRawRecordBody(label, value),
	};
}

function buildArtifactActivityNoteSpecs(
	snapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions
): HermesActivityNoteSpec[] {
	const noteOptions = normalizeActivityNoteOptions(options);
	if (!noteOptions) {
		return [];
	}
	return buildArtifactReferences(snapshot).map((reference) =>
		buildArtifactActivityNoteSpec(noteOptions, reference)
	);
}

function buildActivityArtifactLinks(
	snapshot: HermesActivitySnapshot,
	options: HermesActivityFrontmatterOptions
): string[] {
	const noteOptions = normalizeActivityNoteOptions(options);
	if (!noteOptions) {
		return uniqueStrings(collectActivityArtifacts(snapshot).map(formatArtifactLink));
	}
	return uniqueStrings(
		buildArtifactReferences(snapshot).map((reference) =>
			buildArtifactActivityLink(noteOptions, reference)
		)
	);
}

function buildArtifactLinksForValues(
	values: string[],
	noteOptions: HermesActivityNoteOptions | null,
	sourceType: HermesArtifactReference["sourceType"],
	sourceId: string
): string[] {
	const uniqueValues = uniqueStrings(values);
	if (!noteOptions) {
		return uniqueValues.map(formatArtifactLink);
	}
	return uniqueValues.map((value) =>
		buildArtifactActivityLink(noteOptions, buildArtifactReference(value, sourceType, sourceId))
	);
}

function buildArtifactReferences(
	snapshot: HermesActivitySnapshot
): HermesArtifactReference[] {
	const references: HermesArtifactReference[] = [];
	for (const [commentIndex, comment] of snapshot.comments.slice(-HERMES_ACTIVITY_SUMMARY_LIMIT).entries()) {
		const commentId = stringValue(comment.id) ?? stringValue(comment.comment_id) ?? String(commentIndex + 1);
		for (const value of collectCommentArtifacts(comment)) {
			references.push(buildArtifactReference(value, "comment", commentId));
		}
	}
	for (const [runIndex, run] of snapshot.runs.slice(-HERMES_ACTIVITY_SUMMARY_LIMIT).entries()) {
		const runId = stringValue(run.id) ?? stringValue(run.run_id) ?? String(runIndex + 1);
		for (const value of collectRunArtifacts(run)) {
			references.push(buildArtifactReference(value, "run", runId));
		}
	}
	for (const [eventIndex, event] of getSignalEvents(snapshot.events)
		.slice(-HERMES_ACTIVITY_SUMMARY_LIMIT)
		.entries()) {
		const eventId = stringValue(event.id) ?? String(eventIndex + 1);
		for (const value of collectEventArtifacts(event)) {
			references.push(buildArtifactReference(value, "event", eventId));
		}
	}
	return uniqueArtifactReferences(references);
}

function buildArtifactReference(
	value: string,
	sourceType: HermesArtifactReference["sourceType"],
	sourceId: string
): HermesArtifactReference {
	return {
		value,
		label: artifactLabel(value),
		sourceType,
		sourceId,
		sourceLabel: `${capitalizeWord(sourceType)} ${sourceId}`,
	};
}

function buildArtifactActivityNoteSpec(
	options: HermesActivityNoteOptions,
	reference: HermesArtifactReference
): HermesActivityNoteSpec {
	const path = buildArtifactActivityPath(options, reference);
	return {
		path,
		label: reference.label,
		link: buildArtifactActivityLink(options, reference),
		frontmatter: removeEmptyFrontmatterValues({
			type: "hermes-artifact",
			hermesTask: buildHermesTaskLink(options),
			hermesTaskId: options.taskId,
			hermesArtifactKind: artifactKind(reference.value),
			hermesArtifactLabel: reference.label,
			hermesArtifactFilename: artifactFilename(reference.value),
			hermesArtifactStoredPath: reference.value,
			hermesArtifactSourceType: reference.sourceType,
			hermesArtifactSourceId: reference.sourceId,
			hermesArtifactSource:
				reference.sourceType === "run"
					? buildActivityLink(options, "runs", "run", reference.sourceId, `Run ${reference.sourceId}`)
					: reference.sourceType === "event"
						? buildActivityLink(options, "events", "event", reference.sourceId, `Event ${reference.sourceId}`)
						: buildActivityLink(
								options,
								"comments",
								"comment",
								reference.sourceId,
								`Comment ${reference.sourceId}`
							),
			hermesSourceDigest: activityDigest({
				sourceType: reference.sourceType,
				sourceId: reference.sourceId,
				value: reference.value,
			}),
		}),
		body: [
			`## ${reference.label}`,
			"",
			`- Source: ${reference.sourceLabel}`,
			`- Target: ${reference.value}`,
			"",
		].join("\n"),
	};
}

function collectCommentArtifacts(comment: JsonRecord): string[] {
	const body = stringValue(comment.body) ?? stringValue(comment.comment) ?? "";
	const model = parseHermesComment(body, {
		author: stringValue(comment.author),
		createdAt: stringValue(comment.created_at) ?? stringValue(comment.createdAt),
	});
	const values: string[] = [];
	if (model.payload) {
		collectPathValues(model.payload, values, ARTIFACT_PATH_KEYS, false);
	} else {
		values.push(...collectInlinePathValues(body));
	}
	return uniqueStrings(values);
}

function collectRunArtifacts(run: JsonRecord): string[] {
	const values: string[] = [];
	collectPathValues(run, values, ARTIFACT_PATH_KEYS, false);
	for (const key of ["summary", "result", "error"]) {
		values.push(...collectInlinePathValues(stringValue(run[key]) ?? ""));
	}
	return uniqueStrings(values);
}

function collectRunChangedFiles(run: JsonRecord): string[] {
	const values: string[] = [];
	collectPathValues(run, values, ["changed_files"], false);
	return uniqueStrings(values);
}

function buildEventActivityItems(
	events: JsonRecord[],
	options: HermesActivityFrontmatterOptions,
	noteOptions: HermesActivityNoteOptions | null
): HermesActivityItem[] {
	const items: HermesActivityItem[] = [];
	for (const [eventIndex, event] of events.entries()) {
		const eventId = stringValue(event.id) ?? String(eventIndex + 1);
		const kind = stringValue(event.kind) ?? "event";
		const createdAt = timestampValue(event.created_at) ?? timestampValue(event.createdAt);
		const runId = stringValue(event.run_id) ?? stringValue(event.runId);
		const summary = summarizePayload(event.payload) || summarizePayload(event);
		const label = `Event ${eventId}`;
		const status =
			stringValue(event.status) ??
			(isRecord(event.payload) ? stringValue(event.payload.status) : undefined);
		items.push(
			buildActivityItem(
				"events",
				"event",
				eventId,
				eventIndex,
				label,
				removeEmptyFrontmatterValues({
					type: "hermes-event",
					hermesTask: noteOptions ? buildHermesTaskLink(noteOptions) : undefined,
					hermesTaskId: noteOptions?.taskId,
					hermesRun:
						noteOptions && runId
							? buildActivityLink(noteOptions, "runs", "run", runId, `Run ${runId}`)
							: undefined,
					hermesRunId: runId,
					hermesEventId: eventId,
					hermesEventKind: kind,
					hermesEventStatus: status,
					hermesEventLabel: kind.replace(/[_-]+/g, " "),
					hermesEventSummary: summary ? compactText(summary, 360) : undefined,
					hermesEventCreatedAt: createdAt,
					hermesEventTasks: collectHermesTaskReferenceLinksFromValue(event.payload, options.board),
					hermesEventArtifacts: buildArtifactLinksForValues(
						collectEventArtifacts(event),
						noteOptions,
						"event",
						eventId
					).slice(0, HERMES_ACTIVITY_LIST_LIMIT),
					hermesEventRawPayload:
						noteOptions && event.payload !== undefined && event.payload !== null
							? buildRawActivityLink(noteOptions, "event", eventId, "payload", "Event payload")
							: undefined,
					hermesSourceDigest: activityDigest(event),
				}),
				buildRawRecordBody("Raw event", event),
				noteOptions,
				createdAt
			)
		);
	}
	return uniqueActivityItems(items);
}

function normalizeActivityNoteOptions(
	options: HermesActivityFrontmatterOptions
): HermesActivityNoteOptions | null {
	const board = options.board?.trim();
	const taskId = options.taskId?.trim();
	return board && taskId ? { board, taskId } : null;
}

function buildActivityItem(
	folder: "comments" | "runs" | "events",
	prefix: "comment" | "run" | "event",
	rawId: string,
	index: number,
	label: string,
	frontmatter: Record<string, unknown>,
	body: string,
	options: HermesActivityNoteOptions | null,
	sortTimestamp?: string
): HermesActivityItem {
	const sortTimestampMs = hermesActivityTimestampMs(sortTimestamp);
	if (!options) {
		return { label, sortTimestampMs };
	}
	const basename = activityNoteBasename(prefix, rawId, index, options.taskId);
	const path = canonicalHermesActivityPath(options.taskId, folder, basename);
	return {
		label,
		path,
		link: `[[${path.replace(/\.md$/i, "")}|${label}]]`,
		frontmatter,
		body,
		sortTimestampMs,
	};
}

function buildActivityLink(
	options: HermesActivityNoteOptions,
	folder: "comments" | "runs" | "events",
	prefix: "comment" | "run" | "event",
	rawId: string,
	label: string
): string {
	const basename = activityNoteBasename(prefix, rawId, 0, options.taskId);
	return `[[${canonicalHermesActivityPath(options.taskId, folder, basename).replace(/\.md$/i, "")}|${label}]]`;
}

function buildHermesTaskLink(options: HermesActivityNoteOptions): string {
	return `[[${canonicalHermesTaskPath(options.taskId).replace(/\.md$/i, "")}|${options.taskId}]]`;
}

function activityNoteBasename(
	prefix: "comment" | "run" | "event",
	rawId: string,
	index: number,
	taskId: string
): string {
	const fallback = `${taskId}-${prefix}${index + 1}`;
	const normalized = (rawId || fallback)
		.replace(new RegExp(`^${prefix}[-_\\s]*`, "i"), "")
		.replace(/[^A-Za-z0-9]/g, "");
	const normalizedTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, "");
	const suffix = `${prefix}${normalized || index + 1}`;
	return normalizedTaskId ? `${normalizedTaskId}-${suffix}` : suffix;
}

function activityIndexValue(item: HermesActivityItem): string {
	return item.link ?? item.label;
}

function buildHermesActivityFeedItems(items: {
	comments: HermesActivityItem[];
	runs: HermesActivityItem[];
	events: HermesActivityItem[];
}): HermesActivityItem[] {
	return [...items.comments, ...items.runs, ...items.events]
		.map((item, sequence) => ({ item, sequence }))
		.sort((left, right) => {
			const leftTime = left.item.sortTimestampMs;
			const rightTime = right.item.sortTimestampMs;
			if (leftTime !== null && leftTime !== undefined && rightTime !== null && rightTime !== undefined) {
				return leftTime - rightTime || left.sequence - right.sequence;
			}
			return left.sequence - right.sequence;
		})
		.map(({ item }) => item);
}

function uniqueActivityItems(items: HermesActivityItem[]): HermesActivityItem[] {
	const seen = new Set<string>();
	const result: HermesActivityItem[] = [];
	for (const item of items) {
		const key = (item.path ?? item.label).toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(item);
	}
	return result;
}

function uniqueActivityNoteSpecs(specs: HermesActivityNoteSpec[]): HermesActivityNoteSpec[] {
	const seen = new Set<string>();
	const result: HermesActivityNoteSpec[] = [];
	for (const spec of specs) {
		const key = spec.path.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(spec);
	}
	return result;
}

function uniqueArtifactReferences(references: HermesArtifactReference[]): HermesArtifactReference[] {
	const seen = new Set<string>();
	const result: HermesArtifactReference[] = [];
	for (const reference of references) {
		const key = [
			reference.sourceType,
			reference.sourceId,
			reference.value.toLowerCase(),
		].join(":");
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(reference);
	}
	return result;
}

function activityDigest(value: unknown): string {
	const text = stableStringify(value);
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${(hash >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}

function buildRawRecordBody(title: string, value: unknown): string {
	return `## ${title}\n\n\`\`\`json\n${JSON.stringify(sortJson(value), null, 2)}\n\`\`\`\n`;
}

function buildRawActivityLink(
	options: HermesActivityNoteOptions,
	source: "run" | "event" | "comment",
	rawId: string,
	kind: string,
	label: string
): string {
	const path = buildRawActivityPath(options, source, rawId, kind);
	return `[[${path.replace(/\.md$/i, "")}|${label}]]`;
}

function buildRawActivityPath(
	options: HermesActivityNoteOptions,
	source: "run" | "event" | "comment",
	rawId: string,
	kind: string
): string {
	const normalizedTaskId = options.taskId.replace(/[^A-Za-z0-9_-]/g, "");
	const normalizedId = rawId.replace(/[^A-Za-z0-9]/g, "") || "1";
	const basename = `${normalizedTaskId}-${source}${normalizedId}-${kind}`;
	return canonicalHermesActivityPath(options.taskId, "raw", basename);
}

function buildArtifactActivityLink(
	options: HermesActivityNoteOptions,
	reference: HermesArtifactReference
): string {
	const path = buildArtifactActivityPath(options, reference);
	return `[[${path.replace(/\.md$/i, "")}|${reference.label}]]`;
}

function buildArtifactActivityPath(
	options: HermesActivityNoteOptions,
	reference: HermesArtifactReference
): string {
	const normalizedTaskId = options.taskId.replace(/[^A-Za-z0-9_-]/g, "");
	const normalizedSourceId = reference.sourceId.replace(/[^A-Za-z0-9]/g, "") || "1";
	const digest = activityDigest(reference.value).split("-")[0]?.slice(0, 8) || "artifact";
	const slug = artifactSlug(reference.value);
	const basename = [
		normalizedTaskId,
		`${reference.sourceType}${normalizedSourceId}`,
		slug,
		digest,
	].filter(Boolean).join("-");
	return canonicalHermesActivityPath(options.taskId, "artifacts", basename);
}

function collectEventArtifacts(event: JsonRecord): string[] {
	const values: string[] = [];
	collectPathValues(event, values, ARTIFACT_PATH_KEYS, false);
	values.push(...collectInlinePathValues(summarizePayload(event.payload)));
	return uniqueStrings(values);
}

function summarizePayload(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return compactText(String(value), 180);
	}
	if (Array.isArray(value)) {
		return `${value.length} ${value.length === 1 ? "item" : "items"}`;
	}
	if (isRecord(value)) {
		for (const key of ["summary", "message", "reason", "result", "error", "outcome"]) {
			const text = stringValue(value[key]);
			if (text) {
				return compactText(text, 180);
			}
		}
		return compactText(
			Object.entries(value)
				.slice(0, 3)
				.map(([key, nested]) => `${key}: ${summarizePayload(nested) || "value"}`)
				.join(", "),
			180
		);
	}
	return "";
}

function getSignalEvents(events: JsonRecord[]): JsonRecord[] {
	return events.filter((event) => {
		const kind = stringValue(event.kind)?.toLowerCase();
		if (!kind || kind === "heartbeat" || kind === "commented" || kind.includes("spawn")) {
			return false;
		}
		return true;
	});
}

function collectActivityArtifacts(snapshot: HermesActivitySnapshot): string[] {
	const values: string[] = [];
	for (const comment of snapshot.comments) {
		const model = parseHermesComment(stringValue(comment.body) ?? "", {
			author: stringValue(comment.author),
		});
		collectPathValues(model.payload, values, ARTIFACT_PATH_KEYS, false);
	}
	for (const record of [...snapshot.runs, ...snapshot.events]) {
		collectPathValues(record, values, ARTIFACT_PATH_KEYS, false);
	}
	return uniqueStrings(values);
}

function collectActivityChangedFiles(snapshot: HermesActivitySnapshot): string[] {
	const values: string[] = [];
	for (const comment of snapshot.comments) {
		const model = parseHermesComment(stringValue(comment.body) ?? "", {
			author: stringValue(comment.author),
		});
		collectPathValues(model.payload, values, ["changed_files"], false);
	}
	for (const record of [...snapshot.runs, ...snapshot.events]) {
		collectPathValues(record, values, ["changed_files"], false);
	}
	return uniqueStrings(values);
}

function collectPathValues(
	value: unknown,
	output: string[],
	keys: readonly string[],
	includePathLike = true,
	keyHint = ""
): void {
	if (typeof value === "string") {
		if (keys.includes(keyHint) || (includePathLike && looksLikePath(value))) {
			output.push(value.trim());
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectPathValues(item, output, keys, includePathLike, keyHint);
		}
		return;
	}
	if (isRecord(value)) {
		for (const [key, nested] of Object.entries(value)) {
			collectPathValues(nested, output, keys, includePathLike, key);
		}
	}
}

function collectInlinePathValues(text: string): string[] {
	const values: string[] = [];
	const pathPattern =
		/(?:file:\/\/\/?[^\s"'<>]+?\.(?:base|canvas|csv|html?|json|md|pdf|png|svg|tsv|txt|ya?ml)|\/[^\s"'<>]+?\.(?:base|canvas|csv|html?|json|md|pdf|png|svg|tsv|txt|ya?ml)|\b[A-Za-z0-9_.-]+(?:\/[^\s"'<>]+)*\.(?:base|canvas|csv|html?|json|md|pdf|png|svg|tsv|txt|ya?ml))/gi;
	for (const match of text.matchAll(pathPattern)) {
		const value = match[0].replace(/[),.;:]+$/g, "");
		if (value) {
			values.push(value);
		}
	}
	return uniqueStrings(values);
}

function looksLikePath(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.startsWith("_Artifacts/") ||
		value.startsWith("TaskNotes/") ||
		value.startsWith("30 Projects/") ||
		value.startsWith("20 Job-Search/") ||
		value.startsWith("10 Research-Wiki/") ||
		/\.(?:base|canvas|csv|html?|json|md|pdf|png|svg|tsv|txt|yaml|yml)$/i.test(value)
	);
}

function collectHermesTaskReferenceLinks(text: string, board: string | undefined): string[] {
	const normalizedBoard = board?.trim();
	if (!normalizedBoard || !text) {
		return [];
	}
	const links: string[] = [];
	text.replace(HERMES_TASK_ID_REGEX, (match, _explicitBoard: string | undefined, taskId: string, offset: number) => {
		if (isInsideExistingWikilink(text, offset)) {
			return match;
		}
		const normalizedTaskId = taskId.toLowerCase();
		links.push(`[[${canonicalHermesTaskPath(normalizedTaskId).replace(/\.md$/i, "")}|${normalizedTaskId}]]`);
		return match;
	});
	return uniqueStrings(links);
}

function collectHermesTaskReferenceLinksFromValue(value: unknown, board: string | undefined): string[] {
	if (!board) {
		return [];
	}
	const values: string[] = [];
	collectStringValues(value, values);
	return uniqueStrings(values.flatMap((item) => collectHermesTaskReferenceLinks(item, board)));
}

function collectStringValues(value: unknown, output: string[]): void {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		output.push(String(value));
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectStringValues(item, output);
		}
		return;
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) {
			collectStringValues(item, output);
		}
	}
}

function formatArtifactLink(value: string): string {
	const text = value.trim();
	if (!text || isAlreadyLinked(text)) {
		return text;
	}
	if (text.startsWith("/")) {
		return toFileUrl(text);
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
		return text;
	}
	const target = normalizeArtifactWikilinkTarget(text);
	if (!target) {
		return text;
	}
	const alias = target.split("/").filter(Boolean).pop();
	return alias && alias !== target ? `[[${target}|${alias}]]` : `[[${target}]]`;
}

function artifactLabel(value: string): string {
	return artifactFilename(value) || "Artifact";
}

function artifactFilename(value: string): string {
	const normalized = value
		.trim()
		.replace(/^file:\/\//i, "")
		.split(/[?#]/)[0]
		.replace(/\\/g, "/")
		.replace(/^\[\[/, "")
		.replace(/\]\]$/, "")
		.split("|")[0];
	const filename = normalized.split("/").filter(Boolean).pop() ?? "";
	try {
		return decodeURIComponent(filename);
	} catch {
		return filename;
	}
}

function artifactKind(value: string): string {
	const filename = artifactFilename(value).toLowerCase();
	if (/\.(md|markdown|txt)$/i.test(filename)) return "report";
	if (/\.html?$/i.test(filename)) return "html";
	if (/\.pdf$/i.test(filename)) return "pdf";
	if (/\.(png|jpe?g|gif|webp|svg)$/i.test(filename)) return "image";
	if (/\.(json|ya?ml|csv|tsv)$/i.test(filename)) return "data";
	return "artifact";
}

function artifactSlug(value: string): string {
	const base = artifactFilename(value).replace(/\.[^.]+$/, "") || "artifact";
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "artifact";
}

function capitalizeWord(value: string): string {
	return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function normalizeArtifactWikilinkTarget(value: string): string | null {
	const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
	if (!normalized || normalized.includes("[") || normalized.includes("]")) {
		return null;
	}
	if (
		normalized.startsWith("_Artifacts/") ||
		normalized.startsWith("TaskNotes/") ||
		normalized.startsWith("30 Projects/") ||
		normalized.startsWith("20 Job-Search/") ||
		normalized.startsWith("10 Research-Wiki/")
	) {
		return normalized;
	}
	if (!normalized.includes("/") && /\.(?:base|canvas|csv|html?|json|md|pdf|png|svg|tsv|txt|yaml|yml)$/i.test(normalized)) {
		return normalized;
	}
	return null;
}

function toFileUrl(path: string): string {
	return encodeURI(`file://${path}`);
}

function isAlreadyLinked(text: string): boolean {
	return (
		(text.startsWith("[[") && text.endsWith("]]")) ||
		/^!?\[[^\]]+\]\([^)]+\)$/.test(text) ||
		(text.startsWith("<") && text.endsWith(">"))
	);
}

function isInsideExistingWikilink(text: string, index: number): boolean {
	const lastOpen = text.lastIndexOf("[[", index);
	if (lastOpen < 0) {
		return false;
	}
	const lastClose = text.lastIndexOf("]]", index);
	return lastOpen > lastClose;
}

function removeEmptyFrontmatterValues(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => {
			if (Array.isArray(item)) {
				return item.length > 0;
			}
			return item !== undefined && item !== null && item !== "";
		})
	);
}

function stringListValue(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item) => {
		const text = stringValue(item);
		return text ? [text] : [];
	});
}

function firstStringListValue(
	value: Record<string, JsonValue>,
	keys: readonly string[]
): string[] {
	for (const key of keys) {
		const list = stringListValue(value[key]);
		if (list.length > 0) {
			return list;
		}
	}
	return [];
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values.map((item) => item.trim()).filter(Boolean)) {
		const key = value.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(value);
	}
	return result;
}

function compactText(value: string, maxLength: number): string {
	const compacted = value.replace(/\s+/g, " ").trim();
	if (compacted.length <= maxLength) {
		return compacted;
	}
	return `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value.trim() || undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function timestampValue(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return formatHermesEpochTimestamp(value);
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(trimmed)) {
		return formatHermesEpochTimestamp(numeric);
	}
	return trimmed;
}

function formatHermesEpochTimestamp(value: number): string {
	const milliseconds = Math.abs(value) < 100000000000 ? value * 1000 : value;
	return new Date(milliseconds).toISOString().replace(".000Z", "Z");
}

function hermesActivityTimestampMs(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortJson(value[key])])
	);
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
