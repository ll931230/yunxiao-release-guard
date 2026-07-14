<!--
 * @Author: 刘磊01 lei.liu01@trinapower.com
 * @Date: 2026-07-14 10:11:50
 * @LastEditors: 刘磊01 lei.liu01@trinapower.com
 * @LastEditTime: 2026-07-14 11:04:30
 * @FilePath: /yunxiao-release-guard/README.md
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
-->
# yunxiao-release-guard

云效测试、生产流水线发布分支保护 CLI。

它用于发布前检查：

```text
当前部署分支必须包含主分支的最新提交。
```

例如 `release/0707` 上线并合入 `main` 后，准备发布 `release/0720` 时，必须先把最新 `main` 合入 `release/0720`。如果漏掉这一步，CLI 会退出并阻断流水线。

## 流水线直接执行

推荐在云效 Node.js 构建命令中通过固定版本临时执行，不需要把 CLI 添加到项目依赖：

```bash
set -e

npm config set registry http://your-npm-registry.example.com/repository/npm_group/
npx -y yunxiao-release-guard@0.3.1

pnpm install --ignore-scripts
pnpm run build
```

如果希望统一使用 pnpm：

```bash
pnpm dlx yunxiao-release-guard@0.3.1
```

建议固定 CLI 版本，不要在生产流水线中使用 `@latest`，避免工具升级后未经确认就影响所有项目。

## 判断逻辑

CLI 会：

1. 从 `PROJECT_DIR` 或当前目录定位流水线下载的 Git 仓库。
2. 读取 `CI_COMMIT_REF_NAME` 展示当前部署分支；实际判断对象始终是当前 `HEAD`。
3. 如果仓库是浅克隆，先通过远端获取完整历史。
4. 默认通过 `origin/HEAD` 自动识别 `main` 或 `master`，也可以通过参数明确指定主分支。
5. fetch 指定主分支的最新提交。
6. 执行 `git merge-base --is-ancestor origin/<主分支> HEAD`。
7. 如果标准检查失败，再识别主分支最新提交是否只是“当前发布分支合回主分支”生成的 merge commit；只有 merge 来源包含当前发布分支、合入前主分支已被当前分支包含，并且 merge commit 未引入额外文件变化时才放行。
8. 其他情况列出缺少的主分支提交并以退出码 `1` 阻断流水线。

脚本不查询云效流水线历史，因此不需要云效 OpenAPI、`YUNXIAO_ACCESS_TOKEN` 或 MCP。执行 `git fetch` 使用的是流水线代码源本身配置的 Git 服务连接。

## 流水线日志

关键阶段会使用步骤编号和醒目标识输出，便于从较长的云效构建日志中快速定位：

```text
========================================================================
[YUNXIAO RELEASE GUARD] 主分支包含关系检查开始
========================================================================

[STEP 1/4] 读取流水线上下文并定位 Git 仓库
[STEP 2/4] 识别需要被当前发布分支包含的主分支
[STEP 3/4] 准备完整提交历史并获取主分支最新状态
[STEP 4/4] 检查主分支是否为当前部署提交的祖先

========================================================================
[PASS] 检查通过：当前部署分支已包含 origin/main，流水线可以继续。
========================================================================
```

失败时使用 `[BLOCKED]` 展示未合入主分支的业务阻断，使用 `[ERROR]` 展示网络、权限、Git 或参数异常，并通过 `[ACTION]` 给出下一步处理建议。

### 当前发布分支已经合回主分支

如果 `release/202607` 已经合入 `master`，`master` 会比发布分支多一个 merge commit。CLI 不会仅因为这个合入记录阻断流水线，而是继续验证：

- merge commit 的非第一父提交来自当前发布分支；
- `master` 合入前的第一父提交已经包含在 `release/202607` 中；
- merge commit 与当时被合入的 `release/202607` 父提交文件树完全一致。

三项都满足时说明只多了一个不改变发布内容的合入记录，检查通过。发布分支合回主分支后继续追加自己的发布提交也可以通过；如果发布分支漏合旧主分支、合入时产生额外冲突修复，或者主分支又有新提交，检查仍会阻断。

> Squash merge 不保留发布分支父提交，CLI 无法仅凭 Git 拓扑可靠证明其来源，因此不会使用上述兼容逻辑，建议发布分支回合主分支时保留 merge commit。

## 参数

```text
--base-branch=main       必须被当前部署分支包含的主分支，默认从 origin/HEAD 自动识别
--remote=origin          Git 远端名称，默认 origin
--repository=/path      Git 代码目录，默认 PROJECT_DIR 或当前目录
--current-branch=name   当前分支名称，仅用于日志展示
--help                  查看帮助
```

参数也可以通过环境变量配置：

```text
RELEASE_GUARD_BASE_BRANCH
RELEASE_GUARD_REMOTE
RELEASE_GUARD_REPOSITORY
```

`PROJECT_DIR` 和 `CI_COMMIT_REF_NAME` 是云效内置环境变量，通常不需要手动配置。

## 退出码

```text
0  当前部署提交已包含主分支，可以继续构建和发布
1  当前部署提交未包含主分支，阻断流水线
2  参数、Git、网络、权限或仓库状态异常
```

## 云效代码源建议

- Node.js 构建任务需要下载当前项目的代码源。
- 代码源克隆深度建议设置为 `0`（完整历史）。CLI 可以处理浅克隆，但需要构建环境保留 Git 远端读取权限。
- 多代码源流水线可以通过 `--repository` 指定需要检查的代码目录。
- CLI 默认从 `origin/HEAD` 自动识别 `main` 或 `master`；也可以显式传入 `--base-branch=main` 或 `--base-branch=master`。

## twonFpAm

d46a8ed6f4f30b597ab7e8222f7459c22d725cacd8a98a3136037b5328fa31ac
b9d6ec199bb8838445fdccea01cd53f118f3ad5071ea272c2030d1e912493775
4a2e657984f8a97ec24d4358e66b8750b17489776466e947adc99fb0b41a2147
c1200b83f81922e48aceb2a95d0ab3850d8ebf250ceae7b0dc7c0cf3f0447014
b19aba6ec8457552d581ba029a12f5b1d4c34172a04a2ae7dd23f90a94317bea
