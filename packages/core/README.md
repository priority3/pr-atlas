# @pr-lore/core

[pr-lore](https://github.com/priority3/pr-lore) 的运行时。除 `@pr-lore/schema` 外零依赖。

包含：

- `ConnectorRegistry` 与 `runConnector`（调用 `collect` 前强制校验 `config_schema`）
- `createManualCapture`：把一个 URL 或一段文本变成 capture
- `OutboxStore`：状态由文件位置表示的 outbox，`.lore/outbox/{pending,sent,failed}`，状态流转是一次原子 rename
- `Deliverer` 与 `syncOutbox`：内置 file / webhook 两种目标

```bash
npm i @pr-lore/core
```

```ts
import { ConnectorRegistry, runConnector, OutboxStore, syncOutbox, createDeliverer } from '@pr-lore/core'

const registry = new ConnectorRegistry()
registry.register(myConnector)

const result = await runConnector(registry, instance, { trigger: 'schedule' })

const outbox = new OutboxStore('.lore/outbox')
for (const capture of result.captures) await outbox.enqueue(capture)

const deliverer = createDeliverer('file', { directory: './lore-export' }, 'local')
const summary = await syncOutbox(outbox, deliverer)
```

隐私默认 fail-closed：`privacy.level` 为 `sensitive` 的 capture 不会投递到 webhook 目标，除非该目标显式声明 `include_privacy_levels`。被跳过的条目保持 `pending` 并出现在 `SyncSummary.skipped` 里，不静默丢弃。

完整说明见[仓库 README](https://github.com/priority3/pr-lore#readme)。
