# Add to Gitignore Button

Adds selected files and folders to the applicable `.gitignore` from the VS Code Explorer context menu.

## Behavior

- Right-click one or more files or folders in Explorer and run **Add to .gitignore**.
- Uses the nearest existing `.gitignore` that can ignore the selected item.
- Creates a repository-root `.gitignore` when none exists.
- Falls back to the workspace-root `.gitignore` when the workspace is not inside a Git repository.
- Writes anchored patterns with forward slashes, escaped glob characters, escaped whitespace, and trailing slashes for directories.
- Avoids duplicate exact patterns and preserves existing line endings.

## Development

```sh
npm run compile
npm run lint
npm test
npm run package
```

The tests cover POSIX paths, Windows paths, nested `.gitignore` files, repositories above the opened workspace folder, duplicate selections, line endings, escaping, and invalid paths.

Run `npm run test:vscode` only when you need to launch the full VS Code extension test host. In WSL, that requires the VS Code/Electron native Linux libraries to be installed.

## Publishing

```sh
npm run package
npm run publish
```

The extension is published from `https://github.com/VastBlast/vscode-add-to-gitignore` under the `VastBlast` publisher.
