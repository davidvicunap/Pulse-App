/**
 * The insight engine.
 *
 * The prototype's insights were a chain of `if` statements that emitted fixed strings.
 * This replaces them with a rule set where each rule is a small pure function returning
 * a structured `Insight` — including its evidence, its recommended action and its
 * expected impact — which the engine then ranks and de-duplicates.
 *
 * Three properties this buys us:
 *   - **Priority is computed, not authored.** Urgency × confidence decides what surfaces
 *     first, so the most important thing is at the top on every kind of day.
 *   - **Insights carry their evidence.** Every claim names the numbers behind it, so the
 *     user can check the reasoning rather than take it on faith.
 *   - **Rules are independently testable.** Each is a function of a context object.
 */

import type { DerivedDay, Model } from '../core/types';
import { duration, signed } from '../core/format';
import { formatClock } from '../core/dates';
import { isConfident } from '../model/baselines';
import { loadForStrain, strainBand } from '../model/strain';
import { typicalTimes } from '../model/sleep';
import {
  correlate,
  recordsSetOn,
  streaks,
  thresholdEffect,
  trendOf,
} from './analytics';

export type InsightTone = 'critical' | 'warning' | 'notable' | 'positive' | 'neutral';

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  /** The finding, in plain language. */
  body: string;
  /** What to actually do about it. Omitted when there's nothing to do. */
  action?: string;
  /** The numbers behind the claim, shown as chips. */
  evidence?: string[];
  /** 0..1 — how sure we are. Feeds ranking and can gate display. */
  confidence: number;
  /** 0..1 — how much it matters today. Feeds ranking. */
  urgency: number;
}

export interface InsightContext {
  model: Model;
  index: number;
  day: DerivedDay;
  previous: DerivedDay | null;
}

type Rule = (ctx: InsightContext) => Insight | Insight[] | null;

const TONE_WEIGHT: Record<InsightTone, number> = {
  critical: 1,
  warning: 0.82,
  notable: 0.6,
  positive: 0.5,
  neutral: 0.3,
};

// ─────────────────────────────── rules ───────────────────────────────

/** The day's headline: what recovery means for what you should do. */
const recoveryGuidance: Rule = ({ day }) => {
  const score = day.recovery.score;
  if (score == null) return null;
  const confidence = day.recovery.confidence;

  if (score < 34) {
    const headroom = loadForStrain(8, day.strain.reference);
    return {
      id: 'recovery-low',
      tone: 'critical',
      title: 'Low recovery — hold back today',
      body:
        `Recovery is ${score}%. Your body is still paying off what it has already absorbed, ` +
        `and adding hard training on top of that digs the hole deeper rather than building fitness.`,
      action: `Keep today under a strain of 8 — a walk, mobility, or a genuinely easy session (roughly ${Math.round(headroom)} load units).`,
      evidence: componentEvidence(day),
      confidence,
      urgency: 1,
    };
  }
  if (score >= 67) {
    return {
      id: 'recovery-high',
      tone: 'positive',
      title: 'Primed — this is the day to push',
      body:
        `Recovery is ${score}%. Your autonomic signals are at or above baseline, which is ` +
        `when hard work actually turns into adaptation instead of accumulated fatigue.`,
      action: 'Schedule your hardest session — or your most demanding work — for today.',
      evidence: componentEvidence(day),
      confidence,
      urgency: 0.72,
    };
  }
  return {
    id: 'recovery-moderate',
    tone: 'neutral',
    title: 'Moderate — train, but leave something in reserve',
    body:
      `Recovery is ${score}%. That's a normal working day: you can absorb quality work, ` +
      `but a maximal effort would likely cost more than it returns.`,
    action: 'Favour quality over volume, and stop a little before you would like to.',
    evidence: componentEvidence(day),
    confidence,
    urgency: 0.45,
  };
};

/** Week-over-week HRV movement — the earliest signal of accumulating stress. */
const hrvTrend: Rule = ({ model, index }) => {
  const trend = trendOf(model, 'hrv', index, 7);
  if (!trend || !trend.significant) return null;
  const falling = trend.changePct < 0;
  return {
    id: 'hrv-trend',
    tone: falling ? 'warning' : 'positive',
    title: falling ? 'HRV is trending down' : 'HRV is climbing',
    body: falling
      ? `Your 7-day HRV is down ${Math.abs(trend.changePct).toFixed(0)}% on the week before ` +
        `(${trend.previous.toFixed(0)} → ${trend.current.toFixed(0)} ms). A sustained decline usually ` +
        `means stress is accumulating faster than you're clearing it — training, work, illness or alcohol.`
      : `Your 7-day HRV is up ${trend.changePct.toFixed(0)}% on the week before ` +
        `(${trend.previous.toFixed(0)} → ${trend.current.toFixed(0)} ms). Your current balance of load ` +
        `and recovery is working.`,
    action: falling
      ? 'Protect sleep this week and pull back one hard session — the trend usually turns within days.'
      : 'Hold this pattern. If you were planning to add load, this is the window.',
    evidence: [`7d avg ${trend.current.toFixed(0)} ms`, `prior 7d ${trend.previous.toFixed(0)} ms`, signed(trend.changePct, 0, '%')],
    confidence: 0.8,
    urgency: falling ? 0.78 : 0.5,
  };
};

