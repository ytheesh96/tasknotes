import { parse, stringify } from "yaml";
import type { TaskInfo } from "../types";
import {
	HERMES_CANONICAL_SYNC_VERSION,
	HERMES_SYNC_VERSION_FRONTMATTER,
	readHermesArchivedFrontmatter,
	readHermesBoardFrontmatter,
	readHermesTaskIdFrontmatter,
} from "./hermesCanonicalTaskNotes";
import {
	planHermesActivityMirrorMigration,
	planHermesCanonicalMirrorMigration,
	type HermesActivityMirrorBackfill,
	type HermesCanonicalMirrorMigrationOptions,
	type HermesCanonicalMirrorMigrationPlan,
} from "./hermesCanonicalMigration";

export interface HermesMigrationVault {
	listMarkdownFiles(): Promise<string[]>;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
}

export interface HermesMigrationNote {
	path: string;
	content: string;
}

export interface HermesCanonicalPropertyBackfill {
	path: string;
	taskId: string;
	board: string | null;
	properties: Record<string, string | number | boolean>;
}

export interface HermesCleanupCandidate {
	path: string;
	taskId: string;
	board: string | null;
	reason: "duplicate-task-mirror" | "orphaned-task-mirror" | "duplicate-activity-mirror" | "orphaned-activity-mirror";
	destructive: true;
	requiresApproval: true;
}

export interface HermesActivityMirrorOrphan {
	taskId: string;
	board: string | null;
	path: string;
	reason: "missing-task-mirror-or-remote-task";
}

export interface HermesCanonicalMigrationSummary {
	totalMarkdownFiles: number;
	hermesTaskMirrors: number;
	hermesActivityMirrors: number;
	propertyBackfills: number;
	mirrorRelocations: number;
	activityRelocations: number;
	duplicateTaskGroups: number;
	duplicateActivityGroups: number;
	orphanedTaskMirrors: number;
	orphanedActivityMirrors: number;
	destructiveCleanupCandidates: number;
}

export interface HermesCanonicalMigrationReport {
	summary: HermesCanonicalMigrationSummary;
	taskMirrorPlan: HermesCanonicalMirrorMigrationPlan;
	activityRelocations: HermesActivityMirrorBackfill[];
	activityOrphans: HermesActivityMirrorOrphan[];
	propertyBackfills: HermesCanonicalPropertyBackfill[];
	cleanupCandidates: HermesCleanupCandidate[];
}

export interface HermesBackfillOptions extends HermesCanonicalMirrorMigrationOptions {
	dryRun?: boolean;
	writeCanonicalProperties?: boolean;
	vault: HermesMigrationVault;
}

export interface HermesMigrationWriteResult {
	path: string;
	action: "backfill-canonical-frontmatter";
	dryRun: boolean;
}

export interface HermesBackfillResult {
	report: HermesCanonicalMigrationReport;
	writes: HermesMigrationWriteResult[];
}

interface ParsedMarkdown {
	frontmatter: Record<string, unknown>;
	body: string;
	hasFrontmatter: boolean;
}

interface InventoryEntry {
	note: HermesMigrationNote;
	parsed: ParsedMarkdown;
	taskInfo: TaskInfo;
	taskId: string | null;
	board: string | null;
	isActivity: boolean;
	isTaskMirror: boolean;
}

export async function applyHermesCanonicalBackfill(
	options: HermesBackfillOptions
): Promise<HermesBackfillResult> {
	const paths = (await options.vault.listMarkdownFiles()).filter((path) => path.endsWith(".md"));
	const notes = await Promise.all(
		paths.map(async (path): Promise<HermesMigrationNote> => ({
			path,
			content: await options.vault.read(path),
		}))
	);
	const report = createHermesCanonicalMigrationReport(notes, {
		remoteTaskIdsByBoard: options.remoteTaskIdsByBoard,
	});
	const writes: HermesMigrationWriteResult[] = [];
	const dryRun = options.dryRun !== false;
	if (!dryRun && options.writeCanonicalProperties) {
		const backfillsByPath = new Map(report.propertyBackfills.map((item) => [item.path, item]));
		for (const note of notes) {
			const backfill = backfillsByPath.get(note.path);
			if (!backfill) {
				continue;
			}
			await options.vault.write(note.path, renderBackfilledMarkdown(note.content, backfill.properties));
			writes.push({ path: note.path, action: "backfill-canonical-frontmatter", dryRun: false });
		}
	}
	return { report, writes };
}

