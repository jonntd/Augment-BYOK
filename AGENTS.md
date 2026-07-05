# AGENTS.md

## Project Context

- 本仓库不是普通 Node 应用；它的职责是**把上游 `augment/vscode-augment` VSIX 打补丁后重新打包成单一 BYOK VSIX**。主入口不是 HTTP 服务，也没有数据库/迁移系统；核心工作是：
  1. 下载/解包上游 VSIX；
  2. overlay 本仓库的 `payload/extension/out/byok/**`；
  3. 对上游 `extension/out/extension.js` 与 webview assets 打补丁；
  4. 跑 contracts / syntax / coverage；
  5. 重新打包到 `dist/*.vsix`。
- **当前仓库内没有嵌套 AGENTS.md 规则**。如果未来新增子目录 AGENTS.md，只写局部例外，不复制本文。
- **事实优先级**：
  1. 单一真相代码/脚本：  
     - `tools/report/llm-endpoints-spec.js`（LLM 端点集合）  
     - `payload/extension/out/byok/core/provider-types.js`（provider.type 集合）  
     - `tools/lib/byok-workflow.js`（构建期补丁顺序）  
     - `tools/check/byok-contracts/main.js`（产物布局与 marker 合约）
  2. 根 README：补丁面清单、配置/路由/provider/端点说明、删除功能历史、构建/排障说明
  3. `test/*.test.js`：真实回归与边界行为
- **不要把这些路径误判为可直接编辑的源代码**：
  - `.cache/**`：下载/解包/分析缓存；下次脚本会覆盖
  - `dist/**`：构建产物；下次脚本会覆盖
  - `vscode.log`、`webview.log`：诊断输出；`npm run capture:logs` 会覆盖
- **不要把这些路径误判为“自动生成不可改”**：
  - `payload/extension/out/byok/**` 虽然路径里有 `out`，但它是**仓库提交的源代码 overlay**，应在这里改
- `config.example.json` 只是示例，不是配置契约源头；配置契约以 `README.md` + `payload/extension/out/byok/config/**` 为准。
- 当前上游锁定在 `upstream.lock.json`，快照版本当前是 `0.871.0`；**不要手改 lock 文件内容**，通过 `npm run upstream:analyze` / `npm run build:vsix` 让脚本更新。

## Commands

### 前置环境

| 目的 | 命令 |
| --- | --- |
| Node 版本 | `node -v`（要求 Node.js 20+） |
| Python 版本 | `python3 --version` 或 `py -3 --version` 或 `python --version` |

> 本仓库 `package.json` 无第三方依赖；没有单独的 `npm install` 契约。构建/分析脚本只依赖 Node 内建模块和 Python。

### 常用命令

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 全量单测 | `npm test` | 等价于 `node --test test/*.test.js` |
| 快速本地检查 | `npm run check:fast` | `llm-endpoints` + `provider-types` + `provider-dispatch` + syntax + codestyle + 单测 |
| 完整检查 | `npm run check` | `check:fast` + contracts；通常要求已有缓存的上游 VSIX |
| 语法检查 | `npm run check:payload-syntax` | 检查 `payload/extension/out/byok/**` 与 `tools/**` |
| 代码布局硬规则 | `npm run check:codestyle` | 单文件 ≤ 400 行、kebab-case、禁止 `foo.js` 与 `foo/` 同名、禁止纯转发模块 |
| provider.type 分发闸门 | `npm run check:provider-dispatch` | 限制 provider.type 分支只能出现在少数模块 |
| 端点生成同步 | `npm run gen:llm-endpoints` | 从 `tools/report/llm-endpoints-spec.js` 同步 UI/default-config/official-delegation |
| 端点生成校验 | `npm run check:llm-endpoints` | 检查上述生成物是否过期 |
| provider types 同步 | `npm run gen:provider-types` | 从 `core/provider-types.js` 同步 UI util |
| provider types 校验 | `npm run check:provider-types` | 检查上述生成物是否过期 |
| 上游端点分析 | `npm run upstream:analyze` | 生成 `.cache/reports/upstream-analysis.json` |
| LLM 覆盖报告 | `npm run report:coverage` | 读取 upstream 分析并 fail-fast 校验端点/UI 目录一致性 |
| contracts | `npm run check:contracts` | 使用缓存的上游 VSIX 重新 overlay+patch 后跑 contracts |
| 构建 VSIX | `npm run build:vsix` | 下载/解包/patch/repack，输出到 `dist/` |
| 构建 VSIX（复用缓存） | `npm run build:vsix -- --skip-download` | 已有 `.cache/upstream/*.vsix` 时使用 |
| 捕获 VS Code 日志 | `npm run capture:logs` | 抽取 `[Augment-BYOK]` 到 `vscode.log`/`webview.log` |
| 官方拼接审计 | `npm run check:official-delegation -- --require-all` | 先复现真实请求并 capture logs，再检查 7 个官方拼接端点全部 hit 且 miss/fail=0 |

