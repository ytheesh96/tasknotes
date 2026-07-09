import type { TaskInfo } from "../types";
import { getHermesTaskIdentity, type HermesTaskIdentity } from "./hermesApiClient";
import {
	canonicalHermesActivityPath,
	canonicalHermesTaskPath,
	readHermesBoardFrontmatter,
	readHermesTaskIdFrontmatter,
} from "./hermesCanonicalTaskNotes";

export interface HermesCanonicalMirrorMigration {
	taskId: string;
	board: string;
	fromPath: string;
	toPath: string;
	reason: "legacy-board-prefixed-path" | "noncanonical-managed-path";
}

export interface HermesCanonicalMirrorDuplicateGroup {
	taskId: string;
	board: string;
	canonicalPath: string;
	paths: string[];
}

export interface HermesCanonicalMirrorOrphan {
	taskId: string;
	board: string;
	path: string;
	reason: "missing-from-hermes-board";
}

export interface HermesCanonicalMirrorMigrationPlan {
	migrations: HermesCanonicalMirrorMigration[];
	duplicates: HermesCanonicalMirrorDuplicateGroup[];
	orphans: HermesCanonicalMirrorOrphan[];
}

export type HermesActivityMirrorType = "comments" | "runs" | "events" | "artifacts" | "raw";

export interface HermesActivityMirrorBackfill {
	taskId: string;
	board: string | null;
	activityType: HermesActivityMirrorType;
	fromPath: string;
	toPath: string;
	action: "copy";
	destructive: false;
	reason: "legacy-board-activity-path" | "noncanonical-activity-path";
}

export interface HermesActivityMirrorDuplicateGroup {
	taskId: string;
	activityType: HermesActivityMirrorType;
	canonicalPath: string;
	paths: string[];
}

export interface HermesActivityMirrorMigrationPlan {
	legacy: HermesActivityMirrorBackfill[];
	duplicates: HermesActivityMirrorDuplicateGroup[];
}

export interface HermesCanonicalMirrorMigrationOptions {
	remoteTaskIdsByBoard?: ReadonlyMap<string, ReadonlySet<string>> | Record<string, readonly string[]>;
}

interface ManagedTaskCandidate {
	identity: HermesTaskIdentity;
	task: TaskInfo;
	canonicalPath: string;
}

interface ManagedActivityCandidate {
	taskId: string;
	board: string | null;
	activityType: HermesActivityMirrorType;
	task: TaskInfo;
	canonicalPath: string;
	isCanonical: boolean;
	isLegacyBoardPath: boolean;
}

export function planHermesActivityMirrorMigration(
	tasks: readonly TaskInfo[]
): HermesActivityMirrorMigrationPlan {
	const candidates = tasks
		.map(getManagedActivityCandidate)
		.filter((candidate): candidate is ManagedActivityCandidate => candidate !== null);
	const uniqueCandidates = uniqueActivityCandidates(candidates);
	const pathsByCanonicalPath = new Map<string, Set<string>>();
	for (const candidate of uniqueCandidates) {
		const paths = pathsByCanonicalPath.get(candidate.canonicalPath) ?? new Set<string>();
		paths.add(candidate.task.path);
		pathsByCanonicalPath.set(candidate.canonicalPath, paths);
	}

	return {
		legacy: uniqueCandidates
			.filter((candidate) => {
				if (candidate.isCanonical) {
					return false;
				}
				const collidingPaths = pathsByCanonicalPath.get(candidate.canonicalPath);
				return !collidingPaths || collidingPaths.size <= 1;
			})
			.map((candidate): HermesActivityMirrorBackfill => ({
				taskId: candidate.taskId,
				board: candidate.board,
				activityType: candidate.activityType,
				fromPath: candidate.task.path,
				toPath: candidate.canonicalPath,
				action: "copy",
				destructive: false,
				reason: candidate.isLegacyBoardPath
					? "legacy-board-activity-path"
					: "noncanonical-activity-path",
			}))
			.sort(compareActivityBackfill),
		duplicates: [...pathsByCanonicalPath.entries()]
			.flatMap(([canonicalPath, paths]) => {
				const uniquePaths = [...paths].sort();
				if (uniquePaths.length <= 1) {
					return [];
				}
				const candidate = uniqueCandidates.find((item) => item.canonicalPath === canonicalPath);
				if (!candidate) {
					return [];
				}
				return [
					{
						taskId: candidate.taskId,
						activityType: candidate.activityType,
						canonicalPath,
						paths: uniquePaths,
					},
				];
			})
			.sort(compareActivityDuplicateGroup),
	};
}

