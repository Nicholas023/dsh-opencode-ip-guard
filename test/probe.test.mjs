/**
 * probe.js 单元测试。
 *
 * 全部使用回环地址 + 自签证书，不依赖外网：
 *  - 「成功」路径必须有一个能真正完成 TLS 握手的服务端 → 本地 tls 服务器；
 *  - 「超时」路径必须有一个只接 TCP、永不回 ServerHello 的服务端 → 本地裸 net 服务器；
 * 两种情况都能稳定构造，才敢断言探测结论，而不是靠真实网络的运气。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { probeIp, probeAll } from '../src/probe.js';

// 本地测试专用的自签证书（CN=localhost，SAN 含 localhost / 127.0.0.1）。
// 为什么把证书写死在测试里：测试不依赖 openssl 等外部工具，任何人 clone 下来就能跑；
// 它只用于本机回环，没有机密性，过期也要到 2036 年。
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUY4I0I0KKBBa+af4HP3msBc4ueIowDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyOTA4MDE1M1oXDTM2MTAy
NjA4MDE1M1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAi/VzKzxOvw2Vz090cFtsQq1uYH4Ven9CQETh/Z95m3eB
QnuTHD3+r1UVnZAipx2x5lXSez+owf48dOAsISZi/o7r7NjDGDqCJ3N9KALruIob
7Bbl4XXLIKnIxIPDQcBolwwDq2J6zhklkxZyviPQNphA1JAsH7I95UjVvFIRYISo
NapH7CLbMoICFZyC7Ik+PHR7ZXkGqzIyqXhxvdCV/YruRrxSStMTJu4LoHnhXqsl
EWlcrZ7eL0mPSGGSmitnMwrqnSqXWOkKyR9SjjUwQY7gaVEKPTFI8EiO4OGXPfYJ
T0X6/fe8ImxqcXPekTbsHc+fgOQVd9Jyvb8CpRlvFQIDAQABo28wbTAdBgNVHQ4E
FgQUAEc56WfjEuFTaXH46o446trkwrMwHwYDVR0jBBgwFoAUAEc56WfjEuFTaXH4
6o446trkwrMwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAEMQhBLNShfB7BK91nYqbspJwhLoGdMh
xpIpl+OMV4qolGCtOwy0vynIMxYR1/z8pMSbVi0z2W2fDhlmpWzQHD7448v+K6W5
a1fPCgph7D0xftg50tZ+dL2/0jQFWEWZ+g9ZyYC/MZ623TFteAsHpCT+Ns40sShs
BHOsJCebtiF6HAD7MQpY1RMEvEMZHqLqQujyuSTiR7R9+QWVgucarJhA4a4GUgQs
1eaIr20yvCds1iesR5tIPYOThGOOY9JFTK/4uER4BynP3BWyaFyS6i62K/Fd2ToH
3jfjDhFoudEA6ubfs9vZAJwAcVw6xi3z35QtJOaaC7YInW2Ta7Unc40=
-----END CERTIFICATE-----`;

// 与上面证书配对的私钥，同样只用于回环测试。
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCL9XMrPE6/DZXP
T3RwW2xCrW5gfhV6f0JAROH9n3mbd4FCe5McPf6vVRWdkCKnHbHmVdJ7P6jB/jx0
4CwhJmL+juvs2MMYOoInc30oAuu4ihvsFuXhdcsgqcjEg8NBwGiXDAOrYnrOGSWT
FnK+I9A2mEDUkCwfsj3lSNW8UhFghKg1qkfsItsyggIVnILsiT48dHtleQarMjKp
eHG90JX9iu5GvFJK0xMm7gugeeFeqyURaVytnt4vSY9IYZKaK2czCuqdKpdY6QrJ
H1KONTBBjuBpUQo9MUjwSI7g4Zc99glPRfr997wibGpxc96RNuwdz5+A5BV30nK9
vwKlGW8VAgMBAAECggEAG3QswLzmN3zbN5y+2vFcBaJOhfgFj49Z+BBrAhyftprV
DKz/2OjiRhNbF5q36W8eP+/yx0FgAZm00zpL/b6xaXywk7ebYWvMrx9s3AXipkLV
IlUFh9na3A/h9YZhLUsoWQS+zYYWT8pIABfFrz2IMMVh5jBXr2n/0TOd1YCFrxhc
QZ9+TanYv+3m4adMJr2FzPkpSwUvesjTrwXB85fa80JXJWth6it1AFLO+UroWIS9
SetvXt9vGWEnsIs2SSnbKHAt/pSP57c0JwaMl9czNIoNjHnZ5+erm/HL35pjP9bz
CLl/lbaAB0sDr0Xvb//3RwnMO4p8iabqxBV6jG2bOwKBgQC+NMMWOy+wZMJgNNRt
bw+eFwvS+9jc6J2wl2FSIZzXepH7k7X8lPefKxwewrtQ3pU4faRzhwX/V9N9HZom
sjyNYmqWvZSkXR3YAzNCNLh0gvO40TbIS+onDVaMnvtIAyvyaenOuErM2BZr6tn4
0nrdwNZPwembvO0uFzZ9aOsD0wKBgQC8XyjPohx4SEEdXI0ktp+zHSzfK+nkuFQT
/bCg32eUHPgLOk6+gUSQWuQ/9r+TyZ14Y0jxRPgoapaUIS68qIj549YTcASzAWMm
8JpgLPbkjYYTBdQsgBZNxh9JQGkvWnK7EhNVJAebVBzXrbB0lkWfwz0r/odLGXdn
+jIVJJm4dwKBgQCYUSRRL0B3X5kQ9f2PTTsSfJ4pbSkzbsyo1/FFlklFfZBeCOHZ
zWmm+xzfvU3H6xdQT71cDqrM2oYwUX5asq0vA7sbz+Gy5ia6D4YC5Lk6BIwsWs4m
BDUU5OeEYOQVvQR6cjqcIpU0CW+bKE05p0RhRMXaxQzQfLDrEge+0kAxpQKBgEhF
WisPT0z2q8TQFXbYej0GHIkjGAGgluF0m6edDuhMlP35yOxePCgGNzwzNx1EZR4j
OYEXrP4UpuD+Oig3oRX+y8t5VtQ23Au8k/4CQlc91QrHWbgZDHWaZbZ8994rHYmY
TcKEqEZ35vj4spKIdP3usjGG3fF6O82wuDZUbIXRAoGAGVS0oO1WITTA3lemxlow
CAHuDUXezr02l0kAmFLi6/Y2e1jKHUurAKyj/dUr+foSmXysuINXeQdDwbpwgM0i
BsZQ2rfIhE75i6NYxa+GYRRaD9U1tEtWF8glrOEtC1M/mA84vwFdrLAN/8ZWNQf4
e8hsH7KfdYPYvm4FseVzp9A=
-----END PRIVATE KEY-----`;

/** 监听回环的 0 号端口（由系统分配），返回端口号；用 0 号端口避免测试之间抢端口。 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * 连接跟踪器：记录服务端接受的每条连接及其 close 事件。
 * 为什么必须跟踪 close 事件而不是轮询 destroyed 标志：
 * 客户端 destroy 后服务端会收到 close，这是「客户端句柄已释放」的直接证据；
 * 而轮询若写成自我续期的 setTimeout，会在测试结束后留下永不清理的定时器，
 * 让 node --test 进程无法退出（本轮踩过的坑）。
 */
