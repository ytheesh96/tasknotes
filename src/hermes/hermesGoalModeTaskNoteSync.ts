import { TFile } from "obsidian";
import type TaskNotesPlugin from "../main";
import { processVaultFrontMatter } from "../core/VaultMutationService";
import type { TaskInfo } from "../types";
import { getCurrentTimestamp } from "../utils/dateUtils";
import {
	HermesKanbanApiClient,
	type HermesCreateTaskPayload,
	type HermesTaskRecord,
} from "./hermesApiClient";
import { createHermesKanbanClient } from "./hermesKanbanTransport";
import { normalizeHermesBoardValue, splitHermesList } from "./hermesRouting";
import { HermesWriteGuard } from "./hermesWriteGuard";

const GOAL_TAGS = new Set(["goal", "#goal", "hermes-goal"]);
const DEFAULT_GOAL_BOARD = "default";

export type HermesGoalModeTaskNoteSyncResult =
	| { status: "created"; board: string; cardId: string }
	| { status: "skipped"; reason: "not-eligible" | "already-synced"; board?: string; cardId?: string };

export type SyncedHermesGoalMetadata = {
	board: string;
	cardId: string;
	mode: "goal";
};

type HermesGoalModeTaskNoteSyncApi = Pick<HermesKanbanApiClient, "createTask" | "addComment">;
type HermesGoalModeTaskCreator = Pick<HermesKanbanApiClient, "createTask">;
type HermesGoalModeWriteGuard = Pick<HermesWriteGuard, "assertCanCreateHermesTask">;

type HermesFrontmatterWriter = (
	plugin: TaskNotesPlugin,
	task: TaskInfo,
	board: string,
	card: HermesTaskRecord,
	now: string
) => Promise<void>;

export function isGoalModeTaskNoteSyncEligible(task: TaskInfo): boolean {
	return hasGoalTag(task) && !getSyncedHermesGoalMetadata(task);
}

export function getSyncedHermesGoalMetadata(task: TaskInfo): SyncedHermesGoalMetadata | null {
	const metadata = task.customProperties ?? {};
	const nested = isRecord(metadata.hermes) ? metadata.hermes : null;
	const cardId = stringValue(nested?.cardId) ?? stringValue(metadata["hermes.cardId"]);
	const mode = stringValue(nested?.mode) ?? stringValue(metadata["hermes.mode"]);
	if (!cardId || mode !== "goal") {
		return null;
	}
	const board = stringValue(nested?.board) ?? stringValue(metadata["hermes.board"]) ?? getGoalModeTaskNoteBoard(task);
	return { board, cardId, mode };
}

export function getGoalModeTaskNoteBoard(task: TaskInfo): string {
	for (const project of splitHermesList(task.projects)) {
		const board = normalizeHermesBoardValue(project);
		if (board) return board;
	}
	return DEFAULT_GOAL_BOARD;
}

export function buildGoalModeCreatePayloadFromTaskNote(task: TaskInfo): HermesCreateTaskPayload {
	const status = "triage";
	return {
		title: task.title.trim(),
		body: buildGoalModeBody(task),
		status,
		assignee: getGoalModeTaskNoteAssignee(task) ?? undefined,
		priority: taskNotesPriorityToHermesPriority(task.priority),
		created_by: "tasknotes",
		triage: true,
		idempotency_key: buildGoalModeTaskNoteIdempotencyKey(task),
	};
}

