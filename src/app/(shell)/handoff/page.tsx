import type { Metadata } from 'next';
import { EmptyState, Page, PageHeader, Section } from '@/components/shell/page';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { type DealView, type Group, loadBoard } from '@/lib/handoff/board';
import { readState } from '@/lib/handoff/ledger';
import { runAction, sendDigestAction, sendInvoicesAction, stopRenewalsAction } from './actions';
import { DealCard } from './deal-card';

export const metadata: Metadata = { title: 'Closed Won hand-off' };

const GROUPS: { id: Group; title: string; hint: string }[] = [
  {
    id: 'ready',
    title: 'Ready to set up',
    hint: 'Passed every rule. The hand-off creates the workspace, subscription and billing.',
  },
  {
    id: 'approval',
    title: 'Waiting for approval',
    hint: 'Set up and drafted. Sending invoices and ending old subscriptions wait for one click.',
  },
  {
    id: 'failed',
    title: 'Failed',
    hint: 'A system said no. The remaining steps for the deal stopped; nothing is reported as done.',
  },
  {
    id: 'blocked',
    title: 'Blocked',
    hint: 'Nothing is created until the named person fixes or decides it. It goes through on the next run.',
  },
  { id: 'done', title: 'Done', hint: 'Set up, billed and written back to Salesforce.' },
  { id: 'skipped', title: 'Skipped', hint: 'No longer Closed Won.' },
];

export default async function HandoffPage() {
  const board = await loadBoard();
  const byGroup = (group: Group) => board.filter((d) => d.group === group);
  const { lastRunAt, lastRunResult } = readState();
  const waiting = (name: string) =>
    byGroup('approval').filter((d) =>
      d.steps.some((s) => s.name === name && s.record?.status !== 'done'),
    ).length;
  const toRun = byGroup('ready').length + byGroup('failed').length;
  const invoices = waiting('sendInvoice');
  const renewals = waiting('stopRenewal');

  return (
    <Page>
      <PageHeader
        title="Closed Won hand-off"
        description="Every deal Salesforce marked Closed Won, checked against finance's rules (R1–R8). Clean deals are set up automatically; the rest wait for the one person who can fix them."
        actions={
          <div className="flex flex-col items-end gap-1">
            <div className="flex gap-2">
              <form action={sendDigestAction}>
                <Button type="submit" variant="outline">
                  Send Slack digest
                </Button>
              </form>
              <form action={runAction}>
                <Button type="submit">Run hand-off{toRun > 0 ? ` (${toRun} ready)` : ''}</Button>
              </form>
            </div>
            <span className="text-muted-foreground text-xs">
              {lastRunAt
                ? `Last run ${formatDateTime(lastRunAt)}: ${lastRunResult ?? 'done'}`
                : 'Not run yet'}{' '}
              · safe to run again
            </span>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {GROUPS.map((g) => (
          <a
            key={g.id}
            href={`#${g.id}`}
            className="rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50"
          >
            <div className="text-muted-foreground text-xs">{g.title}</div>
            <div className="font-semibold text-2xl tabular-nums">{byGroup(g.id).length}</div>
          </a>
        ))}
      </div>

      {GROUPS.map((g) => {
        const deals = byGroup(g.id);
        if (deals.length === 0 && (g.id === 'failed' || g.id === 'skipped')) return null;
        return (
          <Section
            key={g.id}
            title={<span id={g.id}>{g.title}</span>}
            count={deals.length}
            actions={
              g.id === 'approval' && deals.length > 0 ? (
                <div className="flex gap-2">
                  {renewals > 0 ? (
                    <form action={stopRenewalsAction}>
                      <Button type="submit" variant="outline" size="sm">
                        Stop {renewals} old {renewals === 1 ? 'subscription' : 'subscriptions'}{' '}
                        renewing
                      </Button>
                    </form>
                  ) : null}
                  {invoices > 0 ? (
                    <form action={sendInvoicesAction}>
                      <Button type="submit" size="sm">
                        Send {invoices} {invoices === 1 ? 'invoice' : 'invoices'}
                      </Button>
                    </form>
                  ) : null}
                </div>
              ) : null
            }
          >
            <p className="-mt-2 text-muted-foreground text-sm">{g.hint}</p>
            {deals.length === 0 ? (
              <EmptyState>Nothing here.</EmptyState>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {deals.map((d: DealView) => (
                  <DealCard key={d.evaluation.oppId} deal={d} />
                ))}
              </div>
            )}
          </Section>
        );
      })}
    </Page>
  );
}
