import { requestUrl } from "obsidian";
import type { TaskInfo } from "../types";
import {
	readHermesBoardFrontmatter,
	readHermesTaskIdFrontmatter,
} from "./hermesCanonicalTaskNotes";

const DEFAULT_HERMES_KANBAN_API_BASE = "http://127.0.0.1:9119/api/plugins/kanban";
const TASKNOTES_CANONICAL_BOARD_TASK_PATH = /^TaskNotes\/Tasks\/(.+)--(t_[^/]+)\.md$/;
const TASKNOTES_LEGACY_UNQUALIFIED_TASK_PATH = /^TaskNotes\/Tasks\/(t_[^/]+)\.md$/;
const TASKNOTES_LEGACY_BOARD_TASK_PATH = /^TaskNotes\/([^/]+)\/(t_[^/]+)\.md$/;
const RESERVED_TASKNOTES_FOLDERS = new Set(["Activity", "Hermes", "Tasks", "Views"]);

interface HermesHttpResponse {
	ok: boolean;
	status: number;
	statusText?: string;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
}

export interface HermesTaskRecord {
	id: string;
	title: string;
	body?: string | null;
	status: string;
	assignee?: string | null;
	priority?: number | null;
	tenant?: string | null;
	run_id?: string | null;
	root_run_id?: string | null;
	run_title?: string | null;
	run_type?: string | null;
	run_assignment_source?: string | null;
	created_by?: string | null;
	workspace_kind?: string | null;
	workspace_path?: string | null;
	branch_name?: string | null;
	result?: string | null;
	latest_summary?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface HermesTaskIdentity {
	board: string;
	id: string;
}

export class HermesApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly statusText?: string
	) {
		super(message);
		this.name = "HermesApiError";
	}
}

export interface HermesBoardRecord {
	slug: string;
	name?: string | null;
	archived?: boolean | null;
}

export interface HermesAssigneeRecord {
	name: string;
	on_disk?: boolean | null;
	counts?: Record<string, number>;
}

export interface HermesBoardsResponse {
	boards?: HermesBoardRecord[];
}

export interface HermesBoardResponse {
	board?: HermesBoardRecord;
}

export interface HermesBoardTaskColumn {
	name: string;
	tasks: HermesTaskRecord[];
}

export interface HermesRunLaneColumn {
	name: string;
	tasks: HermesTaskRecord[];
	count?: number | null;
}

export interface HermesRunLaneRecord {
	id: string;
	title?: string | null;
	run_type?: string | null;
	status?: string | null;
	counts?: Record<string, number> | null;
	columns?: HermesRunLaneColumn[];
}

export interface HermesBoardStateResponse {
	columns?: HermesBoardTaskColumn[];
	run_lanes?: HermesRunLaneRecord[];
	latest_event_id?: number;
}

export interface HermesAssigneesResponse {
	assignees?: HermesAssigneeRecord[];
}

export interface HermesRootHealthResponse {
	ok: boolean;
	status: number;
	text: string;
}

export interface HermesCreateTaskPayload {
	title: string;
	body?: string;
	status?: string;
	assignee?: string;
	tenant?: string;
	priority?: number;
	created_by?: string;
	workspace_kind?: string;
	workspace_path?: string;
	parents?: string[];
	triage?: boolean;
	initial_status?: "running" | "blocked";
	block_reason?: string;
	idempotency_key?: string;
	skills?: string[];
}

export interface HermesUpdateTaskPayload {
	status?: string;
	assignee?: string | null;
	priority?: number;
	title?: string;
	body?: string;
	result?: string;
	block_reason?: string;
	summary?: string;
	metadata?: Record<string, unknown>;
}

export interface HermesAssignTaskRunPayload {
	runId: string | null;
	source?: string;
	actor?: string;
	force?: boolean;
}

export interface HermesCommentPayload {
	body: string;
	author?: string;
}

export interface HermesCreateBoardPayload {
	slug: string;
	name?: string;
	description?: string;
	icon?: string;
	color?: string;
	switch?: boolean;
}

export interface HermesTaskResponse {
	task: HermesTaskRecord | null;
}

export interface HermesTaskDetailResponse extends HermesTaskResponse {
	comments?: unknown[];
	events?: unknown[];
	links?: {
		parents?: string[];
		children?: string[];
	};
	runs?: unknown[];
}

