import json, html, os, re
out = 'mnimg'
m = json.load(open(out + '/manifest.json'))
# visually reviewed: auto-flag was a false alarm, crop shows the right section
VERIFIED = {'SF20-004','SF20-006','U4203','U4204','U4205','M3116','M3118','M3212','U6867','U6937','U6357','U6786',
            'M6754','U4173B','U4432A','U5309B','M42074','U3814','U4107','U1595','U1749','U1856','U4293','U4294','U4298',
            'M92896','M9387','U6258A'}
FORCE_CHECK = {
 'LS20005': 'page has blue hand-drawn pen marks over this drawing; they are in the crop',
 'LS20006': 'page has blue hand-drawn pen marks over this drawing; they are in the crop',
 'M30220': 'crop also contains a large assembly drawing below the M30220 section',
 'M30219': 'crop OK but an extra MN-M30219 callout tag sits under the label',
 'U5779': 'crop includes neighbouring assembly callouts on the right',
}
for r in m:
    if r['die'] in VERIFIED and r['confidence'] == 'check':
        r['confidence'] = 'ok'; r['note'] = ('visually verified; ' + r['note']).strip('; ')
    if r['die'] in FORCE_CHECK:
        r['confidence'] = 'check'; r['note'] = (FORCE_CHECK[r['die']] + '; ' + r['note']).strip('; ')
    r['method'] = r['method'].replace('pdf-text-anchor+ink-segmentation/label', 'pdf-text-anchor+ink-segmentation (label under/beside drawing)').replace('pdf-text-anchor+ink-segmentation/table', 'pdf-text-anchor+ink-segmentation (DIE NO. table under drawing; caption added)')
m.sort(key=lambda r: (r['page'], r['die']))
keys = ['die','page','file','bbox_pt','method','confidence','note','series']
m = [{k: r.get(k) for k in keys} for r in m]
json.dump(m, open(out + '/manifest.json', 'w'), ensure_ascii=False, indent=1)
renamed = {r['die']: r['file'] for r in m if r['file'] and r['file'] != r['die'] + '.png'}
json.dump(renamed, open(out + '/filename-map.json', 'w'), indent=1)
from collections import Counter
print(Counter(r['confidence'] for r in m), 'renamed', len(renamed))
# contact sheet
groups = {}
for r in m:
    groups.setdefault(r['series'], {}).setdefault(r['page'], []).append(r)
nchk = sum(r['confidence'] != 'ok' for r in m)
h = ['<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
     '<title>MN Die Sections</title><style>',
     ':root{--bg:#f6f6f4;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#ddd;--warn:#c2410c;--warnbg:#fff4ec}',
     '@media (prefers-color-scheme:dark){:root{--bg:#1b1b1a;--card:#262624;--ink:#eee;--mute:#a3a39e;--line:#3a3a37;--warnbg:#3a2418}}',
     'body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;padding:16px}',
     'h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 6px;border-bottom:1px solid var(--line);padding-bottom:4px}',
     'h3{font-size:12px;color:var(--mute);margin:10px 0 6px;font-weight:600}h3 a{color:var(--mute)}',
     '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}',
     '.c{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px;text-align:center}',
     '.c img{width:100%;height:130px;object-fit:contain;background:#fff;border-radius:3px}',
     '.d{font-weight:600;margin-top:4px}.n{font-size:11px;color:var(--mute)}',
     '.chk{border:2px solid var(--warn);background:var(--warnbg)}.chk .d{color:var(--warn)}',
     'label{user-select:none;cursor:pointer}</style></head><body>',
     '<h1>MN die section drawings</h1>',
     '<p class="n">%d dies cropped from the MN Aluminium Profile 2021 catalogue (PDF pages). %d flagged <b style="color:var(--warn)">CHECK</b> (orange). Page links open the full page render. <label><input type="checkbox" id="only"> show only CHECK</label></p>' % (len(m), nchk)]
for s, pages in groups.items():
    h.append('<h2>%s</h2>' % html.escape(s))
    for p, rs in sorted(pages.items()):
        h.append('<h3>PDF page %d (catalogue p.%d) &middot; <a href="page-%03d.png" target="_blank">full page</a></h3><div class="grid">' % (p, p - 5, p))
        for r in rs:
            chk = r['confidence'] != 'ok'
            img = ('<a href="%s" target="_blank"><img loading="lazy" src="%s" alt="%s"></a>' % (r['file'], r['file'], html.escape(r['die']))) if r['file'] else '<div class="n">no crop</div>'
            note = ('<div class="n">%s</div>' % html.escape(r['note'])) if chk else ''
            h.append('<div class="c%s">%s<div class="d">%s%s</div>%s</div>' % (' chk' if chk else '', img, html.escape(r['die']), ' &middot; CHECK' if chk else '', note))
        h.append('</div>')
h.append('<script>document.getElementById("only").addEventListener("change",e=>{document.querySelectorAll(".c").forEach(c=>{c.style.display=(e.target.checked&&!c.classList.contains("chk"))?"none":""});document.querySelectorAll(".grid").forEach(g=>{const v=[...g.children].some(c=>c.style.display!=="none");g.style.display=v?"":"none";g.previousElementSibling.style.display=v?"":"none"})});</script></body></html>')
open(out + '/contact.html', 'w').write('\n'.join(h))
