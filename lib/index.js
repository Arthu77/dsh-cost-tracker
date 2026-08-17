// dsh-cost-tracker — 费用跟踪插件 Host 半。
// 通过 webServer 路由为浏览器端提供：
//   /api/cost-tracker/model           当前会话模型名
//   /api/cost-tracker/usage           按模型+高峰/非高峰时段累计的 token 用量
//   /api/cost-tracker/refresh-prices  抓取官方中文定价页（人民币）并解析
//   /api/cost-tracker/balance         账户余额（缓存，每 10 分钟后台刷新）
//   /api/cost-tracker/refresh-balance 立即刷新余额
export const inject = ['agents', 'web', 'credentials', 'shell', 'timer', 'webServer']

export function apply(ctx) {
  // 高峰时段：UTC 01:00-04:00 与 06:00-10:00（即北京时间 9:00-12:00、14:00-18:00）
  const isPeakHour = (t) => {
    const h = new Date(t).getUTCHours()
    return (h >= 1 && h < 4) || (h >= 6 && h < 10)
  }

  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    try { return JSON.parse(text || '{}') } catch { return {} }
  }
  function writeJson(res, status, data) {
    const text = JSON.stringify(data)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  // ── 当前会话模型名 ─────────────────────────────────────────────
  function currentModel(sessionId) {
    if (!sessionId) return null
    const agent = ctx.agents.get(sessionId)
    return agent === undefined || agent.options.model === undefined ? null : agent.options.model
  }

  // ── 按模型 + 时段累计 token 用量 ────────────────────────────────
  // request/context 事件只在 provider/model 变化时记录，之后的所有 usage
  // 都属于该模型；每个 usage 事件的时间戳决定其所在时段。
  function usageByModel(sessionId) {
    if (!sessionId) return { models: [], totals: null }
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return { models: [], totals: null }
    const zero = () => ({ uncached: 0, read: 0, write: 0, out: 0 })
    const byModel = new Map()
    const add = (model, usage, time) => {
      if (!byModel.has(model)) byModel.set(model, { peak: zero(), off: zero() })
      const slot = isPeakHour(time) ? byModel.get(model).peak : byModel.get(model).off
      slot.uncached += usage.inputTokens || 0
      slot.read += usage.cacheReadTokens || 0
      slot.write += usage.cacheWriteTokens || 0
      slot.out += usage.outputTokens || 0
    }
    let current = null
    for (const event of agent.session.events) {
      if (event.type === 'request/context') {
        current = event.data.model
      } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
        add(current === null ? 'unknown' : current, event.data.chunk.usage, event.time)
      } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
        add(current === null ? 'unknown' : current, event.data.usage, event.time)
      }
    }
    const models = []
    let totals = null
    for (const [model, b] of byModel) {
      models.push({ model, peak: b.peak, off: b.off })
      if (totals === null) totals = { uncached: 0, read: 0, write: 0, out: 0 }
      totals.uncached += b.peak.uncached + b.off.uncached
      totals.read += b.peak.read + b.off.read
      totals.write += b.peak.write + b.off.write
      totals.out += b.peak.out + b.off.out
    }
    return { models, totals }
  }

  // ── 抓取官方中文定价页并解析人民币价格 ──────────────────────────
  // 按「缓存命中」/「缓存未命中」/「百万tokens输出」三段锚点提取价格对
  // （元），用「非高峰=高峰半价」关系校验顺序；失败返回 ok:false。
  async function refreshPrices() {
    const res = await ctx.web.fetch({ url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing' })
    if (res.statusCode !== 200) return { ok: false, reason: 'HTTP ' + res.statusCode }
    const raw = res.body.kind === 'html' || res.body.kind === 'text' ? res.body.content : ''
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
    const yuanNums = (seg) => {
      const out = []
      for (const m of seg.matchAll(/(\d+(?:\.\d+)?)元/g)) out.push(parseFloat(m[1]))
      return out
    }
    const group = (label) => {
      const i = text.indexOf(label)
      if (i < 0) return null
      const nums = yuanNums(text.slice(i, i + 700))
      if (nums.length < 4) return null
      const near = (a, b) => Math.abs(a * 2 - b) < Math.max(0.01, b * 0.02)
      let off, peak
      if (near(nums[0], nums[2]) && near(nums[1], nums[3])) {
        off = [nums[0], nums[1]]
        peak = [nums[2], nums[3]]
      } else if (near(nums[2], nums[0]) && near(nums[3], nums[1])) {
        peak = [nums[0], nums[1]]
        off = [nums[2], nums[3]]
      } else {
        return null
      }
      return { off, peak }
    }
    const hit = group('缓存命中')
    const miss = group('缓存未命中')
    const out = group('百万tokens输出')
    if (hit === null || miss === null || out === null) return { ok: false, reason: '页面结构解析失败' }
    const flip = (v) => (v[0] > v[1] ? [v[1], v[0]] : v)
    const hitF = flip(hit.peak)
    const missF = flip(miss.peak)
    const outF = flip(out.peak)
    return {
      ok: true,
      prices: {
        'deepseek-v4-flash': { inMiss: missF[0], inHit: hitF[0], out: outF[0] },
        'deepseek-v4-pro': { inMiss: missF[1], inHit: hitF[1], out: outF[1] },
      },
    }
  }

  // ── 余额：缓存 + 每 10 分钟后台刷新 ─────────────────────────────
  // curl 显式使用 danger-full-access 沙箱策略：本插件 shell.run 调用没有
  // 会话上下文，默认落到部署模式（workspace-write）会禁网络。
  let balanceCache = { ok: false, reason: '尚未查询', data: null }
  let inflight = null
  async function queryBalance() {
    try {
      const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
      if (resolved === undefined) {
        balanceCache = { ok: false, reason: '未配置 DEEPSEEK_API_KEY', data: null }
        return
      }
      const spec = ctx.shell.resolve({
        command: 'curl.exe -sS -m 15 -H "Authorization: Bearer $env:DSH_BALANCE_KEY" https://api.deepseek.com/user/balance',
        timeoutMs: 20000,
        stdoutMaxBytes: 8192,
        env: { DSH_BALANCE_KEY: resolved.value },
        sandboxPolicy: { mode: 'danger-full-access' },
      })
      const result = await ctx.shell.run(spec)
      if (result.exitCode !== 0) {
        balanceCache = {
          ok: false,
          reason: 'curl 退出码 ' + result.exitCode + (result.stderr.text ? ' · ' + result.stderr.text.slice(0, 120) : ''),
          data: null,
        }
        return
      }
      let data
      try {
        data = JSON.parse(result.stdout.text.trim())
      } catch (e) {
        balanceCache = { ok: false, reason: '响应解析失败: ' + result.stdout.text.slice(0, 120), data: null }
        return
      }
      if (data !== null && typeof data === 'object' && Array.isArray(data.balance_infos)) {
        balanceCache = { ok: true, data, at: Date.now() }
      } else {
        balanceCache = { ok: false, reason: '响应缺少 balance_infos', data: null }
      }
    } catch (e) {
      balanceCache = {
        ok: false,
        reason: e !== null && typeof e === 'object' && e.message ? String(e.message) : '未知错误',
        data: null,
      }
    }
  }
  function ensureQueried() {
    if (inflight === null) {
      inflight = queryBalance().finally(() => { inflight = null })
    }
    return inflight
  }
  void ensureQueried()
  ctx.interval(() => { void queryBalance() }, 600000)

  // ── HTTP 路由 ──────────────────────────────────────────────────
  const routes = [
    { kind: 'exact', path: '/api/cost-tracker/model', handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        writeJson(res, 200, { model: currentModel(String(body.sessionId || '')) })
      } catch (err) { writeJson(res, 500, { error: String(err && err.message ? err.message : err) }) }
    } },
    { kind: 'exact', path: '/api/cost-tracker/usage', handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        writeJson(res, 200, usageByModel(String(body.sessionId || '')))
      } catch (err) { writeJson(res, 500, { error: String(err && err.message ? err.message : err) }) }
    } },
    { kind: 'exact', path: '/api/cost-tracker/refresh-prices', handler: async (req, res) => {
      try {
        writeJson(res, 200, await refreshPrices())
      } catch (err) {
        writeJson(res, 200, { ok: false, reason: String(err && err.message ? err.message : err) })
      }
    } },
    { kind: 'exact', path: '/api/cost-tracker/balance', handler: async (req, res) => {
      try {
        await ensureQueried()
        writeJson(res, 200, balanceCache)
      } catch (err) {
        writeJson(res, 200, { ok: false, reason: String(err && err.message ? err.message : err), data: null })
      }
    } },
    { kind: 'exact', path: '/api/cost-tracker/refresh-balance', handler: async (req, res) => {
      try {
        await queryBalance()
        writeJson(res, 200, balanceCache)
      } catch (err) {
        writeJson(res, 200, { ok: false, reason: String(err && err.message ? err.message : err), data: null })
      }
    } },
  ]
  for (const route of routes) ctx.webServer.register(route)
}
