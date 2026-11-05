/**
 * session-header.js —— 给 opencode 请求补上 x-opencode-session 头
 *
 * 为什么需要它：
 *   opencode 的网关对缺少 x-opencode-session 的请求直接 400 MissingSessionID（已实测复现），
 *   请求根本进不到上游模型；这个头还是它做「同一会话钉到同一后端」的依据，
 *   钉得稳才能让 prompt cache 在整段对话里保持温热。
 *
 * 为什么要在插件里做（而不是改 DSH）：
 *   DSH 的 sessionId 链路本身是通的（agent-loop 塞 → adapter 透传 → pi-ai 加头），
 *   但一旦某个环节因版本差异或旁路调用断掉，就会静默变成 400。
 *   本模块在 HTTP 出口做「兜底」：已有头就绝不动，没有才补。
 *
 * 关键实现难点（这是从一份已验证实现里学到的，别自己发明）：
 *   llm/stream 的 next() 返回的是**惰性流**，真正的 HTTP 请求发生在之后消费这个流的时候，
 *   并不在监听器的同步栈里。所以只写 `als.run(x, () => next())` 是无效的；
 *   必须**包装迭代器**，让每一次 next()/throw() 都在 als.run 里执行（见 withStore）。
 *
 * 安全底线：
 *   1) 请求已带该头 → 原样放行，绝不覆盖（覆盖会破坏 DSH 自己算好的会话亲和）；
 *   2) 只在目标 provider 的调用里生效，其它 provider / 旁路请求完全不受影响；
 *   3) patch 出去的 fetch 在任何情况下都不得抛出新异常；
 *   4) 插件卸载时恢复原始 fetch（用 ctx.effect 的 disposer 保证）。
 *
 * @module dsh-opencode-ip-guard/session-header
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** opencode 网关要求的会话头名字。 */
const SESSION_HEADER = 'x-opencode-session';

/** 默认要补头的 provider 路由键：pi-ai catalog 里 opencode 的两个 id。 */
const DEFAULT_PROVIDERS = ['opencode', 'opencode-go'];

/**
 * 归一化配置。坏的/缺的字段一律回退默认值，绝不因为配置写错让插件失效。
 *
 * @param {object|undefined} raw - profile 里的 sessionHeader 配置段。
 * @returns {{enabled: boolean, providers: Set<string>, mode: 'session-id'|'uuid', debug: boolean}} 归一化结果。
 */
export function resolveSessionHeaderConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // 只有显式 false 才关闭；其它脏值按开启处理，避免「配置写错 = 功能静默消失」
  const enabled = source.enabled !== false;
  const providers = Array.isArray(source.providers) && source.providers.length > 0
    ? source.providers.map((value) => String(value))
    : [...DEFAULT_PROVIDERS];
  // session-id：直接用 DSH 会话 id（跨轮次、跨重启都稳定，天然唯一）；
  // uuid：按会话 id 派生一次随机 UUID（更不透明，但进程重启后值会变）。
  const mode = source.mode === 'uuid' ? 'uuid' : 'session-id';
  const debug = source.debug === true;
  return { enabled, providers: new Set(providers), mode, debug };
}

/**
 * 计算某个会话应使用的头值。
 *
 * @param {unknown} sessionId - DSH 会话 id。
 * @param {'session-id'|'uuid'} mode - 取值模式。
 * @param {Map<string, string>} table - uuid 模式下会话 id 到 uuid 的记忆表。
 * @returns {string|undefined} 头值；会话 id 非法时返回 undefined（表示不注入）。
 */
export function headerValueFor(sessionId, mode, table) {
  const raw = String(sessionId);
  if (raw.length === 0) return undefined;
  if (mode !== 'uuid') return raw;
  let value = table.get(raw);
  if (value === undefined) {
    value = randomUUID();
    table.set(raw, value);
  }
  return value;
}

/**
 * 判断这次请求是否已经带了会话头。
 *
 * 用途：已有头必须原样放行，这是整个模块的安全底线。
 *
 * @param {RequestInfo|URL|string} input - fetch 的第一个参数。
 * @param {RequestInit|undefined} init - fetch 的第二个参数。
 * @returns {boolean} 已带该头返回 true。
 */
function hasSessionHeader(input, init) {
  // 与原生 fetch 的优先级一致：init.headers 存在时以它为准，否则读 Request 自带的头
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
  if (source === undefined) return false;
  try {
    return new Headers(source).has(SESSION_HEADER);
  } catch {
    // Headers 构造都失败时宁可认为「已有头」，也不要冒险覆盖别人的值
    return true;
  }
}

