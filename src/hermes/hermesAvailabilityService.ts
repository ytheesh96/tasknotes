import { Platform } from "obsidian";
import { HermesKanbanApiClient, type HermesAssigneeRecord, type HermesBoardRecord } from "./hermesApiClient";

export const HERMES_DASHBOARD_HOST = "127.0.0.1";
export const HERMES_DASHBOARD_PORT = 9119;
export const HERMES_DASHBOARD_ROOT_URL = `http://${HERMES_DASHBOARD_HOST}:${HERMES_DASHBOARD_PORT}/`;
export const HERMES_KANBAN_API_URL = `${HERMES_DASHBOARD_ROOT_URL}api/plugins/kanban`;
export const HERMES_DASHBOARD_START_COMMAND =
	"hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build";
export const HERMES_STATUS_OPTIONS = ["triage", "todo", "running", "blocked", "done"];

export type HermesAvailabilityStatus = "connected" | "degraded" | "disconnected" | "starting";
export type HermesAvailabilityMode = "live" | "cache-only" | "read-only";
export type HermesKanbanTransport = "dashboard-api" | "kanban-cli";
export type HermesWriteAvailabilityStatus =
	| "writable-via-dashboard"
	| "writable-via-cli"
	| "dashboard-unavailable"
	| "cli-unavailable"
	| "board-unavailable";

export interface HermesAvailabilityHealth {
	status: HermesAvailabilityStatus;
	mode: HermesAvailabilityMode;
	rootUrl: string;
	apiUrl: string;
	canStart: boolean;
	transport?: HermesKanbanTransport;
	writeStatus?: HermesWriteAvailabilityStatus;
	message?: string;
	warning?: string;
	rootStatus?: number;
}

export interface HermesAvailabilityCheckOptions {
	transport?: HermesKanbanTransport;
	board?: string;
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

export interface HermesDashboardStartOptions {
	env?: Record<string, string | undefined>;
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

interface SpawnedDashboardChildProcess extends SpawnedDashboardProcess {
	on?(event: "error", listener: (error: Error) => void): this;
	on?(event: "spawn", listener: () => void): this;
	unref?: () => void;
}

interface HermesExecutableCheckResult {
	available: boolean;
	command?: string;
	message?: string;
}

interface HermesKanbanBoardValidationResult {
	available: boolean;
	message?: string;
}

interface ChildProcessModuleLike {
	spawn(
		command: string,
		args: string[],
		options: { detached: boolean; stdio: "ignore"; env?: Record<string, string | undefined> }
	): SpawnedDashboardChildProcess;
}

export interface HermesAvailabilityServiceDeps {
	transport?: HermesKanbanTransport;
	request?: (url: string) => Promise<HermesRequestResponse>;
	kanbanClient?: HermesAvailabilityKanbanClient;
	checkHermesExecutable?: () => Promise<HermesExecutableCheckResult>;
	validateKanbanBoard?: (
		board: string,
		command: string
	) => Promise<HermesKanbanBoardValidationResult>;
	spawnDashboard?: (
		command: string,
		args: string[],
		options?: HermesDashboardStartOptions
	) => Promise<SpawnedDashboardProcess>;
	detectDashboardProcessCount?: () => Promise<number | null>;
	isStartupAvailable?: () => boolean;
}

export class HermesAvailabilityService {
	constructor(private readonly deps: HermesAvailabilityServiceDeps = {}) {}

	async checkHealth(options: HermesAvailabilityCheckOptions = {}): Promise<HermesAvailabilityHealth> {
		const transport = options.transport ?? this.deps.transport ?? "dashboard-api";
		if (transport === "kanban-cli") {
			return this.checkCliHealth(options.board);
		}
		return this.checkDashboardApiHealth();
	}

	private async checkDashboardApiHealth(): Promise<HermesAvailabilityHealth> {
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
				writeStatus: "dashboard-unavailable",
				message: `Hermes dashboard is not reachable at ${HERMES_DASHBOARD_ROOT_URL}.`,
			};
		}

