/**
 * 编排器：代理检测 → dispatcher 安装 → 异步探测 → 状态维护 → 失败重试。
 *
 * 为什么本模块所有对外方法都吞异常：
 * 它跑在 DSH 主进程的启动路径和请求路径上，任何向上抛出的异常都可能拖垮宿主；
 * 最坏情况下插件应该表现得像「不存在」（不过滤），而不是让 DSH 起不来（边界 9）。
 */

import { createBlacklist as defaultCreateBlacklist } from './blacklist.js';
import { buildStatus as defaultBuildStatus } from './status.js';

/**
 * 配置默认值。createGuard 还会再合并一次（不信任上游一定合并好了）：
 * 配置写错导致插件静默失效，比用默认值继续工作更糟。
 */
const DEFAULT_CONFIG = Object.freeze({
  hostname: 'opencode.ai',
  // D7/D19：与 DSH 的 connect timeout 口径一致，10 秒还连不上就没有意义
  probeTimeoutMs: 10000,
  enabled: true,
  forceIps: [],
  // D9：第一次失败 1 分钟后重探；仍失败 2 分钟后再探；第三次失败放弃
  retryDelaysMs: [60000, 120000],
  // 黑名单软 TTL：探测是瞬时快照，IP 可达性会分钟级波动，5 分钟后旧结论自动失效（放行）
  // 注意：该默认值必须与 index.js 的 DEFAULTS 保持一致（以 index.js 传入值为准）
  blacklistTtlMs: 300000,
  // 失败二次确认等待：2 秒足以过滤瞬态抖动，又不至于把探测轮次拖太久
  confirmDelayMs: 2000,
  // 过期检查节拍：每 30 秒扫一次；只有真的出现过期黑洞条目时才补探（不是周期探测）
  expiryCheckIntervalMs: 30000,
});

/**
 * 需要检查的代理环境变量，大小写都查（D11）。
 * 顺序即优先级：https 代理是 fetch 最常用的形态，先命中先返回。
 */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** NO_PROXY 的大小写两种写法。 */
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];

/** 日志前缀：DSH 日志里能一眼认出是本插件。 */
const LOG_PREFIX = '[opencode-ip-guard]';

/** IPv4 字面量形状；resolve4 理论上只回 IPv4，这里再做一次防御。 */
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * 状态快照组装失败时的兜底结构：状态路由必须永远有东西可返回。
 * @param {string} reason
 * @returns {object}
 */
function createFallbackSnapshot(reason) {
  return {
    state: 'error',
    enabled: false,
    reason: reason || '状态快照不可用',
    lastProbeAt: null,
    nextRetryAt: null,
    entries: [],
    stats: { ok: 0, black: 0, total: 0 },
  };
}

/**
 * 把任意异常转成可读文案（异常对象不一定有 message）。
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  try {
    return String(error);
  } catch {
    return '未知异常';
  }
}

/** 判断是否 IPv4 字面量。 */
function isIpv4Like(value) {
  return typeof value === 'string' && IPV4_PATTERN.test(value);
}

/**
 * 去重并保持原始顺序。
 * 保持顺序是为了让面板与探测日志里的 IP 顺序和 DNS 返回顺序一致，排查时更直观。
 * @param {unknown[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * 把代理环境变量值解析成 URL 对象。
 * 只接受 http:/https:：DSH 的 installProxyFromEnvironment 也只接管这两种，
 * 其他协议（socks 等）本来就不会被用作 fetch 代理，判为「未配置代理」才符合事实。
 * @param {unknown} raw
 * @returns {URL | null}
 */
function parseProxyUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * 取第一个非空环境变量值。
 * @param {Record<string, unknown>} environment
 * @param {string[]} keys
 * @returns {{ key: string, value: string } | null}
 */
function pickEnvValue(environment, keys) {
  for (const key of keys) {
    const value = environment[key];
    if (typeof value === 'string' && value.trim() !== '') return { key, value: value.trim() };
  }
  return null;
}

