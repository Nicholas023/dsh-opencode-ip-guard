/**
 * session-header 单元测试
 *
 * 覆盖重点（都是出错就会静默坏掉的地方）：
 *   1. 配置归一化：脏值必须回退默认，不能因为配置写错让注入失效；
 *   2. 已有 x-opencode-session 的请求必须原样放行（覆盖会破坏会话亲和）；
 *   3. 没有 store 的请求必须完全透传（否则会污染所有网络请求）；
 *   4. llm/stream 只对配置里的 provider 生效；
 *   5. withStore 必须让每次 next() 都发生在 store 内（惰性流的关键）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  resolveSessionHeaderConfig,
  headerValueFor,
  patchFetch,
  withStore,
  createSessionHeader,
} from '../src/session-header.js';

/** 构造一个最小的假 cordis ctx，只实现 attach 用到的那几个成员。 */
function fakeCtx() {
  const effects = [];
  const listeners = [];
  const injected = [];
  return {
    effects,
    listeners,
    injected,
    logger: { info() {}, warn() {} },
    effect(factory, label) { effects.push({ disposer: factory(), label }); },
    on(event, handler, options) { listeners.push({ event, handler, options }); },
    inject(services, callback) { injected.push({ services, callback }); callback({}); },
  };
}

test('配置归一化：缺省值全开、providers 为 opencode 两个路由', () => {
  const c = resolveSessionHeaderConfig(undefined);
  assert.equal(c.enabled, true);
  assert.deepEqual([...c.providers], ['opencode', 'opencode-go']);
  assert.equal(c.mode, 'session-id');
});

test('配置归一化：只有显式 false 才关闭，脏值按开启处理', () => {
  assert.equal(resolveSessionHeaderConfig({ enabled: false }).enabled, false);
  assert.equal(resolveSessionHeaderConfig({ enabled: 'no' }).enabled, true);
  assert.equal(resolveSessionHeaderConfig({ enabled: 0 }).enabled, true);
  assert.equal(resolveSessionHeaderConfig(null).enabled, true);
});

test('配置归一化：自定义 providers 覆盖默认，非法 mode 回退 session-id', () => {
  const c = resolveSessionHeaderConfig({ providers: ['my-route'], mode: 'nonsense' });
  assert.deepEqual([...c.providers], ['my-route']);
  assert.equal(c.mode, 'session-id');
});

test('头值：session-id 模式直接用会话 id', () => {
  assert.equal(headerValueFor('abc', 'session-id', new Map()), 'abc');
});

test('头值：uuid 模式对同一会话稳定且是合法 UUID', () => {
  const table = new Map();
  const a = headerValueFor('s1', 'uuid', table);
  const b = headerValueFor('s1', 'uuid', table);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(headerValueFor('s2', 'uuid', table), a);
});

test('头值：空会话 id 返回 undefined（不注入）', () => {
  assert.equal(headerValueFor('', 'session-id', new Map()), undefined);
});

test('patchFetch：没有 store 时完全透传，不改 headers', () => {
  const als = new AsyncLocalStorage();
  let seen;
  const patched = patchFetch((input, init) => { seen = init; return 'ok'; }, als);
  patched('http://x', {});
  assert.deepEqual(seen, {});
});

test('patchFetch：有 store 时注入头', () => {
  const als = new AsyncLocalStorage();
  let seen;
  const patched = patchFetch((input, init) => { seen = init; return 'ok'; }, als);
  als.run({ value: 'SID' }, () => patched('http://x', {}));
  assert.equal(new Headers(seen.headers).get('x-opencode-session'), 'SID');
});

test('patchFetch：请求已带该头时绝不覆盖', () => {
  const als = new AsyncLocalStorage();
  let seen;
  const patched = patchFetch((input, init) => { seen = init; return 'ok'; }, als);
  als.run({ value: 'NEW' }, () => patched('http://x', { headers: { 'x-opencode-session': 'OLD' } }));
  assert.equal(new Headers(seen.headers).get('x-opencode-session'), 'OLD');
});