export interface HermesLoopHandoffRecord {
	id: number;
	root_task_id: string;
	tenant?: string | null;
	task_id: string;
	run_id?: number | null;
	source_event_id?: number | null;
	handoff_kind: string;
	state: string;
	attention?: string | null;
	verification_state?: string | null;
	verification_status?: string | null;
	worker_profile?: string | null;
	worker_session_id?: string | null;
	originating_session_id?: string | null;
	task_title?: string | null;
	summary?: string | null;
	reason?: string | null;
	artifacts?: string[];
	changed_files?: string[];
	created_cards?: string[];
	review_task_id?: string | null;
	review_run_id?: number | null;
	reviewer_session_id?: string | null;
	review_batch_id?: string | null;
	decision_actor?: string | null;
	decision_reason?: string | null;
	resolution_summary?: string | null;
	auto_actions_log?: unknown[];
	escalation_reason?: string | null;
	escalation_options?: unknown[];
	final_summary_sent_at?: number | null;
	escalation_notified_at?: number | null;
	created_at?: number | null;
	updated_at?: number | null;
	started_at?: number | null;
	completed_at?: number | null;
	resolved_at?: number | null;
}

export interface HermesLoopHandoffsResponse {
	ok?: boolean;
	handoffs?: HermesLoopHandoffRecord[];
}

export interface HermesLoopHandoffStatusResponse {
	tenant: string;
	root_task_id: string;
	pending_count: number;
	active_count: number;
	terminal_count: number;
	total_count: number;
}

export function getHermesTaskIdentity(task: TaskInfo): HermesTaskIdentity | null {
	const frontmatterId = readHermesTaskIdFrontmatter(task.customProperties);
	const frontmatterBoard = readHermesBoardFrontmatter(task.customProperties);
	if (frontmatterId && frontmatterBoard) {
		return { board: frontmatterBoard, id: frontmatterId };
	}

	const boardPathMatch = task.path.match(TASKNOTES_CANONICAL_BOARD_TASK_PATH);
	if (boardPathMatch) {
		return { board: frontmatterBoard ?? boardPathMatch[1], id: frontmatterId ?? boardPathMatch[2] };
	}

	const legacyUnqualifiedPathMatch = task.path.match(TASKNOTES_LEGACY_UNQUALIFIED_TASK_PATH);
	if (legacyUnqualifiedPathMatch && frontmatterBoard) {
		return { board: frontmatterBoard, id: frontmatterId ?? legacyUnqualifiedPathMatch[1] };
	}

	const legacyPathMatch = task.path.match(TASKNOTES_LEGACY_BOARD_TASK_PATH);
	if (legacyPathMatch) {
		if (RESERVED_TASKNOTES_FOLDERS.has(legacyPathMatch[1])) {
			return null;
		}
		return { board: legacyPathMatch[1], id: legacyPathMatch[2] };
	}
	return null;
}

export function isHermesTaskNotFoundError(error: unknown, taskId?: string): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const normalizedMessage = message.toLowerCase();
	const normalizedTaskId = taskId?.toLowerCase();
	const namesTask =
		!normalizedTaskId ||
		normalizedMessage.includes(normalizedTaskId) ||
		/\btask\s+t_[a-z0-9]{8}\s+not\s+found\b/i.test(message);
	if (!namesTask || !normalizedMessage.includes("not found")) {
		return false;
	}
	return error instanceof HermesApiError ? error.status === 404 : true;
}

export class HermesKanbanApiClient {
	private sessionToken: string | null = null;

	constructor(private readonly baseUrl = DEFAULT_HERMES_KANBAN_API_BASE) {}

