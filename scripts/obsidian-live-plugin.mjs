#!/usr/bin/env node

import { constants } from "fs";
import { access, copyFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const PLUGIN_ID = "tasknotes";
const PLUGIN_FILES = ["main.js", "styles.css", "manifest.json"];
const DEFAULT_VAULT_NAME = "Obsidian";
const DEFAULT_PLUGIN_PATH = process.env.OBSIDIAN_VAULT_PATH
	? join(process.env.OBSIDIAN_VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID)
	: "~/Documents/Obsidian/.obsidian/plugins/tasknotes";

const command = process.argv[2] ?? "status";
const vaultName = firstEnvValue(
	["TASKNOTES_OBSIDIAN_VAULT_NAME", "OBSIDIAN_VAULT_NAME"],
	DEFAULT_VAULT_NAME
);
const pluginPath = resolve(
	expandTilde(
		firstEnvValue(
			["TASKNOTES_OBSIDIAN_PLUGIN_PATH", "TASKNOTES_OBSIDIAN_PLUGIN_DIR"],
			DEFAULT_PLUGIN_PATH
		)
	)
);
const obsidianCli = firstEnvValue(["TASKNOTES_OBSIDIAN_CLI"], "obsidian");
const obsidianCliHome = firstEnvValue(
	["TASKNOTES_OBSIDIAN_CLI_HOME"],
	inferUserHomeFromVaultPath(process.env.OBSIDIAN_VAULT_PATH) ?? homedir()
);

async function main() {
	if (command === "status") {
		await printStatus();
		return;
	}
	if (command === "copy") {
		await copyPluginFiles();
		return;
	}
	if (command === "reload") {
		assertVaultAvailable();
		runObsidian(["plugin:reload", `id=${PLUGIN_ID}`]);
		return;
	}
	if (command === "errors") {
		assertVaultAvailable();
		runObsidian(["dev:errors"]);
		return;
	}
	if (command === "verify") {
		await copyPluginFiles();
		assertVaultAvailable();
		runObsidian(["plugin:reload", `id=${PLUGIN_ID}`]);
		runObsidian(["dev:errors"]);
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error("Usage: node scripts/obsidian-live-plugin.mjs [status|copy|reload|errors|verify]");
	process.exit(1);
}

async function printStatus() {
	console.log(`Vault: ${vaultName}`);
	console.log(`Plugin path: ${pluginPath}`);
	console.log(`Obsidian CLI: ${obsidianCli}`);
	assertVaultAvailable();
	runObsidian(["plugin", `id=${PLUGIN_ID}`]);
}

async function copyPluginFiles() {
	await mkdir(pluginPath, { recursive: true });
	for (const file of PLUGIN_FILES) {
		await access(file, constants.F_OK);
		await copyFile(file, join(pluginPath, file));
	}
	console.log(`Copied ${PLUGIN_FILES.length} plugin files to ${pluginPath}`);
}

function assertVaultAvailable() {
	let lastResult;
	for (let attempt = 1; attempt <= 10; attempt += 1) {
		lastResult = runObsidianRaw(["eval", "code=app.vault.getName()"]);
		if (isVaultResultAvailable(lastResult)) {
			return;
		}
		sleep(500);
	}

	process.stdout.write(lastResult?.stdout ?? "");
	process.stderr.write(lastResult?.stderr ?? "");
	console.error(
		`Obsidian vault "${vaultName}" is not available. Set TASKNOTES_OBSIDIAN_VAULT_NAME to the running vault name.`
	);
	process.exit(1);
}

function isVaultResultAvailable(result) {
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	return (
		result.status === 0 &&
		!/Vault not found|Unable to connect to main process/i.test(output) &&
		output.includes(vaultName)
	);
}

function runObsidian(args) {
	const result = runObsidianRaw(args);
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function runObsidianRaw(args) {
	return spawnSync(obsidianCli, [`vault=${vaultName}`, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: obsidianCliHome,
		},
	});
}

function inferUserHomeFromVaultPath(vaultPath) {
	if (!vaultPath) return null;
	const normalized = resolve(expandTilde(vaultPath));
	const documentsMarker = `${resolve("/Users")}/`;
	if (!normalized.startsWith(documentsMarker)) return null;

	const parts = normalized.split("/").filter(Boolean);
	if (parts.length < 2 || parts[0] !== "Users") return null;
	return `/${join(parts[0], parts[1])}`;
}

function firstEnvValue(names, fallback) {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return fallback;
}

function expandTilde(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