### 定向测试命令模板

| 改动区域 | 建议命令 |
| --- | --- |
| 路由 / runtime 边界 | `node --test test/router.test.js test/runtime-boundary.test.js test/callapi-shim-contract.test.js` |
| 配置 / 导入导出 / secret 保留 | `node --test test/config-io.test.js test/config-normalize.test.js test/get-models-filter.test.js` |
| provider fallback / requestDefaults | `node --test test/openai-compatible-fallback.test.js test/anthropic-fallback-chain.test.js test/gemini-fallback-chain.test.js test/provider-util.test.js` |
| OpenAI Responses | `node --test test/openai-responses-*.test.js` |
| history summary | `node --test test/history-summary-*.test.js` |
| webview / patch | `node --test test/patch-webview-history-summary-node.test.js test/webview-assets.test.js test/patch-webview-asset-cache-bust.test.js` |
| 文本组装 / delegation | `node --test test/text-assembly.test.js test/official-text-delegation.test.js test/official-delegation-*.test.js` |

## Architecture Boundaries

- **构建边界**
  - 构建主入口：`tools/build/build-vsix.js`
  - 上游下载/解包：`tools/lib/upstream-vsix.js`
  - 补丁编排：`tools/lib/byok-workflow.js`
  - contracts：`tools/check/byok-contracts/main.js`
  - **不要手改 `.cache/work/**/extension/**`**；这些目录是脚本临时解包产物。
- **补丁顺序是契约**
  - `tools/lib/byok-workflow.js` 里的 `applyByokPatches()` 顺序不是随意排的。
  - 改 patch 顺序、增加/删除 patch、变更 marker 时，必须同步更新 contracts 与对应 `test/patch-*.test.js`。
- **runtime 边界**
  - `runtime/bootstrap/**` 只负责安装命令、绑定 `globalState`、初始化 runtime toggle 与 config manager。
  - `runtime/shim/**` 只负责拦截 `callApi/callApiStream`、路由、最薄的请求整形。
  - `core/router.js` 是 BYOK/official/disabled 决策单一真相；不要在 shim 或 provider 里复制路由逻辑。
  - `runtimeEnabled=false` 时必须**在 BYOK 副作用之前**返回 official：不要在 rollback 路径提前读取 upstream token/config、stringify completionURL、清理 cache 或记录 host。
- **官方拼接边界**
  - chat / text 请求组装固定走 `runtime/upstream/official-*.js` 读取 upstream `body` 结果；**不要恢复手写 builder**、不要恢复 `officialDelegation` 配置、不要恢复请求级 `delegate_*` 覆盖。
- **配置边界**
  - 配置只来自 VS Code `globalState`：`augment-byok.config.v1`、`augment-byok.runtimeEnabled.v1`、`augment-byok.historySummaryCache.v1`
  - 不引入 settings/env/yaml/SecretStorage 作为新配置源。
  - `config/**` 负责默认值、归一化、存取；`ui/config-io.js` 负责 import/export 与 secret 保留；不要在 UI 或 provider 侧各自解析配置。