export function planHermesCanonicalMirrorMigration(
	tasks: readonly TaskInfo[],
	options: HermesCanonicalMirrorMigrationOptions = {}
): HermesCanonicalMirrorMigrationPlan {
	const candidates = tasks
		.map((task): ManagedTaskCandidate | null => {
			const identity = getHermesTaskIdentity(task);
			if (!identity) {
				return null;
			}
			return {
				identity,
				task,
				canonicalPath: canonicalHermesTaskPath(identity.board, identity.id),
			};
		})
		.filter((candidate): candidate is ManagedTaskCandidate => candidate !== null);
	const candidatesByIdentity = new Map<string, ManagedTaskCandidate[]>();
	for (const candidate of candidates) {
		const key = migrationIdentityKey(candidate.identity);
		const group = candidatesByIdentity.get(key) ?? [];
		group.push(candidate);
		candidatesByIdentity.set(key, group);
	}

	const duplicates: HermesCanonicalMirrorDuplicateGroup[] = [];
	const duplicateKeys = new Set<string>();
	for (const [key, group] of candidatesByIdentity.entries()) {
		const uniquePaths = [...new Set(group.map((candidate) => candidate.task.path))].sort();
		if (uniquePaths.length <= 1) {
			continue;
		}
		duplicateKeys.add(key);
		duplicates.push({
			taskId: group[0].identity.id,
			board: group[0].identity.board,
			canonicalPath: group[0].canonicalPath,
			paths: uniquePaths,
		});
	}

	const migrations: HermesCanonicalMirrorMigration[] = [];
	const orphans: HermesCanonicalMirrorOrphan[] = [];
	const remoteTaskIdsByBoard = normalizeRemoteTaskIds(options.remoteTaskIdsByBoard);
	for (const candidate of candidates) {
		if (!duplicateKeys.has(migrationIdentityKey(candidate.identity)) && candidate.task.path !== candidate.canonicalPath) {
			migrations.push({
				taskId: candidate.identity.id,
				board: candidate.identity.board,
				fromPath: candidate.task.path,
				toPath: candidate.canonicalPath,
				reason: isLegacyBoardPrefixedPath(candidate.task.path, candidate.identity)
					? "legacy-board-prefixed-path"
					: "noncanonical-managed-path",
			});
		}
		const liveIds = remoteTaskIdsByBoard.get(candidate.identity.board);
		if (liveIds && !liveIds.has(candidate.identity.id)) {
			orphans.push({
				taskId: candidate.identity.id,
				board: candidate.identity.board,
				path: candidate.task.path,
				reason: "missing-from-hermes-board",
			});
		}
	}

	return {
		migrations: migrations.sort(compareMigration),
		duplicates: duplicates.sort(compareDuplicateGroup),
		orphans: orphans.sort(compareOrphan),
	};
}

function migrationIdentityKey(identity: HermesTaskIdentity): string {
	return `${identity.board}\u0000${identity.id}`;
}

function getManagedActivityCandidate(task: TaskInfo): ManagedActivityCandidate | null {
	const frontmatter = task.customProperties ?? {};
	const taskId = readHermesTaskIdFrontmatter(frontmatter);
	if (!taskId) {
		return null;
	}
	const activityType = getHermesActivityType(task);
	if (!activityType) {
		return null;
	}
	const basename = activityBasename(task.path);
	if (!basename) {
		return null;
	}
	const board = readHermesBoardFrontmatter(frontmatter);
	if (!board) {
		return null;
	}
	const canonicalPath = canonicalHermesActivityPath(board, taskId, activityType, basename);
	return {
		taskId,
		board,
		activityType,
		task,
		canonicalPath,
		isCanonical: normalizePath(task.path) === canonicalPath,
		isLegacyBoardPath: isLegacyBoardActivityPath(task.path, activityType),
	};
}

