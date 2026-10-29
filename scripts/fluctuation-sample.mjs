// 波动采样: 每 20 秒探测一轮, 连续 12 轮(约 4 分钟), 观察同一 IP 的状态翻转频率
// 目的: 为「黑名单条目该不该加 TTL / 该不该失败重探」提供数据依据
import { probeAll } from '../src/probe.js';

const IPS = ['172.65.90.20', '172.65.90.21', '172.65.90.22', '172.65.90.23'];
const ROUNDS = 12;
const GAP_MS = 20000;

const history = [];
for (let i = 1; i <= ROUNDS; i++) {
  const results = await probeAll(IPS, { servername: 'opencode.ai', timeoutMs: 10000 });
  const row = results.map((r) => (r.ok ? 'OK(' + r.ms + ')' : 'BLACK'));
  history.push(row);
  console.log('#' + String(i).padStart(2) + '  ' + row.map((v, k) => IPS[k].split('.').pop() + '=' + v).join('  '));
  if (i < ROUNDS) await new Promise((r) => setTimeout(r, GAP_MS));
}

console.log('');
console.log('=== 每个 IP 的状态翻转次数（相邻两轮状态不同 = 1 次翻转）===');
for (let k = 0; k < IPS.length; k++) {
  let flips = 0;
  let black = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i][k] === 'BLACK') black++;
    if (i > 0 && history[i][k] !== history[i - 1][k]) flips++;
  }
  console.log(IPS[k] + ' -> 翻转 ' + flips + ' 次, 黑洞 ' + black + '/' + history.length + ' 轮');
}
// 全黑轮次（触发回退的风险）
const allBlack = history.filter((row) => row.every((v) => v === 'BLACK')).length;
console.log('全黑轮次: ' + allBlack + '/' + history.length);
