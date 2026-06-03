import type { TaskInfo } from "../types";
import {
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
	type HermesAvailabilityMode,
	type HermesAvailabilityStatus,
} from "./hermesAvailabilityService";
import { getHermesTaskIdentity } from "./hermesApiClient";
import { normalizeHermesBoardValue, splitHermesList } from "./hermesRouting";

export const HERMES_WRITE_BLOCKED_MESSAGE =
	"Hermes is unavailable. Start or reconnect Hermes before editing board tasks.";

export type HermesWriteReadiness =
	| {
			allowed: true;
			board?: string;
			taskId?: string;
			health: HermesAvailabilityHealth;
	  }
	| {
			allowed: false;
			board: string;
			taskId?: string;
			status: HermesAvailabilityStatus;
			mode: HermesAvailabilityMode;
			health: HermesAvailabilityHealth;
			reason: string;
	  };

export interface HermesWriteGuardHealthService {
	recheckHealth(): Promise<HermesAvailabilityHealth>;
}

export interface HermesWriteGuardDeps {
	availabilityService?: HermesWriteGuardHealthService;
}

export class HermesWriteUnavailableError extends Error {
	constructor(readiness: Extract<HermesWriteReadiness, { allowed: false }>) {
		super(readiness.reason);
		this.name = "HermesWriteUnavailableError";
	}
}

export class HermesWriteGuard {
	constructor(private readonly deps: HermesWriteGuardDeps = {}) {}

	async canCreateHermesTask(board: string): Promise<HermesWriteReadiness> {
		const normalizedBoard = board.trim();
		if (!normalizedBoard) {
			throw new Error("Choose a board before submitting.");
		}
		return this.checkBoard(normalizedBoard);
	}

	async canWriteHermesTask(task: TaskInfo): Promise<HermesWriteReadiness> {
		const identity = getHermesTaskIdentity(task);
		if (!identity) {
			return {
				allowed: true,
				health: connectedFallbackHealth(),
			};
		}
		return this.checkBoard(identity.board, identity.id);
	}

	async assertCanCreateHermesTask(board: string): Promise<void> {
		const readiness = await this.canCreateHermesTask(board);
		if (!readiness.allowed) {
			throw new HermesWriteUnavailableError(readiness);
		}
	}

	async assertCanWriteHermesTask(task: TaskInfo): Promise<void> {
		const readiness = await this.canWriteHermesTask(task);
		if (!readiness.allowed) {
			throw new HermesWriteUnavailableError(readiness);
		}
	}

	private async checkBoard(board: string, taskId?: string): Promise<HermesWriteReadiness> {
		const health = await this.healthService().recheckHealth();
		if (isHermesWriteHealthLive(health)) {
			return { allowed: true, board, taskId, health };
		}
		return {
			allowed: false,
			board,
			taskId,
			status: health.status,
			mode: health.mode,
			health,
			reason: formatHermesWriteBlockedMessage(health),
		};
	}

	private healthService(): HermesWriteGuardHealthService {
		return this.deps.availabilityService ?? new HermesAvailabilityService();
	}
}

export function isHermesWriteHealthLive(health: HermesAvailabilityHealth): boolean {
	return health.status === "connected" && health.mode === "live";
}

export function formatHermesWriteBlockedMessage(health: HermesAvailabilityHealth): string {
	if (health.status === "degraded") {
		return "Hermes is partially available; writes are disabled until recheck succeeds.";
	}
	if (health.status === "starting") {
		return "Hermes is starting. Recheck before editing board tasks.";
	}
	return HERMES_WRITE_BLOCKED_MESSAGE;
}

export function isHermesManagedTask(task: TaskInfo): boolean {
	return getHermesTaskIdentity(task) !== null;
}

export function getHermesManagedCreationBoard(input: {
	projects?: unknown;
	tags?: unknown;
}): string | null {
	const hasHermesTag = splitHermesList(input.tags).includes("hermes-kanban");
	for (const project of splitHermesList(input.projects)) {
		const board = normalizeHermesBoardValue(project);
		if (board && (hasHermesTag || project.startsWith("Hermes/"))) {
			return board;
		}
	}
	return null;
}

function connectedFallbackHealth(): HermesAvailabilityHealth {
	return {
		status: "connected",
		mode: "live",
		rootUrl: "",
		apiUrl: "",
		canStart: false,
	};
}
