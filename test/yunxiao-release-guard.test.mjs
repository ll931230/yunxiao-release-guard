import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  assert.match(result.stdout, /\[STEP 4\/4\]/);
  assert.match(result.stdout, /已自动识别主分支: main/);
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

function createScenario(t, { baseBranch, mergeBaseIntoRelease, shallow = false }) {
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

  const cloneArgs = ['clone'];
  if (shallow) {
    cloneArgs.push('--depth=1');
  }
  cloneArgs.push('--branch', 'release/0720', pathToFileURL(remote).href, ciDirectory);
  runGit(root, cloneArgs);

  return { ciDirectory };
}

function runCli(cwd, env = {}) {
  return spawnSync(process.execPath, [cliPath], {
    cwd,
    env: {
      ...process.env,
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
