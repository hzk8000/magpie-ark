// Agent Plan Team 的额度在席位上：GetSeatInfo → GetAgentPlanSeatAFPUsage；
// 个人计划才回退 GetAFPUsage（上游 yetone/magpie#5338）。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { ArkPlugin } from "../index.mjs"

const AUTH = {
  type: "api",
  key: "ark-k",
  metadata: {
    base: "https://ark.cn-beijing.volces.com/api/plan/v3",
    accessKeyID: "AKteam",
    secretAccessKey: "SKteam",
    region: "cn-beijing",
  },
}

// serve 按 Action 回答，并记下每次请求的 Action 和签名头。
function serve(replies) {
  const asked = []
  globalThis.fetch = async (url, init) => {
    const action = new URL(url).searchParams.get("Action")
    asked.push({ action, body: init.body, headers: init.headers })
    const reply = replies[action]
    if (reply === undefined) throw new Error(`unexpected action ${action}`)
    const text = typeof reply === "string" ? reply : JSON.stringify(reply)
    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } })
  }
  return asked
}

const seatUsage = {
  ResponseMetadata: { RequestId: "r4" },
  Result: {
    SeatAFPUsages: [
      {
        SeatID: "seat-1",
        PlanType: "medium",
        AFPFiveHour: { Quota: 20000, Used: 6934.76, ResetTime: 1790016000000 },
        AFPDaily: { Quota: 100000, Used: 0 },
        AFPWeekly: { Quota: 70000, Used: 7410.48 },
        AFPMonthly: { Quota: 200000, Used: 76523.54 },
      },
    ],
  },
}

test("team seat: GetSeatInfo then the seat's windows", async () => {
  const asked = serve({
    GetSeatInfo: {
      ResponseMetadata: { RequestId: "r3" },
      Result: { SeatID: "seat-1", BizInfo: "medium", Scene: "agent_plan_enterprise" },
    },
    GetAgentPlanSeatAFPUsage: seatUsage,
  })
  const u = await (await ArkPlugin()).auth.usage(async () => AUTH, {}, {})
  assert.equal(u.error, undefined)
  assert.equal(u.plan, "Agent Plan medium")
  assert.deepEqual(
    u.windows.map((w) => w.name),
    ["5 hours", "Weekly", "Month"], // AFPDaily isn't shown by Ark's console either
  )
  assert.equal(u.windows[0].limit, 20000)
  assert.ok(Math.abs(u.windows[0].used - 34.6738) < 0.01)
  assert.equal(u.windows[0].resetsAt, new Date(1790016000000).toISOString())
  assert.equal(u.windows[0].display, "6934.76 / 20000")
  assert.equal(u.windows[0].span, 5 * 3600)
  assert.deepEqual(
    asked.map((a) => a.action),
    ["GetSeatInfo", "GetAgentPlanSeatAFPUsage"],
  )
  // GetSeatInfo's body is Ark's own: without Scene the SeatID is empty.
  assert.deepEqual(JSON.parse(asked[0].body), { ProjectName: "default", Scene: "agent_plan_enterprise" })
  assert.deepEqual(JSON.parse(asked[1].body), { SeatIDs: ["seat-1"] })
})

test("individual plan: no seat falls back to GetAFPUsage", async () => {
  serve({
    GetSeatInfo: {
      ResponseMetadata: { Error: { Code: "InvalidParameter", Message: "no seat in this plan" } },
    },
    GetAFPUsage: {
      ResponseMetadata: { RequestId: "r2" },
      Result: { Tier: "Lite", AFPFiveHour: { Quota: 100, Used: 42 }, AFPWeekly: { Quota: 400, Used: 100 }, AFPMonthly: { Quota: 0, Used: 0 } },
    },
  })
  const u = await (await ArkPlugin()).auth.usage(async () => AUTH, {}, {})
  assert.equal(u.error, undefined)
  assert.equal(u.plan, "Agent Plan Lite")
  assert.deepEqual(
    u.windows.map((w) => w.name),
    ["5 hours", "Weekly"], // a bucket with no quota isn't on the plan
  )
  assert.equal(u.windows[0].used, 42)
  assert.equal(u.windows[1].used, 25)
})

