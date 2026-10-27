export const LOCATIONS = [
  { id:'gate-main', name:'Main Entrance Gate', type:'Entry', x:10, y:50 }, { id:'gate-east', name:'East Gate', type:'Entry', x:83, y:17 },
  { id:'security', name:'Security Checkpoint', type:'Safety', x:18, y:50 }, { id:'cse', name:'CSE Block', type:'Academic', x:33, y:20 },
  { id:'ece', name:'ECE Block', type:'Academic', x:51, y:18 }, { id:'eee', name:'EEE Block', type:'Academic', x:68, y:28 },
  { id:'science', name:'Science Block', type:'Academic', x:30, y:43 }, { id:'lab', name:'Computer Laboratory', type:'Laboratory', x:48, y:36 },
  { id:'physics', name:'Physics Laboratory', type:'Laboratory', x:70, y:47 }, { id:'library', name:'Central Library', type:'Study', x:46, y:58 },
  { id:'reading', name:'Reading Room', type:'Study', x:60, y:62 }, { id:'canteen', name:'Canteen', type:'Dining', x:77, y:62 },
  { id:'admin', name:'Administrative Office', type:'Office', x:20, y:71 }, { id:'auditorium', name:'Auditorium', type:'Events', x:40, y:80 },
  { id:'playground', name:'Playground', type:'Recreation', x:73, y:82 }, { id:'garden', name:'Central Garden', type:'Common area', x:56, y:43 },
  { id:'bike', name:'Bike Parking', type:'Parking', x:15, y:31 }, { id:'bus', name:'Bus Pickup Area', type:'Transport', x:91, y:51 },
  { id:'water', name:'Water Point', type:'Facility', x:62, y:75 }
];
export const CATEGORIES = ['ID cards','Books & notebooks','Bags','Wallets','Earphones','Electronic devices','Keys','Watches & accessories','Water bottles','Stationery','Clothing','Other'];
export const STAFF_ROLES = ['staff','student'];
export const uid = (prefix='id') => `${prefix}-${crypto.randomUUID()}`;
export const CAMPUS_ZONES = [
  { id:'west', name:'West campus', x:25, y:50 },
  { id:'central', name:'Central campus', x:50, y:50 },
  { id:'east', name:'East campus', x:75, y:50 }
];
export const zoneForLocation = locationId => {
  const location = LOCATIONS.find(item => item.id === locationId);
  if (!location) return null;
  return CAMPUS_ZONES[location.x < 35 ? 0 : location.x > 65 ? 2 : 1];
};
export const zoneById = zoneId => CAMPUS_ZONES.find(zone => zone.id === zoneId) || null;
export const policyFor = (category, value='Less expensive', itemType='') => {
  const item = `${category||''} ${itemType||''}`;
  const sensitive = /id card|access card|financial document|passport|identity/i.test(item);
  const valuable = /wallet|watch|electronic|phone|laptop|jewelry|financial document/i.test(item) || value === 'Expensive';
  return sensitive ? { level:3, label:'Highly sensitive', review:true, custody:true, publish:'generic' } : valuable ? { level:2, label:'Valuable or sensitive', review:true, custody:true, publish:'staff-approved' } : { level:1, label:'Standard', review:false, custody:false, publish:'after-review' };
};
export const publicReport = report => {
  if (!report || !['open','active','under review','recovered'].includes(report.status)) return null;
  if (report.kind === 'found' && (!report.approved || !['active','recovered'].includes(report.status))) return null;
  const policy = policyFor(report.category, report.value, report.itemType);
  const restricted = policy.level > 1;
  const zone = restricted ? null : (zoneById(report.zoneId) || zoneForLocation(report.locationId));
  const description = restricted
    ? 'A restricted item has been reported. Contact campus staff for details.'
    : report.publicDescription || report.description || report.itemType;
  return {
    id: report.id,
    kind: report.kind,
    category: restricted ? 'Restricted item' : report.category,
    itemType: restricted ? 'Restricted item' : report.itemType,
    color: restricted ? '' : report.color,
    description,
    zoneId: zone?.id || null,
    zoneName: zone?.name || 'Campus',
    date: report.date,
    status: report.status,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    duplicateOf: report.duplicateOf ? true : undefined,
    image: restricted ? null : report.image || null,
    value: restricted ? null : report.value
  };
};

export function publicMatchFactors(lost, found) {
  return publicMatch(lost, found).factors;
}

export function publicMatch(lost, found) {
  const publicLost = publicReport(lost), publicFound = publicReport(found);
  if (!publicLost || !publicFound) return { score:0, factors:[] };
  return matchScore(publicLost, publicFound);
}

