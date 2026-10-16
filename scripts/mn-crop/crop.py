#!/usr/bin/env python3
"""Cut one section drawing per MN die out of 5x page renders, using PDF text-layer label positions.
usage: crop.py catalog.json rawdir outdir [pages...]"""
import json, sys, os, re, math
import numpy as np, cv2
from PIL import Image

CAT, RAW, OUT = sys.argv[1:4]
ONLY = set(sys.argv[4:])
SC = 5.0
H_PT = 842.0
os.makedirs(OUT, exist_ok=True)
cat = json.load(open(CAT))
hits = json.load(open(os.path.join(RAW, 'hits.json')))

die_series = {}
for s in cat['series']:
    for p in s['profiles']:
        if p['die_no']:
            die_series[p['die_no']] = (s['name'], p['page'])

def safe(d):
    return re.sub(r'[^A-Za-z0-9._-]+', '_', d)

# rect helpers: pt rects in top-down coords [x0, y0, x1, y1] (y0 = top)
def td(r):
    return [r[0], H_PT - r[3], r[2], H_PT - r[1]]
def union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
def gap(a, b):
    dx = max(0, a[0] - b[2], b[0] - a[2]); dy = max(0, a[1] - b[3], b[1] - a[3])
    return dx, dy
def xov(a, b):
    return min(a[2], b[2]) - max(a[0], b[0])
def cx(r): return (r[0] + r[2]) / 2
def cy(r): return (r[1] + r[3]) / 2

# content frame (inside border box below header), pt top-down
FRAME = [46, 123, 549, 803]

manifest = []

