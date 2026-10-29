/**
 * 黑洞 IP 黑名单容器（纯内存、无 IO）。
 *
 * 为什么要把「探测结果」和「连接时过滤」拆成两层：
 * undici 的 lookup 钩子跑在每次建连的同步路径上，里面不可能做 TLS 探测；
 * 探测只能异步执行，执行完把结论写进这层内存状态，lookup 读取即可。
 */

/**
 * 一轮探测的单条结果（由 probe.js 产出，这里只消费）。
 * @typedef {{ ip: string, ok: boolean, ms: number | null, error: string | null }} ProbeResult
 */

/**
 * 黑名单条目（供面板展示；at 是该条目最后一次被更新的时间）。
 * @typedef {{ ip: string, state: 'ok' | 'black', ms: number | null, error: string | null, at: number }} BlacklistEntry
 */

/** 缺省黑洞原因：保证面板与统计永远拿到可读文本，而不是 undefined。 */
const UNKNOWN_ERROR = 'unknown';

/**
 * 把耗时清洗成「非负有限数字或 null」。
 * 为什么：探测器可能传 undefined/NaN/字符串，面板按数字渲染，类型必须稳定。
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 把错误原因清洗成非空字符串。
 * 为什么：这个字段会直接显示在面板上，null/空串会让文案出现空洞。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeError(value) {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value === null || value === undefined) return UNKNOWN_ERROR;
  return String(value);
}

/**
 * 拷贝条目，避免调用方改到内部状态（entries() 对外承诺是快照）。
 * @param {BlacklistEntry} entry
 * @returns {BlacklistEntry}
 */
function copyEntry(entry) {
  return { ip: entry.ip, state: entry.state, ms: entry.ms, error: entry.error, at: entry.at };
}

/**
 * 按 IP 字符串做码点比较排序。
 * 为什么不用 localeCompare：不同系统 locale 对 '.' 与数字的排序规则可能不同，
 * 面板顺序必须确定，否则每次渲染都可能抖动。
 * @param {BlacklistEntry} a
 * @param {BlacklistEntry} b
 * @returns {number}
 */
function compareByIp(a, b) {
  if (a.ip < b.ip) return -1;
  if (a.ip > b.ip) return 1;
  return 0;
}

/**
 * 创建黑名单容器。纯内存，无 IO，无可观察副作用。
 * @returns {{
 *   isBlack: (ip: string) => boolean,
 *   markOk: (ip: string, ms: number | null) => void,
 *   markBlack: (ip: string, reason: string) => void,
 *   rebuild: (results: ProbeResult[]) => void,
 *   filter: (ips: string[]) => string[],
 *   entries: () => BlacklistEntry[],
 *   stats: () => { ok: number, black: number, total: number },
 *   clear: () => void,
 * }}
 */
export function createBlacklist() {
  /** @type {Map<string, BlacklistEntry>} 以 IP 为键，天然去重 */
  const items = new Map();

  /**
   * 写入/覆盖一条记录。内部函数，调用方保证 ip 已校验。
   * @param {string} ip
   * @param {'ok' | 'black'} state
   * @param {number | null} ms
   * @param {string | null} error
   */
  function write(ip, state, ms, error) {
    items.set(ip, { ip, state, ms, error, at: Date.now() });
  }

  /**
   * 该 IP 是否已被判定为黑洞。
   * 非字符串/空串一律按「不在黑名单」处理：不把非法输入变成阻断连接的理由。
   * @param {string} ip
   * @returns {boolean}
   */
  function isBlack(ip) {
    if (typeof ip !== 'string' || ip === '') return false;
    const entry = items.get(ip);
    return entry !== undefined && entry.state === 'black';
  }

  /**
   * 标记可用，并记录 TLS 握手耗时（null 表示探测器没给耗时）。
   * 非法 IP 静默忽略：一条脏结果不该让整轮探测流程崩掉。
   * @param {string} ip
   * @param {number | null} ms
   * @returns {void}
   */
  function markOk(ip, ms) {
    if (typeof ip !== 'string' || ip === '') return;
    write(ip, 'ok', normalizeMs(ms), null);
  }

  /**
   * 标记黑洞。reason 用探测器的原始错误码（timeout / econnrefused / cert ...），
   * 因为面板要能区分「超时」和「证书问题」，两者的处置完全不一样。
   * @param {string} ip
   * @param {string} reason
   * @returns {void}
   */
  function markBlack(ip, reason) {
    if (typeof ip !== 'string' || ip === '') return;
    write(ip, 'black', null, normalizeError(reason));
  }

  /**
   * 用一轮探测结果重建整个黑名单：先清空，再按结果重填。
   * 为什么必须清空而不是增量更新：只有重建才能让「恢复的 IP」被移出黑名单（D16）；
   * 增量更新会让旧结论永远留着，与「每轮探测都是一份完整事实」相矛盾。
   * @param {ProbeResult[]} results
   * @returns {void}
   */
  function rebuild(results) {
    items.clear();
    if (!Array.isArray(results)) return;
    for (const result of results) {
      if (!result || typeof result.ip !== 'string' || result.ip === '') continue;
      if (result.ok === true) markOk(result.ip, result.ms);
      else markBlack(result.ip, result.error);
    }
  }

  /**
   * 剔除黑名单中的 IP。
   * 若剔除后为空必须返回原始列表：否则一旦探测把自己能用的 IP 全判黑，
   * lookup 就无地址可返回，DSH 会彻底连不上（边界情况 2/8 的自锁保护）。
   * @param {string[]} ips
   * @returns {string[]}
   */
  function filter(ips) {
    if (!Array.isArray(ips)) return [];
    if (ips.length === 0) return [];
    const usable = ips.filter((ip) => !isBlack(ip));
    return usable.length > 0 ? usable : ips.slice();
  }

  /**
   * 返回快照数组，按 IP 字符串排序，供面板稳定展示。
   * @returns {BlacklistEntry[]}
   */
  function entries() {
    return [...items.values()].map(copyEntry).sort(compareByIp);
  }

  /**
   * 统计当前条目分布。
   * @returns {{ ok: number, black: number, total: number }}
   */
  function stats() {
    let ok = 0;
    let black = 0;
    for (const entry of items.values()) {
      if (entry.state === 'black') black += 1;
      else ok += 1;
    }
    return { ok, black, total: ok + black };
  }

  /**
   * 清空全部条目（探测全失败时用：黑名单不生效，全部放行，见 D9）。
   * @returns {void}
   */
  function clear() {
    items.clear();
  }

  return { isBlack, markOk, markBlack, rebuild, filter, entries, stats, clear };
}
