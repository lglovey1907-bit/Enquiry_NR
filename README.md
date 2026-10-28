# NR Enquiry Desk — staff & admin portal

Staff register with their email (verified by a 6-digit code sent from the Commercial Branch Gmail), add their name, HRMS ID and a password, and wait for admin approval. Approved staff sign in and add trains departing New Delhi; the seat-check worker checks them on IRCTC and the counter board updates on its own.

- **Admin:** loveyy.cmi@gmail.com (approved automatically on registration)
- **Database:** Supabase project `nr-enquiry-system` (Mumbai) — already set up, nothing to run
- **Pages:** `/` the public live board (no login, for the counter screen), `/login`, `/register`, `/dashboard` (add / remove trains), `/admin` (approve, reject, disable staff)

## One-time setup (about 15 minutes)

### 1. Gmail app password (so OTP emails come from your Gmail)
1. Open https://myaccount.google.com/security and make sure **2-Step Verification** is on.
2. Open https://myaccount.google.com/apppasswords, create an app password named `NR Enquiry Desk`, and copy the 16-character code. Keep it private.

### 2. Supabase email settings
Open the project at https://supabase.com/dashboard/project/guhxzsjckifbfwmdrmou

**Authentication → Emails → SMTP Settings** → enable Custom SMTP:

| Field | Value |
|---|---|
| Sender email | loveyy.cmi@gmail.com |
| Sender name | NR Enquiry Desk |
| Host | smtp.gmail.com |
| Port | 465 |
| Username | loveyy.cmi@gmail.com |
| Password | the 16-character app password from step 1 |

**Authentication → Emails → Templates → Magic Link** — replace the body so it sends a code instead of a link:

```html
<h2>NR Enquiry Desk — verification code</h2>
<p>Your code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
<p>It is valid for 10 minutes. If you did not request it, ignore this email.</p>
```

Set the subject to `Your NR Enquiry Desk code`. Do the same for the **Confirm signup** template.

**Authentication → Sign In / Providers → Email:** keep Email enabled, set *Email OTP Expiration* to `600` seconds and *Email OTP Length* to `6`. Set minimum password length to `8`.

**Authentication → Rate Limits:** raise *Emails sent per hour* to about `30` (Gmail allows roughly 500 a day).

### 3. Deploy on Vercel
1. Put this folder in a new GitHub repository (or run `npx vercel` inside it from your computer).
2. On https://vercel.com/new import the repository. Framework: Next.js (detected).
3. Add environment variables (also in `.env.example`):
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://guhxzsjckifbfwmdrmou.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_SNVOcRxx_fZ7H3d4TDeGEw_38Tbu6Cq`
4. Deploy. Then in Supabase **Authentication → URL Configuration** set *Site URL* to your Vercel address.

### 4. First sign-in
Register at `/register` with loveyy.cmi@gmail.com — your account is approved as admin straight away. Staff who register after that appear under **Staff approvals**.

## Counter screen
Open the site's main address on the counter TV and press F11 for full screen. It shows every train that has been checked and not yet departed, refreshes every minute, scrolls long routes sideways, and drops each train at its departure time. Anyone can view it without signing in; it shows only train numbers, stops and seat counts.

## How seat checks run
Four scheduled tasks on the Commercial Branch computer (Enquiry board worker :05, :20, :35, :50) run every 15 minutes. Each run marks departed trains, checks any train that is new or due (every 30 minutes from when it was added, only on its journey date), saves the result in Supabase and updates the counter board. The computer must be on and awake with the Claude desktop app open.

## Security
- Row level security on every table. Pending, rejected and disabled accounts see no trains.
- Staff can only submit a train number and journey date; everything else is set by the system. Staff remove only trains they added; the admin can remove any.
- Only the admin can approve, reject or disable accounts, and cannot disable their own.
- The publishable key above is safe in the browser; it only works within those rules.

## Local development
```
npm install
cp .env.example .env.local
npm run dev
```
