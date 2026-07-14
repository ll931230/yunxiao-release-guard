#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_MCP_COMMAND = 'npx';
const DEFAULT_MCP_ARGS = ['-y', 'alibabacloud-devops-mcp-server'];
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_ORGANIZATION_ID = '62650a04c2b7347ce520e7e4';

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const options = buildOptions(args);
  validateOptions(options);

  const currentBranch = options.currentBranch;
  const previousBranch =
    options.previousBranch ||
    await findPreviousSuccessfulBranch(options);

  if (!previousBranch) {
    throw new Error('未找到上一条成功生产部署分支。可以使用 --previous-branch 手动指定。');
  }

  console.log(`当前部署分支: ${currentBranch}`);
  console.log(`上一个生产分支: ${previousBranch}`);

  if (options.skipSameBranch && previousBranch === currentBranch) {
    console.log('上一生产分支与当前部署分支相同，跳过包含关系检查。');
    return;
  }

  ensureCurrentDirectoryIsGitRepository();
  fetchBranch(previousBranch);
  ensureFullHistoryIfShallow();

  const previousRef = `origin/${previousBranch}`;
  const contains = isAncestor(previousRef, 'HEAD');
  if (!contains) {
    console.error(`当前部署分支未包含上一个生产分支内容: ${previousBranch}`);
    console.error('');
    console.error('缺失提交如下:');
    const missing = git(['log', '--oneline', `HEAD..${previousRef}`], { allowFailure: true }).stdout.trim();
    console.error(missing || '(无法列出缺失提交)');
    console.error('');
    console.error(`请先将 ${previousBranch} 或包含它的主分支合入当前部署分支后再发布。`);
    process.exitCode = 1;
    return;
  }

  console.log(`当前部署分支已包含上一个生产分支: ${previousBranch}`);
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (const rawArg of rawArgs) {
    if (rawArg === '--help' || rawArg === '-h') {
      parsed.help = true;
      continue;
    }

    if (rawArg === '--debug') {
      parsed.debug = true;
      continue;
    }

    const [key, ...valueParts] = rawArg.split('=');
    if (!key.startsWith('--') || valueParts.length === 0) {
      throw new Error(`无法识别参数: ${rawArg}`);
    }

    parsed[key.slice(2)] = valueParts.join('=');
  }

  return parsed;
}

function buildOptions(args) {
  return {
    organizationId:
      args['organization-id'] ||
      process.env.YUNXIAO_ORGANIZATION_ID ||
      DEFAULT_ORGANIZATION_ID,
    pipelineId:
      args['pipeline-id'] ||
      process.env.PIPELINE_ID ||
      process.env.CI_PIPELINE_ID ||
      process.env.ENGINE_PIPELINE_ID ||
      '',
    currentBranch:
      args['current-branch'] ||
      process.env.CI_COMMIT_REF_NAME ||
      process.env.BRANCH_NAME ||
      '',
    previousBranch:
      args['previous-branch'] ||
      process.env.PREVIOUS_PROD_BRANCH ||
      '',
    accessToken:
      process.env.YUNXIAO_ACCESS_TOKEN ||
      '',
    mcpCommand:
      args['mcp-command'] ||
      process.env.YUNXIAO_MCP_COMMAND ||
      DEFAULT_MCP_COMMAND,
    mcpArgs:
      splitShellArgs(
        args['mcp-args'] ||
        process.env.YUNXIAO_MCP_ARGS ||
        DEFAULT_MCP_ARGS.join(' '),
      ),
    requestTimeoutMs:
      toPositiveInt(
        args['request-timeout-ms'] ||
        process.env.YUNXIAO_MCP_REQUEST_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
      ),
    debug: Boolean(args.debug),
    skipSameBranch: parseBoolean(args['skip-same-branch'] || process.env.YUNXIAO_SKIP_SAME_BRANCH),
  };
}

function validateOptions(options) {
  if (!options.currentBranch) {
    throw new Error('缺少当前部署分支。请传 --current-branch 或确认 CI_COMMIT_REF_NAME 存在。');
  }

  if (options.previousBranch) {
    return;
  }

  if (!options.organizationId) {
    throw new Error('缺少云效组织 ID。请传 --organization-id 或设置 YUNXIAO_ORGANIZATION_ID。');
  }

  if (!options.pipelineId) {
    throw new Error('缺少当前流水线 ID。请传 --pipeline-id 或确认 PIPELINE_ID 存在。');
  }

  if (!options.accessToken) {
    throw new Error('缺少 YUNXIAO_ACCESS_TOKEN。自动查询上一生产分支需要云效 PAT。');
  }
}