test('patchFetch：Request 对象形式也能识别并注入', () => {
  const als = new AsyncLocalStorage();
  let seen;
  const patched = patchFetch((input, init) => { seen = init; return 'ok'; }, als);
  const req = new Request('http://x', { method: 'POST' });
  als.run({ value: 'REQ-SID' }, () => patched(req, {}));
  assert.equal(new Headers(seen.headers).get('x-opencode-session'), 'REQ-SID');
});

test('withStore：每次 next() 都在 store 作用域内执行', async () => {
  const als = new AsyncLocalStorage();
  const seen = [];
  const inner = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => { seen.push(als.getStore()?.value); return { done: seen.length >= 2, value: 1 }; },
        return: async () => ({ done: true }),
      };
    },
  };
  for await (const _ of withStore(inner, { value: 'S' }, als)) { /* 消费到结束 */ }
  assert.deepEqual(seen, ['S', 'S']);
});

test('withStore：return() 会正常结束且不抛', async () => {
  const als = new AsyncLocalStorage();
  const inner = { [Symbol.asyncIterator]() { return { next: async () => ({ done: false, value: 1 }), return: async () => ({ done: true }) }; } };
  const it = withStore(inner, { value: 'S' }, als)[Symbol.asyncIterator]();
  const r = await it.return();
  assert.equal(r.done, true);
});

test('attach：enabled=false 时不替换 fetch', () => {
  const before = globalThis.fetch;
  const ctx = fakeCtx();
  createSessionHeader({ config: { enabled: false }, log: () => {} }).attach(ctx);
  assert.equal(globalThis.fetch, before);
});

test('attach：启用时替换 fetch，并通过 effect 的 disposer 恢复', () => {
  const before = globalThis.fetch;
  const ctx = fakeCtx();
  createSessionHeader({ config: { enabled: true }, log: () => {} }).attach(ctx);
  assert.notEqual(globalThis.fetch, before);
  // 模拟插件卸载：执行所有 effect 的 disposer
  for (const e of ctx.effects) e.disposer();
  assert.equal(globalThis.fetch, before);
});

test('attach：注册 llm/stream 监听，且非目标 provider 直接透传', async () => {
  const ctx = fakeCtx();
  createSessionHeader({ config: { enabled: true }, log: () => {} }).attach(ctx);
  try {
    // attach 里用 ctx.inject(['llm']) 包裹，假 ctx 会立刻回调
    assert.equal(ctx.injected.length, 1);
    assert.deepEqual(ctx.injected[0].services, ['llm']);
    const listener = ctx.listeners.find((l) => l.event === 'llm/stream');
    assert.ok(listener, '必须注册 llm/stream 监听');
    assert.equal(listener.options?.prepend, true, '必须 prepend，保证在外层就能挂 store');
    let nextCalled = 0;
    const out = listener.handler({ provider: 'other-route', sessionId: 's' }, () => { nextCalled++; return null; });
    assert.equal(nextCalled, 1);
    assert.equal(out, null);
  } finally {
    for (const e of ctx.effects) e.disposer();
  }
});

test('attach：目标 provider 返回被 withStore 包装的流，且缺 sessionId 时透传', async () => {
  const ctx = fakeCtx();
  createSessionHeader({ config: { enabled: true }, log: () => {} }).attach(ctx);
  try {
    const listener = ctx.listeners.find((l) => l.event === 'llm/stream');
    // 缺 sessionId：不包装
    const passthrough = { tag: 'raw' };
    assert.equal(listener.handler({ provider: 'opencode-go' }, () => passthrough), passthrough);
    // 有 sessionId：返回包装器（有 asyncIterator 且不等于原对象）
    const stream = { [Symbol.asyncIterator]() { return { next: async () => ({ done: true }) }; } };
    const wrapped = listener.handler({ provider: 'opencode-go', sessionId: 's-sid' }, () => stream);
    assert.notEqual(wrapped, stream);
    assert.equal(typeof wrapped[Symbol.asyncIterator], 'function');
  } finally {
    for (const e of ctx.effects) e.disposer();
  }
});