# 维护交接

## Grok 中使用 Codex Skill

当用户明确提及/执行 Skill，或请求中已经出现 Skill 读取/结果时，Grok Chat 适配层会启用有界的 prompt 工具桥：上游只负责规划和返回标准工具调用，Codex 仍负责权限确认、工具执行和结果回传。通用的 Skill 目录说明本身不会触发额外请求，避免普通问答被重复探测。

恢复工具调用时会保留原始 system/Skill 指令，并从较早的 Skill 结果中补回有限正文；工具目录相关性计算也包含 system 与 Skill 记录，最多 24 个工具但会优先保留 Skill 明确引用的 MCP 工具。该路径使用本地 mock/wire 回归验证，尚未对真实渠道做带凭据的 Skill smoke；渠道限流、模型不支持工具或超长 Skill 仍会以结构化 incomplete 交给 Codex。

Codex 的 `developer` input 可能包含常驻 Skill 目录，不能单独作为“本轮激活”证据；当前适配层只在用户明确选择/提及、实际读取 Skill、收到 Skill 工具结果或显式内部标记出现时启用兼容桥，避免普通请求被额外重发。

这份文档面向后续开发者，记录稳定架构、质量门禁和已经验证过的陷阱。它不包含机器地址、个人目录、凭据或私有部署信息。

## 不可破坏的产品约束

1. 修改源码前必须检查 Git 工作区并保护已有改动。普通受版本控制的源码修改依靠 Git 提交恢复；只有涉及真实用户数据、迁移、安装/卸载、破坏性操作或未受 Git 管理的文件时，才创建隔离备份并校验相对路径与 SHA-256。
2. 用户普通启动管理器时不能自动启动或关闭 Codex；只有用户明确点击同步/启用并重启时才可操作 Codex 进程。
3. 切换渠道、Key 或模型不能删除 `sessions`、Projects、Skills、Agents 或原登录字段。
4. 发布产物必须是纯净版，不得包含 `data`、API Key、Cookie、登录态、日志或缓存。
5. 模型是否可用必须来自当前 Key 的实际目录与完整协议测试，不能写死模型数量。
6. 未知 Provider 或未验证协议必须显示“适配未完成，暂不可用”，不能猜测接口。
7. GPT 原生 Responses 路径不应为了兼容 Grok 而降级；Grok 的兼容逻辑限定在模型适配层。
8. `config.toml` 的 `[projects]` 只表示目录信任，不等于 Codex 桌面端 Projects；Local Project 和任务归属需要合并到 `.codex-global-state.json`。

## 模块边界

```text
Renderer (src/views/model-manager)
        │ 仅调用受控 preload API
        ▼
IPC / lifecycle (electron/runtime, electron/main.js)
        │
        ├── codexManager.js        配置、会话、项目、模型目录、事务与进程
        ├── protocolProxy.js       HTTP/SSE 编排与上游请求
        ├── protocol/*             转换、模型别名、Chat SSE 增量读取、工具续接判定
        └── features/*             更新、导入、错误转换等独立能力
```

新功能优先放入 `features`、`protocol` 或 `runtime` 的独立模块；`main.js` 只负责编排，UI 行组件放入 `components`。

## Agent Loop 数据流

1. Codex 向本地随机端口和随机能力路径发送 Responses 请求。
2. 代理根据实际模型能力选择原生 Responses 或 Chat Completions 适配。
3. GPT 原生路径尽可能透传合法 Responses 事件。
4. Grok Chat 路径把 Codex 工具声明编译成上游可理解的格式，再把工具调用还原为标准 Responses 项。
5. Codex 执行工具并把 `custom_tool_call_output`/`function_call_output` 发回代理。
6. 上游输出计划型中间消息时，代理在完整响应仍用于判型的同时，把安全正文前缀作为 `phase=commentary` 的 delta 立即交给 Codex；工具 JSON 保持缓冲且不进入可见消息。
7. 代理保持 `call_id`，继续请求当前上游，直到得到最终结果、一个明确问题、有效工具调用、用户取消，或命中重复/连接失败熔断；正常计划续接没有固定轮数。

