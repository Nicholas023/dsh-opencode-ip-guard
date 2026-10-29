/**
 * guard.js 行为测试：代理检测、启动流程、全失败重试状态机、刷新重建、释放幂等。
 * 全程不联网：所有异步能力（lookup/dispatcher/probe/dns）都通过 deps 注入假实现，
 * 定时器也注入假实现，所以测试是确定性的、毫秒级完成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createGuard, detectProxy } from '../src/guard.js';
import { buildStatus } from '../src/status.js';

/** 基础配置：forceIps 非空 → 探测完全不触达真实 DNS。 */
const BASE_CONFIG = {
  hostname: 'opencode.ai',
  probeTimeoutMs: 10000,
  enabled: true,
  forceIps: ['10.0.0.1', '10.0.0.2'],
  retryDelaysMs: [60000, 120000],
};

/** 空环境表：避免宿主机真实代理变量影响断言（所有 guard 用例都注入它）。 */
const EMPTY_ENV = {};

/**
 * 跑测试用的日志收集器。
 * @returns {{ lines: string[], log: (line: string) => void }}
 */
function createLogCollector() {
  const lines = [];
  return {
    lines,
    log(line) {
      lines.push(String(line));
    },
  };
}

/**
 * 等待条件成立（轮询真实定时器；被注入的假定时器不影响这里）。
 * 为什么需要它：探测是异步的，且 start() 刻意不 await 探测（D8）。
 */
async function waitFor(predicate, label = '条件', timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor 等待超时：' + label);
}

/**
 * 假定时器：记录延迟并由测试手动触发，避免真的等 60 秒。
 * 只注入给 guard 的 deps，不替换全局 setTimeout（waitFor 还要用真的）。
 */
function createFakeTimers() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeoutFn(fn, ms) {
      nextId += 1;
      const handle = {
        id: nextId,
        unref() {
          return handle;
        },
      };
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearTimeoutFn(handle) {
      timers.delete(handle);
    },
    fire() {
      const first = timers.keys().next();
      if (first.done) return false;
      const handle = first.value;
      const { fn } = timers.get(handle);
      timers.delete(handle);
      fn();
      return true;
    },
    delays() {
      return [...timers.values()].map((timer) => timer.ms);
    },
    size() {
      return timers.size;
    },
  };
}

/**
 * 构造探针桩：blackSet 里的 IP 判黑洞，其余判可用。
 * @param {() => Set<string>} getBlackSet
 */
function createProbeStub(getBlackSet) {
  const calls = { count: 0, targets: [], opts: [] };
  async function probeAll(ips, opts) {
    calls.count += 1;
    calls.targets = [...ips];
    calls.opts.push(opts);
    const blackSet = getBlackSet();
    return ips.map((ip) =>
      blackSet.has(ip)
        ? { ip, ok: false, ms: null, error: 'timeout' }
        : { ip, ok: true, ms: 120, error: null },
    );
  }
  return { probeAll, calls };
}

/** 构造 dispatcher/lookup 桩，并记录调用参数。 */
function createDispatcherStub() {
  const record = { installCalls: 0, installOpts: null, restoreCalls: 0, lookupOpts: null };
  return {
    record,
    deps: {
      createLookup(opts) {
        record.lookupOpts = opts;
        return function fakeLookup() {};
      },
      async installDispatcher(opts) {
        record.installCalls += 1;
        record.installOpts = opts;
        return {
          dispatcher: {},
          restore() {
            record.restoreCalls += 1;
          },
        };
      },
    },
  };
}

/** 组装一个「无代理、可成功安装」的 deps，并带出调用记录。 */
function createBaseDeps(extra = {}) {
  const dispatcher = createDispatcherStub();
  return {
    record: dispatcher.record,
    deps: {
      ...dispatcher.deps,
      env: EMPTY_ENV,
      ...extra,
    },
  };
}

