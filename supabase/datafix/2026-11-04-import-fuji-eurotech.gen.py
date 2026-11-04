import json, uuid, os, collections
from PIL import Image, ImageDraw, ImageFont
ROOT='/Users/plfx/code/FacadeXPM/facadex-app'
X=ROOT+'/DOC/ALUMNIUM CATALOG/_extracted/fuji-eurotech-sections'
OUT=os.path.dirname(os.path.abspath(__file__))
T='1b9affc4-2136-4ed1-b168-a36e6624e743'
d=json.load(open(ROOT+'/docs/catalogs/fuji/fuji-eurotech-2024.json'))
man={m['die']:m for m in json.load(open(X+'/manifest.json')) if m.get('file')}
ns=uuid.UUID('6f1c2a90-0000-4000-8000-000000f0f1f1')
uid=lambda *k: str(uuid.uuid5(ns,'|'.join(map(str,k))))
SER={ 'EcoTECH A-CLASS':('EcoTECH','EcoTECH A-CLASS ชุดบานเลื่อน',['บานเลื่อนรางล่าง','บานเลื่อนสวน 2 บาน']),
      'EcoTECH C-CLASS':('EcoTECH','EcoTECH C-CLASS ชุดบานเลื่อน',['บานเลื่อนรางล่าง','บานเลื่อนสวน 2 บาน']),
      'EUROTECH Sliding Door & Window (2 & 3 track)':('EUROTECH','EUROTECH ชุดบานเลื่อน 2 ราง / 3 ราง',['บานเลื่อน 2 ตาย 2','บานเลื่อน 3 บาน','บานเลื่อนรางล่าง','บานเลื่อนสวน 2 บาน']),
      'EUROTECH Awning / Casement / Fixed':('EUROTECH','EUROTECH ชุดบานเปิด / บานกระทุ้ง / บานติดตาย',['บานกระทุ้ง 1 ชั้น x 1 ช่อง = 1 บาน','บานติดตาย','บานเปิด','บานเปิดข้าง']),
      'EUROTECH Bi-fold Door':('EUROTECH','EUROTECH ชุดประตูบานเฟี้ยม',['บานเฟี้ยม'])}
FAM=[('EcoTECH',0),('EUROTECH',1)]
FIN=[('อบขาว','Powder coat Standard White',170),('อบดำ','Standard Black',170),('ดำซาฮาร่า','Black Sahara',170),('เทาซาฮาร่า','Grey Sahara',170),
     ('ลายไม้สักทอง','Wood grain Golden Teak',350),('สีชุบ (อโนไดซ์)','Natural Anodised',170),('อโนไดซ์ดำ','Black Anodised',170)]
prov=uid('provider')
q=lambda s: "'"+str(s).replace("'","''")+"'" if s is not None else 'NULL'
num=lambda v: 'NULL' if v in (None,'') else repr(float(v))
profiles={}; links=[]; dup=[]
for s in d['series']:
    fam,sname,types=SER[s['name']]
    sid=uid('series',sname)
    for p in s['profiles']:
        die=p['die_no'].strip(); key=(die, p.get('wall_mm'))
        if not p.get('wall_mm') and man.get(die,{}).get('thickness_mm'): p=dict(p, wall_mm=man[die]['thickness_mm'])
        key=(die, p.get('wall_mm'))
        if key not in profiles:
            profiles[key]=dict(id=uid('profile',die,p.get('wall_mm')),die=die,**p)
        elif profiles[key]['kg_per_m']!=p['kg_per_m']: dup.append((die,profiles[key]['kg_per_m'],p['kg_per_m'],s['name']))
        links.append((sid, profiles[key]['id'], p.get('role_family') or p['name']))
links=list(dict.fromkeys(links))
# images
font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',30)
os.makedirs(OUT+'/img',exist_ok=True); imgs=[]; noimg=[]
def label(t):
    if t in (None,''): return 't = ?'
    v=float(t); return 't = '+(f'{v:.1f}' if round(v,1)==v else f'{v:g}')+' mm'
for k,p in profiles.items():
    m=man.get(p['die'])
    if not m: noimg.append(p['die']); p['image_path']=None; continue
    im=Image.open(X+'/'+m['file']).convert('RGB'); w,h=im.size; band=48
    o=Image.new('RGB',(w,h+band),'white'); o.paste(im,(0,0)); dr=ImageDraw.Draw(o); lb=label(p.get('wall_mm'))
    dr.text(((w-dr.textlength(lb,font=font))/2,h+6),lb,fill='black',font=font)
    fn=p['id']+'.png'; o.save(OUT+'/img/'+fn,optimize=True)
    p['image_path']=f'{T}/profiles/{p["id"]}.png'; imgs.append({'file':fn,'path':p['image_path']})