Grok prompt-emulated 路径会把历史工具调用和结果编码为 `codex_internal_tool_history` 私有信封，并把续接指令编码为 `codex_internal_adapter`。这些内容只供上游保持执行连续性，绝不能进入用户可见正文。可见文本必须先调用 `stripInternalToolTranscript`，然后才能做工具 JSON 解析和输出；否则上游复述的历史 JSON 可能被误判为新的工具调用并造成重复执行。标准 `custom_tool_call` / `function_call` Responses 事件仍必须保留，不能为了隐藏开发标签而破坏 Agent Loop。

不得向用户展示或伪造隐藏推理链。可见内容只能来自上游主动输出的进度、标准工具事件、工具结果和最终消息。

## 已踩过的坑

### 单个会话文件会拖垮整个列表

Codex 写入、杀毒扫描或权限变化可能让 `stat`/`read` 短暂返回 `EPERM`。会话扫描必须按文件隔离异常并清理该文件缓存，下一次刷新重试；不能把异常提升为整个 `getStatus` 失败。

### 跨模型工具项 ID 不同

Responses 的 `custom_tool_call` 项 ID 使用 `ctc_`，`function_call` 项 ID 使用 `fc_`；`call_id` 是关联工具结果的独立字段。切换模型时只规范项 ID，不应篡改调用关联。

### “准备读取技能”不是任务完成

Grok 可能返回计划句但不发工具调用。只有紧邻当前工具结果或明确需要工具的当前任务才允许恢复；历史工具结果不能触发新任务恢复。正常计划续接没有固定次数和总耗时上限，但单次请求仍有超时，连续五次渠道失败或连续五次完全相同计划会熔断。

托管 NewAPI 渠道会在 Codex 配置中注册 `chatgpt_model_manager_image` Streamable HTTP MCP 服务，其 `generate_image` 工具通过当前渠道的 `POST /v1/images/generations` 执行并返回标准 MCP 图片内容。MCP 默认请求 `b64_json`；上游仍返回 URL 时，管理器必须无凭据下载、验证图片魔数和 20 MiB 上限，再保存到 `data/generated-images` 并返回 `image` 内容块与可直接嵌入最终回答的本地绝对路径 Markdown。下载失败只能降级为原 URL Markdown，不得再次生成导致重复计费。若原生 Responses 上游直接返回 `image_generation_call.result` Base64，代理也必须保留原调用、校验并物化图片，再于终态事件前追加标准 assistant `output_text` Markdown；不得依赖模型在下一轮复述路径。无效图片只做脱敏计数并原样交付响应。同步账号后，管理器会从全部可用 Token 中独立选择 `/v1/models` 实际返回图片模型的 Key；该选择不改变当前聊天 Token。MCP URL 必须复用协议代理的随机能力路径，API Key 只能由管理器内部解析；不得写入 Codex 配置、工具参数或日志。若该 MCP 工具未出现在当前 Codex 请求中，兼容层才退回运行时已有的 `exec`/`image_gen__imagegen` 提示，绝不能伪造未注册工具。

Grok + Codex Skill 适配只把明确的 Skill 选择当作低信任路由提示：用户显式要求/读取 Skill、真实 `SKILL.md` 工具调用或结果、`[[skill:name]]`/`$name`/已在目录中的首行 `/name`，或 `metadata.codex_internal.active_skill`（需包含合法 name）会启用有界 prompt 工具桥。常驻的 developer `<skills_instructions>` 目录本身不会触发桥；它在当前 Codex wire 中无法区分“已选 Skill”，这样可避免普通对话多发一次请求。桥只转换消息与工具事件，Codex 仍负责权限、执行和最终收尾；若产品要让“只点选 Skill、不带 token/读取事件”的首轮也强制桥，需要上游 host 提供受信的内部 marker。

图片模型的请求字段必须按模型族隔离：ainiubi/NewAPI 的 `grok-imagine-image-quality` 只发送 `n=1`、`aspect_ratio`、`resolution=1k` 和 `response_format=b64_json`；Grok Imagine 2.0 可使用其支持的分辨率/质量字段；GPT Image 使用 `size`、`quality`、`output_format`、`output_compression`，不发送 Grok 字段。`tools/list` 会依据当前渠道选出的图片模型动态描述这组能力；带 `xai/`、`azure:` 等前缀的模型按最后一段识别。Chat 首选接口失败而回退 Responses 时，必须复用原生图片物化转换器，不能直接 pipe 原始响应，否则 Base64 图片会在 Codex 对话中消失。上游 403/错误响应要用实际请求 Key 做二次脱敏，即使 Key 不是 `sk-` 前缀也不能泄漏。