		if (!rootResponse.ok) {
			return {
				...base,
				status: "disconnected",
				mode: canStart ? "cache-only" : "read-only",
				writeStatus: "dashboard-unavailable",
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
				writeStatus: "dashboard-unavailable",
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

	async recheckHealth(options: HermesAvailabilityCheckOptions = {}): Promise<HermesAvailabilityHealth> {
		return this.checkHealth(options);
	}

	async getOptions(
		board?: string,
		options: HermesAvailabilityCheckOptions = {}
	): Promise<HermesAvailabilityOptions> {
		const normalizedBoard = board?.trim() || options.board?.trim();
		const health = await this.checkHealth({ ...options, board: normalizedBoard });
		if (health.status !== "connected") {
			return {
				boards: [],
				assignees: [],
				statuses: [...HERMES_STATUS_OPTIONS],
				health,
			};
		}
		if (health.transport === "kanban-cli") {
			return {
				boards: normalizedBoard ? [normalizedBoard] : [],
				assignees: [],
				statuses: [...HERMES_STATUS_OPTIONS],
				health,
			};
		}

		const [boards, assignees] = await Promise.all([
			this.client().listBoards(),
			this.client().listAssignees(normalizedBoard),
		]);
		return {
			boards: boards.filter((boardRecord) => !boardRecord.archived).map((boardRecord) => boardRecord.slug),
			assignees: assignees.map((assignee) => assignee.name).filter(Boolean),
			statuses: [...HERMES_STATUS_OPTIONS],
			health,
		};
	}

	async startDashboard(
		commandLine = HERMES_DASHBOARD_START_COMMAND,
		options: HermesDashboardStartOptions = {}
	): Promise<HermesDashboardStartResult> {
		const startCommand = normalizeHermesDashboardStartCommand(commandLine);
		const currentHealth = await this.checkHealth();
		if (currentHealth.status === "connected") {
			return {
				started: false,
				command: startCommand,
				health: currentHealth,
				message: "Hermes dashboard is already running on localhost:9119.",
			};
		}

		if (currentHealth.status === "degraded") {
			return {
				started: false,
				command: startCommand,
				health: currentHealth,
				message:
					"Hermes dashboard is already reachable on localhost:9119, but the Kanban API is unavailable. Recheck health after resolving the API failure.",
			};
		}

		if (!currentHealth.canStart) {
			return {
				started: false,
				command: startCommand,
				health: currentHealth,
				error: startupUnavailableError(startCommand),
			};
		}

		try {
			const process = await this.spawnDashboard(startCommand, options);
			const health = await this.healthAfterStart(process.pid);
			return {
				started: true,
				pid: process.pid,
				command: startCommand,
				health,
			};
		} catch (error) {
			return {
				started: false,
				command: startCommand,
				health: currentHealth,
				error: {
					code: "startup-failed",
					message: errorMessage(error),
					action: `Run ${startCommand} from a local terminal, then recheck health.`,
				},
			};
		}
	}

	private async checkCliHealth(board: string | undefined): Promise<HermesAvailabilityHealth> {
		const base = { ...this.baseHealth(false), transport: "kanban-cli" as const };
		const executable = await this.checkHermesExecutable();
		if (!executable.available || !executable.command) {
			return {
				...base,
				status: "disconnected",
				mode: "read-only",
				writeStatus: "cli-unavailable",
				message: executable.message ?? "Hermes CLI is unavailable; install Hermes or configure HERMES_EXECUTABLE.",
			};
		}

		const normalizedBoard = board?.trim();
		if (!normalizedBoard) {
			return {
				...base,
				status: "degraded",
				mode: "read-only",
				writeStatus: "board-unavailable",
				message: "Choose a Hermes board before writing through the CLI.",
			};
		}

		const boardValidation = await this.validateKanbanBoard(normalizedBoard, executable.command);
		if (!boardValidation.available) {
			return {
				...base,
				status: "degraded",
				mode: "read-only",
				writeStatus: "board-unavailable",
				message:
					boardValidation.message ??
					`Hermes board ${normalizedBoard} is not available through the CLI.`,
			};
		}

		return {
			...base,
			status: "connected",
			mode: "live",
			writeStatus: "writable-via-cli",
			message: `Hermes Kanban CLI is available for board ${normalizedBoard}.`,
		};
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

	private async checkHermesExecutable(): Promise<HermesExecutableCheckResult> {
		if (this.deps.checkHermesExecutable) {
			return this.deps.checkHermesExecutable();
		}
		return defaultCheckHermesExecutable();
	}

	private async validateKanbanBoard(
		board: string,
		command: string
	): Promise<HermesKanbanBoardValidationResult> {
		if (this.deps.validateKanbanBoard) {
			return this.deps.validateKanbanBoard(board, command);
		}
		return defaultValidateKanbanBoard(board, command);
	}

	private canStartDashboard(): boolean {
		return this.deps.isStartupAvailable?.() ?? (Boolean(Platform.isDesktop) && !Platform.isMobile);
	}

	private async spawnDashboard(
		commandLine: string,
		options: HermesDashboardStartOptions
	): Promise<SpawnedDashboardProcess> {
		const parsed = parseHermesDashboardStartCommand(commandLine);
		if (this.deps.spawnDashboard) {
			if (hasSpawnEnv(options)) {
				return this.deps.spawnDashboard(parsed.command, parsed.args, options);
			}
			return this.deps.spawnDashboard(parsed.command, parsed.args);
		}
		return defaultSpawnDashboard(parsed.command, parsed.args, options);
	}

	private async detectDashboardProcessCount(): Promise<number | null> {
		if (this.deps.detectDashboardProcessCount) {
			return this.deps.detectDashboardProcessCount();
		}
		return null;
	}
}

interface ParsedHermesDashboardStartCommand {
	command: string;
	args: string[];
}

export function normalizeHermesDashboardStartCommand(commandLine?: string): string {
	const trimmed = commandLine?.trim();
	return trimmed || HERMES_DASHBOARD_START_COMMAND;
}

export function parseHermesDashboardStartCommand(
	commandLine: string
): ParsedHermesDashboardStartCommand {
	const parts = splitCommandLine(normalizeHermesDashboardStartCommand(commandLine));
	const command = parts[0];
	if (!command) {
		throw new Error("Hermes start command is empty.");
	}
	return {
		command,
		args: parts.slice(1),
	};
}

async function defaultRequest(url: string): Promise<HermesRequestResponse> {
	return new HermesKanbanApiClient(`${url.replace(/\/$/, "")}/api/plugins/kanban`).checkRoot();
}

async function defaultCheckHermesExecutable(): Promise<HermesExecutableCheckResult> {
	let sawExecutableEnv = false;
	for (const candidate of hermesExecutableCandidates("hermes")) {
		sawExecutableEnv = sawExecutableEnv || candidate === process.env.HERMES_EXECUTABLE?.trim();
		try {
			await execFileUtf8(candidate, ["--version"]);
			return { available: true, command: candidate };
		} catch (error) {
			if (!isSpawnEnoent(error)) {
				return {
					available: false,
					message: `Hermes CLI is not executable: ${sanitizeCliError(error)}.`,
				};
			}
		}
	}
	return {
		available: false,
		message: sawExecutableEnv
			? "Hermes CLI is not available from HERMES_EXECUTABLE or PATH."
			: "Hermes CLI is not available on PATH.",
	};
}

async function defaultValidateKanbanBoard(
	board: string,
	command: string
): Promise<HermesKanbanBoardValidationResult> {
	try {
		await execFileUtf8(command, ["kanban", "--board", board, "list", "--json"]);
		return { available: true };
	} catch (error) {
		return {
			available: false,
			message: `Hermes board ${board} is not available through the CLI: ${sanitizeCliError(error)}.`,
		};
	}
}

async function defaultSpawnDashboard(
	command: string,
	args: string[],
	options: HermesDashboardStartOptions
): Promise<SpawnedDashboardProcess> {
	// Lazy-load Node child_process so mobile/browser contexts can import this module safely.
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules -- desktop-only Hermes startup requires Node child_process.
	const childProcess = require("child_process") as ChildProcessModuleLike;
	let lastError: unknown;
	const candidates = shouldUseHermesExecutableCandidates(command)
		? hermesExecutableCandidates(command)
		: [command];
	for (const candidate of candidates) {
		try {
			return await spawnDashboardProcess(childProcess, candidate, args, options);
		} catch (error) {
			lastError = error;
			if (!isSpawnEnoent(error)) {
				throw error;
			}
		}
	}
	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error(`Unable to start ${command}`);
}

function hermesExecutableCandidates(command: string): string[] {
	const home = process.env.HOME?.trim();
	return [
		process.env.HERMES_EXECUTABLE?.trim(),
		command,
		home ? `${home}/.local/bin/hermes` : undefined,
		home ? `${home}/.hermes/hermes-agent/venv/bin/hermes` : undefined,
		"/opt/homebrew/bin/hermes",
		"/usr/local/bin/hermes",
	].filter((candidate): candidate is string => Boolean(candidate));
}

function shouldUseHermesExecutableCandidates(command: string): boolean {
	return command === "hermes";
}

function spawnDashboardProcess(
	childProcess: ChildProcessModuleLike,
	command: string,
	args: string[],
	options: HermesDashboardStartOptions
): Promise<SpawnedDashboardProcess> {
	return new Promise((resolve, reject) => {
		const process = childProcess.spawn(command, args, spawnOptions(options));
		let settled = false;
		process.on?.("error", (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		process.on?.("spawn", () => {
			if (!settled) {
				settled = true;
				process.unref?.();
				resolve({ pid: process.pid });
			}
		});
		if (!process.on) {
			process.unref?.();
			resolve({ pid: process.pid });
		}
	});
}

function execFileUtf8(command: string, args: string[]): Promise<string> {
	// Lazy-load Node child_process so mobile/browser contexts can import this module safely.
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules -- desktop-only CLI probing requires Node child_process.
	const childProcess = require("child_process") as {
		execFile: (
			command: string,
			args: string[],
			options: { encoding: "utf8"; timeout: number; windowsHide: boolean },
			callback: (error: Error | null, stdout: string, stderr: string) => void
		) => void;
	};
	return new Promise((resolve, reject) => {
		childProcess.execFile(
			command,
			args,
			{ encoding: "utf8", timeout: 5000, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					reject(Object.assign(error, { stderr }));
					return;
				}
				resolve(stdout);
			}
		);
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeCliError(error: unknown): string {
	const stderrValue =
		typeof error === "object" && error !== null && "stderr" in error ? error.stderr : undefined;
	const stderr = typeof stderrValue === "string" ? stderrValue : "";
	const raw = stderr.trim() || errorMessage(error);
	const home = process.env.HOME?.trim();
	const sanitized = raw
		.replace(/([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*=)\S+/gi, "$1[redacted]")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(home ? new RegExp(escapeRegExp(home), "g") : /\b\B/g, "~")
		.replace(/\/Users\/[^\s:]+/g, "[path]")
		.split(/\r?\n/)[0]
		.trim();
	return sanitized.slice(0, 240) || "command failed";
}

function spawnOptions(
	options: HermesDashboardStartOptions
): { detached: boolean; stdio: "ignore"; env?: Record<string, string | undefined> } {
	const base = { detached: true, stdio: "ignore" as const };
	if (!hasSpawnEnv(options)) {
		return base;
	}
	const extraEnv = Object.fromEntries(
		Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => {
			const [, value] = entry;
			return typeof value === "string" && value.length > 0;
		})
	);
	return {
		...base,
		env: {
			...process.env,
			...extraEnv,
		},
	};
}

function hasSpawnEnv(options: HermesDashboardStartOptions): boolean {
	return Object.values(options.env ?? {}).some(
		(value) => typeof value === "string" && value.length > 0
	);
}

function isSpawnEnoent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function startupUnavailableError(commandLine: string): HermesStartupErrorData {
	return {
		code: "startup-unavailable",
		message: "Starting Hermes is only available in Obsidian desktop with Node child_process access.",
		action: `Run ${commandLine} from a local terminal, then recheck health.`,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

function splitCommandLine(commandLine: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of commandLine) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}
		if (quote === char) {
			quote = null;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) {
		current += "\\";
	}
	if (quote) {
		throw new Error("Hermes start command has an unterminated quote.");
	}
	if (current) {
		parts.push(current);
	}
	return parts;
}