/**
 * 归一化 NO_PROXY 里的单个条目：去空白、去端口、去通配前缀。
 * 为什么手写而不是用 URL：NO_PROXY 不是 URL，写法非常自由（.a.com / *.a.com / a.com:443）。
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeNoProxyEntry(raw) {
  if (typeof raw !== 'string') return '';
  let entry = raw.trim().toLowerCase();
  if (entry === '') return '';
  if (entry === '*') return '*';
  // [::1]:443 → ::1；IPv6 本身含冒号，不能无脑按冒号切
  entry = entry.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1');
  const colonCount = entry.split(':').length - 1;
  if (colonCount === 1) entry = entry.slice(0, entry.indexOf(':'));
  // "*.opencode.ai" / ".opencode.ai" 都按后缀处理
  entry = entry.replace(/^\*?\./, '');
  return entry;
}

/**
 * 判断目标域名是否被 NO_PROXY 完全绕过。
 * 为什么需要它：用户可能「配了代理但把 opencode.ai 排除」，
 * 这时流量并不走代理，插件装 dispatcher 不会破坏代理，仍应正常生效（D11 只针对被代理接管的流量）。
 * 注意：NO_PROXY='localhost,127.0.0.1' 这类常见 loopback 条目并不覆盖 opencode.ai，
 * 所以仍然算「有代理」，插件必须禁用——这是最容易写错的地方。
 * @param {unknown} noProxyValue
 * @param {string} hostname
 * @returns {boolean}
 */
function noProxyCoversHost(noProxyValue, hostname) {
  if (typeof noProxyValue !== 'string' || noProxyValue.trim() === '') return false;
  const host = String(hostname || '').trim().toLowerCase();
  if (host === '') return false;
  for (const raw of noProxyValue.split(/[,\s]+/)) {
    const entry = normalizeNoProxyEntry(raw);
    if (entry === '') continue;
    if (entry === '*') return true; // NO_PROXY='*'：全部绕过
    if (entry === host) return true;
    if (host.endsWith('.' + entry)) return true; // 后缀匹配，覆盖子域
  }
  return false;
}

/**
 * 检测代理配置（D11）。
 * 导出它是为了让单测能做表驱动验证，生产路径由 start() 调用。
 * @param {Record<string, unknown>} [env] 环境变量表，默认 process.env
 * @param {string} [hostname] 目标域名，默认 opencode.ai
 * @returns {{ hasProxy: boolean, proxyUrl: string | null, envVar: string | null, reason: string | null }}
 */
export function detectProxy(env = process.env, hostname = DEFAULT_CONFIG.hostname) {
  const environment = env && typeof env === 'object' ? env : {};
  const noProxy = pickEnvValue(environment, NO_PROXY_ENV_KEYS);
  const bypassed = noProxy === null ? false : noProxyCoversHost(noProxy.value, hostname);

  for (const key of PROXY_ENV_KEYS) {
    const parsed = parseProxyUrl(environment[key]);
    if (parsed === null) continue;
    if (bypassed) {
      return {
        hasProxy: false,
        proxyUrl: parsed.href,
        envVar: key,
        reason: '检测到代理 ' + key + '，但 NO_PROXY 已覆盖 ' + hostname + '，插件照常工作',
      };
    }
    return {
      hasProxy: true,
      proxyUrl: parsed.href,
      envVar: key,
      reason: '检测到代理配置 ' + key + '，插件已禁用（避免覆盖 DSH 安装的代理 dispatcher）',
    };
  }
  return { hasProxy: false, proxyUrl: null, envVar: null, reason: null };
}

/**
 * 合并配置：缺省/非法字段一律回退默认值。
 * 为什么不做严格校验报错：配置是用户手写的，写错一个字段就让整个插件失效不可接受。
 * @param {any} raw
 * @returns {{ hostname: string, probeTimeoutMs: number, enabled: boolean, forceIps: string[], retryDelaysMs: number[] }}
 */
function mergeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const retryDelaysMs = Array.isArray(source.retryDelaysMs)
    ? source.retryDelaysMs
        .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        .map((value) => Math.round(value))
    : [];
  return {
    hostname:
      typeof source.hostname === 'string' && source.hostname.trim() !== ''
        ? source.hostname.trim()
        : DEFAULT_CONFIG.hostname,
    probeTimeoutMs:
      typeof source.probeTimeoutMs === 'number' && Number.isFinite(source.probeTimeoutMs) && source.probeTimeoutMs > 0
        ? source.probeTimeoutMs
        : DEFAULT_CONFIG.probeTimeoutMs,
    // 只有显式 false 才算关闭；其他脏值按启用处理，避免「配置写错=插件静默消失」
    enabled: source.enabled !== false,
    forceIps: Array.isArray(source.forceIps) ? uniqueStrings(source.forceIps) : [],
    retryDelaysMs: retryDelaysMs.length > 0 ? retryDelaysMs : DEFAULT_CONFIG.retryDelaysMs,
    // 软 TTL 允许 0（结论立即过期，供测试/极端场景），非法值回退默认
    blacklistTtlMs:
      typeof source.blacklistTtlMs === 'number' &&
      Number.isFinite(source.blacklistTtlMs) &&
      source.blacklistTtlMs >= 0
        ? Math.round(source.blacklistTtlMs)
        : DEFAULT_CONFIG.blacklistTtlMs,
    // 二次确认等待允许 0（立即复探），非法值回退默认
    confirmDelayMs:
      typeof source.confirmDelayMs === 'number' &&
      Number.isFinite(source.confirmDelayMs) &&
      source.confirmDelayMs >= 0
        ? Math.round(source.confirmDelayMs)
        : DEFAULT_CONFIG.confirmDelayMs,
    // 节拍必须为正数，0/负数等价于关闭节拍器，按非法值回退默认更安全
    expiryCheckIntervalMs:
      typeof source.expiryCheckIntervalMs === 'number' &&
      Number.isFinite(source.expiryCheckIntervalMs) &&
      source.expiryCheckIntervalMs > 0
        ? Math.round(source.expiryCheckIntervalMs)
        : DEFAULT_CONFIG.expiryCheckIntervalMs,
  };
}

/**
 * 创建编排器。
 * @param {{
 *   config?: object,
 *   log?: (line: string) => void,
 *   deps?: {
 *     createLookup?: Function,
 *     installDispatcher?: Function,
 *     probeAll?: Function,
 *     createBlacklist?: Function,
 *     buildStatus?: Function,
 *     resolve4?: Function,
 *     setTimeout?: Function,
 *     clearTimeout?: Function,
 *     setInterval?: Function,
 *     clearInterval?: Function,
 *     delay?: (ms: number) => Promise<void>,
 *     env?: Record<string, unknown>,
 *   },
 * }} [opts]
 * @returns {{
 *   start: () => Promise<void>,
 *   refresh: () => Promise<object>,
 *   snapshot: () => object,
 *   dispose: () => void,
 * }}
 */
