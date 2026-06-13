import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
	addTargetsToGitignore,
	appendMissingGitignorePatterns,
	createGitignoreEntry,
	findNearestGitignore,
	findRepositoryRoot,
	toGitignorePattern,
} from '../gitignore';
import type { GitignoreFileSystem } from '../gitignore';

class MemoryGitignoreFileSystem implements GitignoreFileSystem {
	private readonly files = new Map<string, string>();
	private readonly directories = new Set<string>();

	constructor(private readonly pathApi: typeof path.posix = path.posix) {}

	addFile(filePath: string, content = '') {
		this.files.set(this.normalize(filePath), content);
		this.addDirectory(this.pathApi.dirname(filePath));
	}

	addDirectory(directoryPath: string) {
		this.directories.add(this.normalize(directoryPath));
	}

	getFile(filePath: string) {
		return this.files.get(this.normalize(filePath));
	}

	async stat(filePath: string) {
		const normalizedPath = this.normalize(filePath);

		if (this.files.has(normalizedPath)) {
			return { isDirectory: false };
		}

		if (this.directories.has(normalizedPath)) {
			return { isDirectory: true };
		}

		return undefined;
	}

	async readFile(filePath: string) {
		return this.getFile(filePath);
	}

	async writeFile(filePath: string, content: string) {
		this.addFile(filePath, content);
	}

	private normalize(filePath: string) {
		return this.pathApi.resolve(filePath);
	}
}

suite('extension manifest', () => {
	test('contributes the Explorer context menu command for local and remote workspace resources', () => {
		const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
		const menuItems = manifest.contributes.menus['explorer/context'];
		const addCommand = menuItems.find((item: { command: string }) => item.command === 'add-to-gitignore.add');

		assert.ok(addCommand);
		assert.strictEqual(addCommand.when, "resourceScheme == 'file' || resourceScheme == 'vscode-remote'");
		assert.deepStrictEqual(manifest.extensionKind, ['workspace']);
	});
});

suite('gitignore pattern generation', () => {
	test('anchors file and directory patterns to the selected .gitignore directory', () => {
		assert.strictEqual(toGitignorePattern('dist', true, path.posix.sep), '/dist/');
		assert.strictEqual(toGitignorePattern('src/generated.js', false, path.posix.sep), '/src/generated.js');
	});

	test('converts Windows path separators to gitignore separators', () => {
		assert.strictEqual(toGitignorePattern('build\\out.log', false, path.win32.sep), '/build/out.log');
		assert.strictEqual(toGitignorePattern('build\\cache', true, path.win32.sep), '/build/cache/');
	});

	test('keeps a POSIX backslash as a literal filename character', () => {
		assert.strictEqual(toGitignorePattern('dir\\name', false, path.posix.sep), '/dir\\\\name');
	});

	test('escapes glob, comment, negation, and whitespace characters', () => {
		assert.strictEqual(
			toGitignorePattern('weird #![a]*?.txt', false, path.posix.sep),
			'/weird\\ \\#\\!\\[a\\]\\*\\?.txt',
		);
		assert.strictEqual(toGitignorePattern('name ', false, path.posix.sep), '/name\\ ');
		assert.strictEqual(toGitignorePattern('tabs\ttoo.log', false, path.posix.sep), '/tabs\\\ttoo.log');
	});

	test('rejects root-relative entries that cannot ignore the root itself', () => {
		assert.throws(() => toGitignorePattern('', true, path.posix.sep), /root folder/);
		assert.throws(() => toGitignorePattern('.', true, path.posix.sep), /root folder/);
	});

	test('rejects paths outside the .gitignore directory', () => {
		assert.throws(() => toGitignorePattern('../secrets.env', false, path.posix.sep), /outside/);
		assert.throws(() => toGitignorePattern('..\\secrets.env', false, path.win32.sep), /outside/);
	});

	test('rejects absolute and invalid relative paths', () => {
		assert.throws(() => toGitignorePattern('/tmp/file', false, path.posix.sep), /relative path/);
		assert.throws(() => toGitignorePattern('C:\\tmp\\file', false, path.win32.sep), /relative path/);
		assert.throws(() => toGitignorePattern('src//file', false, path.posix.sep), /invalid/);
	});

	test('rejects file names containing line breaks', () => {
		assert.throws(() => toGitignorePattern('bad\nname', false, path.posix.sep), /line breaks/);
		assert.throws(() => toGitignorePattern('bad\rname', false, path.posix.sep), /line breaks/);
	});
});

