# MCX NG · GFS vs ECMWF Dashboard (Arc Research)

A tiny mobile-first dashboard for iPhone/Netlify. Tap **UPDATE** to pull Arc Research's latest
public Natural Gas Weather report — GFS vs ECMWF demand-weighted CDDs, national and hub-level,
plus model convergence — and compare it against your previously saved update.

This is a source swap from the earlier Celsius/GWDD version of this app: same visual shell,
different underlying metric (CDD, not GWDD) and a richer data set (two models + regional hubs
+ narrative context, instead of one number).

## Deploy on Netlify

1. Put this folder in a GitHub repository.
2. In Netlify, choose **Add new site → Import an existing project**.
3. Select the repository. No build command is required. Publish directory: `.`
4. Deploy.
5. Open the Netlify URL on iPhone and add it to the Home Screen.

The update history is stored locally in the browser with `localStorage` and is not uploaded
anywhere.

## Data source and its quirks

`netlify/functions/arc-weather.mjs` fetches
`https://www.getarcresearch.com/commodities/natural-gas/weather` and parses the **latest**
report block out of that page (the page also lists truncated older reports further down, which
are deliberately excluded from parsing).

Two structural differences from the old Celsius source that this function was built around:

1. **Prose, not a spreadsheet cell.** Arc's reports are written narrative, and phrasing varies
   report to report ("GFS forecasting X CDDs", "the ECMWF's Y", "ECMWF (Z CDDs)" all appear).
   Every numeric field is extracted with a best-effort regex and can independently come back
   `null`. The raw section text (`summary`, `demandImplications`, `caveats`) is always returned
   too, so the UI can still show something useful even when a specific number can't be parsed.
2. **No unique run identifier.** Arc's own cycle label (e.g. `"2026-08-31T00:00Z"`) is not
   unique — the site's archive shows multiple distinct reports published on the same calendar
   day carrying the same label, and all of them share the *same permalink* (the page is edited
   in place rather than versioned). Because of that, history de-duplication is done with a
   `contentHash` computed server-side from the parsed fields, not from the label — this is the
   same class of bug the earlier Celsius version had (see its README), fixed proactively here
   instead of after the fact.

If Arc changes its page structure or wording, the regexes in `arc-weather.mjs` — particularly
`numberNear()` and the hub bullet pattern in `parseHubs()` — are the place to update.

## Before relying on this

This scrapes a public page that doesn't require login to view. It's worth checking Arc
Research's terms of use for automated/scripted access before leaning on this for live trading
decisions, since that can change independently of whether the page itself is publicly viewable.

## Not a signal generator

GFS/ECMWF divergence and convergence are one input among storage data, LNG flows, and USD/INR —
this dashboard does not replace proper stops and sizing.
