/**
 * DLAB Caps · realistic photo generator (Cloudflare Worker)
 *
 * The quote builder sends the flat mockup views (front / side / back) as small JPEGs
 * plus a text description. This worker asks an image model to turn each view into a
 * realistic studio photo and returns the results. The API key lives only here, as a
 * Cloudflare secret, never in the website.
 *
 * Settings (Cloudflare > Worker > Settings > Variables):
 *   PROVIDER         gemini | openai | fal          (default gemini)
 *   GEMINI_API_KEY   secret, from aistudio.google.com
 *   GEMINI_MODEL     optional, default gemini-2.5-flash-image (gemini-3-pro-image-preview = more realistic, ~3x cost; falls back automatically)
 *   GEMINI_SIZE      optional for gemini-3 models: 1K (default) or 2K
 *   OPENAI_API_KEY   secret, from platform.openai.com
 *   OPENAI_MODEL     optional, default gpt-image-1
 *   FAL_KEY          secret, from fal.ai
 *   FAL_MODEL        optional, default fal-ai/flux-pro/kontext
 *   ALLOWED_ORIGINS  comma list, default https://dlabcaps.com,https://www.dlabcaps.com
 *   DAILY_LIMIT      tries per visitor per day, default 4
 *   RL               optional KV namespace binding used for the daily limit
 */
import { accounts } from './accounts.js';
const J = (o, s, h) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json', ...(h || {}) } });

export default {
  async fetch(req, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || 'https://dlabcaps.com,https://www.dlabcaps.com').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('origin') || '';
    const ok = allowed.includes('*') || allowed.includes(origin);
    const cors = { 'access-control-allow-origin': ok ? origin : allowed[0], 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', vary: 'origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (/^\/(auth|me|designs|admin)(\/|$)/.test(url.pathname)) {
      if (!ok) return J({ error: 'origin not allowed' }, 403, cors);
      try { return await accounts(req, env, ctx, url, (o2, s2) => J(o2, s2, cors)); }
      catch (e) { return J({ error: 'server', message: String(e && e.message || e).slice(0, 200) }, 500, cors); }
    }
    if (req.method === 'GET') return J({ ok: true, provider: env.PROVIDER || 'gemini', accounts: !!env.DB, mail: !!env.RESEND_API_KEY }, 200, cors);
    if (req.method !== 'POST') return J({ error: 'method' }, 405, cors);
    if (!ok) return J({ error: 'origin not allowed' }, 403, cors);

    let body; try { body = await req.json() } catch (e) { return J({ error: 'bad json' }, 400, cors) }
    const views = (body.views || []).slice(0, 4).filter(v => v && typeof v.jpg === 'string' && v.jpg.length < 1500000);
    if (!views.length) return J({ error: 'no views' }, 400, cors);
    const desc = String(body.prompt || '').slice(0, 4000);

    // daily limit per visitor (IP + email)
    const limit = +(env.CLIENT_LIMIT || 12);
    const day0 = new Date().toISOString().slice(0, 10), ip = req.headers.get('cf-connecting-ip') || 'x', em = String(body.email || '').toLowerCase().slice(0, 80);
    const dk = String(body.design || '').slice(0, 64);
    if (env.DB) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_usage (k TEXT PRIMARY KEY, n INTEGER)').run();
      const get = async k => ((await env.DB.prepare('SELECT n FROM ai_usage WHERE k=?').bind(k).first()) || {}).n || 0;
      const bump = k => env.DB.prepare('INSERT INTO ai_usage (k,n) VALUES (?,1) ON CONFLICT(k) DO UPDATE SET n=n+1').bind(k).run();
      const who = em || ('ip:' + ip);
      if (dk && await get('dk:' + who + ':' + dk)) return J({ error: 'same_design', message: 'Photos for this design were already created' }, 429, cors);
      if (await get('cl:' + who) >= limit) return J({ error: 'limit', message: 'Client limit reached' }, 429, cors);
      if (await get('ip:' + day0 + ':' + ip) >= limit * 3) return J({ error: 'limit', message: 'Too many today' }, 429, cors);
      await bump('cl:' + who); await bump('ip:' + day0 + ':' + ip); if (dk) await bump('dk:' + who + ':' + dk);
    } else if (env.RL) {
      const day = new Date().toISOString().slice(0, 10);
      const who = (req.headers.get('cf-connecting-ip') || 'x') + '|' + String(body.email || '').toLowerCase().slice(0, 80);
      const key = 'rl:' + day + ':' + who, n = +(await env.RL.get(key) || 0);
      if (n >= limit) return J({ error: 'limit', message: 'Daily limit reached' }, 429, cors);
      await env.RL.put(key, String(n + 1), { expirationTtl: 90000 });
    }

    const provider = (env.PROVIDER || 'gemini').toLowerCase();
    const run = v => {
      const b64b = v.jpg2 ? String(v.jpg2).replace(/^data:image\/\w+;base64,/, '') : null;
      const p = `${BASE}\n${String(v.note || ('View: ' + v.name)).slice(0, 300)}\n${matLook(desc)}\n\nSPECIFICATION:\n${desc}\n\n${CHECK}`;
      const b64 = v.jpg.replace(/^data:image\/\w+;base64,/, '');
      if (provider === 'openai') return openai(env, p, b64);
      if (provider === 'fal') return fal(env, p, b64);
      return gemini(env, p, b64, b64b);
    };
    const out = await Promise.all(views.map(v => run(v).then(img => ({ name: v.name, img }), e => ({ name: v.name, error: String(e && e.message || e).slice(0, 300) }))));
    return J({ images: out, provider }, 200, cors);
  }
};

