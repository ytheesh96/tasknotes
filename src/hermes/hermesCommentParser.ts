export type HermesCommentKind =
	| "comment"
	| "handoff"
	| "review-required"
	| "run-summary"
	| "artifact-report";

export type HermesCommentSeverity = "info" | "success" | "warning" | "blocked" | "danger";

export interface HermesCommentChip {
	label: string;
	value: string;
}

export interface HermesCommentAction {
	type: "artifact" | "task";
	label: string;
	value: string;
}

export interface HermesCommentPresentationModel {
	kind: HermesCommentKind;
	severity: HermesCommentSeverity;
	title: string;
	summary: string;
	chips: HermesCommentChip[];
	artifacts: HermesCommentAction[];
	actions: HermesCommentAction[];
	raw: string;
	payload?: Record<string, unknown>;
}

export interface HermesCommentParseMetadata {
	author?: string;
	createdAt?: string | number;
	metadata?: Record<string, unknown>;
}

const HERMES_TASK_ID_REGEX = /\bt_[a-z0-9]{8}\b/gi;
const HERMES_ARTIFACT_EXTENSIONS =
	/\.(?:base|canvas|csv|html?|jpeg|jpg|json|md|pdf|png|svg|tsv|txt|webp|yaml|yml)$/i;

const HIGH_SIGNAL_FIELD_ORDER = [
	"status",
	"reason",
	"summary",
	"next_action",
	"run_id",
	"profile",
	"assignee",
	"tests",
	"tests_run",
	"tests_passed",
	"typecheck",
	"build",
	"lint",
	"verification",
	"changed_files",
	"artifacts",
	"diff_path",
	"qa_report",
	"blocked_by",
	"needs_review",
	"questions",
];

const FIELD_LABELS: Record<string, string> = {
	next_action: "Next action",
	run_id: "Run",
	tests_run: "Tests run",
	tests_passed: "Tests passed",
	changed_files: "Changed files",
	diff_path: "Diff",
	qa_report: "QA report",
	blocked_by: "Blocked by",
	needs_review: "Needs review",
};

const ARRAY_NOUNS: Record<string, string> = {
	changed_files: "file",
	artifacts: "artifact",
	blocked_by: "item",
	questions: "question",
	tests_run: "item",
	verification: "check",
};

const ARTIFACT_KEYS = new Set([
	"artifact",
	"artifacts",
	"diff_path",
	"qa_report",
	"report",
	"path",
	"paths",
	"file",
	"files",
]);

export function parseHermesComment(
	rawComment: string,
	metadata: HermesCommentParseMetadata = {}
): HermesCommentPresentationModel {
	const raw = typeof rawComment === "string" ? rawComment : "";
	const cleaned = stripMarkdownFences(raw).trim();
	const payload = parseFirstJsonObject(cleaned) ?? metadata.metadata;
	const kind = classifyHermesComment(cleaned, payload, metadata);
	const severity = inferHermesCommentSeverity(kind, cleaned, payload);
	const summary = summarizeHermesComment(cleaned, payload);
	const title = titleForHermesComment(kind, severity, cleaned, payload, metadata, summary);
	const chips = buildHermesCommentChips(payload);
	const actions = buildHermesCommentActions(cleaned, payload);
	const artifacts = actions.filter((action) => action.type === "artifact");

	return {
		kind,
		severity,
		title,
		summary,
		chips,
		artifacts,
		actions,
		raw,
		payload,
	};
}

