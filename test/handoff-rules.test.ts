/**
 * The hand-off rules on this week's 18 deals. Each test reads the deal from
 * the mock systems, as the app does, and checks the verdict.
 */
import { describe, expect, it } from 'vitest';
import { salesforce } from '@/lib/connectors';
import { listHandoffDeals, loadContext } from '@/lib/handoff/context';
import { evaluate } from '@/lib/handoff/rules';

async function verdict(name: string) {
  const deals = await salesforce.listOpportunities();
  const deal = deals.find((d) => d.Name.startsWith(name));
  if (!deal) throw new Error(`No deal named ${name}`);
  return evaluate(await loadContext(deal.Id));
}

const rules = (e: Awaited<ReturnType<typeof verdict>>) => e.issues.map((i) => i.rule).sort();
const owners = (e: Awaited<ReturnType<typeof verdict>>) => [
  ...new Set(e.issues.map((i) => i.ownerName)),
];

describe('which deals the hand-off looks at', () => {
  it('finds the 18 deals Salesforce announced this week, including the reopened one', async () => {
    const deals = await listHandoffDeals();
    expect(deals).toHaveLength(18);
    expect(deals.filter((d) => d.StageName === 'Closed Won')).toHaveLength(17);
  });
});

describe('clean deals are ready to set up', () => {
  it('Brightwell: card, new workspace, Stripe for the first year', async () => {
    const e = await verdict('Brightwell Health');
    expect(e.status).toBe('ready');
    expect(e.plan?.billingSystem).toBe('Stripe');
    expect(e.plan?.workspace).toMatchObject({
      action: 'create',
      domain: 'brightwell.example',
      region: 'US',
    });
    expect(e.plan?.stripe?.subscription).toMatchObject({
      plan: 'PRO',
      quantity: 15,
      amount: 3900,
      currency: 'usd',
    });
  });

  it('Fjordline: invoices the onboarding package as its own line', async () => {
    const e = await verdict('Fjordline Media');
    expect(e.status).toBe('ready');
    expect(e.plan?.kleer?.invoice.lines.map((l) => l.articleNumber)).toEqual(['ENT', 'ONB']);
    expect(e.plan?.kleer?.expectedNet).toBe(14980);
  });

  it('Torvik: two-year subscription, invoice for year 1 only', async () => {
    const e = await verdict('Torvik Bygg');
    expect(e.status).toBe('ready');
    expect(e.plan?.subscription).toMatchObject({ action: 'create', endDate: '2028-11-19' });
    expect(e.plan?.kleer?.invoice.servicePeriod).toEqual({
      start: '2026-11-20',
      end: '2027-11-19',
    });
    expect(e.plan?.kleer?.expectedNet).toBe(120000);
  });

  it('Okapi renewal: new subscription from 1 Dec on the existing Kleer customer', async () => {
    const e = await verdict('Okapi Learning - Renewal');
    expect(e.status).toBe('ready');
    expect(e.plan?.subscription).toMatchObject({
      action: 'create',
      seats: 50,
      startDate: '2026-12-01',
    });
    expect(e.plan?.kleer?.customer).toEqual({ action: 'use', customerNumber: '1077' });
    expect(e.plan?.stopRenewal).toBeNull();
  });

  it('Wavecrest: Payment method wins over the legacy card checkbox', async () => {
    const e = await verdict('Wavecrest Hotels');
    expect(e.status).toBe('ready');
    expect(e.plan?.billingSystem).toBe('Kleer');
    expect(e.notes.join(' ')).toMatch(/legacy/);
  });

  it('Halden add-on: uses the current 35 licenses, co-terms SUB-502 and prorates by day', async () => {
    const e = await verdict('Halden & Co - Add');
    expect(e.status).toBe('ready');
    expect(e.plan?.subscription).toEqual({
      action: 'update',
      subscriptionId: 'SUB-502',
      seats: 95,
      endDate: '2027-02-28',
    });
    const line = e.plan?.kleer?.invoice.lines[0];
    expect(line).toMatchObject({ quantity: 35, unitPrice: 94.27, discountPercent: 5 });
    expect(e.plan?.kleer?.invoice.poNumber).toBe('PO-7781');
    expect(e.plan?.kleer?.expectedNet).toBe(3134.48);
    expect(e.notes.join(' ')).toMatch(/111\/365/);
  });

  it('Nordlys: invoice, and the old card subscription must stop renewing (R7)', async () => {
    const e = await verdict('Nordlys Energi');
    expect(e.status).toBe('ready');
    expect(e.plan?.workspace).toMatchObject({ action: 'use', workspaceId: 'WS-1001' });
    expect(e.plan?.kleer?.customer.action).toBe('create');
    expect(e.plan?.stopRenewal).toMatchObject({
      subscriptionId: 'SUB-501',
      stripeSubscriptionId: 'sub_1PxNordlys7Hq2Lw',
      endDate: '2026-11-14',
    });
  });
});