function uniqueActivityCandidates(
	candidates: readonly ManagedActivityCandidate[]
): ManagedActivityCandidate[] {
	const seen = new Set<string>();
	const unique: ManagedActivityCandidate[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.task.path}\u0000${candidate.canonicalPath}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function getHermesActivityType(task: TaskInfo): HermesActivityMirrorType | null {
	const pathType = activityTypeFromPath(task.path);
	if (pathType) {
		return pathType;
	}
	const frontmatterType = task.customProperties?.type;
	if (frontmatterType === "hermes-comment") return "comments";
	if (frontmatterType === "hermes-run") return "runs";
	if (frontmatterType === "hermes-event") return "events";
	if (frontmatterType === "hermes-artifact") return "artifacts";
	if (frontmatterType === "hermes-raw") return "raw";
	return null;
}

function activityTypeFromPath(path: string): HermesActivityMirrorType | null {
	const normalized = normalizePath(path);
	const match = normalized.match(/(?:^|\/)activity\/(comments|runs|events|artifacts|raw)\//i);
	if (match) {
		return match[1].toLowerCase() as HermesActivityMirrorType;
	}
	const canonicalMatch = normalized.match(
		/(?:^|\/)Activity\/(?:[^/]+\/)?[^/]+\/(comments|runs|events|artifacts|raw)\//
	);
	return canonicalMatch ? (canonicalMatch[1] as HermesActivityMirrorType) : null;
}

function activityBasename(path: string): string | null {
	const filename = normalizePath(path).split("/").pop();
	if (!filename) {
		return null;
	}
	return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

function isLegacyBoardActivityPath(path: string, activityType: HermesActivityMirrorType): boolean {
	return new RegExp(`^TaskNotes/[^/]+/activity/${activityType}/[^/]+\\.md$`, "i").test(
		normalizePath(path)
	);
}

function normalizePath(path: string): string {
	return path.trim().replace(/\\/g, "/");
}

function compareActivityBackfill(
	left: HermesActivityMirrorBackfill,
	right: HermesActivityMirrorBackfill
): number {
	return (
		left.taskId.localeCompare(right.taskId) ||
		left.activityType.localeCompare(right.activityType) ||
		left.fromPath.localeCompare(right.fromPath)
	);
}

function compareActivityDuplicateGroup(
	left: HermesActivityMirrorDuplicateGroup,
	right: HermesActivityMirrorDuplicateGroup
): number {
	return (
		left.taskId.localeCompare(right.taskId) ||
		left.activityType.localeCompare(right.activityType) ||
		left.canonicalPath.localeCompare(right.canonicalPath)
	);
}

function isLegacyBoardPrefixedPath(path: string, identity: HermesTaskIdentity): boolean {
	return path === `TaskNotes/${identity.board}/${identity.id}.md`;
}

function normalizeRemoteTaskIds(
	input: HermesCanonicalMirrorMigrationOptions["remoteTaskIdsByBoard"]
): Map<string, Set<string>> {
	const output = new Map<string, Set<string>>();
	if (!input) {
		return output;
	}
	if (input instanceof Map) {
		for (const [board, ids] of input.entries()) {
			output.set(board, new Set(ids));
		}
		return output;
	}
	for (const [board, ids] of Object.entries(input)) {
		output.set(board, new Set(ids));
	}
	return output;
}

function compareMigration(left: HermesCanonicalMirrorMigration, right: HermesCanonicalMirrorMigration): number {
	return left.board.localeCompare(right.board) || left.taskId.localeCompare(right.taskId);
}

function compareDuplicateGroup(
	left: HermesCanonicalMirrorDuplicateGroup,
	right: HermesCanonicalMirrorDuplicateGroup
): number {
	return left.board.localeCompare(right.board) || left.taskId.localeCompare(right.taskId);
}

function compareOrphan(left: HermesCanonicalMirrorOrphan, right: HermesCanonicalMirrorOrphan): number {
	return left.board.localeCompare(right.board) || left.taskId.localeCompare(right.taskId);
}