- **provider 边界**
  - `core/provider-text.js` 与 `core/provider-augment-chat.js` 是 provider.type 分发单一真相。
  - `tools/check/provider-type-dispatch.js` 只允许 provider.type 分支出现在：
    - `payload/extension/out/byok/core/provider-text.js`
    - `payload/extension/out/byok/core/provider-augment-chat.js`
    - `payload/extension/out/byok/core/augment-history-summary/provider-dispatch.js`
    - `payload/extension/out/byok/providers/models.js`
    - `payload/extension/out/byok/core/self-test/**`
  - 其他模块不要直接写 `if (type === "...")` / `switch (type)`.
- **日志与错误边界**
  - 统一用 `payload/extension/out/byok/infra/log.js`；它负责 redaction。
  - 不要在任何新代码里直出 token/apiKey/cookie/tool arguments/tool input。
  - provider fallback 只允许在已知兼容错误上重试；不要用宽泛 catch 做伪成功。
- **UI 边界**
  - `ui/config-panel/**` 只负责配置编辑、导入导出、自测触发与 endpoint catalog 展示。
  - 配置/路由/请求拼装的真实规则必须留在 `config/**`、`core/**`、`runtime/**`，不要搬进 webview。
- **源代码/生成物边界**
  - `payload/extension/out/byok/**` 是可编辑源。
  - `default-config.js` 的 LLM 路由块、`core/official-delegation.js`、`ui/config-panel/webview/util.js`、`ui/config-panel/webview/render/index.js` 的部分块由脚本维护；**优先改单一真相再运行生成脚本**。

## Contracts

### 端点与路由契约

- BYOK 只实现 **7 个 LLM 数据面端点**，单一真相在 `tools/report/llm-endpoints-spec.js`：
  - `callApi`：`/get-models`、`/chat`、`/completion`、`/chat-input-completion`
  - `callApiStream`：`/chat-stream`、`/prompt-enhancer`、`/generate-commit-message-stream`
- **已删除且禁止恢复**的旧端点字符串：
  - `/edit`
  - `/generate-conversation-title`
  - `/next_edit_loc`
  - `/instruction-stream`
  - `/smart-paste-stream`
- `tools/check/byok-contracts/main.js` 会扫描 stale endpoint string；恢复这些旧名会直接打破 contracts。
- `routing.rules[endpoint]` 只接受 `{ mode, providerId?, model? }`，`mode` 只接受 `byok | official | disabled`。
- `mode=disabled` 语义固定：
  - `callApi` 返回 `{}`；
  - `callApiStream` 返回空 stream。
- model id 语义固定：`byok:<providerId>:<modelId>`。

### 配置契约

- 配置字段名固定 **camelCase**；不要恢复 snake_case / 旧别名。
- provider.type 只允许：
  - `openai_compatible`
  - `openai_responses`
  - `anthropic`
  - `gemini_ai_studio`
- `/get-models` 与非 `/get-models` 路由都要求 provider “可执行”：
  - 有 `baseUrl`
  - 有可用 auth（`apiKey` 或有效 auth header）
  - type 在已知集合内
- `ui/config-io.js` 的 import merge 语义是契约：
  - incoming secret 为空或 `<redacted>` 时，保留当前已存 secret
  - 扩展新的 auth header 名称时，必须同步 redaction、merge preserve、tests

### 官方拼接 / shim 注入契约

- `patch-callapi-shim.js` 注入必须发生在 upstream side effect 之前。`check-callapi-shim.js` 会校验：
  - 在 `new URL(...)` / `getCompletionURL()` / `getAPIToken()` 之前执行
  - 只透传 `arguments[5]` / `arguments[10]`
  - 不在 patch 层 `delete body.third_party_override`
  - 不提前读取 upstream config token
  - 不提前 stringify completionURL
- `third_party_override` / `thirdPartyOverride` 的剥离属于 runtime shim，不属于 patch 层或 provider 层。
- Official context injection 是 **fail-open**：缺 token/URL 只允许显式降级日志，不允许影响 BYOK 主链路。

### 生成与布局契约

