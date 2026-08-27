# @pr-atlas/cli

`atlas` 命令行，[pr-atlas](https://github.com/priority3/pr-atlas) 的入口。一个 connector 驱动的个人信息采集运行时。

```bash
npm i -g @pr-atlas/cli
atlas help
```

数据默认写在当前目录的 `.atlas`，也可以用 `--data-dir` 或 `ATLAS_DATA_DIR` 指定。

## 手动采集

```bash
atlas capture --url "https://example.com/article" --title "一篇文章" --note "值得回看" --tag ai
atlas capture --text "今天想到的一个设计" --title "临时想法"
```

## Connector

```bash
atlas connector list
atlas config set priority --connector priority-me-blog \
  --config '{"repository_url":"https://github.com/priority3/priority.me","site_url":"https://razet.me"}'
atlas connector run priority-me-blog --instance priority --trigger manual
```

运行是增量的：来源没变的 Connector 什么也不采集。`--full` 可忽略 checkpoint 强制全量重采。

## 投递

```bash
atlas target set local --kind file --config '{"directory":"./atlas-export"}'
atlas target set remote --kind webhook \
  --config '{"url":"https://example.com/hook","token_env":"PR_ATLAS_SINK_TOKEN"}'
atlas sync --target local
```

`privacy.level` 为 `sensitive` 的 capture 不会投递到网络目标，除非该目标显式声明 `include_privacy_levels`；被跳过的条目保持 `pending` 并出现在 `atlas sync` 输出的 `skipped` 字段里。

## 查看

```bash
atlas status
atlas config list
atlas retry [--id <capture-id>]
```

完整说明见[仓库 README](https://github.com/priority3/pr-atlas#readme)。
