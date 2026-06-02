import { Platform } from "obsidian";
import { HermesKanbanApiClient, type HermesAssigneeRecord, type HermesBoardRecord } from "./hermesApiClient";

export const HERMES_DASHBOARD_HOST = "127.0.0.1";
export const HERMES_DASHBOARD_PORT = 9119;
export const HERMES_DASHBOARD_ROOT_URL = `http://${HERMES_DASHBOARD_HOST}:${HERMES_DASHBOARD_PORT}/`;
export const HERMES_KANBAN_API_URL = `${HERMES_DASHBOARD_ROOT_URL}api/plugins/kanban`;
export const HERMES_DASHBOARD_START_COMMAND =
	"hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui";
export const HERMES_STATUS_OPTIONS = ["triage", "todo", "running", "blocked", "done"];

export type HermesAvailabilityStatus = "connected" | "degraded" | "disconnected" | "starting";
export type HermesAvailabilityMode = "live" | "cache-only" | "read-only";

export interface HermesAvailabilityHealth {
	status: HermesAvailabilityStatus;
	mode: HermesAvailabilityMode;
	rootUrl: string;
	apiUrl: string;
	canStart: boolean;
	message?: string;
	warning?: string;
	rootStatus?: number;
}

export interface HermesAvailabilityOptions {
	boards: string[];
	assignees: string[];
	statuses: string[];
	health: HermesAvailabilityHealth;
}

export interface HermesStartupErrorData {
	code: "startup-unavailable" | "startup-failed";
	message: string;
	action: string;
}

export interface HermesDashboardStartResult {
	started: boolean;
	pid?: number;
	command: string;
	health: HermesAvailabilityHealth;
	message?: string;
	error?: HermesStartupErrorData;
}

interface HermesRequestResponse {
	ok: boolean;
	status: number;
	text?: string;
}

interface HermesAvailabilityKanbanClient {
	checkRoot?(): Promise<HermesRequestResponse>;
	listBoards(): Promise<HermesBoardRecord[]>;
	listAssignees(board?: string): Promise<HermesAssigneeRecord[]>;
}

interface SpawnedDashboardProcess {
	pid?: number;
}

interface ChildProcessModuleLike {
	spawn(command: string, args: string[], options: { detached: boolean; stdio: "ignore" }): SpawnedDashboardProcess & {
		unref?: () => void;
	};
}

export interface HermesAvailabilityServiceDeps {
	request?: (url: string) => Promise<HermesRequestResponse>;
	kanbanClient?: HermesAvailabilityKanbanClient;
	spawnDashboard?: (command: string, args: string[]) => Promise<SpawnedDashboardProcess>;
	detectDashboardProcessCount?: () => Promise<number | null>;
	isStartupAvailable?: () => boolean;
}

export class HermesAvailabilityService {
	constructor(private readonly deps: HermesAvailabilityServiceDeps = {}) {}

	async checkHealth(): Promise<HermesAvailabilityHealth> {
		const canStart = this.canStartDashboard();
		const base = this.baseHealth(canStart);

		let rootResponse: HermesRequestResponse;
		try {
			rootResponse = await this.requestRoot();
		} catch {
			return {
				...base,
				status: "disconnected",
				mode: canStart ? "cache-only" : "read-only",
				message: `Hermes dashboard is not reachable at ${HERMES_DASHBOARD_ROOT_URL}.`,
			};
		}

		if (!rootResponse.ok) {
			return {
				...base,
				status: "disconnected",
				mode: canStart ? "cache-only" : "read-only",
				rootStatus: rootResponse.status,
				message: `Hermes dashboard returned HTTP ${rootResponse.status} at ${HERMES_DASHBOARD_ROOT_URL}.`,
			};
		}

		try {
			await this.client().listBoards();
		} catch {
			return {
				...base,
				status: "degraded",
				mode: "cache-only",
				rootStatus: rootResponse.status,
				message: "Hermes dashboard root is reachable, but the Kanban API is unavailable.",
			};
		}

		const processCount = await this.detectDashboardProcessCount();
		return {
			...base,
			status: "connected",
			mode: "live",
			warning:
				processCount !== null && processCount > 1
					? "Multiple Hermes dashboard processes detected; using healthy localhost:9119."
					: undefined,
		};
	}

	async recheckHealth(): Promise<HermesAvailabilityHealth> {
		return this.checkHealth();
	}

	async getOptions(board?: string): Promise<HermesAvailabilityOptions> {
		const health = await this.checkHealth();
		if (health.status !== "connected") {
			return {
				boards: [],
				assignees: [],
				statuses: [...HERMES_STATUS_OPTIONS],
				health,
			};
		}

		const [boards, assignees] = await Promise.all([
			this.client().listBoards(),
			this.client().listAssignees(board),
		]);
		return {
			boards: boards.filter((boardRecord) => !boardRecord.archived).map((boardRecord) => boardRecord.slug),
			assignees: assignees.map((assignee) => assignee.name).filter(Boolean),
			statuses: [...HERMES_STATUS_OPTIONS],
			health,
		};
	}

