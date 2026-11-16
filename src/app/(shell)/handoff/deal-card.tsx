import { AlertTriangle, Check, Circle, Hand, Info, X } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { formatDate, formatMoney } from '@/lib/format';
import type { DealView, StepView } from '@/lib/handoff/board';
import type { Issue } from '@/lib/handoff/types';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<Issue['kind'], string> = {
  fix: 'Fix',
  decision: 'Decide',
  approval: 'Approval',
};

export function DealCard({ deal }: { deal: DealView }) {
  const e = deal.evaluation;
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/deals/${e.oppId}`} className="font-medium hover:underline">
            {e.name}
          </Link>
          <div className="text-muted-foreground text-xs">
            {e.ownerName} · {e.type.replace('_', '-')} · closed {formatDate(deal.closeDate)}
          </div>
        </div>
        <div className="shrink-0 font-medium tabular-nums">{formatMoney(e.amount, e.currency)}</div>
      </div>

      {e.issues.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {e.issues.map((issue) => (
            <li
              key={issue.message}
              className="flex gap-2 rounded-lg bg-amber-500/5 p-2 ring-1 ring-amber-500/20"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{issue.rule}</Badge>
                  <span className="text-muted-foreground text-xs">
                    {KIND_LABEL[issue.kind]}:{' '}
                    <span className="text-foreground">{issue.ownerName}</span>
                  </span>
                </div>
                <p>{issue.message}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {deal.steps.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {deal.steps.map((step) => (
            <StepRow key={step.name} step={step} />
          ))}
        </ol>
      ) : null}

      {e.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-muted-foreground text-xs">
          {e.notes.map((note) => (
            <li key={note} className="flex gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: StepView }) {
  const status = step.record?.status;
  const Icon = status === 'done' ? Check : status === 'failed' ? X : step.gated ? Hand : Circle;
  return (
    <li className="flex flex-col">
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 size-4 shrink-0',
            status === 'done' && 'text-emerald-600',
            status === 'failed' && 'text-red-600',
            !status && step.gated && 'text-amber-600',
            !status && !step.gated && 'text-muted-foreground',
          )}
        />
        <span className={cn(status === 'done' && 'text-muted-foreground')}>
          {step.label}
          {step.record?.ref ? (
            <span className="ml-1.5 font-mono text-xs text-foreground">{step.record.ref}</span>
          ) : null}
          {!status && step.gated ? (
            <span className="ml-1.5 text-amber-700 text-xs dark:text-amber-400">
              needs approval
            </span>
          ) : null}
        </span>
      </div>
      {step.record?.error ? (
        <p className="ml-6 text-red-700 text-xs dark:text-red-400">{step.record.error}</p>
      ) : null}
    </li>
  );
}
