import { readFileSync } from 'node:fs';
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));
const cut=data.routeLogs?.installedPerf;
if(!cut)throw new Error('Missing intervention timestamp');
const summary=rows=>{
  const stats=values=>{
    const sorted=[...values].sort((a,b)=>a-b);
    return {mean:values.reduce((a,b)=>a+b,0)/values.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],p99:sorted[Math.ceil(sorted.length*.99)-1],max:sorted.at(-1)};
  };
  return {samples:rows.length,intervalMs:stats(rows.map(r=>r[2])),workerMs:stats(rows.map(r=>r[3])),gapMs:stats(rows.map(r=>Math.max(0,r[2]-r[3])))};
};
console.log(JSON.stringify({routeLogs:data.routeLogs,before:summary(data.rows.filter(r=>r[2]>0&&r[1]<=cut&&r[1]>cut-60000)),after:summary(data.rows.filter(r=>r[1]-r[2]>=cut+10000))},null,2));
