import { describe, it, expect } from "vitest";

// ─── Alert Rules Engine Tests ───────────────────────

type Operator = ">" | "<" | ">=" | "<=" | "==";

interface AlertRule {
  name: string;
  metric: string;
  operator: Operator;
  threshold: number;
  severity: "info" | "warning" | "critical";
  active: boolean;
}

function evaluateRule(rule: AlertRule, value: number): boolean {
  if (!rule.active) return false;
  switch (rule.operator) {
    case ">": return value > rule.threshold;
    case "<": return value < rule.threshold;
    case ">=": return value >= rule.threshold;
    case "<=": return value <= rule.threshold;
    case "==": return value === rule.threshold;
    default: return false;
  }
}

function runAlertRules(
  rules: AlertRule[],
  metrics: Record<string, number>
): Array<{ rule: string; severity: string; value: number; threshold: number }> {
  const triggered: Array<{ rule: string; severity: string; value: number; threshold: number }> = [];

  for (const rule of rules) {
    const value = metrics[rule.metric];
    if (value !== undefined && evaluateRule(rule, value)) {
      triggered.push({
        rule: rule.name,
        severity: rule.severity,
        value,
        threshold: rule.threshold,
      });
    }
  }

  return triggered;
}

describe("Alert Rules Engine", () => {
  const rules: AlertRule[] = [
    { name: "Margem baixa", metric: "gross_margin_pct", operator: "<", threshold: 25, severity: "critical", active: true },
    { name: "CAC alto", metric: "cac", operator: ">", threshold: 5000, severity: "warning", active: true },
    { name: "NPS baixo", metric: "nps_score", operator: "<", threshold: 50, severity: "warning", active: true },
    { name: "Projetos atrasados", metric: "projects_on_time_pct", operator: "<", threshold: 80, severity: "warning", active: true },
    { name: "Rule inativa", metric: "something", operator: "==", threshold: 0, severity: "info", active: false },
  ];

  it("should trigger critical alert when margin below 25%", () => {
    const result = runAlertRules(rules, { gross_margin_pct: 18, cac: 3000, nps_score: 72, projects_on_time_pct: 90 });
    expect(result).toHaveLength(1);
    expect(result[0].rule).toBe("Margem baixa");
    expect(result[0].severity).toBe("critical");
  });

  it("should trigger multiple alerts", () => {
    const result = runAlertRules(rules, {
      gross_margin_pct: 15,   // <25 → trigger
      cac: 8000,              // >5000 → trigger
      nps_score: 40,          // <50 → trigger
      projects_on_time_pct: 90, // >80 → ok
    });
    expect(result).toHaveLength(3);
  });

  it("should not trigger when all metrics healthy", () => {
    const result = runAlertRules(rules, {
      gross_margin_pct: 35,
      cac: 2000,
      nps_score: 80,
      projects_on_time_pct: 95,
    });
    expect(result).toHaveLength(0);
  });

  it("should skip inactive rules", () => {
    const result = runAlertRules(rules, { something: 0 });
    const inactiveTriggered = result.find((r) => r.rule === "Rule inativa");
    expect(inactiveTriggered).toBeUndefined();
  });

  it("should handle boundary values", () => {
    // Exactly at threshold
    const result = runAlertRules(
      [{ name: "Boundary", metric: "value", operator: "<", threshold: 25, severity: "warning", active: true }],
      { value: 25 }
    );
    expect(result).toHaveLength(0); // 25 is NOT < 25

    const result2 = runAlertRules(
      [{ name: "Boundary", metric: "value", operator: "<=", threshold: 25, severity: "warning", active: true }],
      { value: 25 }
    );
    expect(result2).toHaveLength(1); // 25 IS <= 25
  });

  it("should handle missing metrics gracefully", () => {
    const result = runAlertRules(rules, {}); // No metrics provided
    expect(result).toHaveLength(0);
  });
});

// ─── Digest Formatting Tests ────────────────────────

describe("Weekly Digest Formatting", () => {
  function formatCurrency(value: number): string {
    return `R$ ${value.toLocaleString("pt-BR")}`;
  }

  function revenueEmoji(pct: number): string {
    if (pct >= 80) return "🟢";
    if (pct >= 50) return "🟡";
    return "🔴";
  }

  function growthArrow(value: number): string {
    return value > 0 ? "📈" : "📉";
  }

  it("should format currency correctly", () => {
    expect(formatCurrency(500_000)).toContain("500");
    expect(formatCurrency(1_234_567)).toContain("1.234.567");
  });

  it("should show green for >80% target", () => {
    expect(revenueEmoji(85)).toBe("🟢");
    expect(revenueEmoji(100)).toBe("🟢");
  });

  it("should show yellow for 50-80% target", () => {
    expect(revenueEmoji(60)).toBe("🟡");
    expect(revenueEmoji(79)).toBe("🟡");
  });

  it("should show red for <50% target", () => {
    expect(revenueEmoji(30)).toBe("🔴");
    expect(revenueEmoji(49)).toBe("🔴");
  });

  it("should show correct growth arrows", () => {
    expect(growthArrow(15)).toBe("📈");
    expect(growthArrow(-5)).toBe("📉");
    expect(growthArrow(0)).toBe("📉"); // zero is not positive
  });
});