- `tools/check/byok-contracts/main.js` 的 `requiredRelFiles` 是 overlay 布局契约。移动/重命名 `payload/extension/out/byok/**` 文件时，必须同步改 contracts 与 tests。
- `tools/report/endpoint-coverage.js` 现在不仅校验 LLM 端点，还校验 **UI endpoint catalog 与 upstream endpoint 全集一致**。  
  `payload/extension/out/byok/ui/config-panel/webview/render/index.js` 里的**非 LLM 分组与 meanings 是手工维护的**；上游新增/删除非 LLM 端点时，需要手工同步这里，`gen:llm-endpoints` 不会帮你维护这些非 LLM 分组。
- `default-config.js`、`core/official-delegation.js`、UI 的 LLM endpoint block 都由 `npm run gen:llm-endpoints` 同步。
- webview `util.js` 的已知 provider list 由 `npm run gen:provider-types` 同步。

## Change Order

### 改 LLM 端点集合时

1. 先改 `tools/report/llm-endpoints-spec.js`
2. 运行 `npm run gen:llm-endpoints`
3. 再改对应实现（shim/router/text-assembly/provider/tests/docs 说明）
4. 跑：
   - `npm run check:llm-endpoints`
   - `npm run report:coverage`
   - 相关定向测试
5. 如果变更来自上游升级，再先跑 `npm run upstream:analyze`

### 改 provider.type 时

1. 先改 `payload/extension/out/byok/core/provider-types.js`
2. 运行 `npm run gen:provider-types`
3. 再改：
   - `providers/models.js`
   - `core/provider-text.js`
   - `core/provider-augment-chat.js`
   - historySummary provider dispatch
   - UI provider 选择与 tests
4. 跑：
   - `npm run check:provider-types`
   - `npm run check:provider-dispatch`
   - provider 相关测试

### 改配置字段 / 存储 key / secret 处理时

1. 先改 `payload/extension/out/byok/config/default-config.js`
2. 再改 `normalize-config.js`、`config.js`、`state.js`
3. 再改 `ui/config-io.js`、config panel UI、`README.md`、`config.example.json`
4. 最后补 `test/config-io.test.js`、`test/config-normalize.test.js`、相关 runtime tests

### 改 build patch / marker / patch 顺序时

1. 先改 `tools/patch/*.js`
2. 同步改 `tools/lib/byok-workflow.js`
3. 同步改 `tools/check/byok-contracts/main.js` / `check-callapi-shim.js`
4. 同步改对应 `test/patch-*.test.js` / `test/callapi-shim-contract.test.js`
5. 跑 `npm run check:payload-syntax`，再跑 `npm run check:contracts`

### 改 upstream 分析 / UI endpoint catalog 时

1. 跑 `npm run upstream:analyze`
2. 如果 upstream endpoint 全集变化：
   - 更新 `payload/extension/out/byok/ui/config-panel/webview/render/index.js` 的非 LLM endpoint groups 与 meanings
   - 如果 LLM 集合变化，再按“改 LLM 端点集合”流程处理
3. 跑 `npm run report:coverage`

### 改 workflow / package scripts 时

- `.github/workflows/build-release.yml` 与 `.github/workflows/upstream-check.yml` 复制了本地检查序列；改脚本名或新增必跑检查时，**两个 workflow 都要同步**。
- 不要只改 package script 而不改 workflow，或只改 workflow 而不保留本地等价命令。

## Module Rules

