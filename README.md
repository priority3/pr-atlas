# pr-atlas

`pr-atlas` 是一个独立的个人信息采集运行时。它只定义「内容源如何输入」和「统一记忆如何输出」，不依赖任何特定 Blog、Astro、CMS 或站点仓库。

当前 CLI 名称是 `atlas`。后续可以在同一套 Connector SDK 上增加常驻调度进程 `atlasd`、上传服务和可视化审核界面。

## 架构

```text
Connector Definition
        |
        v
Connector Instance -- schedule / checkpoint / config
        |
        v
      atlas connector run
        |
        v
  AtlasCapture (atlas.capture.v1)
        |
        v
  Local Outbox (.atlas/outbox/{pending,sent,failed})
        |
        v
  Deliverer -- atlas sync
        |
        +--> file export / webhook / future review UI / LLM index
```

仓库分层：

| 目录 | 职责 |
| --- | --- |
| `packages/schema` | `AtlasCapture`、Connector manifest/context/result、稳定 ID、capture 与 instance 校验、`config_schema` 的 JSON Schema 子集校验器 |
| `packages/core` | Connector registry、运行上下文、手动 capture、状态目录型 outbox、Deliverer 与 `syncOutbox` |
| `packages/connectors` | 内置内容源。当前包含 `generic-web` 和 `priority-me-blog` |
| `apps/cli` | `atlas` 命令、实例与投递目标配置、触发 Connector、把结果写入 outbox 并投递 |

Connector 是可插拔的采集能力；未来更宽泛的安装包能力可以叫 Extension，但当前协议只使用 Connector。

## 统一输出

所有来源都输出同一个 `atlas.capture.v1`，不再为「记住一个链接」「关注一个来源」「导入一篇文章」设计三套数据结构。

```json
{
  "schema_version": "atlas.capture.v1",
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

## 增量采集

Connector 每次运行都会返回 checkpoint，下一次运行把它作为输入。声明了 `incremental` 能力的 Connector 必须真正使用它。

`priority-me-blog` 的增量分三层：

1. 仓库 tree SHA 与 checkpoint 一致 → 直接返回 0 条 capture，**跳过全部 blob 请求**。这是绝大多数定时运行的实际路径。
2. tree 变了 → 逐文件比对 blob SHA，只拉取新增和变更的文件；未变的文件不产出 capture。
3. checkpoint 的 `ref` 或 `content_dir` 与当前配置不符 → 视为无效，退回全量扫描。

blob 请求以并发上限 4 并行，并保持输入顺序。未认证的 GitHub API 每小时只有 60 次配额；配额耗尽时错误信息会指出是配额问题而非鉴权问题，并说明该配 `token_env` 还是收窄 `content_dir`。

要忽略 checkpoint 强制全量重采：

```bash
atlas connector run priority-me-blog --instance priority --full
```

## 投递与同步

outbox 里的条目通过 **Deliverer** 出站。状态由文件位置表示（`.atlas/outbox/{pending,sent,failed}/`），所以计数是一次目录列举，状态流转是一次原子 rename。

内置两种目标：

```bash
# 导出到本地目录
atlas target set local --kind file --config '{"directory":"./atlas-export"}'

# POST 到 HTTP 端点，token 只配环境变量名
atlas target set remote --kind webhook \
  --config '{"url":"https://example.com/hook","token_env":"PR_ATLAS_SINK_TOKEN"}'

