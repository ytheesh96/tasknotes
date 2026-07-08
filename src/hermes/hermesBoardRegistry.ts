import { normalizePath, TFile, type App } from "obsidian";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createVaultFile, modifyVaultFile } from "../core/VaultMutationService";
import { getCurrentTimestamp } from "../utils/dateUtils";
import { ensureFolderExists } from "../utils/helpers";
import type { HermesBoardRecord } from "./hermesApiClient";

export const HERMES_BOARD_REGISTRY_FOLDER = "TaskNotes/Boards";
export const HERMES_BOARD_REGISTRY_TYPE = "hermes-board";
export const HERMES_BOARD_REGISTRY_ARCHIVED_FIELD = "hermesBoardArchived";

const HERMES_BOARD_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type HermesBoardRegistryHost = {
	app: {
		vault: Pick<App["vault"], "adapter" | "create" | "createFolder" | "getAbstractFileByPath" | "getFiles" | "modify" | "read">;
	};
};

export type HermesBoardRegistryRecord = {
	slug: string;
	name?: string;
	archived: boolean;
	path: string;
	source: "registry";
};

type ReadHermesBoardRegistryOptions = {
	includeArchived?: boolean;
};

type WriteHermesBoardRegistryInput = {
	slug: string;
	name?: string;
	archived?: boolean;
};

export async function readHermesBoardRegistry(
	host: HermesBoardRegistryHost,
	options: ReadHermesBoardRegistryOptions = {}
): Promise<HermesBoardRegistryRecord[]> {
	const records: HermesBoardRegistryRecord[] = [];
	const files = host.app.vault
		.getFiles()
		.filter((file) => normalizePath(file.path).startsWith(`${HERMES_BOARD_REGISTRY_FOLDER}/`))
		.filter((file) => file.extension === "md")
		.sort((left, right) => left.path.localeCompare(right.path));

	for (const file of files) {
		const slugFromPath = normalizeHermesBoardSlug(slugFromRegistryPath(file.path) ?? "");
		if (!slugFromPath || isHermesBoardFixtureSlug(slugFromPath)) {
			continue;
		}

		let content: string;
		try {
			content = await host.app.vault.read(file);
		} catch {
			// Obsidian can briefly retain deleted fixture TFiles in getFiles() after
			// e2e cleanup. Registry reads are best-effort; skip vanished files so
			// stale fixtures never pollute user-facing board lists or console errors.
			continue;
		}

		const record = parseHermesBoardRegistryRecord(file.path, content);
		if (!record) {
			continue;
		}
		if (record.archived && !options.includeArchived) {
			continue;
		}
		records.push(record);
	}

	return records;
}

export async function createOrUpdateHermesBoardRegistryRecord(
	host: HermesBoardRegistryHost,
	input: WriteHermesBoardRegistryInput
): Promise<HermesBoardRegistryRecord> {
	const slug = normalizeHermesBoardSlug(input.slug);
	if (!slug) {
		throw new Error(`Invalid Hermes board slug: ${input.slug}`);
	}

	await ensureFolderExists(host.app.vault as App["vault"], HERMES_BOARD_REGISTRY_FOLDER);
	const path = getHermesBoardRegistryPath(slug);
	const existing = host.app.vault.getAbstractFileByPath(path);
	const existingContent = existing instanceof TFile ? await host.app.vault.read(existing) : null;
	const existingFrontmatter = parseFrontmatter(existingContent);
	const existingRecord = existingContent
		? parseHermesBoardRegistryRecord(path, existingContent)
		: null;
	const archived = input.archived ?? existingRecord?.archived ?? false;
	const name = normalizeOptionalString(input.name ?? existingRecord?.name) ?? formatBoardTitle(slug);
	const now = getCurrentTimestamp();
	const dateCreated = normalizeOptionalString(existingFrontmatter?.dateCreated) ?? now;
	const existingDateModified = normalizeOptionalString(existingFrontmatter?.dateModified);
	const existingName = existingRecord
		? normalizeOptionalString(existingRecord.name) ?? formatBoardTitle(slug)
		: null;
	const durableMetadataChanged =
		!existingRecord || existingName !== name || existingRecord.archived !== archived;
	const frontmatter: Record<string, unknown> = {
		type: HERMES_BOARD_REGISTRY_TYPE,
		hermesBoard: slug,
		hermesBoardName: name,
		[HERMES_BOARD_REGISTRY_ARCHIVED_FIELD]: archived,
		dateCreated,
		dateModified: durableMetadataChanged ? now : existingDateModified ?? now,
	};
	const content = buildHermesBoardRegistryContent(slug, frontmatter);

	if (existing instanceof TFile) {
		if (existingContent !== content) {
			await modifyVaultFile(host.app, existing, content);
		}
	} else {
		await createVaultFile(host.app, path, content);
	}

	return {
		slug,
		name: normalizeOptionalString(frontmatter.hermesBoardName),
		archived,
		path,
		source: "registry",
	};
}