describe('deals the rep has to fix', () => {
  it('Corvid: licenses say 10, the product line and amount say 8', async () => {
    const e = await verdict('Corvid Analytics');
    expect(e.status).toBe('blocked');
    expect(rules(e)).toEqual(['R8']);
    expect(owners(e)).toEqual(['Jordan Reyes']);
    expect(e.issues[0].message).toMatch(/says 10.*says 8/);
  });

  it('Kessler: PO required but missing (R3)', async () => {
    const e = await verdict('Kessler Logistik');
    expect(e.status).toBe('blocked');
    expect(rules(e)).toEqual(['R3']);
    expect(owners(e)).toEqual(['Alex Berg']);
  });

  it('Alpenblick: no VAT ID and no invoice email (R4)', async () => {
    const e = await verdict('Alpenblick Versicherung');
    expect(rules(e)).toEqual(['R4', 'R4']);
    expect(owners(e)).toEqual(['Alex Berg']);
  });

  it('Vantera: 122,400 EUR by card is above the limit (R2)', async () => {
    const e = await verdict('Vantera Group');
    expect(rules(e)).toEqual(['R2']);
    expect(owners(e)).toEqual(['Noor Haddad']);
  });

  it('Arcadia: the VAT ID is malformed (R4)', async () => {
    const e = await verdict('Arcadia Retail');
    expect(rules(e)).toEqual(['R4']);
    expect(e.issues[0].message).toMatch(/FR 12 3456/);
  });

  it('Lumen: 40% discount waits for Deal Desk', async () => {
    const e = await verdict('Lumen Hochschule');
    expect(rules(e)).toEqual(['Policy']);
    expect(e.issues[0].kind).toBe('approval');
  });
});

describe('deals that need a decision', () => {
  it('Maris: the account is in CHF, the deal in EUR (R8), finance decides', async () => {
    const e = await verdict('Maris Shipping');
    expect(rules(e)).toEqual(['R8']);
    expect(owners(e)).toEqual(['Maja Ek']);
  });

  it('Quill & Ink: starts before it closed, finance decides', async () => {
    const e = await verdict('Quill & Ink');
    expect(rules(e)).toEqual(['Decision']);
    expect(e.issues[0].message).toMatch(/No existing workspace/);
  });

  it('Helix: two self-service workspaces match, the rep picks one', async () => {
    const e = await verdict('Helix Pharma');
    expect(rules(e)).toEqual(['Decision']);
    expect(e.issues[0].message).toMatch(/WS-2310.*WS-2311/);
  });

  it('Sable & Finch: overlaps a live subscription (R7) and the card has expired', async () => {
    const e = await verdict('Sable & Finch');
    expect(rules(e)).toEqual(['R1', 'R7']);
    expect(owners(e)).toEqual(['Priya Shah']);
  });
});

describe('deals the hand-off leaves alone', () => {
  it('Polar Bear was reopened, so it is skipped', async () => {
    const e = await verdict('Polar Bear Studios');
    expect(e.status).toBe('skipped');
    expect(e.plan).toBeNull();
  });
});
