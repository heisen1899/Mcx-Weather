// Netlify function: reads Arc Research's public Natural Gas Weather report page
// (GFS vs ECMWF demand-weighted CDD outlook) and returns structured fields.
//
// Source page is prose (LLM-written narrative), not a fixed spreadsheet cell like
// the old Celsius source — so every extraction here is best-effort. Every field
// can independently come back null; the raw section text is always returned too,
// so the frontend can fall back to showing prose when a number can't be parsed.
//
// LESSON CARRIED OVER FROM THE GWDD BUILD: Arc's own "cycle" label (e.g.
// "2026-08-31T00:00Z") is NOT a unique identifier — the site's archive shows
// multiple distinct reports published on the same day carrying the same label,
// and all of them share the SAME permalink (the page is edited in place, not
// versioned). So this function does not build a unique run id from the label.
// Instead it returns a contentHash of the parsed content; the frontend
// dedupes/saves history on that hash, not on the label.

const OVERVIEW_URL = 'https://www.getarcresearch.com/commodities/natural-gas/weather';

async function fetchText(url){
  const bust = url.includes('?') ? `&_=${Date.now()}` : `?_=${Date.now()}`;
  const r = await fetch(url + bust, {
    headers: { 'User-Agent': 'Mozilla/5.0 MCX-NG-Weather-Dashboard/1.0', 'Cache-Control': 'no-cache' }
  });
  if (!r.ok) throw new Error(`Fetch ${r.status}: ${url}`);
  return r.text();
}

