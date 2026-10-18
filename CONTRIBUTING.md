# Contributing

Issues and pull requests are welcome. Please describe the observed behavior, expected behavior, reproduction steps, and Node.js/Pi versions. Remove credentials and private document contents from reports and logs.

## Development setup

Use Node.js 24, with the version in `.nvmrc` as the reference:

```bash
npm ci --ignore-scripts
npm run dev
```

The development command applies a reversible compatibility patch to the local Pi 1.3.0 dependency. It does not patch global Pi unless you explicitly run `npm run setup:tree -- --global`.

Before submitting a change, run:

```bash
npm run check
npm test
npm run smoke
```

Tests run in temporary directories with simulated model responses. No model account is required. `npm test` prepares the local Pi compatibility patch before running the tests.

## Implementation conventions

- Keep TypeScript strict and use the existing two-space indentation and `.ts` import extensions.
- Use English for plugin and VS Code UI, notifications, logs, tool descriptions and model-facing metadata. Preserve user text and filenames. Pi commands belong to `/inmem`; leave `/memory` unregistered so other plugins can use it.
- Declare Pi's host-provided SDK packages and `typebox` in `peerDependencies` with a `"*"` range, never in runtime `dependencies`. Pin local build/test versions in `devDependencies`; compatibility remains limited to the Pi version checked by the UI patch.
- Test behavior and outcomes. Avoid tests that only match implementation strings.
- Keep workspace mutations serialized and preserve recovery journals on failure.
- Keep a task's model-facing baseline fixed. Successful edits update working memory immediately; the next task gets a fresh baseline.
- Preserve original session messages and tool call/result pairs. Context projection must not rewrite raw history.
- Detect external changes at the documented boundaries, require explicit acceptance or recovery, and do not add background monitoring.
- Keep the English and Chinese READMEs aligned when behavior or setup instructions change. Record verification limits honestly, including the distinction between simulated and live-provider results.

## Pull requests

Explain the problem, resulting behavior, and relevant verification. Keep changes focused and include functional tests when the behavior warrants them. For UI compatibility changes, verify the exact Pi version and include a way to restore the original host files.

## 中文说明

欢迎提交 Issue 和 PR。请提供实际行为、预期行为、复现步骤以及 Node.js/Pi 版本，报告中不要包含密钥或私人文档。

使用 Node.js 24，通过上面的命令安装依赖、运行和检查。测试使用临时目录与模拟模型，不需要模型账号。优先测试功能结果，保留任务内冻结快照、原始会话记录、外部修改确认和失败恢复规则。修改行为或安装流程时，请同步更新中英文 README。