def process(pn):
    v = hits[pn]
    img = np.array(Image.open(os.path.join(RAW, 'r%03d.png' % int(pn))).convert('L'))
    Hpx, Wpx = img.shape
    clean = img.copy()
    clean[clean >= 232] = 255          # drop the light grey MNG watermark
    ink = (clean < 200).astype(np.uint8)
    # keep only the content frame
    fm = np.zeros_like(ink)
    fx0, fy0, fx1, fy1 = [int(c * SC) for c in FRAME]
    fm[fy0:fy1, fx0:fx1] = 1
    ink &= fm

    kgs = [td(r) for r in v['kg'] if r[3]-r[1] < 30 and r[2]-r[0] < 90]
    lines = [(l[0], td(l[1:5])) for l in v['lines']]
    def grow(r):
        # extend a hit to the full text line it sits in (e.g. '0.811' before 'KG./M', 'MN-' prefix, '*')
        out = list(r)
        for t, lr in lines:
            if lr[2] - lr[0] < 160 and (lr[3]-lr[1]) < 1.6 * (r[3]-r[1]) and lr[0] > r[0] - 60 and lr[2] < r[2] + 60 and xov(lr, r) > 0 and abs(cy(lr) - cy(r)) < (r[3]-r[1]) * 0.5:
                out = union(out, lr)
        return [out[0]-2, out[1], out[2]+2, out[3]]
    # footnotes ('*สิทธิบัตร...') are not part of any drawing
    for t, lr in lines:
        if t.strip().startswith('*') or re.search('[\u0e00-\u0e7f]', t):
            x0, y0, x1, y1 = [int(round(c * SC)) for c in (lr[0]-2, lr[1]-2, lr[2]+2, lr[3]+2)]
            ink[max(0,y0):y1, max(0,x0):x1] = 0
    used_kg = set(); used_hdr = set()
    dienos = [td(r) for r in v['dieno']]

    def chained(h, r):
        # rows between header and die must be contiguous (no blank gap) -> die really is in this table
        ys = sorted((lr[1], lr[3]) for t, lr in lines if xov(lr, h) > 3 and lr[1] >= h[3] - 2 and lr[3] <= r[1] + 2 and (lr[3]-lr[1]) < 30)
        prev = h[3]
        for y0, y1 in ys + [(r[1], r[3])]:
            if y0 - prev > 30:
                return False
            prev = max(prev, y1)
        return True
    # ---- choose the primary hit for every die
    anchors = []   # dict(kind, rect(block), dies, masks)
    die_anchor = {}
    notes = {}
    table_of = {}
    tables = {}
    for d, hs in v['dies'].items():
        hs = [td(r) for r in hs]
        hs = [r for r in hs if (r[3]-r[1]) < 30 and (r[2]-r[0]) < 12 * len(d) + 20 and (r[2]-r[0]) > (r[3]-r[1])] or []
        if not hs:
            # printed without the series letter (e.g. 'MN-7216' for U7216): fall back to the text line
            alt = [lr for t, lr in lines if re.search(r'(^|[^0-9A-Za-z])' + re.escape(d[1:]) + r'($|[^0-9A-Za-z])', t) and (lr[3]-lr[1]) < 30 and (lr[2]-lr[0]) < 160]
            if alt:
                hs = alt
                notes[d] = 'label printed as "%s" (no series letter)' % d[1:]
        if not hs:
            notes[d] = 'die label not found (or unusable bounds) in PDF text layer on this page'
            continue
        best = None
        for r in hs:
            hgt = r[3] - r[1]
            # in a table? header above, x-overlapping, within 220pt
            hdr = [h for h in dienos if xov(h, r) > 5 and 0 < r[1] - h[3] < 220 and chained(h, r)]
            if hdr:
                hh = max(hdr, key=lambda h: h[1])
                sc = 1000 + hgt
                cand = ('table', r, hh)
            else:
                kb = [k for k in kgs if xov(union(k, [k[0]-30, k[1], k[2]+30, k[3]]), r) > 0 and 0 <= k[1] - r[3] < 2.0 * hgt + 4]
                sc = hgt + (100 if kb else 0)
                cand = ('label', r, kb[0] if kb else None)
            if best is None or sc > best[0]:
                best = (sc, cand)
        kind, r, extra = best[1]
        if len(hs) > 1:
            notes[d] = 'label occurs %d times on page (callouts); used the main one' % len(hs)
        if kind == 'table':
            key = tuple(round(c, 1) for c in extra)
            tables.setdefault(key, {'hdr': extra, 'rows': []})['rows'].append((d, r))
            table_of[d] = key
        else:
            if extra is not None: used_kg.add(tuple(extra))
            blk = grow(r) if extra is None else union(grow(r), grow(extra))
            anchors.append({'kind': 'label', 'rect': blk, 'dies': [d]})
    for key, t in tables.items():
        hdr = t['hdr']; used_hdr.add(tuple(hdr))
        rows = [r for _, r in t['rows']]
        bottom = max(r[3] for r in rows)
        # table spans header row: find right-most header text on same baseline (KG./M)
        kh = [k for k in kgs if abs(cy(k) - cy(hdr)) < 4 and k[0] > hdr[0]]
        x1 = (max(k[2] for k in kh) + 40) if kh else hdr[2] + 190
        trect = [hdr[0] - 40, hdr[1] - 12, x1, bottom + 12]
        anchors.append({'kind': 'table', 'rect': trect, 'dies': [d for d, _ in t['rows']]})

    # dummy anchors for labels/tables of dies that belong to other pages: they absorb their own drawings
    for k in kgs:
        if tuple(k) in used_kg or any(abs(cy(k) - cy(h)) < 4 and 0 < k[0] - h[0] < 300 for h in dienos):
            continue
        hgt = k[3] - k[1]
        g = grow(k)
        lab_above = [lr for t, lr in lines if lr[2]-lr[0] < 160 and xov(lr, g) > 0 and 0 <= g[1] - lr[3] < 1.6 * hgt]
        blk = g
        for lr in lab_above: blk = union(blk, lr)
        anchors.append({'kind': 'other', 'rect': blk, 'dies': []})
    for h in dienos:
        if tuple(h) in used_hdr: continue
        anchors.append({'kind': 'othertable', 'rect': [h[0]-45, h[1]-14, h[0]+300, h[3]+60], 'dies': []})
    # ---- remove label/table blocks from the ink before segmentation
    for a in anchors:
        r = a['rect']
        pad = 1.5
        x0, y0, x1, y1 = [int(round(c * SC)) for c in (r[0]-pad, r[1]-pad, r[2]+pad, r[3]+pad)]
        ink[max(0,y0):y1, max(0,x0):x1] = 0

    # ---- table frames are not drawing ink
    for a in anchors:
        if a['kind'] in ('table', 'othertable'):
            t = a['rect']
            x0, y0, x1, y1 = [int(round(c * SC)) for c in (t[0]-3, t[1]-3, t[2]+3, t[3]+3)]
            ink[max(0,y0):y1, max(0,x0):x1] = 0
    # ---- footnote line ('*สิทธิบัตร...') along the frame bottom: text run starting at the left frame edge
    fb0, fb1 = int(778 * SC), int(803 * SC)
    band = ink[fb0:fb1, :].copy()
    bn, bl, bst, _ = cv2.connectedComponentsWithStats(cv2.dilate(band, np.ones((3, int(4 * SC)), np.uint8)), connectivity=8)
    for i in range(1, bn):
        x, y, w, h, _a = bst[i]
        if x < 66 * SC and h < 14 * SC and y > 1 and w > 40 * SC:
            sub = ink[fb0:fb1, :]
            sub[bl == i] = 0
    # ---- seeds = thick strokes (the profile walls), dims/text are thin
    ko = int(1.3 * SC)
    thick = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((ko, ko), np.uint8))
    sd = cv2.dilate(thick, np.ones((int(2*SC)+1, int(2*SC)+1), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(sd, connectivity=8)
    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        inkpx = int(thick[y:y+h, x:x+w][lab[y:y+h, x:x+w] == i].sum())
        if inkpx < 600:
            continue
        yy, xx = np.nonzero((lab[y:y+h, x:x+w] == i) & (thick[y:y+h, x:x+w] > 0))
        step = max(1, len(yy) // 4000)
        pts = np.stack([(xx[::step] + x) / SC, (yy[::step] + y) / SC], 1)
        comps.append({'id': i, 'rect': [x / SC, y / SC, (x + w) / SC, (y + h) / SC], 'ink': inkpx, 'pts': pts})
    if not comps:   # no thick strokes: fall back to dilated-ink components
        k = int(2.6 * SC)
        dil = cv2.dilate(ink, np.ones((2*k+1, 2*k+1), np.uint8))
        n, lab, stats, _ = cv2.connectedComponentsWithStats(dil, connectivity=8)
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            comps.append({'id': i, 'rect': [x / SC, y / SC, (x + w) / SC, (y + h) / SC], 'ink': int(area)})

    if not anchors:
        return notes, []
    big = max([c['ink'] for c in comps] + [1])

    def cost(c, a):
        cr, ar = c['rect'], a['rect']
        if 'pts' in c:
            p = c['pts']
            ddx = np.maximum(0, np.maximum(ar[0] - p[:, 0], p[:, 0] - ar[2]))
            ddy = np.maximum(0, np.maximum(ar[1] - p[:, 1], p[:, 1] - ar[3]))
            d = float(np.sqrt(ddx**2 + ddy**2).min())
        else:
            dx, dy = gap(cr, ar)
            d = math.hypot(dx, dy)
        # labels/tables sit below or to the right of their drawing; anchor above the comp is unlikely
        if cy(ar) < cr[1] - 2:
            d = d * 2 + 25
        if a['kind'] in ('table', 'othertable') and xov(cr, ar) <= 0:
            d += 40
        if a['kind'] in ('label', 'other'):
            # labels are centred under / beside their drawing
            if cy(ar) > cr[3]:
                d += 0.25 * abs(cx(ar) - cx(cr))
        return d

    assign = {}
    ambiguous = {}
    order = sorted(comps, key=lambda c: -c['ink'])
    for c in order:
        cs = sorted(((cost(c, a), j) for j, a in enumerate(anchors)), key=lambda t: t[0])
        assign[c['id']] = cs[0][1]
        if len(cs) > 1 and c['ink'] > 0.15 * big and cs[1][0] < cs[0][0] * 1.25 + 4:
            ambiguous[c['id']] = (cs[0][1], cs[1][1])
    # ---- every ink pixel goes to the anchor of its nearest seed (dims, numbers, ghost lines follow their profile)
    seedmask = np.zeros_like(ink)
    lut = np.full(n + 1, -1, np.int32)
    for c in comps:
        lut[c['id']] = assign[c['id']]
    seedmask[(lab > 0) & (lut[lab] >= 0)] = 1
    seedmask &= cv2.dilate(ink, np.ones((3, 3), np.uint8)) | thick
    src = np.where(seedmask > 0, 0, 255).astype(np.uint8)
    dist, vlab = cv2.distanceTransformWithLabels(src, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_CCOMP)
    # map voronoi label -> anchor via the seed pixels
    vl_anchor = np.full(int(vlab.max()) + 1, -1, np.int32)
    ys, xs = np.nonzero(seedmask)
    vl_anchor[vlab[ys, xs]] = lut[lab[ys, xs]]
    inkd = cv2.dilate(ink, np.ones((3, 3), np.uint8))
    owner = np.where((inkd > 0) & (dist < 60 * SC), vl_anchor[vlab], -1)
    # keep only pixel clusters chained (within ~2.5pt) to one of the anchor's own seeds
    kc = int(2.5 * SC)
    ker = np.ones((2*kc+1, 2*kc+1), np.uint8)
    for j in range(len(anchors)):
        m = (owner == j).astype(np.uint8)
        if not m.any():
            continue
        cn, cl = cv2.connectedComponents(cv2.dilate(m, ker), connectivity=8)
        good = np.unique(cl[(seedmask > 0) & (m > 0)])
        okl = np.zeros(cn, bool); okl[good] = True; okl[0] = False
        owner[(m > 0) & ~okl[cl]] = -1
    if os.environ.get('DBG'):
        for j,a in enumerate(anchors): print('A',j,a['kind'],a['dies'],[round(x) for x in a['rect']])
        for c in order[:15]: print('C',[round(x) for x in c['rect']],c['ink'],sorted(((round(cost(c,a)),j) for j,a in enumerate(anchors)))[:3])
    results = []
    for j, a in enumerate(anchors):
        if not a['dies']:
            continue
        mine = [c for c in comps if assign[c['id']] == j]
        conf = 'ok'; note = []
        oy, ox = np.nonzero(owner == j)
        if not mine or len(oy) == 0:
            conf = 'check'; note.append('no drawing ink assigned')
            box = list(a['rect'])
        else:
            box = [ox.min() / SC, oy.min() / SC, (ox.max() + 1) / SC, (oy.max() + 1) / SC]
            if a['kind'] == 'label':
                box = union(box, a['rect'])
        if any(ambiguous.get(c['id'], (None, None))[0] == j or ambiguous.get(c['id'], (None, None))[1] == j for c in comps if c['id'] in ambiguous):
            conf = 'check'; note.append('a drawing piece was nearly equidistant to two labels')
        bw, bh = box[2]-box[0], box[3]-box[1]
        if bw * bh > 0.45 * (FRAME[2]-FRAME[0]) * (FRAME[3]-FRAME[1]) and len(anchors) > 1:
            conf = 'check'; note.append('crop is very large')
        pad = 4
        x0, y0, x1, y1 = [int(round(c * SC)) for c in (box[0]-pad, box[1]-pad, box[2]+pad, box[3]+pad)]
        x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(Wpx, x1), min(Hpx, y1)
        keep = owner[y0:y1, x0:x1] == j
        if a['kind'] == 'label':
            r = a['rect']
            lx0, ly0, lx1, ly1 = [int(round(cc * SC)) for cc in (r[0]-2, r[1]-2, r[2]+2, r[3]+2)]
            keep[max(0,ly0-y0):max(0,ly1-y0), max(0,lx0-x0):max(0,lx1-x0)] = True
        crop = clean[y0:y1, x0:x1].copy()
        crop[~keep] = 255
        # trim
        ys, xs = np.where(crop < 200)
        if len(ys):
            m = 12
            crop = crop[max(0, ys.min()-m):ys.max()+m+1, max(0, xs.min()-m):xs.max()+m+1]
        im = Image.fromarray(crop)
        L = 600
        s = L / max(im.size)
        if s < 1:
            im = im.resize((max(1, round(im.size[0]*s)), max(1, round(im.size[1]*s))), Image.LANCZOS)
        for d in a['dies']:
            fn = safe(d) + '.png'
            out_im = im
            if a['kind'] == 'table':
                from PIL import ImageDraw, ImageFont
                try: font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 34)
                except Exception: font = ImageFont.load_default()
                W2 = max(im.size[0], 260)
                out_im = Image.new('L', (W2, im.size[1] + 60), 255)
                out_im.paste(im, ((W2 - im.size[0]) // 2, 0))
                dr = ImageDraw.Draw(out_im)
                tw = dr.textlength(d, font=font)
                dr.text(((W2 - tw) / 2, im.size[1] + 12), d, fill=0, font=font)
            out_im.save(os.path.join(OUT, fn), optimize=True)
            nn = list(note)
            if d in notes: nn.append(notes[d])
            if a['kind'] == 'table' and len(a['dies']) > 1:
                nn.append('drawing shared by %d dies in the same table (%s)' % (len(a['dies']), ', '.join(a['dies'])))
            results.append({'die': d, 'page': int(pn), 'file': fn,
                            'bbox_pt': [round(box[0], 1), round(H_PT - box[3], 1), round(box[2], 1), round(H_PT - box[1], 1)],
                            'method': 'pdf-text-anchor+ink-segmentation/' + a['kind'], 'confidence': conf, 'note': '; '.join(nn)})
    # full page fallback
    pim = Image.fromarray(clean)
    s = 1600 / max(pim.size)
    pim.resize((round(pim.size[0]*s), round(pim.size[1]*s)), Image.LANCZOS).save(os.path.join(OUT, 'page-%03d.png' % int(pn)), optimize=True)
    return notes, results

allres = []
for pn in sorted(hits, key=int):
    if ONLY and pn not in ONLY:
        continue
    notes, res = process(pn)
    allres += res
    done = {r['die'] for r in res}
    for d in hits[pn]['dies']:
        if d not in done:
            allres.append({'die': d, 'page': int(pn), 'file': None, 'bbox_pt': None, 'method': 'failed', 'confidence': 'check', 'note': notes.get(d, 'not cropped') + '; see page-%03d.png' % int(pn)})
for r in allres:
    r['series'] = die_series.get(r['die'], ('?', 0))[0]
json.dump(allres, open(os.path.join(OUT, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
from collections import Counter
print(Counter(r['confidence'] for r in allres), Counter(r['method'] for r in allres))
