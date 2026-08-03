# 维护交接

这份文档面向后续开发者，记录稳定架构、质量门禁和已经验证过的陷阱。它不包含机器地址、个人目录、凭据或私有部署信息。

## 不可破坏的产品约束

1. 修改源码前必须创建排除依赖、构建产物和用户数据的源码备份，并逐文件校验相对路径与 SHA-256。
2. 用户普通启动管理器时不能自动启动或关闭 Codex；只有用户明确点击同步/启用并重启时才可操作 Codex 进程。
3. 切换渠道、Key 或模型不能删除 `sessions`、Projects、Skills、Agents 或原登录字段。
4. 发布产物必须是纯净版，不得包含 `data`、API Key、Cookie、登录态、日志或缓存。
5. 模型是否可用必须来自当前 Key 的实际目录与完整协议测试，不能写死模型数量。
6. 未知 Provider 或未验证协议必须显示“适配未完成，暂不可用”，不能猜测接口。
7. GPT 原生 Responses 路径不应为了兼容 Grok 而降级；Grok 的兼容逻辑限定在模型适配层。

## 模块边界

```text
Renderer (src/views/model-manager)
        │ 仅调用受控 preload API
        ▼
IPC / lifecycle (electron/runtime, electron/main.js)
        │
        ├── codexManager.js        配置、会话、项目、模型目录、事务与进程
        ├── protocolProxy.js       HTTP/SSE 编排与上游请求
        ├── protocol/*             转换、模型别名、工具续接判定
        └── features/*             更新、导入、错误转换等独立能力
```

新功能优先放入 `features`、`protocol` 或 `runtime` 的独立模块；`main.js` 只负责编排，UI 行组件放入 `components`。

## Agent Loop 数据流

1. Codex 向本地随机端口和随机能力路径发送 Responses 请求。
2. 代理根据实际模型能力选择原生 Responses 或 Chat Completions 适配。
3. GPT 原生路径尽可能透传合法 Responses 事件。
4. Grok Chat 路径把 Codex 工具声明编译成上游可理解的格式，再把工具调用还原为标准 Responses 项。
5. Codex 执行工具并把 `custom_tool_call_output`/`function_call_output` 发回代理。
6. 代理保持 `call_id`，继续请求当前上游，直到得到最终结果、一个明确问题或达到有限恢复上限。

不得向用户展示或伪造隐藏推理链。可见内容只能来自上游主动输出的进度、标准工具事件、工具结果和最终消息。

## 已踩过的坑

### 单个会话文件会拖垮整个列表

Codex 写入、杀毒扫描或权限变化可能让 `stat`/`read` 短暂返回 `EPERM`。会话扫描必须按文件隔离异常并清理该文件缓存，下一次刷新重试；不能把异常提升为整个 `getStatus` 失败。

### 跨模型工具项 ID 不同

Responses 的 `custom_tool_call` 项 ID 使用 `ctc_`，`function_call` 项 ID 使用 `fc_`；`call_id` 是关联工具结果的独立字段。切换模型时只规范项 ID，不应篡改调用关联。

### “准备读取技能”不是任务完成

Grok 可能返回计划句但不发工具调用。只有紧邻当前工具结果或明确需要工具的当前任务才允许有限恢复；历史工具结果不能触发新任务恢复。恢复最多三次，并同时受单次与总耗时限制。

图像请求需要引导模型通过 Codex `exec` 桥调用 `tools.image_gen__imagegen`，但是否存在该工具仍由当前 Codex 运行时决定，代理不能伪造工具。

### 完成信号必须精确

兼容恢复链只接受独占最后一行的完成标志。缺少用户输入、附件或授权时应提出一个具体问题并停止；不能用完成标志掩盖阻塞，也不能无限续接。

### 启动慢不一定是代理慢

代理通常只占很小一段时间。记录静态服务启动、页面 `loadURL`、`ready-to-show` 等分段耗时后再优化。指纹静态资源可长期缓存，HTML 需要重新验证。

### 更新程序不能先退出主程序

调用安装包后必须等待子进程 `spawn` 成功；若收到 `error` 或超时，应保留当前程序、记录脱敏错误并允许用户重试。下载必须限制主机、资产名、大小并验证 SHA-256。

## 数据与安全

- 管理器持久数据只能放在客户端目录 `data` 下。
- Codex 官方的 `.codex` 数据仍归 Codex 管理，不能为了“便携”改变其约定后导致历史任务丢失。
- 日志只记录模型、适配器、协议、计数、耗时和布尔诊断，不记录消息或工具正文。
- 任何凭据只能出现在用户本机运行数据中；源码、测试、文档和发布包使用明显的假值。
- GitHub 发布前执行敏感信息扫描，根目录本机交接文档保持忽略。

## 验证顺序

```powershell
npm ci --dry-run --ignore-scripts
npm run lint
npx tsc --noEmit
npm run test:modules
npm run test:core
npm run test:wire
npm run build
npm run dist
npm run test:packaged-ui
npm run dist:installer
npm run test:installer
```

测试退出码为 0 但执行 0 个断言/场景，不算通过。真实渠道测试需要隔离凭据与明确授权；无法运行时必须在发布报告中说明未验证范围。

## 版本与发布

- 每次用户可见更新递增 `package.json` 与 `package-lock.json` 版本。
- Git tag 使用 `v<版本>`。
- GitHub Release 安装包名称必须为 `ChatGPT-Model-Manager-Setup-<版本>-x64.exe`，在线更新模块按此精确匹配。
- Release 工作流必须先通过 lint、类型、模块、核心、wire、构建和纯净包测试。
- 当前未配置商业 Windows 代码签名证书，这是已知发布风险，不得隐藏。
