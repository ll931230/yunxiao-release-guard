#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// 所有输出均使用纯文本标识，不依赖 ANSI 颜色，确保云效日志下载后仍然清晰可读。
const LOG_SEPARATOR = '='.repeat(72);
const TOTAL_STEPS = 4;
const DEFAULT_REMOTE = 'origin';
const MAX_MISSING_COMMITS = 30;
// 未显式配置主分支时，只允许自动选择团队约定的 main/master，避免误把 develop 当成主分支。
const AUTO_BASE_BRANCHES = new Set(['main', 'master']);
const ALLOWED_OPTIONS = new Set([
  'base-branch',
  'current-branch',
  'remote',
  'repository',
]);

/**
 * CLI 主流程。
 *
 * 首先按“主分支 ref -> 当前流水线 HEAD”执行标准祖先检查。
 * 如果当前发布分支已经合回主分支，主分支会多出一个合入记录，此时再执行
 * 严格的 merge 来源与文件树等价兜底检查，避免把自身生成的 merge commit 当成漏合代码。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  printHeader();
  printStep(1, '读取流水线上下文并定位 Git 仓库');

  const options = buildOptions(args);
  validateOptions(options);

  const repository = resolveRepository(options.repository);
  const gitOptions = { cwd: repository };

  ensureGitRepository(gitOptions);
  ensureRemoteExists(options.remote, gitOptions);

  printInfo(`代码目录: ${repository}`);
  printInfo(`Git 远端: ${options.remote}`);

  printStep(2, '识别需要被当前发布分支包含的主分支');
  const baseBranch = resolveBaseBranch(options.baseBranch, options.remote, gitOptions);
  const resolvedOptions = { ...options, baseBranch };
  validateBranchName(baseBranch, gitOptions);

  const currentBranch =
    options.currentBranch ||
    git(['branch', '--show-current'], { ...gitOptions, allowFailure: true }).stdout.trim() ||
    '(detached HEAD)';
  const currentCommit = git(['rev-parse', '--short=12', 'HEAD'], gitOptions).stdout.trim();

  printInfo(`当前部署分支: ${currentBranch}`);
  printInfo(`当前部署提交: ${currentCommit}`);
  printInfo(`要求包含主分支: ${resolvedOptions.remote}/${resolvedOptions.baseBranch}`);

  printStep(3, '准备完整提交历史并获取主分支最新状态');
  ensureFullHistoryIfShallow(resolvedOptions.remote, gitOptions);
  fetchBaseBranch(resolvedOptions.remote, resolvedOptions.baseBranch, gitOptions);

  const baseRef = `refs/remotes/${resolvedOptions.remote}/${resolvedOptions.baseBranch}`;
  const baseCommit = git(['rev-parse', '--short=12', `${baseRef}^{commit}`], gitOptions).stdout.trim();
  printInfo(`主分支最新提交: ${baseCommit}`);

  printStep(4, '检查主分支是否为当前部署提交的祖先');
  const containment = checkBaseContainment(baseRef, gitOptions);

  if (containment.passed) {
    if (containment.mode === 'integration-record') {
      printInfo('合入记录兼容检查通过：当前发布分支已包含合入前的主分支，且 merge commit 未引入额外文件变化');
    }
    printOutcome(
      'PASS',
      containment.mode === 'ancestor'
        ? `检查通过：当前部署分支已包含 ${resolvedOptions.remote}/${resolvedOptions.baseBranch}，流水线可以继续。`
        : `检查通过：${resolvedOptions.remote}/${resolvedOptions.baseBranch} 的最新提交是当前发布内容的合入记录，流水线可以继续。`,
    );
    return;
  }

  printMissingCommits(baseRef, resolvedOptions, gitOptions);
  process.exitCode = 1;
}

/**
 * 解析 `--key=value` 和 `--key value` 两种 CLI 写法。
 * 对未知参数直接失败，防止流水线里因为参数拼错而静默使用默认值。
 */
