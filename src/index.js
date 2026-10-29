/**
 * index.js —— dsh-opencode-ip-guard 的宿主半区「薄壳」
 *
 * 为什么要有这层壳（形态照抄本机已验证的 mac-tunnel 插件）：
 *   DSH 的插件加载器**按包名缓存**已加载模块，被缓存的就是本文件——改 src 下的源码、
 *   改 package.json 的 main、停用再启用，都不会让宿主侧重新读盘。
 *   实测唯一能让"新代码生效"的现成开关是：改 config 会让 apply 被重新调用。
 *   所以本壳每次 apply 都用带时间戳的查询串重新动态 import 真实实现（guard.js），
 *   于是「改 guard.js → 碰一下 profile 里的 config → 新代码立即生效」。
 *
 * 壳的职责边界：
 *   只做「动态加载 + 配置白名单 + 注册状态路由 + 生命周期登记 + 异常隔离」，
 *   不写任何探测/过滤业务（业务全在 guard.js 及其下游模块里）。
 *
 * 安全底线（本文件最重要的设计约束）：
 *   DSH 是用户正在用的宿主，插件只是锦上添花。所以本文件里的每一步失败都只 log、
 *   绝不向 cordis 抛异常——插件坏掉时用户应该"感觉不到防护"，而不是"DSH 打不开"。
 *
 * @module dsh-opencode-ip-guard
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

/** 必须与 package.json 的 name、cordis.patch.yml 里的 name 完全一致。 */
export const name = 'dsh-opencode-ip-guard';

/**
 * 刻意不硬依赖任何服务：webServer 走 ctx.inject 可选获取。
 * 少了 webServer，只是没有面板数据源，过滤本体照常工作。
 */
export const inject = [];

/**
 * 真实实现（guard.js）的位置。
 *
 * ① 首选：由本模块自身 URL 推导出同目录的 ./guard.js —— 插件装在哪个目录、哪台机器都自洽，
 *    源码里也不必出现本机绝对路径。
 * ② 回退：DSH 加载器若以非常规方式加载（import.meta.url 不是 file: URL），
 *    退回约定的安装位置。用户目录取自环境变量，同样不含硬编码用户名。
 */