test('detectProxy 环境变量表驱动', async (t) => {
  const cases = [
    {
      name: '没有任何代理变量 → 无代理',
      env: {},
      expected: { hasProxy: false, envVar: null, reason: null },
    },
    {
      name: 'HTTPS_PROXY 为合法 http URL → 有代理',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      expected: { hasProxy: true, envVar: 'HTTPS_PROXY' },
    },
    {
      name: '小写 https_proxy 同样识别',
      env: { https_proxy: 'http://127.0.0.1:7890' },
      expected: { hasProxy: true, envVar: 'https_proxy' },
    },
    {
      name: 'HTTP_PROXY 同样识别',
      env: { HTTP_PROXY: 'http://proxy.example.com:8080' },
      expected: { hasProxy: true, envVar: 'HTTP_PROXY' },
    },
    {
      name: 'ALL_PROXY 同样识别',
      env: { ALL_PROXY: 'https://proxy.example.com:8443' },
      expected: { hasProxy: true, envVar: 'ALL_PROXY' },
    },
    {
      name: '值不是 URL → 无代理',
      env: { HTTPS_PROXY: 'not a url' },
      expected: { hasProxy: false, envVar: null, reason: null },
    },
    {
      name: 'socks5 协议不被 DSH 代理接管 → 无代理',
      env: { ALL_PROXY: 'socks5://127.0.0.1:7890' },
      expected: { hasProxy: false, envVar: null, reason: null },
    },
    {
      name: '空字符串值视为未配置',
      env: { HTTPS_PROXY: '   ' },
      expected: { hasProxy: false, envVar: null, reason: null },
    },
    {
      name: "NO_PROXY='*' 全覆盖 → 无代理",
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '*' },
      // 变量被命中但被 NO_PROXY 覆盖：envVar 仍报告出来，便于日志说明「为什么没启用」
      expected: { hasProxy: false, envVar: 'HTTPS_PROXY' },
    },
    {
      name: 'NO_PROXY 精确覆盖目标域名 → 无代理',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'opencode.ai' },
      expected: { hasProxy: false, envVar: 'HTTPS_PROXY' },
    },
    {
      name: 'NO_PROXY 前导点后缀覆盖 → 无代理',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.opencode.ai' },
      expected: { hasProxy: false, envVar: 'HTTPS_PROXY' },
    },
    {
      name: 'NO_PROXY 带端口仍能覆盖 → 无代理',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'opencode.ai:443' },
      expected: { hasProxy: false, envVar: 'HTTPS_PROXY' },
    },
    {
      name: '常见 loopback 绕过不覆盖目标域名 → 仍算有代理',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' },
      expected: { hasProxy: true, envVar: 'HTTPS_PROXY' },
    },
    {
      name: '低优先级变量非法时继续找下一个',
      env: { https_proxy: 'not a url', HTTP_PROXY: 'http://127.0.0.1:7890' },
      expected: { hasProxy: true, envVar: 'HTTP_PROXY' },
    },
    {
      name: '大小写同时存在时 HTTPS_PROXY 优先',
      env: {
        HTTPS_PROXY: 'http://upper.example.com:1111',
        https_proxy: 'http://lower.example.com:2222',
      },
      expected: { hasProxy: true, envVar: 'HTTPS_PROXY' },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = detectProxy(item.env, 'opencode.ai');
      assert.equal(result.hasProxy, item.expected.hasProxy);
      if (item.expected.envVar !== undefined) assert.equal(result.envVar, item.expected.envVar);
      if (item.expected.reason !== undefined) assert.equal(result.reason, item.expected.reason);
    });
  }
});

