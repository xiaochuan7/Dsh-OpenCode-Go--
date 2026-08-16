// OpenCode Go quota route — host plugin for the built-in context-occupancy
// panel (ContextMeter). Serves GET /api/opencode-quota with the OpenCode Go
// usage windows (monthly / weekly / 5h rolling), resolved from the
// deployment's llm-deepseek settings + credentials, cached for 60s.
// Mounted via profiles/web/cordis.patch.yml (user patch layer, hot-reloaded).
// v2: 仅当当前网关为 OpenCode Go 时返回额度（isOpenCodeGateway），
// 其他网关（如 DeepSeek 官网）返回 notApplicable，面板保持官方原样；
// 只缓存成功结果，配置切换立即生效。
export const name = 'opencode-quota-route'

export const inject = ['webServer']

export function apply(ctx) {
  const CACHE_TTL = 60000
  let cache = null

  // 多环境配置解析：baseURL/apiKeyEnv 跟随 DSH settings，key 走 credentials 分层（env/file/…）
  async function resolveConfig() {
    let baseURL = 'https://opencode.ai/zen/go/v1'
    let keyEnv = 'OPENCODE_GO_API_KEY'
    const settings = ctx.get('settings')
    if (settings !== undefined) {
      try {
        const llm = settings.get('llm-deepseek')
        if (llm && typeof llm === 'object') {
          if (typeof llm.baseURL === 'string' && llm.baseURL) baseURL = llm.baseURL
          if (typeof llm.apiKeyEnv === 'string' && llm.apiKeyEnv) keyEnv = llm.apiKeyEnv
        }
        if (baseURL === 'https://opencode.ai/zen/go/v1') {
          const ws = settings.get('web-search-deepseek')
          if (ws && typeof ws === 'object' && typeof ws.baseURL === 'string' && ws.baseURL) baseURL = ws.baseURL
        }
      } catch { /* 设置读取失败时使用默认值 */ }
    }
    let key = ''
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      // 多环境兼容：先按配置的 apiKeyEnv，再依次回退常见键名
      // （本机 OPENCODE_GO_API_KEY / 远程 DEEPSEEK_API_KEY）
      const candidates = [keyEnv]
      if (!candidates.includes('OPENCODE_GO_API_KEY')) candidates.push('OPENCODE_GO_API_KEY')
      if (!candidates.includes('DEEPSEEK_API_KEY')) candidates.push('DEEPSEEK_API_KEY')
      for (const name of candidates) {
        if (key) break
        try {
          const r = await credentials.resolve(name)
          if (r && typeof r.value === 'string' && r.value) key = r.value
        } catch { /* 尝试下一个键名 */ }
      }
    }
    return { baseURL: baseURL.replace(/\/+$/, ''), keyEnv, key }
  }

  // 无会话调用默认解析到 read-only 策略；Windows 沙箱的受限模式用
  // ConstrainedLanguage 启动 pwsh，编码前导会被拒绝导致命令直接 exit 1。
  // 本路由只对配置的网关发一次 GET，显式使用 danger-full-access 策略。
  function fullAccessPolicy() {
    const sp = ctx.get('sandboxPolicy')
    if (sp === undefined) return undefined
    return sp.resolve({ mode: 'danger-full-access' })
  }

  async function runCurl(command) {
    const shell = ctx.get('shell')
    if (shell === undefined) return null
    const policy = fullAccessPolicy()
    const spec = shell.resolve({
      command,
      timeoutMs: 30000,
      stdoutMaxBytes: 16384,
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
    })
    return shell.run(spec)
  }

  // 只在当前配置确实是 OpenCode Go 网关时才提供额度（例如切到 DeepSeek
  // 官网等其他网关时，面板保持官方原样，不显示任何额度信息）。
  function isOpenCodeGateway(baseURL) {
    return /opencode\.ai/i.test(baseURL)
  }

  async function fetchUsage() {
    const cfg = await resolveConfig()
    if (!isOpenCodeGateway(cfg.baseURL)) {
      return { ok: false, notApplicable: true, error: '当前 LLM 网关不是 OpenCode Go（' + cfg.baseURL + '），不显示配额', base: cfg.baseURL }
    }
    if (!cfg.key) {
      return { ok: false, error: 'OpenCode Go API Key 未配置（apiKeyEnv: ' + cfg.keyEnv + '）', base: cfg.baseURL }
    }
    const url = cfg.baseURL + '/usage'
    const auth = 'Authorization: Bearer ' + cfg.key
    let result = await runCurl('curl.exe -s -m 20 -H "' + auth + '" "' + url + '"')
    if (result === null || result.exitCode !== 0) {
      result = await runCurl('curl -s -m 20 -H "' + auth + '" "' + url + '"')
    }
    if (result === null) {
      return { ok: false, error: 'shell 服务不可用', base: cfg.baseURL }
    }
    if (result.exitCode !== 0) {
      const err = (result.stderr && result.stderr.text ? result.stderr.text.slice(0, 300) : '') || (result.stdout && result.stdout.text ? result.stdout.text.slice(0, 300) : '')
      return { ok: false, error: '配额请求失败（exit=' + result.exitCode + '）：' + err, base: cfg.baseURL }
    }
    let parsed
    try {
      parsed = JSON.parse(result.stdout.text)
    } catch {
      return { ok: false, error: '配额响应不是合法 JSON', base: cfg.baseURL }
    }
    const u = parsed && parsed.usage
    if (!u || !u.rolling || !u.weekly || !u.monthly) {
      return { ok: false, error: '配额响应缺少 usage.rolling/weekly/monthly 字段', base: cfg.baseURL }
    }
    const pick = (w) => ({
      percent: typeof w.percent === 'number' ? w.percent : null,
      status: typeof w.status === 'string' ? w.status : null,
      resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
    })
    return {
      ok: true,
      ver: 2,
      base: cfg.baseURL,
      fetchedAt: new Date().toISOString(),
      usage: { rolling: pick(u.rolling), weekly: pick(u.weekly), monthly: pick(u.monthly) },
    }
  }

  return ctx.webServer.register({
    kind: 'exact',
    path: '/api/opencode-quota',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        let payload
        if (cache !== null && Date.now() - cache.at < CACHE_TTL) {
          payload = cache.payload
        } else {
          payload = await fetchUsage()
          // 只缓存成功结果：配置切换（如换网关）后下一次请求立即生效
          if (payload.ok === true) cache = { at: Date.now(), payload }
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '内部错误：' + String((e && (e.message || e)) || e) }))
      }
    },
  })
}