atlas target list
atlas target kinds     # 查看每种目标的 config schema
atlas sync --target local [--limit 20] [--id <capture-id>]
```

投递失败会把条目标为 `failed` 并累加 `attempts`，`atlas retry` 可把它们改回 `pending`。

**隐私默认 fail-closed**：`privacy.level` 为 `sensitive` 的 capture 不会投递到 webhook 目标，除非该目标显式声明 `include_privacy_levels`。被跳过的条目既不算成功也不算失败，保持 `pending`，并出现在 `atlas sync` 输出的 `skipped` 字段里 —— 不静默丢弃。

只配置了一个目标时 `--target` 可省略；配置了多个时必须显式指定。

## CLI

安装依赖后，在仓库根目录运行：

```bash
pnpm install
pnpm atlas help
```

开发阶段可以把下面的 `atlas` 替换为 `pnpm atlas`；发布 CLI 后再直接使用 `atlas`。

默认数据目录是当前目录的 `.atlas`，也可以用 `--data-dir` 或 `ATLAS_DATA_DIR` 指定。`.atlas` 已加入 `.gitignore`。

手动采集 URL 或文本：

```bash
atlas capture --url "https://example.com/article" --title "一篇文章" --note "值得回看" --tag ai
atlas capture --text "今天想到的一个设计" --title "临时想法"
```

查看 Connector、outbox 和实例：

```bash
atlas connector list
atlas status
atlas config list
```

`atlas save --file capture.json` 可把一个 capture（或包含 `capture` 字段的 CLI 输出）放进 outbox；`atlas retry` 会把失败条目重新置为 pending。

`atlas help` 列出全部命令。

## priority.me Blog Connector

这个 Connector 的输入是 **GitHub 仓库地址**，不是本地目录，也不 import `priority.me` 的代码。它通过 GitHub API：

1. 读取仓库默认分支（或配置的 branch）。
2. 获取递归 Git tree。
3. 默认只筛选 `src/content/blogs` 下的 `.md` 和 `.mdoc`。
4. 读取 blob，解析 YAML frontmatter，输出文章正文和来源信息。

因此 `src/content/leetcode` 会被排除。也可以直接传 GitHub tree 地址，例如 `https://github.com/owner/repo/tree/main/src/content/blogs`，此时会自动推断 branch 和目录。

### frontmatter 支持范围

解析器是零依赖的 YAML 子集实现，支持：

- `key: value` 标量，含引号字符串、布尔、数字、`null` / `~`
- 内联集合 `[a, b]` 与 `{a: 1}`
- 块序列 `- item`（含同缩进写法），以及映射序列
- 任意深度的嵌套映射
- 块标量 `|` 与 `>`
- `#` 注释（块标量内部的 `#` 视为正文）

明确**不支持**并会直接报错的构造：tab 缩进、锚点与别名（`&x` / `*x`）、合并键（`<<:`）、复杂键（`? `）、多文档。

这里的取舍是：宁可解析失败也不静默丢数据。此前的实现会跳过任何不认识的语法，一个缩进写法不同的 `tags:` 列表就会变成「没有 tags」而毫无提示。日期保持为字符串，因为 capture metadata 是 JSON。

先写入一个 Connector instance：

```bash
  atlas config set priority \
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
atlas connector run priority-me-blog --instance priority --trigger manual
```

由 cron 定期触发：

```cron
0 * * * * cd /path/to/pr-atlas && atlas connector run priority-me-blog --instance priority --trigger schedule >> /tmp/atlas.log 2>&1
```

公共仓库不需要令牌。私有仓库不要把 token 放进 `config.json`，只配置环境变量名：

```json
{
  "repository_url": "https://github.com/owner/private-blog",
  "token_env": "PR_ATLAS_GITHUB_TOKEN"
}
```

运行命令前由操作系统或服务管理器注入 `PR_ATLAS_GITHUB_TOKEN`。Blog capture 默认 `private` 且不允许云端 LLM；只有明确写入 `allow_cloud_llm: true` 才会改变这一点。

## Connector SDK

Connector 只需要实现三个部分：

```ts
import type { ConnectorContext, ConnectorResult, AtlasConnector } from '@pr-atlas/schema'

export const connector: AtlasConnector = {
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
    // 读取 context.instance.config，转换成 AtlasCapture[]
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

`packages/connectors` 只依赖 `packages/schema`，不依赖 `packages/core`。这条边界是刻意维持的：Connector 不知道 registry、outbox 或 CLI 的存在，因此可以脱离运行时单独测试。

### config_schema 会被真正执行

manifest 里的 `config_schema` 不是文档，而是会被校验的契约。`runConnector` 在调用 `collect` 前校验 `instance.config`，`atlas config set` 在写入前也校验一次 —— 前者是强制点（daemon、webhook 走同一条路），后者是为了让拼写错误在配置时就暴露：

```bash
$ atlas config set bad --connector generic-web --config '{"urlx":"x"}'
atlas: Invalid config for connector generic-web:
  - config.url is required
  - config.urlx is not a recognized option (did you mean "url"?)
