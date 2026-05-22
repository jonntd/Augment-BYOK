(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});
  const { normalizeStr, uniq, escapeHtml, optionHtml, computeProviderIndexById } = ns;

  const ENDPOINT_GROUPS_V1 = [
    {
      id: "llm_data_plane",
      label: "LLM 数据面（8）",
      endpoints: [
        /* BEGIN GENERATED: LLM_ENDPOINTS */
        "/get-models",
        "/chat",
        "/completion",
        "/chat-input-completion",
        "/chat-stream",
        "/prompt-enhancer",
        "/next-edit-stream",
        "/generate-commit-message-stream"
        /* END GENERATED: LLM_ENDPOINTS */
      ]
    },
    {
      id: "remote_agents",
      label: "Remote Agents（4）",
      endpoints: [
        "/remote-agents/list",
        "/remote-agents/list-stream",
        "/remote-agents/get-chat-history",
        "/remote-agents/agent-history-stream"
      ]
    },
    {
      id: "agents_tools",
      label: "Agents / Tools（7）",
      endpoints: [
        "/agents/check-tool-safety",
        "/agents/revoke-tool-access",
        "/agents/list-remote-tools",
        "/agents/run-remote-tool",
        "/agents/edit-file",
        "/agents/codebase-retrieval",
        "/agents/codebase-retrieval-raw"
      ]
    },
    {
      id: "blobs_context_sync",
      label: "文件/Blob/上下文同步（9）",
      endpoints: [
        "/batch-upload",
        "/checkpoint-blobs",
        "/find-missing",
        "/save-chat",
        "/context-canvas/list",
        "/search-external-sources",
        "/indexed-commits/get-latest-blobset",
        "/indexed-commits/register-blobset",
        "/chat/exchanges/list"
      ]
    },
    {
      id: "cloud_agents_experts",
      label: "Cloud Agents / Experts（2）",
      endpoints: [
        "/cloud-agents/agents/send-message",
        "/cloud-experts/experts/create-agent"
      ]
    },
    {
      id: "auth_subscription",
      label: "账号/订阅/权限（5）",
      endpoints: [
        "/token",
        "/get-credit-info",
        "/get-billing-summary",
        "/subscription-banner",
        "/settings/get-tenant-tool-permissions"
      ]
    },
    {
      id: "feedback_telemetry_debug",
      label: "反馈/遥测/调试（11）",
      endpoints: [
        "/chat-feedback",
        "/client-metrics",
        "/client-completion-timelines",
        "/record-session-events",
        "/record-user-events",
        "/record-request-events",
        "/report-error",
        "/resolve-completions",
        "/resolve-chat-input-completion",
        "/resolve-edit",
        "/resolve-next-edit"
      ]
    },
    {
      id: "notifications",
      label: "通知（2）",
      endpoints: [
        "/notifications/read",
        "/notifications/mark-as-read"
      ]
    }
  ];

  const ENDPOINT_MEANINGS_V1 = {
    /* BEGIN GENERATED: LLM_ENDPOINT_MEANINGS */
    "/get-models": "拉取可用模型/feature flags（并可注入 BYOK models registry）",
    "/chat": "非流式 chat（或某些场景的 chat 请求）",
    "/completion": "编辑器 inline completion（短文本）",
    "/chat-input-completion": "Chat 输入框智能补全",
    "/chat-stream": "核心聊天流（Augment NDJSON）",
    "/prompt-enhancer": "提示词增强（stream）",
    "/next-edit-stream": "Next Edit 建议（stream）",
    "/generate-commit-message-stream": "Commit message（stream）",
    /* END GENERATED: LLM_ENDPOINT_MEANINGS */

    "/remote-agents/list": "列表（一次性）",
    "/remote-agents/list-stream": "列表（流式更新）",
    "/remote-agents/get-chat-history": "拉取对话历史（一次性）",
    "/remote-agents/agent-history-stream": "对话/事件历史流",

    "/agents/check-tool-safety": "工具安全性检查/准入",
    "/agents/revoke-tool-access": "撤销工具权限",
    "/agents/list-remote-tools": "列出可用远程工具",
    "/agents/run-remote-tool": "执行远程工具",
    "/agents/edit-file": "通过 agent 执行文件编辑",
    "/agents/codebase-retrieval": "代码库检索",
    "/agents/codebase-retrieval-raw": "代码库检索（raw）",

    "/batch-upload": "批量上传 blobs（文件内容/上下文）",
    "/checkpoint-blobs": "checkpoint 相关 blobs 操作",
    "/find-missing": "查找缺失 blob",
    "/save-chat": "保存会话/记录（服务端持久化）",
    "/context-canvas/list": "Context Canvas 列表",
    "/search-external-sources": "外部来源搜索",
    "/indexed-commits/get-latest-blobset": "Indexed commits 最新 blobset",
    "/indexed-commits/register-blobset": "Indexed commits 注册 blobset",
    "/chat/exchanges/list": "Chat exchanges 列表",

    "/cloud-agents/agents/send-message": "Cloud agent 发送消息",
    "/cloud-experts/experts/create-agent": "Cloud expert 创建 agent",

    "/token": "token 获取/刷新（鉴权相关）",
    "/get-credit-info": "额度/credits 信息",
    "/get-billing-summary": "账单摘要",
    "/subscription-banner": "订阅提示 banner",
    "/settings/get-tenant-tool-permissions": "tenant 级工具权限配置",

    "/chat-feedback": "聊天反馈",
    "/client-metrics": "客户端指标",
    "/client-completion-timelines": "completion timeline（行为序列）",
    "/record-session-events": "会话事件",
    "/record-user-events": "用户事件",
    "/record-request-events": "请求事件记录",
    "/report-error": "错误上报",
    "/resolve-completions": "resolve*（日志/归因类）",
    "/resolve-chat-input-completion": "resolve*（日志/归因类）",
    "/resolve-edit": "resolve*（日志/归因类）",
    "/resolve-next-edit": "resolve*（日志/归因类）",

    "/notifications/read": "拉取通知",
    "/notifications/mark-as-read": "标记已读"
  };

  ns.ENDPOINT_GROUPS_V1 = ENDPOINT_GROUPS_V1;
  ns.ENDPOINT_MEANINGS_V1 = ENDPOINT_MEANINGS_V1;

  // Keep namespace shape stable (avoid unused warnings in older bundlers).
  void normalizeStr;
  void uniq;
  void optionHtml;
  void computeProviderIndexById;
})();
