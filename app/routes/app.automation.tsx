import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { currencyContext } from "../services/currency.server";
import { previewRules, ruleConditions, runAutomationsOnPending } from "../services/automation.server";
import {
  AUTOMATION_MINUTES_SAVED,
  RULE_TEMPLATES,
  conditionsFromForm,
  describeConditions,
  hasAnyCondition,
  type RuleConditions,
} from "../lib/automation";
import { fmtDate } from "../lib/format";
import { COLORS, Card, Empty, btn, grid, input } from "../lib/ui";

// Reasons every Shopify store can have; merged with whatever customers have actually used.
const COMMON_REASONS = ["Size too small", "Size too large", "Defective", "Wrong item", "Not as described", "Style", "Color", "Unwanted", "Other"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [rules, runs, runCount, reasonRows] = await Promise.all([
    db.automationRule.findMany({ where: { shopId: shop.id }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] }),
    db.automationRun.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { rule: { select: { name: true } }, return: { select: { id: true, name: true } } },
    }),
    db.automationRun.count({ where: { shopId: shop.id, ok: true, createdAt: { gte: since } } }),
    db.returnItem.groupBy({ by: ["reason"], where: { return: { shopId: shop.id }, reason: { not: null } } }),
  ]);
  const preview = await previewRules(shop, rules);
  const { base: currency } = await currencyContext(shop);
  const reasons = [...new Set([...COMMON_REASONS, ...reasonRows.map((r) => r.reason!).filter(Boolean)])];
  return {
    rules: rules.map((r) => ({ ...r, conditions: ruleConditions(r), summary: describeConditions(ruleConditions(r), currency) })),
    runs,
    runCount,
    currency,
    hoursSaved: (runCount * AUTOMATION_MINUTES_SAVED) / 60,
    preview,
    reasons,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = String(form.get("id") ?? "");
  const owned = id ? await db.automationRule.findFirst({ where: { id, shopId: shop.id } }) : null;

  switch (intent) {
    case "save": {
      const name = String(form.get("name") ?? "").trim();
      const act = form.get("action") === "DECLINE" ? "DECLINE" : "APPROVE";
      const conditions = conditionsFromForm(form);
      if (!name) return { error: "Give the rule a name." };
      if (!hasAnyCondition(conditions)) return { error: "Add at least one condition — a rule with none would act on every return." };
      const data = {
        name,
        action: act,
        priority: Math.max(1, Math.floor(Number(form.get("priority"))) || 100),
        declineNote: act === "DECLINE" ? String(form.get("declineNote") ?? "").trim() || null : null,
        conditions: conditions as Prisma.InputJsonValue,
      } as const;
      if (id && !owned) return { error: "Rule not found." };
      if (owned) await db.automationRule.update({ where: { id }, data });
      else await db.automationRule.create({ data: { shopId: shop.id, enabled: false, ...data } }); // new rules start paused
      return { ok: owned ? "Rule updated." : "Rule created and paused — switch it on when you're happy with it." };
    }
    case "toggle":
      if (owned) await db.automationRule.update({ where: { id }, data: { enabled: !owned.enabled } });
      return { ok: owned ? (owned.enabled ? "Rule paused." : "Rule is live for new returns.") : undefined };
    case "delete":
      if (owned) await db.automationRule.delete({ where: { id } });
      return { ok: "Rule deleted." };
    case "template": {
      const t = RULE_TEMPLATES.find((x) => x.key === form.get("key"));
      if (!t) return { error: "Unknown template." };
      await db.automationRule.create({
        data: {
          shopId: shop.id,
          name: t.name,
          action: t.action,
          declineNote: t.declineNote ?? null,
          conditions: t.conditions as Prisma.InputJsonValue,
          enabled: false,
          priority: 100,
        },
      });
      return { ok: `"${t.name}" added (paused). Review it, then switch it on.` };
    }
    case "run-pending": {
      const r = await runAutomationsOnPending(session.shop);
      return { ok: `Checked ${r.checked} pending return${r.checked === 1 ? "" : "s"}; automation handled ${r.handled}.` };
    }
  }
  return { error: "Unknown action." };
};

type Rule = ReturnType<typeof useLoaderData<typeof loader>>["rules"][number];

