// Ateeb's calendars and defaults. Calendar IDs aren't secrets; override any with env vars.
export const TZ = "America/New_York";

export const CALENDARS = {
  personal: process.env.CAL_PERSONAL ?? "primary",
  classes: process.env.CAL_CLASSES ?? "1c07f7c420e74616eda17c7b319b433f1aaaef859cf87311cbf0cc4dedf8a53f@group.calendar.google.com",
  lab: process.env.CAL_LAB ?? "cdaca0327e4c815066f76cb744b8956023bf9ee290eb17abc9791d0aefe9f402@group.calendar.google.com",
  exams: process.env.CAL_EXAMS ?? "27b3e93b6eed5a6264f9a19e4422d10b55c1d1b532b6e013a787f30067628b5f@group.calendar.google.com",
  assignments: process.env.CAL_ASSIGNMENTS ?? "e583fb876ad4adad7e18893f1a4dca664987ea01b2064aee39bcbda4064c6ee6@group.calendar.google.com",
  haircuts: process.env.CAL_HAIRCUTS ?? "1084bd8f706e3c4173733966524d7448da21e6e470cc6e32db60e505d4c25cc2@group.calendar.google.com",
  study: process.env.CAL_STUDY ?? "6e79177a1176c2fcf3c8aedbd599d93d1429979d3a4c2af388f7ac2930729490@group.calendar.google.com",
  gym: process.env.CAL_GYM ?? "447cb0700039fc26a72377b67e96b319521a9c08a4456ab72400e2a2b33b54cb@group.calendar.google.com",
  pray: process.env.CAL_PRAY ?? "96c7cd6a81520675e76d48ea932175567fd4ef3a7f3057acafee818ce68421ca@group.calendar.google.com",
  prayerTimes: process.env.CAL_PRAYER_TIMES ?? "l7l75b01n249omuj7t1otubdl3fbf61v@import.calendar.google.com",
  clubs: process.env.CAL_CLUBS ?? "f98770c6d61714c90e67b7bfb6d99d11b43243300c675d36ebaa7828b487bd77@group.calendar.google.com",
  volunteer: process.env.CAL_VOLUNTEER ?? "ded45071b59e7265573c77fd848b0dec079accc397a7b66d6b29585af1752c44@group.calendar.google.com",
} as const;

export type CalendarKey = keyof typeof CALENDARS;

// Every calendar whose events count as "busy" when planning.
export const BUSY_CALENDARS: CalendarKey[] = [
  "personal", "classes", "lab", "exams", "haircuts", "pray", "prayerTimes", "clubs", "volunteer",
];

// Events that are reminders, not real commitments.
export const IGNORE_EVENT_TITLES = ["wake up", "in bed"];

// Marker the planner puts in event descriptions so it only ever deletes its own events.
export const PLANNER_TAG = "[life-os planner]";

// Spaced retrieval schedule (days after the lecture).
export const REVIEW_STAGES = [0, 1, 3, 7, 21];

export const COURSE_CODES = ["BIOLOGY 225", "PHYSICS 150", "PSYCH 230", "ANTHRCUL 101"];

export function courseFromTitle(title: string): string {
  const t = title.toUpperCase();
  const hit = COURSE_CODES.find((c) => t.includes(c) || t.includes(c.split(" ")[0] + " " + c.split(" ")[1]));
  if (hit) return hit;
  if (/\bBIO(LOGY)?\s*225\b/.test(t)) return "BIOLOGY 225";
  if (/\bPHYS(ICS)?\s*150\b/.test(t)) return "PHYSICS 150";
  if (/\bPSYCH\s*230\b/.test(t)) return "PSYCH 230";
  if (/\bANTHR(O|CUL)?\s*101\b/.test(t)) return "ANTHRCUL 101";
  return "Other";
}
