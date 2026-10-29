/**
 * lookup.js 单元测试。
 *
 * 全部使用注入的 resolve4 / fallbackLookup / forceIps，不触网：
 * 被测对象是「候选 IP 怎么选、回调形态怎么给、失败怎么回退」这三件事，
 * 与真实 DNS 无关；注入可控输入才能稳定断言每条降级路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookup } from '../src/lookup.js';

/** 构造一个符合契约 1 的假黑名单：filter 按契约保证「全黑时返回原始列表」。 */
function createBlacklist(blackIps, filterOverride) {
  const black = new Set(blackIps);
  return {
    isBlack: (ip) => black.has(ip),
    filter:
      filterOverride ||
      ((ips) => {
        const usable = ips.filter((ip) => !black.has(ip));
        return usable.length > 0 ? usable : ips;
      }),
  };
}

/** 触发一次 lookup 并把回调参数原样收集下来，便于断言两种回调形态。 */
function invoke(lookup, hostname, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lookup 回调未在 2s 内触发')), 2000);
    lookup(hostname, options, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

/** 默认的假系统解析器；测试里用调用来证明「确实回退到了它」。 */
function createFallback(module = {}) {
  const calls = [];
  const fallbackLookup = (hostname, options, callback) => {
    calls.push({ hostname, options });
    callback(null, '203.0.113.9', 4);
  };
  return { calls, fallbackLookup, ...module };
}

test('lookup：目标域名 all 模式返回 [{address, family: 4}]，且使用 resolve4 的实时结果', async () => {
  const resolveCalls = [];
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist(['172.65.90.20', '172.65.90.22']),
    resolve4: async (hostname) => {
      resolveCalls.push(hostname);
      return ['172.65.90.20', '172.65.90.21', '172.65.90.22', '172.65.90.23'];
    },
    fallbackLookup: createFallback().fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', { all: true });
  assert.deepEqual(args, [null, [{ address: '172.65.90.21', family: 4 }]]);
  assert.deepEqual(resolveCalls, ['opencode.ai']);
});

test('lookup：目标域名非 all 模式返回 (null, address, 4)', async () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist(['172.65.90.20']),
    resolve4: async () => ['172.65.90.20', '172.65.90.21'],
    fallbackLookup: createFallback().fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '172.65.90.21', 4]);
});

test('lookup：按顺序取过滤后的第一个可用 IP（黑名单在第二、三位时选第一位）', async () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist(['172.65.90.21', '172.65.90.22']),
    resolve4: async () => ['172.65.90.20', '172.65.90.21', '172.65.90.22', '172.65.90.23'],
    fallbackLookup: createFallback().fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '172.65.90.20', 4]);
});

test('lookup：过滤后一个不剩时必须回退原始列表，绝不返回空', async () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    // 故意让黑名单 filter 返回空数组（契约要求它不会这样，但我们要有二次兜底）
    blacklist: createBlacklist([], () => []),
    resolve4: async () => ['172.65.90.20', '172.65.90.22'],
    fallbackLookup: createFallback().fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '172.65.90.20', 4]);
});

test('lookup：非目标域名原样回退系统解析器，不调用 resolve4', async () => {
  const fallback = createFallback();
  let resolveCalled = 0;
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist(['1.2.3.4']),
    resolve4: async () => {
      resolveCalled += 1;
      return ['1.2.3.4'];
    },
    fallbackLookup: fallback.fallbackLookup,
  });

  const args = await invoke(lookup, 'api.example.com', {});
  assert.deepEqual(args, [null, '203.0.113.9', 4]);
  assert.equal(resolveCalled, 0);
  assert.equal(fallback.calls.length, 1);
  assert.equal(fallback.calls[0].hostname, 'api.example.com');
});

test('lookup：非目标域名 all 模式时把系统解析器的数组原样透传（不二次包装）', async () => {
  const fallbackLookup = (hostname, options, callback) => {
    callback(null, [{ address: '203.0.113.9', family: 4 }]);
  };
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: async () => ['1.2.3.4'],
    fallbackLookup,
  });

  const args = await invoke(lookup, 'api.example.com', { all: true });
  assert.deepEqual(args, [null, [{ address: '203.0.113.9', family: 4 }]]);
});

test('lookup：resolve4 失败时回退系统解析器', async () => {
  const fallback = createFallback();
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist(['1.2.3.4']),
    resolve4: async () => {
      throw new Error('ENOTFOUND');
    },
    fallbackLookup: fallback.fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '203.0.113.9', 4]);
  assert.equal(fallback.calls.length, 1);
});

test('lookup：resolve4 同步抛错同样回退，不抛穿', async () => {
  const fallback = createFallback();
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: () => {
      throw new Error('boom');
    },
    fallbackLookup: fallback.fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '203.0.113.9', 4]);
});