function createConnectionTracker() {
  const records = [];

  function track(socket) {
    let markClosed;
    const closed = new Promise((resolve) => {
      markClosed = resolve;
    });
    socket.once('close', () => markClosed(true));
    // 服务端 socket 的错误（对端重置等）在测试里没有价值，必须挂空处理避免 uncaught
    records.push({ socket, closed });
    return socket;
  }

  /** 等待当前已记录的所有连接关闭；超时返回 false（不遗留任何定时器）。 */
  function waitAllClosed(timeoutMs) {
    if (records.length === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let remaining = records.length;
      const timer = setTimeout(() => resolve(false), timeoutMs);
      for (const record of records) {
        record.closed.then(() => {
          remaining -= 1;
          if (remaining === 0) {
            clearTimeout(timer);
            resolve(true);
          }
        });
      }
    });
  }

  /** 强制销毁所有已记录连接，保证 server.close() 不会因为连接还开着而卡住。 */
  function destroyAll() {
    for (const record of records) {
      try {
        record.socket.destroy();
      } catch {
        // 已销毁的连接无需处理
      }
    }
  }

  return { track, waitAllClosed, destroyAll };
}

/** 关闭服务器：先销毁残留连接，再等 close 回调，确保测试进程能正常退出。 */
function closeServer(server, tracker) {
  tracker.destroyAll();
  return new Promise((resolve) => server.close(() => resolve()));
}

