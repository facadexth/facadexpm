import json,sys,os
from PIL import Image, ImageDraw
out=sys.argv[1]; pages=set(int(p) for p in sys.argv[3:]); dst=sys.argv[2]
m=json.load(open(os.path.join(out,'manifest.json')))
items=[r for r in m if r['page'] in pages and r['file']]
T=260; cols=5; rows=(len(items)+cols-1)//cols
sheet=Image.new('L',(cols*T,rows*(T+20)),255); dr=ImageDraw.Draw(sheet)
for i,r in enumerate(items):
  im=Image.open(os.path.join(out,r['file'])); im.thumbnail((T-8,T-8))
  x=(i%cols)*T; y=(i//cols)*(T+20)
  sheet.paste(im,(x+4,y+4)); dr.rectangle([x,y,x+T-1,y+T+19],outline=0 if r['confidence']=='ok' else 128, width=1 if r['confidence']=='ok' else 4)
  dr.text((x+4,y+T+4),'%s p%d %s'%(r['die'],r['page'],r['confidence']),fill=0)
sheet.save(dst)