export async function syncGoalModeTaskNoteToHermes(
	plugin: TaskNotesPlugin,
	task: TaskInfo,
	options: {
		api?: HermesGoalModeTaskNoteSyncApi;
		taskCreator?: HermesGoalModeTaskCreator;
		now?: string;
		frontmatterWriter?: HermesFrontmatterWriter;
		writeGuard?: HermesGoalModeWriteGuard;
	} = {}
): Promise<HermesGoalModeTaskNoteSyncResult> {
	const existing = getSyncedHermesGoalMetadata(task);
	if (existing) {
		return {
			status: "skipped",
			reason: "already-synced",
			board: existing.board,
			cardId: existing.cardId,
		};
	}
	if (!hasGoalTag(task)) {
		return { status: "skipped", reason: "not-eligible" };
	}

	const board = getGoalModeTaskNoteBoard(task);
	const transportMode = plugin.settings?.hermesKanbanTransport ?? "kanban-cli";
	await (options.writeGuard ?? new HermesWriteGuard({ transport: transportMode })).assertCanCreateHermesTask(board);
	const api = options.api ?? new HermesKanbanApiClient();
	const taskCreator = options.taskCreator ?? options.api ?? createHermesKanbanClient(transportMode);
	const payload = buildGoalModeCreatePayloadFromTaskNote(task);
	const created = await taskCreator.createTask(board, payload);
	await addGoalModeTaskNoteSyncComment(api, { board, id: created.id }, task);
	const now = options.now ?? getCurrentTimestamp();
	const frontmatterWriter = options.frontmatterWriter ?? writeHermesGoalModeSyncMetadata;
	try {
		await frontmatterWriter(plugin, task, board, created, now);
	} catch (error) {
		throw new Error(
			`Created Hermes Goal Mode card ${created.id}, but failed to write sync metadata: ${errorMessage(error)}`
		);
	}
	return { status: "created", board, cardId: created.id };
}

async function addGoalModeTaskNoteSyncComment(
	api: HermesGoalModeTaskNoteSyncApi,
	identity: { board: string; id: string },
	task: TaskInfo
): Promise<void> {
	await api.addComment(identity, {
		body: [
			"Created from Obsidian TaskNote #goal sync.",
			"",
			"```json",
			JSON.stringify(
				{
					hermes_card_mode: "goal",
					hermes_mode: "goal",
					source: "obsidian-tasknotes",
					source_path: task.path,
				},
				null,
				2
			),
			"```",
		].join("\n"),
	});
}

async function writeHermesGoalModeSyncMetadata(
	plugin: TaskNotesPlugin,
	task: TaskInfo,
	board: string,
	card: HermesTaskRecord,
	now: string
): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) {
		throw new Error(`TaskNote file not found: ${task.path}`);
	}
	await processVaultFrontMatter(plugin.app, file, (frontmatter) => {
		frontmatter.hermes = {
			...(isRecord(frontmatter.hermes) ? frontmatter.hermes : {}),
			board,
			cardId: card.id,
			mode: "goal",
			syncedAt: now,
		};
		frontmatter.hermesCardMode = "goal";
		frontmatter.hermesMode = "goal";
	});
	plugin.cacheManager.updateTaskInfoInCache?.(task.path, {
		...task,
		customProperties: {
			...(task.customProperties ?? {}),
			hermes: { board, cardId: card.id, mode: "goal", syncedAt: now },
			hermesCardMode: "goal",
			hermesMode: "goal",
		},
	});
}

function hasGoalTag(task: TaskInfo): boolean {
	return splitHermesList(task.tags).some((tag) => GOAL_TAGS.has(tag.toLowerCase()));
}

function getGoalModeTaskNoteAssignee(task: TaskInfo): string | null {
	return splitHermesList(task.contexts).find((context) => context.toLowerCase() !== "none") ?? null;
}

function buildGoalModeTaskNoteIdempotencyKey(task: TaskInfo): string {
	return `tasknotes:goal-note:${task.path}`;
}

function buildGoalModeBody(task: TaskInfo): string | undefined {
	const lines = [task.details?.trim() ?? ""];
	const metadataLines = [
		task.scheduled ? `Scheduled: ${task.scheduled}` : null,
		task.due ? `Due: ${task.due}` : null,
	]
		.filter((line): line is string => Boolean(line));
	if (metadataLines.length > 0) {
		if (lines[0]) lines.push("");
		lines.push(...metadataLines);
	}
	return lines.join("\n").trim() || undefined;
}

function taskNotesPriorityToHermesPriority(priority: string | null | undefined): number {
	switch (priority) {
		case "low":
			return 2;
		case "high":
			return 8;
		case "normal":
			return 5;
		default:
			return 0;
	}
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
