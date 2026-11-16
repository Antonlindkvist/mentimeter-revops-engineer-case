/**
 * The daily Slack digest: one direct message per person with only the deals
 * waiting for them, and one summary for finance. In production a scheduler
 * would call this once a day; here the hand-off page has a button for it.
 *
 * A message is only sent when its content changed since the last one, so
 * running it again doesn't ping anyone twice.
 */
import { salesforce, slack } from '@/lib/connectors';
import { type DealView, loadBoard } from './board';
import { readState, recordSlack } from './ledger';

const APP_URL = 'http://localhost:3000/handoff';

export interface DigestSummary {
  sent: string[];
  unchanged: string[];
  failed: { to: string; error: string }[];
}

interface Inbox {
  name: string;
  email: string;
  lines: string[];
}

export function buildInboxes(board: DealView[], revops: { name: string; email: string }) {
  const inboxes = new Map<string, Inbox>();
  const add = (email: string, name: string, line: string) => {
    const inbox = inboxes.get(email) ?? { name, email, lines: [] };
    inbox.lines.push(line);
    inboxes.set(email, inbox);
  };
  for (const deal of board) {
    const e = deal.evaluation;
    if (deal.group === 'blocked') {
      const byOwner = new Map<string, { name: string; messages: string[] }>();
      for (const issue of e.issues) {
        if (!issue.ownerEmail) continue;
        const entry = byOwner.get(issue.ownerEmail) ?? { name: issue.ownerName, messages: [] };
        entry.messages.push(`${issue.rule}: ${issue.message}`);
        byOwner.set(issue.ownerEmail, entry);
      }
      for (const [email, { name, messages }] of byOwner) {
        add(email, name, `• ${e.name}\n    ${messages.join('\n    ')}`);
      }
    }
    if (deal.group === 'failed') {
      const step = deal.steps.find((s) => s.record?.status === 'failed');
      add(
        revops.email,
        revops.name,
        `• ${e.name} failed at "${step?.label}": ${step?.record?.error}`,
      );
    }
  }
  return [...inboxes.values()];
}

function directMessage(inbox: Inbox): string {
  const first = inbox.name.split(' ')[0];
  const n = inbox.lines.length;
  return [
    `Hi ${first}, ${n === 1 ? 'one Closed Won deal is' : `${n} Closed Won deals are`} waiting for you. Nothing is set up for ${n === 1 ? 'it' : 'them'} until it's sorted, and it goes through automatically on the next run after that.`,
    '',
    ...inbox.lines,
    '',
    `Open the Closed Won hand-off: ${APP_URL}`,
  ].join('\n');
}

async function financeSummary(board: DealView[], mention: (email: string) => Promise<string>) {
  const users = await salesforce.listUsers();
  const maja = users.find((u) => u.Title === 'Billing Specialist');
  const pending = (step: string) =>
    board.filter(
      (d) =>
        d.group === 'approval' &&
        d.steps.some((s) => s.name === step && s.record?.status !== 'done'),
    );
  const invoices = pending('sendInvoice');
  const renewals = pending('stopRenewal');
  const blocked = board.filter((d) => d.group === 'blocked');
  const done = board.filter((d) => d.group === 'done');
  const failed = board.filter((d) => d.group === 'failed');

  const owners = new Map<string, number>();
  for (const d of blocked) {
    for (const email of new Set(d.evaluation.issues.map((i) => i.ownerEmail))) {
      if (email) owners.set(email, (owners.get(email) ?? 0) + 1);
    }
  }
  const who = (
    await Promise.all([...owners].map(async ([email, n]) => `${await mention(email)} ${n}`))
  ).join(', ');

  const lines = ['Closed Won hand-off: daily summary'];
  if (invoices.length > 0) {
    lines.push(
      `• ${invoices.length} invoice${invoices.length === 1 ? '' : 's'} drafted and waiting for ${
        maja ? await mention(maja.Email) : 'billing'
      } to send: ${invoices.map((d) => d.evaluation.accountName).join(', ')}`,
    );
  }
  if (renewals.length > 0) {
    lines.push(
      `• ${renewals.length} old subscription${renewals.length === 1 ? '' : 's'} to stop renewing so nobody is billed twice (R7): ${renewals
        .map((d) => d.evaluation.accountName)
        .join(', ')}`,
    );
  }
  if (failed.length > 0) {
    lines.push(
      `• ${failed.length} failed and need RevOps: ${failed.map((d) => d.evaluation.accountName).join(', ')}`,
    );
  }
  lines.push(`• ${done.length} fully set up`);
  if (blocked.length > 0) lines.push(`• ${blocked.length} blocked, waiting for ${who}`);
  lines.push(`Open the Closed Won hand-off: ${APP_URL}`);
  return lines.join('\n');
}

export async function sendDigest(): Promise<DigestSummary> {
  const [board, users] = await Promise.all([loadBoard(), salesforce.listUsers()]);
  const revopsUser = users.find((u) => u.Title === 'RevOps Manager');
  const revops = { name: revopsUser?.Name ?? 'RevOps', email: revopsUser?.Email ?? '' };
  const state = readState();
  const summary: DigestSummary = { sent: [], unchanged: [], failed: [] };

  const ids = new Map<string, string>();
  const slackId = async (email: string) => {
    if (!ids.has(email)) ids.set(email, (await slack.lookupUserByEmail(email)).id);
    return ids.get(email) as string;
  };
  const mention = async (email: string) => `<@${await slackId(email)}>`;

  const deliver = async (to: string, label: string, text: string) => {
    if (state.slack[to] === text) {
      summary.unchanged.push(label);
      return;
    }
    try {
      await slack.postMessage({ channel: to, text });
      recordSlack(to, text);
      summary.sent.push(label);
    } catch (error) {
      summary.failed.push({
        to: label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const reached = new Set<string>();
  for (const inbox of buildInboxes(board, revops)) {
    try {
      const to = await slackId(inbox.email);
      reached.add(to);
      await deliver(to, inbox.name, directMessage(inbox));
    } catch (error) {
      summary.failed.push({
        to: inbox.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await deliver('#finance-billing', '#finance-billing', await financeSummary(board, mention));
  // Someone whose list is now empty gets no message, but if a problem comes
  // back later it must reach them again
  for (const to of Object.keys(state.slack)) {
    if (to.startsWith('U') && !reached.has(to) && state.slack[to] !== '') recordSlack(to, '');
  }
  return summary;
}