	async checkRoot(): Promise<HermesRootHealthResponse> {
		const response = await requestUrl({ url: `${new URL(this.baseUrl).origin}/`, throw: false });
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			text: response.text,
		};
	}

	async createTask(board: string, payload: HermesCreateTaskPayload): Promise<HermesTaskRecord> {
		const response = await this.request<HermesTaskResponse>(
			`/tasks?board=${encodeURIComponent(board)}`,
			{
				method: "POST",
				body: JSON.stringify(payload),
			}
		);
		return requireTask(response, "create task");
	}

	async getTask(identity: HermesTaskIdentity): Promise<HermesTaskDetailResponse> {
		return this.request<HermesTaskDetailResponse>(
			`/tasks/${encodeURIComponent(identity.id)}?board=${encodeURIComponent(identity.board)}`
		);
	}

	async getBoard(
		board: string,
		options: {
			includeArchived?: boolean;
			groupBy?: "run";
			runScope?: "root" | "direct";
			runId?: string;
		} = {}
	): Promise<HermesBoardStateResponse> {
		const params = new URLSearchParams({ board });
		if (options.includeArchived) {
			params.set("include_archived", "true");
		}
		if (options.groupBy === "run") {
			params.set("group_by", "run");
			if (options.runScope) {
				params.set("run_scope", options.runScope);
			}
			if (options.runId) {
				params.set("run_id", options.runId);
			}
		}
		return this.request<HermesBoardStateResponse>(`/board?${params.toString()}`);
	}

	async listLoopHandoffs(
		board: string,
		filters: {
			rootTaskId?: string;
			tenant?: string;
			state?: string;
			taskId?: string;
		} = {}
	): Promise<HermesLoopHandoffRecord[]> {
		const params = new URLSearchParams({ board });
		if (filters.rootTaskId) params.set("root_task_id", filters.rootTaskId);
		if (filters.tenant) params.set("tenant", filters.tenant);
		if (filters.state) params.set("state", filters.state);
		if (filters.taskId) params.set("task_id", filters.taskId);
		const response = await this.request<HermesLoopHandoffsResponse>(`/loop-handoffs?${params.toString()}`);
		return Array.isArray(response.handoffs) ? response.handoffs : [];
	}

	async getLoopHandoffStatus(
		board: string,
		params: { tenant: string; rootTaskId: string }
	): Promise<HermesLoopHandoffStatusResponse> {
		const query = new URLSearchParams({
			board,
			status_only: "true",
			tenant: params.tenant,
			root_task_id: params.rootTaskId,
		});
		return this.request<HermesLoopHandoffStatusResponse>(`/loop-handoffs?${query.toString()}`);
	}

	async getEventStreamUrl(board: string, since = 0): Promise<string | null> {
		const token = this.sessionToken ?? (await this.loadSessionToken());
		if (!token) {
			return null;
		}
		this.sessionToken = token;
		const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/events`);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("since", String(Math.max(0, since)));
		url.searchParams.set("token", token);
		url.searchParams.set("board", board);
		return url.toString();
	}

	async updateTask(
		identity: HermesTaskIdentity,
		payload: HermesUpdateTaskPayload
	): Promise<HermesTaskRecord> {
		const response = await this.request<HermesTaskResponse>(
			`/tasks/${encodeURIComponent(identity.id)}?board=${encodeURIComponent(identity.board)}`,
			{
				method: "PATCH",
				body: JSON.stringify(payload),
			}
		);
		return requireTask(response, "update task");
	}

	async assignTaskRun(
		identity: HermesTaskIdentity,
		payload: HermesAssignTaskRunPayload
	): Promise<HermesTaskRecord> {
		const response = await this.request<HermesTaskResponse>(
			`/tasks/${encodeURIComponent(identity.id)}/run?board=${encodeURIComponent(identity.board)}`,
			{
				method: "POST",
				body: JSON.stringify({
					run_id: payload.runId,
					...(payload.source ? { source: payload.source } : {}),
					...(payload.actor ? { actor: payload.actor } : {}),
					...(payload.force ? { force: payload.force } : {}),
				}),
			}
		);
		return requireTask(response, "assign task run");
	}

	async deleteTask(identity: HermesTaskIdentity): Promise<void> {
		await this.request(
			`/tasks/${encodeURIComponent(identity.id)}?board=${encodeURIComponent(identity.board)}`,
			{ method: "DELETE" }
		);
	}

	async addComment(identity: HermesTaskIdentity, payload: HermesCommentPayload): Promise<void> {
		await this.request(
			`/tasks/${encodeURIComponent(identity.id)}/comments?board=${encodeURIComponent(identity.board)}`,
			{
				method: "POST",
				body: JSON.stringify({
					author: "tasknotes",
					...payload,
				}),
			}
		);
	}

	async addLink(identity: { board: string; parentId: string; childId: string }): Promise<void> {
		await this.request(`/links?board=${encodeURIComponent(identity.board)}`, {
			method: "POST",
			body: JSON.stringify({
				parent_id: identity.parentId,
				child_id: identity.childId,
			}),
		});
	}

	async deleteLink(identity: {
		board: string;
		parentId: string;
		childId: string;
	}): Promise<void> {
		const params = new URLSearchParams({
			board: identity.board,
			parent_id: identity.parentId,
			child_id: identity.childId,
		});
		await this.request(`/links?${params.toString()}`, { method: "DELETE" });
	}

	async listBoards(): Promise<HermesBoardRecord[]> {
		const response = await this.request<HermesBoardsResponse>("/boards");
		return Array.isArray(response.boards) ? response.boards : [];
	}

	async createBoard(payload: HermesCreateBoardPayload): Promise<HermesBoardRecord> {
		const response = await this.request<HermesBoardResponse>("/boards", {
			method: "POST",
			body: JSON.stringify(payload),
		});
		return requireBoard(response, "create board");
	}

	async deleteBoard(slug: string, options?: { hardDelete?: boolean }): Promise<void> {
		const params = options?.hardDelete ? "?delete=true" : "";
		await this.request(`/boards/${encodeURIComponent(slug)}${params}`, { method: "DELETE" });
	}

	async listAssignees(board?: string): Promise<HermesAssigneeRecord[]> {
		const params = board ? `?board=${encodeURIComponent(board)}` : "";
		const response = await this.request<HermesAssigneesResponse>(`/assignees${params}`);
		return Array.isArray(response.assignees) ? response.assignees : [];
	}

	private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
		let response = await this.requestOnce(path, init);
		if (response.status === 401 && !this.sessionToken) {
			this.sessionToken = await this.loadSessionToken();
			if (this.sessionToken) {
				response = await this.requestOnce(path, init);
			}
		}

		if (!response.ok) {
			throw new HermesApiError(
				await this.errorMessage(response),
				response.status,
				response.statusText
			);
		}

		return response.json() as Promise<T>;
	}

	private async requestOnce(path: string, init: RequestInit): Promise<HermesHttpResponse> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...headersToRecord(init.headers),
		};
		if (this.sessionToken) {
			headers.Authorization = `Bearer ${this.sessionToken}`;
		}
		const url = `${this.baseUrl}${path}`;
		return this.requestUrlOnce(url, init, headers);
	}

	private async loadSessionToken(): Promise<string | null> {
		const windowToken = getWindowSessionToken();
		if (windowToken) return windowToken;
		const rootUrl = new URL(this.baseUrl).origin;
		try {
			const response = await requestUrl({ url: `${rootUrl}/`, throw: false });
			return response.text.match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1] ?? null;
		} catch {
			return null;
		}
	}

	private async requestUrlOnce(
		url: string,
		init: RequestInit,
		headers: Record<string, string>
	): Promise<HermesHttpResponse> {
		const response = await requestUrl({
			url,
			method: init.method ?? "GET",
			headers,
			body: typeof init.body === "string" ? init.body : undefined,
			throw: false,
		});
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			statusText: "",
			json: async () =>
				response.json !== undefined ? response.json : JSON.parse(response.text || "null"),
			text: async () => response.text,
		};
	}

	private async errorMessage(response: HermesHttpResponse): Promise<string> {
		try {
			const payload = (await response.json()) as { detail?: unknown };
			if (typeof payload.detail === "string") return payload.detail;
			if (payload.detail !== undefined) return JSON.stringify(payload.detail);
		} catch {
			// Fall through to status text.
		}
		return `Hermes API ${response.status}: ${response.statusText || "request failed"}`;
	}
}

function requireTask(response: HermesTaskResponse, action: string): HermesTaskRecord {
	if (!response.task) {
		throw new Error(`Hermes API did not return a task for ${action}`);
	}
	return response.task;
}

function requireBoard(response: HermesBoardResponse, action: string): HermesBoardRecord {
	if (!response.board) {
		throw new Error(`Hermes API did not return a board for ${action}`);
	}
	return response.board;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
	if (!headers) return {};
	if (headers instanceof Headers) {
		return Object.fromEntries(headers.entries());
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return headers;
}

function getWindowSessionToken(): string | null {
	if (typeof window === "undefined") return null;
	const maybeHermesWindow = window as Window & { __HERMES_SESSION_TOKEN__?: unknown };
	const token = maybeHermesWindow.__HERMES_SESSION_TOKEN__;
	return typeof token === "string" && token.trim() ? token.trim() : null;
}