Grok 返回工具 JSON 时不一定严格使用 `name` + `arguments`。兼容层允许常见的 `tool_call`/`function` 信封、`tool`/`tool_name` 名称、`args` 和 `exec.input`，但最终工具名仍必须存在于本轮 Codex 允许列表中。

用户只说“继续/接着”时，需要把最近一条真实用户任务和最近助手状态作为只发给上游的续接锚点；旧版内部失败提示必须先清理，不能让它成为新的任务上下文。

### 先缓存完整响应再判型会制造“假卡死”

Grok 的 prompt-emulated 工具路径必须同时维护“增量显示”和“完整判型”两份状态。若先调用 `response.text()` 收齐上游，再判断它是计划、工具 JSON 还是终态，用户会在首轮生成和后续恢复期间一直看不到任何内容，最后一次性出现整段文字。

`chatAssistantStream.js` 必须在 SSE 到达时逐块回调；只有已命中计划停顿规则且位于工具 JSON 之前的安全正文前缀可以作为 commentary 输出。`<codex_tool_call>`、JSON 代码块和顶层工具信封一旦出现就停止可见转发，完整内容仍用于 `parseEmulatedToolCall`。回归测试必须证明第一段 commentary 在上游响应结束前已经到达，不能只断言最终字符串包含进度。

诊断里的 `firstProgressDeltaMs` 是从本轮合成开始到首个可见 commentary delta 的耗时，`progressDeltaCount` 是成功写入下游的增量次数；二者不记录消息正文。

### 完成信号必须精确

兼容恢复链只接受独占最后一行的完成标志。缺少用户输入、附件或授权时应提出一个具体问题并停止；不能用完成标志掩盖阻塞。正常未完成任务可无固定轮数续接，但必须保留断线取消、重复响应和渠道失败熔断。

工具结果后的自然语言看起来已经是终态但缺少标志时，只做一次快速恢复；若恢复服务超时，保留上游原始结果并在脱敏诊断中记录“推断终态”，不向会话追加内部安全停止文字。仍在承诺下一步或明确需要工具时不设固定轮数和总时限，单次最多等待 15 秒，并由重复/连接失败熔断兜底。

恢复请求必须使用内部三态 JSON 决策：`tool` 继续标准工具事件，`complete` 携带原始用户可见最终答复，`needs_input` 携带一个具体问题。代理负责把 `complete` 转成内部完成状态并剥离控制结构；不得把决策 JSON 或完成标志展示给用户。复杂 `exec` 恢复需要 4096 token 输出预算，否则脚本可能被 512 token 截断；无固定轮数不能移除重复响应和连续渠道失败熔断。

### Codex Projects 有两层状态

`config.toml [projects]` 只控制目录信任。桌面端 Projects 页读取 `.codex-global-state.json` 的 `local-projects`、`project-order` 和 `thread-project-assignments`。同步流程必须在 Codex 进程关闭后执行，先备份完整状态，只合并这些项目字段；`projectless-thread-ids` 是普通对话的显式归属，优先级高于 cwd，禁止仅凭会话 cwd 创建项目或移除普通对话标记。只有已归属现有 Local Project 的任务才能清理对应 workspace hint。文件损坏或写后校验失败时禁止启动 Codex并恢复备份。

Codex 左侧栏还读取 `pinned-project-ids` 决定显示哪些项目分组。仅创建 Local Project 和任务归属仍可能让所有任务停留在统一列表；同步到的项目 ID 必须追加到固定列表，同时保留用户原有固定项并保持幂等。

### 手动任务恢复必须由用户触发并避免重复执行

对话管理的恢复入口只接受规范 UUID 和未归档的本地 session。先用 `thread/read(includeTurns: true)` 检查运行时与最后一个 turn；任一状态仍为 active/inProgress 时必须拒绝，不能创建并发恢复回合。工作区预检只记录目录是否存在、是否为 Git 仓库和已跟踪改动数量，不记录文件名、diff、对话或工具输出。

恢复通过 `codex exec --json --skip-git-repo-check resume <id> -` 执行，固定恢复指令走 stdin，禁止出现在命令参数和日志。只有 CLI 在 `turn.started`/工具或文件事件出现之前，以明确 session/rollout/history 损坏或不兼容分类失败时，才允许调用一次 `thread/fork` 并恢复新任务；认证、额度、高负载、权限、审批、网络和未知错误直接停止。恢复子进程不脱离客户端，客户端退出时必须终止，且不得使用绕过审批或沙箱的参数。

