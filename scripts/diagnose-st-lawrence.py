"""Report minimum dry crossings; diagnostic only, never carves a route."""
import sys, json, heapq
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.data/map-tools'))
import numpy as np
root=Path(sys.argv[1]); w,h=21344,10124
t=np.memmap(next(root.glob('earth-*-linear.bin')),dtype=np.uint8,mode='r',shape=(h,w))
def xy(lon,lat):return round((lon+169)/360*(4110/4108)*w),round((85-lat)/165*h)
x0,y0=xy(-77,47.2);x1,y1=xy(-70.5,43.8)
wet=(t[y0:y1+1,x0:x1+1]&128)==0;hh,ww=wet.shape
def point(lon,lat):
 x,y=xy(lon,lat);x-=x0;y-=y0
 return min(((xx-x)**2+(yy-y)**2,yy*ww+xx) for yy in range(max(0,y-16),min(hh,y+17)) for xx in range(max(0,x-16),min(ww,x+17)) if wet[yy,xx])[1]
a=point(-76.45,44.20);b=point(-71.2,46.8)
q=[(0,a)];cost={a:0};parent={}
while q:
 c,i=heapq.heappop(q)
 if c!=cost[i]:continue
 if i==b:break
 y,x=divmod(i,ww)
 for nx,ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
  if not(0<=nx<ww and 0<=ny<hh):continue
  j=ny*ww+nx;nc=c+(1 if wet[ny,nx] else 100000)
  if nc<cost.get(j,10**20):cost[j]=nc;parent[j]=i;heapq.heappush(q,(nc,j))
dry=[];i=b
while i!=a:
 y,x=divmod(i,ww)
 if not wet[y,x]:dry.append([round((x+x0)/w/(4110/4108)*360-169,5),round(85-(y+y0)/h*165,5)])
 i=parent[i]
print(json.dumps({'minimum_dry_crossings':len(dry),'locations':dry}))
for lon,lat in dry[:3]:
 x,y=xy(lon,lat);x-=x0;y-=y0
 print('\n'.join(''.join('X' if (xx==x and yy==y) else '~' if wet[yy,xx] else '#' for xx in range(x-6,x+7)) for yy in range(y-6,y+7)))
