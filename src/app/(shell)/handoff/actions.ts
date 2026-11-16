'use server';

import { revalidatePath } from 'next/cache';
import { runHandoff, sendInvoices, stopRenewals } from '@/lib/handoff/run';

export async function runAction() {
  await runHandoff();
  revalidatePath('/', 'layout');
}

export async function sendInvoicesAction() {
  await sendInvoices();
  revalidatePath('/', 'layout');
}

export async function stopRenewalsAction() {
  await stopRenewals();
  revalidatePath('/', 'layout');
}
