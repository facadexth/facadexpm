import json,os
from PIL import Image, ImageDraw
out='mnimg'; m=json.load(open(out+'/manifest.json'))
items=sorted([r for r in m if r['file']], key=lambda r:(r['page'],r['die']))
T=160; cols=8; per=96
for s in range(0,len(items),per):
  chunk=items[s:s+per]; rows=(len(chunk)+cols-1)//cols
  sh=Image.new('L',(cols*T,rows*(T+14)),255); dr=ImageDraw.Draw(sh)
  for i,r in enumerate(chunk):
    im=Image.open(os.path.join(out,r['file'])); im.thumbnail((T-6,T-6))
    x=(i%cols)*T; y=(i//cols)*(T+14)
    sh.paste(im,(x+3,y+3)); dr.rectangle([x,y,x+T-1,y+T+13],outline=0 if r['confidence']=='ok' else 100, width=1 if r['confidence']=='ok' else 4)
    dr.text((x+3,y+T),'%s p%d'%(r['die'],r['page']),fill=0)
  sh.save('mntool/sheet%02d.png'%(s//per))
print(len(items))