/** An elevated resting heart rate against baseline. */
const elevatedRhr: Rule = ({ day }) => {
  const { rhr } = day.raw;
  const baseline = day.baselines.rhr;
  if (rhr == null || !isConfident(baseline)) return null;
  const delta = rhr - baseline!.mean;
  if (delta < baseline!.sd * 1.5 || delta < 3) return null;
  return {
    id: 'rhr-elevated',
    tone: 'warning',
    title: 'Resting heart rate is up',
    body:
      `At ${Math.round(rhr)} bpm you're ${delta.toFixed(0)} bpm above your ${Math.round(baseline!.mean)} bpm ` +
      `baseline. An elevated resting rate most often means under-recovery, the start of an illness, ` +
      `alcohol, or a late heavy meal.`,
    action: 'Treat today as easy until it comes back down, and check in on it tomorrow morning.',
    evidence: [`${Math.round(rhr)} bpm today`, `baseline ${Math.round(baseline!.mean)} bpm`, signed(delta, 0, ' bpm')],
    confidence: baseline!.confidence,
    urgency: 0.72,
  };
};

/** Overnight respiratory rate — an early illness signal that precedes symptoms. */
const respiratoryFlag: Rule = ({ day }) => {
  if (!day.recovery.modifierReason) return null;
  return {
    id: 'respiratory',
    tone: 'warning',
    title: 'Breathing rate ran high overnight',
    body:
      `${day.recovery.modifierReason} A sustained rise often shows up a day or two before you ` +
      `feel anything, so it's worth treating as real even if you feel fine.`,
    action: 'Bank an early night, keep fluids up, and hold off on anything maximal for 48 hours.',
    evidence: day.raw.respiratoryRate
      ? [`${day.raw.respiratoryRate.toFixed(1)} br/min`, `baseline ${day.baselines.respiratoryRate?.mean.toFixed(1)} br/min`]
      : undefined,
    confidence: day.baselines.respiratoryRate?.confidence ?? 0.5,
    urgency: 0.8,
  };
};

/** Accumulated sleep debt over the trailing fortnight. */
const sleepDebtRule: Rule = ({ day }) => {
  const debt = day.sleep.debtMin;
  if (debt < 90) return null;
  const nights = Math.ceil(debt / 45);
  return {
    id: 'sleep-debt',
    tone: debt >= 240 ? 'warning' : 'notable',
    title: 'Sleep debt is building',
    body:
      `You're carrying about ${duration(debt)} of debt against your ${duration(day.sleep.needMin)} need ` +
      `over the last two weeks. Debt at this level shows up as lower HRV and a higher resting heart ` +
      `rate before it shows up as feeling tired.`,
    action: `An extra 45 minutes for ${nights} night${nights === 1 ? '' : 's'} clears it — going to bed earlier works better than sleeping in.`,
    evidence: [`${duration(debt)} owed`, `need ${duration(day.sleep.needMin)}`],
    confidence: 0.85,
    urgency: debt >= 240 ? 0.75 : 0.55,
  };
};

/** Stage composition — the quality half of sleep. */
const sleepQuality: Rule = ({ day }) => {
  const night = day.raw.sleep;
  if (!night || night.asleepMin <= 0) return null;
  const restorative = night.deepMin + night.remMin;
  if (restorative <= 0) return null;
  const pct = (restorative / night.asleepMin) * 100;
  if (pct >= 35) return null;
  return {
    id: 'sleep-quality',
    tone: 'notable',
    title: 'Light on deep and REM',
    body:
      `Only ${pct.toFixed(0)}% of last night was restorative — ${Math.round(night.deepMin)}m deep and ` +
      `${Math.round(night.remMin)}m REM against a healthy target of about 40%. Deep sleep does the ` +
      `physical repair; REM does the cognitive consolidation.`,
    action: 'A cooler room and no alcohol within three hours of bed move deep sleep the most.',
    evidence: [`${pct.toFixed(0)}% restorative`, `${Math.round(night.deepMin)}m deep`, `${Math.round(night.remMin)}m REM`],
    confidence: 0.75,
    urgency: 0.45,
  };
};

