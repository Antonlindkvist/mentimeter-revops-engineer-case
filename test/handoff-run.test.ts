/**
 * Running the hand-off on this week's deals: what it creates, that running
 * again creates nothing, and that it never reports a failed step as done.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorError, kleer, salesforce } from '@/lib/connectors';
import { readDb } from '@/lib/db';
import { loadBoard } from '@/lib/handoff/board';
import { runHandoff, sendInvoices, stopRenewals } from '@/lib/handoff/run';

afterEach(() => {
  vi.restoreAllMocks();
});

// The request log is capped, so count writes after a marker instead of all of them
const marker = () => readDb().log.at(-1)?.id ?? 0;
const writesSince = (id: number) => readDb().log.filter((e) => e.id > id && e.method !== 'GET');
const oppNamed = async (name: string) => {
  const deal = (await salesforce.listOpportunities()).find((o) => o.Name.startsWith(name));
  if (!deal) throw new Error(name);
  return salesforce.getOpportunity(deal.Id);
};
const groups = async () =>
  Object.fromEntries((await loadBoard()).map((d) => [d.evaluation.name.split(' - ')[0], d.group]));

describe('running the hand-off', () => {
  it('sets up the 7 clean deals and touches nothing else but Salesforce status', async () => {
    const summary = await runHandoff();
    expect(summary.setUp).toHaveLength(7);
    expect(summary.failed).toEqual([]);

    const db = readDb();
    const drafts = db.kleer.invoices.filter((i) => i.status === 'draft');
    expect(drafts).toHaveLength(6);
    expect(new Set(drafts.map((i) => i.foreignId)).size).toBe(6);
    expect(db.stripe.subscriptions).toHaveLength(3);
    expect(db.adminApp.subscriptions.find((s) => s.id === 'SUB-502')?.seats).toBe(95);

    const halden = drafts.find((i) => i.poNumber === 'PO-7781');
    expect(halden?.netAmount).toBe(3134.48);

    // Blocked deals got nothing in the admin app, Kleer or Stripe
    const kessler = await oppNamed('Kessler Logistik');
    expect(db.kleer.invoices.some((i) => i.foreignId === kessler.Id)).toBe(false);
    expect(db.adminApp.workspaces.find((w) => w.id === 'WS-2207')?.salesforceAccountId).toBeNull();
    expect(kessler.Handoff_Status__c).toBe('Blocked');
    expect(kessler.Handoff_Issues__c).toMatch(/^R3: .*Alex Berg/);
  });

  it('writes the result back to Salesforce for the rep', async () => {
    await runHandoff();
    const nordlys = await oppNamed('Nordlys Energi');
    expect(nordlys.Handoff_Status__c).toBe('Waiting for approval');
    expect(nordlys.Subscription_ID__c).toMatch(/^SUB-/);
    expect(nordlys.Invoice_Number__c).toBeTruthy();
    const account = await salesforce.getAccount(nordlys.AccountId);
    expect(account.Kleer_Customer_Number__c).toBeTruthy();

    const brightwell = await oppNamed('Brightwell Health');
    expect(brightwell.Handoff_Status__c).toBe('Done');
    expect(brightwell.Stripe_Subscription_ID__c).toMatch(/^sub_/);
  });

  it('creates nothing and writes nothing when run again (R5)', async () => {
    await runHandoff();
    const before = marker();
    const summary = await runHandoff();
    expect(summary.setUp).toEqual([]);
    expect(writesSince(before)).toEqual([]);
  });

  it('sends invoices only after approval, and only once', async () => {
    await runHandoff();
    expect(readDb().kleer.invoices.filter((i) => i.status === 'sent' && i.foreignId)).toHaveLength(
      0,
    );

    const first = await sendInvoices();
    expect(first.done).toHaveLength(6);
    expect(first.failed).toEqual([]);
    const second = await sendInvoices();
    expect(second.done).toEqual([]);
    expect(readDb().kleer.invoices.filter((i) => i.status === 'sent' && i.foreignId)).toHaveLength(
      6,
    );
  });

  it('stops Nordlys’ card subscription renewing after approval (R7)', async () => {
    await runHandoff();
    expect(
      readDb().stripe.subscriptions.find((s) => s.id === 'sub_1PxNordlys7Hq2Lw')
        ?.cancel_at_period_end,
    ).toBe(false);

    const result = await stopRenewals();
    expect(result.done).toEqual(['Nordlys Energi - New Enterprise']);
    const db = readDb();
    expect(
      db.stripe.subscriptions.find((s) => s.id === 'sub_1PxNordlys7Hq2Lw')?.cancel_at_period_end,
    ).toBe(true);
    expect(db.adminApp.subscriptions.find((s) => s.id === 'SUB-501')?.autoRenew).toBe(false);

    await sendInvoices();
    expect((await groups())['Nordlys Energi']).toBe('done');
  });
});

describe('when something goes wrong', () => {
  it('stops the deal at a failed step and never reports it as done', async () => {
    vi.spyOn(kleer, 'createInvoice').mockRejectedValueOnce(
      new ConnectorError('kleer', 503, 'unavailable', 'Kleer is down for maintenance'),
    );
    const summary = await runHandoff();
    expect(summary.failed).toHaveLength(1);

    const failed = (await loadBoard()).find((d) => d.group === 'failed');
    expect(failed).toBeDefined();
    const sub = failed?.steps.find((s) => s.name === 'subscription');
    expect(sub?.record).toBeUndefined();
    const opp = await salesforce.getOpportunity(failed?.evaluation.oppId ?? '');
    expect(opp.Handoff_Status__c).toBe('Failed');
    expect(opp.Handoff_Issues__c).toMatch(/Kleer is down/);
    expect(opp.Subscription_ID__c).toBeNull();

    // Next run retries and finishes it, without duplicating what was done
    const retry = await runHandoff();
    expect(retry.setUp).toEqual([failed?.evaluation.name]);
    expect(readDb().kleer.invoices.filter((i) => i.foreignId === opp.Id)).toHaveLength(1);
  });

  it('goes through on the next run once the rep fixes the deal', async () => {
    await runHandoff();
    const corvid = await oppNamed('Corvid Analytics');
    await salesforce.updateOpportunity(corvid.Id, {
      Number_of_Licenses__c: 8,
      Total_Licenses__c: 8,
    });

    const summary = await runHandoff();
    expect(summary.setUp).toEqual(['Corvid Analytics - New Pro']);
    const db = readDb();
    expect(db.adminApp.workspaces.find((w) => w.id === 'WS-2405')?.salesforceAccountId).toBe(
      corvid.AccountId,
    );
    expect(
      db.stripe.subscriptions.find((s) => s.metadata.salesforce_opportunity_id === corvid.Id),
    ).toMatchObject({
      quantity: 8,
      amount: 2080,
    });
  });

  it('flags a deal changed in Salesforce after it was set up, and changes nothing', async () => {
    await runHandoff();
    const halden = await oppNamed('Halden & Co - Add');
    await salesforce.updateOpportunity(halden.Id, { Number_of_Licenses__c: 40 });
    const before = readDb().kleer.invoices.length;

    await runHandoff();
    const view = (await loadBoard()).find((d) => d.evaluation.oppId === halden.Id);
    expect(view?.group).toBe('blocked');
    expect(view?.evaluation.issues[0]).toMatchObject({ rule: 'R5', ownerName: 'Kim Andersson' });
    expect(readDb().kleer.invoices.length).toBe(before);
  });

  it('flags a deal reopened after it was set up, for a human to reverse', async () => {
    await runHandoff();
    const okapi = await oppNamed('Okapi Learning - Renewal');
    await salesforce.updateOpportunity(okapi.Id, { StageName: 'Negotiation' });

    const view = (await loadBoard()).find((d) => d.evaluation.oppId === okapi.Id);
    expect(view?.group).toBe('blocked');
    expect(view?.evaluation.issues[0].message).toMatch(/Nothing is undone automatically/);
  });
});

describe('the Slack digest', () => {
  it('sends each owner one message with only their deals, and finance a summary', async () => {
    const { sendDigest } = await import('@/lib/handoff/slack');
    await runHandoff();
    const result = await sendDigest();
    expect(result.failed).toEqual([]);
    expect(result.sent.sort()).toEqual(
      [
        '#finance-billing',
        'Alex Berg',
        'Jordan Reyes',
        'Maja Ek',
        'Noor Haddad',
        'Priya Shah',
        'Sam Lind',
      ].sort(),
    );
    const alex = readDb().slack.messages.filter((m) => m.channel === 'U04ALEXBRG');
    expect(alex).toHaveLength(1);
    expect(alex[0].text).toMatch(/3 Closed Won deals/);
    expect(alex[0].text).toMatch(/Kessler.*\n.*R3/);
    const finance = readDb().slack.messages.find(
      (m) => m.channel === 'C04FINBILL' && m.text.startsWith('*Closed Won hand-off*'),
    );
    expect(finance?.text).toMatch(/6 invoices drafted and waiting for <@U04MAJAEK0>/);
  });

  it('does not ping anyone again when nothing changed', async () => {
    const { sendDigest } = await import('@/lib/handoff/slack');
    await runHandoff();
    await sendDigest();
    const again = await sendDigest();
    expect(again.sent).toEqual([]);
    expect(again.unchanged).toHaveLength(7);
  });
});

describe('the Salesforce webhook', () => {
  const deliverAll = async () => {
    const { POST } = await import('@/app/api/webhooks/salesforce/route');
    const { events } = await salesforce.listEvents(0);
    for (const event of events) {
      const response = await POST(
        new Request('http://localhost/api/webhooks/salesforce', {
          method: 'POST',
          body: JSON.stringify(event),
        }),
      );
      expect(response.status).toBe(202);
    }
  };

  it('sets up the same deals as the button, from this week’s 21 events', async () => {
    await deliverAll();
    const db = readDb();
    expect(db.kleer.invoices.filter((i) => i.status === 'draft')).toHaveLength(6);
    // Halden's first event said 30 licenses; the deal now says 35
    expect(db.adminApp.subscriptions.find((s) => s.id === 'SUB-502')?.seats).toBe(95);
    // Polar Bear's closed_won event arrived before it was reopened: nothing was created
    const polar = await oppNamed('Polar Bear Studios');
    expect(
      db.stripe.customers.some((c) => c.metadata.salesforce_account_id === polar.AccountId),
    ).toBe(false);
  }, 30_000);

  it('changes nothing when the same events arrive again', async () => {
    await deliverAll();
    const before = marker();
    await deliverAll();
    expect(writesSince(before)).toEqual([]);
  }, 30_000);
});
