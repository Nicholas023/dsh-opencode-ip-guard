/**
 * lookup.js —— undici Agent 的 DNS 解析钩子（本插件的核心）。
 *
 * 为什么要在 lookup 上做文章：DSH 的请求最终由 Node 内置 fetch（undici）发起，
 * undici 建连时调用 connect.lookup 决定「连哪个 IP」。DNS 每次返回的 A 记录顺序都在变，
 * 命中黑洞 IP 就要吃 21 秒 SYN 重传。我们在这一层剔掉黑洞 IP，DSH 就永远连不到它们（D2）。
 *
 * 三条硬性降级规则（任何一条都优先于「过滤」这个目标）：
 * 1. 非目标域名 → 原样交回系统解析器（D14：只管 opencode.ai）；
 * 2. 解析失败 / 解不出 IPv4 → 交回系统解析器（§7 边界 3、11）；
 * 3. 过滤后一个不剩 → 回退原始列表（§7 边界 2：绝不能把连接搞死）。
 */
import dns from 'node:dns';

/**
 * 判断字符串是否是合法 IPv4 点分十进制。
 * 为什么需要它：forceIps 由用户/测试注入，resolve4 理论上只返回 A 记录，
 * 但「返回值一定是 IPv4」这个前提必须自己校验，否则 family=4 的承诺可能被打破。
 */
function isIPv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    // 前导零（如 01）不是标准点分十进制，直接拒绝，避免把奇怪字符串当 IP 用
    if (part.length > 1 && part.startsWith('0')) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/**
 * 归一化目标域名列表：小写、去掉结尾的点、丢弃空值。
 * 为什么去掉结尾点：FQDN 写法（opencode.ai.）与普通写法指向同一主机，
 * 不归一化会漏防护。这里只做精确匹配，不做通配（D14：只认指定域名）。
 */
function normalizeHostnames(hostnames) {
  if (!Array.isArray(hostnames)) return new Set();
  const set = new Set();
  for (const hostname of hostnames) {
    if (typeof hostname !== 'string') continue;
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (normalized) set.add(normalized);
  }
  return set;
}

/**
 * 创建 undici 用的 lookup 钩子。
 *
 * @param {object} opts
 * @param {string[]} opts.hostnames 需要防护的域名列表，如 ['opencode.ai']
 * @param {{isBlack: Function, filter: Function}} opts.blacklist 契约 1 的黑名单实例
 * @param {(hostname: string) => Promise<string[]>} [opts.resolve4] 可注入，默认 dns.promises.resolve4
 * @param {Function} [opts.fallbackLookup] 可注入，默认 dns.lookup
 * @param {string[]} [opts.forceIps] 测试钩子：非空时忽略真实解析，只用这些 IP 当候选
 * @returns {(hostname: string, options: object, callback: Function) => void}
 */
