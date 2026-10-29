/**
 * acceptance.mjs —— 自动化验收脚本（不依赖 DSH 运行时，可直接用 node 跑）
 *
 * 为什么要有它：
 *   手动验收（抓包/开关对比/强制注入）难以在 CI 里复现，也容易自欺欺人。
 *   这里把「核心行为」抽成四条可在本机断言的检查，任何一条失败都说明插件没做到它承诺的事。
 *
 * 用法：
 *   & "<node>" test/acceptance.mjs
 *
 * 设计原则：
 *   - 真实网络相关检查在无网时自动跳过（skip），不阻断 CI；
 *   - 逻辑相关检查完全用注入的假数据，不依赖真实 DNS；
 *   - 只读：不修改任何系统设置。
 */

import { createBlacklist } from '../src/blacklist.js';
import { createLookup } from '../src/lookup.js';
import { probeAll } from '../src/probe.js';

const HOSTNAME = 'opencode.ai';
const PROBE_TIMEOUT_MS = 10000;

let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * 记录一条检查结果。
 * @param {string} name - 检查名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 附加说明。
 */
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  [PASS] ' + name + (detail ? ' — ' + detail : '')); }
  else { failed++; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
}

/**
 * 跳过一条检查（通常因为环境不具备，如无网络）。
 * @param {string} name - 检查名。
 * @param {string} why - 跳过原因。
 */
function skip(name, why) {
  skipped++; console.log('  [SKIP] ' + name + ' — ' + why);
}

/**
 * 调用 lookup 并把它回调式的结果包成 Promise。
 * @param {Function} lookup - 契约 3 的 lookup 函数。
 * @param {string} hostname - 要解析的域名。
 * @param {object} options - 传给 lookup 的选项（如 { all: true }）。
 * @returns {Promise<{address: string, family: number}>} 选中的地址。
 */
function callLookup(lookup, hostname, options) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (err, addressOrList, family) => {
      if (err) { reject(err); return; }
      if (Array.isArray(addressOrList)) resolve(addressOrList[0]);
      else resolve({ address: addressOrList, family });
    });
  });
}

async function main() {
  console.log('=== 验收 1：真实 TLS 探测能识别黑洞 IP ===');
  let realIps = [];
  try {
    const dns = await import('node:dns');
    realIps = await dns.promises.resolve4(HOSTNAME);
  } catch (error) {
    realIps = [];
  }
  if (realIps.length === 0) {
    skip('真实网络探测', 'DNS 解析失败（可能无网络）');
  } else {
    console.log('  解析到的 IP：' + realIps.join(', '));
    const results = await probeAll(realIps, { servername: HOSTNAME, timeoutMs: PROBE_TIMEOUT_MS });
    for (const r of results) {
      console.log('    ' + r.ip + ' -> ' + (r.ok ? 'ok ' + r.ms + 'ms' : 'black ' + r.error));
    }
    const okCount = results.filter(r => r.ok).length;
    check('至少一个 IP 可用', okCount >= 1, 'ok=' + okCount + '/' + results.length);
    const blackResults = results.filter(r => !r.ok);
    if (blackResults.length > 0) {
      check('黑洞 IP 的错误原因已归类', blackResults.every(r => typeof r.error === 'string' && r.error.length > 0));
    } else {
      skip('黑洞识别', '本轮所有 IP 都可用（黑洞可能暂时恢复）');
    }
  }

  console.log('=== 验收 2：lookup 会剔除黑名单 IP（注入式，不依赖真实网络）===');
  {
    const blacklist = createBlacklist();
    blacklist.markBlack('192.0.2.1', 'timeout');
    blacklist.markOk('192.0.2.2', 350);
    const lookup = createLookup({
      hostnames: [HOSTNAME],
      blacklist,
      resolve4: async () => ['192.0.2.1', '192.0.2.2'],   // 第一个是黑洞
    });
    const chosen = await callLookup(lookup, HOSTNAME, { all: false });
    check('返回的不是黑名单 IP', chosen.address === '192.0.2.2', '实际=' + chosen.address);
    check('返回 family=4（强制 IPv4）', chosen.family === 4, '实际=' + chosen.family);

    const chosenAll = await callLookup(lookup, HOSTNAME, { all: true });
    check('all 模式也返回过滤后的地址', chosenAll.address === '192.0.2.2', '实际=' + chosenAll.address);
  }

  console.log('=== 验收 3：全部被过滤时必须回退（绝不返回空，避免自锁）===');
  {
    const blacklist = createBlacklist();
    blacklist.markBlack('192.0.2.1', 'timeout');
    blacklist.markBlack('192.0.2.2', 'timeout');
    const lookup = createLookup({
      hostnames: [HOSTNAME],
      blacklist,
      resolve4: async () => ['192.0.2.1', '192.0.2.2']
    });
    const chosen = await callLookup(lookup, HOSTNAME, { all: false });
    check('全黑时回退原始列表而非报错', typeof chosen.address === 'string' && chosen.address.length > 0, '实际=' + chosen.address);
  }

  console.log('=== 验收 4：非目标域名必须原样交给系统解析器（不干扰其它网络）===');
  {
    let fallbackCalls = 0;
    const blacklist = createBlacklist();
    const lookup = createLookup({
      hostnames: [HOSTNAME],
      blacklist,
      resolve4: async () => { throw new Error('不应被调用'); },
      fallbackLookup: (hostname, options, cb) => { fallbackCalls++; cb(null, '203.0.113.9', 4); }
    });
    const chosen = await callLookup(lookup, 'example.com', { all: false });
    check('非目标域名走 fallback', fallbackCalls === 1 && chosen.address === '203.0.113.9', 'fallback 调用 ' + fallbackCalls + ' 次');
  }

  console.log('');
  console.log('=== 结果：通过 ' + passed + ' / 失败 ' + failed + ' / 跳过 ' + skipped + ' ===');
  if (failed > 0) {
    console.log('存在失败项，验收不通过。');
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
}

main().catch((error) => {
  console.error('验收脚本自身异常：', error);
  process.exitCode = 2;
});