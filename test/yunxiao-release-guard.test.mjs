import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDirectory, '..', 'bin', 'yunxiao-release-guard.mjs');

test('主分支未合入发布分支时退出 1 并列出缺失提交', (t) => {
  const scenario = createScenario(t, { baseBranch: 'main', mergeBaseIntoRelease: false });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /\x1b\[1;32m\[STEP 4\/4\]/);
  assert.match(result.stdout, /\[STEP 4\/4\]/);
  assert.match(result.stdout, /已自动识别主分支: main/);
  assert.match(result.stderr, /\x1b\[1;31m\[BLOCKED\]/);
  assert.match(result.stderr, /\x1b\[1;31m\[MISSING\]/);
  assert.match(result.stderr, /\x1b\[1;31m\[ACTION\]/);
  assert.match(result.stderr, /\[BLOCKED\]/);
  assert.match(result.stderr, /当前部署分支未包含 origin\/main/);
  assert.match(result.stderr, /release\/0707 merged to main/);
});

test('主分支已合入发布分支时退出 0', (t) => {
  const scenario = createScenario(t, { baseBranch: 'main', mergeBaseIntoRelease: true });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[PASS\]/);
  assert.match(result.stdout, /检查通过：当前部署分支已包含 origin\/main/);
});

test('当前发布分支已经合回主分支且仅新增合入记录时退出 0', (t) => {
  const scenario = createScenario(t, {
    baseBranch: 'master',
    mergeBaseIntoRelease: true,
    integrateReleaseIntoBase: 'merge',
  });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /标准祖先检查未通过/);
  assert.match(result.stdout, /合入记录兼容检查通过/);
  assert.match(result.stdout, /最新提交是当前发布内容的合入记录/);
});

test('squash 合回主分支因缺少可验证的发布分支父提交而阻断', (t) => {
  const scenario = createScenario(t, {
    baseBranch: 'main',
    mergeBaseIntoRelease: true,
    integrateReleaseIntoBase: 'squash',
  });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /主分支最新提交不是 merge commit/);
  assert.match(result.stderr, /\[BLOCKED\]/);
});

test('发布分支漏合旧主分支后再合回主分支仍然阻断', (t) => {
  const scenario = createScenario(t, {
    baseBranch: 'main',
    mergeBaseIntoRelease: false,
    integrateReleaseIntoBase: 'merge',
  });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /当前分支是否包含合入前主分支: 否/);
  assert.match(result.stderr, /\[BLOCKED\]/);
});

test('合回主分支时产生额外文件变化仍然阻断', (t) => {
  const scenario = createScenario(t, {
    baseBranch: 'main',
    mergeBaseIntoRelease: true,
    integrateReleaseIntoBase: 'merge-with-extra-change',
  });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /merge commit 是否未引入额外文件变化: 否/);
  assert.match(result.stderr, /\[BLOCKED\]/);
});

test('发布分支合回主分支后继续追加发布提交时仍然通过', (t) => {
  const scenario = createScenario(t, {
    baseBranch: 'main',
    mergeBaseIntoRelease: true,
    integrateReleaseIntoBase: 'merge',
    addReleaseCommitAfterIntegration: true,
  });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /merge commit 是否未引入额外文件变化: 是/);
  assert.match(result.stdout, /\[PASS\]/);
});

test('发布分支合回主分支后主分支又有新提交时仍然阻断', (t) => {
  const scenario = createScenario(t, {
    baseBranch: 'main',
    mergeBaseIntoRelease: true,
    integrateReleaseIntoBase: 'merge',
    addBaseCommitAfterIntegration: true,
  });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /主分支最新提交不是 merge commit/);
  assert.match(result.stderr, /base changed after integration/);
});

test('自动识别 master 并处理浅克隆', (t) => {
  const scenario = createScenario(t, {
    baseBranch: 'master',
    mergeBaseIntoRelease: true,
    shallow: true,
  });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已自动识别主分支: master/);
  assert.match(result.stdout, /检测到浅克隆/);
  assert.match(result.stdout, /检查通过：当前部署分支已包含 origin\/master/);
});

test('支持通过 PROJECT_DIR 从其他工作目录定位仓库', (t) => {
  const scenario = createScenario(t, { baseBranch: 'main', mergeBaseIntoRelease: true });
  const result = runCli(tmpdir(), {
    CI_COMMIT_REF_NAME: 'release/0720',
    PROJECT_DIR: scenario.ciDirectory,
  });

  assert.equal(result.status, 0, result.stderr);
});

