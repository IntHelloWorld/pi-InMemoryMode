# Pi InMemoryMode

**English** | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933.svg)](.nvmrc)
[![Pi 1.3.0](https://img.shields.io/badge/Pi-1.3.0-blue.svg)](https://github.com/earendil-works/pi)

A [Pi](https://github.com/earendil-works/pi) extension for editing text documents with a stable task context and recoverable file versions.

At the start of each user task, InMemoryMode places the managed files' full text before the instruction. Successful edits update files and working memory immediately, while the initial snapshot stays fixed for that task. The next task receives a fresh snapshot. Pi's native `/tree` restores the corresponding files and conversation branch together.

**Status:** experimental, v0.1.0. Distributed as source; not published to npm. Commands and notices are currently in Chinese. Requires **Node.js 24** and **Pi 1.3.0**; the included UI compatibility patch checks that exact Pi version.

## Features

- **Stable task context:** tool continuations and additional instructions share the same starting snapshot.
- **Recoverable editing:** create, edit, move, and delete files while preserving original bytes, line endings, and ordinary permissions.
- **Branch-aware history:** restore supported checkpoints with `/tree`; original chat and tool records remain intact.
- **Explicit external changes:** choose whether to accept an external edit or restore the last valid working state.
- **On-demand file checks:** reuse verified content and hashes for unchanged files, with additional checks for recent timestamps. No file watcher or polling.
- **Smaller later requests:** omit repeated edit bodies from completed tasks in the derived model input, preserving raw session history.

## Quick start

```bash
git clone https://github.com/IntHelloWorld/pi-InMemoryMode.git
cd pi-InMemoryMode
npm ci --ignore-scripts
npm run dev
```

Before the first chat message in the new Pi session, run:

```text
/memory on examples/documents
```

Then ask Pi to edit the example, such as “Add three sections to this outline.” Configure your model through Pi's `/login` if needed. Use `/tree` to select a completed task and restore its files. Selecting a user instruction returns to the state before that instruction.

InMemory is a dedicated session type. Create it before chatting; use `/new` for an ordinary session or a different managed directory. Existing InMemory sessions have an `[InMemory]` badge in `/resume`.

### Use in another project

If you already use a globally installed **Pi 1.3.0**, run these commands from the cloned repository:

```bash
pi install /absolute/path/to/pi-InMemoryMode
npm run setup:tree -- --global
```

Restart Pi, open it in your project, and run `/memory on ./docs` before the first chat message. For a temporary load, first prepare the compatibility patch, then run `pi -e /absolute/path/to/pi-InMemoryMode` in your project.

`npm run dev` and `npm test` install the UI patch into the project's local Pi dependency. `setup:tree -- --global` also patches the global installation, enabling checkpoint filtering, direct tree navigation without a summary dialog, and session badges. It validates the host version, keeps original-file backups, and does not change global settings. **Restart Pi after patching; `/reload` only reloads the extension.** Reapply after reinstalling Pi. To undo the patch, run `npm run setup:tree -- --global --restore` and restart Pi.

## Commands

| Command | Purpose |
| --- | --- |
| `/memory on [directory]` | Create an InMemory session before chatting; defaults to Pi's working directory. |
| `/memory status` | Show the last known state without scanning files. |
| `/memory sync` | Accept current external changes and record their file version. |
| `/memory recover` | Restore the last valid working state, retaining successful assistant edits. |
| `/tree` | Restore a supported file checkpoint and its conversation branch. |
| `/resume` | Open an existing ordinary or InMemory session. |
| `/new` | Start a new session. |

`sync` and `recover` wait for a new instruction; neither automatically calls the model. To undo assistant edits, select an earlier checkpoint in `/tree`.

## External edits and file versions

Automatic checks run before a new task, before a managed write or tree restore, and before task completion. They compare disk files against the last valid working snapshot. Detected external changes pause the task and require `sync` or `recover`; they are never silently accepted.

Checks still traverse directories to discover added, removed, or moved files. Verified file information allows unchanged bodies and hashes to be reused. Recent timestamps receive conservative content checks, and a plain `touch` does not create a new file version. The cache is local to a workspace instance and is rebuilt at the next check after reloading a session. This follows Git's [index metadata](https://git-scm.com/docs/gitformat-index) and [racy timestamp](https://git-scm.com/docs/racy-git) principles.

Versions are stored under `.pi/inmemory/<workspace-id>/` in Pi's working directory, using SHA-256 content objects, immutable manifests, checkpoints, and recovery journals. No Git repository is required for the managed documents. History is not automatically deleted.

## Configuration

Create `.pi/inmemory.json` in **Pi's working directory** before creating the InMemory session:

```json
{
  "extensions": [".md", ".txt", ".json", ".yaml", ".yml", ".toml"],
  "exclude": ["archive", "drafts/old.md"],
  "includeHidden": false,
  "maxFiles": 100,
  "maxFileBytes": 262144,
  "maxTotalBytes": 1048576,
  "maxSnapshotTokens": 32768
}
```

Files must be valid UTF-8. `extensions` replaces the default list; `exclude` contains relative path prefixes, not globs. Management directories, dependencies, build output, and sensitive account files are excluded. Symlinks are not followed. A session's directory and configuration are fixed when it is created.

## Limitations

- The UI patch supports Pi **1.3.0** only. InMemory sessions do not support `/fork` or arbitrary intermediate tool checkpoints.
- External processes can still write to disk. Boundary checks do not provide operating-system isolation, and multi-file recovery uses journals rather than a directory-wide atomic replacement.
- Snapshot capacity uses a conservative token estimate. Requests stop when limits are exceeded; file bodies are not truncated.
- Claude request serialization and cache-marker placement are covered by local adapter tests. **Live-provider cache hit rates and cost savings have not been measured.** Other providers retain the host's cache behavior.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run smoke
```

Tests use isolated temporary directories, the real Pi SDK, deterministic simulated model responses, and the official Anthropic serializer. The CLI/RPC smoke test does not call a model or alter personal Pi settings. See [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions.

```text
extension.ts          Pi extension entry point
src/                  Workspace, versions, tools, context, and session integration
tests/                Functional and integration tests
scripts/              Reversible Pi UI compatibility patch
examples/documents/   Small sample workspace
docs/                 Usage, design, and implementation notes
smoke.mjs             CLI/RPC smoke test
```

## Documentation

- [Detailed usage guide (中文)](docs/usage.zh-CN.md)
- [Design baseline (中文)](docs/design.md) — original design and acceptance criteria.
- [Implementation and validation (中文)](docs/implementation.md) — current behavior and verification boundaries.
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

## License

[MIT](LICENSE) © 2026 IntHelloWorld. See [third-party notices](THIRD_PARTY_NOTICES.md) for upstream attribution.