```

校验器是 JSON Schema 的一个子集（`type`、`required`、`properties`、`additionalProperties`、`items`、`enum`、`format: uri`、`minLength`、`minItems`），未知关键字会被忽略，因此 manifest 可以携带 `description`、`default` 这类纯文档字段。内置 Connector 都声明了 `additionalProperties: false`。

## 开发检查

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm rebuild    # clean + build，等价于 pnpm clean && pnpm build
```

`pnpm build` 通过 TypeScript project references 逐包编译到 `dist/`，产出 `.js` + `.d.ts` + sourcemap，不引入任何打包器。构建完成后 CLI 可以脱离 `tsx` 直接运行：

```bash
pnpm build
node apps/cli/dist/main.js help
```

各包的 `exports` 同时声明两个条件：

- `development` → `src/*.ts`，开发与测试用 `tsx --conditions=development` 走这条，**无需先构建**；
- `default` → `dist/*.js`，`node` 直接运行产物或将来发布时走这条。

`typecheck` 用独立的 `tsconfig.typecheck.json`，通过 `customConditions: ["development"]` 直接对源码做检查（并覆盖 `src` 与 `test`），因此类型检查同样不依赖构建产物。

## 发布

四个包以 MIT 许可证发布在 npmjs.org：

| 包 | 用途 |
| --- | --- |
| [`@pr-atlas/cli`](https://www.npmjs.com/package/@pr-atlas/cli) | `atlas` 命令，`npm i -g @pr-atlas/cli` |
| [`@pr-atlas/core`](https://www.npmjs.com/package/@pr-atlas/core) | registry、outbox、Deliverer |
| [`@pr-atlas/connectors`](https://www.npmjs.com/package/@pr-atlas/connectors) | 内置内容源 |
| [`@pr-atlas/schema`](https://www.npmjs.com/package/@pr-atlas/schema) | 数据契约，零依赖 |

发布走 `scripts/release.sh`：

```bash
pnpm release --dry-run          # 走完全部检查与打包，但不发布
pnpm release                    # 发布 package.json 里当前的版本
pnpm release --version 0.3.0    # 先把所有包统一改成 0.3.0，提交，再发布
pnpm release --otp 123456       # 透传双因子验证码
pnpm release --publish-only --otp 123456   # 跳过质量门直接发布
```

npmjs.org 现在**强制要求发布方开启 2FA**，所以 `--otp` 基本是必需的。而 TOTP 只有 30 秒有效期，质量门（typecheck + test + 干净重建）要跑半分钟左右，验证码往往在用到之前就过期了。所以实际发布分两步：先 `pnpm release --dry-run` 确认全绿，再取一个新验证码跑 `pnpm release --publish-only --otp <码>`。`--publish-only` 只跳过质量门，仓库状态、登录态、版本一致性和产物校验照常执行。

脚本按顺序做这些事，任一步失败即停：分支必须是 main、工作区干净、与 `origin/main` 同步 → 校验 npmjs.org 登录态 → 四个包版本与根一致 → `typecheck` → `test` → 干净重建 → 校验产物齐全、bin 入口带 shebang、CLI 能脱离 tsx 运行 → 打包演练 → 按拓扑序发布 → 打 tag 并推送。

两个容易踩的点已经在脚本和配置里处理掉：

- 仓库 `.npmrc` 把 registry 指向 npmmirror 镜像，镜像是只读的。所以每条发布命令都显式带 `--registry https://registry.npmjs.org/`，各包也写了 `publishConfig.registry`，不依赖环境里恰好是什么源。
- 包之间用 `workspace:*` 互相引用，`pnpm publish` 会在打包时把它改写成具体版本号。因此必须用 `pnpm publish` 而不是 `npm publish`，否则发出去的包会带着一个装不上的 `workspace:*` 依赖。

`files` 里带了 `src`，这样 `dist/*.js.map` 引用的源码能被解析到，报错栈可以直接跳转；`dist/**/*.tsbuildinfo` 是增量编译缓存，用否定模式排除。

重跑是安全的：`pnpm publish` 会跳过 registry 上已存在的版本，所以中途失败后直接再执行一次即可。
