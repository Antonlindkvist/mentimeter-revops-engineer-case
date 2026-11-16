# Submission

## What I built, and for whom

A **Closed Won hand-off queue** (sidebar: *Closed Won hand-off*, `/handoff`) for **Kim (RevOps)
and the reps**. Clean deals go through on their own, and only problems need a person.

- Every Closed Won deal is checked against finance's rules R1–R8, plus the Deal Desk rule, **as
  it looks in Salesforce now**.
- **Clean deals are set up automatically.** The hand-off links the customer's existing
  self-service workspace (or creates one), creates the Kleer customer and a draft invoice (or
  the Stripe customer and card subscription), then the admin app subscription. On the start
  date it switches the workspace to the plan the customer bought. It writes the IDs and a
  status back to the opportunity, so reps see what happened in Salesforce.
- **Blocked deals create nothing.** They get the rule, a plain reason and the **one person** who
  can fix or decide it. Once it's fixed, the next run (or the next Salesforce event) sets the
  deal up.
- **Two steps wait for a human click**, one per batch, because they reach the customer or are
  hard to undo:
  - sending invoices (Maja)
  - stopping a replaced subscription from renewing (R7)
- **A daily Slack digest** sends each person one DM with only their deals. Finance gets one
  summary in `#finance-billing`.
- **Salesforce events** run the same pipeline through the webhook, so clean deals go through as
  soon as they're won.

On this week's 18 deals: **7 are set up** (6 invoice drafts and 1 card payment), **10 are
blocked**, each with a named owner, and **1 is skipped** (Polar Bear, reopened).

## Decisions

**Who it's for.** Kim said: "If someone still has to click 50 buttons for every deal, we've moved
the copying, not removed it" and "I don't want to be the person who relays every problem."
Priya doesn't want another form before closing. So reps close as they do today, and the
system catches problems after Closed Won and routes each one to the person who can fix it.

**Where people disagreed:**

- **Maja vs Kim (every invoice vs no clicking).** Invoices are drafted automatically, and Maja
  sends them all with one click after looking at them. Every invoice is seen before it reaches
  a customer, and nobody copies anything.
- **Tom vs Lea (bill first vs workspace on day one).** Both, in order. Nothing is created for a
  blocked deal, and billing is set up before the subscription. A failed card payment stops the
  deal before it gets a subscription (Tom). For clean deals the workspace is switched to the
  plan on the start date, by the first run on or after it (Lea). The admin app doesn't do this
  itself: a new workspace stays on Free until someone changes it. For blocked deals, Lea's
  kickoff dates are why problems go straight to the person who can fix them.
- **Alex ("one message a day").** A daily digest, not a ping per problem. It's only sent when
  something changed.
- **RM exemption from R3 (unsettled).** Not applied: a missing PO blocks the invoice. It doesn't
  matter this week, because the only existing customer with a PO requirement (Halden) has its
  PO. Kessler and Lumen are new customers.

**Guardrails:**

- **Idempotent (R5).** Every step is recorded in `db.app` only after the system confirmed it,
  and skipped next time. Steps that create something also check the system first (Kleer by
  `foreignId`, workspaces by account) or use Stripe idempotency keys. A second run, or every
  event delivered twice, makes **no write calls at all**. Tests check both.
- **Never reports work that didn't happen.** A failed step records the system's own error,
  stops that deal's remaining steps, and shows as *Failed* in the app and in Salesforce. The
  next run retries it.
- **Doesn't fix things behind people's backs.** If a deal changes in Salesforce after it was set
  up, or is reopened, it's flagged for RevOps and nothing is undone automatically.
- **Doesn't trust its own invoice math.** If Kleer's computed net amount differs from the deal,
  the draft is deleted and the step fails.

**How I read the ambiguous rules and data** (one place each: `src/lib/handoff/rules.ts` and
`config.ts`):