suite('gitignore content updates', () => {
	test('writes a newline-terminated pattern to an empty file', () => {
		const result = appendMissingGitignorePatterns('', ['/dist/']);

		assert.deepStrictEqual(result.addedPatterns, ['/dist/']);
		assert.deepStrictEqual(result.unchangedPatterns, []);
		assert.strictEqual(result.content, '/dist/\n');
	});

	test('appends after an existing final newline', () => {
		const result = appendMissingGitignorePatterns('/node_modules/\n', ['/dist/']);

		assert.strictEqual(result.content, '/node_modules/\n/dist/\n');
	});

	test('adds a separator when the existing file has no final newline', () => {
		const result = appendMissingGitignorePatterns('/node_modules/', ['/dist/']);

		assert.strictEqual(result.content, '/node_modules/\n/dist/\n');
	});

	test('preserves CRLF line endings from existing content', () => {
		const result = appendMissingGitignorePatterns('/node_modules/\r\n', ['/dist/']);

		assert.strictEqual(result.content, '/node_modules/\r\n/dist/\r\n');
	});

	test('does not add an exact duplicate pattern', () => {
		const result = appendMissingGitignorePatterns('/dist/\n', ['/dist/']);

		assert.deepStrictEqual(result.addedPatterns, []);
		assert.deepStrictEqual(result.unchangedPatterns, ['/dist/']);
		assert.strictEqual(result.content, '/dist/\n');
	});

	test('does not add a directory pattern when an existing file-or-directory pattern already covers it', () => {
		const result = appendMissingGitignorePatterns('/dist\n', ['/dist/']);

		assert.deepStrictEqual(result.addedPatterns, []);
		assert.deepStrictEqual(result.unchangedPatterns, ['/dist/']);
		assert.strictEqual(result.content, '/dist\n');
	});

	test('treats unescaped trailing spaces as insignificant for duplicate checks', () => {
		const result = appendMissingGitignorePatterns('/dist/  \n', ['/dist/']);

		assert.deepStrictEqual(result.addedPatterns, []);
		assert.deepStrictEqual(result.unchangedPatterns, ['/dist/']);
		assert.strictEqual(result.content, '/dist/  \n');
	});

	test('keeps escaped trailing spaces significant', () => {
		const result = appendMissingGitignorePatterns('/name\\ \n', ['/name']);

		assert.deepStrictEqual(result.addedPatterns, ['/name']);
		assert.strictEqual(result.content, '/name\\ \n/name\n');
	});

	test('deduplicates repeated patterns in one update', () => {
		const result = appendMissingGitignorePatterns('', ['/dist/', '/dist/', '/coverage/']);

		assert.deepStrictEqual(result.addedPatterns, ['/dist/', '/coverage/']);
		assert.deepStrictEqual(result.unchangedPatterns, ['/dist/']);
		assert.strictEqual(result.content, '/dist/\n/coverage/\n');
	});

	test('ignores a UTF-8 byte order mark when checking the first line', () => {
		const result = appendMissingGitignorePatterns('\uFEFF/dist/\n', ['/dist/']);

		assert.deepStrictEqual(result.addedPatterns, []);
		assert.deepStrictEqual(result.unchangedPatterns, ['/dist/']);
	});
});