/** Bed/wake time scatter — the strongest lever most people never look at. */
const sleepConsistency: Rule = ({ model, index, day }) => {
  const sd = day.sleep.consistencyMin;
  if (sd == null || sd < 60) return null;
  const window = model.days.slice(Math.max(0, index - 13), index + 1).map((d) => d.raw.sleep);
  const times = typicalTimes(window);
  return {
    id: 'sleep-consistency',
    tone: 'notable',
    title: 'Your wake time is drifting',
    body:
      `Your wake times over the last fortnight vary by about ${Math.round(sd)} minutes. Consistency ` +
      `is the single strongest predictor of how rested you feel — more than total hours, for most people.`,
    action:
      times.wakeMin != null
        ? `Anchor on a fixed wake time near ${formatClock(times.wakeMin)}, including weekends, and let bedtime follow.`
        : 'Pick one wake time and hold it, including weekends.',
    evidence: [`±${Math.round(sd)} min variation`],
    confidence: 0.7,
    urgency: 0.5,
  };
};

/** Yesterday's load against today's readiness. */
const loadResponse: Rule = ({ day, previous }) => {
  if (!previous || day.recovery.score == null) return null;
  if (previous.strain.score < 14 || day.recovery.score >= 50) return null;
  return {
    id: 'load-response',
    tone: 'notable',
    title: 'Yesterday’s session is still with you',
    body:
      `You logged a strain of ${previous.strain.score.toFixed(1)} yesterday and woke at ` +
      `${day.recovery.score}%. That's a normal response to real work — the problem would be ` +
      `stacking another hard day on top of it before the signal recovers.`,
    action: 'Make today active recovery, and put your next hard session on the far side of a green day.',
    evidence: [`Yesterday ${previous.strain.score.toFixed(1)} strain`, `Today ${day.recovery.score}% recovery`],
    confidence: 0.7,
    urgency: 0.62,
  };
};

/**
 * Whether the training week is actually matching readiness.
 * Catches the common failure of grinding out moderate days regardless of signal.
 */
const strainBalance: Rule = ({ model, index }) => {
  const strain = trendOf(model, 'strain', index, 7);
  const recovery = trendOf(model, 'recovery', index, 7);
  if (!strain || !recovery) return null;
  if (strain.changePct <= 15 || recovery.changePct >= -5) return null;
  return {
    id: 'strain-balance',
    tone: 'warning',
    title: 'Load is up while recovery is down',
    body:
      `Your weekly strain rose ${strain.changePct.toFixed(0)}% while recovery fell ` +
      `${Math.abs(recovery.changePct).toFixed(0)}%. That divergence is the classic shape of ` +
      `overreaching: the work is going in, but you're not yet absorbing it.`,
    action: 'Take one full rest day this week rather than another moderate one — partial rest rarely resolves this.',
    evidence: [`Strain ${signed(strain.changePct, 0, '%')}`, `Recovery ${signed(recovery.changePct, 0, '%')}`],
    confidence: 0.72,
    urgency: 0.8,
  };
};

/** Streaks — the thing that makes a habit feel worth continuing. */
const streakRule: Rule = ({ model, index }) => {
  const found = streaks(model, index);
  if (!found.length) return null;
  const best = found.find((s) => s.kind !== 'recovery-low') ?? found[0];
  const negative = best.kind === 'recovery-low';
  return {
    id: `streak-${best.kind}`,
    tone: negative ? 'warning' : 'positive',
    title: negative ? `${best.length} days in the red` : best.label,
    body: negative
      ? `Recovery has been under 34% for ${best.length} days running. A streak this long is rarely ` +
        `just training — sleep, illness, alcohol or life stress are usually in it too.`
      : `That's ${best.label.toLowerCase()} — consistency is what actually moves baselines, and this is it.`,
    action: negative ? 'Take a genuine rest day and look at what changed two weeks ago.' : undefined,
    confidence: 0.9,
    urgency: negative ? 0.85 : 0.35,
  };
};

/** Personal records — rare, so they land when they appear. */
const recordRule: Rule = ({ model, index }) => {
  const records = recordsSetOn(model, index);
  if (!records.length) return null;
  return records.slice(0, 1).map((record) => ({
    id: `record-${record.key}`,
    tone: 'positive' as const,
    title: `Personal best: ${record.label.toLowerCase()}`,
    body:
      `Today's ${record.label.toLowerCase()} of ${formatRecord(record.key, record.value)} is your best ` +
      `across ${record.outOf} recorded days.`,
    confidence: 0.95,
    urgency: 0.4,
  }));
};