const GUARD_PATH = (() => {
  try {
    const here = import.meta.url;
    if (typeof here === 'string' && here.startsWith('file:')) {
      return fileURLToPath(new URL('./guard.js', here));
    }
  } catch {
    // 落到回退分支
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return home === ''
    ? './guard.js'
    : home.replace(/\\/g, '/') + '/.dsh/plugins/dsh-opencode-ip-guard/src/guard.js';
})();

/** 状态查询路由；client.js 里的 STATUS_URL 必须与本值一致。 */
const STATUS_ROUTE = '/opencode-ip-guard/status';

/** 手动重探路由；client.js 里的 REFRESH_URL 必须与本值一致。 */
const REFRESH_ROUTE = '/opencode-ip-guard/refresh';

/**
 * 配置默认值。以 Object.freeze 冻结，防止下游误改这个共享对象
 * （一旦被改，后续 apply 的默认值就被污染，属于最难查的那类 bug）。
 *
 * - hostname：只防护这一个域名（决策 D14：不做通用 IP 优选）；
 * - probeTimeoutMs：单 IP TLS 握手超时；D3 定为 6~10 秒档，取 10 秒与 D7/D19 一致；
 * - enabled：总开关，false 时 guard 仍会起来但只读不做任何接管；
 * - forceIps：测试钩子（验收 3 阴性对照用），空数组表示走真实 DNS；
 * - retryDelaysMs：探测全失败后的重试间隔（决策 D9：1 分钟 → 2 分钟 → 放弃）；
 * - blacklistTtlMs：黑名单条目的软过期时间（用户决策 A）。IP 可达性会分钟级波动，
 *   单次探测必然有误判；给条目加 TTL，让误判最多存活这么久就自动放行；
 * - confirmDelayMs：探测失败的二次确认间隔（用户决策 B）。失败后隔这么久再试一次，
 *   连续两次失败才判黑洞，避免瞬时抖动被固化成"永久坏"；
 * - expiryCheckIntervalMs：guard 检查"是否有条目过期"的间隔。注意这不是周期性探测——
 *   只有确实存在过期条目时才会触发重探，符合"不打扰远端"的原则。
 */
const DEFAULTS = Object.freeze({
  hostname: 'opencode.ai',
  probeTimeoutMs: 10000,
  enabled: true,
  forceIps: Object.freeze([]),
  retryDelaysMs: Object.freeze([60000, 120000]),
  blacklistTtlMs: 300000,
  confirmDelayMs: 2000,
  expiryCheckIntervalMs: 30000,
});

/** 递增序号：同一毫秒内 apply 被重跑两次时，仍能拿到不同的模块 URL。 */
let reloadSeq = 0;

/**
 * 插件入口。
 *
 * ⚠️ 两条铁律（都是踩过的坑）：
 *   1) **不要 return 业务对象**。cordis 会把 apply 的返回值当 effect 校验
 *      （Fiber._execute → safeCollect）：async 函数的返回值是 Promise，
 *      解析出 guard 对象（既不是函数也不是 null）后会抛 TypeError: Invalid effect，
 *      导致整个插件启用失败。所以这里 await 完就 return void。
 *   2) **不要抛异常**。整段用 try/catch 包住，失败只 log。
 *
 * @param {object} ctx - Cordis 上下文（由加载器注入）。
 * @param {object} [rawConfig] - profile 里为本插件写的 config。
 * @returns {Promise<void>} 刻意不返回业务对象（原因见上）。
 */
export async function apply(ctx, rawConfig) {
  try {
    await mount(ctx, rawConfig);
  } catch (error) {
    // 走到这里说明连"降级"本身都失败了；依然不能让异常穿出去。
    logViaContext(ctx, '[opencode-ip-guard] apply 失败（插件已跳过，DSH 不受影响）：' + describeError(error));
  }
}

/**
 * 壳层专用日志出口：ctx.logger 可用时走它，否则退回 console，保证失败可见。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {string} text - 日志文本。
 * @returns {void}
 */
function logViaContext(ctx, text) {
  try {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger.warn === 'function') {
      logger.warn(text);
      return;
    }
  } catch {
    // 落到 console
  }
  try {
    console.warn(text);
  } catch {
    // 连 console 都不可用就彻底放弃（不能为了打日志把宿主搞挂）
  }
}

/**
 * 把错误压成一行可读文本（保留 stack 的前若干行，便于定位）。
 *
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 文本。
 */
function describeError(error) {
  if (error && typeof error.stack === 'string') return error.stack;
  return String(error);
}

/**
 * 挂载：加载实现 → 建 guard → 注册路由 → 登记清理 → 启动。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object|undefined} rawConfig - profile 里的 config。
 * @returns {Promise<void>} 无返回值；任何一步失败都只 log 后继续/退出。
 */
