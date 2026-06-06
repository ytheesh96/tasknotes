import { HermesKanbanApiClient, type HermesCreateTaskPayload, type HermesTaskRecord } from "./hermesApiClient";

export type HermesKanbanTransportMode = "dashboard-api" | "kanban-cli";

export interface HermesKanbanTaskCreator {
	createTask(board: string, payload: HermesCreateTaskPayload): Promise<HermesTaskRecord>;
}

interface ExecFileError extends Error {
	code?: string | number;
}

interface ExecFileOptions {
	shell: false;
	windowsHide: true;
	maxBuffer: number;
	timeout: number;
}

type ExecFileCallback = (error: ExecFileError | null, stdout: string, stderr: string) => void;
type ExecFileFn = (
	command: string,
	args: string[],
	options: ExecFileOptions,
	callback: ExecFileCallback
) => void;

export interface HermesKanbanCliClientDeps {
	execFile?: ExecFileFn;
	hermesCommand?: string;
}

export class HermesKanbanCliError extends Error {
	constructor(
		message: string,
		readonly exitCode?: string | number
	) {
		super(message);
		this.name = "HermesKanbanCliError";
	}
}

export class HermesKanbanCliClient implements HermesKanbanTaskCreator {
	private readonly execFile: ExecFileFn;
	private readonly hermesCommands: string[];

	constructor(deps: HermesKanbanCliClientDeps = {}) {
		this.execFile = deps.execFile ?? defaultExecFile;
		this.hermesCommands = deps.hermesCommand ? [deps.hermesCommand] : hermesCommandCandidates();
	}

	async createTask(board: string, payload: HermesCreateTaskPayload): Promise<HermesTaskRecord> {
		const stdout = await this.runHermes(this.createTaskArgs(board, payload));
		return parseTask(stdout, "create task");
	}

	private createTaskArgs(board: string, payload: HermesCreateTaskPayload): string[] {
		const args = ["kanban", "--board", board, "create", payload.title];
		appendStringFlag(args, "--body", payload.body);
		if (payload.triage ?? true) {
			args.push("--triage");
		}
		appendStringFlag(args, "--assignee", payload.assignee);
		appendStringFlag(args, "--tenant", payload.tenant);
		appendNumberFlag(args, "--priority", payload.priority);
		appendWorkspaceFlag(args, payload);
		for (const parent of payload.parents ?? []) {
			appendStringFlag(args, "--parent", parent);
		}
		appendStringFlag(args, "--idempotency-key", payload.idempotency_key);
		appendStringFlag(args, "--created-by", payload.created_by);
		appendStringFlag(args, "--initial-status", payload.initial_status);
		for (const skill of payload.skills ?? []) {
			appendStringFlag(args, "--skill", skill);
		}
		args.push("--json");
		return args;
	}

	private async runHermes(args: string[]): Promise<string> {
		let lastMissingBinaryError: HermesKanbanCliError | null = null;
		for (const command of this.hermesCommands) {
			try {
				return await this.runHermesCommand(command, args);
			} catch (error) {
				if (error instanceof HermesKanbanCliError && error.exitCode === "ENOENT") {
					lastMissingBinaryError = error;
					continue;
				}
				throw error;
			}
		}
		throw lastMissingBinaryError ?? new HermesKanbanCliError("Hermes Kanban CLI executable not found: hermes", "ENOENT");
	}

	private runHermesCommand(command: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			this.execFile(
				command,
				args,
				{ shell: false, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15000 },
				(error, stdout, stderr) => {
					if (error) {
						reject(toCliError(error, stderr, command));
						return;
					}
					resolve(stdout);
				}
			);
		});
	}
}

export function createHermesKanbanClient(
	mode: HermesKanbanTransportMode = "dashboard-api"
): HermesKanbanTaskCreator {
	return mode === "kanban-cli" ? new HermesKanbanCliClient() : new HermesKanbanApiClient();
}