test('start 在检测到代理时禁用自身且不安装 dispatcher', async () => {
  const { record, deps } = createBaseDeps({
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  const snap = guard.snapshot();

  assert.equal(snap.state, 'disabled_by_proxy');
  assert.equal(snap.enabled, false);
  assert.match(snap.reason, /代理/);
  assert.equal(record.installCalls, 0);
  assert.equal(record.lookupOpts, null);
  assert.equal(snap.entries.length, 0);
});

test('配置关闭时不安装 dispatcher，状态保持 idle', async () => {
  const { record, deps } = createBaseDeps();
  const guard = createGuard({
    config: { ...BASE_CONFIG, enabled: false },
    log: () => {},
    deps,
  });

  await guard.start();
  const snap = guard.snapshot();

  assert.equal(snap.state, 'idle');
  assert.equal(snap.enabled, false);
  assert.match(snap.reason, /关闭/);
  assert.equal(record.installCalls, 0);
});

test('无代理时安装 dispatcher，探测完成后进入 ready', async () => {
  const probe = createProbeStub(() => new Set(['10.0.0.2']));
  const { record, deps } = createBaseDeps({ probeAll: probe.probeAll });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  await waitFor(() => guard.snapshot().state === 'ready', '进入 ready');
  const snap = guard.snapshot();

  assert.equal(record.installCalls, 1);
  assert.equal(record.installOpts.connectTimeoutMs, 10000);
  assert.deepEqual(record.lookupOpts.hostnames, ['opencode.ai']);
  assert.deepEqual(record.lookupOpts.forceIps, BASE_CONFIG.forceIps);
  assert.ok(record.lookupOpts.blacklist, 'lookup 必须拿到同一个黑名单实例');
  assert.equal(probe.calls.count, 1);
  assert.equal(probe.calls.opts[0].servername, 'opencode.ai');
  assert.equal(probe.calls.opts[0].timeoutMs, 10000);

  assert.equal(snap.state, 'ready');
  assert.equal(snap.enabled, true);
  assert.equal(snap.reason, null);
  assert.equal(snap.nextRetryAt, null);
  assert.equal(typeof snap.lastProbeAt, 'number');
  assert.ok(snap.lastProbeAt <= Date.now());
  assert.deepEqual(snap.stats, { ok: 1, black: 1, total: 2 });
  assert.deepEqual(snap.entries.map((entry) => entry.ip), ['10.0.0.1', '10.0.0.2']);
  assert.equal(snap.entries[0].state, 'ok');
  assert.equal(snap.entries[0].ms, 120);
  assert.equal(snap.entries[1].state, 'black');
  assert.equal(snap.entries[1].error, 'timeout');
});

test('start 立即返回，探测完成前状态为 probing', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let probeCalls = 0;
  const { deps } = createBaseDeps({
    probeAll: async (ips) => {
      probeCalls += 1;
      await gate;
      return ips.map((ip) => ({ ip, ok: true, ms: 1, error: null }));
    },
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  // start 返回时探测已被调度（异步），等它真正进入 probeAll 再断言
  await waitFor(() => probeCalls === 1, '探测已启动');
  // 探测被 gate 挡住：状态停在 probing（D8：不阻塞启动）
  assert.equal(guard.snapshot().state, 'probing');

  release();
  await waitFor(() => guard.snapshot().state === 'ready', 'gate 释放后 ready');
});

test('全失败时按 60s/120s 重试，第三次失败进入 failed 并停止', async () => {
  const timers = createFakeTimers();
  const probe = createProbeStub(() => new Set(['10.0.0.1', '10.0.0.2']));
  const { deps } = createBaseDeps({
    probeAll: probe.probeAll,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();

  // 第一次失败 → degraded，60 秒后重试
  await waitFor(() => guard.snapshot().state === 'degraded', '第一次降级');
  assert.deepEqual(timers.delays(), [60000]);
  // 全失败时黑名单必须不生效（clear）
  assert.deepEqual(guard.snapshot().stats, { ok: 0, black: 0, total: 0 });
  const firstNextRetryAt = guard.snapshot().nextRetryAt;
  assert.equal(typeof firstNextRetryAt, 'number');
  assert.ok(firstNextRetryAt >= Date.now() + 59000);
  assert.equal(probe.calls.count, 1);

  // 第二次失败 → 再等 120 秒
  timers.fire();
  await waitFor(
    () => guard.snapshot().state === 'degraded' && timers.delays()[0] === 120000,
    '第二次降级',
  );
  assert.equal(probe.calls.count, 2);

  // 第三次失败 → failed，不再安排定时器
  timers.fire();
  await waitFor(() => guard.snapshot().state === 'failed', '第三次失败后 failed');
  assert.equal(probe.calls.count, 3);
  assert.equal(timers.size(), 0);
  assert.equal(guard.snapshot().nextRetryAt, null);
  assert.match(guard.snapshot().reason, /停止/);
  assert.equal(guard.snapshot().enabled, true);
});

test('降级后重试成功会恢复 ready 并清理定时器', async () => {
  const timers = createFakeTimers();
  let failing = true;
  const { deps } = createBaseDeps({
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    probeAll: async (ips) =>
      ips.map((ip) =>
        failing
          ? { ip, ok: false, ms: null, error: 'timeout' }
          : { ip, ok: true, ms: 80, error: null },
      ),
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  await waitFor(() => guard.snapshot().state === 'degraded', '先降级');
  assert.equal(timers.size(), 1);

  failing = false;
  timers.fire();
  await waitFor(() => guard.snapshot().state === 'ready', '重试后恢复 ready');

  assert.equal(timers.size(), 0);
  assert.equal(guard.snapshot().nextRetryAt, null);
  assert.deepEqual(guard.snapshot().stats, { ok: 2, black: 0, total: 2 });
});

test('refresh 用重探结果重建黑名单（恢复的 IP 被移出）', async () => {
  let round = 0;
  const { deps } = createBaseDeps({
    probeAll: async (ips) => {
      // 第一轮 .1 可用；第二轮反过来，模拟「恢复」与「新黑洞」
      const blackSet = round === 0 ? new Set(['10.0.0.2']) : new Set(['10.0.0.1']);
      round += 1;
      return ips.map((ip) =>
        blackSet.has(ip)
          ? { ip, ok: false, ms: null, error: 'timeout' }
          : { ip, ok: true, ms: 90, error: null },
      );
    },
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  await waitFor(() => guard.snapshot().state === 'ready', '首轮 ready');
  assert.deepEqual(
    guard.snapshot().entries.map((entry) => [entry.ip, entry.state]),
    [
      ['10.0.0.1', 'ok'],
      ['10.0.0.2', 'black'],
    ],
  );

  const snap = await guard.refresh();
  assert.equal(snap.state, 'ready');
  assert.equal(round, 2);
  assert.deepEqual(
    snap.entries.map((entry) => [entry.ip, entry.state]),
    [
      ['10.0.0.1', 'black'],
      ['10.0.0.2', 'ok'],
    ],
  );
});

test('refresh 在探测进行中不重复触发探测', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let probeCalls = 0;
  const { deps } = createBaseDeps({
    probeAll: async (ips) => {
      probeCalls += 1;
      await gate;
      return ips.map((ip) => ({ ip, ok: true, ms: 1, error: null }));
    },
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  await waitFor(() => probeCalls === 1, '探测已启动');

  const snap = await guard.refresh();
  assert.equal(probeCalls, 1, '探测进行中不应再发一轮');
  assert.equal(snap.state, 'probing');

  release();
  await waitFor(() => guard.snapshot().state === 'ready', '释放后 ready');
});

test('probeAll 抛错时只降级，不向调用方抛穿', async () => {
  const logs = createLogCollector();
  const { deps } = createBaseDeps({
    probeAll: async () => {
      throw new Error('boom');
    },
  });
  const guard = createGuard({ config: BASE_CONFIG, log: logs.log, deps });

  await assert.doesNotReject(guard.start());
  await waitFor(() => guard.snapshot().state === 'degraded', '异常后降级');
  assert.match(guard.snapshot().reason, /异常/);
  assert.ok(logs.lines.some((line) => line.includes('异常')));
});

test('DNS 解析失败按探测失败处理', async () => {
  const probe = createProbeStub(() => new Set());
  const { deps } = createBaseDeps({
    probeAll: probe.probeAll,
    resolve4: async () => {
      throw new Error('dns down');
    },
  });
  const guard = createGuard({
    config: { ...BASE_CONFIG, forceIps: [] },
    log: () => {},
    deps,
  });

  await guard.start();
  await waitFor(() => guard.snapshot().state === 'degraded', 'DNS 失败后降级');
  assert.equal(probe.calls.count, 0, '没有 IP 就不该发起探测');
  assert.match(guard.snapshot().reason, /异常/);
});

test('installDispatcher 失败时进入 error 状态且不探测', async () => {
  const probe = createProbeStub(() => new Set());
  const { deps } = createBaseDeps({
    probeAll: probe.probeAll,
    createLookup: () => () => {},
    installDispatcher: async () => {
      throw new Error('undici 不可用');
    },
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  const snap = guard.snapshot();
  assert.equal(snap.state, 'error');
  assert.match(snap.reason, /dispatcher/);
  assert.equal(probe.calls.count, 0);
});

test('dispose 清理定时器、恢复 dispatcher 且幂等', async () => {
  const timers = createFakeTimers();
  const probe = createProbeStub(() => new Set(['10.0.0.1', '10.0.0.2']));
  const { record, deps } = createBaseDeps({
    probeAll: probe.probeAll,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
  });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  await waitFor(() => guard.snapshot().state === 'degraded', '先降级并挂上定时器');
  assert.equal(timers.size(), 1);

  guard.dispose();
  assert.equal(record.restoreCalls, 1);
  assert.equal(timers.size(), 0);

  guard.dispose();
  assert.equal(record.restoreCalls, 1, 'dispose 必须幂等');

  // 释放后刷新只返回快照，不再探测
  const before = probe.calls.count;
  const snap = await guard.refresh();
  assert.equal(probe.calls.count, before);
  assert.equal(snap.state, 'degraded');
});

test('snapshot 返回契约 5 的完整字段', async () => {
  const probe = createProbeStub(() => new Set(['10.0.0.2']));
  const { deps } = createBaseDeps({ probeAll: probe.probeAll });
  const guard = createGuard({ config: BASE_CONFIG, log: () => {}, deps });

  await guard.start();
  await waitFor(() => guard.snapshot().state === 'ready', '进入 ready');
  const snap = guard.snapshot();

  assert.deepEqual(Object.keys(snap).sort(), [
    'enabled',
    'entries',
    'lastProbeAt',
    'nextRetryAt',
    'reason',
    'state',
    'stats',
  ]);
  for (const entry of snap.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'error', 'ip', 'ms', 'state']);
    assert.equal(typeof entry.at, 'number');
  }
});

test('buildStatus 对缺失/脏输入做安全归一化', () => {
  // 缺省输入 → 未启动
  const empty = buildStatus();
  assert.equal(empty.state, 'idle');
  assert.equal(empty.enabled, false);
  assert.equal(empty.reason, null);
  assert.equal(empty.lastProbeAt, null);
  assert.equal(empty.nextRetryAt, null);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.stats, { ok: 0, black: 0, total: 0 });

  // 非法 state → error，并补可读原因
  const invalid = buildStatus({ state: 'bogus-state' });
  assert.equal(invalid.state, 'error');
  assert.equal(invalid.reason, '状态值非法');

  // 条目清洗 + 排序；非法的整条丢弃
  const mixed = buildStatus({
    state: 'ready',
    enabled: true,
    lastProbeAt: 123,
    nextRetryAt: Number.NaN,
    reason: '',
    entries: [
      { ip: '9.9.9.9', state: 'black', ms: null, error: 'timeout', at: 999 },
      { ip: '1.1.1.1', state: 'ok', ms: 300, error: null, at: 111 },
      { ip: '', state: 'ok', ms: 1, error: null, at: 1 },
      { ip: '2.2.2.2', state: 'weird', ms: 1, error: null, at: 1 },
      { ip: '3.3.3.3', state: 'ok', ms: 'slow', error: 42, at: Number.NaN },
    ],
  });
  assert.deepEqual(mixed.entries.map((entry) => entry.ip), ['1.1.1.1', '3.3.3.3', '9.9.9.9']);
  assert.equal(mixed.entries[1].ms, null);
  assert.equal(mixed.entries[1].error, null);
  assert.equal(mixed.entries[1].at, 0);
  assert.equal(mixed.lastProbeAt, 123);
  assert.equal(mixed.nextRetryAt, null);
  assert.equal(mixed.reason, null);
  assert.deepEqual(mixed.stats, { ok: 2, black: 1, total: 3 });
});
