# pr-lore

`pr-lore` 是一个独立的个人信息采集运行时。它只定义「内容源如何输入」和「统一记忆如何输出」，不依赖任何特定 Blog、Astro、CMS 或站点仓库。

当前 CLI 名称是 `lore`。后续可以在同一套 Connector SDK 上增加常驻调度进程 `lored`、上传服务和可视化审核界面。

## 架构

```text
Connector Definition
        |
        v
Connector Instance -- schedule / checkpoint / config
        |
        v
      lore connector run
        |
        v
  LoreCapture (lore.capture.v1)
        |
        v
  Local Outbox (.lore/outbox)
        |
        +--> future sync service / review UI / LLM index
```

仓库分层：

| 目录 | 职责 |
| --- | --- |
| `packages/schema` | `LoreCapture`、Connector manifest/context/result、稳定 ID 和 schema 基础校验 |
| `packages/core` | Connector registry、运行上下文、手动 capture、文件型 outbox |
| `packages/connectors` | 内置内容源。当前包含 `generic-web` 和 `priority-me-blog` |
| `apps/cli` | `lore` 命令、实例配置、触发 Connector、把结果写入 outbox |

Connector 是可插拔的采集能力；未来更宽泛的安装包能力可以叫 Extension，但当前协议只使用 Connector。

## 统一输出

所有来源都输出同一个 `lore.capture.v1`，不再为「记住一个链接」「关注一个来源」「导入一篇文章」设计三套数据结构。

```json
{
  "schema_version": "lore.capture.v1",
  "id": "cap_...",
  "connector": "priority-me-blog",
  "instance_id": "priority",
  "run_id": "run_...",
  "observed_at": "2026-08-25T00:00:00.000Z",
  "captured_at": "2026-08-25T00:00:00.000Z",
  "subject": {
    "kind": "document",
    "uri": "github://owner/repo/src/content/blogs/hello.md?ref=main",
    "title": "Hello",
    "url": "https://example.com/posts/hello"
  },
  "payload": {
    "kind": "markdown",
    "text": "文章正文",
    "raw_ref": "https://github.com/owner/repo/blob/main/src/content/blogs/hello.md",
    "content_hash": "sha256:...",
    "mime_type": "text/markdown"
  },
  "note": null,
  "tags": ["memory"],
  "metadata": {},
  "privacy": {
    "level": "private",
    "allow_cloud_llm": false
  },
  "provenance": {
    "trigger": "schedule",
    "connector_version": "priority-me-blog@1.0.0",
    "cursor": "blob-sha"
  }
}
```

`id` 对同一个 Connector 实例、来源 URI 和内容哈希保持稳定，因此 cron 重跑不会产生重复 outbox 条目。`observed_at` 记录本次观察时间，内容变化时哈希和 ID 都会变化。

## CLI

安装依赖后，在仓库根目录运行：

```bash
pnpm install
pnpm lore help
```

开发阶段可以把下面的 `lore` 替换为 `pnpm lore`；发布 CLI 后再直接使用 `lore`。

默认数据目录是当前目录的 `.lore`，也可以用 `--data-dir` 或 `LORE_DATA_DIR` 指定。`.lore` 已加入 `.gitignore`。

手动采集 URL 或文本：

```bash
lore capture --url "https://example.com/article" --title "一篇文章" --note "值得回看" --tag ai
lore capture --text "今天想到的一个设计" --title "临时想法"
```

查看 Connector、outbox 和实例：

```bash
lore connector list
lore status
lore config list
```

`lore save --file capture.json` 可把一个 capture（或包含 `capture` 字段的 CLI 输出）放进 outbox；`lore retry` 会把失败条目重新置为 pending。

## priority.me Blog Connector

这个 Connector 的输入是 **GitHub 仓库地址**，不是本地目录，也不 import `priority.me` 的代码。它通过 GitHub API：

1. 读取仓库默认分支（或配置的 branch）。
2. 获取递归 Git tree。
3. 默认只筛选 `src/content/blogs` 下的 `.md` 和 `.mdoc`。
4. 读取 blob，解析简单 YAML frontmatter，输出文章正文和来源信息。

因此 `src/content/leetcode` 会被排除。也可以直接传 GitHub tree 地址，例如 `https://github.com/owner/repo/tree/main/src/content/blogs`，此时会自动推断 branch 和目录。

先写入一个 Connector instance：

```bash
  lore config set priority \
  --connector priority-me-blog \
  --config '{
    "repository_url": "https://github.com/priority3/priority.me",
    "site_url": "https://razet.me",
    "source_name": "priority.me",
    "content_dir": "src/content/blogs",
    "privacy_level": "private",
    "allow_cloud_llm": false
  }'
```

执行一次：

```bash
lore connector run priority-me-blog --instance priority --trigger manual
```

由 cron 定期触发：

```cron
0 * * * * cd /path/to/pr-lore && lore connector run priority-me-blog --instance priority --trigger schedule >> /tmp/lore.log 2>&1
```

公共仓库不需要令牌。私有仓库不要把 token 放进 `config.json`，只配置环境变量名：

```json
{
  "repository_url": "https://github.com/owner/private-blog",
  "token_env": "PR_LORE_GITHUB_TOKEN"
}
```

运行命令前由操作系统或服务管理器注入 `PR_LORE_GITHUB_TOKEN`。Blog capture 默认 `private` 且不允许云端 LLM；只有明确写入 `allow_cloud_llm: true` 才会改变这一点。

## Connector SDK

Connector 只需要实现三个部分：

```ts
import type { ConnectorContext, ConnectorResult, LoreConnector } from '@pr-lore/schema'

export const connector: LoreConnector = {
  manifest() {
    return {
      id: 'my-source',
      version: '1.0.0',
      name: 'My Source',
      description: 'Collect something useful',
      capabilities: ['manual', 'scheduled'],
      permissions: ['network'],
      default_schedule: null,
      config_schema: { type: 'object' }
    }
  },
  async collect(context: ConnectorContext): Promise<ConnectorResult> {
    // 读取 context.instance.config，转换成 LoreCapture[]
    return { captures: [], checkpoint: context.instance.checkpoint }
  }
}
```

`ConnectorInstance` 是运行配置，不是 Connector 定义：

```ts
{
  "id": "my-source-main",
  "connector": "my-source",
  "enabled": true,
  "schedule": "0 * * * *",
  "config": {},
  "checkpoint": null
}
```

Connector 不应依赖 CLI、Blog 站点实现或用户 home 目录；所有输入都来自 `config`，所有输出都通过 `ConnectorResult` 返回。这样同一个 Connector 可以被 CLI、未来的 daemon、webhook 或测试夹具复用。

## 开发检查

```bash
pnpm typecheck
pnpm test
pnpm build
```

当前 `build` 使用 TypeScript `--noEmit` 做包级边界检查；后续发布时再接入 bundling 和签名安装流程。
