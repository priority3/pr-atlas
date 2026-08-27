# @pr-atlas/schema

[pr-atlas](https://github.com/priority3/pr-atlas) 的数据契约层。零运行时依赖。

包含：

- `atlas.capture.v1` 的类型定义与运行时校验
- Connector manifest / instance / context / result 的类型
- 稳定 ID 与内容哈希
- 一个 JSON Schema 子集校验器，用于执行 manifest 里的 `config_schema`

```bash
npm i @pr-atlas/schema
```

```ts
import {
  assertValidCapture,
  assertConnectorInstance,
  validateJsonSchema,
  stableId,
  hashText,
  type AtlasCapture,
  type AtlasConnector,
} from '@pr-atlas/schema'

// 校验失败会抛出带具体字段路径的错误，而不是静默返回 false
const capture: AtlasCapture = assertValidCapture(JSON.parse(raw))

// config_schema 是被执行的契约，不是文档；返回人类可读的错误列表，空数组表示通过
const errors = validateJsonSchema(manifest.config_schema, config, 'config')
```

`stableId` 对同一个 Connector 实例、来源 URI 和内容哈希返回相同的 ID，因此定时重跑不会产生重复条目。

完整说明见[仓库 README](https://github.com/priority3/pr-atlas#readme)。
