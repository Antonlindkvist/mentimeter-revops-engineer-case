/**
 * Reads what the rules need about a deal, through the connectors only.
 */
import { adminApp, kleer, salesforce, stripe } from '@/lib/connectors';
import type { SalesforceOpportunity, Workspace } from '@/lib/systems/types';
import { CASE_TODAY } from './config';
import { hasStarted, readState } from './ledger';
import { domainOf } from './rules';
import type { DealContext } from './types';

/** "Today" as the mock systems see it: never earlier than 6 Nov 2026. */
export function systemToday(): string {
  const now = new Date().toISOString().slice(0, 10);
  return now > CASE_TODAY ? now : CASE_TODAY;
}

/**
 * The deals the hand-off looks at: Closed Won deals nobody has set up yet,
 * deals it has already worked on, and deals Salesforce sent events about
 * (so a reopened deal still shows up, as skipped).
 */
export async function listHandoffDeals(): Promise<SalesforceOpportunity[]> {
  const [opportunities, { events }] = await Promise.all([
    salesforce.listOpportunities(),
    salesforce.listEvents(0),
  ]);
  const state = readState();
  const fromEvents = new Set(events.map((e) => e.opportunityId));
  return opportunities
    .filter(
      (o) =>
        fromEvents.has(o.Id) ||
        o.Id in state.deals ||
        (o.StageName === 'Closed Won' && !o.Subscription_ID__c && !o.Invoice_Number__c),
    )
    .sort((a, b) => a.CloseDate.localeCompare(b.CloseDate) || a.Name.localeCompare(b.Name));
}

/** Reference data shared by every deal in a run. */
export async function loadShared() {
  const [users, products, pricebook, workspaces] = await Promise.all([
    salesforce.listUsers(),
    salesforce.listProducts(),
    salesforce.listPricebook(),
    adminApp.listWorkspaces(),
  ]);
  return { users, products, pricebook, workspaces };
}

export type Shared = Awaited<ReturnType<typeof loadShared>>;

export async function loadContext(oppId: string, shared?: Shared): Promise<DealContext> {
  const ref = shared ?? (await loadShared());
  const opp = await salesforce.getOpportunity(oppId);
  const account = await salesforce.getAccount(opp.AccountId);
  const domain = domainOf(account.Website);

  const linkedWorkspaces = ref.workspaces.filter(
    (w) => w.salesforceAccountId === account.Id || w.id === account.Workspace_ID__c,
  );
  const unlinkedWorkspaces = ref.workspaces.filter(
    (w: Workspace) => w.salesforceAccountId === null && domain !== null && w.domain === domain,
  );

  const [subscriptions, original, contact, kleerCustomer] = await Promise.all([
    adminApp.listSubscriptions({ salesforceAccountId: account.Id }),
    opp.Original_Opportunity__c
      ? salesforce.getOpportunity(opp.Original_Opportunity__c).catch(() => null)
      : null,
    opp.Billing_Contact__c ? salesforce.getContact(opp.Billing_Contact__c).catch(() => null) : null,
    findKleerCustomer(account.Kleer_Customer_Number__c, account.VAT_Number__c),
  ]);

  const stripeCustomers = (
    await Promise.all(
      linkedWorkspaces.map((w) => stripe.findCustomers({ metadata: { workspace_id: w.id } })),
    )
  ).flat();
  const stripeSubscriptions = (
    await Promise.all(stripeCustomers.map((c) => stripe.listSubscriptions({ customer: c.id })))
  ).flat();

  return {
    opp,
    account,
    users: ref.users,
    products: ref.products,
    pricebook: ref.pricebook,
    linkedWorkspaces,
    unlinkedWorkspaces,
    subscriptions,
    original,
    stripeCustomers,
    stripeSubscriptions,
    billingContactName: contact?.Name ?? null,
    kleerCustomer,
    alreadyStarted: hasStarted(opp.Id),
    today: systemToday(),
  };
}

async function findKleerCustomer(number: string | null, vatNumber: string | null) {
  if (number) {
    const customer = await kleer.getCustomer(number).catch(() => null);
    if (customer) return customer;
  }
  if (vatNumber) {
    const [match] = await kleer.findCustomers({ vatNumber });
    if (match) return match;
  }
  return null;
}