### 任务终止不得自动创建后续消息

协议代理必须原样交付原生 Responses，不得为了空输出、refusal、reasoning-only、incomplete、工具调用终止或网络中断而重发原请求，也不得生成终态续接标记。主进程不得监听这些终态后向 Codex 写入“继续”，不得调用 `turn/steer`、`turn/start` 或 `codex exec resume` 创建自动恢复回合，也不得为该用途复制 WindowsApps 中的 Codex 运行时。

任务停止后由用户在 Codex 中决定是否继续。唯一保留的恢复能力是上一节所述、由用户在对话管理中明确触发的手动任务恢复；它必须继续执行活动任务检查，不得转化为后台监督器。运行日志没有面向用户的界面入口，仅用于维护诊断。

### 未来承诺不是 Grok 的终态

“我接下来会……”“下一步我将……”和同类英文未来承诺只表示任务仍在进行。即使它出现在工具结果之后且缺少结束标志，也不能走一次快速终态推断；应优先进入严格工具 JSON 恢复并持续到明确决策。只有包含已验证结果的完整答复才允许终态推断。

### 在线更新必须指定当前程序目录

更新安装包保存在稳定目录的 `data/updates`。如果静默启动 NSIS 时只传 `/S`，自定义默认目录会落到安装包旁边，导致新版本安装在 `data/updates/ChatGPT Model Manager`，而用户再次打开的仍是旧程序。

更新器必须把当前 `process.execPath` 所在目录作为最后一个 `/D=...` 参数，并同时传 `--updated`、`--force-run`、`--keep-shortcuts`：更新模式负责等待或关闭旧进程、保留 `data`，强制运行标志负责在静默安装结束后启动新 EXE。`/D` 是 NSIS 特殊参数，必须位于参数列表最后。安装器回归必须验证旧程序文件被替换、数据标记保留，以及重启进程仍来自同一个稳定目录。

### 轻量补丁必须保留完整包兜底

1.2.79 起，更新器优先精确匹配 `ChatGPT-Model-Manager-Patch-<from>-to-<to>-<updateRuntimeId>-x64.asar`。只有相邻版本的 `updateRuntimeId` 相同，发布脚本才会生成补丁；Electron、原生运行时、打包结构或外部资源变化时必须先更新该 ID，强制客户端走完整 NSIS。

补丁和完整安装包都必须来自当前仓库 GitHub Release 并具有 GitHub 资产 SHA-256。补丁辅助进程只可替换当前安装目录的 `resources/app.asar`，替换前保留备份；新版本窗口创建后回写健康状态，超时则恢复旧版。补丁损坏、缺失、曾被回滚或运行时不兼容时必须自动选择完整安装包。

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

## 分阶段验证顺序

源码阶段先执行以下门禁，通过后推送 GitHub 并给出精确提交：

```powershell
npm ci --dry-run --ignore-scripts
npx prettier --check .
npm run lint
npx tsc --noEmit
npm run test:modules
npm run test:core
npm run test:wire
npm run build
```

安装包阶段随后执行：

```powershell
npm run dist
npm run test:packaged-ui
npm run dist:installer
npm run test:installer
```

如果变更触及安装器、更新器、Electron 生命周期、持久化路径、数据迁移或发布脚本，相关安装包阶段测试必须在源码推送前提前执行。测试退出码为 0 但执行 0 个断言/场景，不算通过。真实渠道测试需要隔离凭据与明确授权；无法运行时必须在发布报告中说明未验证范围。

## 版本与发布

- 每次用户可见更新递增 `package.json` 与 `package-lock.json` 版本。
- Git tag 使用 `v<版本>`。
- 固定顺序为：源码门禁通过 → 推送 GitHub 源码并通知提交 → 用户可在开发工作区拉取并热重载 → 安装包门禁通过 → 推送版本标签并发布 GitHub Release。
- 共享目录只维护一个不带版本号的稳定程序文件夹，不再创建逐版本目录或复制安装包。后续原位更新前必须确认程序已退出，并备份、保留和验证稳定目录中的 `data`；不能用纯净包覆盖掉真实用户数据。
- 开发模式的源码热重载和已安装客户端更新是两个不同通道。仅推送源码不会被安装版更新器发现；安装版仍读取 GitHub Release，并下载经过 SHA-256 校验的安装包。
- GitHub Release 安装包名称必须为 `ChatGPT-Model-Manager-Setup-<版本>-x64.exe`，在线更新模块按此精确匹配。
- Release 工作流必须先通过 lint、类型、模块、核心、wire、构建和纯净包测试。
- 当前未配置商业 Windows 代码签名证书，这是已知发布风险，不得隐藏。