/**
 * A discovered correlation, phrased as a threshold the user can act on.
 * This is the insight that most reliably surprises people about their own data.
 */
const sleepRecoveryLink: Rule = ({ model, index }) => {
  if (index < 30) return null;
  // Lag 0: a night is filed under the morning it ends on, and the HRV that scored that
  // morning was measured during that same night. See PAIRINGS in ui/analysis.ts.
  const c = correlate(model, 'asleepMin', 'recovery', 0);
  if (!c || c.strength === 'none' || c.r <= 0) return null;
  const effect = thresholdEffect(c, 420); // seven hours
  if (!effect || effect.deltaPct >= -5) return null;
  return {
    id: 'sleep-recovery-link',
    tone: 'notable',
    title: 'Short nights cost you the morning after',
    body:
      `Across ${c.n} days of your own data, nights under 7 hours produce recovery averaging ` +
      `${effect.below.toFixed(0)}% — against ${effect.above.toFixed(0)}% after longer nights. ` +
      `That's a ${Math.abs(effect.deltaPct).toFixed(0)}% difference in how you start the day.`,
    action: 'Treat 7 hours as the floor rather than the target.',
    evidence: [`r = ${c.r.toFixed(2)}`, `${effect.nBelow} short nights`, `${effect.nAbove} full nights`],
    confidence: Math.min(0.9, 0.4 + c.n / 100),
    urgency: 0.5,
  };
};

/** Fires only when nothing else does — an empty feed would feel broken. */
const steadyState: Rule = ({ day }) => ({
  id: 'steady',
  tone: 'neutral',
  title: 'Nothing is flagging',
  body:
    day.recovery.score == null
      ? `There isn't enough data for this day to say much. Once a few weeks of HRV, resting heart rate ` +
        `and sleep are in, Pulse can compare each day against your own baselines.`
      : `Every signal is tracking near your baselines. That's the boring state that consistency is ` +
        `made of — nothing to change today.`,
  confidence: 0.5,
  urgency: 0.1,
});

const RULES: Rule[] = [
  recoveryGuidance,
  hrvTrend,
  elevatedRhr,
  respiratoryFlag,
  strainBalance,
  loadResponse,
  sleepDebtRule,
  sleepQuality,
  sleepConsistency,
  sleepRecoveryLink,
  streakRule,
  recordRule,
];

/**
 * Runs the rule set and returns insights ranked by how much they matter today.
 *
 * Ranking is `urgency × tone weight × (0.5 + confidence/2)` — so a confident warning
 * outranks a speculative one, and a critical finding outranks a positive one even when
 * the positive one is more certain.
 */
export function generateInsights(model: Model, index: number, limit = 5): Insight[] {
  if (!model.days.length || index < 0 || index >= model.days.length) return [];
  const ctx: InsightContext = {
    model,
    index,
    day: model.days[index],
    previous: index > 0 ? model.days[index - 1] : null,
  };

  const collected: Insight[] = [];
  for (const rule of RULES) {
    let result: Insight | Insight[] | null = null;
    try {
      result = rule(ctx);
    } catch {
      // A single misbehaving rule must never take down the feed.
      result = null;
    }
    if (!result) continue;
    for (const insight of Array.isArray(result) ? result : [result]) collected.push(insight);
  }

  if (!collected.length) {
    const fallback = steadyState(ctx);
    return fallback ? [fallback as Insight] : [];
  }

  const seen = new Set<string>();
  return collected
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, limit);
}

function priority(insight: Insight): number {
  return insight.urgency * TONE_WEIGHT[insight.tone] * (0.5 + insight.confidence / 2);
}

/** Turns a recovery breakdown into evidence chips. */
function componentEvidence(day: DerivedDay): string[] {
  return day.recovery.components.map((c) => {
    if (c.key === 'sleep') return `Sleep ${duration(c.value)}`;
    if (c.key === 'hrv') return `HRV ${Math.round(c.value)} ms`;
    if (c.key === 'rhr') return `RHR ${Math.round(c.value)} bpm`;
    return `${c.label} ${c.value.toFixed(0)}`;
  });
}

function formatRecord(key: string, value: number): string {
  if (key === 'asleepMin') return duration(value);
  if (key === 'hrv') return `${Math.round(value)} ms`;
  if (key === 'rhr') return `${Math.round(value)} bpm`;
  if (key === 'strain') return `${value.toFixed(1)} (${strainBand(value)})`;
  return `${Math.round(value)}%`;
}
