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
import { accounts, adminFrom } from './accounts.js';
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
    const desc = String(body.prompt || '').slice(0, 7000);

    // daily limit per visitor (IP + email)
    const limit = +(env.CLIENT_LIMIT || 12) * 4; // counted in photos: 12 designs x 4 views
    const day0 = new Date().toISOString().slice(0, 10), ip = req.headers.get('cf-connecting-ip') || 'x', em = String(body.email || '').toLowerCase().slice(0, 80);
    const dk = String(body.design || '').slice(0, 64);
    const admin = await adminFrom(req, env);
    if (env.DB && !admin) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_usage (k TEXT PRIMARY KEY, n INTEGER)').run();
      const get = async k => ((await env.DB.prepare('SELECT n FROM ai_usage WHERE k=?').bind(k).first()) || {}).n || 0;
      const bump = k => env.DB.prepare('INSERT INTO ai_usage (k,n) VALUES (?,1) ON CONFLICT(k) DO UPDATE SET n=n+1').bind(k).run();
      const who = em || ('ip:' + ip);
      if (dk && await get('dk:' + who + ':' + dk) >= 2) return J({ error: 'same_design', message: 'Photos for this design were already created' }, 429, cors);
      if (await get('cl:' + who) >= limit) return J({ error: 'limit', message: 'Client limit reached' }, 429, cors);
      if (await get('ip:' + day0 + ':' + ip) >= limit * 3) return J({ error: 'limit', message: 'Too many today' }, 429, cors);
      for (let i = 0; i < views.length; i++) { await bump('cl:' + who); await bump('ip:' + day0 + ':' + ip); } if (dk) await bump('dk:' + who + ':' + dk);
    } else if (env.RL && !admin) {
      const day = new Date().toISOString().slice(0, 10);
      const who = (req.headers.get('cf-connecting-ip') || 'x') + '|' + String(body.email || '').toLowerCase().slice(0, 80);
      const key = 'rl:' + day + ':' + who, n = +(await env.RL.get(key) || 0);
      if (n >= limit) return J({ error: 'limit', message: 'Daily limit reached' }, 429, cors);
      await env.RL.put(key, String(n + views.length), { expirationTtl: 90000 });
    }

    const provider = (env.PROVIDER || 'gemini').toLowerCase();
    const run = v => {
      const b64b = v.jpg2 ? String(v.jpg2).replace(/^data:image\/\w+;base64,/, '') : null;
      let p = `${BASE}\n${String(v.note || ('View: ' + v.name)).slice(0, 1800)}\n${noPrint(desc)}\n${matLook(desc)}\n\nSPECIFICATION:\n${desc}\n\n${CHECK}`;
      const b64 = v.jpg.replace(/^data:image\/\w+;base64,/, '');
      const lg = logosOf(v);
      if (lg.length) p += `\n\nLOGO ARTWORK: the last ${lg.length} attached image${lg.length > 1 ? 's are' : ' is'} the client's real logo file${lg.length > 1 ? 's' : ''} (shown on a plain gray card only so you can see it; the gray card is not part of the cap). The logo on the cap must be EXACTLY this artwork: the same letters, shapes, proportions and colors. Never redraw it as other letters or a different symbol. Use the drawing only for its position and size.`;
      if (provider === 'openai') return openai(env, p, b64);
      if (provider === 'fal') return fal(env, p, b64);
      return gemini(env, p, b64, b64b, lg);
    };
    // generate -> automatic visual check against the drawing and the spec -> one corrected retry if it fails
    const runChecked = async v => {
      const tries = Math.max(1, Math.min(3, +(env.AI_TRIES || 2)));
      let best = null, fix = '';
      for (let t = 0; t < tries; t++) {
        const v2 = fix ? Object.assign({}, v, { note: 'A PREVIOUS ATTEMPT WAS REJECTED. FIX THESE MISTAKES: ' + fix + '\n' + (v.note || '') }) : v;
        const img = await run(v2);
        if (provider !== 'gemini' || env.AI_VERIFY === 'off') return { img, checked: false, verr: 'off' };
        let res; try { res = await verify(env, v, desc, img); } catch (e) { return { img, checked: false, verr: String(e && e.message || e).slice(0, 160) } }
        if (res.pass) return { img, checked: true, tries: t + 1 };
        if (!best || res.problems.length < best.n) best = { img, n: res.problems.length, problems: res.problems };
        fix = res.problems.join(' ').slice(0, 900);
      }
      return { img: best.img, checked: true, pass: false, problems: best.problems.slice(0, 6), tries };
    };
    const out = await Promise.all(views.map(v => runChecked(v).then(r => Object.assign({ name: v.name }, r), e => ({ name: v.name, error: String(e && e.message || e).slice(0, 300) }))));
    return J({ images: out, provider, ver: 'v3-check' }, 200, cors);
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
  [/rope/i, 'Rope on the brim: a real braided cord with visible twisted strands, lying only on the top of the brim along the seam where the brim meets the crown, from one end of the brim to the other. It never continues around the sides or the back of the cap, and it is not visible in a back view.'],
  [/leather/i, 'Leather strap: real leather grain with stitched edges and a metal buckle or press with true metallic reflections.']
];
function noPrint(desc) {
  const s = String(desc || '');
  const pat = /patterned print|camo|sublimat/i.test(s);
  return 'PRINTS AND GRAPHICS: ' + (pat ? 'Only the parts marked as patterned print or camo carry a pattern, copied from the drawing; every other part is a plain solid color. ' : 'Every part of this cap is a plain SOLID dyed color: absolutely no prints, no all-over patterns, no florals, no camo, no sublimation, no graphics on the crown, side panels or brim. ') +
    'The only artwork allowed is the logos shown in the drawing for this exact view, in their exact place. Do not copy a logo from another view, do not repeat it, and do not add any decoration.';
}
function matLook(desc) { const s = String(desc || ''); const out = MATS.filter(m => m[0].test(s)).map(m => m[1]); return out.length ? 'MATERIAL LOOK: ' + out.join(' ') : ''; }