	async startDashboard(): Promise<HermesDashboardStartResult> {
		const currentHealth = await this.checkHealth();
		if (currentHealth.status === "connected") {
			return {
				started: false,
				command: HERMES_DASHBOARD_START_COMMAND,
				health: currentHealth,
				message: "Hermes dashboard is already running on localhost:9119.",
			};
		}

		if (currentHealth.status === "degraded") {
			return {
				started: false,
				command: HERMES_DASHBOARD_START_COMMAND,
				health: currentHealth,
				message:
					"Hermes dashboard is already reachable on localhost:9119, but the Kanban API is unavailable. Recheck health after resolving the API failure.",
			};
		}

		if (!currentHealth.canStart) {
			return {
				started: false,
				command: HERMES_DASHBOARD_START_COMMAND,
				health: currentHealth,
				error: startupUnavailableError(),
			};
		}

		try {
			const process = await this.spawnDashboard();
			const health = await this.healthAfterStart(process.pid);
			return {
				started: true,
				pid: process.pid,
				command: HERMES_DASHBOARD_START_COMMAND,
				health,
			};
		} catch (error) {
			return {
				started: false,
				command: HERMES_DASHBOARD_START_COMMAND,
				health: currentHealth,
				error: {
					code: "startup-failed",
					message: errorMessage(error),
					action: `Run ${HERMES_DASHBOARD_START_COMMAND} from a local terminal, then recheck health.`,
				},
			};
		}
	}

	private async healthAfterStart(pid: number | undefined): Promise<HermesAvailabilityHealth> {
		const health = await this.checkHealth();
		if (health.status === "disconnected") {
			return {
				...health,
				status: "starting",
				mode: "cache-only",
				message: pid
					? `Hermes dashboard process ${pid} started; waiting for localhost:9119 to become reachable.`
					: "Hermes dashboard start command ran; waiting for localhost:9119 to become reachable.",
			};
		}
		return health;
	}

	private baseHealth(canStart: boolean): Pick<HermesAvailabilityHealth, "rootUrl" | "apiUrl" | "canStart"> {
		return {
			rootUrl: HERMES_DASHBOARD_ROOT_URL,
			apiUrl: HERMES_KANBAN_API_URL,
			canStart,
		};
	}

	private async requestRoot(): Promise<HermesRequestResponse> {
		const request = this.deps.request ?? defaultRequest;
		return request(HERMES_DASHBOARD_ROOT_URL);
	}

	private client(): HermesAvailabilityKanbanClient {
		return this.deps.kanbanClient ?? new HermesKanbanApiClient(HERMES_KANBAN_API_URL);
	}

	private canStartDashboard(): boolean {
		return this.deps.isStartupAvailable?.() ?? (Boolean(Platform.isDesktop) && !Platform.isMobile);
	}

	private async spawnDashboard(): Promise<SpawnedDashboardProcess> {
		if (this.deps.spawnDashboard) {
			return this.deps.spawnDashboard("hermes", dashboardStartArgs());
		}
		return defaultSpawnDashboard("hermes", dashboardStartArgs());
	}

	private async detectDashboardProcessCount(): Promise<number | null> {
		if (this.deps.detectDashboardProcessCount) {
			return this.deps.detectDashboardProcessCount();
		}
		return null;
	}
}

async function defaultRequest(url: string): Promise<HermesRequestResponse> {
	return new HermesKanbanApiClient(`${url.replace(/\/$/, "")}/api/plugins/kanban`).checkRoot();
}

async function defaultSpawnDashboard(command: string, args: string[]): Promise<SpawnedDashboardProcess> {
	// Lazy-load Node child_process so mobile/browser contexts can import this module safely.
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules -- desktop-only Hermes startup requires Node child_process.
	const childProcess = require("child_process") as ChildProcessModuleLike;
	const process = childProcess.spawn(command, args, { detached: true, stdio: "ignore" });
	process.unref?.();
	return { pid: process.pid };
}

function dashboardStartArgs(): string[] {
	return ["dashboard", "--host", HERMES_DASHBOARD_HOST, "--port", String(HERMES_DASHBOARD_PORT), "--no-open", "--skip-build", "--tui"];
}

function startupUnavailableError(): HermesStartupErrorData {
	return {
		code: "startup-unavailable",
		message: "Starting Hermes is only available in Obsidian desktop with Node child_process access.",
		action: `Run ${HERMES_DASHBOARD_START_COMMAND} from a local terminal, then recheck health.`,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}
