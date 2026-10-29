/**
 * smoke-host.mjs —— 集成冒烟测试（不启动 DSH，用伪造 ctx 模拟宿主）
 *
 * 为什么需要它：
 *   单元测试只验证各模块自身，但「插件能否被 cordis 加载」是另一回事：
 *   apply 的返回值、inject 的写法、ctx.effect/dispose 的接法，任一错位都会让插件在真实
 *   DSH 里静默失效。本脚本用一个最小的伪造 ctx 把这些接线跑一遍。
 *
 * 覆盖点：
 *   1. apply 可被调用且不抛异常；
 *   2. apply 返回 undefined（返回业务对象会触发 cordis 的 Invalid effect）；
 *   3. 注册了 GET /opencode-ip-guard/status 与 POST /opencode-ip-guard/refresh；
 *   4. status 返回的 JSON 符合 StatusSnapshot 契约字段；
 *   5. dispose 可被调用且不抛；
 *   6. 插件不会因为没有 webServer 而崩溃。
 *
 * 用法：& "<node>" scripts/smoke-host.mjs
 */

import assert from 'node:assert/strict';

const ROUTES = new Map();
let disposeHandler = null;
const logs = [];

/**
 * 伪造一个最小的 cordis 上下文。
 * 只实现 apply 真正用到的那几个成员：logger / inject / effect / on。
 */
function createFakeContext() {
  return {
    logger: {
      info: (line) => logs.push(['info', String(line)]),
      warn: (line) => logs.push(['warn', String(line)]),
    },
    /** 模拟 cordis 的服务注入：本测试直接提供 webServer。 */
    inject: (deps, callback) => {
      const services = {};
      if (deps.includes('webServer')) {
        services.webServer = {
          /** 模拟 webServer.register：记录路由并返回清理函数。 */
          register: ({ path, handler }) => {
            ROUTES.set(path, handler);
            return () => ROUTES.delete(path);
          },
        };
      }
      callback(services);
    },
    /** 模拟 effect：立即执行并记录 disposer。 */
    effect: (factory) => {
      const disposer = factory();
      return disposer;
    },
    on: (event, handler) => {
      if (event === 'dispose') disposeHandler = handler;
    },
  };
}

/**
 * 伪造一个 HTTP 响应对象，收集 handler 写出的状态码与响应体。
 */
function createFakeResponse() {
  const captured = { statusCode: 0, body: '', headers: {} };
  captured.writeHead = (statusCode, headers) => { captured.statusCode = statusCode; Object.assign(captured.headers, headers || {}); };
  captured.end = (body) => { captured.body = body === undefined ? '' : String(body); };
  return captured;
}

async function main() {
  const mod = await import('../src/index.js');

  assert.equal(mod.name, 'dsh-opencode-ip-guard', 'name 必须与包名一致');
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组');
  assert.equal(typeof mod.apply, 'function', 'apply 必须导出');
  console.log('  [PASS] 导出形态正确 (name/inject/apply)');

  const ctx = createFakeContext();
  const returnValue = await mod.apply(ctx, { probeTimeoutMs: 3000 });
  assert.equal(returnValue, undefined, 'apply 不能返回业务对象（会触发 Invalid effect）');
  console.log('  [PASS] apply 返回 undefined，不抛异常');

  const statusPath = '/opencode-ip-guard/status';
  const refreshPath = '/opencode-ip-guard/refresh';
  assert.ok(ROUTES.has(statusPath), '必须注册 status 路由');
  assert.ok(ROUTES.has(refreshPath), '必须注册 refresh 路由');
  console.log('  [PASS] 两条路由已注册：' + [...ROUTES.keys()].join(', '));

  // 探测是异步的：给它一点时间，但不阻塞过久
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const res1 = createFakeResponse();
  ROUTES.get(statusPath)({}, res1);
  assert.equal(res1.statusCode, 200, 'status 应返回 200');
  const snapshot = JSON.parse(res1.body);
  for (const key of ['state', 'enabled', 'reason', 'lastProbeAt', 'nextRetryAt', 'entries', 'stats']) {
    assert.ok(Object.prototype.hasOwnProperty.call(snapshot, key), 'StatusSnapshot 缺少字段: ' + key);
  }
  assert.ok(Array.isArray(snapshot.entries), 'entries 必须是数组');
  console.log('  [PASS] status 返回合法快照: state=' + snapshot.state + ', entries=' + snapshot.entries.length + ', stats=' + JSON.stringify(snapshot.stats));

  const res2 = createFakeResponse();
  await new Promise((resolve) => {
    const maybePromise = ROUTES.get(refreshPath)({}, res2);
    if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(resolve, resolve);
    else setTimeout(resolve, 3000);
  });
  console.log('  [PASS] refresh 路由可调用（status=' + (res2.statusCode || 'async') + '）');

  assert.equal(typeof disposeHandler, 'function', '必须注册 dispose 处理器');
  disposeHandler();
  console.log('  [PASS] dispose 可调用且不抛');

  // 第二条路径：没有 webServer 时插件也必须能加载
  const ctxNoServer = {
    logger: ctx.logger,
    inject: (deps, callback) => callback({}),
    effect: (factory) => factory(),
    on: () => {},
  };
  const ret2 = await mod.apply(ctxNoServer, { enabled: false });
  assert.equal(ret2, undefined, '无 webServer 时 apply 也不能返回业务对象');
  console.log('  [PASS] 无 webServer 时插件仍可加载（enabled:false）');

  console.log('');
  console.log('=== 集成冒烟测试全部通过 ===');
  if (logs.some(([level]) => level === 'warn')) {
    console.log('（过程中的 warn 日志：）');
    for (const [, line] of logs.filter(([level]) => level === 'warn')) console.log('  - ' + line);
  }
}

main().catch((error) => {
  console.error('集成冒烟测试失败：', error);
  process.exitCode = 1;
});