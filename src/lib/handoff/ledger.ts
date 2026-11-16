/**
 * The hand-off's memory, kept in db.app. Every step it takes for a deal is
 * recorded here once the system confirmed it, so running again (or receiving
 * the same Salesforce event twice) skips what's already done.
 */
import { readDb, updateDb } from '@/lib/db';

export type StepName =
  | 'workspace'
  | 'kleerCustomer'
  | 'kleerInvoice'
  | 'stripeCustomer'
  | 'stripeSubscription'
  | 'subscription'
  | 'accountLinks'
  | 'sendInvoice'
  | 'stopRenewal';

export interface StepRecord {
  status: 'done' | 'failed';
  at: string;
  /** The ID the system gave back, e.g. "SUB-601" or "2026-0312" */
  ref?: string;
  error?: string;
}

export interface DealRecord {
  steps: Partial<Record<StepName, StepRecord>>;
  /** What we last wrote to Salesforce, so we only write when it changes */
  writtenBack?: string;
}

export interface HandoffState {
  deals: Record<string, DealRecord>;
  /** Last Slack message per recipient, so a re-run doesn't repeat it */
  slack: Record<string, string>;
  lastRunAt: string | null;
}

const empty = (): HandoffState => ({ deals: {}, slack: {}, lastRunAt: null });

export function readState(): HandoffState {
  return { ...empty(), ...((readDb().app.handoff as HandoffState | undefined) ?? {}) };
}

function change(edit: (state: HandoffState) => void) {
  updateDb((db) => {
    const state = { ...empty(), ...((db.app.handoff as HandoffState | undefined) ?? {}) };
    edit(state);
    db.app.handoff = state;
  });
}

export function doneRef(oppId: string, step: StepName): string | undefined {
  const record = readState().deals[oppId]?.steps[step];
  return record?.status === 'done' ? (record.ref ?? '') : undefined;
}

export function recordStep(oppId: string, step: StepName, record: Omit<StepRecord, 'at'>) {
  change((state) => {
    state.deals[oppId] ??= { steps: {} };
    state.deals[oppId].steps[step] = { ...record, at: new Date().toISOString() };
  });
}

export function recordWriteBack(oppId: string, fingerprint: string) {
  change((state) => {
    state.deals[oppId] ??= { steps: {} };
    state.deals[oppId].writtenBack = fingerprint;
  });
}

export function recordSlack(recipient: string, text: string) {
  change((state) => {
    state.slack[recipient] = text;
  });
}

export function recordRun() {
  change((state) => {
    state.lastRunAt = new Date().toISOString();
  });
}

export function hasStarted(oppId: string): boolean {
  const steps = readState().deals[oppId]?.steps ?? {};
  return Object.values(steps).some((s) => s?.status === 'done');
}