test("percent-only reply keeps its share", async () => {
  serve({
    GetSeatInfo: { ResponseMetadata: { Result: {} } },
    GetAFPUsage: {
      ResponseMetadata: { RequestId: "r2" },
      Result: { AFPMonthly: { Percent: 12.5, ResetTimestamp: 1758300000 } },
    },
  })
  const u = await (await ArkPlugin()).auth.usage(async () => AUTH, {}, {})
  assert.deepEqual(u.windows, [
    { name: "Month", used: 12.5, display: "12.5%", span: 30 * 24 * 3600, resetsAt: new Date(1758300000 * 1000).toISOString() },
  ])
})

test("coding plan windows come from GetCodingPlanUsage", async () => {
  const asked = serve({
    GetCodingPlanUsage: {
      ResponseMetadata: { RequestId: "r1" },
      Result: {
        QuotaUsage: [
          { Level: "session", Percent: 10.5, ResetTimestamp: 1758100000 },
          { Level: "weekly", Percent: 20.25, ResetTimestamp: 1758200000 },
          { Level: "monthly", Percent: 30.75, ResetTimestamp: 1758300000 },
        ],
      },
    },
  })
  const auth = { ...AUTH, metadata: { ...AUTH.metadata, base: "https://ark.cn-beijing.volces.com/api/coding/v3" } }
  const u = await (await ArkPlugin()).auth.usage(async () => auth, {}, {})
  assert.equal(u.plan, "Coding Plan")
  assert.deepEqual(
    u.windows.map((w) => w.used),
    [10.5, 20.25, 30.75],
  )
  assert.deepEqual(
    asked.map((a) => a.action),
    ["GetCodingPlanUsage"],
  )
})

test("pay as you go asks nothing", async () => {
  let asked = 0
  globalThis.fetch = async () => {
    asked++
    throw new Error("no request expected")
  }
  const auth = { ...AUTH, metadata: { ...AUTH.metadata, base: "https://ark.cn-beijing.volces.com/api/v3" } }
  const u = await (await ArkPlugin()).auth.usage(async () => auth, {}, {})
  assert.deepEqual(u, { plan: "Pay as you go", windows: [] })
  assert.equal(asked, 0)
})

test("no access key: says what to add, asks nothing", async () => {
  let asked = 0
  globalThis.fetch = async () => {
    asked++
    throw new Error("no request expected")
  }
  const auth = { type: "api", key: "ark-k", metadata: { base: AUTH.metadata.base } }
  const u = await (await ArkPlugin()).auth.usage(async () => auth, {}, {})
  assert.equal(u.windows.length, 0)
  assert.match(u.error, /AccessKey/)
  assert.equal(asked, 0)
})

test("refusal is reported with what was answered", async () => {
  serve({
    GetSeatInfo: { ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "signature mismatch" } } },
    GetAFPUsage: { ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "signature mismatch" } } },
  })
  const u = await (await ArkPlugin()).auth.usage(async () => AUTH, {}, {})
  assert.match(u.error, /SignatureDoesNotMatch/)
  assert.match(u.error, /AccessKey ID \/ Secret/)
  assert.equal(u.windows.length, 0)
})

test("the control-plane request is signed the way Volcengine's SDK signs it", async () => {
  const asked = serve({ GetAFPUsage: { ResponseMetadata: {}, Result: { AFPWeekly: { Quota: 1, Used: 0 } } } })
  await (await ArkPlugin()).auth.usage(async () => AUTH, {}, {})
  const { headers, body } = asked[0]
  const xDate = headers["X-Date"]
  assert.match(xDate, /^\d{8}T\d{6}Z$/)
  assert.equal(headers["X-Content-Sha256"], createHash("sha256").update(body).digest("hex"))
  const scope = `${xDate.slice(0, 8)}/cn-beijing/ark/request`
  assert.match(
    headers.Authorization,
    new RegExp(
      "^HMAC-SHA256 Credential=AKteam/" +
        scope.replace(/[/]/g, "\\/") +
        ", SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$",
    ),
  )
})

test("config hook leaves the user's models alone and names the provider", async () => {
  const hooks = await ArkPlugin()
  const cfg = {}
  hooks.config(cfg)
  assert.equal(cfg.provider.ark.name, "火山方舟（自建）")
  assert.equal(cfg.provider.ark.api, "https://ark.cn-beijing.volces.com/api/plan/v3")
  assert.ok(cfg.provider.ark.models["deepseek-v4-1-flash-261017"])
  const own = { name: "mine", api: "https://example.invalid/v1", models: { "kimi-k3": { name: "K" } } }
  const kept = { provider: { ark: own } }
  hooks.config(kept)
  assert.deepEqual(kept.provider.ark, { ...own, npm: "@ai-sdk/openai-compatible" })
})
