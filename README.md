# dsh-opencode-ip-guard

> A DeepSeek Harness (DSH) plugin that removes the blackholed A records of `opencode.ai`
> from undici's DNS lookup, so DSH never dials a dead IP.

**English** | [简体中文](./README.zh.md)

---

## What problem does it solve?

`opencode.ai` has four A records: `172.65.90.20`, `.21`, `.22` and `.23`. Two of them,
`.20` and `.22`, are permanent black holes: TCP connections to port 443 are never answered,
and Windows only gives up after burning through its SYN retransmissions (~21 s).

DSH sends model requests through the Node built-in `fetch` (undici's global dispatcher),
whose default **connect timeout is 10 s**. So whenever DNS happens to put a blackholed IP
first, DSH fails after 10 s, and llm-retry retries up to 5 times with backoff — up to
74–78 s with no model output at all, which looks exactly like a freeze.

This plugin takes over undici's `connect.lookup` first, then probes every A record in the
background with a full TLS handshake and keeps the timed-out/failed ones in an in-memory
blacklist. From then on every resolution of `opencode.ai` is filtered against that
blacklist and only a reachable IPv4 is returned, so DSH only ever connects to `.21` / `.23`.

- Root-cause report (Chinese): [docs/planning/DSH-opencode-长连接失效根因报告.md](docs/planning/DSH-opencode-长连接失效根因报告.md)
- Interface contracts: [docs/CONTRACTS.md](docs/CONTRACTS.md)
- Design decisions D1–D20: [docs/planning/grill-决策记录.md](docs/planning/grill-决策记录.md)

---

## How it works (30-second version)

1. After the plugin is mounted it installs a custom undici Agent as the global dispatcher,
   replacing `connect.lookup` with its filtering function. The blacklist is still empty at
   this point (i.e. no filtering), so "hijack first, probe later" cannot disturb any request.
2. It then probes **asynchronously** (DSH startup is not blocked): it resolves all A records
   of `opencode.ai` and performs a **TCP + full TLS handshake** against each IP (SNI =
   `opencode.ai`, certificate chain verified, 10 s timeout, **no HTTP request is sent**).
3. Handshake succeeds = usable (latency recorded); timeout or failure = black hole.
4. For every later request to `opencode.ai`: `dns.resolve4` → drop blacklisted IPs →
   return the first usable IPv4. If resolution fails it falls back to the system resolver;
   if filtering leaves nothing it falls back to the original list. Those two fallbacks are
   what guarantee "a bug in this plugin can never cut DSH off the network".
5. If **every** probe fails (e.g. local network outage) the blacklist is not applied
   (native behaviour), the plugin retries after 60 s, then after 120 s, and gives up after
   the third failure (`state=failed`).
6. If a proxy is configured, the plugin **disables itself** instead of overwriting DSH's
   proxy dispatcher (`state=disabled_by_proxy`). If `NO_PROXY` explicitly covers
   `opencode.ai` (that traffic never goes through the proxy), the plugin keeps working.

Deliberately **not** done: no hosts edits, no system DNS changes, no keep-alive tuning,
no change to the default 10 s connect timeout, no persistence, no changes to DSH business code.
Probing only happens at startup, on degraded retries and on user refresh — there is no
periodic polling of the remote side.

---

## Installation

**Prerequisites**

- DSH installed and starting normally (the plugin runs inside the DSH process; you do not
  need a separate Node install).
- DSH's bundled Node ≥ 22.19.0 (current releases ship Node 24.x).
- No HTTP(S) proxy configured: users behind a proxy do not need this plugin, and the plugin
  disables itself when one is detected (see "Known limitations").

The commands below use PowerShell; the profile directory defaults to
`$env:USERPROFILE\.dsh\profiles\desktop`.

### Option 1: npm (once the package is published)

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add dsh-opencode-ip-guard
```

### Option 2: tgz (offline / internal distribution)

```powershell
# In the plugin repo root, build the tarball (dsh-opencode-ip-guard-0.1.0.tgz)
pnpm pack

# Then install it into the profile
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "file:D:\path\to\dsh-opencode-ip-guard-0.1.0.tgz"
```

### Option 3: local link (development)

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:D:\DSH-Files-v2\02-DSH开发\dshapi长连接插件"
```

### Final step: register the bundle and restart DSH

Add the package name to `dsh.profile.bundles` in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "mac-tunnel",
        "dsh-opencode-ip-guard"
      ]
    }
  }
}
```

Then fully quit DSH and start it again. Host plugins are loaded at process start and the
client panel is loaded with the Web GUI; hot reload only applies to configuration, so a new
package (or a code change) always needs a restart.

---

## Configuration

Everything is optional. Override it by id in the profile's `cordis.patch.yml`:

```yaml
- id: opencode-ip-guard
  config:
    hostname: 'opencode.ai'        # domain to protect
    probeTimeoutMs: 10000          # TLS handshake timeout per IP (ms)
    enabled: true                  # master switch
    forceIps: []                   # test hook: when non-empty, skip real DNS and use these IPs only
    retryDelaysMs: [60000, 120000] # probe retry delays (ms) after a total failure
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `hostname` | string | `'opencode.ai'` | Domain to protect. Protecting exactly one domain is intentional; this is not a generic IP optimiser. |
| `probeTimeoutMs` | number | `10000` | TLS handshake timeout per IP; also used as undici's connect timeout (the two intentionally share one value, defaulting to the 10 s used by DSH). All IPs are probed concurrently, so one round takes roughly this long. |
| `enabled` | boolean | `true` | Master switch. `false` means no probing and no dispatcher installation (as if not installed). |
| `forceIps` | string[] | `[]` | Test hook: when non-empty, real DNS is ignored and only these IPs are filtered/selected. Used by acceptance test 3. |
| `retryDelaysMs` | number[] | `[60000, 120000]` | Retry delays after a total probe failure. When the list is exhausted the state becomes `failed` and probing stops. |

