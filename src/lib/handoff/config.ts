/**
 * The numbers the hand-off rules depend on, in one place so finance can see
 * and change them.
 */

/** R2: card payments are allowed up to this first-year amount, in EUR. */
export const CARD_LIMIT_EUR = 10_000;

/** Discounts above this percentage need Deal Desk approval before booking. */
export const DISCOUNT_APPROVAL_ABOVE = 25;

/**
 * R2 says "or the same amount in another currency" but no rates are given.
 * These are fixed planning rates (1 unit = x EUR). This week no card deal is
 * near the limit in another currency, so the exact rates don't change any
 * outcome. In production these would come from finance's monthly rates.
 */
export const EUR_RATES: Record<string, number> = {
  EUR: 1,
  SEK: 0.087,
  NOK: 0.085,
  DKK: 0.134,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.05,
};

/** Invoices: payment terms are 30 days on every invoice. */
export const PAYMENT_TERMS_DAYS = 30;

/** The mocks never go earlier than this date. */
export const CASE_TODAY = '2026-11-06';

/** EU countries and the prefix their VAT numbers start with. */
export const EU_VAT_PREFIX: Record<string, string> = {
  Austria: 'AT',
  Belgium: 'BE',
  Bulgaria: 'BG',
  Croatia: 'HR',
  Cyprus: 'CY',
  Czechia: 'CZ',
  Denmark: 'DK',
  Estonia: 'EE',
  Finland: 'FI',
  France: 'FR',
  Germany: 'DE',
  Greece: 'EL',
  Hungary: 'HU',
  Ireland: 'IE',
  Italy: 'IT',
  Latvia: 'LV',
  Lithuania: 'LT',
  Luxembourg: 'LU',
  Malta: 'MT',
  Netherlands: 'NL',
  Poland: 'PL',
  Portugal: 'PT',
  Romania: 'RO',
  Slovakia: 'SK',
  Slovenia: 'SI',
  Spain: 'ES',
  Sweden: 'SE',
};
