#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const DEFAULT_REMOTE = 'origin';
const MAX_MISSING_COMMITS = 30;
const AUTO_BASE_BRANCHES = new Set(['main', 'master']);
const ALLOWED_OPTIONS = new Set([
  'base-branch',
  'current-branch',
  'remote',
  'repository',
]);

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const options = buildOptions(args);
  validateOptions(options);

  const repository = resolveRepository(options.repository);
  const gitOptions = { cwd: repository };

  ensureGitRepository(gitOptions);
  ensureRemoteExists(options.remote, gitOptions);
  const baseBranch = resolveBaseBranch(options.baseBranch, options.remote, gitOptions);
  const resolvedOptions = { ...options, baseBranch };
  validateBranchName(baseBranch, gitOptions);

  const currentBranch =
    options.currentBranch ||
    git(['branch', '--show-current'], { ...gitOptions, allowFailure: true }).stdout.trim() ||
    '(detached HEAD)';
  const currentCommit = git(['rev-parse', '--short=12', 'HEAD'], gitOptions).stdout.trim();

  console.log(`当前部署分支: ${currentBranch}`);
  console.log(`当前部署提交: ${currentCommit}`);
  console.log(`要求包含主分支: ${resolvedOptions.remote}/${resolvedOptions.baseBranch}`);

  ensureFullHistoryIfShallow(resolvedOptions.remote, gitOptions);
  fetchBaseBranch(resolvedOptions.remote, resolvedOptions.baseBranch, gitOptions);

  const baseRef = `refs/remotes/${resolvedOptions.remote}/${resolvedOptions.baseBranch}`;
  const baseCommit = git(['rev-parse', '--short=12', `${baseRef}^{commit}`], gitOptions).stdout.trim();
  console.log(`主分支最新提交: ${baseCommit}`);

  const result = git(
    ['merge-base', '--is-ancestor', baseRef, 'HEAD'],
    { ...gitOptions, allowFailure: true },
  );

  if (result.status === 0) {
    console.log(`检查通过：当前部署分支已包含 ${resolvedOptions.remote}/${resolvedOptions.baseBranch}。`);
    return;
  }

  if (result.status !== 1) {
    throw new Error(
      [
        '无法判断主分支包含关系。',
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  printMissingCommits(baseRef, resolvedOptions, gitOptions);
  process.exitCode = 1;
}

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

function resolveBaseBranch(configuredBranch, remote, gitOptions) {
  if (configuredBranch.trim()) {
    return configuredBranch.trim();
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
        console.log(`已自动识别主分支: ${detected}`);
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
      console.log(`已自动识别主分支: ${match[1]}`);
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
    console.log(`已自动识别主分支: ${candidates[0]}`);
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

function ensureFullHistoryIfShallow(remote, gitOptions) {
  const result = git(['rev-parse', '--is-shallow-repository'], gitOptions);
  if (result.stdout.trim() !== 'true') {
    return;
  }

  console.log('检测到浅克隆，正在获取完整提交历史...');
  git(['fetch', '--no-tags', '--unshallow', remote], gitOptions);
}

function fetchBaseBranch(remote, baseBranch, gitOptions) {
  console.log(`正在获取 ${remote}/${baseBranch} 最新提交...`);
  git([
    'fetch',
    '--no-tags',
    remote,
    `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
  ], gitOptions);
}

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

  console.error('');
  console.error(`检查失败：当前部署分支未包含 ${options.remote}/${options.baseBranch}。`);
  console.error(`缺少主分支提交 ${missingCount} 个：`);
  console.error(missing || '(无法列出缺失提交)');
  if (missingCount > MAX_MISSING_COMMITS) {
    console.error(`仅展示前 ${MAX_MISSING_COMMITS} 个缺失提交。`);
  }
  console.error('');
  console.error(`请先将 ${options.baseBranch} 合入当前部署分支，再重新执行流水线。`);
}

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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
