# @pr-lore/cli

`lore` 命令行，[pr-lore](https://github.com/priority3/pr-lore) 的入口。一个 connector 驱动的个人信息采集运行时。

```bash
npm i -g @pr-lore/cli
lore help
```

数据默认写在当前目录的 `.lore`，也可以用 `--data-dir` 或 `LORE_DATA_DIR` 指定。

## 手动采集

```bash
lore capture --url "https://example.com/article" --title "一篇文章" --note "值得回看" --tag ai
lore capture --text "今天想到的一个设计" --title "临时想法"
```

## Connector

```bash
lore connector list
lore config set priority --connector priority-me-blog \
  --config '{"repository_url":"https://github.com/priority3/priority.me","site_url":"https://razet.me"}'
lore connector run priority-me-blog --instance priority --trigger manual
```

运行是增量的：来源没变的 Connector 什么也不采集。`--full` 可忽略 checkpoint 强制全量重采。

## 投递

```bash
lore target set local --kind file --config '{"directory":"./lore-export"}'
lore target set remote --kind webhook \
  --config '{"url":"https://example.com/hook","token_env":"PR_LORE_SINK_TOKEN"}'
lore sync --target local
```

`privacy.level` 为 `sensitive` 的 capture 不会投递到网络目标，除非该目标显式声明 `include_privacy_levels`；被跳过的条目保持 `pending` 并出现在 `lore sync` 输出的 `skipped` 字段里。

## 查看

```bash
lore status
lore config list
lore retry [--id <capture-id>]
```

完整说明见[仓库 README](https://github.com/priority3/pr-lore#readme)。
