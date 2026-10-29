/**
 * client.js —— dsh-opencode-ip-guard 的客户端半区：会话头「IP 防护小卡」
 *
 * 形态（0.2.0-rc.2 官方客户端 bundle 契约，照抄本机已验证的 mac-tunnel 插件）：
 *   window.__ModuleLoader__.load({ id, factory })；factory 收 require，可 require('react')。
 *
 * 挂载点：conversation.session.header.utilities —— 常驻会话头、自动可见、零点击。
 *
 * 数据通道：轮询宿主侧 GET /opencode-ip-guard/status（由 src/index.js 用 webServer 注册）；
 *           点击时 POST /opencode-ip-guard/refresh 触发「重探 + 重建黑名单」（决策 D16）。
 *
 * ⚠️ 设计原则（安全第一）：整卡被 try/catch 包住，任何一步失败都只打印 console.warn，
 *    绝不向 DSH 抛出异常 —— 一个状态卡不该有能力影响会话渲染。
 *
 * @module dsh-opencode-ip-guard/client
 */
(function () {
  'use strict';

  /** 必须与 package.json 的 name 完全一致：客户端模块表按包名索引。 */
  var PLUGIN_ID = 'dsh-opencode-ip-guard';

  if (typeof window === 'undefined') return;

  var loader = window.__ModuleLoader__;
  if (!loader || typeof loader.load !== 'function') {
    console.warn('[' + PLUGIN_ID + '] 需要 DSH >= 0.2.0-rc.2 的客户端模块系统，已跳过注册。');
    return;
  }

  /** 状态查询端点（必须与 src/index.js 的 STATUS_ROUTE 一致）。 */
  var STATUS_URL = '/opencode-ip-guard/status';

  /** 手动重探端点（必须与 src/index.js 的 REFRESH_ROUTE 一致）。 */
  var REFRESH_URL = '/opencode-ip-guard/refresh';

  /**
   * 轮询间隔（毫秒）：60 秒。
   * 决策 D18 要求「上次探测：X 分钟前」每分钟刷新，正好用轮询驱动重绘；
   * 再密没有意义（探测本身只在启动/点击/重试时发生），只会白刷请求。
   */
  var POLL_MS = 60000;

  /** 挂载点：会话头右侧工具区（与 mac-tunnel 同款）。 */
  var SLOT = 'conversation.session.header.utilities';

  /**
   * 各状态的外观。
   *
   * 颜色一律用官方主题变量，不硬编码：硬编码按一套主题挑的色，换主题就失真。
   * - ready：绿（正在过滤）
   * - probing：黄（正在探测）
   * - idle：灰（还没开始探测）
   * - degraded：黄（探测全失败，已放弃过滤，需要用户注意但不致命）
   * - failed：红（重试用尽）
   * - disabled_by_proxy：灰（用户配了代理，插件主动禁用，属于预期行为）
   * - error：红（面板自身拿不到数据）
   */
  var STATE_VIEW = {
    ready: { dot: 'var(--state-success-primary, #2ea043)', label: null },
    probing: { dot: 'var(--state-warn-primary, #d29922)', label: 'IP 防护：探测中…' },
    idle: { dot: 'var(--label-tertiary, #8b949e)', label: 'IP 防护：待探测' },
    degraded: { dot: 'var(--state-warn-primary, #d29922)', label: 'IP 防护：已降级（未过滤）' },
    failed: { dot: 'var(--state-error-primary, #f85149)', label: 'IP 防护：探测失败' },
    disabled_by_proxy: { dot: 'var(--label-tertiary, #8b949e)', label: 'IP 防护：代理下禁用' },
    error: { dot: 'var(--state-error-primary, #f85149)', label: 'IP 防护：异常' },
  };

  /**
   * 取某状态的外观（未知状态按 idle，避免因为后端多一个状态就渲染崩掉）。
   *
   * @param {string} state - 状态名。
   * @returns {{dot: string, label: string|null}} 外观。
   */
  function viewOf(state) {
    return STATE_VIEW[state] || STATE_VIEW.idle;
  }

  /**
   * 把 Unix 毫秒换算成「X 分钟前」这类人话。
   *
   * @param {number|null} timestamp - Unix 毫秒；null/非法时视为尚未探测。
   * @returns {string} 相对时间文案。
   */
  function relativeTime(timestamp) {
    if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return '尚未探测';
    var diff = Math.max(0, Date.now() - timestamp);
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '刚刚';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    return Math.floor(hours / 24) + ' 天前';
  }

  /**
   * 把未来的 Unix 毫秒换算成「X 分钟后」这类人话（用于 nextRetryAt）。
   *
   * 为什么不复用 relativeTime 再替换「前」为「后」：未来时间在 relativeTime 里会被夹成 0
   * 而显示「刚刚」，字符串替换根本对不上——那是个会静默显示错误信息的写法。
   *
   * @param {number|null} timestamp - 目标时刻（Unix 毫秒）。
   * @returns {string|null} 文案；非法值返回 null（调用方据此决定是否显示该行）。
   */
  function futureTime(timestamp) {
    if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return null;
    var diff = timestamp - Date.now();
    if (diff <= 0) return '即将';
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '不到 1 分钟';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟后';
    return Math.floor(minutes / 60) + ' 小时后';
  }

  /**
   * 统计黑洞数量。
   * 优先用 stats.black（后端权威值），缺失时退回扫描 entries —— 面板不该因为少一个字段就显示错误数字。
   *
   * @param {object} data - StatusSnapshot。
   * @returns {number} 黑洞 IP 数量。
   */
  function blackCount(data) {
    if (data && data.stats && typeof data.stats.black === 'number') return data.stats.black;
    var entries = data && Array.isArray(data.entries) ? data.entries : [];
    var count = 0;
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i] && entries[i].state === 'black') count += 1;
    }
    return count;
  }

  /**
   * 把一条探测结果渲染成一行 tooltip 文本：IP · 状态 · 耗时 · 错误原因。
   *
   * @param {object} entry - BlacklistEntry。
   * @returns {string} 单行文本；entry 非法时返回空串。
   */
  function entryLine(entry) {
    if (!entry || typeof entry.ip !== 'string') return '';
    var parts = [entry.ip, entry.state === 'black' ? '黑洞' : '可用'];
    if (typeof entry.ms === 'number') parts.push(Math.round(entry.ms) + 'ms');
    if (entry.error) parts.push(String(entry.error));
    return parts.join(' · ');
  }

  /**
   * 组装 tooltip：状态 + 上次探测 + 每个 IP 的明细 + 统计 + 操作提示。
   *
   * @param {object} data - StatusSnapshot。
   * @returns {string} 多行文本。
   */
  function buildTooltip(data) {
    var entries = data && Array.isArray(data.entries) ? data.entries : [];
    var lines = ['状态：' + String((data && data.state) || 'unknown')];

    lines.push('上次探测：' + relativeTime(data && data.lastProbeAt));

    // nextRetryAt 只在 degraded/failed 时有意义，非空才显示，避免「下次重试：尚未探测」这种噪音。
    var retryIn = data ? futureTime(data.nextRetryAt) : null;
    if (retryIn) lines.push('下次重试：' + retryIn);

    if (entries.length > 0) {
      lines.push('IP 明细：');
      for (var i = 0; i < entries.length; i += 1) {
        var line = entryLine(entries[i]);
        if (line) lines.push('  ' + line);
      }
    } else {
      lines.push('IP 明细：（暂无）');
    }

    if (data && data.stats) {
      lines.push('统计：可用 ' + Number(data.stats.ok || 0)
        + ' / 黑洞 ' + Number(data.stats.black || 0)
        + ' / 共 ' + Number(data.stats.total || 0));
    }

    if (data && data.reason) lines.push('说明：' + String(data.reason));

    lines.push('点击立即重探（每 ' + Math.round(POLL_MS / 1000) + ' 秒自动刷新）');
    return lines.join('\n');
  }

  loader.load({
    id: PLUGIN_ID,

    /** @param {(spec: string) => any} require 平台种子表 / 已注册 factory */
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var React = require('react');

      // ────────────────────────── 组件 ──────────────────────────

      /**
       * IP 防护小卡：一个状态圆点 + 一句话，悬停看明细，点击立刻重探。
       *
       * @returns {object} React 元素。
       */
      function StatusChip() {
        // 初值刻意用 idle：还没拿到数据前展示「待探测」，比展示「0 个黑洞」更诚实。
        var stateHook = React.useState({ state: 'idle', reason: null, lastProbeAt: null, nextRetryAt: null, entries: [], stats: null });
        var data = stateHook[0];
        var setData = stateHook[1];

        var busyHook = React.useState(false);
        var busy = busyHook[0];
        var setBusy = busyHook[1];

        React.useEffect(function () {
          var alive = true;

          /** 拉一次状态；失败即把卡片置为异常（宿主没应答本身就是信息）。 */
          function poll() {
            fetch(STATUS_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
              .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
              })
              .then(function (json) {
                if (alive) setData(json && typeof json === 'object' ? json : {});
              })
              .catch(function (error) {
                if (!alive) return;
                setData({
                  state: 'error',
                  reason: '拿不到状态：' + String(error && error.message ? error.message : error),
                  lastProbeAt: null,
                  nextRetryAt: null,
                  entries: [],
                  stats: null,
                });
              });
          }

          poll();
          var timer = setInterval(poll, POLL_MS);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        }, []);

        var view = viewOf(data.state);
        var label = view.label || ('IP 防护：' + blackCount(data) + ' 个黑洞');
        var tip = buildTooltip(data);
        // 上次探测时间直接显示在卡面（D18），不只藏在 tooltip 里：
        // 用户扫一眼就该知道"这些数字是什么时候的"，不必悬停。
        var agoText = (typeof data.lastProbeAt === 'number' && data.lastProbeAt > 0)
          ? relativeTime(data.lastProbeAt)
          : null;

        /**
         * 点击重探：先 POST 触发刷新，再立刻拉一次状态。
         *
         * 为什么不直接用 refresh 的响应体渲染：即使 POST 失败（500/网络错），
         * 后面的 GET 仍能拿到当前真实状态，卡片不会卡在「刷新中」。
         */
        function refresh() {
          if (busy) return;
          setBusy(true);
          fetch(REFRESH_URL, { method: 'POST', headers: { accept: 'application/json' } })
            .catch(function (error) {
              console.warn('[' + PLUGIN_ID + '] 触发重探失败：' + String(error));
            })
            .then(function () {
              return fetch(STATUS_URL, { headers: { accept: 'application/json' }, cache: 'no-store' });
            })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.json();
            })
            .then(function (json) {
              setData(json && typeof json === 'object' ? json : {});
            })
            .catch(function (error) {
              // 不把卡片打成异常：下一轮轮询会自愈。
              console.warn('[' + PLUGIN_ID + '] 重探后取状态失败：' + String(error));
            })
            .then(function () {
              setBusy(false);
            });
        }

        return React.createElement(
          'button',
          {
            type: 'button',
            title: tip,
            onClick: refresh,
            'data-opencode-ip-guard': 'status',
            'aria-label': label,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '22px',
              padding: '0 8px',
              border: '1px solid var(--border-secondary, rgba(127,127,127,.3))',
              borderRadius: '999px',
              background: 'transparent',
              color: 'var(--label-secondary, inherit)',
              fontSize: '12px',
              lineHeight: '1',
              cursor: 'pointer',
              opacity: busy ? 0.6 : 1,
              whiteSpace: 'nowrap',
            },
          },
          React.createElement('span', {
            'aria-hidden': 'true',
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: view.dot,
              flex: '0 0 auto',
            },
          }),
          React.createElement('span', null, label),
          agoText
            ? React.createElement('span', {
                style: { color: 'var(--label-tertiary, #8b949e)', fontSize: '11px' },
              }, '· ' + agoText)
            : null,
        );
      }

      // ────────────────────────── 插件入口 ──────────────────────────

      /**
       * 注册到会话头工具区。
       *
       * @param {object} ctx - 客户端上下文（须含 slots）。
       * @returns {void}
       */
      function apply(ctx) {
        try {
          var registry = ctx && ctx.slots;
          if (!registry || typeof registry.inject !== 'function') {
            console.warn('[' + PLUGIN_ID + '] ctx.slots 不可用；已跳过 IP 防护卡。');
            return;
          }

          // kind: list（本卡是独立小项，不包装别人的渲染）。
          // order 41：排在 mac-tunnel 的路况卡（40）之后，避免抢占头部位置。
          registry.inject(SLOT, function () {
            return registry.register(
              { name: SLOT, id: 'opencode-ip-guard-status', order: 41 },
              StatusChip,
            );
          });

          console.log('[' + PLUGIN_ID + '] IP 防护卡已注册：' + SLOT);
        } catch (error) {
          // 这张卡绝不该拖垮会话渲染。
          console.warn('[' + PLUGIN_ID + '] IP 防护卡注册失败：' + String(error));
        }
      }

      exports.apply = apply;
      // ⚠️ 实测必须：不声明 inject 时访问 ctx.slots 会抛
      //    cannot get property "slots" without inject
      exports.inject = ['slots'];
      return module.exports;
    },
  });
}());
