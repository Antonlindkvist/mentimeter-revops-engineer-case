/**
 * Salesforce calls this URL for every Closed Won event. Each event runs the
 * same hand-off as the "Run hand-off" button, for that one opportunity.
 *
 * The event's snapshot is only used to know which deal changed: the hand-off
 * always reads the opportunity as it is now. That handles an edit after
 * Closed Won (Halden: 30 -> 35 licenses), a reopened deal (Polar Bear) and
 * the same event arriving twice, which changes nothing the second time.
 */
import { runHandoff } from '@/lib/handoff/run';
import type { SalesforceEvent } from '@/lib/systems/types';

export async function POST(request: Request) {
  const event = (await request.json()) as SalesforceEvent;
  if (!event?.opportunityId) {
    return Response.json({ error: 'opportunityId is missing' }, { status: 400 });
  }
  const summary = await runHandoff(event.opportunityId);
  console.log(
    `[webhook] ${event.type} for ${event.opportunity?.Name ?? event.opportunityId} (replayId ${event.replayId}): ${
      summary.setUp.length ? 'set up' : summary.failed.length ? 'failed' : 'nothing to do'
    }`,
  );
  return Response.json(
    {
      received: true,
      replayId: event.replayId,
      setUp: summary.setUp,
      failed: summary.failed,
    },
    { status: 202 },
  );
}
