# Pi 插件开发环境

这是一个独立的 Pi 扩展项目，不是 Pi 核心的 fork。当前仅提供开发环境和用于确认加载成功的 `/plugin-dev` 命令，尚未实现 InMemoryMode 功能。

## 本机启动

```bash
cd /Users/cue/pi-InMemoryMode
npm run dev
```

进入 Pi 后输入 `/plugin-dev`，应显示插件已加载的通知。修改 `extension.ts` 后，在 Pi 中执行 `/reload` 重新加载。

本机已单独安装 Pi，可在任意工作目录运行 `pi`。模型账号通过 Pi 内的 `/login` 配置；验证插件加载不需要账号或模型调用。

## 安装与检查

使用 Node.js 24 LTS（版本见 `.nvmrc`），然后执行：

```bash
npm ci --ignore-scripts
npm run check
npm run smoke
```

`smoke` 在临时配置目录中启动 Pi，通过 RPC 验证包发现、命令注册、命令执行和通知。它使用 `--no-session`，不调用模型，也不写入个人 Pi 配置。

## 项目结构

- `extension.ts`：扩展入口，导出接收 `ExtensionAPI` 的函数。
- `package.json`：`pi.extensions` 声明扩展入口；Pi 是宿主提供的 peer dependency，同时作为开发依赖提供 CLI 和类型。
- `tsconfig.json`：严格类型检查，不生成编译产物；Pi 直接加载 TypeScript。
- `smoke.mjs`：不依赖模型的加载验证。
- `.dev/`：仅本机保留的参考资料，不进入 GitHub 或 npm 包。

## 在其他工作目录试用

```bash
pi -e /Users/cue/pi-InMemoryMode
```

需要长期安装时，可以在 Pi 所在环境中执行 `pi install /Users/cue/pi-InMemoryMode`。开发阶段使用 `-e` 即可。

## 官方资料

- [扩展接口与示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [插件包结构与依赖约定](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [RPC 命令](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)

`private: true` 表示当前是开发工程；准备发布到 npm 时再补齐发布信息并移除此字段。