async function mount(ctx, rawConfig) {
  /** 统一日志出口：带前缀，方便用户在 DSH 日志里 grep。 */
  const log = (line) => {
    try {
      const logger = ctx && ctx.logger;
      if (logger && typeof logger.info === 'function') {
        logger.info(String(line));
        return;
      }
    } catch {
      // 落到 console
    }
    try {
      console.log(String(line));
    } catch {
      // 忽略
    }
  };

  const config = normalizeConfig(rawConfig, log);

  // ── 动态加载真实实现 ──
  // 用带时间戳的查询串规避「加载器按模块键缓存」：否则改了 guard.js 也读不到新代码。
  const href = pathToFileURL(GUARD_PATH).href + '?v=' + Date.now() + '-' + (++reloadSeq);
  let impl;
  try {
    impl = await import(href);
  } catch (error) {
    log('[opencode-ip-guard] guard.js 加载失败，插件本次不生效（DSH 不受影响）：' + describeError(error));
    return;
  }

  if (typeof impl.createGuard !== 'function') {
    log('[opencode-ip-guard] guard.js 未导出 createGuard（拿到的是 ' + typeof impl.createGuard + '），插件本次不生效');
    return;
  }

  // ── 创建编排器 ──
  let guard;
  try {
    guard = impl.createGuard({ config, log });
  } catch (error) {
    log('[opencode-ip-guard] createGuard 抛错，插件本次不生效：' + describeError(error));
    return;
  }
  if (!guard || typeof guard.start !== 'function' || typeof guard.snapshot !== 'function') {
    log('[opencode-ip-guard] createGuard 返回的对象缺少 start/snapshot，插件本次不生效');
    return;
  }

  // 调试/验收用出口：挂到 globalThis，便于外部脚本直接读状态，不必经 HTTP。
  try {
    globalThis.__opencodeIpGuard = guard;
  } catch {
    // globalThis 不可写时忽略（不影响插件本体）
  }

  // 先注册路由再 start：面板最早一次轮询能拿到 idle 快照，而不是 404。
  registerRoutes(ctx, guard, log);

  // ── 清理登记：dispose 时停定时器 + 还原 dispatcher ──
  // 必须自己清理：guard 持有 undici 全局 dispatcher 与重试定时器，
  // 不还原会让 DSH 在插件卸载后继续走我们的 lookup（已卸载代码仍被引用）。
  try {
    ctx.on('dispose', () => {
      try {
        if (typeof guard.dispose === 'function') guard.dispose();
      } catch (error) {
        log('[opencode-ip-guard] dispose 清理异常（忽略）：' + describeError(error));
      }
    });
  } catch (error) {
    log('[opencode-ip-guard] 登记 dispose 失败（插件仍可工作，但卸载时可能残留 dispatcher）：' + describeError(error));
  }

  // ── 启动（内部异步探测，不阻塞启动流程，决策 D8）──
  try {
    await guard.start();
  } catch (error) {
    // 启动失败不是致命错误：guard 内部会把 state 置 degraded/failed 供面板展示。
    log('[opencode-ip-guard] guard.start 异常（插件继续挂着，状态将显示降级）：' + describeError(error));
  }

  log(
    '[opencode-ip-guard] 已挂载：hostname=' + config.hostname
    + '｜enabled=' + config.enabled
    + '｜probeTimeoutMs=' + config.probeTimeoutMs
    + '｜forceIps=' + (config.forceIps.length ? config.forceIps.join(',') : '（无）'),
  );
}

/**
 * 注册面板所需的两条 HTTP 路由。
 *
 * webServer 不可用时**什么都不做**（面板没有数据源），但过滤本体照常工作——
 * 这正是 inject 里不写 'webServer' 的原因：硬依赖会让缺 webServer 的宿主直接禁用插件。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} guard - guard 实例（契约 6）。
 * @param {(line: string) => void} log - 日志出口。
 * @returns {void}
 */
function registerRoutes(ctx, guard, log) {
  try {
    if (!ctx || typeof ctx.inject !== 'function') {
      log('[opencode-ip-guard] ctx.inject 不可用，跳过状态路由（过滤本体不受影响）');
      return;
    }

    ctx.inject(['webServer'], (sctx) => {
      try {
        const webServer = (sctx && sctx.webServer) || ctx.webServer;
        if (!webServer || typeof webServer.register !== 'function') {
          log('[opencode-ip-guard] webServer.register 不可用，跳过状态路由（过滤本体不受影响）');
          return;
        }

        // effect 必须登记在"持有 webServer 的那个上下文"上，才能随其一起释放；
        // 有的版本只在外层 ctx 上提供 effect，所以做一次能力探测再二选一。
        const effectCtx = sctx && typeof sctx.effect === 'function' ? sctx : ctx;

        /**
         * 注册单条路由并把 register 返回的清理函数登记进 effect。
         *
         * @param {string} path - 精确路径。
         * @param {Function} handler - Node http 处理器 (req, res)。
         * @param {string} label - effect 标签（出现在调试信息里）。
         * @returns {void}
         */
        const mountRoute = (path, handler, label) => {
          try {
            if (typeof effectCtx.effect !== 'function') {
              // 没有 effect 也应尽力注册：路由残留的代价远小于面板不可用。
              webServer.register({ kind: 'exact', path, handler });
              log('[opencode-ip-guard] 路由已注册（无 effect，无法自动清理）：' + path);
              return;
            }
            effectCtx.effect(() => {
              const disposer = webServer.register({ kind: 'exact', path, handler });
              log('[opencode-ip-guard] 路由已注册：' + path);
              return disposer;
            }, label);
          } catch (error) {
            log('[opencode-ip-guard] 路由注册失败（面板不可用，过滤不受影响）：' + path + ' → ' + describeError(error));
          }
        };

        mountRoute(STATUS_ROUTE, makeStatusHandler(guard, log), 'opencode-ip-guard: status route');
        mountRoute(REFRESH_ROUTE, makeRefreshHandler(guard, log), 'opencode-ip-guard: refresh route');
      } catch (error) {
        log('[opencode-ip-guard] 注入 webServer 回调异常（面板不可用，过滤不受影响）：' + describeError(error));
      }
    });
  } catch (error) {
    log('[opencode-ip-guard] 注册状态路由失败（面板不可用，过滤不受影响）：' + describeError(error));
  }
}

