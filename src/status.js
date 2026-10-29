/**
 * 状态快照组装（纯函数，不持有任何状态）。
 * 为什么单列一层：状态路由、面板、测试都消费同一份结构；
 * 把「字段归一化」集中在这里，避免每个消费方各自防脏数据、各自写一套默认值。
 */

/** 契约 5 的状态枚举：只认这几个值，避免面板收到无法渲染的字符串。 */
const VALID_STATES = new Set([
  'idle',
  'probing',
  'ready',
  'degraded',
  'failed',
  'disabled_by_proxy',
  'error',
]);

/** 输入没给 state 时的默认值：等价于「还没启动」，比报错更符合调用方直觉。 */
const DEFAULT_STATE = 'idle';

/** 输入给了非法 state 时的兜底值：让面板显示「出错了」，而不是白屏或崩溃。 */
const INVALID_STATE = 'error';

/**
 * 归一化时间戳：只接受有限数字（Unix ms），其他一律 null。
 * 为什么不用 Date 对象/字符串：契约规定就是 Unix ms，面板直接做减法算「几分钟前」。
 * @param {unknown} value
 * @returns {number | null}
 */
function toTimestampOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 归一化原因文案：空串/非字符串一律视为「没有原因」。 */
function toReasonOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * 归一化单条黑名单条目；结构不合法时返回 null，由调用方丢弃。
 * 为什么丢弃而不是猜：条目的 state 决定面板显示红色还是绿色，猜错会误导用户。
 * @param {any} raw
 * @returns {{ ip: string, state: 'ok' | 'black', ms: number | null, error: string | null, at: number } | null}
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.ip !== 'string' || raw.ip === '') return null;
  if (raw.state !== 'ok' && raw.state !== 'black') return null;
  return {
    ip: raw.ip,
    state: raw.state,
    ms: typeof raw.ms === 'number' && Number.isFinite(raw.ms) && raw.ms >= 0 ? raw.ms : null,
    error: toReasonOrNull(raw.error),
    // 未知时间用 0 占位（面板按 falsy 处理即可），避免快照里出现 NaN/undefined
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
  };
}

/**
 * 统计条目分布。
 * @param {Array<{ state: string }>} entries
 * @returns {{ ok: number, black: number, total: number }}
 */
function countStats(entries) {
  let ok = 0;
  let black = 0;
  for (const entry of entries) {
    if (entry.state === 'black') black += 1;
    else ok += 1;
  }
  return { ok, black, total: ok + black };
}

/**
 * 与 blacklist.js 保持一致的码点排序，保证面板顺序确定。
 * @param {{ ip: string }} a
 * @param {{ ip: string }} b
 * @returns {number}
 */
function compareByIp(a, b) {
  if (a.ip < b.ip) return -1;
  if (a.ip > b.ip) return 1;
  return 0;
}

/**
 * 组装状态快照。纯函数：同样的输入永远得到同样的输出，不读时钟、不读环境。
 * @param {{
 *   state?: string,
 *   enabled?: boolean,
 *   reason?: string | null,
 *   lastProbeAt?: number | null,
 *   nextRetryAt?: number | null,
 *   entries?: Array<object>,
 *   extra?: object,
 * }} [input] 契约 5 的输入；缺字段时按安全默认值补齐
 * @returns {{
 *   state: string,
 *   enabled: boolean,
 *   reason: string | null,
 *   lastProbeAt: number | null,
 *   nextRetryAt: number | null,
 *   entries: Array<{ ip: string, state: 'ok' | 'black', ms: number | null, error: string | null, at: number }>,
 *   stats: { ok: number, black: number, total: number },
 * }}
 */
export function buildStatus(input) {
  const source = input && typeof input === 'object' ? input : {};

  let state = DEFAULT_STATE;
  if (source.state !== undefined && source.state !== null) {
    state =
      typeof source.state === 'string' && VALID_STATES.has(source.state) ? source.state : INVALID_STATE;
  }

  const entries = (Array.isArray(source.entries) ? source.entries : [])
    .map(normalizeEntry)
    .filter((entry) => entry !== null)
    .sort(compareByIp);

  // 非法 state 时补一条可读原因，否则面板只看到 error 却不知道为什么
  const reason = toReasonOrNull(source.reason) ?? (state === INVALID_STATE ? '状态值非法' : null);

  // 契约 5 的 extra 是给后续扩展预留的，当前快照结构固定，故不透传，避免污染面板契约
  return {
    state,
    enabled: Boolean(source.enabled),
    reason,
    lastProbeAt: toTimestampOrNull(source.lastProbeAt),
    nextRetryAt: toTimestampOrNull(source.nextRetryAt),
    entries,
    stats: countStats(entries),
  };
}
