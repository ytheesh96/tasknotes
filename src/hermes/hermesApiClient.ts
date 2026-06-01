import type { TaskInfo } from "../types";

const DEFAULT_HERMES_KANBAN_API_BASE = "http://127.0.0.1:9119/api/plugins/kanban";

export interface HermesTaskRecord {
	id: string;
	title: string;
	body?: string | null;
	status: string;
	assignee?: string | null;
	priority?: number | null;
	tenant?: string | null;
	created_by?: string | null;
	workspace_kind?: string | null;
	workspace_path?: string | null;
	branch_name?: string | null;
	result?: string | null;
	latest_summary?: string | null;
}

export interface HermesTaskIdentity {
	board: string;
	id: string;
}

export interface HermesCreateTaskPayload {
	title: string;
	body?: string;
	assignee?: string;
	tenant?: string;
	priority?: number;
	workspace_kind?: string;
	workspace_path?: string;
	parents?: string[];
	triage?: boolean;
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

export interface HermesCommentPayload {
	body: string;
	author?: string;
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

export function getHermesTaskIdentity(task: TaskInfo): HermesTaskIdentity | null {
	const boardFromFrontmatter = customString(task, "hermes_board");
	const idFromFrontmatter = customString(task, "hermes_id");
	if (boardFromFrontmatter && idFromFrontmatter) {
		return { board: boardFromFrontmatter, id: idFromFrontmatter };
	}

	const match = task.path.match(/^TaskNotes\/Hermes\/([^/]+)\/([^/]+)\.md$/);
	if (!match) {
		return null;
	}
	return { board: match[1], id: idFromFrontmatter || match[2] };
}

export class HermesKanbanApiClient {
	private sessionToken: string | null = null;

	constructor(private readonly baseUrl = DEFAULT_HERMES_KANBAN_API_BASE) {}

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

	private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
		let response = await this.requestOnce(path, init);
		if (response.status === 401 && !this.sessionToken) {
			this.sessionToken = await this.loadSessionToken();
			if (this.sessionToken) {
				response = await this.requestOnce(path, init);
			}
		}

		if (!response.ok) {
			throw new Error(await this.errorMessage(response));
		}

		return response.json() as Promise<T>;
	}

	private async requestOnce(path: string, init: RequestInit): Promise<Response> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...headersToRecord(init.headers),
		};
		if (this.sessionToken) {
			headers.Authorization = `Bearer ${this.sessionToken}`;
		}
		return fetch(`${this.baseUrl}${path}`, {
			...init,
			headers,
		});
	}

	private async loadSessionToken(): Promise<string | null> {
		const windowToken = getWindowSessionToken();
		if (windowToken) return windowToken;
		try {
			const rootUrl = new URL(this.baseUrl).origin;
			const response = await fetch(`${rootUrl}/`);
			const html = await response.text();
			return html.match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1] ?? null;
		} catch (_error) {
			return null;
		}
	}

	private async errorMessage(response: Response): Promise<string> {
		try {
			const payload = (await response.json()) as { detail?: unknown };
			if (typeof payload.detail === "string") return payload.detail;
			if (payload.detail !== undefined) return JSON.stringify(payload.detail);
		} catch (_error) {
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

function customString(task: TaskInfo, key: string): string {
	const value = task.customProperties?.[key];
	return typeof value === "string" ? value.trim() : "";
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
