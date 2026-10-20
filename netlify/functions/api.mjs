// שרת קטן למשחק: שחקנים לפי שם ושם משפחה, צבירת נקודות, טבלת עשרת הראשונים ומסך מנהל.
// הנתונים נשמרים ב־Netlify Blobs; הקוד הזה רץ בשרת ואינו נשלח לדפדפן.
import { getStore } from '@netlify/blobs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const ADMIN_SALT = 'aaf7a19d0fc1d894';
const ADMIN_HASH = '28ae2846f5f12bf91758abb69062665b10083c85d3c4266fd76464a497990fb0';
const TOKEN_SECRET = '7071eea5d7ccd3cd1543b3affe22bc1492ffcc242c55a0ff';
const MAX_QUESTIONS = 52, MAX_POINTS_PER_Q = 20, TOP = 10, HISTORY = 100;
const MODES = ['round', 'mistakes'];

const store = () => getStore({ name: 'taanit1', consistency: 'strong' });
const sha = s => createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normName = n => String(n || '').trim().replace(/\s+/g, ' ');
const keyOf = n => 'user/' + encodeURIComponent(normName(n).toLowerCase());
const tokenOf = n => createHmac('sha256', TOKEN_SECRET).update(normName(n).toLowerCase()).digest('hex');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (msg, status = 400) => json({ error: msg }, status);

// שם פרטי ושם משפחה: לפחות שתי מילים
const validName = n => n.length >= 4 && n.length <= 30 && n.split(' ').length >= 2;
const isAdmin = code => same(sha(ADMIN_SALT + ':' + String(code || '')), ADMIN_HASH);
const pub = u => ({ name: u.name, total: u.total, games: u.games, best: u.best });
const detail = u => ({ ...pub(u), answered: u.answered || 0, right: u.right || 0, created: u.created, last: u.last, history: u.history || [] });

async function allUsers(s) {
  const { blobs } = await s.list({ prefix: 'user/' });
  const users = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
  return users.filter(Boolean).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'he'));
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const s = store();

  if (route === 'top' && req.method === 'GET') {
    const users = await allUsers(s);
    return json({ top: users.slice(0, TOP).map(u => ({ name: u.name, total: u.total })), players: users.length });
  }
  if (req.method !== 'POST') return fail('not found', 404);
  const body = await readBody(req);

  // כניסה לפי שם: שם חדש נוצר, שם קיים ממשיך לצבור נקודות
  if (route === 'join') {
    const name = normName(body.name);
    if (!validName(name)) return fail('כתבו שם פרטי ושם משפחה (עד 30 תווים).');
    const key = keyOf(name);
    let user = await s.get(key, { type: 'json' });
    if (!user) {
      user = { name, total: 0, games: 0, best: 0, answered: 0, right: 0, history: [], created: Date.now(), last: 0 };
      await s.setJSON(key, user);
    }
    return json({ ...pub(user), token: tokenOf(user.name) });
  }

  if (route === 'me') {
    if (!body.token || !same(String(body.token), tokenOf(body.name))) return fail('צריך להיכנס מחדש.', 401);
    const user = await s.get(keyOf(body.name), { type: 'json' });
    if (!user) return fail('המשתמש לא נמצא. צריך להירשם מחדש.', 404);
    return json(pub(user));
  }

  if (route === 'score') {
    if (!body.token || !same(String(body.token), tokenOf(body.name))) return fail('צריך להיכנס מחדש.', 401);
    const key = keyOf(body.name);
    const user = await s.get(key, { type: 'json' });
    if (!user) return fail('המשתמש לא נמצא. צריך להירשם מחדש.', 404);
    const q = Math.floor(Number(body.questions)), c = Math.floor(Number(body.correct)), p = Math.floor(Number(body.points));
    if (!(q >= 1 && q <= MAX_QUESTIONS && c >= 0 && c <= q && p >= 0 && p <= c * MAX_POINTS_PER_Q)) return fail('הניקוד לא תקין.');
    const wrong = Array.isArray(body.wrong) ? [...new Set(body.wrong.map(Number).filter(k => Number.isInteger(k) && k >= 0 && k < MAX_QUESTIONS))] : [];
    const mode = MODES.includes(body.mode) ? body.mode : 'round';
    // משחק לא יכול להסתיים מהר יותר משנייה וחצי לשאלה
    const now = Date.now();
    if (user.last && now - user.last < q * 1500) return fail('המשחק הסתיים מהר מדי ולא נשמר.', 429);
    user.total += p; user.games += 1; user.best = Math.max(user.best, p); user.last = now;
    user.answered = (user.answered || 0) + q; user.right = (user.right || 0) + c;
    user.history = [{ at: now, mode, q, c, p, wrong }, ...(user.history || [])].slice(0, HISTORY);
    await s.setJSON(key, user);
    return json(pub(user));
  }

  if (route === 'admin') {
    if (!isAdmin(body.code)) return fail('קוד המנהל לא נכון.', 401);
    if (body.action === 'delete') await s.delete(keyOf(body.name));
    const users = await allUsers(s);
    return json({ users: users.map(detail) });
  }

  return fail('not found', 404);
};

export const config = { path: '/api/*' };
