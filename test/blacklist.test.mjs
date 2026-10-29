/**
 * blacklist.js 单元测试：条目记录、软 TTL、过滤自锁保护、重建语义、快照稳定性。
 * 纯内存无 IO；TTL 用注入时钟验证，不产生任何真实等待。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlacklist } from '../src/blacklist.js';

/** 默认软 TTL，必须与实现里的常量一致（契约：5 分钟，与 index.js 默认值对齐）。 */
const DEFAULT_TTL_MS = 300000;

/**
 * 可手动拨动的时钟：注入给 createBlacklist 的 now，避免真的等 TTL 到期。
 * @param {number} [start]
 */
function createClock(start = 1000) {
  let now = start;
  return {
    now() {
      return now;
    },
    set(value) {
      now = value;
    },
    advance(ms) {
      now += ms;
    },
  };
}

test('初始状态为空', () => {
  const blacklist = createBlacklist();
  assert.equal(blacklist.isBlack('1.1.1.1'), false);
  assert.deepEqual(blacklist.entries(), []);
  assert.deepEqual(blacklist.expiredIps(), []);
  assert.deepEqual(blacklist.stats(), { ok: 0, black: 0, total: 0 });
});

test('markBlack 后 isBlack 为真，并记录原因、at 与 expiresAt', () => {
  const clock = createClock(1000);
  const blacklist = createBlacklist({ now: clock.now });
  blacklist.markBlack('172.65.90.20', 'timeout');

  assert.equal(blacklist.isBlack('172.65.90.20'), true);
  const [entry] = blacklist.entries();
  assert.equal(entry.ip, '172.65.90.20');
  assert.equal(entry.state, 'black');
  assert.equal(entry.ms, null);
  assert.equal(entry.error, 'timeout');
  assert.equal(entry.at, 1000);
  assert.equal(entry.expiresAt, 1000 + DEFAULT_TTL_MS);
});

test('markOk 记录耗时且不会被当成黑洞', () => {
  const blacklist = createBlacklist();
  blacklist.markOk('172.65.90.21', 371);

  assert.equal(blacklist.isBlack('172.65.90.21'), false);
  const [entry] = blacklist.entries();
  assert.equal(entry.state, 'ok');
  assert.equal(entry.ms, 371);
  assert.equal(entry.error, null);
});

test('耗时与原因会被清洗成稳定类型', () => {
  const blacklist = createBlacklist();
  blacklist.markOk('1.1.1.1', Number.NaN);
  blacklist.markOk('2.2.2.2', -5);
  blacklist.markBlack('3.3.3.3', undefined);

  const byIp = new Map(blacklist.entries().map((entry) => [entry.ip, entry]));
  assert.equal(byIp.get('1.1.1.1').ms, null);
  assert.equal(byIp.get('2.2.2.2').ms, null);
  assert.equal(byIp.get('3.3.3.3').error, 'unknown');
  assert.equal(blacklist.isBlack('3.3.3.3'), true);
});

test('非法 IP 的标记被静默忽略，不抛错', () => {
  const blacklist = createBlacklist();
  assert.doesNotThrow(() => {
    blacklist.markOk(null, 10);
    blacklist.markBlack(undefined, 'timeout');
    blacklist.markBlack('', 'timeout');
  });
  assert.deepEqual(blacklist.stats(), { ok: 0, black: 0, total: 0 });
});

test('entries 按 IP 字符串排序且返回快照副本', () => {
  const blacklist = createBlacklist();
  blacklist.markBlack('9.9.9.9', 'timeout');
  blacklist.markOk('172.65.90.21', 348);
  blacklist.markBlack('1.1.1.1', 'econnrefused');

  assert.deepEqual(
    blacklist.entries().map((entry) => entry.ip),
    ['1.1.1.1', '172.65.90.21', '9.9.9.9'],
  );

  // 快照副本：改返回值不能污染内部状态
  const snapshot = blacklist.entries();
  snapshot[0].ip = '被改坏';
  snapshot.pop();
  assert.deepEqual(
    blacklist.entries().map((entry) => entry.ip),
    ['1.1.1.1', '172.65.90.21', '9.9.9.9'],
  );
});