## 2026-08-10：参考 RongleCat/grok-app 加固 Grok/NewAPI→Codex 流边界（1.2.90）

- 对照项目的可复用结论不是把 Grok Build ACP 运行时搬进 Codex，而是保留“Agent 内核归客户端、适配层只负责协议边界”的分工。当前客户端继续由 Codex 执行工具和维护会话，NewAPI 代理不代替 Codex 执行工具。
- 吸收其第三方中转 SSE 清洗经验：Chat→Responses 转换明确忽略 ping、`x-opencode-type` 与无有效选择的计费尾帧；对 Codex 输出的每个合成 Responses 事件都带从 0 开始、严格递增的 `sequence_number`。
- 吸收其中文流分片回归：`TextDecoder` 始终以流式方式读取，并在 EOF 刷新尾部缓冲；同时对转换流执行 32 MiB 上限，超限会取消上游而不是继续占用内存。
- Grok/NewAPI 增量兼容新增数组文本、`reasoning_content`/`reasoning`/`thinking` commentary，以及累计式 JSON 工具参数识别。推理 commentary 只允许出现在首个正文或工具事件之前，避免后续交错事件复用 output index。
- 不照搬的部分：Grok App 使用 `grok agent stdio`/ACP、独立 `GROK_HOME` 和官方辅助 MCP；本客户端的宿主是 Codex，已有 Responses 工具协议、Codex Home 和 NewAPI 图片工具，复制这些运行时会形成双 Agent Loop 和认证冲突。
- 回归范围：模块测试覆盖元数据分类、数组文本、reasoning 字段和增量/累计工具参数；wire 测试通过真实 HTTP SSE 在一个中文字符的多字节中间切包，断言无替换字符、commentary/正文完整、元数据不泄漏，并断言所有合成事件序号精确为 `0..n-1`。

## 2026-08-05：1.2.69 流式控制标志与脚本续接

- `.230` 的 1.2.68 日志显示，Grok 经过多轮标准工具调用后，在工具结果后回复“接下来用更稳妥的脚本方式排查认证”；旧逻辑没有把“接下来用”识别为计划，只做一次终局确认，确认请求 15 秒超时后把计划误判成最终答案。
- `toolContinuation` 现在识别逗号后的“接下来用/使用/通过/以”及认证、排查、测试等后续动作；这类文本进入无固定轮数恢复，只由明确完成、需要输入、有效工具调用、用户取消或熔断收口。
- 完成/安全停止信号加入 `emulatedToolSyntax` 的完整和部分流式边界；实时进度还会再次执行控制信号清理，防止 `[CODEX_AGENT_LOOP_COMPLETE]` 分片先显示、结束时才被清理。
- Codex 的标准工具调用卡属于客户端安全审计通道，工具参数必须随 Responses 工具事件交给 Codex 才能在用户电脑执行，代理不能在保留真实执行的同时伪造或删除该卡。应隐藏的是模型正文中的内部标签、模拟协议和历史转录，而不是声称工具已运行却不发送审计事件。
- 修改前本地备份标签为 `backup-v1.2.68-before-agent-loop-privacy-20260805`，指向正式 v1.2.68 提交。针对性 Agent Loop 与 wire 测试已通过；完整源码、安装器及云端发布门禁尚待执行。
- 完整源码门禁随后通过依赖 dry-run、生产审计 0、格式、diff、语法、lint、类型、modules、core/Agent Loop/中文错误/updater、wire 和 production build；安装器及云端发布门禁仍待执行。
- 本机完整目录随后通过纯净性、图标和 packaged UI 检查：76 个文件、283,147,799 字节，无 `data`、凭据、日志、缓存或开发文件；UI 668 ms 就绪，版本 1.2.69，0 renderer/console/startup error，不自动启动 Codex。
- 本机 NSIS 安装包 80,652,074 字节，SHA-256 `78BCA7E18BBCE0C59C9052F0779478937FDA21D866B3FE31B6A3A397E4FFFD75`。真实隔离回归通过自选路径安装、纯净启动、卸载、保留 data 重装、原位更新、自动重启、再次 UI、最终卸载和默认路径安装；两轮 UI 484/652 ms 且 0 错误。仍需最终提交的 main CI 和独立 Release runner 通过后才能发布在线更新。