suite('gitignore file selection', () => {
	test('finds the nearest repository root by .git directory', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');

		assert.strictEqual(await findRepositoryRoot('/repo/src/deep', fileSystem, path.posix), '/repo');
	});

	test('finds a repository root when .git is a file', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addFile('/repo/.git', 'gitdir: ../.git/modules/repo\n');

		assert.strictEqual(await findRepositoryRoot('/repo/src', fileSystem, path.posix), '/repo');
	});

	test('returns undefined when no repository root exists', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();

		assert.strictEqual(await findRepositoryRoot('/workspace/src', fileSystem, path.posix), undefined);
	});

	test('uses the nearest existing .gitignore under the repository root', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');
		fileSystem.addFile('/repo/.gitignore');
		fileSystem.addFile('/repo/src/.gitignore');

		assert.strictEqual(await findNearestGitignore('/repo/src/lib', '/repo', fileSystem, path.posix), '/repo/src/.gitignore');
	});

	test('does not search above the repository root for .gitignore files', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addFile('/.gitignore');

		assert.strictEqual(await findNearestGitignore('/repo/src', '/repo', fileSystem, path.posix), undefined);
	});

	test('uses a nested .gitignore for a file inside that directory', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');
		fileSystem.addFile('/repo/.gitignore');
		fileSystem.addFile('/repo/app/.gitignore');

		const entry = await createGitignoreEntry({
			path: '/repo/app/debug.log',
			workspaceRoot: '/repo',
			isDirectory: false,
		}, fileSystem, path.posix);

		assert.strictEqual(entry.gitignorePath, '/repo/app/.gitignore');
		assert.strictEqual(entry.pattern, '/debug.log');
	});

	test('uses the parent .gitignore when adding a folder that contains its own .gitignore', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');
		fileSystem.addFile('/repo/app/.gitignore');
		fileSystem.addFile('/repo/app/cache/.gitignore');

		const entry = await createGitignoreEntry({
			path: '/repo/app/cache',
			workspaceRoot: '/repo',
			isDirectory: true,
		}, fileSystem, path.posix);

		assert.strictEqual(entry.gitignorePath, '/repo/app/.gitignore');
		assert.strictEqual(entry.pattern, '/cache/');
	});

	test('creates a repository-root .gitignore when no applicable .gitignore exists', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');

		const result = await addTargetsToGitignore([{
			path: '/repo/app/cache',
			workspaceRoot: '/repo',
			isDirectory: true,
		}], fileSystem, path.posix);

		assert.deepStrictEqual(result.changedGitignorePaths, ['/repo/.gitignore']);
		assert.strictEqual(fileSystem.getFile('/repo/.gitignore'), '/app/cache/\n');
	});

	test('falls back to the workspace root when no Git repository exists', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();

		const result = await addTargetsToGitignore([{
			path: '/workspace/logs/app.log',
			workspaceRoot: '/workspace',
			isDirectory: false,
		}], fileSystem, path.posix);

		assert.deepStrictEqual(result.changedGitignorePaths, ['/workspace/.gitignore']);
		assert.strictEqual(fileSystem.getFile('/workspace/.gitignore'), '/logs/app.log\n');
	});

	test('can write to a repository root above the opened workspace folder', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');

		const entry = await createGitignoreEntry({
			path: '/repo/packages/pkg/dist',
			workspaceRoot: '/repo/packages/pkg',
			isDirectory: true,
		}, fileSystem, path.posix);

		assert.strictEqual(entry.gitignorePath, '/repo/.gitignore');
		assert.strictEqual(entry.pattern, '/packages/pkg/dist/');
	});

	test('uses an existing .gitignore above the opened workspace folder', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');
		fileSystem.addFile('/repo/packages/.gitignore');

		const entry = await createGitignoreEntry({
			path: '/repo/packages/pkg/dist',
			workspaceRoot: '/repo/packages/pkg',
			isDirectory: true,
		}, fileSystem, path.posix);

		assert.strictEqual(entry.gitignorePath, '/repo/packages/.gitignore');
		assert.strictEqual(entry.pattern, '/pkg/dist/');
	});

	test('keeps Windows relative paths anchored and slash-normalized', async () => {
		const fileSystem = new MemoryGitignoreFileSystem(path.win32);
		fileSystem.addDirectory('C:\\repo\\.git');
		fileSystem.addFile('C:\\repo\\src\\.gitignore');

		const entry = await createGitignoreEntry({
			path: 'C:\\repo\\src\\generated\\file[1].js',
			workspaceRoot: 'C:\\repo',
			isDirectory: false,
		}, fileSystem, path.win32);

		assert.strictEqual(entry.gitignorePath, 'C:\\repo\\src\\.gitignore');
		assert.strictEqual(entry.pattern, '/generated/file\\[1\\].js');
	});

	test('does not rewrite an unchanged .gitignore', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');
		fileSystem.addFile('/repo/.gitignore', '/dist/\n');

		const result = await addTargetsToGitignore([{
			path: '/repo/dist',
			workspaceRoot: '/repo',
			isDirectory: true,
		}], fileSystem, path.posix);

		assert.deepStrictEqual(result.addedPatterns, []);
		assert.strictEqual(result.unchangedPatterns.length, 1);
		assert.deepStrictEqual(result.changedGitignorePaths, []);
		assert.strictEqual(fileSystem.getFile('/repo/.gitignore'), '/dist/\n');
	});

	test('reports duplicate selected paths once as added and once as unchanged', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();
		fileSystem.addDirectory('/repo/.git');

		const target = {
			path: '/repo/dist',
			workspaceRoot: '/repo',
			isDirectory: true,
		};
		const result = await addTargetsToGitignore([target, target], fileSystem, path.posix);

		assert.strictEqual(result.addedPatterns.length, 1);
		assert.strictEqual(result.unchangedPatterns.length, 1);
		assert.strictEqual(fileSystem.getFile('/repo/.gitignore'), '/dist/\n');
	});

	test('rejects trying to ignore the workspace root from its own .gitignore', async () => {
		const fileSystem = new MemoryGitignoreFileSystem();

		await assert.rejects(
			() => createGitignoreEntry({
				path: '/workspace',
				workspaceRoot: '/workspace',
				isDirectory: true,
			}, fileSystem, path.posix),
			/root folder/,
		);
	});
});
