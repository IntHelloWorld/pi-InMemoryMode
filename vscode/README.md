# Pi InMemory for VS Code

A lightweight companion extension: keep Pi in the integrated terminal while VS Code shows managed files and external changes, opens editable diffs, and shares selected text with Pi.

This directory is an independent extension project with its own dependencies, build, tests and VSIX package. Develop it alongside the Pi plugin at the repository root. **v0.1.5 is distributed as source and a local VSIX; it is not published to the Marketplace.**

## Features

- **Pi: Start Terminal Session** starts Pi in an integrated terminal. The status bar shows the selected session, activity and managed file count. Select another session or focus its terminal at any time.
- **Pi: Show Logs** opens the **Pi InMemory** Output channel with startup paths, connections, state changes, operation results and errors.
- Right-click a folder and choose **Pi: Mount Directory in New Session**. Each dedicated InMemory session mounts one directory.
- Managed files, the mount directory and relevant parent folders show `M`. Detected external changes show `!`. Excluded files remain unmarked.
- The **Mounted Files** view lists managed files and pending additions, modifications and deletions. Deleted files still have a diff.
- Pending changes automatically open in one native multi-file review. The original side is the last accepted Pi version; existing files on the modified side are editable. **Pi: Open All Pending Diffs** reuses the existing review, including unsaved edits and view position. A closed review can be reopened; changes to the file list refresh the container while preserving unsaved buffers.
- **Continue (Accept Resolved Files)** saves managed edits, checks the disk and asks to accept the entire directory. **Recover (Discard External Changes)** asks to discard external and unsaved managed edits, preserving successful assistant edits. Use `/tree` in Pi to undo earlier assistant changes.
- While a decision is pending, both actions remain visible as text rows in the sidebar, in editor context menus and in the editor toolbar. The status bar also provides **Pi: Recover**. Editing or saving a diff does not hide Recover.
- **Pi: Add Selection to Input** and **Pi: Send Selection** include the file path, line range and exact selected text. Existing drafts, a busy Pi or pending recovery cause the selection to be kept as a draft. Unsaved selections are identified explicitly; sharing does not save files. Drafts survive Pi reloads.

All extension UI, messages, logs and selection metadata use English. Selected content, filenames and user-defined session names retain their original text. Explorer decorations also depend on your theme, other extensions and `explorer.decorations.colors` / `explorer.decorations.badges` settings.

## Requirements

- Local desktop VS Code **1.100 or later**. Browser, SSH, WSL, container and other remote workspaces are not supported in this version.
- Node.js **24**, Pi **1.3.0**, the current root Pi plugin and its UI compatibility patch. See the [root README](../README.md).
- Open and trust a local project folder in VS Code.

## Build and install

First prepare the root Pi plugin:

```bash
npm ci --ignore-scripts
npm run setup:tree
```

Then, in this directory:

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run package
```

Choose **Extensions: Install from VSIX** and select `pi-inmemory-vscode-0.1.5.vsix`, or run:

```bash
code --install-extension pi-inmemory-vscode-0.1.5.vsix
```

This installs the VS Code extension. Install the Pi plugin separately, or point `pluginPath` below to the repository. A global Pi installation also needs the root compatibility patch; restart Pi after applying that patch.

## Configuration

Set these VS Code user settings:

```json
{
  "piInMemory.executable": "/absolute/path/to/pi",
  "piInMemory.nodeExecutable": "/absolute/path/to/node",
  "piInMemory.pluginPath": "/absolute/path/to/pi-InMemoryMode",
  "piInMemory.arguments": []
}
```

- `executable` defaults to `pi`. Use an absolute executable path if VS Code cannot find it.
- `nodeExecutable` is optional. When empty, the extension looks alongside Pi, then on PATH and in common installation directories. The resolved executable directories are added to the terminal PATH, including when VS Code was launched from the GUI. An explicit path can resolve `env: node: No such file or directory` / exit code 127.
- `pluginPath` is optional. When empty, Pi uses its installed plugin. An absolute repository path adds `-e` to Pi startup arguments.
- Each item in `arguments` is passed separately, without shell interpolation. Paths do not need extra quoting.
- `piInMemory.autoOpenChanges` defaults to `true`: open all diffs once per pending stage. When disabled, open them manually from the sidebar or command palette.

## Usage

1. Right-click a directory and choose **Pi: Mount Directory in New Session**. The extension waits for the Pi plugin to confirm the mount.
2. Work in the Pi terminal using normal instructions and Pi commands such as `/login`, `/tree` and `/resume`.
3. Select editor text and choose **Pi: Add Selection to Input** to review or extend it in Pi, or **Pi: Send Selection** to submit it when Pi is idle and the input is empty.
4. After external edits, run **Pi: Check External Changes**, or let a Pi operation boundary detect them. Edit the modified files in the review, then use **Continue** to accept or **Recover** to discard the external changes. Both decisions confirm the impact on the entire directory.

Continue follows `/inmem sync`; Recover follows `/inmem recover`. Afterwards, the pending instruction returns to the Pi input. **Send it again to start the task; the model does not run automatically.** There is no `/inmem continue` terminal command. Reviews compare external changes; they do not add Git conflict markers or perform a three-way merge.

You can also start Pi with **Pi: Start Terminal Session**, then run `/inmem on [directory]` before the first chat message. A manually started terminal Pi is discoverable when it loads the current plugin. Select the intended session when several are running. On first use, **Pi: Focus Session Terminal** may ask which terminal belongs to a manually started session; that association only controls focus.

For plain `pi` launches, install the plugin with `pi install /absolute/path/to/pi-InMemoryMode`, then restart Pi or run `/reload`. The VS Code `pluginPath` setting only affects terminals started by the extension. Plugin commands use `/inmem`; the old `/memory` name is not registered, so other plugins can use it.

If startup fails or Pi is disconnected, run **Pi: Show Logs**, or choose **Pi InMemory** in **View > Output**. State polling only logs changes; it does not repeatedly log unchanged status.

## File state and review behavior

- `M` identifies files recorded as managed by Pi. New disk files may remain unmarked until checked.
- `!` identifies detected external changes awaiting a decision. It does not mean a Git merge conflict or automatic background synchronization.
- The sidebar shows the last inspection time. Connection refresh reads existing Pi state; it does not scan managed files. Scans occur at documented Pi boundaries or on an explicit check.
- The original version stays fixed. Existing modified files use the current disk/editor buffer; saving alone does not accept them into Pi working memory. Deleted or unreadable files use the last inspected read-only version until checked or recovered.
- VS Code can display diffs side by side or inline with removed and added lines. `diffEditor.renderSideBySide` controls the preference; `diffEditor.useInlineViewWhenSpaceIsLimited` allows an inline view in narrow windows. The line-level revert arrow only changes that section; use **Pi: Recover** for the directory decision.
- Continue saves managed edits and checks again before asking for acceptance. Cancelling that confirmation keeps those saved edits without accepting them or calling the model. Recover discards unsaved managed edits only after confirmation. If the disk changes after a final decision, Pi updates the list and rejects the stale request.
- Exiting Pi or losing the connection clears active file decorations. File history remains under the project’s `.pi/inmemory/` directory.

## Development

See the [development guide](docs/development.md) for architecture, protocol, tests, debugging and manual acceptance checks.

## License

[MIT](LICENSE). Uses the native VS Code extension interfaces and does not bundle VS Code or Pi.