export function createHermesCanonicalMigrationReport(
	notes: readonly HermesMigrationNote[],
	options: HermesCanonicalMirrorMigrationOptions = {}
): HermesCanonicalMigrationReport {
	const inventory = notes.map(createInventoryEntry);
	const hermesEntries = inventory.filter((entry) => entry.taskId);
	const taskEntries = hermesEntries.filter((entry) => entry.isTaskMirror);
	const activityEntries = hermesEntries.filter((entry) => entry.isActivity);
	const taskInfo = taskEntries.map((entry) => entry.taskInfo);
	const taskMirrorPlan = planHermesCanonicalMirrorMigration(taskInfo, options);
	const activityPlan = planHermesActivityMirrorMigration(activityEntries.map((entry) => entry.taskInfo));
	const propertyBackfills = hermesEntries.flatMap(getCanonicalPropertyBackfill);
	const activityOrphans = findOrphanedActivityMirrors(activityEntries, taskEntries, options);
	const cleanupCandidates = buildCleanupCandidates(taskMirrorPlan, activityPlan.duplicates, activityOrphans);
	const summary: HermesCanonicalMigrationSummary = {
		totalMarkdownFiles: notes.length,
		hermesTaskMirrors: taskEntries.length,
		hermesActivityMirrors: activityEntries.length,
		propertyBackfills: propertyBackfills.length,
		mirrorRelocations: taskMirrorPlan.migrations.length,
		activityRelocations: activityPlan.legacy.length,
		duplicateTaskGroups: taskMirrorPlan.duplicates.length,
		duplicateActivityGroups: activityPlan.duplicates.length,
		orphanedTaskMirrors: taskMirrorPlan.orphans.length,
		orphanedActivityMirrors: activityOrphans.length,
		destructiveCleanupCandidates: cleanupCandidates.length,
	};
	return {
		summary,
		taskMirrorPlan,
		activityRelocations: activityPlan.legacy,
		activityOrphans,
		propertyBackfills,
		cleanupCandidates,
	};
}

function createInventoryEntry(note: HermesMigrationNote): InventoryEntry {
	const parsed = parseMarkdown(note.content);
	const taskId = readHermesTaskIdFrontmatter(parsed.frontmatter);
	const board = readHermesBoardFrontmatter(parsed.frontmatter);
	const isActivity = isHermesActivityPath(note.path, parsed.frontmatter);
	const taskInfo: TaskInfo = {
		title: note.path.split("/").pop() ?? note.path,
		status: "unknown",
		priority: "normal",
		path: note.path,
		archived: readHermesArchivedFrontmatter(parsed.frontmatter) ?? false,
		tags: [],
		contexts: [],
		projects: [],
		customProperties: parsed.frontmatter,
	};
	return {
		note,
		parsed,
		taskInfo,
		taskId,
		board,
		isActivity,
		isTaskMirror: Boolean(taskId) && !isActivity,
	};
}

function getCanonicalPropertyBackfill(entry: InventoryEntry): HermesCanonicalPropertyBackfill[] {
	if (!entry.taskId) {
		return [];
	}
	const properties: Record<string, string | number | boolean> = {};
	if (entry.parsed.frontmatter.hermesTaskId !== entry.taskId) {
		properties.hermesTaskId = entry.taskId;
	}
	if (entry.board && entry.parsed.frontmatter.hermesBoard !== entry.board) {
		properties.hermesBoard = entry.board;
	}
	const archived = readHermesArchivedFrontmatter(entry.parsed.frontmatter);
	if (archived !== null && entry.parsed.frontmatter.hermesArchived !== archived) {
		properties.hermesArchived = archived;
	}
	if (entry.parsed.frontmatter[HERMES_SYNC_VERSION_FRONTMATTER] !== HERMES_CANONICAL_SYNC_VERSION) {
		properties[HERMES_SYNC_VERSION_FRONTMATTER] = HERMES_CANONICAL_SYNC_VERSION;
	}
	return Object.keys(properties).length > 0
		? [{ path: entry.note.path, taskId: entry.taskId, board: entry.board, properties }]
		: [];
}