/**
 * 制造 GET /opencode-ip-guard/status 的处理器。
 *
 * 纯内存读快照，无 IO、无副作用；即使 guard.snapshot() 抛错也要保证有 JSON 可回，
 * 否则面板会一直停在"拿不到状态"，用户无从判断插件到底在不在。
 *
 * @param {object} guard - guard 实例。
 * @param {(line: string) => void} log - 日志出口。
 * @returns {(req: object, res: object) => void} Node http 处理器。
 */
function makeStatusHandler(guard, log) {
  return (req, res) => {
    try {
      if (!isMethod(req, 'GET')) {
        sendJson(res, 405, { error: 'method not allowed', allow: 'GET' });
        return;
      }
      sendJson(res, 200, snapshotSafe(guard, log));
    } catch (error) {
      // 兜底：处理器自身异常也要给出 500 JSON，而不是让 socket 悬着。
      log('[opencode-ip-guard] status 处理器异常：' + describeError(error));
      sendJson(res, 500, fallbackSnapshot('状态读取异常：' + String(error)));
    }
  };
}

/**
 * 制造 POST /opencode-ip-guard/refresh 的处理器（决策 D16：先重探，再按结果重建黑名单）。
 *
 * guard.refresh() 是异步的，处理器里用 Promise 链而不是 async 函数，
 * 这样"同步阶段抛错"也能被同一段 catch 兜住（http 处理器抛异常会变成未处理 rejection）。
 *
 * @param {object} guard - guard 实例。
 * @param {(line: string) => void} log - 日志出口。
 * @returns {(req: object, res: object) => void} Node http 处理器。
 */
function makeRefreshHandler(guard, log) {
  return (req, res) => {
    try {
      if (!isMethod(req, 'POST')) {
        sendJson(res, 405, { error: 'method not allowed', allow: 'POST' });
        return;
      }
      if (typeof guard.refresh !== 'function') {
        // 契约 6 要求有 refresh；真缺了就明确回 501，面板据此显示异常而不是空转。
        sendJson(res, 501, { error: 'guard.refresh 不可用' });
        return;
      }
      Promise.resolve()
        .then(() => guard.refresh())
        .then((snapshot) => {
          // refresh 正常应返回 StatusSnapshot；万一返回空就再取一次快照。
          sendJson(res, 200, snapshot && typeof snapshot === 'object' ? snapshot : snapshotSafe(guard, log));
        })
        .catch((error) => {
          log('[opencode-ip-guard] refresh 失败：' + describeError(error));
          sendJson(res, 500, { error: 'refresh failed', reason: String(error), snapshot: snapshotSafe(guard, log) });
        });
    } catch (error) {
      log('[opencode-ip-guard] refresh 处理器异常：' + describeError(error));
      sendJson(res, 500, { error: 'refresh failed', reason: String(error) });
    }
  };
}

/**
 * 安全取快照：guard.snapshot() 抛错时降级为 error 快照。
 *
 * @param {object} guard - guard 实例。
 * @param {(line: string) => void} log - 日志出口。
 * @returns {object} StatusSnapshot（结构见契约 5）。
 */
function snapshotSafe(guard, log) {
  try {
    const snapshot = guard.snapshot();
    if (snapshot && typeof snapshot === 'object') return snapshot;
    return fallbackSnapshot('snapshot() 返回了非对象');
  } catch (error) {
    log('[opencode-ip-guard] snapshot() 异常：' + describeError(error));
    return fallbackSnapshot('snapshot() 异常：' + String(error));
  }
}