test('rebuild 先清空再按新结果重填', () => {
  const blacklist = createBlacklist();
  blacklist.markBlack('8.8.8.8', 'timeout');

  blacklist.rebuild([
    { ip: '1.1.1.1', ok: true, ms: 100, error: null },
    { ip: '2.2.2.2', ok: false, ms: null, error: 'timeout' },
  ]);

  // 旧条目必须消失：重建代表「这一轮探测是完整事实」（D16）
  assert.equal(blacklist.isBlack('8.8.8.8'), false);
  assert.deepEqual(blacklist.entries().map((entry) => entry.ip), ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(blacklist.stats(), { ok: 1, black: 1, total: 2 });
});

test('rebuild 忽略非法探测结果', () => {
  const blacklist = createBlacklist();
  blacklist.rebuild(null);
  assert.deepEqual(blacklist.stats(), { ok: 0, black: 0, total: 0 });

  blacklist.rebuild([
    null,
    { ok: true, ms: 1 },
    { ip: 42, ok: true, ms: 1 },
    { ip: '', ok: false, error: 'timeout' },
    { ip: '1.1.1.1', ok: true, ms: 10, error: null },
    // ok 不是严格 true 的一律按黑洞处理，避免脏数据把黑洞误判成可用
    { ip: '2.2.2.2', ok: 0, error: undefined },
  ]);

  assert.deepEqual(
    blacklist.entries().map((entry) => [entry.ip, entry.state]),
    [
      ['1.1.1.1', 'ok'],
      ['2.2.2.2', 'black'],
    ],
  );
});

test('filter 剔除黑洞并保持原始顺序', () => {
  const blacklist = createBlacklist();
  blacklist.markBlack('172.65.90.20', 'timeout');
  blacklist.markBlack('172.65.90.22', 'timeout');

  const input = ['172.65.90.20', '172.65.90.21', '172.65.90.22', '172.65.90.23'];
  assert.deepEqual(blacklist.filter(input), ['172.65.90.21', '172.65.90.23']);
});

test('filter 全部命中黑名单时返回原始列表（防自锁）', () => {
  const blacklist = createBlacklist();
  const input = ['172.65.90.20', '172.65.90.22'];
  input.forEach((ip) => blacklist.markBlack(ip, 'timeout'));

  const filtered = blacklist.filter(input);
  // 契约：剔除后为空必须返回原始列表，绝不能返回空数组把连接搞死
  assert.deepEqual(filtered, input);
  assert.notEqual(filtered.length, 0);
});

test('filter 对空数组与非法入参安全降级', () => {
  const blacklist = createBlacklist();
  assert.deepEqual(blacklist.filter([]), []);
  assert.deepEqual(blacklist.filter(null), []);
  assert.deepEqual(blacklist.filter(undefined), []);
  assert.deepEqual(blacklist.filter('not-an-array'), []);
});

test('filter 不修改入参数组', () => {
  const blacklist = createBlacklist();
  blacklist.markBlack('1.1.1.1', 'timeout');
  const input = ['1.1.1.1', '2.2.2.2'];
  blacklist.filter(input);
  assert.deepEqual(input, ['1.1.1.1', '2.2.2.2']);
});

test('重复标记会刷新状态与 at/expiresAt', () => {
  const clock = createClock(1000);
  const blacklist = createBlacklist({ now: clock.now });
  blacklist.markBlack('1.1.1.1', 'timeout');
  clock.advance(500);
  blacklist.markOk('1.1.1.1', 55);

  const [entry] = blacklist.entries();
  assert.equal(entry.state, 'ok');
  assert.equal(entry.ms, 55);
  assert.equal(entry.error, null);
  assert.equal(entry.at, 1500);
  assert.equal(entry.expiresAt, 1500 + DEFAULT_TTL_MS);
  assert.equal(blacklist.isBlack('1.1.1.1'), false);
});

test('stats 与 clear', () => {
  const blacklist = createBlacklist();
  blacklist.markOk('1.1.1.1', 10);
  blacklist.markOk('2.2.2.2', 20);
  blacklist.markBlack('3.3.3.3', 'timeout');
  assert.deepEqual(blacklist.stats(), { ok: 2, black: 1, total: 3 });

  blacklist.clear();
  assert.deepEqual(blacklist.stats(), { ok: 0, black: 0, total: 0 });
  assert.deepEqual(blacklist.entries(), []);
});

// ───────────────────────── 软 TTL ─────────────────────────

test('默认 TTL 为 300000ms', () => {
  const blacklist = createBlacklist();
  blacklist.markBlack('1.1.1.1', 'timeout');
  const [entry] = blacklist.entries();
  assert.equal(entry.expiresAt - entry.at, DEFAULT_TTL_MS);
});

test('TTL 到期后 isBlack=false、filter 放行，但条目仍保留在 entries/stats', () => {
  const clock = createClock(0);
  const blacklist = createBlacklist({ ttlMs: 1000, now: clock.now });
  blacklist.markBlack('1.1.1.1', 'timeout');

  clock.set(999);
  assert.equal(blacklist.isBlack('1.1.1.1'), true, '未到期仍是黑洞');

  clock.set(1000);
  // 到点即过期：陈旧结论自动失效，避免瞬时抖动被固化成整轮误判
  assert.equal(blacklist.isBlack('1.1.1.1'), false);
  assert.deepEqual(blacklist.filter(['1.1.1.1']), ['1.1.1.1']);
  assert.deepEqual(blacklist.expiredIps(), ['1.1.1.1']);

  // 条目不能被自动删除：面板要能看到「曾经判黑、但结论已过期」
  assert.deepEqual(blacklist.entries().map((entry) => entry.ip), ['1.1.1.1']);
  assert.deepEqual(blacklist.stats(), { ok: 0, black: 1, total: 1 });
});

test('expiredIps 支持显式时间参数、排序且只含已过期条目', () => {
  const clock = createClock(0);
  const blacklist = createBlacklist({ ttlMs: 1000, now: clock.now });
  blacklist.markBlack('9.9.9.9', 'timeout');
  clock.advance(400);
  blacklist.markBlack('1.1.1.1', 'timeout'); // 到 1400 才过期

  // 显式传 now：900 时还没到期
  assert.deepEqual(blacklist.expiredIps(900), []);
  // 1200 时只有 9.9.9.9 到期
  assert.deepEqual(blacklist.expiredIps(1200), ['9.9.9.9']);
  // 默认取注入时钟：1400 时两个都到期，且按 IP 字符串排序
  clock.set(1400);
  assert.deepEqual(blacklist.expiredIps(), ['1.1.1.1', '9.9.9.9']);
});

test('rebuild 刷新所有条目的 at 与 expiresAt', () => {
  const clock = createClock(0);
  const blacklist = createBlacklist({ ttlMs: 1000, now: clock.now });
  blacklist.markBlack('1.1.1.1', 'timeout');

  clock.advance(500);
  blacklist.rebuild([
    { ip: '1.1.1.1', ok: false, ms: null, error: 'timeout' },
    { ip: '2.2.2.2', ok: true, ms: 10, error: null },
  ]);

  for (const entry of blacklist.entries()) {
    assert.equal(entry.at, 500);
    assert.equal(entry.expiresAt, 1500);
  }
  // 重建后旧结论被刷新：900 时还没到期
  clock.set(900);
  assert.equal(blacklist.isBlack('1.1.1.1'), true);
});

test('过期后重新 markBlack 会恢复黑洞状态', () => {
  const clock = createClock(0);
  const blacklist = createBlacklist({ ttlMs: 1000, now: clock.now });
  blacklist.markBlack('1.1.1.1', 'timeout');

  clock.set(2000);
  assert.equal(blacklist.isBlack('1.1.1.1'), false);

  blacklist.markBlack('1.1.1.1', 'timeout');
  assert.equal(blacklist.isBlack('1.1.1.1'), true);
  assert.equal(blacklist.expiredIps().length, 0);
});

test('非法 TTL 回退默认值；ttlMs=0 表示结论立即过期', () => {
  for (const ttlMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3000']) {
    const blacklist = createBlacklist({ ttlMs });
    blacklist.markBlack('1.1.1.1', 'timeout');
    const [entry] = blacklist.entries();
    assert.equal(entry.expiresAt - entry.at, DEFAULT_TTL_MS);
  }

  const clock = createClock(500);
  const instant = createBlacklist({ ttlMs: 0, now: clock.now });
  instant.markBlack('1.1.1.1', 'timeout');
  // 0 TTL：写入瞬间即过期（用于测试与极端场景）
  assert.equal(instant.isBlack('1.1.1.1'), false);
  assert.deepEqual(instant.expiredIps(), ['1.1.1.1']);
});

test('注入的坏时钟会退回真实时间，不抛错', () => {
  const blacklist = createBlacklist({
    now() {
      throw new Error('坏时钟');
    },
  });
  assert.doesNotThrow(() => blacklist.markBlack('1.1.1.1', 'timeout'));
  // 退回真实时间后 TTL 未到期
  assert.equal(blacklist.isBlack('1.1.1.1'), true);
});