test('设置 NO_COLOR 时输出纯文本日志', (t) => {
  const scenario = createScenario(t, { baseBranch: 'main', mergeBaseIntoRelease: false });
  const result = runCli(scenario.ciDirectory, {
    CI_COMMIT_REF_NAME: 'release/0720',
    NO_COLOR: '1',
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
  assert.doesNotMatch(result.stderr, /\x1b\[/);
  assert.match(result.stderr, /\[BLOCKED\]/);
});

function createScenario(t, {
  baseBranch,
  mergeBaseIntoRelease,
  integrateReleaseIntoBase = '',
  addBaseCommitAfterIntegration = false,
  addReleaseCommitAfterIntegration = false,
  shallow = false,
}) {
  const root = mkdtempSync(join(tmpdir(), 'yunxiao-release-guard-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const ciDirectory = join(root, 'ci');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  runGit(root, ['init', '--bare', `--initial-branch=${baseBranch}`, remote]);
  runGit(root, ['clone', remote, seed]);
  runGit(seed, ['config', 'user.name', 'release-guard-test']);
  runGit(seed, ['config', 'user.email', 'release-guard-test@example.com']);
  runGit(seed, ['checkout', '-b', baseBranch]);
  runGit(seed, ['commit', '--allow-empty', '-m', 'initial']);
  runGit(seed, ['push', '--set-upstream', 'origin', baseBranch]);

  runGit(seed, ['checkout', '-b', 'release/0720']);
  runGit(seed, ['commit', '--allow-empty', '-m', 'release/0720 work']);
  runGit(seed, ['push', '--set-upstream', 'origin', 'release/0720']);

  runGit(seed, ['checkout', baseBranch]);
  runGit(seed, ['commit', '--allow-empty', '-m', `release/0707 merged to ${baseBranch}`]);
  runGit(seed, ['push']);

  if (mergeBaseIntoRelease) {
    runGit(seed, ['checkout', 'release/0720']);
    runGit(seed, ['merge', '--no-ff', baseBranch, '-m', `${baseBranch} merged into release/0720`]);
    runGit(seed, ['push']);
  }

  if (integrateReleaseIntoBase) {
    runGit(seed, ['checkout', baseBranch]);

    if (integrateReleaseIntoBase === 'squash') {
      runGit(seed, ['merge', '--squash', 'release/0720']);
      runGit(seed, ['commit', '--allow-empty', '-m', 'squash release/0720 into base']);
    } else {
      runGit(seed, ['merge', '--no-ff', '--no-commit', 'release/0720']);

      if (integrateReleaseIntoBase === 'merge-with-extra-change') {
        writeFileSync(join(seed, 'merge-only-change.txt'), 'created while merging into base\n');
        runGit(seed, ['add', 'merge-only-change.txt']);
      }

      runGit(seed, ['commit', '-m', 'merge release/0720 into base']);
    }

    runGit(seed, ['push']);
  }

  if (addBaseCommitAfterIntegration) {
    writeFileSync(join(seed, 'base-after-integration.txt'), 'new base content\n');
    runGit(seed, ['add', 'base-after-integration.txt']);
    runGit(seed, ['commit', '-m', 'base changed after integration']);
    runGit(seed, ['push']);
  }

  if (addReleaseCommitAfterIntegration) {
    runGit(seed, ['checkout', 'release/0720']);
    writeFileSync(join(seed, 'release-after-integration.txt'), 'new release content\n');
    runGit(seed, ['add', 'release-after-integration.txt']);
    runGit(seed, ['commit', '-m', 'release changed after integration']);
    runGit(seed, ['push']);
  }

  const cloneArgs = ['clone'];
  if (shallow) {
    cloneArgs.push('--depth=1');
  }
  cloneArgs.push('--branch', 'release/0720', pathToFileURL(remote).href, ciDirectory);
  runGit(root, cloneArgs);

  return { ciDirectory };
}

function runCli(cwd, env = {}) {
  // 测试结果不应受执行测试的终端是否预设 NO_COLOR 影响；需要关闭颜色的用例会自行传入。
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.NO_COLOR;

  return spawnSync(process.execPath, [cliPath], {
    cwd,
    env: {
      ...inheritedEnv,
      PROJECT_DIR: '',
      RELEASE_GUARD_BASE_BRANCH: '',
      RELEASE_GUARD_REMOTE: '',
      RELEASE_GUARD_REPOSITORY: '',
      ...env,
    },
    encoding: 'utf8',
  });
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(
    result.status,
    0,
    [`git ${args.join(' ')} failed`, result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
}
