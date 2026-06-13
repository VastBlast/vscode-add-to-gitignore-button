import * as fs from 'fs/promises';
import * as path from 'path';

type PathApi = typeof path.posix;
const gitignoreCharactersToEscape = new Set([' ', '\t', '*', '?', '[', ']', '#', '!']);

export interface GitignoreFileSystem {
	stat(filePath: string): Promise<{ isDirectory: boolean } | undefined>;
	readFile(filePath: string): Promise<string | undefined>;
	writeFile(filePath: string, content: string): Promise<void>;
}

export interface GitignoreTarget {
	path: string;
	workspaceRoot: string;
	isDirectory: boolean;
}

interface GitignoreEntry {
	gitignorePath: string;
	pattern: string;
}

export const nodeGitignoreFileSystem: GitignoreFileSystem = {
	async stat(filePath) {
		try {
			const stat = await fs.stat(filePath);
			return { isDirectory: stat.isDirectory() };
		} catch (error) {
			if (isNotFoundError(error)) {
				return undefined;
			}

			throw error;
		}
	},

	async readFile(filePath) {
		try {
			return await fs.readFile(filePath, 'utf8');
		} catch (error) {
			if (isNotFoundError(error)) {
				return undefined;
			}

			throw error;
		}
	},

	async writeFile(filePath, content) {
		await fs.writeFile(filePath, content, 'utf8');
	},
};

export async function addTargetsToGitignore(
	targets: readonly GitignoreTarget[],
	fileSystem: GitignoreFileSystem,
	pathApi: PathApi = path,
) {
	const entries = await Promise.all(targets.map(target => createGitignoreEntry(target, fileSystem, pathApi)));
	const entriesByGitignorePath = new Map<string, GitignoreEntry[]>();
	const addedPatterns: GitignoreEntry[] = [];
	const unchangedPatterns: GitignoreEntry[] = [];
	const changedGitignorePaths: string[] = [];

	for (const entry of entries) {
		const key = pathApi.resolve(entry.gitignorePath);
		const groupedEntries = entriesByGitignorePath.get(key);

		if (groupedEntries) {
			groupedEntries.push(entry);
		} else {
			entriesByGitignorePath.set(key, [entry]);
		}
	}

	for (const [gitignorePath, groupedEntries] of entriesByGitignorePath) {
		const existingContent = await fileSystem.readFile(gitignorePath) ?? '';
		const { content, addedPatterns: addedPatternValues, unchangedPatterns: unchangedPatternValues } = appendMissingGitignorePatterns(
			existingContent,
			groupedEntries.map(entry => entry.pattern),
		);

		if (addedPatternValues.length > 0) {
			await fileSystem.writeFile(gitignorePath, content);
			changedGitignorePaths.push(gitignorePath);
		}

		const addedPatternSet = new Set(addedPatternValues);
		const unchangedPatternSet = new Set(unchangedPatternValues);
		const reportedAddedPatterns = new Set<string>();

		for (const entry of groupedEntries) {
			if (addedPatternSet.has(entry.pattern) && !reportedAddedPatterns.has(entry.pattern)) {
				addedPatterns.push(entry);
				reportedAddedPatterns.add(entry.pattern);
			} else if (unchangedPatternSet.has(entry.pattern)) {
				unchangedPatterns.push(entry);
			}
		}
	}

	return {
		addedPatterns,
		unchangedPatterns,
		changedGitignorePaths,
	};
}

export async function createGitignoreEntry(
	target: GitignoreTarget,
	fileSystem: GitignoreFileSystem,
	pathApi: PathApi = path,
) {
	const targetPath = pathApi.resolve(target.path);
	const workspaceRoot = pathApi.resolve(target.workspaceRoot);
	const applicableParentDir = pathApi.dirname(targetPath);
	const repositoryRoot = await findRepositoryRoot(applicableParentDir, fileSystem, pathApi);
	const fallbackRoot = repositoryRoot ?? workspaceRoot;

	if (!isPathInsideOrEqual(targetPath, fallbackRoot, pathApi)) {
		throw new Error(`Cannot add "${target.path}" because it is outside the Git repository or workspace folder.`);
	}

	const gitignorePath = await findNearestGitignore(applicableParentDir, fallbackRoot, fileSystem, pathApi)
		?? pathApi.join(fallbackRoot, '.gitignore');
	const relativePath = pathApi.relative(pathApi.dirname(gitignorePath), targetPath);
	const pattern = toGitignorePattern(relativePath, target.isDirectory, pathApi.sep);

	return {
		gitignorePath,
		pattern,
	};
}

export async function findRepositoryRoot(
	startDirectory: string,
	fileSystem: GitignoreFileSystem,
	pathApi: PathApi = path,
) {
	let currentDirectory = pathApi.resolve(startDirectory);

	while (true) {
		if (await fileSystem.stat(pathApi.join(currentDirectory, '.git'))) {
			return currentDirectory;
		}

		const parentDirectory = pathApi.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return undefined;
		}

		currentDirectory = parentDirectory;
	}
}

