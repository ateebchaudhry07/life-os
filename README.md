# Life OS

Ateeb's all-in-one app: school, AteebCuts, money, gym, and a week planned around your priorities. One website, one database. It reads Gmail and Google Calendar, Canvas and Asana, and it runs on its own every night.

## What it does on its own

| When | What |
|---|---|
| ~9:15 PM every night | **Lecture review.** Adds today's lectures from your Classes calendar, writes 3–5 recall questions (from Canvas slides when it can reach them), and schedules spaced reviews at 1, 3, 7 and 21 days. Pushes tonight's list to your phone. |
| ~10:50 PM every night | **AteebCuts & money sync.** New Booksy bookings and Haircuts-calendar clients become appointments. Venmo "paid you" and Zelle emails are matched to the right client and mark the cut done with the real amount. Robinhood, card payments, Venmo/Zelle you sent and Venmo cash-outs are recorded. Canvas, Asana and exams refresh. Pushes a summary to your phone. |
| Sunday afternoon | **Week plan.** Reads every calendar plus assignments and exams, finds your free time, and places study, assignment, lecture-review and gym blocks on your Study and Gym calendars, following the priorities you wrote. It only ever deletes events it created. |

**Why the study method looks like this:** same-day review flattens the forgetting curve (Ebbinghaus; Murre & Dros 2015). Closed-notes recall beats rereading (Roediger & Karpicke 2006; Karpicke & Blunt 2011). Expanding spaced reviews work best (Cepeda et al. 2006, 2008). Dunlosky et al. (2013) rate practice testing and distributed practice the two highest-utility techniques. Interleaving helps problem-solving (Rohrer & Taylor 2007), and sleep after studying consolidates memory (Diekelmann & Born 2010).

## Pages

- **Today:** greeting, what matters most, the next 48 hours, everything that needs you, unread email, hours per area (School, AteebCuts, Faith, Wolverine Shifa, PhiDE, Gym, Personal).
- **School:** tonight's reviews with recall prompts and a confidence rating, assignments (check them off), exams with countdowns, recent lectures, Canvas grades.
- **AteebCuts:** past cuts to confirm (cash or no-show), revenue by week, upcoming bookings, top clients, payments that didn't match a booking.
- **Money:** in, out, net and invested for 7/30/90 days, spending by category against budgets, weekly in vs. out, CSV import for 360 Checking and Flagstar, every transaction with editable categories.
- **Gym:** log a workout, workout days per week, strength progress as estimated one-rep max, bodyweight.
- **Week plan:** the planned blocks with the reason for each, plus the priorities the planner follows (edit them in plain English).
- **Settings:** connection status, run any automation now, areas and weekly hour goals, categories.

## Set it up (about 30 minutes, once)

All of these services have free tiers. You need accounts on GitHub (you have one), [Vercel](https://vercel.com), [Neon](https://neon.tech), [Google Cloud](https://console.cloud.google.com) and the [Anthropic Console](https://console.anthropic.com).

1. **Database:** on Neon, create a project and copy the pooled and direct connection strings.
2. **Google sign-in:** Google Cloud Console → new project →
   - APIs & Services → enable the **Gmail API** and the **Google Calendar API**.
   - OAuth consent screen → External → add yourself as a test user → add scopes `gmail.readonly` and `calendar`.
   - Credentials → OAuth client ID → Web application → redirect URI `https://YOUR-APP.vercel.app/api/auth/callback/google` → copy the ID and secret.
   - Then press **Publish app** (it stays unverified and only you can use it). Apps left in "Testing" lose the Google connection every 7 days.
3. **Claude:** Anthropic Console → API keys → create a key. Expect roughly a few dollars a month. Set `CLAUDE_MODEL=claude-haiku-5-5` to cut that further.
4. **Deploy:** Vercel → Add New Project → import this repo → paste every variable from `.env.example` → Deploy.
5. **Tables:** nothing to do. Every deploy creates or updates the database tables and the default areas and categories.
6. **Sign in** at your Vercel URL with your Google account.
7. **Phone notifications:** install **ntfy** (iOS/Android), subscribe to a private topic name like `ateeb-life-7f3k`, and enter the same name in Settings.
8. **Canvas:** in Canvas, go to Calendar → **Calendar Feed** and copy the link into Settings. If your Canvas allows access tokens, also set `CANVAS_TOKEN`; that adds grades and lets the review read your slides.
9. **History:** Settings → **Sync last 30 days**. To bring over your Notion history (clients, cuts, transactions, workouts), see `scripts/import-notion.ts` and run `npm run import:notion`.
10. **Bank purchases:** card purchases only show up from bank files. Once a month, download CSVs from Capital One 360 and Flagstar and drop them on the Money page. Turning on purchase alert emails in both banks' apps lets the nightly sync catch more on its own.

Vercel's free plan runs scheduled jobs once a day, at a time within the hour shown in `vercel.json` (UTC). The times listed above are Eastern.