function parseArgs(rawArgs) {
  const parsed = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const rawArg = rawArgs[index];

    if (rawArg === '--help' || rawArg === '-h') {
      parsed.help = true;
      continue;
    }

    if (!rawArg.startsWith('--')) {
      throw new Error(`无法识别参数: ${rawArg}`);
    }

    const equalIndex = rawArg.indexOf('=');
    const key = rawArg.slice(2, equalIndex === -1 ? undefined : equalIndex);
    if (!ALLOWED_OPTIONS.has(key)) {
      throw new Error(`无法识别参数: --${key}`);
    }

    if (equalIndex !== -1) {
      parsed[key] = rawArg.slice(equalIndex + 1);
      continue;
    }

    const value = rawArgs[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`参数 --${key} 缺少值`);
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

/**
 * 参数优先级：命令行 > Release Guard 环境变量 > 云效内置变量 > 默认值。
 * `currentBranch` 只用于日志；实际部署对象始终以 Git HEAD 为准，兼容流水线 detached HEAD。
 */
function buildOptions(args) {
  return {
    baseBranch:
      args['base-branch'] ||
      process.env.RELEASE_GUARD_BASE_BRANCH ||
      '',
    remote:
      args.remote ||
      process.env.RELEASE_GUARD_REMOTE ||
      DEFAULT_REMOTE,
    repository:
      args.repository ||
      process.env.RELEASE_GUARD_REPOSITORY ||
      process.env.PROJECT_DIR ||
      process.cwd(),
    currentBranch:
      args['current-branch'] ||
      process.env.CI_COMMIT_REF_NAME ||
      process.env.CI_COMMIT_REF_NAME_1 ||
      process.env.BRANCH_NAME ||
      '',
  };
}

function validateOptions(options) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.remote)) {
    throw new Error(`远端名称不合法: ${options.remote}`);
  }
}

/**
 * 解析主分支，顺序如下：
 * 1. 用户通过参数或环境变量显式指定；
 * 2. 读取本地 `origin/HEAD`；
 * 3. 查询远端 HEAD（单分支克隆时本地可能没有 origin/HEAD）；
 * 4. 本地仅存在 main/master 之一时采用该分支；
 * 5. 仍无法唯一判断则报错，不做有风险的猜测。
 */
function resolveBaseBranch(configuredBranch, remote, gitOptions) {
  if (configuredBranch.trim()) {
    const branch = configuredBranch.trim();
    printInfo(`使用显式配置的主分支: ${branch}`);
    return branch;
  }

  const remoteHead = git(
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`],
    { ...gitOptions, allowFailure: true },
  );
  if (remoteHead.status === 0) {
    const prefix = `${remote}/`;
    const branch = remoteHead.stdout.trim();
    if (branch.startsWith(prefix) && branch.length > prefix.length) {
      const detected = branch.slice(prefix.length);
      if (AUTO_BASE_BRANCHES.has(detected)) {
        printInfo(`已自动识别主分支: ${detected}（来源: 本地 ${remote}/HEAD）`);
        return detected;
      }
    }
  }

  const remoteDefault = git(
    ['ls-remote', '--symref', remote, 'HEAD'],
    { ...gitOptions, allowFailure: true },
  );
  if (remoteDefault.status === 0) {
    const match = remoteDefault.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
    if (match?.[1] && AUTO_BASE_BRANCHES.has(match[1])) {
      printInfo(`已自动识别主分支: ${match[1]}（来源: 远端 HEAD）`);
      return match[1];
    }
  }

  const candidates = ['main', 'master'].filter((branch) => {
    const result = git(
      ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`],
      { ...gitOptions, allowFailure: true },
    );
    return result.status === 0;
  });

  if (candidates.length === 1) {
    printInfo(`已自动识别主分支: ${candidates[0]}（来源: 本地远端分支）`);
    return candidates[0];
  }

  throw new Error(
    `无法自动识别主分支。请传 --base-branch=main 或 --base-branch=master。`,
  );
}

function resolveRepository(repository) {
  if (!existsSync(repository)) {
    throw new Error(`代码目录不存在: ${repository}`);
  }
  return repository;
}

function ensureGitRepository(gitOptions) {
  git(['rev-parse', '--is-inside-work-tree'], gitOptions);
}

function ensureRemoteExists(remote, gitOptions) {
  const remotes = git(['remote'], gitOptions)
    .stdout
    .split(/\r?\n/)
    .filter(Boolean);

  if (!remotes.includes(remote)) {
    throw new Error(`Git 远端不存在: ${remote}`);
  }
}

function validateBranchName(branch, gitOptions) {
  git(['check-ref-format', '--branch', branch], gitOptions);
}

/**
 * 浅克隆缺少较早的父提交，即使代码内容正确，merge-base 也可能无法证明祖先关系。
 * 因此发现 shallow 仓库时先执行 --unshallow；失败按基础设施异常返回退出码 2。
 */
