# Generates the Muangthong Vol.3 import (supabase/datafix/2026-11-04-import-muangthong.sql) and stamped pictures.
import json, uuid, os
from PIL import Image, ImageDraw, ImageFont
ROOT='/Users/plfx/code/FacadeXPM/facadex-app'
X=ROOT+'/DOC/ALUMNIUM CATALOG/_extracted/muangthong-sections'
OUT=os.path.dirname(os.path.abspath(__file__))
T='1b9affc4-2136-4ed1-b168-a36e6624e743'
d=json.load(open(ROOT+'/docs/catalogs/muangthong/muangthong-vol3.json'))
man={m['die']:m for m in json.load(open(X+'/manifest.json')) if m.get('file')}
ns=uuid.UUID('6f1c2a90-0000-4000-8000-0000004d5401')
uid=lambda *k: str(uuid.uuid5(ns,'|'.join(map(str,k))))
SL2=['บานเลื่อนสวน 2 บาน','บานเลื่อน 2 ตาย 2']; DOOR=['บานเลื่อน','บานเลื่อนรางล่าง']
# index -> (family, Thai series name, types)
S={0:('STANDARD','กล่องหน้าร้าน 3"x1.5" - 6" (GROUP 01)',['บานติดตาย']),
 1:('ประตูบานสวิง / บานเปิด','ประตูสวิง เสากลม 54x46 (GROUP 01)',['บานสวิง','บานสวิงเดี่ยว','บานสวิงคู่']),
 2:('ประตูบานสวิง / บานเปิด','ประตูสวิงใหญ่ 76.2 / 101.6 / 150',['บานสวิง','บานสวิงเดี่ยว','บานสวิงคู่']),
 3:('ประตูบานสวิง / บานเปิด','ประตูบานเปิด วงกบ 3097 / 3174',['บานเปิด']),
 4:('ประตูบานสวิง / บานเปิด','ประตูกระจกเปลือย (รางหนีบ)',['บานสวิงเปลือยเดี่ยว','บานสวิงเปลือยคู่']),
 5:('บานเลื่อน','บานเลื่อน 4000 (เฟรม 95)',SL2),
 6:('บานเลื่อน','บานเลื่อน 4004 (เฟรม 71.5) + รางเดี่ยว 36.35',SL2),
 7:('บานเลื่อน','บานเลื่อน 4080 (เฟรม 70.6)',SL2),
 8:('บานเลื่อน','บานเลื่อน 4097 (เฟรม 103)',SL2),
 9:('บานเลื่อน','บานเลื่อน 4141 (เฟรม 101.6 หนา 1.6)',SL2),
 10:('บานเลื่อน','บานเลื่อน 4158 / 4160 (เฟรม 101.6 หนา 2.0)',SL2),
 11:('บานเลื่อน','บานเลื่อน 4873 (เฟรม 101.6 ร่อง 12)',SL2),
 12:('บานเลื่อน','บานเลื่อนเฟรมกล่อง (40051 / 40282 / 40240 / 40389)',SL2),
 13:('บานเลื่อน','ประตูบานเลื่อน 40301 (เฟรม 101.6 หนา 1.8)',DOOR+['บานเลื่อน 2 ตาย 2']),
 14:('บานเลื่อน','ประตูบานเลื่อน เฟรม 121 (4720) / 4056',DOOR),
 15:('บานเลื่อน','ชุดบานประตูเลื่อน ร่อง 12 / 16.5',DOOR),
 16:('บานเลื่อน','ประตูบานเลื่อน 40120 (เฟรม 101.6 หนา 2.5)',['บานเลื่อน 2 ตาย 2']),
 17:('บานเลื่อน','บานเลื่อน 3 ราง (เฟรม 105.5)',['บานเลื่อน 3 บาน']),
 18:('บานเลื่อน','บานเลื่อน TR (เสาเกี่ยวเสริม ใช้เฟรม 4000)',SL2),
 19:('บานเลื่อน','ประตูบานเลื่อน HR (เสาเกี่ยวหนัก ใช้เฟรม 40301)',['บานเลื่อน 2 ตาย 2']),
 20:('บานเลื่อน','มุ้งบานเลื่อน (GROUP 07)',[]),
 21:('บานเปิด / บานกระทุ้ง','บานเปิด 5000',['บานเปิด','บานเปิดข้าง']),
 22:('บานเปิด / บานกระทุ้ง','บานเปิด / บานกระทุ้ง 5398',['บานเปิด','บานเปิดข้าง','บานกระทุ้ง','บานติดตาย']),
 23:('บานเปิด / บานกระทุ้ง','บานเปิดหนัก 5451 / 5077',['บานเปิด','บานเปิดข้าง','บานกระทุ้ง']),
 24:('บานเปิด / บานกระทุ้ง','บานเปิด 5200 (กล่อง)',['บานเปิด']),
 25:('บานเปิด / บานกระทุ้ง','บานเปิด 5036',['บานเปิด','บานเปิดข้าง']),
 26:('บานเปิด / บานกระทุ้ง','บานกระทุ้ง 5203 (เฟรม 4")',['บานกระทุ้ง']),
 27:('บานเปิด / บานกระทุ้ง','บานกระทุ้ง 5207',['บานกระทุ้ง','บานติดตาย']),
 28:('บานเปิด / บานกระทุ้ง','บานกระทุ้ง 50193 / 50199',['บานกระทุ้ง']),
 29:('บานเปิด / บานกระทุ้ง','บานกระทุ้ง 5077 / 51057',['บานกระทุ้ง']),
 30:('ผนังกระจก','ผนังกระจก (GROUP 04)',['STICK WALL']),
 31:('แผงกันแดด / ลูกฟัก','แผงกันแดด (GROUP 05)',[]),
 32:('แผงกันแดด / ลูกฟัก','ลูกฟัก (GROUP 06)',[])}
