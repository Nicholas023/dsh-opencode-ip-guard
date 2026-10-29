/**
 * dispatcher.js —— 创建并安装自定义 undici 全局 dispatcher。
 *
 * 为什么必须接管「全局 dispatcher」而不是给某个业务模块传配置：
 * DSH 的请求走 Node 内置 fetch，连接池由 undici 的全局 dispatcher 决定（D5：不碰 DSH 业务代码）。
 * 我们只能通过 setGlobalDispatcher 把自己的 Agent 装进去，lookup 钩子才会生效。
 * 注意：不设置 keepAliveTimeout（D6 不做保活），connect timeout 保持运行时默认 10s（D7）。
 */

/**
 * 默认 connect 超时（毫秒），与 DSH 运行时口径一致（D7）。
 * 传非法值时回落此值——配置错误只能降级，不能把 undici 弄坏。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

/**
 * 归一化超时配置。
 * 为什么要校验：undici 的 Agent 对 connect.timeout 期望是正整数毫秒，
 * 传入 NaN/负数/字符串可能导致建连行为不可预期。
 */
function normalizeTimeout(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_CONNECT_TIMEOUT_MS;
}

/**
 * 安装自定义全局 undici dispatcher。
 *
 * 为什么是 async：契约 4 要求 undici 动态 import（避免插件加载期就把 undici 拉起来，
 * 也避免和 DSH 内置 undici 版本产生顶层循环依赖）。调用方需要 await 本函数。
 *
 * @param {object} opts
 * @param {Function} opts.lookup 交给 Agent 的 connect.lookup
 * @param {number} [opts.connectTimeoutMs] connect 超时，默认 10000
 * @param {object} [opts.undici] 测试钩子：可注入假的 undici 模块（Agent/getGlobalDispatcher/setGlobalDispatcher）
 * @returns {Promise<{dispatcher: any, restore: () => void}>}
 *          dispatcher 是新建的 Agent（安装失败时为 null）；restore 幂等且永不抛错
 */
export async function installDispatcher(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const lookup = o.lookup;
  const connectTimeoutMs = normalizeTimeout(o.connectTimeoutMs);

  // restore 的默认形态：什么都没装时也必须能安全调用（guard.dispose 会无脑调它）
  let restore = () => {};
  try {
    const undiciModule = o.undici || (await import('undici'));
    const { Agent, getGlobalDispatcher, setGlobalDispatcher } = undiciModule || {};

    // 能力检测（§7 边界 10）：undici 大版本变更可能导致 API 形态不同，
    // 缺失任一 API 就放弃安装并保持无副作用，而不是带着半残状态跑。
    if (
      typeof Agent !== 'function' ||
      typeof getGlobalDispatcher !== 'function' ||
      typeof setGlobalDispatcher !== 'function'
    ) {
      return { dispatcher: null, restore };
    }

    // 先保存原 dispatcher：DSH 可能已经装了代理 dispatcher（D11），
    // 我们必须能把它原样还回去，否则 dispose 会破坏用户的代理配置。
    let previous;
    try {
      previous = getGlobalDispatcher();
    } catch {
      previous = undefined;
    }

    // 注意：这里只给 connect.timeout 与 lookup，不设 keepAliveTimeout（D6）
    const dispatcher = new Agent({ connect: { timeout: connectTimeoutMs, lookup } });
    setGlobalDispatcher(dispatcher);

    let restored = false;
    /**
     * 恢复原 dispatcher。幂等（重复调用只生效一次）且永不抛错：
     * dispose 可能被 cordis 重复触发，恢复失败也只能吞掉，不能让插件卸载流程崩掉。
     */
    restore = () => {
      if (restored) return;
      restored = true;
      try {
        if (previous) setGlobalDispatcher(previous);
      } catch {
        // 恢复失败没有补救手段；保持进程存活比恢复成功更重要
      }
    };

    return { dispatcher, restore };
  } catch (err) {
    // 动态 import 失败、Agent 构造抛错等：一律降级为「没装」，并给出可安全调用的 restore
    restore = () => {};
    return { dispatcher: null, restore };
  }
}
