const DAY = 86_400_000;

const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (time: number) => new Date(time).toISOString().slice(0, 10);

const addDays = (date: string, days: number) => toTime(date) + days * DAY;

export function shiftDays(date: string, days: number): string {
  return toDate(addDays(date, days));
}

/** Days from start to end, both included. */
export function daysInclusive(start: string, end: string): number {
  return Math.round((toTime(end) - toTime(start)) / DAY) + 1;
}

/** The last day of a term of `months` that starts on `start`. */
export function termEnd(start: string, months: number): string {
  const date = new Date(toTime(start));
  date.setUTCMonth(date.getUTCMonth() + months);
  return shiftDays(toDate(date.getTime()), -1);
}
