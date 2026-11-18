// magpie-ark: 火山方舟 (Volcengine Ark) 的自建 provider 插件。
//
// 为什么存在：magpie 内置的 volcengine provider 取额度只调控制面
// ark:GetAFPUsage。Agent Plan Team（团队版，Scene=agent_plan_enterprise）的
// 额度属于席位，Ark 对该 action 返回 403 AccessDenied，Usage 页的火山卡片
// 因此为空。正确取数路径是 GetSeatInfo → GetAgentPlanSeatAFPUsage，个人
// 计划（没有席位）才回退 GetAFPUsage。上游 issue（完整补丁已提交）：
// https://github.com/yetone/magpie/issues/5338 ，未被合入。
//
// 数据面（chat / responses）与内置 provider 相同：同一个 API key 走
// /api/plan/v3；控制面只用账号的 AccessKey ID / Secret 签名，密钥只发往
// open.volcengineapi.com。

import { createHash, createHmac } from "node:crypto"

const ID = "ark"
const DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3"
// 控制面地址。MAGPIE_ARK_CONTROL_PLANE 只给测试和本地 mock 用：默认是
// Ark 的，凭据只发往这里。
const OPENAPI = (() => {
  const raw = (process.env.MAGPIE_ARK_CONTROL_PLANE ?? "").trim()
  if (!raw) return { url: "https://open.volcengineapi.com", host: "open.volcengineapi.com" }
  const u = new URL(raw)
  return { url: u.origin, host: u.host }
})()
const API_VERSION = "2024-01-01"
const SERVICE = "ark"
const DEFAULT_REGION = "cn-beijing"

// 内置 provider 已有的 Agent Plan 模型；插件不做列表接口（Agent Plan 的
// /models 返回 404，Coding Plan 的只列通用目录），模型在 provider 编辑器里
// 可自行增删。
const MODELS = {
  "glm-5-3-flash": { name: "GLM 5.3 Flash" },
  "glm-5-3": { name: "GLM 5.3" },
  "deepseek-v4-1-flash-economy-261017": { name: "DeepSeek V4.1 Flash Economy" },
  "deepseek-v4-1-flash-261017": { name: "DeepSeek V4.1 Flash" },
  "minimax-m3": { name: "MiniMax M3" },
  "kimi-k3": { name: "Kimi K3" },
  "kimi-k3.1-pro": { name: "Kimi K3.1 Pro" },
  "doubao-seed-evolving-latest-version": { name: "Doubao Seed Evolving" },
}

// 每个模型都能走 Responses（方舟 Agent Plan 的 Codex 页设 wire_api
// responses），聊天走 OpenAI 兼容的 chat/completions。
const NPM = "@ai-sdk/openai-compatible"
const ALSO = ["@ai-sdk/openai"]

const str = (v) => (typeof v === "string" ? v.trim() : "")
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const f = Number(v.trim())
    if (Number.isFinite(f)) return f
  }
  return undefined
}

// 计数显示：有额度就 "已用 / 总额"，只有百分比就 "n%"。
function displayOf(amount, limit, used) {
  if (limit > 0 && amount !== undefined) {
    const round = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ""))
    return `${round(amount)} / ${round(limit)}`
  }
  return `${used.toFixed(1)}%`
}

// 复位时间可能是 epoch 秒、epoch 毫秒或 RFC 3339。
function iso(v) {
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return new Date(n > 1e11 ? n : n * 1000).toISOString()
}

const WIN = [
  ["5 hours", "AFPFiveHour", 5 * 3600],
  ["Weekly", "AFPWeekly", 7 * 24 * 3600],
  ["Month", "AFPMonthly", 30 * 24 * 3600],
]