assert len(S)==len(d['series'])
FAM=[('STANDARD',0,'{1.0,1.2,1.5,1.8,2.0}'),('บานเลื่อน',1,None),('บานเปิด / บานกระทุ้ง',2,None),('ประตูบานสวิง / บานเปิด',3,None),('ผนังกระจก',4,None),('แผงกันแดด / ลูกฟัก',5,None)]
FIN=[('อบขาว',170),('อบดำ',170),('สีชุบ (อโนไดซ์)',170),('ลายไม้สักทอง',350)]   # = SMS shop rates
prov=uid('provider')
fmt=lambda v: ('%g' % float(v)) if v not in (None,'') else None
def pname(p):
    size='x'.join(x for x in (fmt(p.get('width_mm')), fmt(p.get('depth_mm'))) if x)
    return ((p.get('role_family') or 'อื่นๆ') + (' ' + size if size else '')).strip()
q=lambda s: "'"+str(s).replace("'","''")+"'" if s is not None else 'NULL'
num=lambda v: 'NULL' if v in (None,'') else repr(float(v))
profiles={}; links=[]; kgdiff=[]
for i,s in enumerate(d['series']):
    sid=uid('series',S[i][1])
    for p in s['profiles']:
        die=p['die_no'].strip()
        if die not in profiles: profiles[die]=dict(p, id=uid('profile',die), die=die)
        elif profiles[die]['kg_per_m']!=p['kg_per_m']: kgdiff.append((die,profiles[die]['kg_per_m'],p['kg_per_m']))
        links.append((sid, profiles[die]['id'], p.get('role_family') or 'อื่นๆ'))
links=list(dict.fromkeys(links))
font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',30)
os.makedirs(OUT+'/img',exist_ok=True); imgs=[]
def label(t):
    if t in (None,''): return 't = ?'
    v=float(t); return 't = '+(f'{v:.1f}' if round(v,1)==v else f'{v:g}')+' mm'
for p in profiles.values():
    m=man.get(p['die'])
    if not m: p['image_path']=None; continue
    im=Image.open(X+'/'+m['file']).convert('RGB'); w,h=im.size; band=48
    o=Image.new('RGB',(w,h+band),'white'); o.paste(im,(0,0)); dr=ImageDraw.Draw(o); lb=label(p.get('wall_mm'))
    dr.text(((w-dr.textlength(lb,font=font))/2,h+6),lb,fill='black',font=font)
    fn=p['id']+'.png'; o.save(OUT+'/img/'+fn,optimize=True)
    p['image_path']=f'{T}/profiles/{p["id"]}.png'; imgs.append({'id':p['id'],'file':fn,'code':p['die']})
json.dump(imgs,open(OUT+'/list.json','w'))
L=["-- Owner 2026-11-04: \"เมืองทองก่อน ราคาเหมือน sms\" — import Muangthong Aluminium Vol.3 (แคตตาล็อคเมืองทอง.pdf) as an extruder.",
"-- Source docs/catalogs/muangthong/muangthong-vol3.json (kg/m + wall read from the catalogue; role names mapped). Prices = SMS",
"-- shop rates (170 THB/kg, wood grain 350). Pictures uploaded first to estimation-images/<tenant>/profiles/<id>.png with t = wall.",
"-- Families: STANDARD = GROUP 01 box system (like SMS001 / MN GROUP 01). Generated by 2026-11-04-import-muangthong.gen.py; refuses to run twice.",
"BEGIN;",
f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM alu_providers WHERE tenant_id = {q(T)} AND (id = {q(prov)} OR short_name = 'MT')) THEN RAISE EXCEPTION 'Muangthong already imported'; END IF; END $$;",
f"INSERT INTO alu_providers (id, tenant_id, name, short_name, price_basis, active) VALUES ({q(prov)}, {q(T)}, 'บจก. เมืองทองอลูมิเนียมอุตสาหกรรม (เมืองทอง)', 'MT', 'per_kg', true);"]
for name,price in FIN:
    fid=uid('finish',name)
    L.append(f"INSERT INTO alu_finishes (id, tenant_id, provider_id, name, active) VALUES ({q(fid)}, {q(T)}, {q(prov)}, {q(name)}, true);")
    L.append(f"INSERT INTO alu_kg_prices (tenant_id, provider_id, finish_id, price_per_kg, effective_from, source) VALUES ({q(T)}, {q(prov)}, {q(fid)}, {price}, '2026-01-01', 'same as SMS shop rate (owner 2026-11-04)');")