| 路径 | 职责 | 必须复用 | 最低验证 | 禁止事项 |
| --- | --- | --- | --- | --- |
| `payload/extension/out/byok/config/**` | 默认配置、归一化、globalState 存取 | `default-config.js`、`normalize-config.js`、`state.js` | `test/config-io.test.js`、`test/config-normalize.test.js`、`test/get-models-filter.test.js` | 不新增第二配置源；不在 provider/UI 各自解析配置 |
| `payload/extension/out/byok/core/**` | 路由、协议、model registry、history summary、provider 分发 | `core/router.js`、`core/protocol.js`、`core/provider-text.js`、`core/provider-augment-chat.js` | `test/router.test.js`、`test/provider-augment-chat.test.js`、history summary tests | 不把 provider.type 分发散落到别处；不复制 stop_reason / model registry 语义 |
| `payload/extension/out/byok/runtime/shim/**` | 拦截 callApi/callApiStream、最薄 runtime boundary | `resolveByokRouteContext()`、`stripUpstreamProviderOverrideKeys()`、text assembly | `test/runtime-boundary.test.js`、`test/callapi-shim-contract.test.js`、`test/text-assembly.test.js` | 不复制路由/配置解析；不在 rollback 路径制造副作用 |
| `payload/extension/out/byok/runtime/official/**` + `runtime/upstream/**` | 读取 upstream 组装结果、官方上下文注入、delegation 审计 | official common / delegation shared | `test/official-*.test.js` + 真实日志审计 | 不恢复手写官方 builder；不把失败吞成伪成功 |
| `payload/extension/out/byok/providers/**` | HTTP/SSE/JSON 协议适配、fallback、用量与 tool chunks | `chat-chunks-util.js`、`provider-util.js`、`request-defaults-util.js`、`sse*.js` | 对应 provider tests | 不在 caller 侧写 provider 特判；不弱化 fallback 分类 |
| `payload/extension/out/byok/ui/config-panel/**` | 配置面板、导入导出、endpoint catalog、自测入口 | `ui/config-io.js`、webview util/render/core/handlers | `test/config-io.test.js`、`test/webview-assets.test.js`、相关 webview tests | 不把业务规则搬到 UI；不手写 secret 明文显示 |
| `tools/patch/**` | 构建期对 upstream `extension.js` / webview assets 做最小外科补丁 | `patch-target.js`、marker、`webview-assets.js` | `test/patch-*.test.js` + `npm run check:contracts` | 不直接改 `.cache/work/**`；不做无 marker 的黑盒替换 |
| `tools/gen/**` | 同步 generated blocks | `sync-llm-endpoints.js`、`sync-provider-types.js` | 对应 `check:*` | 不直接手改 generated block 再假装同步完成 |
| `tools/check/**` / `tools/report/**` | fail-fast 闸门、覆盖报告、日志审计 | 现有 contract/assert helpers | 对应 test + 实际命令 | 不为了让 CI 变绿而删 guard / 放宽断言 |

## Testing / Verification

- **改 JS 结构但不改行为**：至少跑  
  `npm run check:payload-syntax && npm run check:codestyle`
- **改 LLM 端点集合 / endpoint docs / default routes / official delegation 集合**：至少跑  
  `npm run gen:llm-endpoints && npm run check:llm-endpoints && npm run report:coverage`
- **改 provider types**：至少跑  
  `npm run gen:provider-types && npm run check:provider-types && npm run check:provider-dispatch`
- **改路由 / shim / runtime rollback 边界**：至少跑  
  `node --test test/router.test.js test/runtime-boundary.test.js test/callapi-shim-contract.test.js`
- **改配置/导入导出/secret 保留**：至少跑  
  `node --test test/config-io.test.js test/config-normalize.test.js test/get-models-filter.test.js`
- **改 provider fallback / requestDefaults / stop_reason / chunk 输出**：至少跑对应 provider 定向测试，再补  
  `node --test test/provider-util.test.js test/request-defaults-util.test.js`
- **改 history summary / webview history summary patch**：至少跑  
  `node --test test/history-summary-*.test.js test/patch-webview-history-summary-node.test.js test/webview-assets.test.js`
- **改 build / patch / contracts / required files list**：至少跑  
  `npm run check:payload-syntax && npm run check:contracts`
- **改官方拼接 / official context / delegation**：
  1. 在 VS Code 里真实复现相关端点；
  2. `npm run capture:logs`
  3. `npm run check:official-delegation -- --require-all`
- **发版前或改动面较大时**：
  - 本地：`npm run check:fast`
  - 触及 build/upstream/contracts/generation：`npm run upstream:analyze && npm run check`
  - 需要最终产物：`npm run build:vsix`

### 验证阻塞说明