**Value validation** — invalid values fall back to defaults with a single warning; they never
throw and never break DSH startup:

- `probeTimeoutMs` is clamped to 2000–30000 ms;
- `retryDelaysMs` accepts only non-negative finite numbers; an empty result falls back to defaults;
- `forceIps` accepts only valid IPv4 literals;
- `hostname` must be a non-empty string (trimmed and lower-cased);
- `enabled` accepts booleans only.

---

## Panel and status endpoints

When enabled, a small card appears in the conversation session header (same mount point as
mac-tunnel):

- normally shows "**IP 防护：N 个黑洞**" (IP guard: N black holes);
- hovering expands each IP's `state` (ok / black) and TLS handshake latency;
- shows "上次探测：X 分钟前" (last probe: X minutes ago), updated every minute;
- clicking it sends `POST /opencode-ip-guard/refresh`, re-probes and **rebuilds** the
  blacklist from the new results (recovered IPs are removed);
- polls the status every 60 s;
- colours: green when ready, yellow while probing/degraded, red when failed/errored, grey with a reason when disabled by proxy or switched off in config.

The host side exposes two routes on the DSH Web GUI port:

```powershell
# status snapshot
Invoke-RestMethod "http://127.0.0.1:<DSH_PORT>/opencode-ip-guard/status" | ConvertTo-Json -Depth 6

# re-probe and rebuild the blacklist
Invoke-RestMethod -Method Post "http://127.0.0.1:<DSH_PORT>/opencode-ip-guard/refresh" | ConvertTo-Json -Depth 6
```

`state` values:

| state | Meaning |
|---|---|
| `idle` | Probing has not started yet (or `enabled: false` in config) |
| `probing` | Probing in progress |
| `ready` | Probing finished, blacklist active |
| `degraded` | All probes failed, filtering suspended, retrying per `retryDelaysMs` |
| `failed` | Retries exhausted, giving up (no filtering for the rest of this run) |
| `disabled_by_proxy` | Proxy detected, plugin disabled itself |
| `error` | Internal error, degraded |

---

## Acceptance tests

Full steps, expected results and failure interpretation: **[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)**
(Chinese). Quick reference:

### 1 · Connection observation

```powershell
# Trigger one model request in DSH, then sample port-443 peers
1..20 | ForEach-Object {
  Get-NetTCPConnection -RemotePort 443 -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -like '172.65.*' } |
    Select-Object -ExpandProperty RemoteAddress
  Start-Sleep -Milliseconds 500
} | Sort-Object -Unique
```

**Expected**: only `172.65.90.21` / `172.65.90.23`; never `.20` / `.22`.

### 2 · On/off latency comparison

With the plugin on, 20 requests stay in the 1–2 s range; with it off the same batch may show
>10 s spikes (black-hole connect timeout). Compare p50/p90/max. Note that `curl.exe` does not
go through the plugin — only DSH's own undici traffic does — so the comparison must exercise
the Node `fetch` path. Save the `acceptance-2.mjs` script from the
[acceptance manual](docs/ACCEPTANCE.md) into the repo root, then run:

