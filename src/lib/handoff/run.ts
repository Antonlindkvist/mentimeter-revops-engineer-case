/**
 * Carries out the plan for ready deals, and the approved steps.
 *
 * Guardrails:
 * - Every step is recorded in the ledger only after the system confirmed it,
 *   and skipped next time. Steps that create something also look in the
 *   system first (Kleer by foreignId, workspaces by account) or use Stripe's
 *   idempotency keys, so a crash between the call and the ledger write
 *   doesn't create a duplicate either.
 * - A failed step records the system's own error and stops the deal's
 *   remaining steps. Nothing is reported as done that didn't happen.
 */
import { adminApp, kleer, salesforce, stripe } from '@/lib/connectors';
import type { FieldValue } from '@/lib/systems/types';
import { type DealView, type Group, isDue, loadDeal } from './board';
import { listHandoffDeals, loadShared, type Shared, systemToday } from './context';
import {
  doneRef,
  readState,
  recordPlan,
  recordRun,
  recordStep,
  recordWriteBack,
  type StepName,
} from './ledger';

class StepFailed extends Error {}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function step(oppId: string, name: StepName, action: () => Promise<string>): Promise<string> {
  const done = doneRef(oppId, name);
  if (done !== undefined) return done;
  try {
    const ref = await action();
    recordStep(oppId, name, { status: 'done', ref });
    return ref;
  } catch (error) {
    recordStep(oppId, name, { status: 'failed', error: errorMessage(error) });
    throw new StepFailed(errorMessage(error));
  }
}

export interface RunSummary {
  looked: number;
  setUp: string[];
  failed: { name: string; error: string }[];
}

/** Runs the hand-off for every deal, or for one deal (from a Salesforce event). */
export async function runHandoff(onlyOppId?: string): Promise<RunSummary> {
  const shared = await loadShared();
  const ids = onlyOppId ? [onlyOppId] : (await listHandoffDeals()).map((d) => d.Id);
  const summary: RunSummary = { looked: ids.length, setUp: [], failed: [] };
  for (const id of ids) {
    const view = await loadDeal(id, shared);
    const started = view.steps.some((s) => s.record?.status === 'done');
    const isNew = view.group === 'failed' || (view.group === 'ready' && !started);
    // Deals already set up still run when a scheduled step is due (the start date)
    const due = view.steps.some((s) => isDue(s, systemToday()));
    if (view.group !== 'blocked' && view.group !== 'skipped' && (isNew || due)) {
      try {
        await executeDeal(view, shared);
        if (isNew) summary.setUp.push(view.evaluation.name);
      } catch (error) {
        summary.failed.push({ name: view.evaluation.name, error: errorMessage(error) });
      }
    }
    await writeBack(await loadDeal(id, shared));
  }
  recordRun();
  return summary;
}

