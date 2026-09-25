import { readFileSync } from 'node:fs';
const [profilePath,cadencePath]=process.argv.slice(2);
const p=JSON.parse(readFileSync(profilePath,'utf8')), cadence=JSON.parse(readFileSync(cadencePath,'utf8'));
if(!p.workerClock?.start)throw new Error('Profile has no worker clock alignment');
const offset=p.workerClock.start.hrtimeUs/1000-p.workerClock.start.performanceMs;
const nodes=new Map(p.nodes.map(n=>[n.id,n])),parent=new Map();
for(const n of p.nodes)for(const c of n.children??[])parent.set(c,n.id);
const category=new Map();
for(const n of p.nodes){
  const stack=[];for(let id=n.id;id!==undefined;id=parent.get(id))stack.push(nodes.get(id).callFrame);
  const contains=s=>stack.some(f=>f.url.includes(s));
  category.set(n.id,n.callFrame.functionName==='(idle)'?'idle':n.callFrame.functionName==='(garbage collector)'?'GC':contains('WaterRefinementTransformer')?'water repair':contains('/pathfinding/')?'other pathfinding':contains('/AttackExecution')?'attack expansion':contains('/PlayerExecution')?'player/cluster work':contains('/simulation/Fog')||contains('/simulation/GameFog')?'fog/view work':'other');
}
const rows=cadence.rows.filter(r=>r[2]>0);
const groups={slow:{samplesUs:0,ticks:new Set(),categories:{}},normal:{samplesUs:0,ticks:new Set(),categories:{}},between:{samplesUs:0,ticks:new Set(),categories:{}}};
let timestamp=p.startTime,index=0;
for(let i=0;i<p.samples.length;i++){
  const delta=p.timeDeltas[i]??0;timestamp+=delta;
  const now=timestamp/1000-offset;
  while(index<rows.length&&rows[index][1]<now)index++;
  if(index>=rows.length)break;
  const row=rows[index];
  if(now<row[1]-row[2])continue;
  const group=now<row[1]-row[3]?groups.between:row[3]>=500?groups.slow:groups.normal;
  group.samplesUs+=delta;group.ticks.add(row[0]);
  const c=category.get(p.samples[i]);group.categories[c]=(group.categories[c]??0)+delta;
}
for(const [name,g] of Object.entries(groups))console.log(JSON.stringify({group:name,ticks:g.ticks.size,sampledMs:g.samplesUs/1000,categories:Object.entries(g.categories).sort((a,b)=>b[1]-a[1]).map(([name,us])=>({name,ms:Math.round(us/1000),percent:Math.round(us/g.samplesUs*1000)/10}))}));
