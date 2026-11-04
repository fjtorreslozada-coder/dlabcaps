/* DLAB Caps accounts: register, magic-link login, saved designs, admin, welcome email.
   Needs a D1 binding named DB (tables are created automatically) and the RESEND_API_KEY secret. */
const SITE = 'https://dlabcaps.com';
const FROM = 'DLAB Caps <hola@dlabcaps.com>';
const REPLY_TO = 'dlabstorepr@gmail.com';
const ADMINS_DEFAULT = 'dlabstorepr@gmail.com,fjtorreslozada@gmail.com';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, company TEXT, phone TEXT, lang TEXT, verified INTEGER DEFAULT 0, created INTEGER, last_seen INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER, expires INTEGER)`,
  `CREATE TABLE IF NOT EXISTS magic (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER, used INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS designs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, summary TEXT, total TEXT, status TEXT, state TEXT, quote TEXT, thumb TEXT, photos TEXT, created INTEGER, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS designs_user ON designs(user_id, updated)`
];
let ready = false;
async function init(db) { if (ready) return; for (const s of SCHEMA) await db.prepare(s).run(); ready = true; }

const now = () => Date.now();
const rid = (n = 24) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, n * 1.5 | 0); };
const clean = (s, n) => String(s || '').trim().slice(0, n);
const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e);
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function newSession(db, uid) {
  const t = rid(32), n = now();
  await db.prepare('INSERT INTO sessions (token,user_id,created,expires) VALUES (?,?,?,?)').bind(t, uid, n, n + 1000 * 60 * 60 * 24 * 180).run();
  return t;
}
async function userFrom(req, db) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const r = await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').bind(t, now()).first();
  if (r) await db.prepare('UPDATE users SET last_seen=? WHERE id=?').bind(now(), r.id).run();
  return r || null;
}
const isAdmin = (env, u) => !!u && !!u.verified && (env.ADMIN_EMAILS || ADMINS_DEFAULT).toLowerCase().split(',').map(s => s.trim()).includes(u.email);
const pub = u => ({ name: u.name, email: u.email, company: u.company, phone: u.phone, lang: u.lang, verified: !!u.verified });

async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return { skipped: true };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || FROM, to: [to], reply_to: env.REPLY_TO || REPLY_TO, subject, html })
  });
  return { ok: r.ok, status: r.status };
}
function mailHtml(es, name, link, kind) {
  const T = (en, sp) => es ? sp : en;
  const hi = kind === 'welcome' ? T(`Welcome to DLAB Caps, ${esc(name)}!`, `¡Bienvenido a DLAB Caps, ${esc(name)}!`) : T('Your sign-in link', 'Su enlace para entrar');
  const body = kind === 'welcome'
    ? T('Your account is ready. Every design you confirm in our quote tool is saved in your account, with its mockup and realistic photos. Use the button below to confirm your email and open your account on any device.',
        'Su cuenta está lista. Cada diseño que confirme en nuestro cotizador se guarda en su cuenta, con su mockup y sus fotos realistas. Use el botón para confirmar su email y abrir su cuenta en cualquier equipo.')
    : T('Tap the button to sign in to your DLAB Caps account. The link works once and expires in 7 days.', 'Toque el botón para entrar a su cuenta de DLAB Caps. El enlace funciona una vez y vence en 7 días.');
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f4f2ee;padding:24px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<div style="font-weight:800;font-size:22px;letter-spacing:.02em;color:#111">DLAB <span style="color:#d4401c">CAPS</span></div>
<h1 style="font-size:20px;margin:22px 0 10px;color:#111">${hi}</h1><p style="font-size:15px;line-height:1.5;color:#333">${body}</p>
<p style="margin:26px 0"><a href="${link}" style="background:#d4401c;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:8px;display:inline-block">${T('Open my account', 'Abrir mi cuenta')}</a></p>
<p style="font-size:13px;color:#666">${T('Questions? Just reply to this email.', '¿Preguntas? Solo responda a este email.')}</p>
<p style="font-size:12px;color:#999">DLAB Caps · Puerto Rico · dlabcaps.com</p></div></div>`;
}
async function magicLink(db, uid) {
  const t = rid(32);
  await db.prepare('INSERT INTO magic (token,user_id,expires) VALUES (?,?,?)').bind(t, uid, now() + 1000 * 60 * 60 * 24 * 7).run();
  return `${SITE}/order.html#acct=${t}`;
}