// windowsOf 读 AGP 的三个 bucket（AFPDaily 方舟自己的控制台也不显示）。
// 一个 bucket 没有配额时不在套餐里，跳过。
function windowsOf(buckets) {
  const out = []
  if (!buckets || typeof buckets !== "object") return out
  for (const [name, key, span] of WIN) {
    const b = buckets[key]
    if (!b || typeof b !== "object") continue
    const used = num(b.Used)
    const limit = num(b.Quota) ?? num(b.Total)
    const percent = num(b.Percent)
    const counts = used !== undefined && limit !== undefined && limit > 0
    if (percent === undefined && !counts) continue // 没有配额：不在套餐里
    const pct = percent !== undefined ? percent : (100 * used) / limit
    const resetsAt = iso(b.ResetTime) ?? iso(b.ResetTimestamp)
    out.push({
      name,
      used: Math.round(pct * 100) / 100,
      ...(counts ? { amount: used, limit } : {}),
      display: displayOf(counts ? used : undefined, counts ? limit : undefined, pct),
      span,
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  return out
}

// codingWindows 读 GetCodingPlanUsage 的 QuotaUsage：Percent 是已用比例，
// ResetTimestamp 是秒。
function codingWindows(result) {
  const out = []
  const levels = { session: ["5 hours", 5 * 3600], weekly: ["Weekly", 7 * 24 * 3600], monthly: ["Month", 30 * 24 * 3600] }
  for (const u of Array.isArray(result?.QuotaUsage) ? result.QuotaUsage : []) {
    const level = levels[str(u?.Level).toLowerCase()]
    const used = num(u?.Percent)
    if (!level || used === undefined) continue
    out.push({
      name: level[0],
      used: Math.round(used * 100) / 100,
      display: `${used.toFixed(1)}%`,
      span: level[1],
      ...(iso(u?.ResetTimestamp) ? { resetsAt: iso(u?.ResetTimestamp) } : {}),
    })
  }
  return out
}

// planOf 认 endpoint 属于哪种计费：内置 provider 用同一套判断。
function planOf(base) {
  let path = ""
  try {
    path = new URL(base).pathname.replace(/\/+$/, "") + "/"
  } catch {
    return "unknown"
  }
  if (path.startsWith("/api/coding/")) return "coding"
  if (path.startsWith("/api/plan/")) return "agent"
  if (path.startsWith("/api/v3/") || path === "/api/v3/") return "payg"
  return "unknown"
}

function regionOf(base) {
  try {
    const labels = new URL(base).hostname.toLowerCase().split(".")
    if (labels.length === 4 && labels[0] === "ark" && labels[1]) return labels[1]
  } catch {}
  return DEFAULT_REGION
}

const hex = (b) => createHash("sha256").update(b).digest("hex")
const mac = (key, s) => createHmac("sha256", key).update(s).digest()

// sign 与 volc-sdk-golang 的 GetSignRequest 一致：canonical request 的
// 头按字典序，scope 是 date/region/ark/request，密钥从 Secret 逐级派生。
function sign({ ak, sk, region, query, body, xDate, host = OPENAPI.host }) {
  const date = xDate.slice(0, 8)
  const contentSHA = hex(body)
  const signed = "content-type;host;x-content-sha256;x-date"
  const canonical = [
    "POST",
    "/",
    query,
    "content-type:application/json\n" +
      "host:" + host + "\n" +
      "x-content-sha256:" + contentSHA + "\n" +
      "x-date:" + xDate + "\n",
    signed,
    contentSHA,
  ].join("\n")
  const scope = `${date}/${region}/${SERVICE}/request`
  const toSign = ["HMAC-SHA256", xDate, scope, hex(canonical)].join("\n")
  let key = mac(sk, date)
  for (const s of [region, SERVICE, "request"]) key = mac(key, s)
  const signature = createHmac("sha256", key).update(toSign).digest("hex")
  return {
    "Content-Type": "application/json",
    "X-Date": xDate,
    "X-Content-Sha256": contentSHA,
    Accept: "application/json",
    Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  }
}

const pad = (n) => String(n).padStart(2, "0")

// call 调一次控制面 action，返回 Result；Ark 自己在 ResponseMetadata 里
// 报的错误按原文抛出。
async function call({ ak, sk, region, action, body = {}, signal }) {
  const now = new Date()
  const xDate =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const query = `Action=${encodeURIComponent(action)}&Version=${API_VERSION}`
  const payload = JSON.stringify(body)
  const headers = sign({ ak, sk, region, query, body: payload, xDate })
  const res = await fetch(`${OPENAPI.url}/?${query}`, {
    method: "POST",
    headers,
    body: payload,
    ...(signal ? { signal } : {}),
  })
  const raw = await res.text()
  let env
  try {
    env = JSON.parse(raw)
  } catch {
    throw new Error(`Volcengine ${action}: ${res.status} ${raw.slice(0, 200)}`)
  }
  const e = env?.ResponseMetadata?.Error
  if (e && (e.Code || e.Message)) {
    const hint = /accesskey|signature|accessdenied|unauthorized|forbidden|credential|authfailure/i.test(str(e.Code))
      ? "；检查 AccessKey ID / Secret 以及该 AK 是否允许 ark 控制面（IAM）"
      : ""
    throw new Error(`Volcengine ${action}: ${str(e.Code)} ${str(e.Message)}${hint}`)
  }
  if (!res.ok) throw new Error(`Volcengine ${action}: ${res.status} ${raw.slice(0, 200)}`)
  return env?.Result ?? {}
}

const planName = (plan) => (plan === "coding" ? "Coding Plan" : plan === "agent" ? "Agent Plan" : "Pay as you go")

// ---- hooks ------------------------------------------------------------------

function hooks() {
  return {
    auth: {
      provider: ID,
      // 数据面：账号的 Ark API key 与所选 endpoint；控制面的 AK/SK 只用于
      // 额度，不参与请求。
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const base = str(auth.metadata?.base) || DEFAULT_BASE
        return { baseURL: base.replace(/\/+$/, ""), apiKey: auth.key }
      },
      methods: [
        {
          type: "api",
          label: "Ark API key + AccessKey（额度用）",
          placeholder: "ark-…",
          prompts: [
            { type: "password", key: "key", message: "Ark API key（数据面用，ark- 开头）", placeholder: "ark-…" },
            {
              type: "select",
              key: "base",
              message: "Endpoint",
              options: [
                { label: "Agent Plan", value: "https://ark.cn-beijing.volces.com/api/plan/v3" },
                { label: "Coding Plan", value: "https://ark.cn-beijing.volces.com/api/coding/v3" },
                { label: "Pay as you go", value: "https://ark.cn-beijing.volces.com/api/v3" },
              ],
            },
            { type: "text", key: "accessKeyID", message: "AccessKey ID（控制面取额度，可留空）", placeholder: "AKLT…" },
            { type: "password", key: "secretAccessKey", message: "Secret AccessKey（可留空）", placeholder: "" },
            { type: "text", key: "region", message: "Region", placeholder: DEFAULT_REGION },
          ],
          authorize(inputs) {
            const key = str(inputs?.key)
            if (!key) return { type: "failed", error: "Ark API key is required" }
            return {
              type: "success",
              key,
              metadata: {
                base: str(inputs?.base) || DEFAULT_BASE,
                accessKeyID: str(inputs?.accessKeyID),
                secretAccessKey: str(inputs?.secretAccessKey),
                region: str(inputs?.region) || regionOf(str(inputs?.base)),
              },
            }
          },
        },
      ],
      // 额度：Agent Plan 先找席位（团队版），个人计划回退 GetAFPUsage。
      async usage(getAuth, provider, { signal } = {}) {
        const auth = await getAuth()
        const md = auth?.metadata ?? {}
        const base = str(md.base) || DEFAULT_BASE
        const plan = planOf(base)
        if (plan === "payg" || plan === "unknown") return { plan: planName(plan), windows: [] }
        const ak = str(md.accessKeyID)
        const sk = str(md.secretAccessKey)
        const region = str(md.region) || regionOf(base)
        if (!ak || !sk) {
          return {
            plan: planName(plan),
            windows: [],
            error: "额度要用账号的 AccessKey ID / Secret：在 provider 编辑器里补上（只发往 open.volcengineapi.com）",
          }
        }
        try {
          if (plan === "coding") {
            const r = await call({ ak, sk, region, action: "GetCodingPlanUsage", signal })
            const ws = codingWindows(r)
            if (!ws.length) throw new Error("GetCodingPlanUsage 没有窗口：该 AK 可能不在 Coding Plan 上")
            return { plan: "Coding Plan", windows: ws }
          }
          // Agent Plan：团队版的额度属于席位，个人计划没有席位。
          let tier = ""
          try {
            const seat = await call({
              ak,
              sk,
              region,
              action: "GetSeatInfo",
              body: { ProjectName: "default", Scene: "agent_plan_enterprise" },
              signal,
            })
            const id = str(seat?.SeatID)
            tier = str(seat?.BizInfo)
            if (id) {
              const r = await call({ ak, sk, region, action: "GetAgentPlanSeatAFPUsage", body: { SeatIDs: [id] }, signal })
              const s = Array.isArray(r?.SeatAFPUsages) ? r.SeatAFPUsages[0] : undefined
              const ws = windowsOf(s)
              if (ws.length) return { plan: `Agent Plan${str(s?.PlanType) || tier ? " " + (str(s?.PlanType) || tier) : ""}`, windows: ws }
            }
          } catch {
            // 没有席位（个人计划）或 GetSeatInfo 不被允许：按账号范围再问一次
          }
          const r = await call({ ak, sk, region, action: "GetAFPUsage", signal })
          const ws = windowsOf(r)
          if (!ws.length) throw new Error("GetAFPUsage 没有窗口：该 AK 可能不在 Agent Plan 上")
          return { plan: `Agent Plan${str(r?.Tier) ? " " + str(r.Tier) : ""}`, windows: ws }
        } catch (e) {
          return { plan: planName(plan), windows: [], error: String(e?.message ?? e) }
        }
      },
    },
    config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[ID] ?? {}
      const models = {}
      for (const [id, m] of Object.entries(MODELS)) {
        models[id] = { ...(was.models?.[id] ?? {}), name: m.name, also: ALSO }
      }
      cfg.provider[ID] = {
        ...was,
        name: was.name ?? "火山方舟（自建）",
        api: was.api ?? DEFAULT_BASE,
        npm: was.npm ?? NPM,
        models: Object.keys(was.models ?? {}).length ? was.models : models,
      }
    },
  }
}

export async function ArkPlugin() {
  return hooks()
}
