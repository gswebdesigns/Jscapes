# JScapes Staff Portal

A JScapes branded staff portal starter built with Express, PostgreSQL, and plain HTML/CSS/JavaScript. It is ready to push to GitHub and deploy as a Railway web service.

The visual identity uses the J-SCAPES blue and green wordmark, a charcoal navigation panel, and the Gardening & Landscaping descriptor based on [jscapesgls.com](https://www.jscapesgls.com/).

## Run locally

1. Install Node.js 20 or newer and PostgreSQL.
2. Copy `.env.example` to `.env`, set `DATABASE_URL`, and set `SESSION_SECRET` to a long random value.
3. Set `STAFF_ADMIN_EMAIL` and `STAFF_ADMIN_PASSWORD` to create the first director. The password must be at least 12 characters. The initial account is created once; changing the environment values later does not reset its password.
4. Run `npm install`, then `npm start`, and open `http://localhost:3000`.

The database schema is created automatically on startup. Login is real server-side authentication: passwords are bcrypt hashed and sessions are stored in PostgreSQL. After signing in, use the profile control to sign out.

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a project from that GitHub repository and add a PostgreSQL service.
3. Add a `DATABASE_URL` reference to the PostgreSQL service's connection URL, plus a unique `SESSION_SECRET` and the initial director email/password.
4. Deploy. Railway sets `PORT`; the server listens on it and binds to `0.0.0.0`.
5. Sign in as the initial director. Directors can create accounts, assign or edit shifts, create events, review all staff records, and approve submitted timesheets. Managers have a read-only staff roster and can view staff shift and timesheet details. Staff accounts are restricted to their own records. Role checks are enforced server-side: directors can create/edit/deactivate accounts, reset passwords, assign shifts, and approve timesheets; managers can view staff; staff can view only their own records.
6. Remove the initial director password variable after first-time setup. Use a password manager for account credentials.

Example director API request (replace values and sign in first so the browser session cookie is present):

```js
await fetch('/api/staff', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({name:'Alex Morgan', email:'alex@company.com', password:'a-long-unique-password', role:'staff'})
});
```

## Included API

- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- `GET /api/shifts?from=YYYY-MM-DD` (own schedule for any role), `POST /api/shifts` and `PATCH /api/shifts/:id` (director)
- `GET /api/events`, `POST /api/events` (director)
- `GET /api/notifications`, `POST /api/notifications/:id/read`
- `GET /api/timesheets` (staff see only their own; managers see staff records; directors see all), `POST /api/timesheets/:id/submit` (own record), `PATCH /api/timesheets/:id/approve` (director)
- `GET /api/management/staff/:id` (manager/director staff detail; director also sees account status and notifications)
- `GET /api/documents`, `GET /api/documents/:id/download`
- `GET /api/staff` (manager or director), `POST /api/staff` and `PATCH /api/staff/:id` (director)
- `GET /api/health`

Put approved PDF files in `documents/` using the filenames in the `documents` table to enable downloads. The starter only creates the document records; it does not include company policy PDFs.

## Still to connect

The dashboard uses the signed-in account for hours, timesheets and schedules. The login and core protected API are backed by PostgreSQL, and document/event/notification lists load from the API. Dashboard hours, timesheets, and personal schedules use the signed-in account. Manager and director details are scoped by role. Add a delivery provider (email, push, or SMS) for real-time upcoming-event notifications. The notification panel currently shows records saved in the database; reminders are not automatically sent yet. Review deployment security and privacy requirements for your organization before launch.
