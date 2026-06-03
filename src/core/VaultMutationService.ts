import type { App, TFile } from "obsidian";

type VaultCreateApp = {
	vault: Pick<App["vault"], "create">;
};

type VaultCreateFolderApp = {
	vault: Pick<App["vault"], "createFolder">;
};

type VaultDeleteApp = {
	vault: Pick<App["vault"], "delete">;
};

type VaultModifyApp = {
	vault: Pick<App["vault"], "modify">;
};

type VaultRenameApp = {
	vault: Pick<App["vault"], "rename">;
};

type FrontMatterMutationApp = {
	fileManager: Pick<App["fileManager"], "processFrontMatter">;
};

export async function processVaultFrontMatter(
	app: FrontMatterMutationApp,
	file: TFile,
	update: (frontmatter: Record<string, unknown>) => void
): Promise<void> {
	await app.fileManager.processFrontMatter(file, update);
}

export async function createVaultFile(
	app: VaultCreateApp,
	path: string,
	content: string
): Promise<TFile> {
	return app.vault.create(path, content);
}

export async function createVaultFolder(app: VaultCreateFolderApp, path: string): Promise<void> {
	await app.vault.createFolder(path);
}

export async function modifyVaultFile(
	app: VaultModifyApp,
	file: TFile,
	content: string
): Promise<void> {
	await app.vault.modify(file, content);
}

export async function renameVaultFile(
	app: VaultRenameApp,
	file: TFile,
	newPath: string
): Promise<void> {
	await app.vault.rename(file, newPath);
}

export async function deleteVaultFile(app: VaultDeleteApp, file: TFile): Promise<void> {
	await app.vault.delete(file);
}
