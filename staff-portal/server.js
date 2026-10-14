require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('node:fs/promises');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false } : false,
});
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '32kb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  name: 'jscapes.sid',
  secret: process.env.SESSION_SECRET || 'local-development-secret-change-before-deploy',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeSamplePdf(lines) {
  const escape = text => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let stream = 'BT\n/F1 16 Tf\n50 790 Td\n';
  lines.forEach((line, index) => { if (index) stream += '0 -24 Td\n'; stream += `(${escape(line)}) Tj\n`; });
  stream += 'ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('director','manager','staff')), active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id BIGSERIAL PRIMARY KEY, staff_id BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      title TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL, break_minutes INTEGER NOT NULL DEFAULT 30 CHECK (break_minutes >= 0),
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled'))
    );
    CREATE INDEX IF NOT EXISTS shifts_staff_start_idx ON shifts(staff_id, starts_at);
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT 'team',
      location TEXT NOT NULL DEFAULT '', starts_at TIMESTAMPTZ NOT NULL, description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY, staff_id BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      title TEXT NOT NULL, message TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'reminder',
      read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS notifications_staff_created_idx ON notifications(staff_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS timesheets (
      id BIGSERIAL PRIMARY KEY, staff_id BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      week_start DATE NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved')),
      submitted_at TIMESTAMPTZ, UNIQUE(staff_id, week_start)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Resources',
      description TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check; ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('director','manager','staff')); ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`);
  const email = process.env.STAFF_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.STAFF_ADMIN_PASSWORD;
  if (email && password && emailPattern.test(email) && password.length >= 12) {
    const existing = await pool.query('SELECT id FROM staff WHERE email = $1', [email]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(password, 12);
      const name = email.split('@')[0].split(/[._-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
      await pool.query('INSERT INTO staff(email, full_name, password_hash, role) VALUES($1,$2,$3,$4)', [email, name, hash, 'director']);
      console.log(`Created initial director account for ${email}`);
    } else {
      const existingAccount = await pool.query('SELECT id,password_hash FROM staff WHERE email=$1', [email]);
      if (await bcrypt.compare(password, existingAccount.rows[0].password_hash)) {
        await pool.query("UPDATE staff SET role='director',active=TRUE WHERE id=$1", [existingAccount.rows[0].id]);
      }
    }
  }
  await pool.query(`INSERT INTO documents(title, category, description, file_name)
    SELECT * FROM (VALUES
      ('Staff handbook','People & Culture','Policies, benefits and team information.','staff-handbook.pdf'),
      ('Timesheet template','Payroll','Printable timesheet for recording hours.','timesheet-template.pdf'),
      ('Workplace safety guide','Health & Safety','Quick reference for workplace safety.','workplace-safety-guide.pdf')
    ) AS seed(title,category,description,file_name)
    WHERE NOT EXISTS (SELECT 1 FROM documents)`);
  const documentDir = path.join(__dirname, 'documents');
  await fs.mkdir(documentDir, { recursive: true });
  for (const [file, title] of [['staff-handbook.pdf','Staff handbook'],['timesheet-template.pdf','Timesheet template'],['workplace-safety-guide.pdf','Workplace safety guide']]) {
    const fullPath = path.join(documentDir, file);
    try { await fs.access(fullPath); }
    catch { await fs.writeFile(fullPath, makeSamplePdf(['JSCAPES STAFF PORTAL', title, '', 'SAMPLE PLACEHOLDER DOCUMENT', 'Replace this file with your approved company PDF.'])); }
  }
}

async function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.status(401).json({ error: 'Please sign in to continue.' });
  try {
    const result = await pool.query('SELECT id,email,full_name,role,active FROM staff WHERE id=$1', [req.session.staffId]);
    if (!result.rowCount || !result.rows[0].active) return req.session.destroy(() => res.status(401).json({ error: 'This account is unavailable.' }));
    req.staff = result.rows[0]; next();
  } catch (error) { next(error); }
}
function requireRole(...roles) {
  return (req, res, next) => requireStaff(req, res, error => {
    if (error) return next(error);
    if (!roles.includes(req.staff.role)) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    next();
  });
}
const requireManager = requireRole('manager','director');
const requireDirector = requireRole('director');
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'database unavailable' }); }
});
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!emailPattern.test(email) || !password || password.length > 200) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const result = await pool.query('SELECT id, email, full_name, password_hash, role, active FROM staff WHERE email = $1', [email]);
  const staff = result.rows[0];
  if (!staff || !staff.active || !(await bcrypt.compare(password, staff.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start your session.' });
    req.session.staffId = staff.id;
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: 'Could not save your session.' });
      res.json({ staff: { id: staff.id, email: staff.email, name: staff.full_name, role: staff.role } });
    });
  });
});
app.post('/api/auth/logout', requireStaff, (req, res) => req.session.destroy(() => {
  res.clearCookie('jscapes.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.status(204).end();
}));
app.get('/api/auth/me', async (req, res) => {
  if (!req.session.staffId) return res.status(401).json({ error: 'Not signed in.' });
  const result = await pool.query('SELECT id,email,full_name,role,active FROM staff WHERE id=$1', [req.session.staffId]);
  if (!result.rowCount || !result.rows[0].active) return res.status(401).json({ error: 'Not signed in.' });
  const s = result.rows[0]; res.json({ staff: { id: s.id, email: s.email, name: s.full_name, role: s.role } });
});
app.get('/api/staff', requireManager, async (req, res) => {
  const result = req.staff.role === 'director'
    ? await pool.query('SELECT id,email,full_name,role,active,created_at FROM staff ORDER BY full_name')
    : await pool.query(`SELECT id,email,full_name,role FROM staff WHERE active=TRUE AND role='staff' ORDER BY full_name`);
  res.json({ staff: result.rows, access: req.staff.role });
});
app.post('/api/staff', requireDirector, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const role = ['staff','manager','director'].includes(req.body?.role) ? req.body.role : 'staff';
  if (name.length < 2 || name.length > 100 || !emailPattern.test(email) || password.length < 12 || password.length > 200)
    return res.status(400).json({ error: 'Provide a name, valid email, and password of at least 12 characters.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO staff(email,full_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,email,full_name,role,active,created_at', [email,name,hash,role]);
    res.status(201).json({ staff: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That email is already in use.' });
    throw error;
  }
});
app.patch('/api/staff/:id', requireDirector, async (req, res) => {
  const targetId=String(req.params.id); const name=String(req.body?.name||'').trim();
  const email=String(req.body?.email||'').trim().toLowerCase(); const role=String(req.body?.role||'staff');
  const active=req.body?.active!==false; const password=String(req.body?.password||'');
  if(!/^\d+$/.test(targetId)||name.length<2||name.length>100||!emailPattern.test(email)||!['director','manager','staff'].includes(role)|| (password && password.length<12))
    return res.status(400).json({error:'Check the name, email, role, and password (12 characters minimum).'});
  if(targetId===String(req.staff.id)&&(!active||role!=='director'))return res.status(400).json({error:'You cannot deactivate or demote your own director account.'});
  try {
    const before=await pool.query('SELECT role,active FROM staff WHERE id=$1',[targetId]);
    if(!before.rowCount)return res.status(404).json({error:'Staff account not found.'});
    const result=await pool.query(`UPDATE staff SET email=$2,full_name=$3,role=$4,active=$5,password_hash=CASE WHEN $6='' THEN password_hash ELSE $7 END WHERE id=$1 RETURNING id,email,full_name,role,active,created_at`,[targetId,email,name,role,active,password,password?await bcrypt.hash(password,12):'']);
    if(targetId!==String(req.staff.id)&&(password||!active||before.rows[0].role!==role))await pool.query(`UPDATE session SET expire=NOW() WHERE sess->>'staffId'=$1`,[targetId]);
    res.json({staff:result.rows[0]});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'That email is already in use.'});throw error}
});
app.get('/api/management/staff/:id', requireManager, async (req,res) => {
  if(!/^\d+$/.test(String(req.params.id)))return res.status(400).json({error:'Invalid staff id.'});
  const staffResult=await pool.query(`SELECT id,email,full_name,role,${req.staff.role==='director'?'active,created_at':'active'} FROM staff WHERE id=$1 AND ($2='director' OR (active=TRUE AND role='staff'))`,[req.params.id,req.staff.role]);
  if(!staffResult.rowCount)return res.status(404).json({error:'Staff member not found.'});
  const [shifts,timesheets]=await Promise.all([
    pool.query('SELECT id,title,location,starts_at,ends_at,break_minutes,status FROM shifts WHERE staff_id=$1 ORDER BY starts_at DESC',[req.params.id]),
    pool.query(`SELECT t.id,t.week_start,t.status,t.submitted_at,COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM(s.ends_at-s.starts_at))/3600-s.break_minutes/60.0)),0)::numeric(6,2) AS hours FROM timesheets t LEFT JOIN shifts s ON s.staff_id=t.staff_id AND s.starts_at::date>=t.week_start AND s.starts_at::date<t.week_start+7 WHERE t.staff_id=$1 GROUP BY t.id ORDER BY t.week_start DESC`,[req.params.id])
  ]);
  const details={staff:staffResult.rows[0],shifts:shifts.rows,timesheets:timesheets.rows};
  if(req.staff.role==='director'){const notifications=await pool.query('SELECT id,title,message,kind,read_at,created_at FROM notifications WHERE staff_id=$1 ORDER BY created_at DESC',[req.params.id]);details.notifications=notifications.rows}
  res.json(details);
});
app.post('/api/shifts', requireDirector, async (req, res) => {
  const { staffId, title, location = '', startsAt, endsAt, breakMinutes = 30 } = req.body || {};
  const start = new Date(startsAt), end = new Date(endsAt), pause = Number(breakMinutes);
  if (!staffId || !String(title || '').trim() || Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start || !Number.isInteger(pause) || pause < 0 || pause > 240)
    return res.status(400).json({ error: 'Provide a staff member, shift title, valid start/end, and break from 0 to 240 minutes.' });
  const result = await pool.query('INSERT INTO shifts(staff_id,title,location,starts_at,ends_at,break_minutes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [staffId,String(title).trim(),String(location).trim(),start,end,pause]);
  res.status(201).json({ shift: result.rows[0] });
});
app.patch('/api/shifts/:id', requireDirector, async (req,res) => {
  const {title,location='',startsAt,endsAt,breakMinutes=30,status='scheduled'}=req.body||{};
  const start=new Date(startsAt),end=new Date(endsAt),pause=Number(breakMinutes);
  if(!/^\d+$/.test(String(req.params.id))||!String(title||'').trim()||Number.isNaN(start.valueOf())||Number.isNaN(end.valueOf())||end<=start||!Number.isInteger(pause)||pause<0||pause>240||!['scheduled','completed','cancelled'].includes(status))return res.status(400).json({error:'Check the shift details, break length, and status.'});
  const result=await pool.query('UPDATE shifts SET title=$2,location=$3,starts_at=$4,ends_at=$5,break_minutes=$6,status=$7 WHERE id=$1 RETURNING *',[req.params.id,String(title).trim(),String(location).trim(),start,end,pause,status]);
  if(!result.rowCount)return res.status(404).json({error:'Shift not found.'});res.json({shift:result.rows[0]});
});
app.patch('/api/timesheets/:id/approve', requireDirector, async (req,res) => {
  const result=await pool.query("UPDATE timesheets SET status='approved' WHERE id=$1 AND status='submitted' RETURNING id,staff_id,week_start,status",[req.params.id]);
  if(!result.rowCount)return res.status(404).json({error:'Submitted timesheet not found.'});res.json({timesheet:result.rows[0]});
});
app.post('/api/events', requireDirector, async (req, res) => {
  const { title, eventType = 'team', location = '', startsAt, description = '' } = req.body || {};
  const start = new Date(startsAt);
  if (!String(title || '').trim() || Number.isNaN(start.valueOf())) return res.status(400).json({ error: 'Provide an event title and valid start time.' });
  const result = await pool.query('INSERT INTO events(title,event_type,location,starts_at,description) VALUES($1,$2,$3,$4,$5) RETURNING *', [String(title).trim(),String(eventType).trim(),String(location).trim(),start,String(description).trim()]);
  await pool.query(`INSERT INTO notifications(staff_id,title,message,kind) SELECT id,$1,$2,'event' FROM staff WHERE active=TRUE`, [`Upcoming event: ${String(title).trim()}`, `${start.toLocaleString()} · ${String(location).trim()}`]);
  res.status(201).json({ event: result.rows[0] });
});
app.get('/api/shifts', requireStaff, async (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date();
  if (Number.isNaN(from.valueOf())) return res.status(400).json({ error: 'Invalid start date.' });
  const to = new Date(from); to.setDate(to.getDate() + 14);
  const result = await pool.query(`SELECT id,title,location,starts_at,ends_at,break_minutes,status FROM shifts
    WHERE staff_id=$1 AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at`, [req.staff.id, from, to]);
  res.json({ shifts: result.rows });
});
app.get('/api/events', requireStaff, async (req, res) => {
  const result = await pool.query('SELECT id,title,event_type,location,starts_at,description FROM events WHERE starts_at >= NOW() ORDER BY starts_at LIMIT 20');
  res.json({ events: result.rows });
});
app.get('/api/notifications', requireStaff, async (req, res) => {
  const result = await pool.query('SELECT id,title,message,kind,read_at,created_at FROM notifications WHERE staff_id=$1 ORDER BY created_at DESC LIMIT 30', [req.session.staffId]);
  res.json({ notifications: result.rows });
});
app.post('/api/notifications/:id/read', requireStaff, async (req, res) => {
  await pool.query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND staff_id=$2', [req.params.id, req.session.staffId]);
  res.status(204).end();
});
app.get('/api/timesheets', requireStaff, async (req, res) => {
  const result = await pool.query(`SELECT t.id,t.staff_id,st.full_name AS staff_name,t.week_start,t.status,t.submitted_at,
    COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (s.ends_at-s.starts_at))/3600 - s.break_minutes/60.0)),0)::numeric(6,2) AS hours
    FROM timesheets t JOIN staff st ON st.id=t.staff_id LEFT JOIN shifts s ON s.staff_id=t.staff_id AND s.starts_at::date >= t.week_start AND s.starts_at::date < t.week_start + 7
    WHERE ($1::text='director' OR st.active=TRUE) AND (($1::text='staff' AND t.staff_id=$2) OR ($1::text='manager' AND st.role='staff') OR $1::text='director') GROUP BY t.id,st.full_name ORDER BY t.week_start DESC`, [req.staff.role,req.staff.id]);
  res.json({ timesheets: result.rows });
});
app.get('/api/timesheets/current', requireStaff, async (req, res) => {
  const result = await pool.query(`WITH bounds AS (SELECT date_trunc('week',CURRENT_DATE)::date AS week_start),
    totals AS (SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (ends_at-starts_at))/3600 - break_minutes/60.0)),0)::numeric(6,2) AS hours
      FROM shifts,bounds WHERE staff_id=$1 AND starts_at::date >= bounds.week_start AND starts_at::date < bounds.week_start + 7)
    SELECT bounds.week_start, totals.hours, COALESCE(t.status,'draft') AS status, t.id
    FROM bounds CROSS JOIN totals LEFT JOIN timesheets t ON t.staff_id=$1 AND t.week_start=bounds.week_start`, [req.session.staffId]);
  res.json({ timesheet: result.rows[0] });
});
app.post('/api/timesheets/current/submit', requireStaff, async (req, res) => {
  const result = await pool.query(`INSERT INTO timesheets(staff_id,week_start,status,submitted_at)
    VALUES($1,date_trunc('week',CURRENT_DATE)::date,'submitted',NOW())
    ON CONFLICT(staff_id,week_start) DO UPDATE SET status='submitted',submitted_at=NOW()
    WHERE timesheets.status='draft' RETURNING id,status,submitted_at`, [req.session.staffId]);
  if (!result.rowCount) return res.status(409).json({ error: 'This timesheet has already been submitted or approved.' });
  res.json({ timesheet: result.rows[0] });
});
app.post('/api/timesheets/:id/submit', requireStaff, async (req, res) => {
  const result = await pool.query(`UPDATE timesheets SET status='submitted',submitted_at=NOW()
    WHERE id=$1 AND staff_id=$2 AND status='draft' RETURNING id,status,submitted_at`, [req.params.id, req.session.staffId]);
  if (!result.rowCount) return res.status(404).json({ error: 'Draft timesheet not found.' });
  res.json({ timesheet: result.rows[0] });
});
app.get('/api/documents', requireStaff, async (_req, res) => {
  const result = await pool.query('SELECT id,title,category,description,file_name,updated_at FROM documents ORDER BY category,title');
  res.json({ documents: result.rows });
});
app.get('/api/documents/:id/download', requireStaff, async (req, res) => {
  const result = await pool.query('SELECT file_name FROM documents WHERE id=$1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Document not found.' });
  const safeName = path.basename(result.rows[0].file_name);
  const file = path.join(__dirname, 'documents', safeName);
  try { await fs.access(file); res.download(file, safeName); }
  catch { res.status(404).json({ error: 'The document file has not been uploaded yet.' }); }
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); });

initializeDatabase().then(() => app.listen(port, '0.0.0.0', () => console.log(`Staff Hub listening on ${port}`)))
  .catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