- `npm run check:contracts` 依赖缓存的上游 VSIX：若 `.cache/upstream/augment.vscode-augment.latest.vsix` 不存在，先跑 `npm run upstream:analyze` 或 `npm run build:vsix`。
- 多个测试会起本地 `127.0.0.1` HTTP fixture server；在受限沙箱里如果出现 `listen EPERM 127.0.0.1`，这是**环境阻塞，不是代码通过**。必须明确报告阻塞，并在允许本地监听的环境重跑；不要删测试或改测试绕过。
- 不要声称“已通过”任何未实际执行的命令。

## Do Not

- 不要编辑 `.cache/**`、`dist/**`、`vscode.log`、`webview.log`、解包后的 `extension/out/extension.js`；改源请回到 `payload/**` 与 `tools/**`。
- 不要手改任何 `BEGIN GENERATED` / `END GENERATED` 区块；先改单一真相，再运行 `npm run gen:*`。
- 不要恢复这些已删除路径/语义：`/edit`、`/generate-conversation-title`、`/next_edit_loc`、`/instruction-stream`、`/smart-paste-stream`。
- 不要恢复 `tooluseonly` / `toolusefix` 或其他已知会导致主面板空白的 webview fallback 思路。
- 不要在 patch 层原地改 upstream body；`third_party_override` 的清理属于 runtime shim。
- 不要把 provider.type 分支散落到非允许模块。
- 不要绕过 `infra/log.js`，也不要新增会打印 token/apiKey/cookie/tool arguments/tool input 的日志。
- 不要为了“修 CI”删除 contracts、删 marker 校验、删 stale endpoint 检查、放宽 provider dispatch 闸门。
- 不要手改 `upstream.lock.json` 或 `dist/upstream.lock.json`。
- 不要把 `payload/extension/out/byok/ui/config-panel/webview/render/index.js` 的非 LLM endpoint catalog 当成自动生成；上游 endpoint 全集变化时这里必须手工同步。
- 不要夹带批量格式化、跨目录重命名、无关 patch 重排；这个仓库的 contracts 和 review 成本都很高。

## Notes for Agents

- 改动前先确认你是在改**单一真相**还是**生成物**。本仓库很多地方看起来相似，但真正该改的文件很少。
- 看到 `out/` 不要默认当 build output：`payload/extension/out/byok/**` 是源；`.cache/work/**/extension/out/**` 是生成物。
- root `README.md` 是配置、路由、provider、端点与补丁面的唯一用户文档入口；具体执行契约仍以代码单一真相和 tests 为准。
- 需要新增模块时，先检查是否会触发 `check:codestyle`（400 行、命名、纯转发模块、同名 file/dir）和 `check:provider-dispatch`。
- 改动完成后，优先跑与文件名前缀同名的测试；本仓库的测试命名基本按模块/风险点对齐。
- `.github/workflows/*.yml` 是 CI 事实的一部分；本地命令与 CI 顺序不一致时，以 workflow + `package.json` 双边一致为目标。

## Stop Conditions

遇到以下情况先停，不要直接实现或“顺手修”：

- 要变更以下公共契约之一：
  - 8 个 LLM 端点集合
  - `byok:<providerId>:<modelId>` 语义
  - `routing.rules[endpoint]` 结构
  - `augment-byok.*.v1` 存储 key
  - provider.type 枚举
  - disabled / official / byok 路由语义
- 要新增新的配置源、VS Code settings、extension command、第三方依赖、provider 类型或上游 patch 面。
- 要改 `tools/lib/byok-workflow.js` 的补丁顺序、`tools/check/byok-contracts/main.js` 的 required file/marker 合约、`patch-callapi-shim.js` 的注入时序。
- 上游 `extension.js` 签名漂移导致 patch needle / contracts 失败，但你还没有先跑 `npm run upstream:analyze`、定位真实 drift，再同步 patch/tests/contracts。
- 要改 secret/redaction、official context 注入、runtime rollback boundary、provider fallback 分类这些高风险路径，却没有对应测试或日志验证路径。
- 要做任何破坏性清理（删除 patch、删除 tests、删除 stale endpoint 检查、删除 workflow 步骤）来换取“暂时通过”。