for f,o,th in FAM:
    L.append(f"INSERT INTO alu_series_families (id, tenant_id, provider_id, name, thickness_options, sort_order, active) VALUES ({q(uid('family',f))}, {q(T)}, {q(prov)}, {q(f)}, {q(th) if th else 'NULL'}, {o}, true);")
for i,(fam,sname,types) in S.items():
    sid=uid('series',sname)
    L.append(f"INSERT INTO alu_series (id, tenant_id, provider_id, name, is_base, active, series_family_id) VALUES ({q(sid)}, {q(T)}, {q(prov)}, {q(sname)}, false, true, {q(uid('family',fam))});")
    for t in types:
        L.append(f"INSERT INTO alu_series_types (tenant_id, series_id, type_id) SELECT {q(T)}, {q(sid)}, id FROM door_window_types WHERE tenant_id = {q(T)} AND name = {q(t)};")
for p in profiles.values():
    L.append("INSERT INTO alu_profiles (id, tenant_id, provider_id, name, drawing_no, family, thickness_mm, linear_weight_kg_per_m, default_length_m, width_mm, depth_mm, active, image_path) VALUES "
             f"({q(p['id'])}, {q(T)}, {q(prov)}, {q(pname(p))}, {q(p['die'])}, {q(p.get('role_family') or 'อื่นๆ')}, {num(p.get('wall_mm'))}, {num(p['kg_per_m'])}, {num(p.get('std_length_m') or 6.4)}, {num(p.get('width_mm'))}, {num(p.get('depth_mm'))}, true, {q(p['image_path'])});")
for sid,pid,fam in links:
    L.append(f"INSERT INTO alu_series_profiles (tenant_id, series_id, profile_id, family) VALUES ({q(T)}, {q(sid)}, {q(pid)}, {q(fam)});")
nt=sum(len(v[2]) for v in S.values())
L.append(f"""DO $$ DECLARE a int; b int; c int; d int; e int; f int; BEGIN
  SELECT count(*) INTO a FROM alu_series WHERE provider_id = {q(prov)};
  SELECT count(*) INTO b FROM alu_profiles WHERE provider_id = {q(prov)};
  SELECT count(*) INTO c FROM alu_series_profiles sp JOIN alu_series s ON s.id = sp.series_id WHERE s.provider_id = {q(prov)};
  SELECT count(*) INTO d FROM alu_series_types st JOIN alu_series s ON s.id = st.series_id WHERE s.provider_id = {q(prov)};
  SELECT count(*) INTO e FROM alu_kg_prices WHERE provider_id = {q(prov)};
  SELECT count(*) INTO f FROM alu_profiles WHERE provider_id = {q(prov)} AND image_path IS NOT NULL;
  IF a <> {len(S)} OR b <> {len(profiles)} OR c <> {len(links)} OR d <> {nt} OR e <> {len(FIN)} OR f <> {len(imgs)} THEN
    RAISE EXCEPTION 'count mismatch: series % profiles % links % types % prices % images %', a, b, c, d, e, f; END IF;
END $$;""")
L.append(f"SELECT f.name family, count(DISTINCT s.id) series, count(sp.id) profiles FROM alu_series s JOIN alu_series_families f ON f.id = s.series_family_id LEFT JOIN alu_series_profiles sp ON sp.series_id = s.id WHERE s.provider_id = {q(prov)} GROUP BY f.name, f.sort_order ORDER BY f.sort_order;")
L.append("COMMIT;")
open(ROOT+'/supabase/datafix/2026-11-04-import-muangthong.sql','w').write('\n'.join(L)+'\n')
print('series',len(S),'profiles',len(profiles),'links',len(links),'types',nt,'imgs',len(imgs),'kgdiff',kgdiff,'no wall',[p['die'] for p in profiles.values() if not p.get('wall_mm')])