function hermesCommandCandidates(): string[] {
	return uniqueNonEmpty([
		process.env.HERMES_EXECUTABLE,
		"hermes",
		"/Users/yt/.hermes/hermes-agent/venv/bin/hermes",
		"/opt/homebrew/bin/hermes",
		"/usr/local/bin/hermes",
	]);
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

function appendStringFlag(args: string[], flag: string, value: string | null | undefined): void {
	const trimmed = value?.trim();
	if (!trimmed) return;
	args.push(flag, trimmed);
}

function appendNumberFlag(args: string[], flag: string, value: number | null | undefined): void {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	args.push(flag, String(value));
}

function appendWorkspaceFlag(args: string[], payload: HermesCreateTaskPayload): void {
	const kind = payload.workspace_kind?.trim();
	if (!kind) return;
	if (kind === "scratch" || kind === "worktree") {
		args.push("--workspace", payload.workspace_path ? `${kind}:${payload.workspace_path}` : kind);
		return;
	}
	if (kind === "dir") {
		args.push("--workspace", payload.workspace_path ? `dir:${payload.workspace_path}` : "dir");
	}
}

function parseTask(stdout: string, action: string): HermesTaskRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout || "null");
	} catch (error) {
		throw new HermesKanbanCliError(
			`Hermes Kanban CLI returned invalid JSON for ${action}: ${errorMessage(error)}`
		);
	}
	const task = unwrapTaskRecord(parsed);
	if (!task) {
		throw new HermesKanbanCliError(`Hermes Kanban CLI did not return a task for ${action}`);
	}
	return task;
}

function unwrapTaskRecord(value: unknown): HermesTaskRecord | null {
	if (isHermesTaskRecord(value)) {
		return value;
	}
	if (value !== null && typeof value === "object") {
		const maybeTask = (value as { task?: unknown }).task;
		if (isHermesTaskRecord(maybeTask)) {
			return maybeTask;
		}
	}
	return null;
}

function isHermesTaskRecord(value: unknown): value is HermesTaskRecord {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { id?: unknown }).id === "string" &&
		typeof (value as { title?: unknown }).title === "string" &&
		typeof (value as { status?: unknown }).status === "string"
	);
}

function toCliError(error: ExecFileError, stderr: string, hermesCommand = "hermes"): HermesKanbanCliError {
	if (error.code === "ENOENT") {
		return new HermesKanbanCliError(
			`Hermes Kanban CLI executable not found: ${hermesCommand}`,
			error.code
		);
	}
	const detail = sanitizeCliText(stderr) || sanitizeCliText(error.message) || "request failed";
	return new HermesKanbanCliError(
		`Hermes Kanban CLI failed (exit ${error.code ?? "unknown"}): ${detail}`,
		error.code
	);
}

function sanitizeCliText(value: string): string {
	return redactSecrets(
		stripControlCharacters(stripAnsiEscapes(value))
			.replace(/\s+/g, " ")
			.trim()
	).slice(0, 500);
}

function stripAnsiEscapes(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) !== 27) {
			result += value[index];
			continue;
		}
		if (value[index + 1] === "[") {
			index += 2;
			while (index < value.length) {
				const code = value.charCodeAt(index);
				if (code >= 64 && code <= 126) break;
				index += 1;
			}
		}
	}
	return result;
}

function stripControlCharacters(value: string): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127 ? " " : character;
	}).join("");
}

function redactSecrets(value: string): string {
	return value.replace(
		/\b(api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*([^\s]+)/gi,
		(_match, key) => `${key}=[redacted]`
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

function defaultExecFile(
	command: string,
	args: string[],
	options: ExecFileOptions,
	callback: ExecFileCallback
): void {
	// Lazy-load Node child_process so mobile/browser contexts can import this module safely.
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules -- desktop-only Hermes CLI transport requires Node child_process.
	const childProcess = require("child_process") as { execFile: ExecFileFn };
	childProcess.execFile(command, args, options, callback);
}
