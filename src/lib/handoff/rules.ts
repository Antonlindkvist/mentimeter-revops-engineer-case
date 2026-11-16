/**
 * The hand-off rules. `evaluate` is a pure function: it takes what the systems
 * say about one deal and decides whether the deal can be set up
 * automatically, and if not, why and who can fix it. It never writes anything.
 */
import { formatDate, formatMoney } from '@/lib/format';
import type { SalesforceUser } from '@/lib/systems/types';
import {
  CARD_LIMIT_EUR,
  DISCOUNT_APPROVAL_ABOVE,
  EU_VAT_PREFIX,
  EUR_RATES,
  PAYMENT_TERMS_DAYS,
} from './config';
import { daysInclusive, shiftDays, termEnd } from './dates';
import type {
  DealContext,
  Evaluation,
  Issue,
  KleerStep,
  OwnerRole,
  Plan,
  StopRenewalStep,
  StripeStep,
  SubscriptionStep,
  WorkspaceStep,
} from './types';

const ROLE_TITLES: Record<Exclude<OwnerRole, 'rep'>, string> = {
  finance: 'Billing Specialist',
  revops: 'RevOps Manager',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website.includes('://') ? website : `https://${website}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return null;
  }
}

function termMonths(term: string | null): number | null {
  const match = term?.match(/^(\d+) months$/);
  return match ? Number(match[1]) : null;
}

export function evaluate(ctx: DealContext): Evaluation {
  const { opp, account } = ctx;
  const owner = ctx.users.find((u) => u.Id === opp.OwnerId);
  const issues: Issue[] = [];
  const notes: string[] = [];
  const cur = opp.CurrencyIsoCode;
  const money = (n: number, currency = cur) => formatMoney(n, currency);

  const person = (role: OwnerRole): SalesforceUser | undefined =>
    role === 'rep' ? owner : ctx.users.find((u) => u.Title === ROLE_TITLES[role]);
  const add = (rule: string, role: OwnerRole, kind: Issue['kind'], message: string) => {
    const p = person(role);
    issues.push({
      rule,
      role,
      kind,
      message,
      ownerName: p?.Name ?? role,
      ownerEmail: p?.Email ?? null,
    });
  };

  const result = (plan: Plan | null): Evaluation => ({
    oppId: opp.Id,
    name: opp.Name,
    accountId: account.Id,
    accountName: account.Name,
    ownerName: owner?.Name ?? 'Unknown',
    type: opp.RecordType.DeveloperName,
    amount: opp.Amount,
    currency: cur,
    status: issues.length > 0 ? 'blocked' : plan ? 'ready' : 'skipped',
    issues,
    notes,
    plan: issues.length > 0 ? null : plan,
  });

  // Always judge the deal as it is now. A reopened deal is not ours to set up.
  if (opp.StageName !== 'Closed Won') {
    if (ctx.alreadyStarted) {
      add(
        'R5',
        'revops',
        'decision',
        `Moved back to ${opp.StageName} after the hand-off had started. Nothing is undone automatically: decide whether to reverse what was set up.`,
      );
    } else {
      notes.push(`No longer Closed Won (now ${opp.StageName}). Nothing to set up.`);
    }
    return result(null);
  }

  // ── The deal has what we need ──────────────────────────────
  const plan = opp.Plan__c;
  const licenses = opp.Number_of_Licenses__c;
  const total = opp.Total_Licenses__c;
  const price = opp.Price_per_License_per_Year__c;
  const start = opp.Start_Date__c;
  const end = opp.End_Date__c;
  const method = opp.Payment_Method__c;
  const discount = opp.Discount__c ?? 0;
  const missing = Object.entries({
    Plan: plan,
    'Number of licenses': licenses,
    'Total licenses': total,
    'Price per license': price,
    'Start date': start,
    'End date': end,
    'Payment method': method,
  })
    .filter(([, value]) => value === null || value === undefined || value === '')
    .map(([label]) => label);
  if (!plan || !licenses || !total || !price || !start || !end || !method) {
    add('Data', 'rep', 'fix', `Missing on the deal: ${missing.join(', ')}.`);
    return result(null);
  }

  // ── R1: where it's billed ──────────────────────────────────
  if (method !== 'Invoice' && method !== 'Card') {
    add('R1', 'rep', 'fix', `Payment method is "${method}". Set it to Invoice or Card.`);
  }
  if (method === 'Invoice' && opp.Credit_Card_Payment__c) {
    notes.push(
      'The legacy "Credit card payment" checkbox is ticked, but Payment method says Invoice. Payment method wins: the checkbox comes from the old quote template.',
    );
  }
  const billingSystem = method === 'Card' ? 'Stripe' : 'Kleer';

  // ── R8: the numbers agree ──────────────────────────────────
  const productOf = (code: string) => ctx.products.find((p) => p.ProductCode === code);
  const product = productOf(plan);
  const lines = opp.OpportunityLineItems.records;
  const planLine = lines.find((l) => l.ProductCode === plan);
  const oneOffLines = lines.filter((l) => productOf(l.ProductCode)?.Family === 'Services');
  let linesAgree = true;
  if (!planLine) {
    add('R8', 'rep', 'fix', `There is no ${plan} product line on the deal.`);
    linesAgree = false;
  } else if (planLine.Quantity !== licenses) {
    const amountFitsLine =
      opp.Amount !== null &&
      Math.abs(planLine.TotalPrice + sum(oneOffLines.map((l) => l.TotalPrice)) - opp.Amount) < 0.01;
    add(
      'R8',
      'rep',
      'fix',
      `Number of licenses says ${licenses}, but the ${plan} product line says ${planLine.Quantity}${
        amountFitsLine
          ? ` and the Amount (${money(opp.Amount ?? 0)}) matches ${planLine.Quantity}`
          : ''
      }. Correct Number of licenses and Total licenses.`,
    );
    linesAgree = false;
  } else if (planLine.UnitPrice !== price || planLine.Discount !== discount) {
    add(
      'R8',
      'rep',
      'fix',
      'The product line and the deal disagree on list price or discount. Make them match.',
    );
    linesAgree = false;
  }

  const listPrice = ctx.pricebook.find(
    (p) => p.ProductCode === plan && p.CurrencyIsoCode === cur && p.IsActive,
  )?.UnitPrice;
  if (account.CurrencyIsoCode !== cur) {
    const hasAccountPrices = ctx.pricebook.some(
      (p) => p.CurrencyIsoCode === account.CurrencyIsoCode,
    );
    add(
      'R8',
      'finance',
      'decision',
      `The account is billed in ${account.CurrencyIsoCode} but the deal is in ${cur}. R8 says the amount is in the account's currency${
        hasAccountPrices ? '' : `, and there is no ${account.CurrencyIsoCode} price list`
      }. Decide which currency to bill in, or correct the account.`,
    );
  } else if (listPrice === undefined) {
    add('R8', 'finance', 'decision', `There is no ${plan} list price in ${cur}.`);
  } else if (listPrice !== price) {
    add(
      'R8',
      'rep',
      'fix',
      `List price on the deal is ${money(price)}, the price book says ${money(listPrice)}.`,
    );
  }

  const months = termMonths(opp.Contract_Term__c);
  const years = opp.Multi_Year_deal__c && months ? months / 12 : 1;
  const yearly = round2(licenses * price * (1 - discount / 100));
  const oneOff = round2(sum(oneOffLines.map((l) => l.TotalPrice)));
  const expectedAmount = round2(yearly * years + oneOff);
  if (linesAgree && opp.Amount !== null && Math.abs(opp.Amount - expectedAmount) > 0.01) {
    add(
      'R8',
      'rep',
      'fix',
      `Amount is ${money(opp.Amount)}, but licenses × price × (1 − discount) gives ${money(expectedAmount)}.`,
    );
  }
  if (product?.Min_Licenses__c && total < product.Min_Licenses__c) {
    add(
      'Data',
      'rep',
      'fix',
      `${product.Name} needs at least ${product.Min_Licenses__c} licenses; the deal has ${total}.`,
    );
  }

  // ── Deal Desk ──────────────────────────────────────────────
  if (discount > DISCOUNT_APPROVAL_ABOVE && opp.Discount_Approval__c !== 'Approved') {
    add(
      'Policy',
      'rep',
      'approval',
      `${discount}% discount needs Deal Desk approval before the deal is booked (approval: ${
        opp.Discount_Approval__c ?? 'not requested'
      }). Nothing is set up until it's approved.`,
    );
  }

  // ── R2: card limit ─────────────────────────────────────────
  const firstYear = round2(yearly + oneOff);
  if (method === 'Card') {
    const rate = EUR_RATES[cur];
    if (rate === undefined) {
      add('R2', 'finance', 'decision', `No exchange rate for ${cur} to check the card limit.`);
    } else if (firstYear * rate > CARD_LIMIT_EUR) {
      add(
        'R2',
        'rep',
        'fix',
        `Card payments are allowed up to ${formatMoney(CARD_LIMIT_EUR, 'EUR')} a year. This deal is ${money(firstYear)}${
          cur === 'EUR' ? '' : ` (about ${formatMoney(Math.round(firstYear * rate), 'EUR')})`
        }. Change Payment method to Invoice.`,
      );
    }
  }

  // ── Dates ──────────────────────────────────────────────────
  const domain = domainOf(account.Website);
  const noWorkspace = ctx.linkedWorkspaces.length === 0 && ctx.unlinkedWorkspaces.length === 0;
  if (start < opp.CloseDate) {
    add(
      'Decision',
      'finance',
      'decision',
      `The contract starts ${formatDate(start)}, before the deal closed (${formatDate(opp.CloseDate)}). Invoicing for time that has already passed needs finance's OK${
        noWorkspace && domain ? `. No existing workspace was found for ${domain} either` : ''
      }.`,
    );
  }
  if (opp.RecordType.DeveloperName !== 'Add_on') {
    if (!months) {
      add(
        'Data',
        'rep',
        'fix',
        `Contract term "${opp.Contract_Term__c ?? ''}" isn't a number of months.`,
      );
    } else if (end !== termEnd(start, months)) {
      add(
        'Data',
        'rep',
        'fix',
        `End date ${formatDate(end)} doesn't match a ${months}-month term from ${formatDate(start)} (expected ${formatDate(termEnd(start, months))}).`,
      );
    }
  }

  // ── R3 and R4: what an invoice needs ───────────────────────
  if (method === 'Invoice') {
    if (account.PO_Required__c && !opp.PO_Number__c) {
      add(
        'R3',
        'rep',
        'fix',
        `${account.Name} requires a PO number on every invoice, and the deal has none. Add PO number to the deal; the invoice is prepared as soon as it's there.`,
      );
    }
    if (!account.Legal_Entity_Name__c) {
      add('R4', 'rep', 'fix', 'Legal entity name is missing on the account.');
    }
    if (!account.Invoice_Email__c) {
      add('R4', 'rep', 'fix', 'Invoice email is missing on the account.');
    } else if (!EMAIL.test(account.Invoice_Email__c)) {
      add('R4', 'rep', 'fix', `Invoice email "${account.Invoice_Email__c}" isn't a valid address.`);
    }
    const prefix = EU_VAT_PREFIX[account.BillingCountry];
    if (prefix && account.BillingCountry !== 'Sweden') {
      const vat = account.VAT_Number__c;
      if (!vat) {
        add(
          'R4',
          'rep',
          'fix',
          `${account.BillingCountry} is in the EU, so the invoice needs a VAT ID. Without one Kleer charges 25% Swedish VAT, which the customer will dispute.`,
        );
      } else {
        const normalized = vat.replace(/[\s.-]/g, '').toUpperCase();
        if (!normalized.startsWith(prefix) || !/^[A-Z]{2}[0-9A-Z]{8,12}$/.test(normalized)) {
          add(
            'R4',
            'rep',
            'fix',
            `VAT ID "${vat}" doesn't look like a ${account.BillingCountry} VAT number (${prefix} followed by 8–12 characters).`,
          );
        }
      }
    }
  } else if (!account.Invoice_Email__c || !EMAIL.test(account.Invoice_Email__c)) {
    add(
      'Data',
      'rep',
      'fix',
      'Stripe needs a billing email: Invoice email on the account is missing or invalid.',
    );
  }

  // ── R6 and R7: existing subscriptions ──────────────────────
  const live = ctx.subscriptions.filter((s) => s.status === 'Active' || s.status === 'Scheduled');
  const status = start > ctx.today ? 'Scheduled' : 'Active';
  let subscription: SubscriptionStep | null = null;
  let stopRenewal: StopRenewalStep | null = null;
  let invoicePeriod = { start, end };
  let invoiceUnitPrice = price;
  let invoiceDescription = `${product?.Name ?? plan} licenses, ${formatDate(start)} to ${formatDate(end)}`;

  if (opp.RecordType.DeveloperName === 'Add_on') {
    const target =
      live.find((s) => s.id === ctx.original?.Subscription_ID__c) ??
      (live.length === 1 ? live[0] : undefined);
    if (!target) {
      add(
        'R6',
        'revops',
        'decision',
        'This is an add-on, but no active subscription was found to add to.',
      );
    } else {
      if (target.plan !== plan) {
        add('R6', 'rep', 'decision', `Add-on is for ${plan}, but ${target.id} is ${target.plan}.`);
      }
      if (total !== target.seats + licenses) {
        add(
          'R6',
          'rep',
          'fix',
          `Total licenses should be ${target.seats} existing + ${licenses} added = ${target.seats + licenses}, but the deal says ${total}.`,
        );
      }
      if (end !== target.endDate) {
        add(
          'R6',
          'rep',
          'fix',
          `Add-ons are co-termed: End date should be ${formatDate(target.endDate)}, when ${target.id} ends.`,
        );
      }
      if (method === 'Card' || target.billingSystem !== billingSystem) {
        add(
          'R6',
          'revops',
          'decision',
          'Add-ons on card subscriptions are not set up automatically yet.',
        );
      }
      subscription = {
        action: 'update',
        subscriptionId: target.id,
        seats: total,
        endDate: target.endDate,
      };
      // R6: co-term and prorate by day
      const days = daysInclusive(start, target.endDate);
      const yearDays = daysInclusive(target.startDate, target.endDate);
      invoiceUnitPrice = round2((price * days) / yearDays);
      invoicePeriod = { start, end: target.endDate };
      invoiceDescription = `${product?.Name ?? plan} licenses added ${formatDate(start)} to ${formatDate(target.endDate)}: ${days} of ${yearDays} days at ${money(price)} per year`;
      const invoiced = round2(licenses * invoiceUnitPrice * (1 - discount / 100));
      const exact = round2((licenses * price * (1 - discount / 100) * days) / yearDays);
      notes.push(
        `Prorated by day (R6): ${licenses} licenses × ${days}/${yearDays} days. The invoice is ${money(invoiced)} (unit price rounded to ${money(invoiceUnitPrice)}; exact pro rata ${money(exact)}). The Salesforce Amount, ${money(opp.Amount ?? 0)}, is the full-year value.`,
      );
    }
  } else {
    subscription = {
      action: 'create',
      plan,
      seats: total,
      startDate: start,
      endDate: end,
      status,
      billingSystem,
    };
    for (const s of live) {
      const isRenewed =
        opp.RecordType.DeveloperName === 'Renewal' && ctx.original?.Subscription_ID__c === s.id;
      if (isRenewed && shiftDays(s.endDate, 1) !== start) {
        add(
          'Data',
          'rep',
          'fix',
          `A renewal should start the day after ${s.id} ends (${formatDate(shiftDays(s.endDate, 1))}), but this one starts ${formatDate(start)}.`,
        );
      } else if (s.endDate < start) {
        if (s.autoRenew) {
          stopRenewal = {
            subscriptionId: s.id,
            stripeSubscriptionId: s.billingSystem === 'Stripe' ? s.billingReference : null,
            endDate: s.endDate,
            description: `Stop ${s.id} (${s.seats} × ${s.plan}, ${s.billingSystem}) from renewing after ${formatDate(s.endDate)}, so ${account.Name} isn't billed twice (R7).`,
          };
          notes.push(
            `Replaces ${s.id} (${s.seats} × ${s.plan} by ${s.billingSystem === 'Stripe' ? 'card' : 'invoice'}), which would renew on ${formatDate(shiftDays(s.endDate, 1))}. Stopping it waits for approval.`,
          );
        } else {
          notes.push(
            `${s.id} (${s.seats} × ${s.plan}) ends ${formatDate(s.endDate)} and doesn't renew; the new subscription takes over.`,
          );
        }
      } else {
        add(
          'R7',
          'rep',
          'decision',
          `${account.Name} already has ${s.seats} × ${s.plan} (${s.id}, ${s.billingSystem}) running until ${formatDate(s.endDate)}. Should this deal replace it (end it and credit the rest, R7) or extend it (R6)?`,
        );
      }
    }
    if (opp.Multi_Year_deal__c && months && months > 12) {
      if (opp.Multi_Year_Payment_Terms__c === 'Paid upfront') {
        invoiceUnitPrice = price * years;
        notes.push(`Paid upfront: one invoice for all ${years} years.`);
      } else {
        invoicePeriod = { start, end: termEnd(start, 12) };
        invoiceDescription = `${product?.Name ?? plan} licenses, year 1 of ${years}: ${formatDate(start)} to ${formatDate(invoicePeriod.end)}`;
        notes.push(
          `Invoiced annually: this invoice covers year 1 (${money(yearly)}). The Salesforce Amount, ${money(opp.Amount ?? 0)}, is the whole contract. Year 2 is invoiced from ${formatDate(shiftDays(invoicePeriod.end, 1))}.`,
        );
      }
    }
  }

  // ── Card on file ───────────────────────────────────────────
  const stripeCustomer = ctx.stripeCustomers[0] ?? null;
  if (method === 'Card' && stripeCustomer) {
    const card = stripeCustomer.default_payment_method;
    const expired =
      !card ||
      ctx.today >= new Date(Date.UTC(card.exp_year, card.exp_month, 1)).toISOString().slice(0, 10);
    if (expired) {
      const pastDue = ctx.stripeSubscriptions.find((s) => s.status === 'past_due');
      add(
        'R1',
        'rep',
        'fix',
        `The card on file${card ? ` (${card.brand} •••• ${card.last4}, ${card.exp_month}/${card.exp_year})` : ''} has expired${
          pastDue ? ` and ${pastDue.id} is already past due` : ''
        }. Ask the customer for a new card before anything is charged, and let Tom Becker (credit control) know.`,
      );
    }
    if (stripeCustomer.currency && stripeCustomer.currency !== cur.toLowerCase()) {
      add(
        'Data',
        'rep',
        'fix',
        `The Stripe customer pays in ${stripeCustomer.currency.toUpperCase()}, the deal is in ${cur}.`,
      );
    }
  }

  // ── Workspace ──────────────────────────────────────────────
  let workspace: WorkspaceStep | null = null;
  const linked = ctx.linkedWorkspaces;
  const unlinked = ctx.unlinkedWorkspaces;
  if (linked.length === 1) {
    workspace = { action: 'use', workspaceId: linked[0].id, name: linked[0].name };
  } else if (linked.length > 1) {
    add(
      'Decision',
      'rep',
      'decision',
      `${linked.length} workspaces are linked to ${account.Name}. Which one is this deal for?`,
    );
  } else if (unlinked.length === 1) {
    workspace = { action: 'link', workspaceId: unlinked[0].id, name: unlinked[0].name };
  } else if (unlinked.length > 1) {
    add(
      'Decision',
      'rep',
      'decision',
      `${unlinked.length} self-service workspaces match ${domain}: ${unlinked
        .map((w) => `${w.name} (${w.id}, ${w.activeMembers} members)`)
        .join(
          ', ',
        )}. Which one gets ${product?.Name ?? plan}? The other team can be invited into it.`,
    );
  } else {
    workspace = {
      action: 'create',
      name: account.Name,
      domain,
      region: account.Region__c === 'North America' ? 'US' : 'EU',
    };
  }

  if (issues.length > 0 || !workspace || !subscription) return result(null);

  // ── The plan ───────────────────────────────────────────────
  let kleerStep: KleerStep | null = null;
  let stripeStep: StripeStep | null = null;
  if (billingSystem === 'Kleer') {
    const invoiceLines = [
      {
        articleNumber: plan,
        description: invoiceDescription,
        quantity: licenses,
        unitPrice: invoiceUnitPrice,
        discountPercent: discount,
      },
      ...oneOffLines.map((l) => ({
        articleNumber: l.ProductCode,
        description: productOf(l.ProductCode)?.Name ?? l.Name,
        quantity: l.Quantity,
        unitPrice: l.UnitPrice,
        discountPercent: l.Discount,
      })),
    ];
    kleerStep = {
      customer: ctx.kleerCustomer
        ? { action: 'use', customerNumber: ctx.kleerCustomer.customerNumber }
        : {
            action: 'create',
            input: {
              name: account.Legal_Entity_Name__c ?? account.Name,
              email: account.Invoice_Email__c ?? '',
              country: account.BillingCountry,
              currency: cur,
              vatNumber: account.VAT_Number__c,
              address: [
                account.BillingStreet,
                `${account.BillingPostalCode} ${account.BillingCity}`,
              ]
                .filter(Boolean)
                .join(', '),
            },
          },
      invoice: {
        currency: cur,
        lines: invoiceLines,
        servicePeriod: invoicePeriod,
        poNumber: opp.PO_Number__c,
        yourReference: ctx.billingContactName,
        ourReference: owner?.Name ?? null,
        foreignId: opp.Id,
        paymentTermsDays: PAYMENT_TERMS_DAYS,
      },
      expectedNet: round2(
        sum(
          invoiceLines.map((l) => round2(l.quantity * l.unitPrice * (1 - l.discountPercent / 100))),
        ),
      ),
    };
  } else {
    stripeStep = {
      customer: stripeCustomer
        ? { action: 'use', customerId: stripeCustomer.id }
        : {
            action: 'create',
            input: {
              name: account.Legal_Entity_Name__c ?? account.Name,
              email: account.Invoice_Email__c ?? '',
              currency: cur.toLowerCase(),
              metadata: { salesforce_account_id: account.Id },
            },
          },
      subscription: {
        plan,
        quantity: total,
        currency: cur.toLowerCase(),
        amount: firstYear,
        start_date: start,
        metadata: { salesforce_opportunity_id: opp.Id },
      },
    };
  }

  return result({
    billingSystem,
    workspace,
    subscription,
    kleer: kleerStep,
    stripe: stripeStep,
    stopRenewal,
  });
}

function sum(values: number[]) {
  return values.reduce((a, b) => a + b, 0);
}