export default function Automation() {
  const { rules, runs, runCount, hoursSaved, preview, reasons, currency } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const live = rules.filter((r) => r.enabled).length;
  // Close the editor once the server confirms the save; on a validation error it stays open with the input intact.
  useEffect(() => {
    if (result && "ok" in result && result.ok) setEditing(null);
  }, [result]);

  return (
    <s-page heading="Automation">
      <div style={{ display: "grid", gap: 16 }}>
        {result && "error" in result && result.error && <s-banner tone="critical">{result.error}</s-banner>}
        {result && "ok" in result && result.ok && <s-banner tone="success">{result.ok}</s-banner>}

        <div style={grid(220, 14)}>
          <Stat label="Live rules" value={`${live} / ${rules.length}`} />
          <Stat label="Decisions (30 days)" value={String(runCount)} />
          <Stat label="Time saved (30 days)" value={`${hoursSaved.toFixed(1)}H`} sub={`≈ ${AUTOMATION_MINUTES_SAVED} min per decision`} />
        </div>

        <Card
          title="How it works"
          right={
            <div style={{ display: "flex", gap: 8 }}>
              <Form method="post" onSubmit={(e) => !window.confirm("Apply your live rules to every return that is still waiting for review? This approves/declines them on Shopify.") && e.preventDefault()}>
                <input type="hidden" name="intent" value="run-pending" />
                <button style={btn("secondary", busy || live === 0)} disabled={busy || live === 0}>Run on pending returns</button>
              </Form>
              <button type="button" style={btn("primary")} onClick={() => setEditing("new")}>Create rule</button>
            </div>
          }
        >
          <p style={{ margin: 0, fontSize: 14, color: COLORS.subdued }}>
            When a new return request arrives, live rules are checked top to bottom (lowest priority number first). The <strong>first rule whose conditions all match</strong> approves or
            declines the request on Shopify and is logged below. Anything no rule matches waits for you. New rules start paused. <strong>Exchanges are never automated</strong> — they always wait for you to review the replacement item first.
          </p>
        </Card>

        {editing && (
          <RuleForm
            key={editing === "new" ? "new" : editing.id}
            rule={editing === "new" ? null : editing}
            reasons={reasons}
            currency={currency}
            busy={busy}
            onClose={() => setEditing(null)}
          />
        )}

        <Card title={`Rules (${rules.length})`}>
          {rules.length === 0 ? (
            <Empty>No rules yet. Start from a template below or create your own.</Empty>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rules.map((r) => {
                const pv = preview[r.id];
                return (
                  <div key={r.id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, opacity: r.enabled ? 1 : 0.75 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <strong>{r.name}</strong>
                        <s-badge tone={r.action === "APPROVE" ? "success" : "critical"}>{r.action === "APPROVE" ? "Auto-approve" : "Auto-decline"}</s-badge>
                        <s-badge tone={r.enabled ? "info" : "neutral"}>{r.enabled ? "Live" : "Paused"}</s-badge>
                        <span style={{ fontSize: 12, color: COLORS.subdued }}>priority {r.priority}</span>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="id" value={r.id} />
                          <button style={btn(r.enabled ? "secondary" : "primary", busy)} disabled={busy}>{r.enabled ? "Pause" : "Turn on"}</button>
                        </Form>
                        <button type="button" style={btn("secondary")} onClick={() => setEditing(r)}>Edit</button>
                        <Form method="post" onSubmit={(e) => !window.confirm(`Delete "${r.name}"?`) && e.preventDefault()}>
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={r.id} />
                          <button style={btn("danger", busy)} disabled={busy}>Delete</button>
                        </Form>
                      </div>
                    </div>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                      {r.summary.map((s) => <li key={s}>{s}</li>)}
                    </ul>
                    {r.action === "DECLINE" && r.declineNote && <div style={{ fontSize: 13, color: COLORS.subdued, marginTop: 4 }}>Customer sees: “{r.declineNote}”</div>}
                    {pv && pv.sample > 0 && (
                      <div style={{ fontSize: 12, color: COLORS.subdued, marginTop: 6 }}>
                        Would have matched <strong>{pv.matched}</strong> of your last {pv.sample} returns.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Templates" hint="Added paused, so nothing fires until you turn them on.">
          <div style={grid(260, 12)}>
            {RULE_TEMPLATES.map((t) => (
              <div key={t.key} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, display: "grid", gap: 8, alignContent: "space-between" }}>
                <div>
                  <strong style={{ fontSize: 14 }}>{t.name}</strong>
                  <div style={{ fontSize: 13, color: COLORS.subdued, marginTop: 4 }}>{t.description}</div>
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value="template" />
                  <input type="hidden" name="key" value={t.key} />
                  <button style={btn("secondary", busy)} disabled={busy}>Add rule</button>
                </Form>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Recent automation activity">
          {runs.length === 0 ? (
            <Empty>Nothing has been automated yet.</Empty>
          ) : (
            runs.map((r) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 0", borderTop: `1px solid ${COLORS.border}`, fontSize: 13 }}>
                <span>
                  <Link to={`/app/returns/${r.return.id}`}>{r.return.name}</Link> · {r.action === "APPROVE" ? "approved" : "declined"} by “{r.rule?.name ?? "deleted rule"}”
                  {!r.ok && <span style={{ color: "#d72c0d" }}> — failed: {r.error}</span>}
                </span>
                <span style={{ color: COLORS.subdued, whiteSpace: "nowrap" }}>{fmtDate(r.createdAt)}</span>
              </div>
            ))
          )}
        </Card>
      </div>
    </s-page>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <div style={{ fontSize: 13, color: COLORS.subdued }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: COLORS.subdued }}>{sub}</div>}
    </Card>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span style={{ color: COLORS.subdued, fontSize: 12 }}>{hint}</span>}
    </label>
  );
}

function RuleForm({ rule, reasons, currency, busy, onClose }: { rule: Rule | null; reasons: string[]; currency: string; busy: boolean; onClose: () => void }) {
  const [action, setAction] = useState<string>(rule?.action ?? "APPROVE");
  const c: RuleConditions = rule?.conditions ?? {};
  const v = (n: number | undefined) => n ?? "";
  const picked = new Set((c.reasons ?? []).map((r) => r.toLowerCase()));
  const extraReasons = (c.reasons ?? []).filter((r) => !reasons.some((x) => x.toLowerCase() === r.toLowerCase()));
  const num = { ...input, width: "100%" } as const;

  return (
    <Card title={rule ? `Edit “${rule.name}”` : "New rule"} right={<button type="button" style={btn("plain")} onClick={onClose}>Close ✕</button>}>
      <Form method="post" style={{ display: "grid", gap: 14 }}>
        <input type="hidden" name="intent" value="save" />
        {rule && <input type="hidden" name="id" value={rule.id} />}

        <div style={grid(220, 12)}>
          <Field label="Rule name"><input name="name" defaultValue={rule?.name ?? ""} required style={num} placeholder="e.g. Auto-approve cheap returns" /></Field>
          <Field label="Then">
            <select name="action" value={action} onChange={(e) => setAction(e.target.value)} style={num}>
              <option value="APPROVE">Approve the return</option>
              <option value="DECLINE">Decline the return</option>
            </select>
          </Field>
          <Field label="Priority" hint="Lower runs first.">
            <input name="priority" type="number" min={1} defaultValue={rule?.priority ?? 100} style={num} />
          </Field>
        </div>

        {action === "DECLINE" && (
          <Field label="Message shown to the customer">
            <input name="declineNote" defaultValue={rule?.declineNote ?? ""} style={num} placeholder="Why the return was declined" />
          </Field>
        )}

        <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
          <strong style={{ fontSize: 14 }}>When ALL of these are true</strong>
          <div style={{ fontSize: 12, color: COLORS.subdued }}>Money amounts are in your store currency ({currency}), whatever currency the dashboard is showing.</div>
          <div style={{ ...grid(180, 12), marginTop: 10 }}>
            <Field label={`Return value at least (${currency})`}><input name="minReturnValue" type="number" min={0} defaultValue={v(c.minReturnValue)} style={num} /></Field>
            <Field label={`Return value at most (${currency})`}><input name="maxReturnValue" type="number" min={0} defaultValue={v(c.maxReturnValue)} style={num} /></Field>
            <Field label="Max units"><input name="maxQuantity" type="number" min={0} defaultValue={v(c.maxQuantity)} style={num} /></Field>
            <Field label="Payment">
              <select name="paymentMode" defaultValue={c.paymentMode ?? ""} style={num}>
                <option value="">Any</option>
                <option value="PREPAID">Prepaid only</option>
                <option value="COD">Cash on delivery only</option>
              </select>
            </Field>
            <Field label="Within days of order" hint="Order age ≤ this"><input name="maxDaysSinceOrder" type="number" min={0} defaultValue={v(c.maxDaysSinceOrder)} style={num} /></Field>
            <Field label="At least days after order" hint="Order age ≥ this"><input name="minDaysSinceOrder" type="number" min={0} defaultValue={v(c.minDaysSinceOrder)} style={num} /></Field>
            <Field label="Customer has ≥ N other returns" hint="last 90 days"><input name="minPriorReturns" type="number" min={0} defaultValue={v(c.minPriorReturns)} style={num} /></Field>
            <Field label="Customer has ≤ N other returns" hint="last 90 days"><input name="maxPriorReturns" type="number" min={0} defaultValue={v(c.maxPriorReturns)} style={num} /></Field>
          </div>

          <div style={{ marginTop: 12 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Reason is any of</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 6 }}>
              {reasons.map((r) => (
                <label key={r} style={{ fontSize: 13, display: "flex", gap: 5, alignItems: "center" }}>
                  <input type="checkbox" name="reasons" value={r} defaultChecked={picked.has(r.toLowerCase())} /> {r}
                </label>
              ))}
            </div>
            <input name="reasonsExtra" defaultValue={extraReasons.join(", ")} placeholder="Other reasons, comma separated" style={{ ...num, marginTop: 8 }} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Field label="Product type is any of" hint="Comma separated, e.g. Dresses, Outfit Sets">
              <input name="productTypes" defaultValue={(c.productTypes ?? []).join(", ")} style={num} />
            </Field>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button style={btn("primary", busy)} disabled={busy}>{rule ? "Save changes" : "Create rule"}</button>
          <button type="button" style={btn("secondary")} onClick={onClose}>Cancel</button>
        </div>
      </Form>
    </Card>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