```powershell
# baseline with the plugin off (native behaviour)
node acceptance-2.mjs off 20
# plugin on (filtered dispatcher installed in-process)
node acceptance-2.mjs on 20
```

### 3 · Forced black-hole injection (negative control)

```yaml
# Put this in the profile's cordis.patch.yml, then restart DSH
- id: opencode-ip-guard
  config:
    forceIps: ['172.65.90.20', '172.65.90.21']
```

**Expected**: requests succeed in ~1 s and only `.21` is used, while a control
`curl.exe --resolve` against `.20` times out after 10 s.

> Note: `forceIps` must contain at least one usable IP. If it contains black holes only,
> filtering leaves nothing, the contract mandates falling back to the original list, and the
> connection still goes to a black hole. That is the "never break connectivity" safety net,
> not a bug.

---

## Known limitations

1. **Only `opencode.ai`.** No generic IP optimisation; changing `hostname` changes the
   protected domain, but the probe/certificate logic is built around that one host.
2. **No persistence.** The blacklist lives only for this DSH run and is rebuilt on every
   start; between start and probe completion nothing is filtered (native behaviour).
3. **Changing the proxy at runtime has no effect.** Proxy detection runs once at startup;
   restart DSH after changing proxy settings.
4. **An opencode IP-pool change can invalidate the blacklist.** IPs not seen during this run
   are passed through (never blocked), but stale black-hole verdicts may no longer match;
   restart DSH to re-probe.
5. **A corporate TLS man-in-the-middle causes automatic degradation.** Probes verify the full
   certificate chain; an MITM certificate makes every IP fail → the "total failure" fallback
   stops filtering and the panel/status shows `degraded` or `failed`.
6. **Depends on undici's `connect.lookup` behaviour.** Verified against undici 8.x
   (`^8.11.2`); a future major undici change to the lookup contract would need an update here.
   At startup the plugin performs a capability check and skips the takeover (no filtering)
   when a required API is missing.
7. **Does not address idle-connection recycling.** No keep-alive tuning (intentional); this
   plugin only prevents dialling black holes.
8. **Only the Node built-in fetch / undici path is affected.** `curl`, browsers and other
   non-undici HTTP clients bypass the plugin entirely.
9. **IPv4 only (`dns.resolve4`).** On IPv6-only networks resolution is empty and falls back
   to the system resolver, where filtering does not apply.
10. **Probing needs real outbound TLS.** If a firewall blocks 443, probing fails entirely and
    the plugin degrades to no filtering.

---

## Interoperability

- **Proxy plugins / DSH's own `installProxyFromEnvironment()`**: when a proxy is detected this
  plugin does **not** install its dispatcher, so the proxy chain is never overwritten; the
  trade-off is that the plugin is inactive (which is fine — proxied users do not need it).
  Exception: if `NO_PROXY` covers `opencode.ai`, that traffic never uses the proxy and the
  plugin keeps working.
- **Any plugin that calls `setGlobalDispatcher`**: there is only one global dispatcher and the
  last installer wins. Do not enable two dispatcher-replacing plugins at once — nothing
  crashes, but one of them silently does nothing.
- **mac-tunnel**: different layer (SSH port forwarding, not undici), no conflict; this plugin
  never touches its ssh connections.
- **Panel plugins** (dsh-ops, dsh-phone, ...): different mount points, no interference.
- The plugin does not edit other profile config, does not write files, and reports nothing
  to any remote service.

---

## Development and tests

Module layout: [implementation plan §4](docs/planning/实现方案-黑洞IP过滤插件.md).

```powershell
# Unit tests (network-free cases must pass without network access)
node --test "test/*.test.mjs"

# Note: do not run bare `node --test` — Node 24's auto-discovery also picks up
# scripts/acceptance.mjs, which performs real network requests and hangs; and do not
# pass a directory (`node --test test/`) — Node 24 treats it as a module path and
# fails with MODULE_NOT_FOUND.
```

The only runtime dependency is `undici` (`^8.11.2`); no other third-party packages are used.

---

## License

[Apache License 2.0](./LICENSE), Copyright 2026 Nicholas023.

You may use, modify and redistribute this plugin (including commercially) provided the
license and copyright notices are retained. The software is provided without warranty.