const BASE = 'Turn this flat technical drawing of a cap into a real photograph of the finished, physical cap, as if it had been manufactured and then shot for a premium e-commerce catalog. ' +
  'Picture it: the cap sits on a light warm-gray seamless paper backdrop in a photo studio. A large softbox above and to the left wraps it in soft, even light, and a gentle contact shadow falls beneath the brim and the crown. It is shot on a full-frame DSLR with a 100mm macro lens at f/8, tack sharp, true-to-life color, natural contrast, with the subtle imperfections of a real object. ' +
  'You can see the real material up close: the weave of the fabric, tiny fibers catching the light, rows of tight thread stitching along every seam and around the brim, sewn eyelets, a fabric-covered top button, gentle natural creases where the panels meet the brim, and soft shading that shows the curved volume of the crown. ' +
  'Logos are physically made with EXACTLY the decoration technique named in DECORATIONS below (for example chain stitch, flat embroidery, 3D puff, chenille, a leather or woven patch, or a screen print). Never swap the technique: flat or chain stitch must not become puff, and a print must not become embroidery. Show the real texture of that technique up close. The shading or depth effect on the logos in the drawing is only a preview effect; the technique text decides how the logo is made. ' +
  'Do not retouch, recolor or trace the drawing: build the cap again as a real three-dimensional object and photograph it, with real volume, perspective, curved surfaces, soft shadows in the folds and seams, and real fabric. Even in a straight front view the crown must look rounded and the brim must show its thickness. ' +
  'The result must be indistinguishable from a real photo. It must not look like a drawing, an illustration, a vector graphic, a cartoon, clip art or a 3D render: no outlines, no flat color fills, no cel shading. ' +
  'The drawing is the blueprint and must be followed exactly: the same silhouette, crown height, panel layout and seams, brim shape and curve, closure, and the same camera angle and framing. ' +
  'The thin dark lines in the drawing are only outlines, not black parts: never turn them into black piping, trim or a black brim edge. The edge of the brim is the same color as the top of the brim unless an edge binding color is listed. Seam thread matches the fabric color. ' +
  'Use the hex colors listed below as the true dyed fabric colors under neutral daylight; the drawing shows where each color goes. ' +
  'Logos and text keep the same artwork, letters, colors, size and position as in the drawing. Never invent, add, remove, translate or restyle any logo or text. ' +
  'No people, no mannequin head, no props, no watermark, no extra text, no frame or border.';
const CHECK = 'Before finishing, check: (1) it looks like a real camera photo, not a drawing; (2) every part has the exact color listed, including the back closure, the rope on the brim if any, the underside of the brim and the brim edge (same color as the top of the brim, never black unless listed); (3) the logos match the drawing for this view, each made with the exact technique listed in DECORATIONS (never swapped for another technique), and nothing else is printed on the fabric; (4) the number of panels and the seams match the PANEL LAYOUT exactly (a 5-panel cap has ONE seamless front panel with no center seam; a 6-panel cap has a center front seam); (5) nothing was added.';