export async function importHermesBoardsIntoRegistry(
	host: HermesBoardRegistryHost,
	boards: readonly HermesBoardRecord[]
): Promise<HermesBoardRegistryRecord[]> {
	const records: HermesBoardRegistryRecord[] = [];
	const existingRecords = new Map(
		(await readHermesBoardRegistry(host, { includeArchived: true })).map((record) => [
			record.slug,
			record,
		])
	);
	for (const board of boards) {
		const slug = normalizeHermesBoardSlug(board.slug);
		if (!slug || isHermesBoardFixtureSlug(slug)) {
			continue;
		}
		const existing = existingRecords.get(slug);
		records.push(
			await createOrUpdateHermesBoardRegistryRecord(host, {
				slug,
				name: normalizeOptionalString(board.name),
				archived: existing?.archived === true ? true : readBoolean(board.archived) ?? false,
			})
		);
	}
	return records;
}

export async function archiveHermesBoardRegistryRecord(
	host: HermesBoardRegistryHost,
	board: string
): Promise<HermesBoardRegistryRecord> {
	const slug = normalizeHermesBoardSlug(board);
	if (!slug) {
		throw new Error(`Invalid Hermes board slug: ${board}`);
	}
	return createOrUpdateHermesBoardRegistryRecord(host, { slug, archived: true });
}

export function getHermesBoardRegistryPath(board: string): string {
	const slug = normalizeHermesBoardSlug(board);
	if (!slug) {
		throw new Error(`Invalid Hermes board slug: ${board}`);
	}
	return normalizePath(`${HERMES_BOARD_REGISTRY_FOLDER}/${slug}.md`);
}

export function normalizeHermesBoardSlug(input: string): string | null {
	const slug = input.trim().toLowerCase().replace(/\s+/g, "-");
	if (!HERMES_BOARD_SLUG_PATTERN.test(slug)) {
		return null;
	}
	return slug;
}

export function parseHermesBoardRegistryRecord(
	path: string,
	content: string
): HermesBoardRegistryRecord | null {
	const frontmatter = parseFrontmatter(content);
	if (!frontmatter) {
		return null;
	}
	const type = normalizeOptionalString(frontmatter.type);
	if (type && type !== HERMES_BOARD_REGISTRY_TYPE) {
		return null;
	}
	const slug = normalizeHermesBoardSlug(
		normalizeOptionalString(frontmatter.hermesBoard) ?? slugFromRegistryPath(path) ?? ""
	);
	if (!slug || isHermesBoardFixtureSlug(slug)) {
		return null;
	}
	return {
		slug,
		name: normalizeOptionalString(frontmatter.hermesBoardName),
		archived: readBoolean(frontmatter[HERMES_BOARD_REGISTRY_ARCHIVED_FIELD]) ?? readBoolean(frontmatter.archived) ?? false,
		path: normalizePath(path),
		source: "registry",
	};
}

function buildHermesBoardRegistryContent(slug: string, frontmatter: Record<string, unknown>): string {
	const yaml = stringifyYaml(frontmatter).trimEnd();
	return `---\n${yaml}\n---\n\n# Hermes/${slug}\n\nThis TaskNotes-native board record is the local source of truth for the Hermes board. Deleting a board archives this record and removes local Hermes mirror task notes; the archived record is kept for recovery and migration context.\n`;
}

function parseFrontmatter(content: string | null): Record<string, unknown> | null {
	if (!content) {
		return null;
	}
	const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	if (!match) {
		return null;
	}
	try {
		const parsed = parseYaml(match[1]);
		if (isPlainObject(parsed) && Object.keys(parsed).length > 0) {
			return parsed;
		}
	} catch {
		// Fall through to the lightweight parser below. Some test harnesses mock
		// the yaml package with JSON-only parsing, but board records are stored as
		// regular Obsidian YAML frontmatter.
	}

	const fallback = parseSimpleFrontmatter(match[1]);
	return Object.keys(fallback).length > 0 ? fallback : null;
}

function parseSimpleFrontmatter(yaml: string): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {};
	for (const rawLine of yaml.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const separator = line.indexOf(":");
		if (separator <= 0) {
			continue;
		}
		const key = line.slice(0, separator).trim();
		const rawValue = line.slice(separator + 1).trim();
		if (!key) {
			continue;
		}
		frontmatter[key] = parseSimpleFrontmatterValue(rawValue);
	}
	return frontmatter;
}

function parseSimpleFrontmatterValue(value: string): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	const quoted = value.match(/^(["'])([\s\S]*)\1$/);
	if (quoted) {
		return quoted[2];
	}
	return value;
}

function slugFromRegistryPath(path: string): string | null {
	const match = normalizePath(path).match(/^TaskNotes\/Boards\/(.+)\.md$/);
	return match?.[1] ?? null;
}

function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatBoardTitle(board: string): string {
	return board
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function isHermesBoardFixtureSlug(slug: string): boolean {
	return /(?:^e2e[-_]|[-_]e2e[-_]|[-_]e2e$|[-_]fixture$|^fixture[-_])/.test(slug);
}