export async function findNearestGitignore(
	startDirectory: string,
	stopDirectory: string,
	fileSystem: GitignoreFileSystem,
	pathApi: PathApi = path,
) {
	let currentDirectory = pathApi.resolve(startDirectory);
	const resolvedStopDirectory = pathApi.resolve(stopDirectory);

	if (!isPathInsideOrEqual(currentDirectory, resolvedStopDirectory, pathApi)) {
		return undefined;
	}

	while (true) {
		const candidatePath = pathApi.join(currentDirectory, '.gitignore');
		const stat = await fileSystem.stat(candidatePath);
		if (stat && !stat.isDirectory) {
			return candidatePath;
		}

		if (currentDirectory === resolvedStopDirectory) {
			return undefined;
		}

		const parentDirectory = pathApi.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return undefined;
		}

		currentDirectory = parentDirectory;
	}
}

export function toGitignorePattern(relativePath: string, isDirectory: boolean, separator = path.sep) {
	const normalizedRelativePath = normalizeRelativePathForGitignore(relativePath, separator);
	const escapedRelativePath = normalizedRelativePath
		.split('/')
		.map(escapeGitignoreSegment)
		.join('/');

	return `/${escapedRelativePath}${isDirectory ? '/' : ''}`;
}

export function appendMissingGitignorePatterns(
	content: string,
	patterns: readonly string[],
) {
	const existingPatterns = new Set(getComparableGitignoreLines(content));
	const seenPatterns = new Set<string>();
	const addedPatterns: string[] = [];
	const unchangedPatterns: string[] = [];

	for (const pattern of patterns) {
		if (seenPatterns.has(pattern)) {
			unchangedPatterns.push(pattern);
			continue;
		}

		seenPatterns.add(pattern);

		const existingPatternIgnoresTarget = existingPatterns.has(pattern)
			|| (pattern.endsWith('/') && existingPatterns.has(pattern.slice(0, -1)));
		if (existingPatternIgnoresTarget) {
			unchangedPatterns.push(pattern);
			continue;
		}

		addedPatterns.push(pattern);
		existingPatterns.add(pattern);
	}

	if (addedPatterns.length === 0) {
		return { content, addedPatterns, unchangedPatterns };
	}

	const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
	const separator = content.length > 0 && !content.endsWith('\n') ? lineEnding : '';
	const appendedContent = `${content}${separator}${addedPatterns.join(lineEnding)}${lineEnding}`;

	return {
		content: appendedContent,
		addedPatterns,
		unchangedPatterns,
	};
}

function normalizeRelativePathForGitignore(relativePath: string, separator: string) {
	if (relativePath === '' || relativePath === '.') {
		throw new Error('Cannot ignore a root folder from a .gitignore inside that same folder.');
	}

	const isAbsolutePath = separator === '\\' ? path.win32.isAbsolute(relativePath) : path.posix.isAbsolute(relativePath);
	if (isAbsolutePath) {
		throw new Error(`Expected a relative path, got "${relativePath}".`);
	}

	const parts = relativePath.split(separator);
	if (parts.some(part => part === '..')) {
		throw new Error(`Cannot write a .gitignore pattern for a path outside the .gitignore directory: "${relativePath}".`);
	}

	if (parts.some(part => part === '' || part === '.')) {
		throw new Error(`Cannot write a .gitignore pattern for an invalid relative path: "${relativePath}".`);
	}

	if (parts.some(part => part.includes('\n') || part.includes('\r'))) {
		throw new Error('Gitignore patterns cannot safely represent file names containing line breaks.');
	}

	return parts.join('/');
}

function escapeGitignoreSegment(segment: string) {
	let escaped = '';

	for (const character of segment) {
		if (character === '\\') {
			escaped += '\\\\';
		} else if (gitignoreCharactersToEscape.has(character)) {
			escaped += `\\${character}`;
		} else {
			escaped += character;
		}
	}

	return escaped;
}

function getComparableGitignoreLines(content: string) {
	return content
		.split('\n')
		.map((line, index) => {
			const withoutCarriageReturn = line.endsWith('\r') ? line.slice(0, -1) : line;
			const withoutByteOrderMark = index === 0 && withoutCarriageReturn.startsWith('\uFEFF')
				? withoutCarriageReturn.slice(1)
				: withoutCarriageReturn;

			return trimUnescapedTrailingSpaces(withoutByteOrderMark);
		});
}

function trimUnescapedTrailingSpaces(line: string) {
	let endIndex = line.length;

	while (endIndex > 0 && line[endIndex - 1] === ' ') {
		let backslashCount = 0;

		for (let currentIndex = endIndex - 2; currentIndex >= 0 && line[currentIndex] === '\\'; currentIndex--) {
			backslashCount++;
		}

		if (backslashCount % 2 === 1) {
			break;
		}

		endIndex--;
	}

	return line.slice(0, endIndex);
}

function isPathInsideOrEqual(childPath: string, parentPath: string, pathApi: PathApi) {
	const relativePath = pathApi.relative(pathApi.resolve(parentPath), pathApi.resolve(childPath));

	return relativePath === '' || (!relativePath.startsWith('..') && !pathApi.isAbsolute(relativePath));
}

function isNotFoundError(error: unknown) {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& (error as NodeJS.ErrnoException).code === 'ENOENT';
}