const MATS = [
  [/waterproof/i, 'Waterproof fabric: a smooth, tightly woven nylon/polyester with a soft satin sheen and crisp folds.'],
  [/suede/i, 'Suede: soft brushed nap with a velvety matte surface whose shade shifts slightly with the direction of the fibers.'],
  [/corduroy/i, 'Corduroy: clear raised parallel wales with soft shadows between them.'],
  [/denim/i, 'Denim: diagonal twill weave with slight slub texture and natural color variation.'],
  [/mesh|trucker/i, 'Trucker mesh: open honeycomb mesh with visible holes on the back panels.'],
  [/polyester/i, 'Polyester: fine, smooth performance weave with a slight sheen.'],
  [/cotton|twill/i, 'Cotton twill: fine diagonal weave, matte surface, soft natural texture.'],
  [/acrylic|knit|beanie/i, 'Knit: chunky ribbed knit with visible loops of acrylic yarn and soft fuzz.'],
  [/rope/i, 'Rope on the brim: a real braided cord with visible twisted strands, sitting on top of the brim where it meets the crown.'],
  [/leather/i, 'Leather strap: real leather grain with stitched edges and a metal buckle or press with true metallic reflections.']
];
function matLook(desc) { const s = String(desc || ''); const out = MATS.filter(m => m[0].test(s)).map(m => m[1]); return out.length ? 'MATERIAL LOOK: ' + out.join(' ') : ''; }

const BASE = 'Turn this flat technical drawing of a cap into a real photograph of the finished, physical cap, as if it had been manufactured and then shot for a premium e-commerce catalog. ' +
  'Picture it: the cap sits on a light warm-gray seamless paper backdrop in a photo studio. A large softbox above and to the left wraps it in soft, even light, and a gentle contact shadow falls beneath the brim and the crown. It is shot on a full-frame DSLR with a 100mm macro lens at f/8, tack sharp, true-to-life color, natural contrast, with the subtle imperfections of a real object. ' +
  'You can see the real material up close: the weave of the fabric, tiny fibers catching the light, rows of tight thread stitching along every seam and around the brim, sewn eyelets, a fabric-covered top button, gentle natural creases where the panels meet the brim, and soft shading that shows the curved volume of the crown. ' +
  'Logos are physically made, never printed flat: raised thread embroidery with satin-stitch sheen, or a real patch with thickness, edges and a tiny shadow on the fabric. ' +
  'The result must be indistinguishable from a real photo. It must not look like a drawing, an illustration, a vector graphic, a cartoon, clip art or a 3D render: no outlines, no flat color fills, no cel shading. ' +
  'The drawing is the blueprint and must be followed exactly: the same silhouette, crown height, panel layout and seams, brim shape and curve, closure, and the same camera angle and framing. ' +
  'The thin dark lines in the drawing are only outlines, not black parts: never turn them into black piping, trim or a black brim edge. The edge of the brim is the same color as the top of the brim unless an edge binding color is listed. Seam thread matches the fabric color. ' +
  'Use the hex colors listed below as the true dyed fabric colors under neutral daylight; the drawing shows where each color goes. ' +
  'Logos and text keep the same artwork, letters, colors, size and position as in the drawing. Never invent, add, remove, translate or restyle any logo or text. ' +
  'No people, no mannequin head, no props, no watermark, no extra text, no frame or border.';
const CHECK = 'Before finishing, check: (1) it looks like a real camera photo, not a drawing; (2) every part has the exact color listed, including the back closure, the rope on the brim if any, the underside of the brim and the brim edge (same color as the top of the brim, never black unless listed); (3) the logos match the drawing; (4) nothing was added.';

async function gemini(env, prompt, b64, b64b) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
  const want = env.GEMINI_MODEL || 'gemini-2.5-flash-image';
  try { return await geminiCall(env, want, prompt, b64, b64b); }
  catch (e) {
    if (want === 'gemini-2.5-flash-image') throw e;
    return geminiCall(env, 'gemini-2.5-flash-image', prompt, b64, b64b);
  }
}
async function geminiCall(env, model, prompt, b64, b64b) {
  const g3 = /gemini-3/.test(model);
  const generationConfig = g3 ? { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: env.GEMINI_SIZE || '1K' } } : { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3' } };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }].concat(b64b ? [{ inline_data: { mime_type: 'image/jpeg', data: b64b } }] : []).concat([{ text: prompt }]) }], generationConfig })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('gemini ' + r.status));
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const ims = parts.filter(p => (p.inline_data || p.inlineData) && !p.thought);
  const im = ims[ims.length - 1];
  if (!im) throw new Error('no image returned');
  const d = im.inline_data || im.inlineData;
  return `data:${d.mime_type || d.mimeType || 'image/png'};base64,${d.data}`;
}

async function openai(env, prompt, b64) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('model', env.OPENAI_MODEL || 'gpt-image-1');
  fd.append('prompt', prompt);
  fd.append('size', '1024x1024');
  fd.append('image', new Blob([bin], { type: 'image/jpeg' }), 'view.jpg');
  const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: fd });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('openai ' + r.status));
  const d = (j.data || [])[0] || {};
  if (d.b64_json) return 'data:image/png;base64,' + d.b64_json;
  if (d.url) return d.url;
  throw new Error('no image returned');
}

async function fal(env, prompt, b64) {
  if (!env.FAL_KEY) throw new Error('FAL_KEY missing');
  const r = await fetch('https://fal.run/' + (env.FAL_MODEL || 'fal-ai/flux-pro/kontext'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Key ' + env.FAL_KEY },
    body: JSON.stringify({ prompt, image_url: 'data:image/jpeg;base64,' + b64, num_images: 1, output_format: 'jpeg' })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.detail && JSON.stringify(j.detail)) || ('fal ' + r.status));
  const u = ((j.images || [])[0] || {}).url;
  if (!u) throw new Error('no image returned');
  return u;
}