const VIEWNAME = { front: 'a straight FRONT view', side: 'a SIDE PROFILE view (camera at 90 degrees to the front, brim seen from the side)', back: 'a straight BACK view showing the closure', q34: 'a THREE-QUARTER view turned toward the side (side panel is the main subject; no front logo is expected here, so ignore the logo in the front drawing; any invented or different logo on the front is a mistake)' };
async function verify(env, v, desc, img) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(img || '');
  if (!m) return { pass: true, problems: [] };
  const ref = v.jpg.replace(/^data:image\/\w+;base64,/, ''), ref2 = v.jpg2 ? String(v.jpg2).replace(/^data:image\/\w+;base64,/, '') : null;
  const lg = logosOf(v);
  const q = 'You are a strict quality inspector for a cap factory. The LAST image is an AI photo that must show exactly the cap in the technical drawing' + (ref2 ? 's (first image = front drawing, second = side drawing)' : ' (first image)') + ', seen as ' + (VIEWNAME[v.name] || v.name) + '. ' + (lg.length ? 'The ' + lg.length + ' image' + (lg.length > 1 ? 's' : '') + ' just before the photo ' + (lg.length > 1 ? 'are' : 'is') + ' the client\'s real logo artwork on a gray card: the logo in the photo must be this exact artwork (same letters and shapes); different letters or a different symbol is a serious mistake. ' : '') +
    'Compare the photo with the drawing and this specification and list every real mistake. Check: ' +
    '(a) PANEL LAYOUT and seams exactly as specified (for a 5-panel cap any vertical seam running up the middle of the front, or extra seams on the front panel, is a mistake); ' +
    '(b) the camera angle is ' + (VIEWNAME[v.name] || v.name) + ' as in the drawing; ' +
    '(c) logos: only the logos listed for this view, in the same place and size as the drawing, same letters and colors, made with the listed technique; a front logo that moved onto a side panel is a mistake; ' +
    '(d) colors of each part, including the top and underside of the brim, the brim edge (top-of-brim color), the button and the closure; ' +
    '(e) the rope, if any, lies only on the top of the brim at the front and never continues around the sides or the back of the cap; ' +
    '(f) closure type and color match; (g) no added prints, text, patterns or decorations; (h) it looks like a real camera photo: if it still looks like the flat drawing (flat front-on look, drawn outlines, painted or striped fill, uniform flat lighting, no real depth or volume) that is a mistake. ' +
    'Ignore lighting, background, small shading differences and fabric texture details. ' +
    'Answer only JSON: {"pass": true|false, "problems": ["short fix instruction", ...]}. pass is true only if there are no real mistakes.\n\nVIEW NOTE: ' + String(v.note || '').slice(0, 1200) + '\n\nSPECIFICATION:\n' + desc;
  const parts = [{ inline_data: { mime_type: 'image/jpeg', data: ref } }].concat(ref2 ? [{ inline_data: { mime_type: 'image/jpeg', data: ref2 } }] : []).concat(lg.map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d } }))).concat([{ inline_data: { mime_type: m[1], data: m[2] } }, { text: q }]);
  const models = [...new Set([env.VERIFY_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'].filter(Boolean))];
  let o = null, errs = [];
  for (const model of models) {
    try {
      const gc = { temperature: 0, responseMimeType: 'application/json' };
      if (/2\.5/.test(model)) gc.thinkingConfig = { thinkingBudget: 512 };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: gc })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(model + ': ' + ((j.error && j.error.message) || r.status));
      const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
      const mm = txt.match(/\{[\s\S]*\}/);
      if (!mm) throw new Error(model + ': no json (' + String(((j.candidates || [])[0] || {}).finishReason || txt.slice(0, 60)) + ')');
      o = JSON.parse(mm[0]); break;
    } catch (e) { errs.push(String(e && e.message || e).slice(0, 120)); }
  }
  if (!o) throw new Error(errs.join(' | '));
  const problems = Array.isArray(o.problems) ? o.problems.map(x => String(x).slice(0, 200)).filter(Boolean) : [];
  return o.pass ? { pass: true, problems: [] } : { pass: false, problems: problems.length ? problems : ['does not match the drawing'] };
}

function logosOf(v) {
  return (Array.isArray(v.logos) ? v.logos : []).slice(0, 2).map(x => String(x || '').replace(/^data:image\/\w+;base64,/, '')).filter(x => x && x.length < 1500000);
}
async function gemini(env, prompt, b64, b64b, lg) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
  const want = env.GEMINI_MODEL || 'gemini-2.5-flash-image';
  try { return await geminiCall(env, want, prompt, b64, b64b, lg); }
  catch (e) {
    if (want === 'gemini-2.5-flash-image') throw e;
    return geminiCall(env, 'gemini-2.5-flash-image', prompt, b64, b64b, lg);
  }
}
async function geminiCall(env, model, prompt, b64, b64b, lg) {
  const g3 = /gemini-3/.test(model);
  const generationConfig = g3 ? { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: env.GEMINI_SIZE || '1K' } } : { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3' } };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }].concat(b64b ? [{ inline_data: { mime_type: 'image/jpeg', data: b64b } }] : []).concat((lg || []).map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d } }))).concat([{ text: prompt }]) }], generationConfig })
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
