/**
 * dispatcher.js 单元测试。
 *
 * 核心验证点是「Agent 被用什么参数构造、全局 dispatcher 被怎么替换/恢复、失败是否降级」，
 * 这些都通过注入假 undici 模块来断言，不需要真实网络。
 * 最后一个用例用真实 undici 做安装/恢复闭环（仍不联网），确保动态 import 路径可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDispatcher } from '../src/dispatcher.js';

/** 构造一个行为可控的假 undici 模块，并暴露内部状态供断言。 */
function createFakeUndici(overrides = {}) {
  const state = { original: { name: 'original-dispatcher' }, installed: [] };
  class FakeAgent {
    constructor(options) {
      this.options = options;
      this.closed = false;
    }

    async close() {
      this.closed = true;
    }
  }
  const module = {
    Agent: FakeAgent,
    getGlobalDispatcher: () => state.original,
    setGlobalDispatcher: (dispatcher) => {
      state.installed.push(dispatcher);
    },
    ...overrides,
  };
  return { module, state, FakeAgent };
}

test('installDispatcher：用 connect.timeout + lookup 构造 Agent，且不设置 keepAliveTimeout', async () => {
  const { module, state, FakeAgent } = createFakeUndici();
  const lookup = () => {};
  const handle = await installDispatcher({ lookup, connectTimeoutMs: 8000, undici: module });

  try {
    assert.ok(handle.dispatcher instanceof FakeAgent);
    assert.deepEqual(handle.dispatcher.options, { connect: { timeout: 8000, lookup } });
    // D6：不做保活，一旦设置了 keepAliveTimeout 就等于改了连接复用行为
    assert.equal('keepAliveTimeout' in handle.dispatcher.options, false);
    // 安装动作必须真的落到全局 dispatcher 上
    assert.deepEqual(state.installed, [handle.dispatcher]);
  } finally {
    handle.restore();
  }
});

test('installDispatcher：connectTimeoutMs 缺省/非法时回落到 10000', async () => {
  const lookup = () => {};
  for (const connectTimeoutMs of [undefined, 0, -1, 'abc', NaN]) {
    const { module, FakeAgent } = createFakeUndici();
    const handle = await installDispatcher({ lookup, connectTimeoutMs, undici: module });
    try {
      assert.ok(handle.dispatcher instanceof FakeAgent);
      assert.equal(handle.dispatcher.options.connect.timeout, 10000);
    } finally {
      handle.restore();
    }
  }
});

test('installDispatcher：restore 恢复原 dispatcher，且幂等、可重复调用不抛错', async () => {
  const { module, state } = createFakeUndici();
  const handle = await installDispatcher({ lookup: () => {}, undici: module });
  assert.equal(state.installed.length, 1);

  handle.restore();
  assert.equal(state.installed.length, 2);
  assert.equal(state.installed[1], state.original);

  // 幂等：第二次不应再改写全局 dispatcher，也不能抛错
  assert.doesNotThrow(() => handle.restore());
  assert.doesNotThrow(() => handle.restore());
  assert.equal(state.installed.length, 2);
});

test('installDispatcher：undici 缺少 Agent 能力时降级为「不安装」，restore 仍可安全调用', async () => {
  const { module, state } = createFakeUndici({ Agent: undefined });
  const handle = await installDispatcher({ lookup: () => {}, undici: module });

  assert.equal(handle.dispatcher, null);
  assert.equal(state.installed.length, 0);
  assert.doesNotThrow(() => handle.restore());
});

test('installDispatcher：setGlobalDispatcher 抛错时整体降级，不让异常冒到调用方', async () => {
  const { module } = createFakeUndici({
    setGlobalDispatcher: () => {
      throw new Error('全局 dispatcher 不可写');
    },
  });

  const handle = await installDispatcher({ lookup: () => {}, undici: module });
  assert.equal(handle.dispatcher, null);
  assert.equal(typeof handle.restore, 'function');
  assert.doesNotThrow(() => handle.restore());
});

test('installDispatcher：Agent 构造抛错时同样降级', async () => {
  const { module } = createFakeUndici({
    Agent: class {
      constructor() {
        throw new Error('Agent 构造失败');
      }
    },
  });

  const handle = await installDispatcher({ lookup: () => {}, undici: module });
  assert.equal(handle.dispatcher, null);
  assert.doesNotThrow(() => handle.restore());
});

test('installDispatcher：getGlobalDispatcher 抛错时仍能安装，restore 不抛错', async () => {
  const { module, state, FakeAgent } = createFakeUndici({
    getGlobalDispatcher: () => {
      throw new Error('读不到全局 dispatcher');
    },
  });

  const handle = await installDispatcher({ lookup: () => {}, undici: module });
  assert.ok(handle.dispatcher instanceof FakeAgent);
  assert.equal(state.installed.length, 1);
  assert.doesNotThrow(() => handle.restore());
  // 没有可恢复的原值：restore 不应拿 undefined 去 setGlobalDispatcher
  assert.equal(state.installed.length, 1);
});

test('installDispatcher：真实 undici 闭环（安装 → 恢复），不联网', async (t) => {
  let undici;
  try {
    undici = await import('undici');
  } catch {
    // 环境里没有 undici（例如未安装依赖）时跳过，而不是失败
    t.skip('undici 不可用，跳过真实闭环测试');
    return;
  }

  const original = undici.getGlobalDispatcher();
  const handle = await installDispatcher({
    lookup: (hostname, options, callback) => callback(null, '127.0.0.1', 4),
    connectTimeoutMs: 5000,
  });

  try {
    assert.ok(handle.dispatcher, '真实 undici 下应安装成功');
    assert.equal(undici.getGlobalDispatcher(), handle.dispatcher);
    handle.restore();
    assert.equal(undici.getGlobalDispatcher(), original);
    // 幂等
    handle.restore();
    assert.equal(undici.getGlobalDispatcher(), original);
  } finally {
    try {
      await handle.dispatcher?.close?.();
    } catch {
      // 关闭 Agent 只是为了不留下句柄，失败不影响断言
    }
    try {
      undici.setGlobalDispatcher(original);
    } catch {
      // 兜底恢复，同属清理动作
    }
  }
});