// Preserves structural signal that a naive tag-strip would destroy:
//  - headings become "### TEXT ###" markers, so section() can reliably split
//    Executive Summary / Hub-Level Weather / Demand Implications apart
//  - <strong>/<b> become "**", so hub header bullets ("**Midwest (Chicago,
//    35% weight):**") stay regex-matchable
//  - <li> gets a leading "- ", in case hub bullets are rendered as a list
function strip(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(h[1-6])[^>]*>/gi, '\n### ')
    .replace(/<\/(h[1-6])>/gi, ' ###\n')
    .replace(/<(strong|b)[^>]*>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Tiny non-cryptographic hash (djb2) — good enough to detect "this content is
// identical to what we last saved", not for security.
function hash(str){
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// Extracts the number associated with a model label. Report phrasing varies
// ("GFS forecasting 190.0 CDDs", "216.5 (GFS)", "the ECMWF's 175.2"), and
// critically the two forms can BOTH technically match the same sentence — so
// order matters. "NUMBER (LABEL)" is tried first because label-then-number
// search can otherwise walk into a trailing "(GFS)" marker and grab the
// *next* model's number by mistake (verified against real report text).
function numberNear(text, label, window = 90){
  let re = new RegExp(`([0-9]+\\.[0-9]+)\\s*(?:weighted\\s*)?(?:CDDs?)?\\s*\\(\\s*${label}\\s*\\)`, 'i');
  let m = text.match(re);
  if (m) return Number(m[1]);
  re = new RegExp(label + `[^.\\n]{0,${window}}?([0-9]+\\.[0-9]+)(?:\\s*(?:cumulative\\s*)?(?:weighted\\s*)?(?:demand-weighted\\s*)?[CH]DDs?)?`, 'i');
  m = text.match(re);
  if (m) return Number(m[1]);
  return null;
}

function section(text, startHeading, endHeadings){
  const sm = text.match(new RegExp('### ' + startHeading, 'i'));
  if (!sm) return null;
  const from = sm.index + sm[0].length;
  let end = text.length;
  for (const h of endHeadings) {
    const em = text.slice(from).match(new RegExp('### ' + h, 'i'));
    if (em) end = Math.min(end, from + em.index);
  }
  return text.slice(from, end).replace(/^\s*#{1,3}\s*/, '').replace(/#{1,3}\s*$/, '').trim();
}

const KNOWN_HUBS = ['Midwest', 'East', 'South Central', 'South', 'Northeast', 'Mountain', 'Pacific'];

function parseHubs(hubSectionText){
  if (!hubSectionText) return [];
  const hubs = [];

  // Primary: bold-marked header, e.g. "**Midwest (Chicago, 35% weight):**"
  const boldRe = /\*\*([A-Za-z][A-Za-z /]+?)\s*\(([^)]*)\)\s*:?\*\*\s*([\s\S]*?)(?=\n?-?\s*\*\*[A-Za-z]|$)/g;
  let m;
  while ((m = boldRe.exec(hubSectionText))) {
    hubs.push(buildHub(m[1], m[2], m[3]));
  }
  if (hubs.length) return hubs;

  // Fallback: no bold markers survived — anchor on known hub names directly.
  const nameAlt = KNOWN_HUBS.join('|');
  const nameRe = new RegExp(`(${nameAlt})\\s*\\(([^)]*)\\)\\s*:`, 'gi');
  const marks = [];
  let mm;
  while ((mm = nameRe.exec(hubSectionText))) marks.push({ idx: mm.index, len: mm[0].length, name: mm[1], detail: mm[2] });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx + marks[i].len;
    const end = i + 1 < marks.length ? marks[i + 1].idx : hubSectionText.length;
    hubs.push(buildHub(marks[i].name, marks[i].detail, hubSectionText.slice(start, end)));
  }
  return hubs;
}

function buildHub(name, detail, body){
  name = name.trim();
  detail = (detail || '').trim();
  body = (body || '').trim();
  const city = detail.split(',')[0].replace(/`?demand_weight`?.*$/i, '').trim();
  let weightPct = null;
  const wPct = (detail + ' ' + body).match(/([0-9]+(?:\.[0-9]+)?)\s*%\s*weight/i);
  const wFrac = (detail + ' ' + body).match(/demand_weight`?:?\s*([0-9]*\.?[0-9]+)/i);
  if (wPct) weightPct = Number(wPct[1]);
  else if (wFrac) weightPct = Math.round(Number(wFrac[1]) * 1000) / 10;
  return {
    name,
    city: city || null,
    weightPct,
    gfsCdd: numberNear(body, 'GFS'),
    ecmwfCdd: numberNear(body, 'ECMWF'),
    detail: body.length > 280 ? body.slice(0, 280).trim() + '…' : body
  };
}

// Trend deltas ("run-over-run" change). These use SIGNED numbers in the
// source text ("+13.1", "-7.2", "-0.5") whereas national/hub totals are
// almost always unsigned — that sign requirement is the main guard against
// accidentally grabbing a national total instead of a trend delta.
function trendNear(text, label){
  // Preferred: label ... "trend"-ish word ... (SIGNED number [CDD/TDD/wCDD])
  let re = new RegExp(label + `[^()\\n]{0,60}?(?:trend|adding|added|shed|lost|losing|gained|stable)[a-z]*[^()\\n]{0,20}?\\((-?\\+?[0-9]*\\.?[0-9]+)\\s*(?:weighted\\s*)?w?[TC]DDs?\\)`, 'i');
  let m = text.match(re);
  if (m) return Number(String(m[1]).replace('+', ''));
  // Fallback: no parentheses, but an explicit sign right before the CDD/TDD word
  re = new RegExp(label + `[^\\n]{0,60}?([+-][0-9]*\\.?[0-9]+)\\s*(?:weighted\\s*)?w?[TC]DDs?`, 'i');
  m = text.match(re);
  if (m) return Number(m[1]);
  return null;
}

function dateToSlug(dateStr){
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear(), mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default async (req) => {
  try {
    const page = await fetchText(OVERVIEW_URL);
    const text = strip(page);

    // Isolate the "latest report" block only — the page also lists truncated
    // archive snippets further down, which must not bleed into the latest
    // numbers.
    const latestStart = text.search(/Latest report/i);
    const archiveStart = text.search(/Report archive/i);
    const block = latestStart >= 0
      ? text.slice(latestStart, archiveStart > latestStart ? archiveStart : undefined)
      : text;

    const reportDateMatch = block.match(/Latest report\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
    const reportDate = reportDateMatch ? reportDateMatch[1] : null;

    const cycleLabelMatch = block.match(/GFS vs ECMWF Demand-Hub Outlook:\s*([^\n#]+)/i);
    const cycleLabel = cycleLabelMatch ? cycleLabelMatch[1].trim() : null;

    const slug = dateToSlug(reportDate);
    const permalinkMatch = page.match(/href="([^"]*\/weather\/\d{4}-\d{2}-\d{2})"[^>]*>\s*View this report/i);
    let reportUrl = permalinkMatch ? permalinkMatch[1] : (slug ? `${OVERVIEW_URL}/${slug}` : OVERVIEW_URL);
    if (reportUrl.startsWith('/')) reportUrl = 'https://www.getarcresearch.com' + reportUrl;

    const summary = section(block, 'Executive Summary', ['Hub-Level Weather', 'Demand Implications', 'Model Agreement']);
    const hubSection = section(block, 'Hub-Level Weather', ['Demand Implications', 'Model Agreement']);
    const demandSection = section(block, 'Demand Implications[^#]*', ['Model Agreement']);
    const caveatsSection = section(block, 'Model Agreement[^#]*', ['Weather & demand data', 'Report archive']);

    const scanText = summary || block;
    const gfsCdd = numberNear(scanText, 'GFS');
    const ecmwfCdd = numberNear(scanText, 'ECMWF');
    const spread = (gfsCdd != null && ecmwfCdd != null) ? Math.round((gfsCdd - ecmwfCdd) * 100) / 100 : null;
    const avgCdd = (gfsCdd != null && ecmwfCdd != null) ? Math.round(((gfsCdd + ecmwfCdd) / 2) * 100) / 100 : null;

    const convergenceScore = (() => {
      const m = block.match(/convergence score[^0-9]{0,25}([0-9]*\.?[0-9]+)/i);
      return m ? Number(m[1]) : null;
    })();
    const deltaConvergence = (() => {
      const m = block.match(/delta_convergence_score`?:?\s*(-?[0-9]*\.?[0-9]+)/i);
      return m ? Number(m[1]) : null;
    })();

    const gfsTrend = trendNear(scanText, 'GFS');
    const ecmwfTrend = trendNear(scanText, 'ECMWF');

    const hubs = parseHubs(hubSection);

    const parsedForHash = JSON.stringify({ reportDate, cycleLabel, gfsCdd, ecmwfCdd, convergenceScore, hubs, summary, demandSection, caveatsSection });
    const contentHash = hash(parsedForHash);

    if (gfsCdd == null && ecmwfCdd == null && !summary) {
      throw new Error('Could not parse the Arc Research report — page layout may have changed.');
    }

    return new Response(JSON.stringify({
      reportDate,
      cycleLabel,           // display only — NOT unique, do not use for dedup
      reportUrl,
      fetchedAt: new Date().toISOString(),
      contentHash,           // use this for dedup / "is this a genuinely new update"
      national: {
        gfsCdd, ecmwfCdd, spread, avgCdd,
        gfsTrend, ecmwfTrend,
        convergenceScore, deltaConvergence
      },
      hubs,
      summary,
      demandImplications: demandSection,
      caveats: caveatsSection,
      source: 'Arc Research — Natural Gas Weather (GFS vs ECMWF, Open-Meteo data)'
    }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
};