## 2026-08-05：1.2.70 未签名终局与手动中断续接

- v1.2.69 的 `.230` 现场日志证明长任务保留了最多 77 条消息和 32 组工具结果，但两次在模型快速返回未签名文字后，续接确认约 15 秒超时并进入 `inferredCompletionAccepted=true`；这不是 Python 进程或代理网络整体断线。
- v1.2.70 删除未签名终局的单次推断接受：所有工具结果后的缺少完成信号回答都进入无固定轮数恢复；连续五次传输失败或五次相同停顿仍熔断，防止离线渠道无限请求。
- Codex 会在手动停止时写入仅供运行时使用的 `<turn_aborted>` developer 控制消息。适配器现在只在该控制消息位于当前用户轮次之前、且用户以“继续/接着/恢复/重试/往下”开头时，锚定原任务、最近助手状态和已有工具结果；若用户改问新任务则不会错误续接。
- `<turn_aborted>` 在发给上游前被删除，不进入普通回答或恢复上下文。新增单元和 wire 场景覆盖“安装 Python → 工具结果 → 手动中断 → 继续安装并验证”，并断言下一条标准 `exec` 工具调用产生、原任务与工具结果计数存在、控制标记不可见。
- 修改前备份标签 `backup-v1.2.69-before-interrupt-continuation-20260805` 指向正式 v1.2.69 提交 `4a22bcb7f7a350b7beb0937e5238f9be9ccc4b5e`。
- 源码门禁已通过：依赖锁 dry-run、生产依赖审计（0 漏洞）、Prettier、diff/JS 语法、ESLint（0 warning/error）、TypeScript、模块边界、核心/Agent Loop/中文错误/更新器、wire 协议集成和 production build。安装器与云端发布门禁仍待执行。
- 完整目录随后通过纯净性、图标和 packaged UI 检查：76 个文件、283,152,684 字节，无凭据、数据、日志、缓存或开发文件；UI 512 ms 就绪，版本 1.2.70，0 renderer/console/startup error，不自动启动 Codex。
- NSIS 安装包 `ChatGPT-Model-Manager-Setup-1.2.70-x64.exe` 为 80,652,482 字节，SHA-256 `818E95C20D5D749163EC118D80CD84A9803C6FF67E6D7511FB1DA8341C3B1B11`。真实隔离回归通过自选路径安装、纯净启动、卸载、保留 data 重装、原位更新、自动重启、再次 UI、最终卸载和默认路径安装；两轮 UI 498/407 ms 且 0 错误。最终 main CI 与独立 Release runner 仍待执行。

## 2026-08-05：1.2.71 Grok 恢复超时修复

- `.230` 的 v1.2.70 日志中两次 `consecutive_transport_failures` 实际集中命中 15 秒固定上限；成功恢复样本也耗时 14.238 秒，因此根因是长上下文推理被过早中止，不是五次明确渠道错误。
- v1.2.71 将单次恢复等待改为 60 秒，同时在不记录响应正文、地址或凭据的前提下增加 `timeout`、`http_rate_limit`、`http_server_error`、`http_request_rejected` 和 `transport_error` 诊断分类；熔断提示按类别给出中文下一步。
- 新增真实延迟 16 秒的 wire 场景，断言旧 15 秒边界后仍产生标准 `exec` 工具调用、失败计数为 0、不会触发熔断。修改前备份标签 `backup-v1.2.70-before-recovery-timeout-20260805` 指向正式 v1.2.70 提交 `5f8e2bf7d1f5cdbc5d4fd7bb3ee8738a197b6e44`。
- 完整源码门禁通过依赖 dry-run、生产审计 0、格式/diff/语法、lint 0、类型、modules、core/Agent Loop/中文错误/updater、50 秒 wire 和 production build。完整目录 76 个文件、283,157,079 字节，纯净性、图标和 packaged UI 通过，UI 371 ms、0 错误、不自动启动 Codex。
- 本机 NSIS 安装包 80,653,053 字节，SHA-256 `6CC6FB4940636EE5711FAA66874CEE80107C9C5B5B1972A66D7FDFE47A7971EC`；真实隔离安装、保留 data 更新、自动重启、两轮 UI（385/380 ms）与卸载全部通过。远端部署与现场日志验证尚待执行。