const norm = s => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim();
export function matchScore(lost, found) {
  if (lost.kind !== 'lost' || found.kind !== 'found' || found.approved === false || found.status === 'recovered' || found.duplicateOf) return { score:0, factors:[] };
  let score=0; const factors=[];
  const add=(points, label)=>{score+=points; factors.push(label);};
  if (lost.category && found.category && norm(lost.category) === norm(found.category)) add(28,'Same category');
  if (lost.itemType && found.itemType && norm(lost.itemType) === norm(found.itemType)) add(24,'Similar item type');
  if (lost.brand && found.brand && norm(lost.brand) === norm(found.brand)) add(15,'Brand matches');
  if (lost.color && found.color && norm(lost.color) === norm(found.color)) add(12,'Colour matches');
  if (lost.zoneId && found.zoneId && lost.zoneId === found.zoneId) add(8,'Same broad campus area');
  else if (lost.locationId && found.locationId && lost.locationId === found.locationId) add(12,'Same campus landmark');
  if (lost.date && found.date) { const days=Math.abs(new Date(lost.date)-new Date(found.date))/86400000; if(days<=1)add(9,'Dates within one day'); else if(days<=7)add(5,'Dates within one week'); }
  if (lost.color && found.color && norm(lost.color) !== norm(found.color)) score-=18;
  if (lost.brand && found.brand && norm(lost.brand) !== norm(found.brand)) score-=12;
  return { score:Math.max(0,Math.min(100,score)), factors };
}
export const isOpen = r => !!r && ['open','active','under review'].includes(r.status);
export function analytics(reports, claims=[], { since=null, until=null }={}) {
  const inRange=r=>{const d=new Date(r.createdAt || r.date); return !Number.isNaN(+d)&&(!since || d>=new Date(since))&&(!until || d<=new Date(until+'T23:59:59'));};
  const valid=reports.map(publicReport).filter(Boolean).filter(inRange);
  const unique=[...new Map(valid.filter(r=>!r.duplicateOf).map(r=>[r.id,r])).values()];
  const lost=unique.filter(r=>r.kind==='lost'), found=unique.filter(r=>r.kind==='found');
  const recovered=unique.filter(r=>r.status==='recovered');
  const byLocation=CAMPUS_ZONES.map(zone=>{const rows=unique.filter(r=>r.zoneId===zone.id);return {location:zone,count:rows.length,lost:rows.filter(r=>r.kind==='lost').length,found:rows.filter(r=>r.kind==='found').length,recovered:rows.filter(r=>r.status==='recovered').length};}).filter(x=>x.count).sort((a,b)=>b.count-a.count);
  const trend=(rows,unit)=>{const groups=new Map();for(const r of rows){const d=new Date(r.createdAt||r.date);if(Number.isNaN(+d))continue;const key=unit==='week'?new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-((d.getUTCDay()+6)%7))).toISOString().slice(0,10):d.toISOString().slice(0,7);groups.set(key,(groups.get(key)||0)+1);}return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([period,count])=>({period,count}));};
  const recoveredWithTime=recovered.filter(r=>r.createdAt&&r.updatedAt);const averageDays=recoveredWithTime.length?Math.round(recoveredWithTime.reduce((sum,r)=>sum+Math.max(0,new Date(r.updatedAt)-new Date(r.createdAt))/86400000,0)/recoveredWithTime.length*10)/10:null;
  return { lost:lost.length,found:found.length,recovered:recovered.length,unresolved:unique.filter(r=>isOpen(r)).length,pendingClaims:claims.filter(c=>inRange(c)&&['Submitted','Under review','More information required'].includes(c.status)).length,recoveryRate:unique.length?Math.round(recovered.length/unique.length*100):0,averageDays,weekly:trend(unique,'week'),monthly:trend(unique,'month'),byLocation,byCategory:CATEGORIES.map(category=>({category,count:unique.filter(r=>r.category===category).length})).filter(x=>x.count) };
}

export const HOTSPOT_MINIMUM = 3;
export function calculateHotspots(reports, { kind='combined', period='month', threshold=HOTSPOT_MINIMUM, now=new Date() }={}) {
  const days = period === 'week' ? 7 : 30;
  const min = Math.max(HOTSPOT_MINIMUM, Number(threshold) || HOTSPOT_MINIMUM);
  const cutoff = new Date(now).getTime() - days * 86400000;
  const eligible = reports.map(publicReport).filter(Boolean)
    .filter(report => !report.duplicateOf && ['lost','found'].includes(report.kind))
    .filter(report => kind === 'combined' || report.kind === kind)
    .filter(report => Number.isFinite(new Date(report.createdAt || report.date).getTime()))
    .filter(report => {const timestamp=new Date(report.createdAt || report.date).getTime();return report.zoneId&&timestamp>=cutoff&&timestamp<=new Date(now).getTime();});
  const unique = [...new Map(eligible.map(report => [report.id, report])).values()];
  return CAMPUS_ZONES.map(zone => {
    const rows = unique.filter(report => report.zoneId === zone.id);
    const lost = rows.filter(report => report.kind === 'lost').length;
    const found = rows.filter(report => report.kind === 'found').length;
    const count = kind === 'lost' ? lost : kind === 'found' ? found : lost + found;
    return { zone, count, lost, found };
  }).filter(row => row.count >= min).sort((a,b) => b.count-a.count);
}

export function duplicateCandidates(candidate, reports) {
  return reports.filter(r=>r.id!==candidate.id && r.kind===candidate.kind && r.status!=='recovered' && r.category===candidate.category && r.locationId===candidate.locationId && Math.abs(new Date(r.date)-new Date(candidate.date))<=86400000*3 && (!candidate.color || !r.color || norm(r.color)===norm(candidate.color)));
}
