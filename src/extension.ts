import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { addTargetsToGitignore, nodeGitignoreFileSystem } from './gitignore';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('add-to-gitignore.add', addToGitignore));
}

async function addToGitignore(resource?: vscode.Uri, selectedResources?: vscode.Uri[]) {
	try {
		const resources = getCommandResources(resource, selectedResources);
		if (resources.length === 0) {
			vscode.window.showErrorMessage('Select a file or folder to add to .gitignore.');
			return;
		}

		const targets = await Promise.all(resources.map(createTarget));
		const result = await addTargetsToGitignore(targets, nodeGitignoreFileSystem);

		if (result.addedPatterns.length === 0) {
			const itemLabel = resources.length === 1 ? 'item is' : 'items are';
			vscode.window.showInformationMessage(`Selected ${itemLabel} already in .gitignore.`);
			return;
		}

		const itemLabel = result.addedPatterns.length === 1 ? 'item' : 'items';
		const fileLabel = result.changedGitignorePaths.length === 1 ? '.gitignore' : `${result.changedGitignorePaths.length} .gitignore files`;
		vscode.window.showInformationMessage(`Added ${result.addedPatterns.length} ${itemLabel} to ${fileLabel}.`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Could not add to .gitignore: ${message}`);
	}
}

function getCommandResources(resource?: vscode.Uri, selectedResources?: readonly vscode.Uri[]) {
	const resources = selectedResources && selectedResources.length > 0
		? selectedResources
		: resource
			? [resource]
			: vscode.window.activeTextEditor
				? [vscode.window.activeTextEditor.document.uri]
				: [];
	const seenResources = new Set<string>();
	const fileResources: vscode.Uri[] = [];

	for (const currentResource of resources) {
		if (currentResource.scheme !== 'file') {
			throw new Error(`Only file-system resources can be added to .gitignore.`);
		}

		const resourceKey = currentResource.toString();
		if (!seenResources.has(resourceKey)) {
			seenResources.add(resourceKey);
			fileResources.push(currentResource);
		}
	}

	return fileResources;
}

async function createTarget(resource: vscode.Uri) {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
	if (!workspaceFolder) {
		throw new Error(`"${resource.fsPath}" is not inside an open workspace folder.`);
	}

	const stat = await fs.lstat(resource.fsPath);

	return {
		path: resource.fsPath,
		workspaceRoot: workspaceFolder.uri.fsPath,
		isDirectory: stat.isDirectory(),
	};
}
