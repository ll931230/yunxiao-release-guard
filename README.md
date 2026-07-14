# yunxiao-release-guard

云效生产发布分支保护 CLI。

它用于生产流水线发布前检查：

```text
当前部署分支必须包含上一条成功生产部署分支。
```

典型场景：

```text
release/0707 已上线
release/0720 准备上线
测试环境已经跑到 release/0730
```

这时生产流水线应检查 `release/0720` 是否包含 `release/0707`，而不是从测试环境反推上线分支。

## 使用方式

在云效生产流水线构建命令最前面添加：

```bash
npx -y yunxiao-release-guard@latest
```

需要在流水线变量或通用变量组里配置一次：

```bash
YUNXIAO_ACCESS_TOKEN=pt-xxxx
```

`YUNXIAO_ORGANIZATION_ID` 默认使用 `62650a04c2b7347ce520e7e4`。`PIPELINE_ID` 和 `CI_COMMIT_REF_NAME` 是云效运行时环境变量，通常不需要手动传参。

如果不想自动查询上一条生产分支，也可以手动指定：

```bash
npx -y yunxiao-release-guard@latest \
  --current-branch="$CI_COMMIT_REF_NAME" \
  --previous-branch="release/0707"
```

## 判断逻辑

自动模式：

1. 读取当前流水线 ID：`PIPELINE_ID`。
2. 查询当前流水线最近一次 `SUCCESS` 运行。
3. 从运行详情里读取 `CI_COMMIT_REF_NAME`，得到上一条生产部署分支。
4. 执行 `git merge-base --is-ancestor origin/<上一生产分支> HEAD`。
5. 不包含则退出码为 `1`，阻断流水线。

## 常用参数

```text
--organization-id=xxx      云效组织 ID，也可用 YUNXIAO_ORGANIZATION_ID，默认 62650a04c2b7347ce520e7e4
--pipeline-id=xxx          当前云效流水线 ID，也可用 PIPELINE_ID
--current-branch=xxx       当前部署分支，也可用 CI_COMMIT_REF_NAME
--previous-branch=xxx      手动指定上一生产分支；指定后不调用云效接口
--skip-same-branch=false   上一生产分支与当前分支相同也继续检查，默认 false
--debug                    输出调试日志
--help                     查看帮助
```

## 注意

- Git 只能判断分支包含关系，不知道哪个分支上过生产；上一生产分支必须来自云效流水线历史或手动传入。
- 自动模式依赖 `npx -y alibabacloud-devops-mcp-server` 查询云效接口。
- 脚本不会读取或输出 `YUNXIAO_ACCESS_TOKEN`。