async function executeDeal(view: DealView, shared: Shared) {
  const { oppId, accountId } = view.evaluation;
  const plan = view.evaluation.plan;
  if (!plan) return;
  recordPlan(oppId, plan, view.evaluation.notes, view.fingerprint);

  const workspaceId = await step(oppId, 'workspace', async () => {
    const w = plan.workspace;
    if (w.action === 'use') return w.workspaceId;
    if (w.action === 'link') {
      await adminApp.updateWorkspace(w.workspaceId, { salesforceAccountId: accountId });
      return w.workspaceId;
    }
    const [existing] = await adminApp.listWorkspaces({ salesforceAccountId: accountId });
    if (existing) return existing.id;
    const created = await adminApp.createWorkspace({
      name: w.name,
      salesforceAccountId: accountId,
      domain: w.domain,
      region: w.region,
    });
    shared.workspaces.push(created);
    return created.id;
  });

  let billingReference: string | null = null;
  let kleerCustomerNumber: string | null = null;

  if (plan.kleer) {
    const k = plan.kleer;
    kleerCustomerNumber = await step(oppId, 'kleerCustomer', async () => {
      if (k.customer.action === 'use') return k.customer.customerNumber;
      const input = k.customer.input;
      const [existing] = input.vatNumber
        ? await kleer.findCustomers({ vatNumber: input.vatNumber })
        : [];
      return existing?.customerNumber ?? (await kleer.createCustomer(input)).customerNumber;
    });
    const customerNumber = kleerCustomerNumber;
    billingReference = await step(oppId, 'kleerInvoice', async () => {
      // Kleer doesn't stop duplicates, so look for ours first (R5)
      const existing = (await kleer.findInvoices({ foreignId: oppId })).find(
        (i) => i.type === 'invoice' && i.status !== 'credited',
      );
      if (existing) return existing.invoiceNumber;
      const invoice = await kleer.createInvoice({ ...k.invoice, customerNumber });
      if (Math.abs(invoice.netAmount - k.expectedNet) > 0.01) {
        await kleer.deleteDraft(invoice.invoiceNumber);
        throw new Error(
          `Kleer worked out ${invoice.netAmount} ${invoice.currency}, the deal says ${k.expectedNet}. The draft was deleted.`,
        );
      }
      return invoice.invoiceNumber;
    });
  }

  if (plan.stripe) {
    const s = plan.stripe;
    const customerId = await step(oppId, 'stripeCustomer', async () => {
      if (s.customer.action === 'use') return s.customer.customerId;
      const input = s.customer.input;
      const customer = await stripe.createCustomer(
        { ...input, metadata: { ...input.metadata, workspace_id: workspaceId } },
        { idempotencyKey: `handoff-${oppId}-customer` },
      );
      return customer.id;
    });
    billingReference = await step(oppId, 'stripeSubscription', async () => {
      const subscription = await stripe.createSubscription(
        {
          customer: customerId,
          ...s.subscription,
          metadata: { ...s.subscription.metadata, workspace_id: workspaceId },
        },
        { idempotencyKey: `handoff-${oppId}-subscription` },
      );
      if (
        subscription.status === 'past_due' ||
        subscription.latest_invoice_status === 'payment_failed'
      ) {
        throw new Error(
          `Stripe created ${subscription.id} but the payment failed (${subscription.last_payment_error ?? 'no reason given'}). Nothing is set up in the admin app until it's paid; Tom Becker should follow up.`,
        );
      }
      return subscription.id;
    });
  }

  const subscriptionId = await step(oppId, 'subscription', async () => {
    const sub = plan.subscription;
    if (sub.action === 'update') {
      await adminApp.updateSubscription(sub.subscriptionId, {
        seats: sub.seats,
        endDate: sub.endDate,
      });
      return sub.subscriptionId;
    }
    const existing = (await adminApp.listSubscriptions({ workspaceId })).find(
      (s) =>
        s.plan === sub.plan &&
        s.startDate === sub.startDate &&
        s.seats === sub.seats &&
        s.status !== 'Cancelled',
    );
    if (existing) return existing.id;
    const created = await adminApp.createSubscription({
      workspaceId,
      salesforceAccountId: accountId,
      plan: sub.plan,
      seats: sub.seats,
      startDate: sub.startDate,
      endDate: sub.endDate,
      status: sub.status,
      billingSystem: sub.billingSystem,
      autoRenew: false,
      billingReference,
    });
    return created.id;
  });

  // The customer gets the plan on the start date (Lea), not before billing is set up (Tom)
  const sub = plan.subscription;
  if (sub.action === 'create' && plan.workspacePlan && sub.startDate <= systemToday()) {
    const workspacePlan = plan.workspacePlan;
    await step(oppId, 'activate', async () => {
      const current = await adminApp.getSubscription(subscriptionId);
      if (current.status === 'Scheduled') {
        await adminApp.updateSubscription(subscriptionId, { status: 'Active' });
      }
      const workspace = await adminApp.getWorkspace(workspaceId);
      if (workspace.plan !== workspacePlan) {
        await adminApp.updateWorkspace(workspaceId, { plan: workspacePlan });
      }
      return workspacePlan;
    });
  }

  // Keep the account linked to what it now has, so the next deal finds it
  const account = await salesforce.getAccount(accountId);
  const links: Record<string, FieldValue> = {};
  if (account.Workspace_ID__c !== workspaceId) links.Workspace_ID__c = workspaceId;
  if (kleerCustomerNumber && account.Kleer_Customer_Number__c !== kleerCustomerNumber) {
    links.Kleer_Customer_Number__c = kleerCustomerNumber;
  }
  if (Object.keys(links).length > 0) await salesforce.updateAccount(accountId, links);
}