function buildCleanupCandidates(
	taskMirrorPlan: HermesCanonicalMirrorMigrationPlan,
	activityDuplicates: readonly { taskId: string; paths: readonly string[] }[],
	activityOrphans: readonly HermesActivityMirrorOrphan[]
): HermesCleanupCandidate[] {
	const candidates: HermesCleanupCandidate[] = [];
	for (const duplicate of taskMirrorPlan.duplicates) {
		for (const path of duplicate.paths.filter((path) => path !== duplicate.canonicalPath)) {
			candidates.push({
				path,
				taskId: duplicate.taskId,
				board: duplicate.board,
				reason: "duplicate-task-mirror",
				destructive: true,
				requiresApproval: true,
			});
		}
	}
	for (const orphan of taskMirrorPlan.orphans) {
		candidates.push({
			path: orphan.path,
			taskId: orphan.taskId,
			board: orphan.board,
			reason: "orphaned-task-mirror",
			destructive: true,
			requiresApproval: true,
		});
	}
	for (const duplicate of activityDuplicates) {
		for (const path of duplicate.paths.slice(1)) {
			candidates.push({
				path,
				taskId: duplicate.taskId,
				board: null,
				reason: "duplicate-activity-mirror",
				destructive: true,
				requiresApproval: true,
			});
		}
	}
	for (const orphan of activityOrphans) {
		candidates.push({
			path: orphan.path,
			taskId: orphan.taskId,
			board: orphan.board,
			reason: "orphaned-activity-mirror",
			destructive: true,
			requiresApproval: true,
		});
	}
	return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

function findOrphanedActivityMirrors(
	activityEntries: readonly InventoryEntry[],
	taskEntries: readonly InventoryEntry[],
	options: HermesCanonicalMirrorMigrationOptions
): HermesActivityMirrorOrphan[] {
	const taskIds = new Set(taskEntries.map((entry) => entry.taskId).filter((id): id is string => Boolean(id)));
	const remoteIds = normalizeRemoteIds(options.remoteTaskIdsByBoard);
	return activityEntries
		.flatMap((entry): HermesActivityMirrorOrphan[] => {
			if (!entry.taskId) {
				return [];
			}
			if (taskIds.has(entry.taskId)) {
				return [];
			}
			const orphan: HermesActivityMirrorOrphan = {
				taskId: entry.taskId,
				board: entry.board,
				path: entry.note.path,
				reason: "missing-task-mirror-or-remote-task",
			};
			if (!entry.board) {
				return [orphan];
			}
			const remoteBoardIds = remoteIds.get(entry.board);
			return remoteBoardIds && !remoteBoardIds.has(entry.taskId) ? [orphan] : [];
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRemoteIds(
	input: HermesCanonicalMirrorMigrationOptions["remoteTaskIdsByBoard"]
): Map<string, Set<string>> {
	if (!input) {
		return new Map();
	}
	if (input instanceof Map) {
		return new Map([...input.entries()].map(([board, ids]) => [board, new Set(ids)]));
	}
	return new Map(Object.entries(input).map(([board, ids]) => [board, new Set(ids)]));
}

function renderBackfilledMarkdown(content: string, properties: Record<string, string | number | boolean>): string {
	const parsed = parseMarkdown(content);
	const frontmatter = { ...parsed.frontmatter, ...properties };
	const yaml = stringify(frontmatter).trimEnd();
	return `---\n${yaml}\n---\n${parsed.body.replace(/^\n/, "")}`;
}

function parseMarkdown(content: string): ParsedMarkdown {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) {
		return { frontmatter: {}, body: content, hasFrontmatter: false };
	}
	const parsed = parse(match[1]);
	return {
		frontmatter: isRecord(parsed) && Object.keys(parsed).length > 0 ? parsed : parseSimpleFrontmatter(match[1]),
		body: content.slice(match[0].length),
		hasFrontmatter: true,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSimpleFrontmatter(yaml: string): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {};
	for (const line of yaml.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) {
			continue;
		}
		frontmatter[match[1]] = parseSimpleScalar(match[2]);
	}
	return frontmatter;
}

function parseSimpleScalar(value: string): string | number | boolean | null {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null") return null;
	const numberValue = Number(trimmed);
	if (trimmed !== "" && Number.isFinite(numberValue) && String(numberValue) === trimmed) {
		return numberValue;
	}
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function isHermesActivityPath(path: string, frontmatter: Record<string, unknown>): boolean {
	if (typeof frontmatter.type === "string" && frontmatter.type.startsWith("hermes-")) {
		return ["hermes-comment", "hermes-run", "hermes-event", "hermes-artifact", "hermes-raw"].includes(
			frontmatter.type
		);
	}
	return /(?:^|\/)activity\/(comments|runs|events|artifacts|raw)\//i.test(path);
}