export async function accounts(req, env, ctx, url, J) {
  const db = env.DB;
  if (!db) return J({ error: 'accounts_not_configured' }, 503);
  await init(db);
  const p = url.pathname.replace(/\/+$/, '');
  const body = req.method === 'POST' || req.method === 'PUT' ? await req.json().catch(() => ({})) : {};
  const es = String(body.lang || '').startsWith('es');

  if (p === '/auth/register' && req.method === 'POST') {
    const email = clean(body.email, 200).toLowerCase(), name = clean(body.name, 120);
    if (!okEmail(email) || name.length < 2) return J({ error: 'invalid' }, 400);
    const ex = await db.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
    if (ex) {
      // existing account: never hand out a session without proving the email; send a sign-in link
      const link = await magicLink(db, ex.id);
      ctx.waitUntil(sendMail(env, email, es ? 'Su enlace para entrar a DLAB Caps' : 'Your DLAB Caps sign-in link', mailHtml(es, ex.name, link, 'login')));
      return J({ status: 'check_email' });
    }
    const id = rid(16), n = now();
    await db.prepare('INSERT INTO users (id,email,name,company,phone,lang,verified,created,last_seen) VALUES (?,?,?,?,?,?,0,?,?)')
      .bind(id, email, name, clean(body.company, 120), clean(body.phone, 40), es ? 'es' : 'en', n, n).run();
    const token = await newSession(db, id), link = await magicLink(db, id);
    ctx.waitUntil(sendMail(env, email, es ? '¡Bienvenido a DLAB Caps! Su cuenta está lista' : 'Welcome to DLAB Caps! Your account is ready', mailHtml(es, name, link, 'welcome')));
    return J({ status: 'ok', token, user: { name, email, verified: false } });
  }
  if (p === '/auth/login' && req.method === 'POST') {
    const email = clean(body.email, 200).toLowerCase();
    const u = okEmail(email) && await db.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
    if (u) { const link = await magicLink(db, u.id); ctx.waitUntil(sendMail(env, email, es ? 'Su enlace para entrar a DLAB Caps' : 'Your DLAB Caps sign-in link', mailHtml(es, u.name, link, 'login'))); }
    return J({ status: 'check_email' });
  }
  if (p === '/auth/verify' && req.method === 'POST') {
    const m = await db.prepare('SELECT * FROM magic WHERE token=?').bind(clean(body.token, 80)).first();
    if (!m || m.used || m.expires < now()) return J({ error: 'expired' }, 400);
    await db.prepare('UPDATE magic SET used=1 WHERE token=?').bind(m.token).run();
    await db.prepare('UPDATE users SET verified=1 WHERE id=?').bind(m.user_id).run();
    const u = await db.prepare('SELECT * FROM users WHERE id=?').bind(m.user_id).first();
    return J({ status: 'ok', token: await newSession(db, u.id), user: pub(u), admin: isAdmin(env, u) });
  }

  const u = await userFrom(req, db);
  if (!u) return J({ error: 'auth' }, 401);

  if (p === '/auth/logout' && req.method === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token=?').bind((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')).run();
    return J({ status: 'ok' });
  }
  if (p === '/me' && req.method === 'GET') {
    const r = await db.prepare('SELECT id,name,summary,total,status,thumb,created,updated FROM designs WHERE user_id=? ORDER BY updated DESC LIMIT 200').bind(u.id).all();
    return J({ user: pub(u), admin: isAdmin(env, u), designs: r.results || [] });
  }
  if (p === '/me' && req.method === 'POST') {
    await db.prepare('UPDATE users SET name=COALESCE(NULLIF(?,\'\'),name), company=?, phone=? WHERE id=?').bind(clean(body.name, 120), clean(body.company, 120), clean(body.phone, 40), u.id).run();
    return J({ status: 'ok' });
  }
  if (p === '/designs' && req.method === 'POST') {
    const st = JSON.stringify(body.state || {});
    if (st.length > 900000) return J({ error: 'too_big' }, 413);
    const photos = JSON.stringify((body.photos || []).slice(0, 3).filter(x => typeof x === 'string' && x.length < 250000));
    const thumb = typeof body.thumb === 'string' && body.thumb.length < 200000 ? body.thumb : '';
    const n = now();
    let id = clean(body.id, 40);
    const own = id && await db.prepare('SELECT id FROM designs WHERE id=? AND user_id=?').bind(id, u.id).first();
    if (own) {
      await db.prepare('UPDATE designs SET name=?,summary=?,total=?,status=?,state=?,quote=?,thumb=COALESCE(NULLIF(?,\'\'),thumb),photos=CASE WHEN ?=\'[]\' THEN photos ELSE ? END,updated=? WHERE id=?')
        .bind(clean(body.name, 120), clean(body.summary, 300), clean(body.total, 40), clean(body.status, 30) || 'saved', st, clean(body.quote, 20000), thumb, photos, photos, n, id).run();
    } else {
      id = rid(16);
      await db.prepare('INSERT INTO designs (id,user_id,name,summary,total,status,state,quote,thumb,photos,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, u.id, clean(body.name, 120), clean(body.summary, 300), clean(body.total, 40), clean(body.status, 30) || 'saved', st, clean(body.quote, 20000), thumb, photos, n, n).run();
    }
    return J({ status: 'ok', id });
  }
  const dm = p.match(/^\/designs\/([a-z0-9]+)$/);
  if (dm) {
    const d = await db.prepare('SELECT * FROM designs WHERE id=?').bind(dm[1]).first();
    if (!d || (d.user_id !== u.id && !isAdmin(env, u))) return J({ error: 'not_found' }, 404);
    if (req.method === 'DELETE') { if (d.user_id !== u.id) return J({ error: 'forbidden' }, 403); await db.prepare('DELETE FROM designs WHERE id=?').bind(d.id).run(); return J({ status: 'ok' }); }
    return J({ design: { ...d, state: JSON.parse(d.state || '{}'), photos: JSON.parse(d.photos || '[]') } });
  }
  if (p === '/admin/users' && isAdmin(env, u)) {
    const r = await db.prepare('SELECT u.id,u.name,u.email,u.company,u.phone,u.verified,u.created,u.last_seen,(SELECT COUNT(*) FROM designs d WHERE d.user_id=u.id) AS designs,(SELECT MAX(updated) FROM designs d WHERE d.user_id=u.id) AS last_design FROM users u ORDER BY COALESCE(last_design,u.created) DESC LIMIT 1000').all();
    return J({ users: r.results || [] });
  }
  const am = p.match(/^\/admin\/users\/([a-z0-9]+)$/);
  if (am && isAdmin(env, u)) {
    const cu = await db.prepare('SELECT * FROM users WHERE id=?').bind(am[1]).first();
    if (!cu) return J({ error: 'not_found' }, 404);
    const r = await db.prepare('SELECT id,name,summary,total,status,thumb,created,updated FROM designs WHERE user_id=? ORDER BY updated DESC').bind(cu.id).all();
    return J({ user: { ...pub(cu), id: cu.id, created: cu.created, last_seen: cu.last_seen }, designs: r.results || [] });
  }
  return J({ error: 'not_found' }, 404);
}