/**
 * 兜底快照：保证面板永远能拿到一个结构合法的对象。
 *
 * @param {string} reason - 降级原因，会显示在面板 tooltip 里。
 * @returns {{state: string, enabled: boolean, reason: string, lastProbeAt: null, nextRetryAt: null, entries: never[], stats: {ok: number, black: number, total: number}}} StatusSnapshot。
 */
function fallbackSnapshot(reason) {
  return {
    state: 'error',
    enabled: false,
    reason,
    lastProbeAt: null,
    nextRetryAt: null,
    entries: [],
    stats: { ok: 0, black: 0, total: 0 },
  };
}

/**
 * 是否是某个 HTTP 方法（大小写不敏感；缺省按 GET，符合 Node 语义）。
 *
 * @param {object} req - Node 请求对象。
 * @param {string} expected - 期望方法，如 'GET'。
 * @returns {boolean} 是否匹配。
 */
function isMethod(req, expected) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  return method === expected;
}

/**
 * 发送 JSON 响应。刻意自己算 content-length：面板极小，一次写清比分块更省事，
 * 也避免客户端在 keep-alive 连接上等不到结束标记。
 *
 * @param {object} res - Node 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 会被 JSON.stringify 的负载。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  let body = 'null';
  try {
    body = JSON.stringify(payload);
  } catch {
    body = '{"error":"serialize failed"}';
  }
  try {
    const length = Buffer.byteLength(body, 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      // 状态必须实时：任何中间层缓存都会让面板显示过期信息。
      'cache-control': 'no-store',
      'content-length': length,
    });
    res.end(body);
  } catch {
    // 响应已发出（或 socket 已断）时 writeHead 会抛，这里静默放弃即可。
    try {
      res.end();
    } catch {
      // 彻底忽略
    }
  }
}

/**
 * 白名单方式读取 profile config 并合并默认值。
 *
 * 为什么用白名单：profile 里可能残留别人写的键，或者用户拼错的键；
 * 只挑认识的字段，能让"配置写错"表现为"按默认值运行"，而不是把脏值塞进 guard。
 *
 * @param {object|undefined} rawConfig - profile 里的 config。
 * @param {(line: string) => void} log - 日志出口（用于报告被丢弃的非法值）。
 * @returns {{hostname: string, probeTimeoutMs: number, enabled: boolean, forceIps: string[], retryDelaysMs: number[], blacklistTtlMs: number, confirmDelayMs: number, expiryCheckIntervalMs: number}} 合并后的配置。
 */