const STATUS_LABEL: Record<Group, string> = {
  ready: 'Ready',
  approval: 'Waiting for approval',
  failed: 'Failed',
  blocked: 'Blocked',
  done: 'Done',
  skipped: 'Skipped',
};

/** Tells the rep in Salesforce where their deal is. Writes only when something changed. */
async function writeBack(view: DealView) {
  const { oppId } = view.evaluation;
  const record = readState().deals[oppId];
  if (view.group === 'skipped' && !record) return;
  const ref = (name: StepName) => view.steps.find((s) => s.name === name)?.record;
  const doneId = (name: StepName) =>
    ref(name)?.status === 'done' ? (ref(name)?.ref ?? null) : null;
  const failed = view.steps.find((s) => s.record?.status === 'failed');

  const fields: Record<string, FieldValue> = {
    Handoff_Status__c: STATUS_LABEL[view.group],
    Handoff_Issues__c: failed
      ? `${failed.label}: ${failed.record?.error}`
      : view.evaluation.issues.map((i) => `${i.rule}: ${i.message} (${i.ownerName})`).join('\n') ||
        null,
  };
  if (doneId('subscription')) fields.Subscription_ID__c = doneId('subscription');
  if (doneId('kleerInvoice')) fields.Invoice_Number__c = doneId('kleerInvoice');
  if (doneId('stripeSubscription')) fields.Stripe_Subscription_ID__c = doneId('stripeSubscription');

  const written = JSON.stringify(fields);
  if (record?.writtenBack === written) return;
  await salesforce.updateOpportunity(oppId, fields);
  recordWriteBack(oppId, written);
}

// ── Approvals ────────────────────────────────────────────────

export interface ApprovalSummary {
  done: string[];
  failed: { name: string; error: string }[];
}

async function approve(
  name: StepName,
  action: (view: DealView) => Promise<string>,
): Promise<ApprovalSummary> {
  const shared = await loadShared();
  const summary: ApprovalSummary = { done: [], failed: [] };
  for (const deal of await listHandoffDeals()) {
    const view = await loadDeal(deal.Id, shared);
    const pending = view.steps.find((s) => s.name === name && s.record?.status !== 'done');
    if (view.group !== 'approval' || !pending) continue;
    try {
      await step(deal.Id, name, () => action(view));
      summary.done.push(view.evaluation.name);
    } catch (error) {
      summary.failed.push({ name: view.evaluation.name, error: errorMessage(error) });
    }
    await writeBack(await loadDeal(deal.Id, shared));
  }
  return summary;
}

/** Maja's one click: sends every drafted invoice that's waiting. */
export function sendInvoices() {
  return approve('sendInvoice', async (view) => {
    const invoiceNumber = view.steps.find((s) => s.name === 'kleerInvoice')?.record?.ref;
    if (!invoiceNumber) throw new Error('No drafted invoice to send.');
    const invoice = await kleer.getInvoice(invoiceNumber);
    if (invoice.status === 'draft') await kleer.sendInvoice(invoiceNumber);
    return invoiceNumber;
  });
}

/** Stops the subscriptions a new deal replaces from renewing (R7). */
export function stopRenewals() {
  return approve('stopRenewal', async (view) => {
    const stop = view.evaluation.plan?.stopRenewal;
    if (!stop) throw new Error('Nothing to stop.');
    if (stop.stripeSubscriptionId) {
      const updated = await stripe.updateSubscription(
        stop.stripeSubscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey: `handoff-${view.evaluation.oppId}-stop-renewal` },
      );
      if (!updated.cancel_at_period_end) throw new Error(`Stripe still renews ${updated.id}.`);
    }
    await adminApp.updateSubscription(stop.subscriptionId, { autoRenew: false });
    return stop.subscriptionId;
  });
}
