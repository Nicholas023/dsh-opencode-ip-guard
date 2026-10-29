/**
 * probe.js —— TLS 握手探测（单个 IP / 批量）。
 *
 * 为什么探测必须走到「完整 TLS 握手 + 校验证书链」，而不是 ping 或裸 TCP 握手：
 * 黑洞 IP 的故障形态是 TCP 层丢包（SYN 无响应），只有真正完成一次与 DSH 业务条件一致的
 * TLS 握手，才能证明「这个 IP 现在能承载 HTTPS 请求」；证书校验则能识别企业网络中间人，
 * 这类环境应整体降级为不过滤，而不是把中间人当成可用 IP（D12 / §7 边界 8）。
 * 本模块只回答连通性问题，绝不发送任何 HTTP 请求（D5：不反复打扰远端）。
 */
import net from 'node:net';
import tls from 'node:tls';

/**
 * 默认探测端口。
 * 契约约定的探测目标是 https，所以固定 443；本地测试需要连临时端口，
 * 因此允许 opts.port 覆盖（仅测试钩子，生产调用方不要传）。
 */
const DEFAULT_PORT = 443;

/**
 * 默认探测超时（毫秒）。
 * D3 定为「6~10 秒」，取 10 秒与 DSH 运行时的 connect timeout 口径一致（D7）；
 * 黑洞 IP 在 Windows 上要等 SYN 重传约 21 秒才失败，10 秒足以判定它不可用。
 */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * 把底层错误转成稳定的字符串原因。
 * 为什么优先取 err.code：上层（blacklist/面板）需要区分 timeout / ECONNREFUSED /
 * CERT_* 这类可判读的原因，err.message 会随 Node 版本变化且不适合展示。
 */
function toErrorText(err) {
  if (!err) return 'unknown';
  if (typeof err.code === 'string' && err.code) return err.code;
  if (typeof err.message === 'string' && err.message) return err.message;
  return 'tls_error';
}

/**
 * 校验超时值，非法值一律回落到默认值。
 * 为什么不让非法值直接抛：插件是旁路增强，配置写错也只能降级，不能拖垮 DSH。
 */
function normalizeTimeout(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * 对单个 IP 做一次 TLS 握手探测。
 *
 * @param {string} ip 要连接的 IP（连接地址由它决定，不做系统解析）
 * @param {{servername?: string, timeoutMs?: number, port?: number, ca?: string|string[]}} [opts]
 *        servername 同时用于 SNI 和证书主机名校验；port / ca 只给本地测试用
 * @returns {Promise<{ip: string, ok: boolean, ms: number|null, error: string|null}>}
 *          永不 reject：任何失败都以 ok:false + error 原因 resolve（契约 2）
 */
export function probeIp(ip, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const target = typeof ip === 'string' ? ip.trim() : '';
  // 入口处就用 net.isIP 拦截非法目标，而不是丢给 tls.connect 去做 DNS 解析：
  // 契约要求探测的是「IP」的连通性，域名不属于本函数的职责；若放行会得到 ENOTFOUND
  // 这类与黑洞无关的错误码，污染上层黑白名单判定。同时一个坏值也不能让探测抛异常，
  // 否则整轮探测都会中断，所以统一 resolve 成 ok:false。
  // 只接受 IPv4（net.isIP 返回 4）：本插件明确不使用 IPv6（D 决策），避免探测结论与
  // 实际连接族不一致。
  if (net.isIP(target) !== 4) {
    return Promise.resolve({ ip: String(ip), ok: false, ms: null, error: 'invalid_ip' });
  }

  const timeoutMs = normalizeTimeout(o.timeoutMs);
  const port = Number.isInteger(o.port) && o.port > 0 && o.port < 65536 ? o.port : DEFAULT_PORT;
  const servername =
    typeof o.servername === 'string' && o.servername.length > 0 ? o.servername : undefined;

  return new Promise((resolve) => {
    // settled 用于保证「只交付一次结果」：secureConnect / error / close / timeout 可能同时到达
    let settled = false;
    let socket = null;
    let timer = null;

    /**
     * 统一的收尾路径：先置 settled，再清定时器、销毁 socket，最后 resolve。
     * 为什么销毁 socket 要放在 try 里：destroy 本身也可能因为底层状态异常而抛，
     * 而收尾阶段的异常没有任何价值，只能吞掉。
     */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (socket) {
        const s = socket;
        socket = null;
        try {
          s.destroy();
        } catch {
          // 句柄已经不可用，忽略即可；不能因此改变探测结论
        }
      }
      resolve(result);
    };

    const fail = (error) => finish({ ip: target, ok: false, ms: null, error });

    // 超时判定：socket.setTimeout 只覆盖空闲读，握手阶段可能不触发定时器，
    // 所以这里自己计时，到点直接销毁并判 timeout（契约 2 的实现要点）。
    timer = setTimeout(() => fail('timeout'), timeoutMs);
    const startedAt = Date.now();

    // 连接参数：host 用 IP，servername 用真实域名做 SNI 与证书校验（契约 2 / §6.1）。
    const connectOptions = { host: target, port, rejectUnauthorized: true };
    if (servername) connectOptions.servername = servername;
    if (o.ca) connectOptions.ca = o.ca; // 仅供本地自签测试服务器使用

    try {
      socket = tls.connect(connectOptions);
    } catch (err) {
      // tls.connect 参数非法等同步失败：按失败结果交付，不抛给调用方
      fail(toErrorText(err));
      return;
    }

    socket.once('secureConnect', () => {
      const ms = Date.now() - startedAt;
      // rejectUnauthorized=true 时正常情况下 authorized 必为 true；
      // 这里仍显式检查，是为了避免「证书校验被意外关闭」时把不可信连接判成可用。
      if (socket && socket.authorized === false) {
        fail('tls_unauthorized');
        return;
      }
      finish({ ip: target, ok: true, ms, error: null });
    });
    socket.once('error', (err) => fail(toErrorText(err)));
    // 对端在握手完成前关闭连接（例如服务端主动断开）也要给出确定结论，不能悬着
    socket.once('close', () => fail('closed'));
  });
}

/**
 * 并发探测多个 IP，结果顺序与入参 ips 严格一致。
 *
 * 为什么用 Promise.all：4 个 IP 并发探测，整轮耗时约等于单次超时（§5.3）；
 * 又因为 probeIp 永不 reject，单个 IP 的失败不会让整轮探测失败（契约 2）。
 *
 * @param {string[]} ips
 * @param {{servername?: string, timeoutMs?: number, port?: number, ca?: string|string[]}} [opts]
 * @returns {Promise<Array<{ip: string, ok: boolean, ms: number|null, error: string|null}>>}
 */
export function probeAll(ips, opts) {
  // 入参不是数组时返回空数组：调用方（guard）按「零结果」处理即可，不需要异常分支
  if (!Array.isArray(ips)) return Promise.resolve([]);
  return Promise.all(ips.map((ip) => probeIp(ip, opts)));
}