## 2026-08-05：1.2.73 编码工具帧兼容

- 上游 `0xa0a1e…0xa1…0xa2…` 内部工具帧现在会被解析为当前请求允许的标准 Codex 工具事件，并在完整/部分 SSE 边界和可见文本层隐藏；不会执行同一答复中预写的后续陈旧步骤。
- 修复初始草稿把 `input` 贪婪读成 `input0x` 的缺陷。单元测试覆盖 exec/wait、参数类型、无字段和非法名称，wire 测试覆盖四分片工具帧的完整转换与不可见性。
- 版本递增至 1.2.73；依赖、格式、语法、lint、类型、模块、核心、Agent Loop、中文错误、更新器、wire 与 production build 已通过，安装包和发布门禁仍待执行。
- 源码提交 `3c6295458660334e99dd1d17e8c62d67c88b6bf7` 已推送。完整目录 76 文件、283,165,446 字节，纯净/图标/packaged UI 通过；UI 383 ms、0 错误且不自动启动 Codex。
- 本机 NSIS 安装包 80,654,063 字节，SHA-256 `29E761C005FCA347BCE222013E728E09A20F155540B30081D24E0D196F40349B`；真实自选路径安装、data 保留更新、自动重启、两轮 UI（474/372 ms）、卸载与默认目录安装全部通过，云端 CI/Release 仍待完成。

## 2026-08-05：1.2.74 日志入口与 Grok 容量错误

- 正式程序目录已安装 1.2.72，但现有 `manager.log` 最后由 1.2.61 写入；文件时间和进程记录证明 1.2.72 安装后没有启动，因此没有新版日志可读，并非日志权限或路径迁移故障。
- 两个近期长任务最新单次输入约 124,825/172,263 token，均低于 258,400 上下文窗口；`high demand` 应按上游容量繁忙处理，不能据此断定输入越界。
- v1.2.74 移除 `high demand` 的工具不兼容误分类，容量错误最多退避重试两次；容量耗尽和上下文过大使用不同中文提示。日志新增脱敏状态、类别、重试与请求大小，并在主界面提供“打开运行日志”。
- 模块、14 个中文错误案例、TypeScript、ESLint 和 wire 集成测试已通过；wire 覆盖两次容量失败后恢复、三次容量失败后停止，以及上下文过大立即返回且不重试。其余源码、打包、安装器和发布门禁待继续执行。
- 源码提交 `a90caa2fbf81247c103f5a6eb3d7e544beaacb36` 已推送维护分支与 main。完整源码门禁通过依赖锁 dry-run、生产审计 0 漏洞、Prettier、diff/语法、ESLint 0 warning/error、TypeScript、modules、core/Agent Loop/中文错误/updater、wire 和 production build。
- 完整目录 76 个文件、283,176,238 字节，纯净性、图标和 packaged UI 通过；UI 384 ms 就绪、版本 1.2.74、0 renderer/console/startup error，并确认运行日志按钮与桥接方法存在。
- 本机 NSIS 安装包 `ChatGPT-Model-Manager-Setup-1.2.74-x64.exe` 为 80,655,431 字节，SHA-256 `A9125D43E54456231D04169FAC38B4520E29D6A585812B955AF9C7E370FC9D7D`；真实隔离安装、保留 data 重装、原位更新、自动重启、两轮 UI（370/374 ms）、卸载和默认路径安装全部通过。云端 CI、正式标签、Release 与稳定目录部署仍待完成。

## 2026-08-05：1.2.75 映射盘 GPU 启动兼容

- v1.2.74 发布并原位部署到稳定映射盘后，首次真实启动复现了 Chromium GPU 子进程连续九次 `error_code=18`，随后 `GPU process isn't usable` 致命退出；这解释了新版程序文件存在但进程和新日志缺失的现场症状。
- v1.2.75 在 Electron 初始化前调用 `app.disableHardwareAcceleration()`。管理器 UI 不依赖 WebGL，该兼容模式不影响 Codex、模型代理、本地工具或用户数据；`process.start` 同时记录 `hardwareAcceleration=disabled`。
- 新增模块边界断言，确保禁用硬件加速发生在便携数据目录初始化之前。源码、打包、安装器、云端发布和稳定目录启动日志仍待完整复验。