export function createLookup(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const hostnames = normalizeHostnames(o.hostnames);
  const blacklist = o.blacklist;
  // 默认解析器用函数包一层：dns.promises.resolve4 直接传递引用在不同 Node 版本下
  // 有过 this 绑定的坑，包一层最稳。
  const resolve4 =
    typeof o.resolve4 === 'function' ? o.resolve4 : (hostname) => dns.promises.resolve4(hostname);
  const fallbackLookup = typeof o.fallbackLookup === 'function' ? o.fallbackLookup : dns.lookup;
  const forceIps = Array.isArray(o.forceIps) ? o.forceIps.filter(isIPv4) : [];

  /**
   * 契约为 undici 的 connect.lookup 形态：lookup(hostname, options, callback)。
   *
   * @param {string} hostname 待解析域名
   * @param {object} options undici 传入的解析选项（可能带 all / family / hints）
   * @param {Function} callback (err, address, family) 或 (err, [{address, family}])
   */
  return function lookup(hostname, options, callback) {
    // 参数容错：兼容 dns.lookup 的 (hostname, cb) 旧形态；undici 始终传三参
    let lookupOptions = options;
    let done = callback;
    if (typeof lookupOptions === 'function') {
      done = lookupOptions;
      lookupOptions = {};
    }
    if (!lookupOptions || typeof lookupOptions !== 'object') lookupOptions = {};
    // 没有回调就等于没有交付通道，此时唯一正确的做法是静默放弃（不能抛穿到 undici）
    if (typeof done !== 'function') return;

    const all = lookupOptions.all === true;
    let settled = false;

    /**
     * 统一交付：保证回调只被调用一次，并且回调本身抛错也不会冒泡成未捕获异常。
     * 为什么吞掉回调异常：undici 的回调理论上不会抛，但一旦抛且冒出到 Promise 链外，
     * 会让 DSH 进程出现 unhandled rejection；降级优先于暴露内部 bug（代码风格第 5 条）。
     */
    const deliver = (err, address, family) => {
      if (settled) return;
      settled = true;
      try {
        if (err) done(err);
        else if (all) done(null, [{ address, family: 4 }]);
        else done(null, address, 4);
      } catch {
        // 交付阶段的异常只能吞掉：没有第二个人能接收它
      }
    };

    /**
     * 交回系统解析器。
     * 为什么这里要「原样透传」而不是复用 deliver：all 模式下系统解析器的第二参是
     * [{address, family}] 数组，若再包一层就会得到嵌套数组，反而破坏 undici 的解析。
     */
    const fallback = () => {
      if (settled) return;
      const passthrough = (err, address, family) => {
        if (settled) return;
        settled = true;
        try {
          if (err) done(err);
          else if (all) done(null, address);
          else done(null, address, family);
        } catch {
          // 同 deliver：回调异常只能吞掉
        }
      };
      try {
        fallbackLookup(hostname, lookupOptions, passthrough);
      } catch (err) {
        // 系统解析器同步抛错（例如非法 options）：降级成错误回调，不让异常穿到 undici
        passthrough(err);
      }
    };

    // 非目标域名：原样交给系统解析器，插件对它没有任何意见（D14）
    const normalizedHostname =
      typeof hostname === 'string' ? hostname.toLowerCase().replace(/\.$/, '') : '';
    if (!normalizedHostname || !hostnames.has(normalizedHostname)) {
      fallback();
      return;
    }

    /** 目标域名：解析 → 过滤 → 选第一个可用 IPv4 */
    const chooseAddress = (rawList) => {
      const ips = Array.isArray(rawList) ? rawList.filter(isIPv4) : [];
      // 解析不到任何 IPv4（只有 AAAA / 空结果）：回退系统解析器，允许系统自己选（§7 边界 11）
      if (ips.length === 0) {
        fallback();
        return;
      }

      let usable = ips;
      try {
        // blacklist.filter 契约上会自己保证「全黑时返回原列表」，这里仍做二次兜底：
        // 插件内部任何一环出问题，都不能导致「一个候选都不给」。
        const filtered = blacklist && typeof blacklist.filter === 'function' ? blacklist.filter(ips) : ips;
        if (Array.isArray(filtered) && filtered.length > 0) usable = filtered;
      } catch {
        // 黑名单异常等同于黑名单为空：放行全部，保证请求可通
        usable = ips;
      }
      const chosen = usable.find((ip) => isIPv4(ip));
      if (!chosen) {
        fallback();
        return;
      }
      deliver(null, chosen, 4);
    };

    try {
      if (forceIps.length > 0) {
        // forceIps 只做测试注入：跳过真实解析，直接拿注入值当候选，其余规则完全一致
        chooseAddress(forceIps.slice());
        return;
      }
      // 实时解析、不缓存（§6.2）：跟随最新 DNS 结果，避免缓存过期导致防护失效
      const pending = resolve4(normalizedHostname);
      Promise.resolve(pending)
        .then((addresses) => chooseAddress(addresses))
        .catch(() => fallback());
    } catch {
      // 解析器同步抛错（注入实现可能如此）：同样回退，不能让 undici 看到异常
      fallback();
    }
  };
}