function normalizeConfig(rawConfig, log) {
  /** 归一化结果：先深拷贝默认值（防止下游改动污染冻结的 DEFAULTS 内的数组引用）。 */
  const config = {
    hostname: DEFAULTS.hostname,
    probeTimeoutMs: DEFAULTS.probeTimeoutMs,
    enabled: DEFAULTS.enabled,
    forceIps: DEFAULTS.forceIps.slice(),
    retryDelaysMs: DEFAULTS.retryDelaysMs.slice(),
    blacklistTtlMs: DEFAULTS.blacklistTtlMs,
    confirmDelayMs: DEFAULTS.confirmDelayMs,
    expiryCheckIntervalMs: DEFAULTS.expiryCheckIntervalMs,
  };

  if (rawConfig === null || typeof rawConfig !== 'object') return config;

  /** 收集非法值提示，最后一次性打日志，避免刷屏。 */
  const notes = [];

  const has = (key) => Object.prototype.hasOwnProperty.call(rawConfig, key);

  if (has('hostname')) {
    const value = rawConfig.hostname;
    if (typeof value === 'string' && value.trim() !== '') {
      config.hostname = value.trim().toLowerCase();
    } else {
      notes.push('hostname 必须是非空字符串，已用默认值 ' + DEFAULTS.hostname);
    }
  }

  if (has('probeTimeoutMs')) {
    const value = rawConfig.probeTimeoutMs;
    // 下限 2000ms：决策 D3 明确不用 2 秒以下，太激进会把慢网络的好 IP 误判成黑洞；
    // 上限 30000ms：再长就等于把面板"点击重探"卡死。
    if (typeof value === 'number' && Number.isFinite(value)) {
      config.probeTimeoutMs = Math.min(30000, Math.max(2000, Math.round(value)));
    } else {
      notes.push('probeTimeoutMs 必须是有限数字，已用默认值 ' + DEFAULTS.probeTimeoutMs);
    }
  }

  if (has('enabled')) {
    const value = rawConfig.enabled;
    if (typeof value === 'boolean') {
      config.enabled = value;
    } else {
      notes.push('enabled 必须是布尔值，已用默认值 ' + DEFAULTS.enabled);
    }
  }

  if (has('forceIps')) {
    const value = rawConfig.forceIps;
    if (Array.isArray(value)) {
      const ips = [];
      for (const item of value) {
        // 只接受 IPv4 字面量：这个钩子是给验收 3 用的，塞进垃圾会被当成 DNS 结果连出去。
        if (typeof item === 'string' && isIpv4(item.trim())) ips.push(item.trim());
        else notes.push('forceIps 含非法 IPv4，已丢弃：' + String(item));
      }
      config.forceIps = ips;
    } else {
      notes.push('forceIps 必须是数组，已忽略');
    }
  }

  if (has('retryDelaysMs')) {
    const value = rawConfig.retryDelaysMs;
    if (Array.isArray(value)) {
      const delays = [];
      for (const item of value) {
        if (typeof item === 'number' && Number.isFinite(item) && item >= 0) delays.push(Math.round(item));
        else notes.push('retryDelaysMs 含非法值，已丢弃：' + String(item));
      }
      // 空数组会让 guard 永远不重试；宁可回默认值也不要静默变成"只探一次"。
      if (delays.length > 0) config.retryDelaysMs = delays;
      else notes.push('retryDelaysMs 过滤后为空，已用默认值 ' + DEFAULTS.retryDelaysMs.join(','));
    } else {
      notes.push('retryDelaysMs 必须是数组，已用默认值 ' + DEFAULTS.retryDelaysMs.join(','));
    }
  }

  if (has('blacklistTtlMs')) {
    const value = rawConfig.blacklistTtlMs;
    // 下限 10000ms：再短就等于"刚拉黑就过期"，黑名单失去意义；
    // 上限 3600000ms：再长就等于"一次误判管一小时"，与软过期的初衷相悖。
    if (typeof value === 'number' && Number.isFinite(value)) {
      config.blacklistTtlMs = Math.min(3600000, Math.max(10000, Math.round(value)));
    } else {
      notes.push('blacklistTtlMs 必须是有限数字，已用默认值 ' + DEFAULTS.blacklistTtlMs);
    }
  }

  if (has('confirmDelayMs')) {
    const value = rawConfig.confirmDelayMs;
    // 下限 100ms：0 会让二次确认形同虚设；上限 10000ms：再长会让探测收尾拖得太久。
    if (typeof value === 'number' && Number.isFinite(value)) {
      config.confirmDelayMs = Math.min(10000, Math.max(100, Math.round(value)));
    } else {
      notes.push('confirmDelayMs 必须是有限数字，已用默认值 ' + DEFAULTS.confirmDelayMs);
    }
  }

  if (has('expiryCheckIntervalMs')) {
    const value = rawConfig.expiryCheckIntervalMs;
    // 下限 5000ms：太频繁等于每秒都在检查，虽然不联网也没必要；
    // 上限 600000ms：再长则过期条目可能要等十分钟才被纠正。
    if (typeof value === 'number' && Number.isFinite(value)) {
      config.expiryCheckIntervalMs = Math.min(600000, Math.max(5000, Math.round(value)));
    } else {
      notes.push('expiryCheckIntervalMs 必须是有限数字，已用默认值 ' + DEFAULTS.expiryCheckIntervalMs);
    }
  }

  if (notes.length > 0) {
    log('[opencode-ip-guard] 配置校验提示：' + notes.join('；'));
  }

  return config;
}

/**
 * 是否是合法 IPv4 字面量（四段 0~255，不带前导零以免被误判成八进制）。
 *
 * @param {string} text - 候选文本。
 * @returns {boolean} 是否合法。
 */
function isIpv4(text) {
  if (typeof text !== 'string') return false;
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}
