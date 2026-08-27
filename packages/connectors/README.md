# @pr-lore/connectors

[pr-lore](https://github.com/priority3/pr-lore) 的内置内容源。只依赖 `@pr-lore/schema`，**不依赖 `@pr-lore/core`** —— Connector 不知道 registry、outbox 或 CLI 的存在，因此可以脱离运行时单独测试。

```bash
npm i @pr-lore/connectors
```

## generic-web

抓取任意 URL，产出一条 capture。

```ts
import { createGenericWebConnector } from '@pr-lore/connectors/generic-web'
```

## priority-me-blog

输入是 **GitHub 仓库地址**，通过 GitHub API 读取递归 tree，筛选内容目录下的 `.md` / `.mdoc`，解析 YAML frontmatter 后输出正文与来源信息。

```ts
import { createPriorityMeBlogConnector } from '@pr-lore/connectors/priority-me-blog'
```

增量分三层：仓库 tree SHA 与 checkpoint 一致则直接返回 0 条并**跳过全部 blob 请求**；tree 变了则逐文件比对 blob SHA，只拉取新增和变更的文件；checkpoint 的 `ref` 或 `content_dir` 与当前配置不符则视为无效，退回全量扫描。blob 请求以并发上限 4 并行并保持输入顺序。

frontmatter 解析器是零依赖的 YAML 子集实现，对不支持的构造（tab 缩进、锚点别名、合并键、复杂键、多文档）**直接报错而非静默跳过** —— 宁可解析失败也不静默丢数据。

完整说明见[仓库 README](https://github.com/priority3/pr-lore#readme)。
