/**
 * blacklist.js 单元测试：条目记录、过滤自锁保护、重建语义、快照稳定性。
 * 纯内存无 IO，所以断言可以做到完全确定（不涉及网络、不涉及时钟推进）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlacklist } from '../src/blacklist.js';

test('初始状态为空', () => {
  const blacklist = createBlacklist();
  assert.equal(blacklist.isBlack('1.1.1.1'), false);
  assert.deepEqual(blacklist.entries(), []);
  assert.deepEqual(blacklist.stats(), { ok: 0, black: 0, total: 0 });
});

test('markBlack 后 isBlack 为真，并记录原因与时间戳', () => {
  const blacklist = createBlacklist();
  const before = Date.now();
  blacklist.markBlack('172.65.90.20', 'timeout');

  assert.equal(blacklist.isBlack('172.65.90.20'), true);
  const [entry] = blacklist.entries();
  assert.equal(entry.ip, '172.65.90.20');
  assert.equal(entry.state, 'black');
  assert.equal(entry.ms, null);
  assert.equal(entry.error, 'timeout');
  assert.ok(entry.at >= before && entry.at <= Date.now(), 'at 应是毫秒时间戳');
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

test('重复标记会刷新状态与 at 时间', () => {
  const blacklist = createBlacklist();
  blacklist.markBlack('1.1.1.1', 'timeout');
  const firstAt = blacklist.entries()[0].at;
  blacklist.markOk('1.1.1.1', 55);

  const [entry] = blacklist.entries();
  assert.equal(entry.state, 'ok');
  assert.equal(entry.ms, 55);
  assert.equal(entry.error, null);
  assert.ok(entry.at >= firstAt);
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