json.dump(imgs,open(OUT+'/imgs.json','w'))
L=[]
L.append("-- Owner 2026-11-04: \"ทำเลย ราคาเหมือน sms\" — import Fuji Eurotech 2024 (bought via KC) as an extruder.")
L.append("-- Source docs/catalogs/fuji/fuji-eurotech-2024.json (kg/m, dims read from the catalogue). Prices = SMS shop rates per colour")
L.append("-- (170 THB/kg, wood grain 350). Pictures uploaded first to estimation-images/<tenant>/profiles/<id>.png with t = wall.")
L.append("-- Ids are fixed (uuid5) so the file can be re-checked; it refuses to run twice.")
L.append("BEGIN;")
L.append(f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM alu_providers WHERE tenant_id = {q(T)} AND (id = {q(prov)} OR short_name = 'FUJI')) THEN RAISE EXCEPTION 'Fuji already imported'; END IF; END $$;")
L.append(f"INSERT INTO alu_providers (id, tenant_id, name, short_name, price_basis, active) VALUES ({q(prov)}, {q(T)}, 'บจก. ฟูจิ เมททอล (FUJI)', 'FUJI', 'per_kg', true);")
for name,code,price in FIN:
    fid=uid('finish',name)
    L.append(f"INSERT INTO alu_finishes (id, tenant_id, provider_id, name, code, active) VALUES ({q(fid)}, {q(T)}, {q(prov)}, {q(name)}, {q(code)}, true);")
    L.append(f"INSERT INTO alu_kg_prices (tenant_id, provider_id, finish_id, price_per_kg, effective_from, source) VALUES ({q(T)}, {q(prov)}, {q(fid)}, {price}, '2026-01-01', 'same as SMS shop rate (owner 2026-11-04)');")
for f,o in FAM:
    L.append(f"INSERT INTO alu_series_families (id, tenant_id, provider_id, name, sort_order, active) VALUES ({q(uid('family',f))}, {q(T)}, {q(prov)}, {q(f)}, {o}, true);")
for k,(fam,sname,types) in SER.items():
    sid=uid('series',sname)
    L.append(f"INSERT INTO alu_series (id, tenant_id, provider_id, name, is_base, active, series_family_id) VALUES ({q(sid)}, {q(T)}, {q(prov)}, {q(sname)}, false, true, {q(uid('family',fam))});")
    for t in types:
        L.append(f"INSERT INTO alu_series_types (tenant_id, series_id, type_id) SELECT {q(T)}, {q(sid)}, id FROM door_window_types WHERE tenant_id = {q(T)} AND name = {q(t)};")
for p in profiles.values():
    L.append("INSERT INTO alu_profiles (id, tenant_id, provider_id, name, drawing_no, family, thickness_mm, linear_weight_kg_per_m, default_length_m, width_mm, depth_mm, active, image_path) VALUES "
             f"({q(p['id'])}, {q(T)}, {q(prov)}, {q(p['name'])}, {q(p['die'])}, {q(p.get('role_family') or p['name'])}, {num(p.get('wall_mm'))}, {num(p['kg_per_m'])}, {num(p.get('std_length_m') or 6.4)}, {num(p.get('width_mm'))}, {num(p.get('depth_mm'))}, true, {q(p['image_path'])});")
for sid,pid,fam in links:
    L.append(f"INSERT INTO alu_series_profiles (tenant_id, series_id, profile_id, family) VALUES ({q(T)}, {q(sid)}, {q(pid)}, {q(fam)});")
ntypes=sum(len(v[2]) for v in SER.values())
L.append(f"""DO $$ DECLARE a int; b int; c int; d int; e int; f int; BEGIN
  SELECT count(*) INTO a FROM alu_series WHERE provider_id = {q(prov)};
  SELECT count(*) INTO b FROM alu_profiles WHERE provider_id = {q(prov)};
  SELECT count(*) INTO c FROM alu_series_profiles sp JOIN alu_series s ON s.id = sp.series_id WHERE s.provider_id = {q(prov)};
  SELECT count(*) INTO d FROM alu_series_types st JOIN alu_series s ON s.id = st.series_id WHERE s.provider_id = {q(prov)};
  SELECT count(*) INTO e FROM alu_kg_prices WHERE provider_id = {q(prov)};
  SELECT count(*) INTO f FROM alu_profiles WHERE provider_id = {q(prov)} AND image_path IS NOT NULL;
  IF a <> 5 OR b <> {len(profiles)} OR c <> {len(links)} OR d <> {ntypes} OR e <> {len(FIN)} OR f <> {len(imgs)} THEN
    RAISE EXCEPTION 'count mismatch: series % profiles % links % types % prices % images %', a, b, c, d, e, f; END IF;
  RAISE NOTICE 'OK series % profiles % links % types % prices % images %', a, b, c, d, e, f;
END $$;""")
L.append(f"SELECT s.name series, f.name family, (SELECT count(*) FROM alu_series_profiles sp WHERE sp.series_id = s.id) profiles, (SELECT string_agg(t.name, ' | ') FROM alu_series_types st JOIN door_window_types t ON t.id = st.type_id WHERE st.series_id = s.id) types FROM alu_series s JOIN alu_series_families f ON f.id = s.series_family_id WHERE s.provider_id = {q(prov)} ORDER BY f.sort_order, s.name;")
L.append("COMMIT;")
open(ROOT+'/supabase/datafix/2026-11-04-import-fuji-eurotech.sql','w').write('\n'.join(L)+'\n')
print('profiles',len(profiles),'links',len(links),'imgs',len(imgs),'noimg',noimg,'dup',dup,'no wall',[p['die'] for p in profiles.values() if not p.get('wall_mm')])
