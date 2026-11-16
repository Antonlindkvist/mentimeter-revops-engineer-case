import type { CreateKleerCustomerInput, CreateKleerInvoiceInput } from '@/lib/connectors/kleer';
import type { OpportunityWithLines } from '@/lib/connectors/salesforce';
import type {
  BillingSystem,
  KleerCustomer,
  PricebookEntry,
  Product,
  SalesforceAccount,
  SalesforceOpportunity,
  SalesforceUser,
  StripeCustomer,
  StripeSubscription,
  Subscription,
  SubscriptionStatus,
  Workspace,
} from '@/lib/systems/types';

/** Everything the rules need to judge one deal, read from the systems. */
export interface DealContext {
  opp: OpportunityWithLines;
  account: SalesforceAccount;
  users: SalesforceUser[];
  products: Product[];
  pricebook: PricebookEntry[];
  /** Workspaces linked to the account */
  linkedWorkspaces: Workspace[];
  /** Self-service workspaces on the account's domain that nobody linked */
  unlinkedWorkspaces: Workspace[];
  /** The account's subscriptions in the admin app */
  subscriptions: Subscription[];
  /** The deal this one renews or adds to */
  original: SalesforceOpportunity | null;
  /** Stripe customers and subscriptions for the account's workspaces */
  stripeCustomers: StripeCustomer[];
  stripeSubscriptions: StripeSubscription[];
  /** Name of the deal's billing contact, for "your reference" on the invoice */
  billingContactName: string | null;
  /** The account's customer in Kleer, if it has one */
  kleerCustomer: KleerCustomer | null;
  /** The hand-off already did something for this deal */
  alreadyStarted: boolean;
  /** "Today" as the systems see it */
  today: string;
}

/** Who can fix an issue. `rep` is the deal owner. */
export type OwnerRole = 'rep' | 'finance' | 'revops';

export interface Issue {
  /** The rule behind it: R1-R8, or Policy / Data / Decision */
  rule: string;
  message: string;
  role: OwnerRole;
  ownerName: string;
  ownerEmail: string | null;
  /** fix: wrong or missing data. decision: someone has to choose. approval: waiting for a sign-off. */
  kind: 'fix' | 'decision' | 'approval';
}

export type WorkspaceStep =
  | { action: 'use'; workspaceId: string; name: string }
  | { action: 'link'; workspaceId: string; name: string }
  | { action: 'create'; name: string; domain: string | null; region: 'EU' | 'US' };

export type SubscriptionStep =
  | {
      action: 'create';
      plan: string;
      seats: number;
      startDate: string;
      endDate: string;
      status: SubscriptionStatus;
      billingSystem: BillingSystem;
    }
  | { action: 'update'; subscriptionId: string; seats: number; endDate: string };

export interface KleerStep {
  customer:
    | { action: 'use'; customerNumber: string }
    | { action: 'create'; input: CreateKleerCustomerInput };
  invoice: Omit<CreateKleerInvoiceInput, 'customerNumber'>;
  /** Net amount we expect Kleer to work out, for the page and the checks */
  expectedNet: number;
}

export interface StripeStep {
  customer:
    | { action: 'use'; customerId: string }
    | {
        action: 'create';
        input: { name: string; email: string; currency: string; metadata: Record<string, string> };
      };
  subscription: {
    plan: string;
    quantity: number;
    currency: string;
    amount: number;
    start_date: string;
    metadata: Record<string, string>;
  };
}

/** Ending a subscription the new deal replaces (R7). Waits for approval. */
export interface StopRenewalStep {
  subscriptionId: string;
  stripeSubscriptionId: string | null;
  endDate: string;
  description: string;
}

export interface Plan {
  billingSystem: BillingSystem;
  workspace: WorkspaceStep;
  subscription: SubscriptionStep;
  kleer: KleerStep | null;
  stripe: StripeStep | null;
  stopRenewal: StopRenewalStep | null;
  /** The admin app workspace plan this deal gives the customer, e.g. "Enterprise" */
  workspacePlan: string | null;
}

export type EvaluationStatus = 'ready' | 'blocked' | 'skipped';

export interface Evaluation {
  oppId: string;
  name: string;
  accountId: string;
  accountName: string;
  ownerName: string;
  type: string;
  amount: number | null;
  currency: string;
  status: EvaluationStatus;
  /** Why it's blocked. Empty when ready. */
  issues: Issue[];
  /** Things worth knowing that don't block the deal */
  notes: string[];
  plan: Plan | null;
}