export function stripMarkdownFences(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !/^\s*```(?:json|JSON|javascript|js|ts|typescript)?\s*$/.test(line))
		.join("\n");
}

export function parseFirstJsonObject(text: string): Record<string, unknown> | null {
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		const end = findJsonObjectEnd(text, start);
		if (end < 0) {
			continue;
		}
		try {
			const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
			if (isRecord(parsed)) {
				return parsed;
			}
		} catch {
			// Keep scanning: Hermes comments often contain prose braces before a payload.
		}
	}
	return null;
}

function findJsonObjectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function classifyHermesComment(
	text: string,
	payload: Record<string, unknown> | undefined,
	metadata: HermesCommentParseMetadata
): HermesCommentKind {
	const lower = text.trim().toLowerCase();
	const structured = payload ?? {};
	const kindValue = stringValue(structured.kind).toLowerCase();
	const statusValue = stringValue(structured.status).toLowerCase();
	const severityValue = stringValue(structured.severity).toLowerCase();

	if (
		lower.startsWith("review-required") ||
		lower.includes("review-required handoff") ||
		booleanValue(structured.needs_review) ||
		kindValue.includes("review") ||
		statusValue.includes("review") ||
		severityValue.includes("review")
	) {
		return "review-required";
	}

	if (!payload) {
		return "comment";
	}

	if (hasAnyField(structured, ["summary", "result", "reason", "next_action", "questions"])) {
		return "handoff";
	}

	if (hasAnyField(structured, ["run_id", "profile", "outcome", "error", "status"])) {
		return "run-summary";
	}

	if (
		hasAnyField(structured, [
			"artifacts",
			"artifact",
			"diff_path",
			"qa_report",
			"changed_files",
		])
	) {
		return "artifact-report";
	}

	const author = metadata.author?.trim().toLowerCase() ?? "";
	return author === "tasknotes" || author === "yt" || author === "user" ? "comment" : "handoff";
}

function inferHermesCommentSeverity(
	kind: HermesCommentKind,
	text: string,
	payload: Record<string, unknown> | undefined
): HermesCommentSeverity {
	const combined = `${text} ${payload ? JSON.stringify(payload) : ""}`.toLowerCase();
	const status = stringValue(payload?.status).toLowerCase();
	if (/blocked|needs input|missing credentials|human decision/.test(combined)) {
		return "blocked";
	}
	if (/failed|failure|crashed|timed_out|error/.test(combined)) {
		return "danger";
	}
	if (kind === "review-required" || /running|partial|skipped|review/.test(combined)) {
		return "warning";
	}
	if (
		status === "done" ||
		status === "completed" ||
		status === "success" ||
		allNumericTestsPassed(payload) ||
		allVerificationChecksPassed(payload) ||
		/all checks passed|checks passed|tests? passed|build passed|typecheck passed|lint passed/.test(
			combined
		)
	) {
		return "success";
	}
	return "info";
}

function summarizeHermesComment(
	text: string,
	payload: Record<string, unknown> | undefined
): string {
	const structuredSummary =
		stringValue(payload?.summary) ||
		stringValue(payload?.reason) ||
		stringValue(payload?.result) ||
		stringValue(payload?.error) ||
		stringValue(payload?.next_action);
	if (structuredSummary) {
		return compactText(structuredSummary, 360);
	}

	const withoutPrefix = text
		.replace(/^review-required\s+handoff:\s*/i, "")
		.replace(/^review-required:\s*/i, "")
		.replace(/^handoff:\s*/i, "")
		.trim();
	const beforeJson = withoutPrefix.slice(0, firstJsonStart(withoutPrefix));
	return compactText((beforeJson.trim() || withoutPrefix).trim(), 360);
}

function titleForHermesComment(
	kind: HermesCommentKind,
	severity: HermesCommentSeverity,
	text: string,
	payload: Record<string, unknown> | undefined,
	metadata: HermesCommentParseMetadata,
	summary: string
): string {
	if (kind === "review-required") return "Review required";
	if (severity === "blocked") return "Blocked";
	const title = stringValue(payload?.title);
	if (title) return compactText(title, 120);
	if (kind === "handoff") return "Handoff";
	if (kind === "run-summary") return "Run summary";
	if (kind === "artifact-report") return "Artifacts";
	const author = metadata.author?.trim();
	if (author) return author;
	const firstLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	return compactText(firstLine || summary || "Comment", 120);
}

function buildHermesCommentChips(
	payload: Record<string, unknown> | undefined
): HermesCommentChip[] {
	if (!payload) return [];
	const chips: HermesCommentChip[] = [];
	const keys = orderPayloadKeys(payload);

	for (const key of keys) {
		if (chips.length >= 8) break;
		const value = payload[key];
		if (
			isEmptyValue(value) ||
			key === "summary" ||
			key === "reason" ||
			key === "result" ||
			key === "error"
		) {
			continue;
		}

		if (
			key === "tests_run" &&
			typeof value === "number" &&
			typeof payload.tests_passed === "number"
		) {
			chips.push({ label: "Tests", value: `${payload.tests_passed}/${value} passed` });
			continue;
		}
		if (key === "tests_passed" && typeof payload.tests_run === "number") {
			continue;
		}
		if (key === "verification" && isRecord(value)) {
			for (const [verificationKey, verificationValue] of Object.entries(value)) {
				if (chips.length >= 8 || isEmptyValue(verificationValue)) continue;
				chips.push({
					label: fieldLabel(verificationKey),
					value: summarizePayloadValue(verificationValue, verificationKey),
				});
			}
			continue;
		}

		chips.push({ label: fieldLabel(key), value: summarizePayloadValue(value, key) });
	}

	return chips;
}

function buildHermesCommentActions(
	text: string,
	payload: Record<string, unknown> | undefined
): HermesCommentAction[] {
	const actions: HermesCommentAction[] = [];
	const seen = new Set<string>();
	const addAction = (action: HermesCommentAction) => {
		const key = `${action.type}:${action.value.toLowerCase()}`;
		if (seen.has(key) || actions.length >= 8) return;
		seen.add(key);
		actions.push(action);
	};

	const visit = (value: unknown, keyHint = "") => {
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) return;
			if (isArtifactValue(trimmed, keyHint)) {
				addAction({
					type: "artifact",
					label: artifactActionLabel(trimmed),
					value: trimmed,
				});
			}
			for (const match of trimmed.matchAll(HERMES_TASK_ID_REGEX)) {
				const taskId = match[0].toLowerCase();
				addAction({ type: "task", label: `Edit ${taskId}`, value: taskId });
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, keyHint);
			return;
		}
		if (isRecord(value)) {
			for (const [key, nestedValue] of Object.entries(value)) visit(nestedValue, key);
		}
	};

	if (payload) visit(payload);
	visit(text);
	return actions;
}

function orderPayloadKeys(payload: Record<string, unknown>): string[] {
	const keys = Object.keys(payload);
	return [
		...HIGH_SIGNAL_FIELD_ORDER.filter((key) => keys.includes(key)),
		...keys.filter((key) => !HIGH_SIGNAL_FIELD_ORDER.includes(key)).sort(),
	];
}

function summarizePayloadValue(value: unknown, key: string, maxLength = 96): string {
	if (Array.isArray(value)) {
		const noun = ARRAY_NOUNS[key] ?? "item";
		return `${value.length} ${value.length === 1 ? noun : `${noun}s`}`;
	}
	if (isRecord(value)) {
		const entries = orderPayloadKeys(value)
			.filter((entryKey) => !isEmptyValue(value[entryKey]))
			.slice(0, 3)
			.map(
				(entryKey) =>
					`${fieldLabel(entryKey)}: ${summarizePayloadValue(value[entryKey], entryKey, 48)}`
			);
		return entries.length > 0 ? compactText(entries.join(", "), maxLength) : "No fields";
	}
	if (typeof value === "boolean") return value ? "yes" : "no";
	return compactText(String(value), maxLength);
}

function fieldLabel(key: string): string {
	return (
		FIELD_LABELS[key] ??
		key.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (char) => char.toUpperCase())
	);
}

function isArtifactValue(value: string, keyHint: string): boolean {
	const lowerKey = keyHint.toLowerCase();
	return (
		ARTIFACT_KEYS.has(lowerKey) ||
		lowerKey.endsWith("_file") ||
		lowerKey.endsWith("_files") ||
		lowerKey.endsWith("_path") ||
		lowerKey.endsWith("_paths") ||
		value.startsWith("/") ||
		value.startsWith("TaskNotes/") ||
		value.startsWith("30 Projects/") ||
		value.startsWith("20 Job-Search/") ||
		value.startsWith("10 Research-Wiki/") ||
		HERMES_ARTIFACT_EXTENSIONS.test(value)
	);
}

function artifactActionLabel(path: string): string {
	const basename = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
	return `Open ${compactText(basename, 48)}`;
}

function firstJsonStart(text: string): number {
	const index = text.indexOf("{");
	return index >= 0 ? index : text.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasAnyField(record: Record<string, unknown>, fields: string[]): boolean {
	return fields.some((field) => !isEmptyValue(record[field]));
}

function isEmptyValue(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		(typeof value === "string" && value.trim() === "") ||
		(Array.isArray(value) && value.length === 0)
	);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown): boolean {
	return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

function allNumericTestsPassed(payload: Record<string, unknown> | undefined): boolean {
	return (
		typeof payload?.tests_run === "number" &&
		typeof payload.tests_passed === "number" &&
		payload.tests_run === payload.tests_passed
	);
}

function allVerificationChecksPassed(payload: Record<string, unknown> | undefined): boolean {
	if (!isRecord(payload?.verification)) return false;
	const values = Object.values(payload.verification);
	return (
		values.length > 0 && values.every((value) => stringValue(value).toLowerCase() === "passed")
	);
}

function compactText(value: string, maxLength: number): string {
	const text = value.trim();
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}
