# Pi InMemoryMode

[English](README.md) | **简体中文**

[![许可证：MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933.svg)](.nvmrc)
[![Pi 1.3.0](https://img.shields.io/badge/Pi-1.3.0-blue.svg)](https://github.com/earendil-works/pi)

一个用于编辑文本文件的 [Pi](https://github.com/earendil-works/pi) 扩展，提供任务内稳定的文件上下文，以及可随会话分支恢复的文件版本。

每条新任务开始时，插件将托管文件的全文放在用户指令之前。成功编辑会立即更新磁盘和工作内存，同一任务中的初始文件快照保持不变；下一任务再使用新快照。通过 Pi 原生 `/tree`，可以同时恢复文件版本和对应的会话分支。

**项目状态：**实验阶段，版本 v0.1.0；目前以源码分发，尚未发布到 npm。命令提示和通知目前使用中文。需要 **Node.js 24** 和 **Pi 1.3.0**；附带的界面兼容补丁会检查 Pi 的确切版本。

## 主要功能

- **任务内上下文稳定：**工具续答和补充指令共用同一份任务起始快照。
- **文件修改可恢复：**支持创建、编辑、移动和删除，保留原始字节、换行和普通文件权限。
- **版本跟随会话分支：**通过 `/tree` 恢复支持的检查点，原始聊天和工具记录继续保留。
- **外部修改由用户处理：**明确选择接纳外部编辑，或恢复最后有效工作状态。
- **按需检查文件：**未变化的文件复用已验证正文和哈希，近期时间戳另做内容检查；不持续监听或轮询。
- **减少后续请求中的重复正文：**在派生的模型输入中省略已完成任务的重复编辑正文，原始会话保持完整。

## 快速开始

```bash
git clone https://github.com/IntHelloWorld/pi-InMemoryMode.git
cd pi-InMemoryMode
npm ci --ignore-scripts
npm run dev
```

在新 Pi 会话的第一条聊天消息之前执行：

```text
/memory on examples/documents
```

随后输入“为这份提纲补充三个小节”等编辑要求。需要配置模型时，使用 Pi 的 `/login`。在 `/tree` 中选择已完成任务，即可恢复对应文件；选择一条用户指令会回到执行该指令之前。

InMemory 是专用会话类别，必须在聊天前创建。需要普通会话或其他托管目录时使用 `/new`。已有 InMemory 会话在 `/resume` 中显示 `[InMemory]` 标记。

### 在其他项目中使用

如果已安装全局 **Pi 1.3.0**，在克隆的插件仓库中执行：

```bash
pi install /absolute/path/to/pi-InMemoryMode
npm run setup:tree -- --global
```

重启 Pi，在自己的项目中启动，然后在第一条聊天前执行 `/memory on ./docs`。需要临时加载时，先完成兼容补丁安装，再在项目中运行 `pi -e /absolute/path/to/pi-InMemoryMode`。

`npm run dev` 和 `npm test` 会为项目依赖中的 Pi 安装界面补丁；`setup:tree -- --global` 还会处理全局 Pi，以支持检查点筛选、免摘要询问的树导航和会话类别标记。补丁校验宿主版本、保留原文件备份，不修改全局设置。**安装补丁后须重启 Pi；`/reload` 只重载扩展。**重新安装 Pi 后需重新执行。撤销补丁可运行 `npm run setup:tree -- --global --restore`，然后重启 Pi。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/memory on [目录]` | 在聊天前创建 InMemory 会话，默认绑定 Pi 当前工作目录。 |
| `/memory status` | 展示最后已知状态，不扫描文件。 |
| `/memory sync` | 接纳当前外部修改并记录文件版本。 |
| `/memory recover` | 恢复最后有效工作状态，保留助手已成功的修改。 |
| `/tree` | 恢复支持的文件检查点及对应会话分支。 |
| `/resume` | 打开已有普通会话或 InMemory 会话。 |
| `/new` | 创建新会话。 |

`sync` 和 `recover` 都会等待新指令，不自动调用模型。撤销助手修改请通过 `/tree` 选择更早的检查点。

## 外部修改和文件版本

自动检查只在新任务开始前、托管文件写入或树恢复前，以及整个任务结束前执行。比较依据是最后有效工作快照；检测到外部修改后暂停任务，等待 `sync` 或 `recover`，不静默接纳。

每次检查仍遍历目录，以发现新增、删除和移动。文件信息一致且已确认稳定时复用正文和哈希；近期时间戳保守检查内容，单纯 `touch` 不产生新文件版本。缓存只属于当前工作区实例，重载会话后在下次检查时重新建立。这一方式参考了 Git 的[索引信息](https://git-scm.com/docs/gitformat-index)和[短时间修改防漏检](https://git-scm.com/docs/racy-git)机制。

版本保存在 Pi 工作目录的 `.pi/inmemory/<工作区标识>/`，包含按 SHA-256 去重的正文、不可变文件清单、检查点和恢复日志。托管文件不需要位于 Git 仓库中，历史版本不会自动清理。

## 配置

创建 InMemory 会话前，在 **Pi 工作目录**中添加 `.pi/inmemory.json`：

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

文件必须是有效 UTF-8。`extensions` 替换默认扩展名列表，`exclude` 使用相对路径前缀，不是通配符。管理目录、依赖、构建产物和敏感账户文件会被排除，不跟随符号链接。会话创建后，托管目录和配置固定。

## 当前限制

- 界面补丁仅支持 Pi **1.3.0**。InMemory 会话不支持 `/fork`，也不能恢复到任意工具中间节点。
- 外部程序仍可修改磁盘。操作边界的检查不提供操作系统级隔离，多文件恢复使用日志，不是整个目录的原子替换。
- 快照容量使用保守的 token 估算，超过限制时停止请求，不截断正文。
- Claude 请求序列化和缓存标记位置已通过本地适配器测试；**尚未测量真实模型服务的缓存命中率和费用收益**。其他提供方保留宿主自身的缓存行为。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run smoke
```

测试使用隔离临时目录、真实 Pi SDK、确定性的模拟模型回复和官方 Anthropic 序列化器。CLI/RPC 冒烟测试不调用模型，不修改个人 Pi 配置。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```text
extension.ts          Pi 扩展入口
src/                  工作区、版本、工具、上下文和会话集成
tests/                功能与集成测试
scripts/              可撤销的 Pi 界面兼容补丁
examples/documents/   小型示例工作区
docs/                 使用、设计和实现说明
smoke.mjs             CLI/RPC 冒烟测试
```

## 文档

- [详细使用说明](docs/usage.zh-CN.md)
- [设计基线](docs/design.md)：原始设计和验收要求。
- [实现与验证记录](docs/implementation.md)：当前行为和验证边界。
- [Pi 扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

## 许可证

[MIT](LICENSE) © 2026 IntHelloWorld。上游代码说明见[第三方声明](THIRD_PARTY_NOTICES.md)。
