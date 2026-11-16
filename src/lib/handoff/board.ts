/**
 * Puts the rules and the ledger together: for each deal, what state is it in
 * and what are the steps, done or still to do.
 */
import { formatDate, formatMoney } from '@/lib/format';
import type { SalesforceOpportunity } from '@/lib/systems/types';
import { listHandoffDeals, loadContext, loadShared, type Shared } from './context';
import { type DealRecord, readState, type StepName, type StepRecord } from './ledger';
import { evaluate } from './rules';
import type { DealContext, Evaluation, Plan } from './types';

export type Group = 'ready' | 'approval' | 'failed' | 'blocked' | 'done' | 'skipped';

export interface PlannedStep {
  name: StepName;
  label: string;
  /** Outward-facing or hard to undo: waits for a person to approve it */
  gated: boolean;
  /** Not to be done before this date, e.g. switching the plan on at the start date */
  notBefore?: string;
}

export interface StepView extends PlannedStep {
  record?: StepRecord;
}

export interface DealView {
  evaluation: Evaluation;
  group: Group;
  steps: StepView[];
  closeDate: string;
  /** The billing fields as they are now, to notice changes after set-up */
  fingerprint: string;
  /** "Today" as the systems saw it when this was judged */
  today: string;
}

/** The fields that decide what gets billed. If they change after set-up, a human looks. */
const BILLING_FIELDS = [
  'Plan__c',
  'Number_of_Licenses__c',
  'Total_Licenses__c',
  'Price_per_License_per_Year__c',
  'Discount__c',
  'Amount',
  'CurrencyIsoCode',
  'Start_Date__c',
  'End_Date__c',
  'Payment_Method__c',
  'PO_Number__c',
] as const;

export function fingerprint(opp: SalesforceOpportunity): string {
  return JSON.stringify(BILLING_FIELDS.map((f) => opp[f] ?? null));
}

export function planSteps(plan: Plan): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const w = plan.workspace;
  steps.push({
    name: 'workspace',
    gated: false,
    label:
      w.action === 'create'
        ? `Create workspace "${w.name}"`
        : w.action === 'link'
          ? `Link self-service workspace ${w.name} (${w.workspaceId}) to the account`
          : `Use workspace ${w.name} (${w.workspaceId})`,
  });
  if (plan.kleer) {
    const k = plan.kleer;
    const inv = k.invoice;
    steps.push({
      name: 'kleerCustomer',
      gated: false,
      label:
        k.customer.action === 'use'
          ? `Use Kleer customer ${k.customer.customerNumber}`
          : `Create Kleer customer ${k.customer.input.name}`,
    });
    steps.push({
      name: 'kleerInvoice',
      gated: false,
      label: `Draft invoice: ${formatMoney(k.expectedNet, inv.currency)} + VAT, ${formatDate(
        inv.servicePeriod?.start,
      )} – ${formatDate(inv.servicePeriod?.end)}${inv.poNumber ? `, PO ${inv.poNumber}` : ''}`,
    });
  }
  if (plan.stripe) {
    const s = plan.stripe;
    steps.push({
      name: 'stripeCustomer',
      gated: false,
      label:
        s.customer.action === 'use'
          ? `Use Stripe customer ${s.customer.customerId}`
          : `Create Stripe customer ${s.customer.input.name}`,
    });
    steps.push({
      name: 'stripeSubscription',
      gated: false,
      label: `Charge card: ${s.subscription.quantity} × ${s.subscription.plan}, ${formatMoney(
        s.subscription.amount,
        s.subscription.currency,
      )} per year`,
    });
  }
  const sub = plan.subscription;
  steps.push({
    name: 'subscription',
    gated: false,
    label:
      sub.action === 'create'
        ? `Subscription ${sub.plan} × ${sub.seats}, ${formatDate(sub.startDate)} – ${formatDate(
            sub.endDate,
          )} (${sub.status})`
        : `Update ${sub.subscriptionId} to ${sub.seats} seats, co-termed to ${formatDate(sub.endDate)}`,
  });
  if (sub.action === 'create' && plan.workspacePlan) {
    steps.push({
      name: 'activate',
      gated: false,
      notBefore: sub.startDate,
      label: `Workspace on ${plan.workspacePlan} from ${formatDate(sub.startDate)}`,
    });
  }
  if (plan.kleer) {
    steps.push({ name: 'sendInvoice', gated: true, label: 'Send the invoice to the customer' });
  }
  if (plan.stopRenewal) {
    steps.push({ name: 'stopRenewal', gated: true, label: plan.stopRenewal.description });
  }
  return steps;
}

/**
 * Judges one deal. Once the hand-off has started a deal, it keeps the plan it
 * started with: the systems now contain what it created, so judging again
 * would see its own work as a conflict.
 */
export function judge(ctx: DealContext, record: DealRecord | undefined): DealView {
  let evaluation: Evaluation;
  const started = Object.values(record?.steps ?? {}).some((s) => s?.status === 'done');
  if (record?.plan && started && ctx.opp.StageName === 'Closed Won') {
    const fresh = evaluate({ ...ctx, alreadyStarted: true });
    const changed = record.fingerprint !== undefined && record.fingerprint !== fingerprint(ctx.opp);
    const revops = ctx.users.find((u) => u.Title === 'RevOps Manager');
    evaluation = {
      ...fresh,
      status: changed ? 'blocked' : 'ready',
      issues: changed
        ? [
            {
              rule: 'R5',
              role: 'revops',
              kind: 'decision',
              ownerName: revops?.Name ?? 'RevOps',
              ownerEmail: revops?.Email ?? null,
              message:
                'The deal changed in Salesforce after the hand-off set it up. Nothing was changed automatically: check what was created against the deal and correct it (finance credits a sent invoice in full).',
            },
          ]
        : [],
      notes: record.notes ?? [],
      plan: record.plan,
    };
  } else {
    evaluation = evaluate(ctx);
  }

  const steps: StepView[] = evaluation.plan
    ? planSteps(evaluation.plan).map((s) => ({ ...s, record: record?.steps[s.name] }))
    : [];
  return {
    evaluation,
    group: groupOf(evaluation, steps, ctx.today),
    steps,
    closeDate: ctx.opp.CloseDate,
    fingerprint: fingerprint(ctx.opp),
    today: ctx.today,
  };
}

/** A step that should happen now: automatic, not done, and its date has come. */
export function isDue(step: StepView, today: string): boolean {
  return (
    !step.gated && step.record?.status !== 'done' && (!step.notBefore || step.notBefore <= today)
  );
}

function groupOf(evaluation: Evaluation, steps: StepView[], today: string): Group {
  if (evaluation.status === 'blocked') return 'blocked';
  if (evaluation.status === 'skipped') return 'skipped';
  if (steps.some((s) => s.record?.status === 'failed')) return 'failed';
  // A step scheduled for later (the start date) doesn't hold the deal back
  const automatic = steps.filter((s) => !s.gated && !(s.notBefore && s.notBefore > today));
  if (automatic.some((s) => s.record?.status !== 'done')) return 'ready';
  if (steps.some((s) => s.gated && s.record?.status !== 'done')) return 'approval';
  return 'done';
}

export async function loadDeal(oppId: string, shared?: Shared): Promise<DealView> {
  const ctx = await loadContext(oppId, shared);
  return judge(ctx, readState().deals[oppId]);
}

export async function loadBoard(): Promise<DealView[]> {
  const [deals, shared] = await Promise.all([listHandoffDeals(), loadShared()]);
  const views: DealView[] = [];
  for (const deal of deals) views.push(await loadDeal(deal.Id, shared));
  return views;
}