export function createGuard(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const config = mergeConfig(options.config);
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};

  /**
   * 日志入口：日志函数自己抛错也不能影响主流程。
   * @param {string} line
   */
  function safeLog(line) {
    if (typeof options.log !== 'function') return;
    try {
      options.log(line);
    } catch {
      // 日志失败没有补救手段，也绝不能因此中断状态机
    }
  }

  // ---- 依赖装配：能用注入的就用注入的，否则回落到真实实现 ----
  const createBlacklistFactory =
    typeof deps.createBlacklist === 'function' ? deps.createBlacklist : defaultCreateBlacklist;
  const buildStatus =
    typeof deps.buildStatus === 'function' ? deps.buildStatus : defaultBuildStatus;

  // 黑名单的软 TTL 由配置决定：guard 是唯一知道「结论保鲜期」语义的地方
  const blacklistOptions = { ttlMs: config.blacklistTtlMs };
  let blacklist;
  try {
    blacklist = createBlacklistFactory(blacklistOptions);
  } catch (error) {
    safeLog(LOG_PREFIX + ' 创建黑名单失败，回落到默认实现：' + describeError(error));
    blacklist = defaultCreateBlacklist(blacklistOptions);
  }

  // 假定时器注入点：单测要验证 60s/120s 重试阶梯，不能真的等下去
  const scheduleTimeout = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
  const cancelTimeout = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
  // 周期定时器注入点（过期检查节拍）
  const scheduleInterval = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
  const cancelInterval = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval;
  // 二次确认等待注入点：单测里绝不能真的等 2 秒
  const wait = typeof deps.delay === 'function' ? deps.delay : defaultDelay;

  /**
   * 默认的确认等待实现；unref 是为了即便宿主提前退出也不会被这个 2 秒定时器挂住。
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function defaultDelay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  // ---- 内部状态（全部只在本闭包内可见） ----
  /** @type {string} 当前状态，取值见契约 5 */
  let state = 'idle';
  /** @type {string | null} 当前状态的解释文案 */
  let reason = null;
  /** @type {number | null} 上次探测完成时间（D18 面板用） */
  let lastProbeAt = null;
  /** @type {number | null} 降级状态下计划重试的时间 */
  let nextRetryAt = null;
  /** @type {number} 连续失败次数，用来索引重试阶梯（D9） */
  let retryCount = 0;
  /** @type {boolean} 探测互斥标记，防止重试定时器与面板刷新撞车 */
  let probeInFlight = false;
  /** @type {boolean} start 是否已执行过（幂等保护） */
  let started = false;
  /** @type {boolean} dispose 是否已执行过（幂等保护） */
  let disposed = false;
  /** @type {null | (() => void)} dispatcher 恢复句柄 */
  let restoreDispatcher = null;
  /** @type {any} 重试定时器句柄 */
  let retryTimer = null;
  /** @type {any} 过期检查节拍器句柄 */
  let expiryTimer = null;

  /**
   * 计算快照里的 enabled 字段。
   * 语义：配置启用且没有被「代理检测」自动禁用。
   * 运行期健康度由 state 表达（degraded/failed/error），不在这里重复扣减，
   * 否则面板会把「暂时降级、马上会重试」误显示成「插件被关掉了」。
   * @returns {boolean}
   */
  function computeEnabled() {
    if (!config.enabled) return false;
    if (state === 'disabled_by_proxy') return false;
    return true;
  }

  /**
   * 安全地读取黑名单快照；注入实现异常时退化为空列表。
   * @returns {Array<object>}
   */
  function safeEntries() {
    try {
      return typeof blacklist.entries === 'function' ? blacklist.entries() : [];
    } catch (error) {
      safeLog(LOG_PREFIX + ' 读取黑名单快照失败：' + describeError(error));
      return [];
    }
  }

  /**
   * 组装当前状态快照；任何异常都降级为 error 快照，路由永远有响应。
   * @returns {object}
   */
  function snapshot() {
    try {
      return buildStatus({
        state,
        enabled: computeEnabled(),
        reason,
        lastProbeAt,
        entries: safeEntries(),
        nextRetryAt,
      });
    } catch (error) {
      safeLog(LOG_PREFIX + ' 组装状态快照失败：' + describeError(error));
      return createFallbackSnapshot('状态快照组装失败：' + describeError(error));
    }
  }

  /**
   * 解析异步依赖：优先用注入的，其次动态 import。
   * 为什么动态 import：单测要替换这些模块；同时 A 的模块缺失时不能把 guard 一起拖死，
   * 缺依赖只会让本次能力降级，由调用方决定状态。
   * @param {string} depName
   * @param {string} modulePath
   * @param {string} exportName
   * @returns {Promise<Function | null>}
   */
  async function resolveDependency(depName, modulePath, exportName) {
    const injected = deps[depName];
    if (typeof injected === 'function') return injected;
    try {
      const module = await import(modulePath);
      const fn = module ? module[exportName] : undefined;
      if (typeof fn === 'function') return fn;
      safeLog(LOG_PREFIX + ' 模块 ' + modulePath + ' 缺少导出 ' + exportName);
      return null;
    } catch (error) {
      safeLog(LOG_PREFIX + ' 加载模块 ' + modulePath + ' 失败：' + describeError(error));
      return null;
    }
  }

  /**
   * 解析本次探测要用的 IP 列表。
   * forceIps 是验收用的测试钩子：非空时完全绕开真实 DNS，保证阴性对照可控。
   * @returns {Promise<string[]>}
   */
  async function resolveTargets() {
    if (config.forceIps.length > 0) return [...config.forceIps];
    const resolve4 = await resolveDependency('resolve4', 'node:dns/promises', 'resolve4');
    if (typeof resolve4 !== 'function') throw new Error('无法加载 DNS 解析器');
    const resolved = await resolve4(config.hostname);
    if (!Array.isArray(resolved)) return [];
    // 只保留 IPv4 字面量：插件从设计上就不碰 IPv6（决策：禁 IPv6）
    return uniqueStrings(resolved.filter(isIpv4Like));
  }

  /**
   * 取本次失败对应的重试延迟；阶梯用完返回 null 表示放弃（D9）。
   * @returns {number | null}
   */
  function nextRetryDelay() {
    if (retryCount < 1 || retryCount > config.retryDelaysMs.length) return null;
    return config.retryDelaysMs[retryCount - 1];
  }

  /**
   * 清理重试定时器并清空下次重试时间。
   * @returns {void}
   */
  function clearRetryTimer() {
    if (retryTimer !== null) {
      try {
        cancelTimeout(retryTimer);
      } catch (error) {
        safeLog(LOG_PREFIX + ' 清理重试定时器失败：' + describeError(error));
      }
    }
    retryTimer = null;
    nextRetryAt = null;
  }

  /**
   * 安排一次延迟重试。
   * 定时器必须 unref()：否则一个等待 60 秒的定时器会拖住宿主进程退出。
   * @param {number} delayMs
   * @returns {void}
   */
  function scheduleRetry(delayMs) {
    clearRetryTimer();
    const scheduled = Date.now() + delayMs;
    nextRetryAt = scheduled;
    try {
      retryTimer = scheduleTimeout(() => {
        retryTimer = null;
        nextRetryAt = null;
        if (disposed) return;
        kickProbe('重试');
      }, delayMs);
      if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
    } catch (error) {
      retryTimer = null;
      nextRetryAt = null;
      safeLog(LOG_PREFIX + ' 安排重试失败：' + describeError(error));
    }
  }

  /**
   * 启动过期检查节拍器（unref，避免拖住宿主退出）。
   * 为什么用 setInterval 而不是递归 setTimeout：节拍固定、实现简单；
   * 真正的「探测」仍然只在发现过期黑洞条目时才发生，所以它不是周期性探测。
   * @returns {void}
   */
  function startExpiryWatcher() {
    if (expiryTimer !== null) return;
    if (!(config.expiryCheckIntervalMs > 0)) return;
    try {
      expiryTimer = scheduleInterval(() => {
        onExpiryTick();
      }, config.expiryCheckIntervalMs);
      if (expiryTimer && typeof expiryTimer.unref === 'function') expiryTimer.unref();
    } catch (error) {
      expiryTimer = null;
      safeLog(LOG_PREFIX + ' 启动过期检查定时器失败：' + describeError(error));
    }
  }

  /**
   * 停止过期检查节拍器。dispose 必须调用它，否则插件卸载后还会继续触发探测。
   * @returns {void}
   */
  function stopExpiryWatcher() {
    if (expiryTimer !== null) {
      try {
        cancelInterval(expiryTimer);
      } catch (error) {
        safeLog(LOG_PREFIX + ' 清理过期检查定时器失败：' + describeError(error));
      }
    }
    expiryTimer = null;
  }

  /**
   * 找出「TTL 已过期且仍标记为黑洞」的条目 IP。
   * 为什么要先取 expiredIps 再回查 entries：expiredIps 返回的是所有过期条目（含 ok），
   * 而只有黑洞条目过期才意味着「过滤结论需要重新验证」。
   * @param {number} now
   * @returns {string[]}
   */
  function collectExpiredBlackIps(now) {
    try {
      const expired = typeof blacklist.expiredIps === 'function' ? blacklist.expiredIps(now) : [];
      if (!Array.isArray(expired) || expired.length === 0) return [];
      const expiredSet = new Set(expired);
      return safeEntries()
        .filter((entry) => entry && entry.state === 'black' && expiredSet.has(entry.ip))
        .map((entry) => entry.ip);
    } catch (error) {
      safeLog(LOG_PREFIX + ' 检查过期条目失败：' + describeError(error));
      return [];
    }
  }

  /**
   * 过期检查节拍回调：只有真的存在过期黑洞条目时才补探一次。
   * 为什么排除 ok 条目：ok 过期不影响过滤，若也算触发条件就会变成每 TTL 一次的周期探测，
   * 违背用户「不打扰远端」的原则（D5）；同时用 probeInFlight 去重，探测进行中就等下一拍。
   * @returns {void}
   */
  function onExpiryTick() {
    try {
      if (disposed || !config.enabled) return;
      if (state === 'disabled_by_proxy') return;
      if (probeInFlight) return;
      const expiredBlackIps = collectExpiredBlackIps(Date.now());
      if (expiredBlackIps.length === 0) return;
      safeLog(
        LOG_PREFIX +
          ' 检测到 ' +
          expiredBlackIps.length +
          ' 个黑洞条目 TTL 到期（' +
          expiredBlackIps.join(', ') +
          '），触发补探',
      );
      kickProbe('过期补探');
    } catch (error) {
      safeLog(LOG_PREFIX + ' 过期检查回调异常：' + describeError(error));
    }
  }

  /**
   * 对首轮探测失败的 IP 做一次延迟复探（二次确认）。
   * 为什么需要：单次 TLS 探测很容易受瞬态抖动影响（实测同一 IP 上午黑洞、下午可用），
   * 一次失败就永久拉黑会把抖动固化成误判；隔一会儿再确认一次能显著降低误判率。
   * 规则：第二次成功 → 按可用记录（ms 取第二次耗时）；两次都失败 → 保留黑洞（error 取第二次）。
   * @param {Array<{ ip: string, ok: boolean }>} results 首轮结果
   * @param {Function} probeAll 已解析好的批量探测函数
   * @returns {Promise<Array<{ ip: string, ok: boolean }>>}
   */
  async function confirmFailedTargets(results, probeAll) {
    const failedIps = uniqueStrings(
      results.filter((item) => item && item.ok !== true).map((item) => item.ip),
    );
    if (failedIps.length === 0) return results;

    const delayMs = config.confirmDelayMs;
    if (delayMs > 0) {
      try {
        await wait(delayMs);
      } catch (error) {
        // 等待失败不是 IP 的问题：保留首轮结论，让状态机按既有路径走
        safeLog(LOG_PREFIX + ' 二次确认等待失败，按首轮结果处理：' + describeError(error));
        return results;
      }
    }
    if (disposed) return results;

    let second = [];
    try {
      const probed = await probeAll(failedIps, {
        servername: config.hostname,
        timeoutMs: config.probeTimeoutMs,
      });
      second = Array.isArray(probed)
        ? probed.filter((item) => item && typeof item.ip === 'string' && item.ip !== '')
        : [];
    } catch (error) {
      // 复探异常不等于 IP 有问题：保留首轮结论，避免把「我们探测失败」当成「对方是黑洞」
      safeLog(LOG_PREFIX + ' 二次确认探测异常，按首轮结果处理：' + describeError(error));
      return results;
    }
    if (second.length === 0) return results;

    const secondByIp = new Map(second.map((item) => [item.ip, item]));
    let recovered = 0;
    const merged = results.map((item) => {
      if (!item || item.ok === true) return item;
      const retry = secondByIp.get(item.ip);
      if (!retry) return item;
      if (retry.ok === true) recovered += 1;
      return retry;
    });
    safeLog(
      LOG_PREFIX +
        ' 二次确认：' +
        failedIps.length +
        ' 个失败 IP 复探，' +
        recovered +
        ' 个恢复可用',
    );
    return merged;
  }

  /**
   * 根据一轮探测结果更新状态机。
   * 全失败时黑名单必须清空（不过滤）：否则一个短暂网络故障就可能把 DSH 锁死（边界 1/8）。
   * @param {Array<{ ip: string, ok: boolean }>} results
   * @param {string | null} failureDetail
   * @param {string} trigger
   * @returns {boolean} 本轮是否有可用 IP
   */
  function applyProbeOutcome(results, failureDetail, trigger) {
    const detail = failureDetail ? '（' + failureDetail + '）' : '';
    try {
      const okCount = results.filter((item) => item && item.ok === true).length;
      if (okCount > 0) {
        blacklist.rebuild(results);
        retryCount = 0;
        clearRetryTimer();
        state = 'ready';
        reason = null;
        safeLog(
          LOG_PREFIX +
            ' ' +
            trigger +
            '探测完成：' +
            okCount +
            ' 个可用 / ' +
            (results.length - okCount) +
            ' 个黑洞',
        );
        return true;
      }

      blacklist.clear();
      retryCount += 1;
      const delay = nextRetryDelay();
      if (delay === null) {
        state = 'failed';
        reason = '连续 ' + retryCount + ' 次探测全部失败' + detail + '，已停止自动重试';
        clearRetryTimer();
        safeLog(LOG_PREFIX + ' ' + reason);
        return false;
      }

      state = 'degraded';
      reason =
        '第 ' +
        retryCount +
        ' 次探测全部失败' +
        detail +
        '，暂不过滤，' +
        Math.round(delay / 1000) +
        ' 秒后重试';
      scheduleRetry(delay);
      safeLog(LOG_PREFIX + ' ' + reason);
      return false;
    } catch (error) {
      state = 'error';
      reason = '更新黑名单状态失败：' + describeError(error);
      safeLog(LOG_PREFIX + ' ' + reason);
      return false;
    }
  }

  /**
   * 执行一轮探测（互斥）。
   * 内部所有异常都转成「探测失败」，绝不向外抛。
   * @param {string} trigger 触发来源，仅用于日志
   * @returns {Promise<boolean>} 本轮是否成功
   */
  async function probeOnce(trigger) {
    if (disposed) return false;
    if (probeInFlight) {
      safeLog(LOG_PREFIX + ' 已有探测在进行，忽略本次触发（' + trigger + '）');
      return false;
    }
    probeInFlight = true;
    state = 'probing';
    reason = null;
    clearRetryTimer();
    let results = [];
    let failureDetail = null;
    try {
      try {
        const targets = await resolveTargets();
        if (targets.length === 0) {
          failureDetail = 'DNS 未返回可用 IPv4 地址';
        } else {
          const probeAll = await resolveDependency('probeAll', './probe.js', 'probeAll');
          if (typeof probeAll !== 'function') {
            failureDetail = 'probe 模块不可用';
          } else {
            const probed = await probeAll(targets, {
              servername: config.hostname,
              timeoutMs: config.probeTimeoutMs,
            });
            results = Array.isArray(probed)
              ? probed.filter((item) => item && typeof item.ip === 'string' && item.ip !== '')
              : [];
            if (results.length === 0) {
              failureDetail = '探测未返回任何结果';
            } else {
              // 失败 IP 隔 confirmDelayMs 再确认一次：单次抖动不能直接算黑洞
              results = await confirmFailedTargets(results, probeAll);
            }
          }
        }
      } catch (error) {
        // 探测链路异常=本轮探测失败，后面走降级/重试逻辑，不向宿主抛
        failureDetail = '探测链路异常：' + describeError(error);
      }

      if (disposed) return false;
      lastProbeAt = Date.now();
      return applyProbeOutcome(results, failureDetail, trigger);
    } finally {
      probeInFlight = false;
    }
  }

  /**
   * 触发一次探测但不等待结果（D8：探测不能阻塞 DSH 启动）。
   * 再兜一层 catch：绝不产生 unhandledRejection 把宿主进程带走。
   * @param {string} trigger
   * @returns {void}
   */
  function kickProbe(trigger) {
    probeOnce(trigger).catch((error) => {
      safeLog(LOG_PREFIX + ' 探测流程出现未捕获异常：' + describeError(error));
    });
  }

  /**
   * 启动流程。幂等：重复调用直接忽略，避免重复安装 dispatcher。
   * @returns {Promise<void>}
   */
  async function start() {
    if (disposed) {
      safeLog(LOG_PREFIX + ' 已释放，忽略 start');
      return;
    }
    if (started) {
      safeLog(LOG_PREFIX + ' start 重复调用，忽略');
      return;
    }
    started = true;
    try {
      // 0) 总开关关闭：什么都不装，也不探测
      if (!config.enabled) {
        state = 'idle';
        reason = '插件已在配置中关闭';
        safeLog(LOG_PREFIX + ' ' + reason + '，不安装 dispatcher');
        return;
      }

      // 1) 代理检测：有代理就不能覆盖 DSH 已经装好的代理 dispatcher（D11）
      const env = deps.env && typeof deps.env === 'object' ? deps.env : process.env;
      const proxy = detectProxy(env, config.hostname);
      if (proxy.hasProxy) {
        state = 'disabled_by_proxy';
        reason = proxy.reason;
        safeLog(LOG_PREFIX + ' ' + proxy.reason);
        return;
      }
      if (proxy.reason) safeLog(LOG_PREFIX + ' ' + proxy.reason);

      // 2) 安装 dispatcher：先让过滤生效（此刻黑名单为空=不过滤），再异步探测
      const createLookup = await resolveDependency('createLookup', './lookup.js', 'createLookup');
      const installDispatcher = await resolveDependency(
        'installDispatcher',
        './dispatcher.js',
        'installDispatcher',
      );
      if (typeof createLookup !== 'function' || typeof installDispatcher !== 'function') {
        state = 'error';
        reason = 'lookup/dispatcher 模块不可用，插件未生效';
        safeLog(LOG_PREFIX + ' ' + reason);
        return;
      }

      let handle;
      try {
        const lookup = createLookup({
          hostnames: [config.hostname],
          blacklist,
          forceIps: config.forceIps,
        });
        handle = await installDispatcher({
          lookup,
          connectTimeoutMs: config.probeTimeoutMs,
        });
      } catch (error) {
        state = 'error';
        reason = '安装 undici dispatcher 失败：' + describeError(error);
        safeLog(LOG_PREFIX + ' ' + reason);
        return;
      }

      if (handle && typeof handle.restore === 'function') {
        restoreDispatcher = handle.restore;
      } else {
        safeLog(LOG_PREFIX + ' installDispatcher 未返回 restore()，释放时无法恢复原 dispatcher');
      }

      state = 'probing';
      reason = null;
      safeLog(LOG_PREFIX + ' 已安装 undici dispatcher，开始后台探测 ' + config.hostname);

      // 3) 过期检查节拍器：只在出现「过期黑洞条目」时才补探
      startExpiryWatcher();

      // 4) 探测异步执行，立即返回（D8）
      kickProbe('启动');
    } catch (error) {
      state = 'error';
      reason = '启动流程异常：' + describeError(error);
      safeLog(LOG_PREFIX + ' ' + reason);
    }
  }

  /**
   * 面板点击刷新：重探并重建黑名单（D16）。
   * 与自动重试的区别：手动刷新会把重试阶梯重置，因为用户主动给了「再试一次」的信号。
   * @returns {Promise<object>} 刷新后的状态快照
   */
  async function refresh() {
    try {
      if (disposed) {
        safeLog(LOG_PREFIX + ' 已释放，忽略刷新');
        return snapshot();
      }
      if (!started) {
        safeLog(LOG_PREFIX + ' 尚未 start，忽略刷新');
        return snapshot();
      }
      if (!config.enabled || state === 'disabled_by_proxy') {
        safeLog(LOG_PREFIX + ' 插件处于禁用状态，忽略刷新');
        return snapshot();
      }
      if (probeInFlight) {
        // 正在探测就把当前快照直接返回：重复探测既浪费 TLS 握手，也会让状态乱跳
        safeLog(LOG_PREFIX + ' 探测进行中，刷新请求合并到当前轮');
        return snapshot();
      }
      retryCount = 0;
      await probeOnce('手动刷新');
      return snapshot();
    } catch (error) {
      safeLog(LOG_PREFIX + ' 刷新流程异常：' + describeError(error));
      return snapshot();
    }
  }

  /**
   * 释放：清理定时器并恢复原 dispatcher。幂等。
   * @returns {void}
   */
  function dispose() {
    try {
      disposed = true;
      clearRetryTimer();
      stopExpiryWatcher();
      const restore = restoreDispatcher;
      restoreDispatcher = null;
      if (typeof restore === 'function') {
        try {
          restore();
        } catch (error) {
          safeLog(LOG_PREFIX + ' 恢复原 dispatcher 失败：' + describeError(error));
        }
      }
      safeLog(LOG_PREFIX + ' 已释放（定时器已清理，dispatcher 已尝试恢复）');
    } catch (error) {
      safeLog(LOG_PREFIX + ' 释放流程异常：' + describeError(error));
    }
  }

  return { start, refresh, snapshot, dispose };
}