async function findPreviousSuccessfulBranch(options) {
  const mcp = new McpClient({
    command: options.mcpCommand,
    args: options.mcpArgs,
    env: {
      ...process.env,
      YUNXIAO_ACCESS_TOKEN: options.accessToken,
    },
    debug: options.debug,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  try {
    await mcp.start();
    await mcp.initialize();

    const runs = await mcp.callTool('list_pipeline_runs', {
      organizationId: options.organizationId,
      pipelineId: options.pipelineId,
      status: 'SUCCESS',
      page: 1,
      perPage: 5,
    });
    const items = Array.isArray(runs?.items) ? runs.items : [];

    for (const latestRun of items) {
      if (!latestRun?.pipelineRunId) {
        continue;
      }

      const run = await mcp.callTool('get_pipeline_run', {
        organizationId: options.organizationId,
        pipelineId: options.pipelineId,
        pipelineRunId: String(latestRun.pipelineRunId),
      });
      const branch = extractBranch(run);
      if (branch && branch !== options.currentBranch) {
        return branch;
      }
      if (branch && branch === options.currentBranch && !options.skipSameBranch) {
        return branch;
      }
    }

    return '';
  } finally {
    await mcp.close();
  }
}

function extractBranch(run) {
  const branch =
    getGlobalParam(run, 'CI_COMMIT_REF_NAME') ||
    getGlobalParam(run, 'CI_COMMIT_REF_NAME_1');
  if (branch) {
    return branch;
  }

  const rawSources = Array.isArray(run?.sources) ? run.sources : [];
  for (const source of rawSources) {
    const data = source?.data || {};
    if (data.branch || data.ref) {
      return data.branch || data.ref;
    }
  }

  const nestedSources = deepFindSources(run);
  for (const source of nestedSources) {
    if (source.branch || source.ref) {
      return source.branch || source.ref;
    }
  }

  return '';
}

function getGlobalParam(run, key) {
  const sources = [
    run?.globalParams,
    run?.params,
    run?.variables,
  ];

  for (const source of sources) {
    if (Array.isArray(source)) {
      const item = source.find((entry) => entry?.key === key || entry?.name === key);
      if (item?.value) {
        return String(item.value);
      }
    }

    if (source && typeof source === 'object' && source[key]) {
      return String(source[key]);
    }
  }

  return '';
}

function deepFindSources(value) {
  const found = [];
  const queue = [value];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current.sources)) {
      for (const source of current.sources) {
        if (source?.data?.branch || source?.data?.ref || source?.branch || source?.ref) {
          found.push(source.data || source);
        }
      }
    }

    for (const child of Object.values(current)) {
      if (typeof child === 'string' && looksJson(child)) {
        try {
          queue.push(JSON.parse(child));
        } catch {
          // Ignore non-JSON strings.
        }
      } else if (child && typeof child === 'object') {
        queue.push(child);
      }
    }
  }

  return found;
}

function looksJson(value) {
  const text = value.trim();
  return (
    (text.startsWith('{') && text.endsWith('}')) ||
    (text.startsWith('[') && text.endsWith(']'))
  );
}

function ensureCurrentDirectoryIsGitRepository() {
  git(['rev-parse', '--is-inside-work-tree']);
}

function fetchBranch(branch) {
  git([
    'fetch',
    '--no-tags',
    '--prune',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}

function ensureFullHistoryIfShallow() {
  const result = git(['rev-parse', '--is-shallow-repository'], { allowFailure: true });
  if (result.stdout.trim() !== 'true') {
    return;
  }

  git(['fetch', '--unshallow', 'origin'], { allowFailure: true });
}

function isAncestor(ancestor, descendant) {
  const result = git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
  return result.status === 0;
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
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

class McpClient {
  constructor({ command, args, env, debug, requestTimeoutMs }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.debug = debug;
    this.requestTimeoutMs = requestTimeoutMs;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      if (this.debug) {
        process.stderr.write(chunk);
      }
    });
    this.proc.on('exit', (code, signal) => {
      const error = new Error(`云效 MCP 已退出: code=${code ?? ''} signal=${signal ?? ''}`);
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
    });
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'yunxiao-release-guard',
        version: '0.1.0',
      },
    });
    this.notify('notifications/initialized', {});
  }

  async callTool(name, argumentsObject) {
    const response = await this.request('tools/call', {
      name,
      arguments: argumentsObject,
    });

    if (response?.isError) {
      const message = extractToolContentText(response) || `${name} 调用失败`;
      throw new Error(message);
    }

    const text = extractToolContentText(response);
    if (!text) {
      return response;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`云效 MCP 请求超时: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk) {
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        if (this.debug) {
          console.error(`忽略非 JSON MCP 输出: ${line}`);
        }
        continue;
      }

      if (!message.id || !this.pending.has(message.id)) {
        continue;
      }

      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  async close() {
    if (!this.proc || this.proc.killed) {
      return;
    }

    this.proc.kill('SIGTERM');
    await delay(100);
  }
}

function extractToolContentText(response) {
  if (!Array.isArray(response?.content)) {
    return '';
  }

  return response.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function splitShellArgs(value) {
  const args = [];
  let current = '';
  let quote = '';

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value || '').toLowerCase());
}

function printHelp() {
  console.log(`
yunxiao-release-guard

检查当前部署分支是否包含上一条成功生产部署分支。

Usage:
  yunxiao-release-guard --organization-id=xxx --pipeline-id=xxx --current-branch=release/0720
  yunxiao-release-guard --current-branch=release/0720 --previous-branch=release/0707

Options:
  --organization-id=xxx      云效组织 ID，也可用 YUNXIAO_ORGANIZATION_ID，默认 ${DEFAULT_ORGANIZATION_ID}
  --pipeline-id=xxx          当前云效流水线 ID，也可用 PIPELINE_ID
  --current-branch=xxx       当前部署分支，也可用 CI_COMMIT_REF_NAME
  --previous-branch=xxx      手动指定上一生产分支，指定后不调用云效接口
  --skip-same-branch=true    上一生产分支与当前分支相同时跳过检查
  --mcp-command=npx          MCP 启动命令
  --mcp-args="-y alibabacloud-devops-mcp-server"
  --request-timeout-ms=60000 MCP 请求超时时间
  --debug                    输出 MCP stderr 和调试信息
  --help                     查看帮助

Env:
  YUNXIAO_ACCESS_TOKEN       自动查询上一生产分支时必填
  YUNXIAO_ORGANIZATION_ID    云效组织 ID，默认 ${DEFAULT_ORGANIZATION_ID}
  PIPELINE_ID                当前流水线 ID
  CI_COMMIT_REF_NAME         当前部署分支
  PREVIOUS_PROD_BRANCH       手动指定上一生产分支
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
