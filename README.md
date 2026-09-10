# Codex Model Manager for Windows

一个面向 Windows 的 Codex 渠道、API Key、模型目录与本地协议适配管理器。当前版本：**1.2.108**。

项目目标是在切换 OpenAI Responses、Chat Completions 和兼容 NewAPI 渠道时，尽量保留 Codex 桌面端原有的项目、历史任务、本地工具与 Agent Loop。

## 主要能力

- 从 NewAPI 账号或手动渠道读取当前 Key 实际可见的模型，不使用固定“三模型”列表。
- 图片生成仅使用 NewAPI 返回的 ChatGPT/OpenAI 图片模型（例如 `gpt-image-*` 或 `dall-e-*`），并按 OpenAI 图片接口契约校验、保存到 `data/generated-images`；不会注入其他供应商专用参数或协议。
- NewAPI 登录页默认使用 `https://ainiubi.org`，也可以改为其他兼容平台地址。
- 对每个模型执行聊天、流式、工具调用和工具结果续答检测；未知接口明确标记为暂不支持。
- 在 Codex 内通过原生可见槽位切换已验证模型，并保持真实上游模型路由。
- NewAPI 同步与手动模型列表只显示 ChatGPT/OpenAI 模型；Codex 原生 Responses/Chat Completions 传输保持透明，不再为其他模型注入专用适配层。
- NewAPI 渠道直接使用平台返回的原始模型 ID 和平台地址，启用不依赖检测，也不启动本地回环代理；图片功能暂不参与这条直连流程。
- “恢复初始 Codex”会先停止受管理的 Codex 客户端，按首次快照恢复 `config.toml`，清除当前登录、模型索引和管理器状态，并保留会话记录与项目文件夹；界面会报告未能清理的环境变量或索引文件。
- 对话删除默认只清理会话记录、项目配置和全局索引，不删除项目文件夹；“清理项目文件夹”是单独的二次确认操作。索引删除失败时会执行有界的 SQLite 文件清理并报告结果。
- 上游 5xx 会被转换为结构化 `response.incomplete`（`upstream_server_error`），仅进行一次有界重试并记录脱敏的请求 ID、重试次数和等待时间，避免把上游故障误显示成模型正文。
- 保留 Codex 的 `sessions`、Projects、Skills、Agents 和登录配置；历史任务目录会同步为 Codex 桌面端 Local Projects，导入、导出和删除操作包含隔离与失败回滚。
- 对话管理可粘贴任务 UUID 或从对话行恢复未完成任务：用户确认后先检查最后一轮、工作区和 Git 现场，再继续原任务；只有恢复尚未开始且会话记录不可用时才 Fork 一次。认证、额度、权限、网络或高负载错误不会自动重试。
- 原生 Responses 的 refusal、空输出、incomplete、工具调用和连接错误均原样交给 Codex；管理器不会监视任务终态、自动写入“继续”、创建额外回合或在后台恢复任务。
- 管理器自己的设置、日志和更新文件只写入客户端目录下的 `data`，发布包不携带开发机数据。
- 提供中文错误提示、启动进度、关闭行为选择和 GitHub Release 在线更新。
- 主界面聚焦模型切换；在线插件市场已移除，避免无关远程资源影响启动和安全边界。

## 系统要求

- Windows 10/11 x64。
- 管理器安装包可独立运行，不要求目标电脑安装 Node.js 或 npm。
- 使用 Codex 对话、项目和本地工具前，目标电脑仍需安装可用的 Codex 桌面客户端。
- 上游渠道需要用户自行提供有效地址和凭据；仓库与 Release 不包含任何 API Key、Cookie 或登录态。

## 安装

从仓库的 Releases 页面下载 `ChatGPT-Model-Manager-Setup-<版本>-x64.exe`。安装向导允许自行选择安装目录；静默在线更新会继续覆盖当前程序目录并保留其中的 `data` 用户数据。1.2.79 起，兼容的后续版本优先下载约 2–3 MB 的 `app.asar` 轻量补丁；补丁缺失、校验失败、运行时不兼容或启动回滚时自动改用完整安装包。

Windows 可能会对未签名的安装包显示 SmartScreen 提示。当前项目没有商业代码签名证书，请只从本仓库的 Release 下载，并核对 Release 资产信息。

## 从源码开发

```powershell
npm ci
npm run desktop
```

### 源码热更新（开发模式）

源码提交推送到 GitHub 后，开发工作区可以直接拉取并继续使用 Next.js 热重载：

```powershell
git pull --ff-only
npm ci
npm run desktop
```

如果 `package-lock.json` 没有变化，可以继续使用现有依赖并省略 `npm ci`。这里的“热更新”仅适用于源码开发模式；已经安装的客户端只会读取 GitHub Release，仍需等待对应版本安装包发布。

生产构建与安装包：

```powershell
npm run build
npm run dist
npm run dist:installer
```

## 质量门禁

```powershell
npm run lint
npx tsc --noEmit
npm run test:modules
npm run test:core
npm run test:wire
npm run build
npm run dist
npm run test:packaged-ui
npm run test:installer
```

`test:live-proxy` 会调用真实外部渠道，只应使用隔离测试账号和明确允许消耗的额度；常规 CI 不执行该命令。

## 数据与隐私

- 管理器数据：`<客户端目录>\data`。
- Codex 官方数据：默认仍由 Codex 放在 `%USERPROFILE%\.codex`；管理器不会把它迁入仓库或发布包。
- 运行日志经过脱敏，不应记录 API Key、Authorization、Cookie、密码、消息正文或工具结果正文。
- 每次正式打包都会扫描 `data`、登录态、Cookie、Local Storage、Session Storage、日志和缓存，发现残留即失败。

## 架构

- `electron/codexManager.js`：渠道、模型目录、Codex 配置、会话与项目管理。
- `electron/protocolProxy.js`：Responses/Chat 路由、流式事件与工具循环适配。
- `electron/protocol/`：模型别名、工具连续性、上游 Chat SSE 增量读取与协议转换等可复用模块。
- `electron/runtime/`：窗口、静态页面、IPC、安全边界与生命周期。
- `electron/features/`：桌面 Projects 同步、更新、导入、用户错误等独立功能。
- `src/views/model-manager/`：管理器界面及模块化组件。

更完整的维护说明见 [docs/HANDOFF.md](docs/HANDOFF.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 安全报告

请不要在公开 Issue 中粘贴 API Key、PAT、Cookie、完整日志或登录文件。处理方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
