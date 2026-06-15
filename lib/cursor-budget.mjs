import { readCursorAccessTokenAsync, readCursorAccountEmailAsync } from './cursor-auth.mjs';

const USAGE_API_URL =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

function centsToIsoDate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return new Date(numeric).toISOString();
}

function buildBudgetFromPlanUsage(planUsage) {
  if (!planUsage || typeof planUsage !== 'object') {
    return null;
  }

  const limitCents = Number(planUsage.limit ?? 0);
  const includedSpendCents = Number(planUsage.includedSpend ?? 0);
  const totalSpendCents = Number(planUsage.totalSpend ?? includedSpendCents);
  const bonusSpendCents = Number(planUsage.bonusSpend ?? 0);
  const percentUsed = Number(planUsage.totalPercentUsed ?? 0);
  const remainingCents = Math.max(0, limitCents - includedSpendCents);

  return {
    usedCents: includedSpendCents,
    remainingCents,
    limitCents,
    totalSpendCents,
    bonusSpendCents,
    percentUsed,
    currency: 'USD',
  };
}

function buildOnDemandUsage(planUsage, payload) {
  if (!planUsage || typeof planUsage !== 'object') {
    return null;
  }

  return {
    includedSpendCents: Number(planUsage.includedSpend ?? 0),
    bonusSpendCents: Number(planUsage.bonusSpend ?? 0),
    totalSpendCents: Number(planUsage.totalSpend ?? 0),
    autoPercentUsed: Number(planUsage.autoPercentUsed ?? 0),
    apiPercentUsed: Number(planUsage.apiPercentUsed ?? 0),
    totalPercentUsed: Number(planUsage.totalPercentUsed ?? 0),
    remainingBonus: Boolean(planUsage.remainingBonus),
    bonusTooltip:
      typeof planUsage.bonusTooltip === 'string' ? planUsage.bonusTooltip : null,
    displayMessage:
      typeof payload.displayMessage === 'string' ? payload.displayMessage : null,
    autoModelSelectedDisplayMessage:
      typeof payload.autoModelSelectedDisplayMessage === 'string'
        ? payload.autoModelSelectedDisplayMessage
        : null,
    namedModelSelectedDisplayMessage:
      typeof payload.namedModelSelectedDisplayMessage === 'string'
        ? payload.namedModelSelectedDisplayMessage
        : null,
    currency: 'USD',
  };
}

export async function fetchCursorAccountBudget() {
  const accessToken = await readCursorAccessTokenAsync();
  const email = await readCursorAccountEmailAsync();

  if (!accessToken) {
    return {
      email,
      budget: null,
      onDemandUsage: null,
      billingCycle: null,
      error: 'missing_access_token',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  let response;
  try {
    response = await fetch(USAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        email,
        budget: null,
        onDemandUsage: null,
        billingCycle: null,
        error: 'usage_api_timeout',
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text();
    return {
      email,
      budget: null,
      onDemandUsage: null,
      billingCycle: null,
      error: `usage_api_${response.status}: ${body.slice(0, 200)}`,
    };
  }

  const payload = await response.json();
  const billingCycle =
    payload.billingCycleStart || payload.billingCycleEnd
      ? {
          start: centsToIsoDate(payload.billingCycleStart),
          end: centsToIsoDate(payload.billingCycleEnd),
        }
      : null;

  return {
    email,
    budget: buildBudgetFromPlanUsage(payload.planUsage),
    onDemandUsage: buildOnDemandUsage(payload.planUsage, payload),
    billingCycle,
    error: null,
  };
}
