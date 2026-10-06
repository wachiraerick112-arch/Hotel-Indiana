# Hotel Indiana — Point of Sale

A self-contained point-of-sale app for Hotel Indiana: a frontend (what staff
tap on) and a backend (stores items and sales), bundled together so you can
host it yourself on any server you choose. No Claude or Anthropic branding
anywhere in it, and no dependency on claude.ai once it's running.

## What's inside

```
hotel-pos/
  server.js         <- backend (Node + Express)
  package.json      <- dependency list
  data/db.json       <- where items, sales and the admin PIN are stored
  public/index.html  <- the frontend (served by the backend)
  README.md          <- this file
```

Data is stored in a plain JSON file (`data/db.json`) rather than a database
server — this keeps setup to a single command and is plenty for a small
hotel's sales volume. If you outgrow it later, swap the `readDB`/`writeDB`
functions in `server.js` for a real database (Postgres, MySQL, etc.) without
touching the frontend.

## Running it locally

You'll need [Node.js](https://nodejs.org) installed (version 18 or newer).

```bash
cd hotel-pos
npm install
npm start
```

Then open **http://localhost:3000** in a browser. That's the whole app —
frontend and backend together, on one address.

Admin access is via **named logins**, with two kinds of account:

- **Owner** — exactly one of these. Created automatically on first run
  (name `Admin`, password `1234` — change this immediately). Only the
  Owner can add or remove admin accounts, and only the Owner's password
  can authorize **deleting anything** (an item, a sale, an expense, a
  held sale). The Owner can also force every device to log out at once.
- **Admin** — regular named accounts the Owner creates (e.g. "Manager",
  "Front Desk"). They can see everything the Owner can (Sales History,
  Reports, Expense History) and use the app normally, but **cannot delete
  data** and cannot manage other admin accounts.

Log in as `Admin` / `1234` once, then go to **Sales History → Manage
Admins** to change that password and add named accounts for everyone else.
Every admin — Owner included — can change their own password from the
same screen ("Change My Password").

**Deleting anything always asks for the Owner's password**, even if a
regular admin is the one trying to delete it — a dialog pops up for it.
Once entered correctly, it's remembered for the rest of that browser tab's
session (not saved to disk), so you're not re-typing it for every delete.

If you're upgrading from an older copy of this app (PIN-based, or an
earlier flat admin list with no Owner), the first admin account
automatically becomes the Owner the first time the upgraded server starts
— nothing is lost, and no manual migration is needed.

## Putting it on the internet (so staff can reach it from their phones)

Pick any one option; all of them keep the app running continuously on an
address you control, with no "claude.ai" anywhere in it.

- **Render.com / Railway.app** — both offer a free or low-cost tier for
  small Node apps. Push this folder to a GitHub repo, connect it, and set
  the start command to `npm start`. They give you a URL like
  `hotel-indiana.onrender.com`, or you can point your own domain at it.
- **A VPS you rent** (DigitalOcean, Linode, etc.) — install Node, copy this
  folder over, run `npm install && npm start` (ideally under something like
  `pm2` so it restarts automatically), and point a domain name at the
  server's IP address.
- **Your own domain** — once hosted anywhere above, you can attach a domain
  like `pos.hotelindiana.co.ke` to it through your domain registrar's DNS
  settings, so the link you share looks fully your own.

**Honest limitation:** like the PIN before it, this login gates what's
*shown on screen* — it doesn't add server-side authentication to every API
request. Anyone who can reach your server's address directly (not through
the app's UI) could still call the data endpoints. For a small, trusted
team this is a reasonable tradeoff; if you need real access control (e.g.
the app is reachable by people outside your staff), that's a bigger change
worth doing properly rather than bolting on — ask if you want that built.

## Keeping your data safe

Back up `data/db.json` periodically (copy it somewhere else) — it's the only
copy of your sales and item records. If you move to a hosting provider that
wipes the filesystem between deploys (some free tiers do), you'll want a
real database instead of the JSON file for that reason.

## Notes

- Payment is split between **Cash** and **M-Pesa**; M-Pesa sales require a
  confirmation code to be entered, matching the SMS from Safaricom.
- **Expenses** can be logged from the Expenses tab (description, category,
  amount, Cash or M-Pesa). Anyone can log an expense; viewing the history
  and totals requires the admin PIN, same as Sales History. Reports shows
  Total Expenses and **Net** (Sales minus Expenses).
- Any sale or expense paid via **M-Pesa** triggers a live on-screen alert
  (banner + sound, plus a system notification if the tab is backgrounded)
  on every device that has the app open — sales show green, expenses show
  red, so you can tell money coming in from money going out at a glance.
- Staff can still type an M-Pesa confirmation code manually. But if you set
  up the automatic flow below, confirmed payments show up live as tappable
  tiles instead — no typing needed.
- **Held Sales**: while building a sale, staff can tap **Hold Sale** (with
  an optional label like "Table 4" or "Room 12") to park it and start a
  fresh sale for someone else. Parked sales appear in a **Held Sales**
  panel — visible to everyone, live, on every device — with **Resume** to
  pick it back up and finish payment, or **Cancel** to drop it. A sale can
  only be resumed into an empty cart, so two staff can't accidentally merge
  two tabs together.

## Automatic M-Pesa confirmations (optional, but this is the real thing)

This makes Safaricom notify your app the instant someone pays your till —
no polling, no manual entry. It requires a few things that only you (or
Safaricom) can provide:

1. **A registered Till Number or Paybill.** This is a real Safaricom
   business account — sign up at your nearest Safaricom shop or via
   [Safaricom's business portal](https://www.safaricom.co.ke/business).
   I can't create or supply this for you.
2. **Daraja API credentials.** Register an app at
   [developer.safaricom.co.ke](https://developer.safaricom.co.ke) to get a
   Consumer Key and Consumer Secret tied to your till.
3. **This app running at a public HTTPS address** (see "Putting it on the
   internet" above — Render/Railway give you HTTPS automatically; a VPS
   needs a certificate, e.g. via Let's Encrypt).

Once you have all three:

1. On your server, set two environment variables before starting the app:
   - `MPESA_WEBHOOK_SECRET` — any long random string you make up (this
     keeps random internet traffic from faking a payment, since Safaricom's
     C2B callback has no built-in signature to verify).
   - `PORT` (optional, defaults to 3000).
2. Run the one-time registration script. If you've filled in `.env` (see
   `.env.example`) and have Node 20.6+, this reads it automatically:
   ```bash
   node --env-file=.env register-mpesa-urls.js
   ```
   Otherwise, pass the values directly:
   ```bash
   MPESA_CONSUMER_KEY=xxx \
   MPESA_CONSUMER_SECRET=xxx \
   MPESA_SHORTCODE=your_sandbox_test_shortcode \
   MPESA_WEBHOOK_SECRET=the_same_secret_you_set_above \
   PUBLIC_URL=https://your-domain.com \
   MPESA_ENV=sandbox \
   node register-mpesa-urls.js
   ```
   Use `MPESA_ENV=sandbox` to test against Safaricom's sandbox first; switch
   to `MPESA_ENV=production` (and your real till number) once it's working.
3. From then on, every payment to your till shows up within the app as a
   live amber alert and a tappable tile under the M-Pesa field at checkout
   — staff tap the matching one instead of typing a code.

If you skip this section entirely, the app still works exactly as before —
manual code entry.