test('lookup：解析结果为空数组时回退系统解析器', async () => {
  const fallback = createFallback();
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: async () => [],
    fallbackLookup: fallback.fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '203.0.113.9', 4]);
});

test('lookup：只解析出 IPv6 时视为无 IPv4 候选，回退系统解析器', async () => {
  const fallback = createFallback();
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: async () => ['2606:4700:78::90:0:140', '2606:4700:78::90:0:141'],
    fallbackLookup: fallback.fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '203.0.113.9', 4]);
});

test('lookup：forceIps 非空时忽略真实解析，只用注入 IP 并照常过滤黑名单', async () => {
  const fallback = createFallback();
  let resolveCalled = 0;
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist(['172.65.90.20']),
    resolve4: async () => {
      resolveCalled += 1;
      return ['172.65.90.21'];
    },
    fallbackLookup: fallback.fallbackLookup,
    forceIps: ['172.65.90.20', '172.65.90.23'],
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '172.65.90.23', 4]);
  assert.equal(resolveCalled, 0);
});

test('lookup：forceIps 全被黑名单剔除时回退原始 forceIps 列表', async () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist(['172.65.90.20', '172.65.90.22']),
    resolve4: async () => ['172.65.90.21'],
    fallbackLookup: createFallback().fallbackLookup,
    forceIps: ['172.65.90.20', '172.65.90.22'],
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '172.65.90.20', 4]);
});

test('lookup：忽略 options.family，始终返回 IPv4', async () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: async () => ['172.65.90.21'],
    fallbackLookup: createFallback().fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', { family: 6 });
  assert.deepEqual(args, [null, '172.65.90.21', 4]);
});

test('lookup：目标域名大小写与结尾点归一化（FQDN 写法也能匹配）', async () => {
  const fallback = createFallback();
  const resolveCalls = [];
  const lookup = createLookup({
    hostnames: ['OpenCode.AI.'],
    blacklist: createBlacklist([]),
    resolve4: async (hostname) => {
      resolveCalls.push(hostname);
      return ['172.65.90.21'];
    },
    fallbackLookup: fallback.fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai.', {});
  assert.deepEqual(args, [null, '172.65.90.21', 4]);
  // 交给解析器的是归一化后的主机名，避免把 FQDN 写法原样丢给 DNS 造成重复查询差异
  assert.deepEqual(resolveCalls, ['opencode.ai']);
  assert.equal(fallback.calls.length, 0);
});

test('lookup：黑名单 filter 自身抛错时退化为「不过滤」，保证请求可通', async () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: {
      isBlack: () => false,
      filter: () => {
        throw new Error('blacklist 坏了');
      },
    },
    resolve4: async () => ['172.65.90.20', '172.65.90.21'],
    fallbackLookup: createFallback().fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '172.65.90.20', 4]);
});

test('lookup：系统解析器同步抛错时以错误回调降级，不把异常抛给调用方', async () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: async () => ['172.65.90.21'],
    fallbackLookup: () => {
      throw new Error('系统解析器也坏了');
    },
  });

  // 目标是「不抛穿」：要么交错误回调，要么交可用的结果，两个都可以，但不能 throw
  const args = await invoke(lookup, 'api.example.com', {});
  assert.equal(args[0] instanceof Error, true);
});

test('lookup：回调只触发一次（异步解析完成后不再重复交付）', async () => {
  let calls = 0;
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: async () => ['172.65.90.21'],
    fallbackLookup: createFallback().fallbackLookup,
  });

  await new Promise((resolve) => {
    lookup('opencode.ai', {}, () => {
      calls += 1;
    });
    setTimeout(resolve, 50);
  });
  assert.equal(calls, 1);
});

test('lookup：没有回调时静默返回，不抛异常', () => {
  const lookup = createLookup({
    hostnames: ['opencode.ai'],
    blacklist: createBlacklist([]),
    resolve4: async () => ['172.65.90.21'],
  });
  assert.doesNotThrow(() => lookup('opencode.ai', {}));
  assert.doesNotThrow(() => lookup('opencode.ai', undefined));
});

test('lookup：hostnames 非数组时等同于没有目标域名，全部回退系统解析器', async () => {
  const fallback = createFallback();
  const lookup = createLookup({
    hostnames: null,
    blacklist: createBlacklist([]),
    resolve4: async () => ['172.65.90.21'],
    fallbackLookup: fallback.fallbackLookup,
  });

  const args = await invoke(lookup, 'opencode.ai', {});
  assert.deepEqual(args, [null, '203.0.113.9', 4]);
  assert.equal(fallback.calls.length, 1);
});