| Case | Decision |
| --- | --- |
| Event snapshots vs current deal | Always read the current opportunity. Halden was edited from 30 to 35 licenses after Closed Won, and #closed-won still says 30. Polar Bear was reopened. |
| R6 vs R8 (Halden add-on) | Update SUB-502 to 95 seats, co-termed to 28 Feb 2027, invoice prorated by day: 35 × 111/365 days. The unit price is rounded to the cent, so the invoice is **£3,134.48** against an exact pro rata of £3,134.61. The Salesforce Amount (£10,307.50) is the full-year value, and the card says so. |
| Multi-year (Torvik, invoiced annually) | The subscription covers both years. The invoice covers year 1 (120,000 SEK). The Amount (240,000) is the whole contract. |
| One-off products (Fjordline) | R8 only covers licenses. The onboarding package is its own invoice line, and the Amount check includes it. |
| Legacy card checkbox (Wavecrest) | `Payment_Method__c` wins. The checkbox comes from the old quote template. |
| Renewal (Okapi) | Not covered by R1–R8. Create a new subscription from 1 Dec. The old one ends on its own (no auto-renew). |
| R7 (Nordlys) | The old Stripe card subscription ends the day before the new invoice period starts. After approval: `cancel_at_period_end` in Stripe (no refund needed) and auto-renew off in the admin app. |
| R2 currency | No rates were given, so I used fixed planning rates in `config.ts`. No card deal this week is near the limit in another currency, so the rates change no outcome. |
| R4 VAT format | Kleer accepts any text, so a malformed VAT ID would get 0% VAT on an invalid number. I check the country prefix plus 8–12 characters (Arcadia's "FR 12 3456" fails). |
| Invoice email | From the account's `Invoice_Email__c`, not the billing contact. Contact emails in the data have spaces and accents. |
| Invoice references | "Your reference" is the billing contact. "Our reference" is Maja (billing), like every earlier invoice in Kleer, since PO and VAT questions go to Maja. |
| Self-service workspaces | Matched by the account's domain and linked instead of duplicated (Kessler, Corvid). Two matches (Helix) is a decision for the rep. |
| Decisions not mine to make | Maris (CHF account, EUR deal, no CHF price list), Quill & Ink (contract starts before it closed), Sable & Finch (replace or extend a live card subscription whose card has expired) and Helix (which workspace) are blocked with a named owner, not guessed. |

**What I chose not to build:**

- correcting already-sent invoices (credit notes)
- invoicing year 2 of multi-year deals
- add-ons on card subscriptions
- real exchange rates
- a login, so the approvals don't record who clicked
- notifying Tom about the expired card (the message tells the rep to)

## Before it goes live

- **Maja:** is one batch "send" click enough review, or should invoices be approved one by
  one? Is cent-rounding the prorated unit price acceptable? Changing either is a small
  change to the gated steps.
- **Finance, on Quill & Ink:** may we invoice a contract backdated to a trial start? And on
  Maris: CHF or EUR? Both could become rules instead of decisions.
- **RMs and finance:** settle the R3 exemption for long-standing customers. It would be one
  condition in the R3 check.
- **Tom and Lea:** should a new customer whose only blocker is a missing PO get the workspace on
  the start date? That would turn "blocked" into "provision, but hold the invoice".
- **Kim:** which fields reps should see (`Handoff_Status__c`, `Handoff_Issues__c`), and whether a
  daily digest is the right cadence for reps.
- **Deal Desk:** is a discount above 25% always a blocker, or only for new business?

## How to try it

`npm install` and `npm run dev` (Node 22 or later). No keys or accounts.

1. Open **Closed Won hand-off** in the sidebar. Seven deals are ready, ten are blocked, each with
   a rule and a named owner, and one is skipped.
2. Click **Run hand-off**. Six deals now wait for approval and Brightwell (card) is done. Look in
   *Admin app*, *Kleer*, *Stripe*, and at a deal under *Deals* (the `Handoff_*` fields and the
   IDs).
3. Click **Stop 1 old subscription renewing** (Nordlys, R7), then **Send 6 invoices**.
4. Click **Send Slack digest**, then open *Slack*: one DM per owner and a summary in
   `#finance-billing`. Click it again: nothing new is sent.
5. Click **Run hand-off** again: the line under the button says *nothing new*, and *Kleer* still
   has the same six invoices. (The request log on *Dev tools* keeps only the last 500 requests and
   this page reads a lot, so it isn't a reliable place to check. The tests count the writes.)
6. Alternatively, from a reset: *Dev tools* → **Send all 21 to webhook**. You get the same result
   from the events.

Reset any time with *Dev tools* → **Reset all systems** (or `npm run db:reset`). `npm test` runs
42 tests, including all 18 deals.

Dates: the mocks' "today" is your real date (never before 6 Nov 2026). Deals that start before
today are *Active* and their workspace switches to the plan on the first run; later starts are
*Scheduled* and switch on the start date.

## What I'd do next

- A correction flow when a set-up deal changes (credit the sent invoice in full, then a new one),
  instead of only flagging it.
- A scheduler for the daily digest, and for year-2 invoices of multi-year deals.
- Tell Tom about failed card payments and expired cards directly.
- Validation rules in Salesforce for the cheap checks (PO, VAT, invoice email, card limit), shown
  as warnings at close, without blocking the rep from closing.
- Who approved what, once there's a login.
- Turn the decisions in "Before it goes live" into rules once they're settled.

## Working with your AI tool

Your first prompt, pasted as you wrote it:

> Fork https://github.com/BashamL/mentimeter-revops-engineer-case to my GitHub account with the gh
> CLI, clone my fork, run npm install and start the app with npm run dev. Install gh if it’s
> missing. Explain the task to me in simple terms, and what they will assess.
> Go through this week’s 18 Closed Won deals against billing rules R1-R8 and give me a table: deal,
> what’s wrong or missing, which rule, and who must fix it.
> Suggest 2-3 options for what to build, each with who it’s for, what it leaves out and how long it
> would take. Recommend one, but let me decide. My starting idea: build for the RevOps manager (Kim)
> and the reps, where clean deals go through automatically and only problems need a human.
> Once I’ve decided, build it in small steps, commit after each step. spawn subagents with relevant
> roles to keep context clean and to delegate thr right task to the right role, for example; tester,
> designer, and other relvant roles.


**How I worked.** I used Claude Code. I told it the context and how I wanted to work: read
everything first, explain the task, go through all 18 deals against R1–R8, give me options, and
let me decide. I chose the direction (Kim and the reps, clean deals automatic, problems routed to
one person). I went through its recommendations for the ambiguous cases, accepted them, and had it
write them into a build prompt (in the same file). It built in seven small commits with tests and
ran `npm run check` before every push. I walked through the build in the app myself, then asked it
to double-check everything against the data before recording the demo.

Something your tool suggested or built that you changed or threw away, and why:

**It assumed an Enterprise subscription gives the customer Enterprise.** The first build created
the subscription in the admin app and stopped there. But a workspace's plan is a separate field:
new workspaces stayed on Free, and Nordlys stayed on Pro, even with an Active Enterprise
subscription. The tests passed, because they checked what the code meant to do. The double-check
found it by comparing the result with the admin app's data. I changed the design instead of
patching it: the hand-off now switches the workspace's plan on the start date (Lea's "day one"),
and only after billing is set up (Tom's "bill first").

Two smaller ones:

- It wrote into this file that the Dev tools request log shows that a second run writes nothing.
  That wasn't true: the log keeps only the last 500 requests, and the hand-off page reads about 150
  per view, so the writes scroll out. Recording the demo caught it. I replaced it with something a
  person can check: the run now says "nothing new", and Kleer still has six invoices. The tests
  count the write calls.
- Its first query found 17 Closed Won deals, not 18. It noticed that the 18th was reopened and only
  shows up in the event feed. That's why the hand-off reads the events and judges every deal as it
  is now.

Roughly where you spent your time:

About 4 hours:

- ~15 min: forking and setting up (Node had to be upgraded)
- ~15 min: reading the case with the agent's walkthrough of the 18 deals, and choosing what to
  build
- ~30 min: building it in seven small, tested commits
- ~25 min: walking through the build myself, and the fixes from the double-check
- ~2 h: the demo video: recording it, checking it frame by frame, and the two fixes it found
- ~30 min [EDIT]: the voice-over and this file

## Video

Link: https://drive.google.com/file/d/183ceJOshV-Z-8sHxCxoBSyKpMTrmKYtc/view?usp=sharing