test('probeIp：本地自签 TLS 服务器握手成功，返回 ok/ms 且不残留连接', async () => {
  const tracker = createConnectionTracker();
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT });
  // 在 TCP 连接建立时就跟踪：secureConnection 回调在客户端 secureConnect 之后才会触发，
  // 若挂在那里，探测可能已经 resolve 而服务端还没记录到连接，close 断言就会误判。
  server.on('connection', (socket) => {
    // 只记录连接，不主动关闭：探测成功与否必须由客户端（probe）自己决定
    tracker.track(socket);
  });
  const port = await listen(server);
  try {
    const result = await probeIp('127.0.0.1', {
      servername: 'localhost',
      timeoutMs: 3000,
      port,
      ca: TEST_CERT,
    });
    assert.equal(result.ip, '127.0.0.1');
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.ms, result.ms); // NaN 自检（NaN !== NaN）
    assert.ok(typeof result.ms === 'number' && result.ms >= 0, '成功时必须给出握手耗时');

    // 探测结束后客户端 socket 必须已销毁，服务端应观察到连接关闭
    const closed = await tracker.waitAllClosed(1000);
    assert.equal(closed, true, 'probeIp 成功分支必须 destroy socket');
  } finally {
    await closeServer(server, tracker);
  }
});

test('probeIp：只接 TCP 不握手的服务端被判为 timeout', async () => {
  const tracker = createConnectionTracker();
  // 裸 net 服务器：接受连接后什么都不做，模拟黑洞 IP「TCP 建连后对 TLS 无响应」
  const server = net.createServer((socket) => {
    tracker.track(socket);
  });
  const port = await listen(server);
  try {
    const result = await probeIp('127.0.0.1', { servername: 'localhost', timeoutMs: 300, port });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'timeout');
    assert.equal(result.ms, null);
  } finally {
    await closeServer(server, tracker);
  }
});

test('probeIp：自签证书未受信时失败原因带 TLS 错误码，而不是 timeout', async () => {
  const tracker = createConnectionTracker();
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT });
  // 在 TCP 连接建立时就跟踪：secureConnection 回调在客户端 secureConnect 之后才会触发，
  // 若挂在那里，探测可能已经 resolve 而服务端还没记录到连接，close 断言就会误判。
  server.on('connection', (socket) => {
    tracker.track(socket);
  });
  const port = await listen(server);
  try {
    // 不传 ca：证书链无法验证，握手必须失败；错误码应透传 Node 的 CERT_* / SELF_SIGNED 等
    const result = await probeIp('127.0.0.1', { servername: 'localhost', timeoutMs: 3000, port });
    assert.equal(result.ok, false);
    assert.equal(result.ms, null);
    assert.notEqual(result.error, 'timeout');
    assert.match(String(result.error), /CERT|SELF_SIGNED|VERIFY|ALTNAME|UNABLE/i);
  } finally {
    await closeServer(server, tracker);
  }
});

test('probeIp：连接被拒绝时返回 ECONNREFUSED 类错误码', async () => {
  // 先占一个端口再关掉，保证这个端口上没有人监听（回环上几乎不会被别人抢走）
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const result = await probeIp('127.0.0.1', { servername: 'localhost', timeoutMs: 3000, port });
  assert.equal(result.ok, false);
  assert.equal(result.ms, null);
  assert.match(String(result.error), /ECONNREFUSED|ECONNRESET/i);
});

test('probeIp：非法 IP 直接判失败且不抛异常', async () => {
  const result = await probeIp('', { servername: 'localhost', timeoutMs: 100 });
  assert.deepEqual(result, { ip: '', ok: false, ms: null, error: 'invalid_ip' });
  await assert.doesNotReject(() => probeIp(undefined, {}));
});

test('probeAll：结果顺序与入参一致，且单个失败不影响其他', async () => {
  const tracker = createConnectionTracker();
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT });
  // 在 TCP 连接建立时就跟踪：secureConnection 回调在客户端 secureConnect 之后才会触发，
  // 若挂在那里，探测可能已经 resolve 而服务端还没记录到连接，close 断言就会误判。
  server.on('connection', (socket) => {
    tracker.track(socket);
  });
  const port = await listen(server);
  try {
    const results = await probeAll(['bad-ip', '127.0.0.1', 'localhost'], {
      servername: 'localhost',
      timeoutMs: 3000,
      port,
      ca: TEST_CERT,
    });
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.ip),
      ['bad-ip', '127.0.0.1', 'localhost'],
    );
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, 'invalid_ip');
    assert.equal(results[1].ok, true);
    // 'localhost' 不是 IP：按契约同样走 invalid_ip 分支，不会抛出
    assert.equal(results[2].ok, false);
    assert.equal(results[2].error, 'invalid_ip');
  } finally {
    await closeServer(server, tracker);
  }
});

test('probeAll：非数组入参返回空数组，不抛异常', async () => {
  assert.deepEqual(await probeAll(null), []);
  assert.deepEqual(await probeAll('127.0.0.1'), []);
  assert.deepEqual(await probeAll([]), []);
});