function ensureFullHistoryIfShallow(remote, gitOptions) {
  const result = git(['rev-parse', '--is-shallow-repository'], gitOptions);
  if (result.stdout.trim() !== 'true') {
    printInfo('提交历史状态: 完整仓库，无需补全历史');
    return;
  }

  printInfo('检测到浅克隆，正在获取完整提交历史...');
  git(['fetch', '--no-tags', '--unshallow', remote], gitOptions);
  printInfo('浅克隆历史补全完成');
}

/**
 * 强制把远端主分支写入对应的 remote-tracking ref。
 * 使用完整 refspec 可以避免依赖流水线 clone 时生成的 fetch 配置，并确保比较的是刚获取的主分支 tip。
 */
function fetchBaseBranch(remote, baseBranch, gitOptions) {
  printInfo(`正在获取 ${remote}/${baseBranch} 最新提交...`);
  git([
    'fetch',
    '--no-tags',
    remote,
    `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
  ], gitOptions);
  printInfo(`${remote}/${baseBranch} 获取完成`);
}

/**
 * 检查当前 HEAD 是否满足“包含主分支”的发布约束。
 *
 * 第一层是标准 Git 祖先检查，适用于主分支尚未合入当前发布分支之后又发生变化的普通场景。
 *
 * 第二层用于处理以下合法拓扑：
 *
 *   previous-base ---- integration-record (最新主分支)
 *          \           /
 *           current-HEAD (当前发布分支)
 *
 * 发布分支合回主分支后，integration-record 天然是 HEAD 的后代，第一层一定失败。
 * 只有同时满足下面三个条件才允许忽略这个合入记录：
 * 1. 主分支最新提交是 merge commit，且至少一个非第一父提交来自当前发布分支；
 * 2. merge commit 的第一父提交（合入前的主分支）已经是当前 HEAD 的祖先；
 * 3. merge commit 与被合入的发布分支父提交 Git tree 完全一致，没有冲突修复或额外文件变化。
 *
 * 该规则兼容普通 two-parent merge 和 octopus merge，但不会放过：
 * - 发布分支本来就漏合了旧主分支；
 * - 合入时在主分支产生了额外内容；
 * - 合入完成后主分支又新增了提交。
 *
 * squash commit 没有发布分支父提交，无法从 Git 拓扑可靠证明来源，因此不会走该兜底。
 */
function checkBaseContainment(baseRef, gitOptions) {
  if (isAncestor(baseRef, 'HEAD', gitOptions)) {
    printInfo('标准祖先检查通过：主分支最新提交是当前部署提交的祖先');
    return { passed: true, mode: 'ancestor' };
  }

  printInfo('标准祖先检查未通过，正在检查主分支最新提交是否只是当前发布内容的合入记录...');

  const parentLine = git(
    ['rev-list', '--parents', '--max-count=1', baseRef],
    gitOptions,
  ).stdout.trim();
  const [, firstParent, ...mergedParents] = parentLine.split(/\s+/);

  // 普通提交只有一个父提交；至少两个父提交才是可验证来源的 merge commit。
  if (!firstParent || mergedParents.length === 0) {
    printInfo('合入记录兼容检查未通过：主分支最新提交不是 merge commit');
    return { passed: false, mode: 'missing-base' };
  }

  const previousBaseCommit = git(
    ['rev-parse', '--short=12', firstParent],
    gitOptions,
  ).stdout.trim();
  const previousBaseContained = isAncestor(firstParent, 'HEAD', gitOptions);

  // 非第一父提交是被合入主分支的来源。它必须等于或早于当前 HEAD，才能证明这次 merge 来自当前发布分支。
  const integratedReleaseParents = mergedParents.filter((parent) =>
    isAncestor(parent, 'HEAD', gitOptions));
  const currentReleaseWasIntegrated = integratedReleaseParents.length > 0;

  // 应比较 merge commit 与“当时被合入的发布分支父提交”，而不是最新 HEAD。
  // 这样发布分支在合回主分支后继续追加正常提交时，仍能证明它包含所需主分支内容。
  const baseTree = git(['rev-parse', `${baseRef}^{tree}`], gitOptions).stdout.trim();
  const integratedTreeMatches = integratedReleaseParents.some((parent) => {
    const parentTree = git(['rev-parse', `${parent}^{tree}`], gitOptions).stdout.trim();
    return baseTree === parentTree;
  });

  printInfo(`合入前主分支提交: ${previousBaseCommit}`);
  printInfo(`merge commit 是否包含当前发布分支来源: ${currentReleaseWasIntegrated ? '是' : '否'}`);
  printInfo(`当前分支是否包含合入前主分支: ${previousBaseContained ? '是' : '否'}`);
  printInfo(`merge commit 是否未引入额外文件变化: ${integratedTreeMatches ? '是' : '否'}`);

  if (currentReleaseWasIntegrated && previousBaseContained && integratedTreeMatches) {
    return { passed: true, mode: 'integration-record' };
  }

  return { passed: false, mode: 'missing-base' };
}

/**
 * 对 `git merge-base --is-ancestor` 的退出码做严格分类：
 * 0 表示是祖先，1 表示不是祖先，其他值属于 Git/仓库异常，应返回退出码 2。
 */
function isAncestor(ancestor, descendant, gitOptions) {
  const result = git(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { ...gitOptions, allowFailure: true },
  );

  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }

  throw new Error(
    [
      `无法判断提交祖先关系: ${ancestor} -> ${descendant}`,
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * 输出 `HEAD..主分支` 范围内的提交，即当前部署分支缺少、但主分支已经拥有的提交。
 * 日志最多展示 30 条，避免长期未同步时刷满云效日志；总数仍会完整输出。
 */
function printMissingCommits(baseRef, options, gitOptions) {
  const missingCount = Number(
    git(['rev-list', '--count', `HEAD..${baseRef}`], gitOptions).stdout.trim(),
  );
  const missing = git([
    'log',
    '--oneline',
    '--no-decorate',
    `--max-count=${MAX_MISSING_COMMITS}`,
    `HEAD..${baseRef}`,
  ], gitOptions).stdout.trim();

  printOutcome(
    'BLOCKED',
    `检查失败：当前部署分支未包含 ${options.remote}/${options.baseBranch}，流水线已阻断。`,
    console.error,
  );
  console.error(`[MISSING] 缺少主分支提交 ${missingCount} 个：`);
  console.error(missing || '[MISSING] 无法列出缺失提交');
  if (missingCount > MAX_MISSING_COMMITS) {
    console.error(`[MISSING] 仅展示前 ${MAX_MISSING_COMMITS} 个缺失提交。`);
  }
  console.error('');
  console.error(`[ACTION] 请先将 ${options.baseBranch} 合入当前部署分支，再重新执行流水线。`);
}

/**
 * 统一执行 Git 子进程，避免使用 shell 字符串拼接。
 * 默认遇到非零退出码立即抛错；只有需要解释特定退出码的调用方才设置 allowFailure。
 */
function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      [
        `git ${args.join(' ')} 执行失败`,
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function printHeader() {
  console.log('');
  console.log(LOG_SEPARATOR);
  console.log('[YUNXIAO RELEASE GUARD] 主分支包含关系检查开始');
  console.log(LOG_SEPARATOR);
}

function printStep(index, message) {
  console.log('');
  console.log(`[STEP ${index}/${TOTAL_STEPS}] ${message}`);
  console.log('-'.repeat(72));
}

function printInfo(message) {
  console.log(`[INFO] ${message}`);
}

function printOutcome(status, message, output = console.log) {
  output('');
  output(LOG_SEPARATOR);
  output(`[${status}] ${message}`);
  output(LOG_SEPARATOR);
}

function printHelp() {
  console.log(`
yunxiao-release-guard

检查当前部署提交是否包含指定主分支的最新提交。

Usage:
  yunxiao-release-guard --base-branch=main
  yunxiao-release-guard --base-branch main --remote origin

Options:
  --base-branch=main       必须被当前部署分支包含的主分支；默认从 origin/HEAD 自动识别
  --remote=origin          Git 远端名称，默认 ${DEFAULT_REMOTE}
  --repository=/path      Git 代码目录，默认 PROJECT_DIR 或当前目录
  --current-branch=name   当前分支名称，仅用于日志展示
  --help                  查看帮助

Env:
  RELEASE_GUARD_BASE_BRANCH  主分支名称
  RELEASE_GUARD_REMOTE       Git 远端名称
  RELEASE_GUARD_REPOSITORY   Git 代码目录
  PROJECT_DIR                云效流水线代码目录
  CI_COMMIT_REF_NAME         云效当前运行分支，仅用于日志展示

Exit codes:
  0  当前部署提交已包含主分支
  1  当前部署提交未包含主分支，阻断发布
  2  参数、Git、网络或仓库状态异常
`);
}

try {
  main();
} catch (error) {
  printOutcome('ERROR', '检查执行异常，流水线已阻断。', console.error);
  console.error(`[DETAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