/**
 * 生成一个带注入能力的 fetch。
 *
 * 只有在 AsyncLocalStorage 里存在本次调用的 store 时才注入，其余情况完全透传，
 * 因此对非 opencode 的所有网络请求零影响。
 *
 * @param {typeof fetch} original - 原始 fetch。
 * @param {AsyncLocalStorage<{value: string}>} als - 存放头值的作用域。
 * @returns {typeof fetch} 包装后的 fetch。
 */
export function patchFetch(original, als) {
  return function patchedFetch(input, init) {
    let state;
    try {
      state = als.getStore();
    } catch {
      state = undefined;
    }
    if (state && !hasSessionHeader(input, init)) {
      try {
        const headers = new Headers(
          init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
        );
        headers.set(SESSION_HEADER, state.value);
        return original.call(this, input, { ...init, headers });
      } catch {
        // 注入失败绝不能影响原请求：退回完全原始的调用
        return original.apply(this, arguments);
      }
    }
    return original.apply(this, arguments);
  };
}

/**
 * 把一个异步可迭代对象包装成「每次拉取都在指定 store 里执行」的版本。
 *
 * 为什么必须这样做：llm/stream 的 next() 返回的是惰性流，HTTP 请求发生在之后
 * 消费这个流的时候（不同的异步栈）。只有把每次 next()/throw() 都放回 als.run 里，
 * 下游 fetch 才读得到 store —— 这是整个注入能生效的关键。
 *
 * @param {AsyncIterable<any>} iterable - 下游流。
 * @param {{value: string}} store - 本次调用的头值。
 * @param {AsyncLocalStorage<any>} als - 作用域容器。
 * @returns {AsyncIterable<any>} 包装后的流。
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return als.run(store, () => iterator.next());
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value);
        } catch {
          // 下游可能已经被拆除，按正常结束处理即可
        }
      }
      return { done: true, value };
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error));
      }
      throw error;
    },
  };
}

/**
 * 创建会话头注入器。
 *
 * @param {object} options
 * @param {object|undefined} options.config - 已归一化前的原始配置。
 * @param {(line: string) => void} options.log - 日志出口。
 * @returns {{attach: (ctx: object) => void}} 注入器。
 */
export function createSessionHeader({ config, log }) {
  const resolved = resolveSessionHeaderConfig(config);
  const als = new AsyncLocalStorage();
  const uuidBySession = new Map();

  /**
   * 挂载到宿主上下文。
   *
   * 两个注册都走 ctx.effect / ctx.on，随插件生命周期自动回收：
   * 停用、热更新、卸载都会恢复原始 fetch 并移除监听。
   *
   * @param {object} ctx - cordis 上下文。
   * @returns {void}
   */
  function attach(ctx) {
    if (!resolved.enabled) {
      log('[opencode-ip-guard] sessionHeader 已按配置关闭，不注入 x-opencode-session');
      return;
    }
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== 'function') {
      log('[opencode-ip-guard] globalThis.fetch 不可用，跳过 x-opencode-session 注入');
      return;
    }
    const patched = patchFetch(originalFetch, als);

    // 1) 换掉全局 fetch（effect 的 disposer 负责恢复，且只在仍是我们那版时恢复，
    //    避免把别人后装的 patch 覆盖掉）
    ctx.effect(() => {
      globalThis.fetch = patched;
      log('[opencode-ip-guard] x-opencode-session 注入已启用｜providers=['
        + [...resolved.providers].join(', ') + ']｜mode=' + resolved.mode);
      return () => {
        if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
      };
    }, 'opencode-ip-guard: session-header fetch');

    // 2) 监听 llm/stream：拿到 provider 与 sessionId，给这次调用挂上头值作用域。
    //    为什么用 ctx.inject(['llm']) 而不是直接 ctx.on：llm 服务没就绪时事件不会发生，
    //    等它就绪再注册，既避免空监听，也不影响插件其它部分（IP 过滤照常工作）。
    ctx.inject(['llm'], () => {
      ctx.on('llm/stream', (options, next) => {
        if (options === undefined || options === null || typeof options !== 'object') return next();
        if (!resolved.providers.has(String(options.provider))) return next();
        const sessionId = options.sessionId;
        if (sessionId === undefined || sessionId === null) return next();
        const value = headerValueFor(sessionId, resolved.mode, uuidBySession);
        if (value === undefined) return next();

        // next() 返回下游惰性流：先拿到它（异常照常抛给调用方），再包一层让拉取发生在 store 里
        const downstream = next();
        if (downstream === undefined || downstream === null) return downstream;
        if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream;

        if (resolved.debug) {
          log('[opencode-ip-guard] 为 provider="' + options.provider + '" 注入 ' + SESSION_HEADER + '=' + value);
        }
        return withStore(downstream, { value }, als);
      }, { prepend: true });
    });
  }

  return { attach };
}