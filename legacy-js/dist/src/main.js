import { LOCATIONS, CATEGORIES, CAMPUS_ZONES, uid, policyFor, publicReport, publicMatch, publicMatchFactors, analytics, calculateHotspots, HOTSPOT_MINIMUM, zoneForLocation, duplicateCandidates, isOpen } from './domain.js';
import { getAll, put, putMany, remove, clearAll, exportData, importData } from './store.js';
import { validateImageFile, readImageFile, verifyImageDataUrl, saveReportBundle } from './reporting.js';
import { CLAIM_STATUS, allowedClaimTransitions, validateClaimCreation, validateClaimTransition, validateHandover, validateMessageText, conversationParticipants as participantIdsForClaim, canAccessConversation as mayAccessConversation, orderedConversationMessages, escapeHtml } from './workflow.js';

const app=document.querySelector('#app'), modal=document.querySelector('#modal'), toastEl=document.querySelector('#toast');
const NAV=[['home','⌂','Home'],['map','⌖','Campus map'],['find','⌕','Find items'],['report','＋','Report an item'],['recovery','↗','Recovery centre'],['messages','✉','Messages'],['insights','▥','Insights & trends'],['activity','◷','My activity'],['admin','⚙','Admin / staff']];
const state={page:'home',role:localStorage.getItem('cfi-role')||'student',kind:'lost',data:{reports:[],claims:[],custody:[],notifications:[],audit:[],messages:[]},mapMode:'items',hotspotKind:'combined',hotspotPeriod:'month',hotspotThreshold:HOTSPOT_MINIMUM,openConversationId:null,mapLayer:'all',mapCategory:'all',mapStatus:'all',mapSince:null,mapQuery:'',mapSelected:null,zoom:1,panX:0,panY:0,selectedReport:null,reportImageFile:null,reportImagePreviewUrl:null,reportImageError:null,filters:{kind:'all',category:'all',location:'all',status:'all',query:''}};
const esc=escapeHtml;
const loc=id=>LOCATIONS.find(x=>x.id===id);
const dateLabel=d=>d?new Date(`${d}T00:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Date not set';
const ago=d=>{const n=Math.floor((Date.now()-new Date(d))/86400000);return n<=0?'Today':n===1?'Yesterday':`${n} days ago`;};
const statusClass=s=>String(s||'').toLowerCase().replace(/[^a-z]+/g,'-');
const now=()=>new Date().toISOString();
const roleLabel=role=>({student:'Demo claimant',finder:'Demo finder',staff:'Demo staff'})[role]||'Demo claimant';
const actorId=(role=state.role)=>({student:'demo-student',finder:'demo-finder',staff:'demo-staff'})[role]||'demo-student';
const normalizedOwner=owner=>owner==='demo'?'demo-student':owner;
const ownsRecord=(owner,role=state.role)=>normalizedOwner(owner)===actorId(role);
const isDemoRole=role=>['student','finder','staff'].includes(role);
const unreadMessages=()=>state.data.messages.filter(message=>message.toId===actorId()&&!message.readAt?.[actorId()]).length;
const notificationForActor=notice=>{if(notice.recipientId)return notice.recipientId===actorId();if(notice.message?.includes('waiting for staff review'))return state.role==='staff';if(notice.claimId){const claim=state.data.claims.find(item=>item.id===notice.claimId),report=state.data.reports.find(item=>item.id===claim?.reportId);return !!claim&&(ownsRecord(claim.owner)||ownsRecord(report?.owner));}const report=state.data.reports.find(item=>item.id===notice.reportId);return report?ownsRecord(report.owner)||state.role==='staff':state.role==='student';};
const currentNotifications=()=>state.data.notifications.filter(notificationForActor);
const zoneForId=id=>CAMPUS_ZONES.find(zone=>zone.id===id);
function toast(s){toastEl.textContent=s;toastEl.classList.add('show');setTimeout(()=>toastEl.classList.remove('show'),2800);}
function auditRecord(action,targetId,details='',actor=actorId()){return {id:uid('audit'),action,targetId,details,actor,createdAt:now()};}
function notificationRecord(message,reportId=null,recipientId=actorId(),claimId=null){return {id:uid('notice'),message,reportId,claimId,recipientId,read:false,createdAt:now()};}
async function commitBundle(entries){await putMany(entries);for(const {store,record} of entries){const rows=state.data[store];if(!rows)continue;const index=rows.findIndex(item=>item.id===record.id);if(index<0)rows.push(record);else rows[index]=record;}}
function updateReportImageUI(){
  const status=app.querySelector('#image-feedback'),preview=app.querySelector('#image-preview'),removeButton=app.querySelector('#remove-report-image');
  if(status){status.textContent=state.reportImageError|| (state.reportImageFile?'Selected: '+state.reportImageFile.name:'No photo selected.');status.setAttribute('role',state.reportImageError?'alert':'status');status.classList.toggle('error',!!state.reportImageError);}
  if(preview){preview.hidden=!state.reportImagePreviewUrl;if(state.reportImagePreviewUrl&&preview.src!==state.reportImagePreviewUrl)preview.src=state.reportImagePreviewUrl;if(!state.reportImagePreviewUrl)preview.removeAttribute('src');preview.onerror=()=>{if(state.reportImageFile){const message='The selected image could not be previewed. Choose a readable JPEG, PNG, or WebP image.';discardReportImage(message);toast(message);}};}
  if(removeButton)removeButton.hidden=!state.reportImageFile;
}
function discardReportImage(error=null){
  if(state.reportImagePreviewUrl)URL.revokeObjectURL(state.reportImagePreviewUrl);
  state.reportImagePreviewUrl=null;state.reportImageFile=null;state.reportImageError=error;
  const input=app.querySelector('#report-image-input');if(input)input.value='';
  updateReportImageUI();
}
function handleReportImageSelection(event){
  const file=event.currentTarget.files?.[0];if(!file)return;
  const validation=validateImageFile(file);
  if(!validation.valid){discardReportImage(validation.error);toast(validation.error);return;}
  if(state.reportImagePreviewUrl)URL.revokeObjectURL(state.reportImagePreviewUrl);
  state.reportImageFile=file;state.reportImageError=null;
  try{state.reportImagePreviewUrl=URL.createObjectURL(file);}
  catch{discardReportImage('A preview could not be created. Choose the image again.');toast(state.reportImageError);return;}
  updateReportImageUI();
}
async function refresh(){for(const k of Object.keys(state.data))state.data[k]=await getAll(k);render();}
async function audit(action,targetId,details=''){const event=auditRecord(action,targetId,details);await put('audit',event);state.data.audit.push(event);}
async function notify(message,reportId=null,recipientId=actorId(),claimId=null){const n=notificationRecord(message,reportId,recipientId,claimId);await put('notifications',n);state.data.notifications.push(n);}
async function saveReport(r){
  const createdAt=now();
  const event={...auditRecord('Report created',r.id,r.kind+' report'),createdAt};
  const notifications=[];
  if(r.kind==='found')notifications.push(notificationRecord('A found-item report is waiting for staff review.',r.id,actorId('staff')));
  else{
    const candidates=state.data.reports.filter(f=>f.kind==='found').map(f=>({r:f,...publicMatch(r,f)})).filter(x=>x.score>=45);
    if(candidates.length)notifications.push(notificationRecord(candidates.length+' possible match'+(candidates.length===1?'':'es')+' found for your report.',r.id,normalizedOwner(r.owner)));
  }
  const entries=[{store:'reports',record:r},{store:'audit',record:event},...notifications.map(record=>({store:'notifications',record}))];
  const result=await saveReportBundle(entries,putMany);
  if(!result.ok)throw result.error;
  state.data.reports.push(r);state.data.audit.push(event);state.data.notifications.push(...notifications);
}
function go(page){
  if(state.page==='report'&&page!=='report')discardReportImage();
  state.page=page;state.selectedReport=null;history.replaceState(null,'','#'+page);render();
}
function icon(i){return `<span class="nav-icon" aria-hidden="true">${i}</span>`;}
function layout(content){const unread=currentNotifications().filter(n=>!n.read).length,chatUnread=unreadMessages();return `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#home" data-page="home"><span class="brand-mark">F</span><span>Campus <b>FindIt</b><small>Lost. Found. Reunited.</small></span></a><div class="nav-label">WORKSPACE</div><nav>${NAV.map(([id,ic,label])=>`<button class="nav-item ${state.page===id?'active':''}" data-page="${id}">${icon(ic)}<span>${label}</span>${id==='activity'&&unread?`<i class="nav-badge">${unread}</i>`:''}${id==='messages'&&chatUnread?`<i class="nav-badge">${chatUnread}</i>`:''}</button>`).join('')}</nav><div class="side-bottom"><div class="demo-note"><span class="pulse-dot"></span><div><b>Local demo</b><small>Saved on this device</small></div></div><button class="role-switch" id="role-switch"><span class="avatar">${state.role==='staff'?'S':state.role==='finder'?'F':'M'}</span><span><b>${roleLabel(state.role)}</b><small>Switch demo role</small></span><span class="chevron">⌄</span></button></div></aside><main class="main-area"><header class="topbar"><div class="mobile-brand"><span class="brand-mark">F</span> Campus FindIt</div><div class="breadcrumb">Campus community <span>/</span> <b>${NAV.find(x=>x[0]===state.page)?.[2]||'Home'}</b></div><div class="top-actions"><button class="icon-button" id="bell" aria-label="Notifications">♧${unread?'<i></i>':''}</button><button class="top-avatar" id="role-switch-top" aria-label="Switch demo role" title="Switch demo role">${state.role==='staff'?'S':state.role==='finder'?'F':'M'}</button></div></header><div class="page-wrap">${content}</div><footer>Campus FindIt <span>•</span> Illustrative campus · Your records stay in this browser</footer></main><nav class="mobile-nav">${NAV.map(([id,ic,label])=>`<button class="${state.page===id?'active':''}" data-page="${id}">${icon(ic)}<small>${({home:'Home',map:'Map',find:'Find',report:'Report',recovery:'Recovery',messages:'Chat',insights:'Insights',activity:'Activity',admin:'Staff'})[id]}</small></button>`).join('')}</nav></div>`;}
function pageTitle(kicker,title,desc,actions=''){return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="heading-actions">${actions}</div></div>`;}
function empty(iconText,title,body,action=''){return `<div class="empty-state"><div class="empty-icon">${iconText}</div><h3>${title}</h3><p>${body}</p>${action}</div>`;}
function button(text,cls='btn-primary',attrs=''){return `<button class="${cls}" ${attrs}>${text}</button>`;}
function statusPill(s){return `<span class="status-pill ${statusClass(s)}">${esc(s||'Open')}</span>`;}
function cardReport(r,compact=false){const p=publicReport(r);if(!p)return '';const place=p.zoneName||'Campus';return `<article class="report-card ${compact?'compact':''}" data-open-report="${esc(r.id)}"><div class="report-thumb ${p.kind}">${p.image?`<img src="${p.image}" alt="Approved item photo">`:`<span>${p.kind==='lost'?'⌕':'＋'}</span>`}</div><div class="report-info"><div class="report-topline"><span class="kind-tag ${p.kind}">${p.kind==='lost'?'LOST':'FOUND'}</span>${statusPill(p.status)}</div><h3>${esc(p.itemType||p.category)}</h3><p>${esc(p.description||p.category)}</p><div class="report-meta"><span>⌖ ${esc(place)}</span><span>· ${dateLabel(p.date)}</span></div></div><span class="card-arrow">↗</span></article>`;}
function statCard(label,val,note,iconText){return `<div class="stat-card"><div class="stat-icon">${iconText}</div><div><span>${label}</span><strong>${val}</strong><small>${note}</small></div></div>`;}
function homePage(){const reports=state.data.reports.filter(r=>r.kind==='lost'||(r.kind==='found'&&r.approved)).filter(r=>isOpen(r)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const mine=state.data.reports.filter(r=>ownsRecord(r.owner));const matches=mine.filter(r=>r.kind==='lost').flatMap(l=>state.data.reports.filter(f=>f.kind==='found'&&f.approved&&isOpen(f)).map(f=>({f,...publicMatch(l,f),l}))).filter(m=>m.score>=45).sort((a,b)=>b.score-a.score).slice(0,2);const stats=analytics(state.data.reports,state.data.claims);const hour=new Date().getHours();const greeting=hour<12?'Good morning':hour<18?'Good afternoon':'Good evening';return `${pageTitle('YOUR CAMPUS, RECONNECTED',greeting,'A simpler way to find what matters and return what belongs.',button('＋ Report an item','btn-primary','data-page="report"'))}<section class="hero-card"><div class="hero-copy"><span class="hero-kicker">LOST SOMETHING? FOUND SOMETHING?</span><h2>Small things find<br><em>their way home.</em></h2><p>Search campus reports, share a useful clue, and coordinate a safe handover.</p><div class="hero-actions">${button('I lost something','btn-light','data-report-kind="lost"')} ${button('I found something','btn-outline-light','data-report-kind="found"')}</div></div><div class="hero-art"><div class="art-circle"></div><div class="art-pin">⌖</div><span class="art-line"></span><div class="art-chip">Made for campus</div></div></section><div class="quick-grid"><button class="quick-card" data-page="find"><span class="quick-icon lilac">⌕</span><b>Search items</b><small>Browse approved reports</small><span class="quick-arrow">↗</span></button><button class="quick-card" data-page="map"><span class="quick-icon mint">⌖</span><b>Explore campus</b><small>See landmarks and reports</small><span class="quick-arrow">↗</span></button><button class="quick-card" data-page="recovery"><span class="quick-icon peach">↗</span><b>Recovery centre</b><small>Follow a claim to handover</small><span class="quick-arrow">↗</span></button></div><div class="section-head"><div><div class="eyebrow">CAMPUS BOARD</div><h2>Recently reported</h2></div><button class="text-button" data-page="find">View all reports <span>→</span></button></div>${reports.length?`<div class="report-list">${reports.slice(0,3).map(r=>cardReport(r)).join('')}</div>`:empty('⌕','It starts with a report','There are no item reports yet. Add a report and it will appear here after the relevant review.')}${matches.length?`<div class="section-head"><div><div class="eyebrow">A POSSIBLE LEAD</div><h2>Matches to check</h2></div><button class="text-button" data-page="activity">My activity →</button></div><div class="match-strip">${matches.map(m=>`<div class="match-card"><div class="match-score">${m.score}<small>pts</small></div><div><b>${esc(publicReport(m.f)?.itemType||'Restricted item')} could match your ${esc(publicReport(m.l)?.itemType||'your report')}</b><small>${esc(publicReport(m.f)?.zoneName||'Campus')} · ${publicMatchFactors(m.l,m.f).join(' · ')}</small></div><button class="btn-quiet" data-open-report="${m.f.id}">Review →</button></div>`).join('')}</div>`:''}<div class="home-bottom"><div class="panel insight-mini"><div><div class="eyebrow">LIVE CAMPUS SNAPSHOT</div><h3>Patterns from real reports</h3><p>${stats.lost+stats.found?`${stats.lost} lost and ${stats.found} found reports so far.`:'Insights will appear when reports are submitted.'}</p></div><div class="mini-number">${stats.recoveryRate}<small>% recovered</small></div><button class="text-button" data-page="insights">Explore insights →</button></div><div class="privacy-tip"><span>✳</span><div><b>Keep one clue private</b><p>Leave a distinctive mark or detail out of public descriptions. It helps confirm ownership later.</p></div></div></div>`;}
function selector(name,items,value,allLabel='All'){return `<select name="${name}"><option value="all">${allLabel}</option>${items.map(x=>typeof x==='string'?`<option value="${esc(x)}" ${value===x?'selected':''}>${esc(x)}</option>`:`<option value="${x.id}" ${value===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select>`;}
function findPage(){
  const filters=state.filters;
  let list=state.data.reports.map(report=>({report,public:publicReport(report)})).filter(row=>row.public);
  if(filters.kind!=='all')list=list.filter(row=>row.public.kind===filters.kind);
  if(filters.category!=='all')list=list.filter(row=>row.public.category===filters.category);
  if(filters.location!=='all')list=list.filter(row=>row.public.zoneId===filters.location);
  if(filters.status!=='all')list=list.filter(row=>row.public.status===filters.status);
  if(filters.query){const query=filters.query.toLowerCase();list=list.filter(row=>`${row.public.itemType} ${row.public.category} ${row.public.description} ${row.public.zoneName}`.toLowerCase().includes(query));}
  list.sort((a,b)=>b.public.createdAt.localeCompare(a.public.createdAt));
  const categories=[...CATEGORIES,'Restricted item'];
  return `${pageTitle('DISCOVER','Find an item','Search approved lost and found reports across broad campus areas.') }<section class="panel filters-panel"><label class="search-box"><span>⌕</span><input id="search-query" placeholder="Search item, colour, or campus area..." value="${esc(filters.query)}"></label><div class="filter-row"><label>Report type${selector('kind',['lost','found'],filters.kind,'All types')}</label><label>Category${selector('category',categories,filters.category,'All categories')}</label><label>Campus area${selector('location',CAMPUS_ZONES,filters.location,'All areas')}</label><label>Status${selector('status',['under review','active','open','recovered'],filters.status,'All statuses')}</label><button class="text-button" id="clear-filters">Clear filters</button></div></section><div class="results-line"><b>${list.length} ${list.length===1?'result':'results'}</b><span>Newest first · exact landmarks and private details are hidden</span></div>${list.length?`<div class="report-list">${list.map(row=>cardReport(row.report)).join('')}</div>`:empty('⌕',filters.query||filters.kind!=='all'?'No matching reports':'No approved reports yet','Try a different search or check back after a report is approved.',button('Report an item','btn-secondary','data-page="report"'))}`;
}
function reportPage(){return `${pageTitle('ADD TO THE CAMPUS BOARD','Report an item','A few details can help reunite an item with its owner. Keep one identifying clue private.')}<div class="form-layout"><div class="form-main panel"><div class="segmented"><button class="${state.kind==='lost'?'active':''}" data-report-kind="lost">⌕ &nbsp;I lost something</button><button class="${state.kind==='found'?'active':''}" data-report-kind="found">＋ &nbsp;I found something</button></div><form id="report-form"><input type="hidden" name="kind" value="${state.kind}"><div class="form-section"><h3>About the item</h3><div class="form-grid"><label>Category <span>*</span><select name="category" required>${CATEGORIES.map(x=>`<option>${x}</option>`).join('')}</select></label><label>Item type <span>*</span><input name="itemType" required maxlength="80" placeholder="e.g. Blue notebook"></label><label>Brand or model <small>optional</small><input name="brand" maxlength="80" placeholder="If known"></label><label>Colour <small>optional</small><input name="color" maxlength="40" placeholder="e.g. Navy blue"></label><label>Date ${state.kind==='lost'?'last seen':'found'} <span>*</span><input type="date" name="date" max="${new Date().toISOString().slice(0,10)}" required value="${new Date().toISOString().slice(0,10)}"></label><label>Approximate time <small>optional</small><input type="time" name="time"></label></div><label>Public description <span>*</span><textarea name="description" required maxlength="300" rows="3" placeholder="Describe the item without giving away your private clue."></textarea></label>${state.kind==='found'?`<div class="form-grid"><label>Value classification<select name="value"><option>Less expensive</option><option>Expensive</option></select></label><label>How is it being handled?<select name="handling"><option>With me for now</option><option>Handed to campus staff</option><option>At the security desk</option></select></label></div><label>Private ownership clue <small>shown to staff during verification</small><textarea name="privateClue" rows="2" maxlength="300" placeholder="A mark, engraving, or contents known only to the owner"></textarea></label>`:`<label>Private distinguishing detail <small>only used during verification</small><textarea name="privateClue" rows="2" maxlength="300" placeholder="A mark, sticker, contents, or other detail only the owner knows"></textarea></label>`}</div><div class="form-section"><h3>Where on campus?</h3><div class="form-grid"><label>Exact campus landmark <small>kept private</small> <span>*</span><select name="locationId" required><option value="" disabled selected>Choose a campus landmark</option>${LOCATIONS.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label><label>Additional location details <small>optional · kept private</small><input name="locationDetail" maxlength="120" placeholder="Broad area only"></label></div><button type="button" class="text-button" data-page="map">⌖ Choose from campus map</button></div><div class="form-section"><h3>Add a photo <small>optional</small></h3><label class="upload-box" for="report-image-input"><input id="report-image-input" class="visually-hidden" type="file" name="image" accept="image/jpeg,image/png,image/webp"><span class="upload-icon">＋</span><span><b>Choose a photo</b><small>JPG, PNG or WebP · max 3 MiB</small></span></label><div class="image-selection"><span id="image-feedback" role="status" aria-live="polite">No photo selected.</span><img id="image-preview" alt="Selected item photo preview" hidden><button type="button" id="remove-report-image" class="text-button" hidden>Remove photo</button></div><small class="form-help">Avoid uploading IDs or images that reveal private personal information.</small></div><div class="privacy-callout"><span>◈</span><div><b>${state.kind==='found'?'Staff review before publishing':'Your private clue stays restricted'}</b><p>${state.kind==='found'?'Found reports are reviewed before they appear publicly. Exact landmarks and private clues are hidden from public views.':'Your exact landmark and identifying clue stay private; public views use a broad campus area.'}</p></div></div><div class="form-actions"><button class="btn-primary" type="submit">Submit ${state.kind} report <span>→</span></button><span class="form-footnote">Saved on this device in this browser</span></div></form></div><aside class="form-side"><div class="side-card"><div class="side-step">01</div><h3>Share the useful parts</h3><p>Item type, colour, and a broad landmark help people spot a possible match.</p></div><div class="side-card"><div class="side-step">02</div><h3>Keep a clue back</h3><p>Don't share unique marks or contents in the public description. Use them to verify a claim.</p></div><div class="side-card"><div class="side-step">03</div><h3>Meet safely</h3><p>Valuable items are routed through the demo staff workflow and in-person handover.</p></div><div class="local-data"><b>Local prototype</b><p>Records stay in this browser profile. They are not shared across devices or students.</p>${state.kind==='found'&&state.role!=='finder'?'<small>For a two-participant demo conversation, switch to Demo finder before creating the found report, then switch back to Demo claimant to claim it.</small>':''}</div></aside></div>`;}
function mapPage(){
  const query=state.mapQuery.toLowerCase();
  const landmarks=LOCATIONS.filter(item=>item.name.toLowerCase().includes(query)||item.type.toLowerCase().includes(query));
  const mode=state.mapMode;
  const since=state.mapSince?new Date(state.mapSince).getTime():null;
  const publicRows=state.data.reports.map(report=>({report,public:publicReport(report)})).filter(row=>row.public);
  const itemRows=publicRows.filter(row=>!since||new Date(row.public.createdAt).getTime()>=since)
    .filter(row=>(state.mapLayer==='all'||row.public.kind===state.mapLayer))
    .filter(row=>(state.mapCategory==='all'||row.public.category===state.mapCategory))
    .filter(row=>(state.mapStatus==='all'||row.public.status===state.mapStatus));
  const itemReports=itemRows.map(row=>row.public);
  const stats=analytics(itemRows.map(row=>row.report),state.data.claims);
  const selected=state.mapSelected?loc(state.mapSelected):null;
  const selectedZone=selected?zoneForLocation(selected.id):null;
  const hotspotSources=state.data.reports.filter(report=>{
    const projection=publicReport(report);
    return projection&&(!since||new Date(projection.createdAt).getTime()>=since)
      &&(state.mapCategory==='all'||projection.category===state.mapCategory)
      &&(state.mapStatus==='all'||projection.status===state.mapStatus);
  });
  const hotspots=calculateHotspots(hotspotSources,{kind:state.hotspotKind,period:state.hotspotPeriod,threshold:state.hotspotThreshold});
  const markerRows=mode==='items'?itemReports:[];
  const categories=[...CATEGORIES,'Restricted item'];
  const hotspotTitle=state.hotspotKind==='combined'?'Combined hotspots':`${state.hotspotKind==='lost'?'Lost-item':'Found-item'} hotspots`;
  return `${pageTitle('LOCATION INTELLIGENCE','Campus map','Reports use broad campus zones. Individual landmarks and room details remain private.',button('Reset view','btn-secondary','id="map-reset"'))}<div class="map-tabs"><button class="${mode==='items'?'active':''}" data-map-mode="items">Reported items</button><button class="${mode==='hotspots'?'active':''}" data-map-mode="hotspots">Hotspots</button><button class="${mode==='ranked'?'active':''}" data-map-mode="ranked">Frequent areas</button><button class="${mode==='explorer'?'active':''}" data-map-mode="explorer">Campus explorer</button></div><div class="map-layout"><section class="panel map-panel"><div class="map-toolbar"><label class="search-box"><span>⌕</span><input id="map-search" value="${esc(state.mapQuery)}" placeholder="Find a campus landmark"></label><div class="map-controls"><button id="zoom-out" aria-label="Zoom out">−</button><span>${Math.round(state.zoom*100)}%</span><button id="zoom-in" aria-label="Zoom in">＋</button></div></div><div class="map-viewport"><svg id="campus-map" viewBox="0 0 100 100" role="img" aria-label="Illustrative campus map with generalized report areas"><rect width="100" height="100" fill="#f5f7f2"/><path class="map-road" d="M2 49 H98 M22 8 V92 M6 30 H93 M12 72 H88 M32 8 V88 M54 8 V90 M76 8 V91"/><path class="map-path" d="M10 50 L33 20 L51 18 L68 28 L77 62 L73 82 M33 20 L46 58 L60 62 L56 43 L30 43 L20 71 L40 80"/>${LOCATIONS.map(item=>`<g class="map-landmark ${selected?.id===item.id?'selected':''}" data-map-location="${item.id}" transform="translate(${item.x},${item.y})"><circle r="5.3"/><text text-anchor="middle" y="1.1">${esc(item.name.split(' ').map(word=>word[0]).join('').slice(0,2))}</text><text class="map-label" text-anchor="middle" y="9">${esc(item.name)}</text></g>`).join('')}${mode==='items'?markerRows.map(report=>{const zone=zoneForId(report.zoneId);return zone?`<g class="report-marker ${report.kind}" data-open-report="${esc(report.id)}" transform="translate(${zone.x},${zone.y})"><circle r="2.8"/><text text-anchor="middle" y="1.2">${report.kind==='lost'?'?':'+'}</text></g>`:''}).join(''):''}${mode==='hotspots'?hotspots.map(row=>`<g class="hotspot ${esc(state.hotspotKind)}"><title>${esc(row.zone.name)}: ${row.count} eligible ${state.hotspotKind==='combined'?'lost and found':state.hotspotKind} reports</title><circle cx="${row.zone.x}" cy="${row.zone.y}" r="${Math.min(11,4+row.count)}" opacity=".42"/></g>`).join(''):''}</svg></div><div class="map-legend"><span><i class="legend-dot lost"></i> Lost</span><span><i class="legend-dot found"></i> Found</span><span><i class="legend-dot landmark"></i> Landmark</span><span class="map-caption">Illustrative layout · not to scale</span></div><div class="map-layer"><span>Report layer</span>${['all','lost','found'].map(kind=>`<button class="${state.mapLayer===kind?'active':''}" data-map-layer="${kind}">${kind==='all'?'All':kind[0].toUpperCase()+kind.slice(1)}</button>`).join('')}</div><div class="map-extra-filters"><label>Category${selector('category',categories,state.mapCategory,'All categories')}</label><label>Status${selector('status',['open','active','under review','recovered'],state.mapStatus,'All statuses')}</label><label>From date<input id="map-date-from" type="date" value="${esc(state.mapSince||'')}"></label></div></section><aside class="panel location-panel"><div class="panel-heading"><div><div class="eyebrow">${mode==='hotspots'?'THRESHOLDED REPORT PATTERNS':mode==='ranked'?'GENERALIZED AREA COUNTS':'CAMPUS DIRECTORY'}</div><h3>${selected?esc(selected.name):mode==='hotspots'?hotspotTitle:mode==='ranked'?'Frequent campus areas':'Campus landmarks'}</h3></div>${selected?`<button class="icon-button" id="clear-location" aria-label="Clear selected landmark">×</button>`:''}</div>${selected?`<div class="location-detail"><span class="location-type">${esc(selected.type)}</span><p>Report counts and markers are shown only by broad campus area.</p><div class="location-actions"><button class="btn-secondary" data-map-report="${selected.id}">Use in a report</button><button class="text-button" data-filter-location="${selectedZone?.id||''}">View area reports →</button></div></div>`:''}${mode==='hotspots'?`<div class="map-filters"><label>Report type<select id="hotspot-kind"><option value="combined" ${state.hotspotKind==='combined'?'selected':''}>Combined</option><option value="lost" ${state.hotspotKind==='lost'?'selected':''}>Lost only</option><option value="found" ${state.hotspotKind==='found'?'selected':''}>Found only</option></select></label><label>Time window<select id="hotspot-period"><option value="week" ${state.hotspotPeriod==='week'?'selected':''}>Last 7 days</option><option value="month" ${state.hotspotPeriod==='month'?'selected':''}>Last 30 days</option></select></label><label>Minimum count<select id="hotspot-threshold">${[3,4,5].map(value=>`<option value="${value}" ${Number(state.hotspotThreshold)===value?'selected':''}>${value} reports</option>`).join('')}</select></label></div>${hotspots.length?hotspots.map(row=>`<div class="rank-row hotspot-row"><span class="rank-num">${row.count}</span><span><b>${esc(row.zone.name)}</b><small>${row.lost} lost · ${row.found} found · last ${state.hotspotPeriod==='week'?'7':'30'} days</small></span></div>`).join(''):empty('⌖','No qualifying hotspots',`A broad campus area appears after at least ${Math.max(HOTSPOT_MINIMUM,Number(state.hotspotThreshold)||HOTSPOT_MINIMUM)} eligible unique ${state.hotspotKind==='combined'?'lost or found':state.hotspotKind} reports in the last ${state.hotspotPeriod==='week'?'7':'30'} days.`)}<p class="privacy-note">Hotspots describe reporting patterns only; they do not indicate risk or prove that an area is unsafe.</p>`:mode==='ranked'?stats.byLocation.length?stats.byLocation.map((row,index)=>`<div class="rank-row"><span class="rank-position">${String(index+1).padStart(2,'0')}</span><span><b>${esc(row.location.name)}</b><small>${row.count} report${row.count===1?'':'s'} · ${row.lost} lost / ${row.found} found</small></span><span class="row-arrow">→</span></div>`).join(''):empty('⌖','No reported areas yet','Generalized area counts will appear when reports are submitted.'):`<div class="landmark-list">${landmarks.map(item=>`<button class="landmark-row ${selected?.id===item.id?'selected':''}" data-map-location="${item.id}"><span class="landmark-symbol">⌖</span><span><b>${esc(item.name)}</b><small>${esc(item.type)}</small></span><span class="row-arrow">→</span></button>`).join('')||'<p class="muted">No landmarks match that search.</p>'}</div>`}</aside></div>`;
}
function claimsFor(reportId){return state.data.claims.filter(c=>c.reportId===reportId);}
function recoveryPage(){
  const relevantReports=state.data.reports.filter(report=>report.kind==='found'&&(state.role==='staff'||ownsRecord(report.owner)));
  const relevantReportIds=new Set(relevantReports.map(report=>report.id));
  const claims=state.data.claims.filter(claim=>state.role==='staff'||ownsRecord(claim.owner)||relevantReportIds.has(claim.reportId));
  const pending=state.role==='staff'?relevantReports.filter(report=>!report.approved&&report.status!=='withdrawn'&&report.status!=='rejected'):[];
  const custody=state.data.custody.filter(record=>state.role==='staff'||claims.some(claim=>claim.id===record.claimId));
  return `${pageTitle('SAFE HANDOVER','Recovery centre','Follow found items and ownership claims through review, custody, and in-person handover.',state.role==='staff'?button('Review queue','btn-secondary','data-page="admin"'): '')}<div class="recovery-stats">${statCard('Awaiting review',state.role==='staff'?pending.length:0,'Found item reports','◷')}${statCard('Open claims',claims.filter(claim=>![CLAIM_STATUS.REJECTED,CLAIM_STATUS.RECOVERED].includes(claim.status)).length,'For your cases','◇')}${statCard('In custody',custody.filter(record=>record.status!=='released').length,'Official handovers','▣')}</div><div class="section-head"><div><div class="eyebrow">ACTIVE CASES</div><h2>Items and claims</h2></div><span class="local-chip">DEMO WORKFLOW</span></div>${claims.length?`<div class="case-list">${claims.map(claim=>{const report=state.data.reports.find(item=>item.id===claim.reportId);const maySeeExplanation=ownsRecord(claim.owner)||state.role==='staff';return `<article class="case-card"><div class="case-id">${esc(claim.id.slice(-8).toUpperCase())}</div><div class="case-main"><div class="case-title"><b>${esc(publicReport(report)?.itemType||'Restricted item')}</b>${statusPill(claim.status)}</div><p>Claim for ${esc(claim.reportId)} · submitted ${ago(claim.createdAt)}</p>${maySeeExplanation?`<small>Your explanation: ${esc(claim.explanation)}</small>`:''}</div>${canAccessConversation(claim)?button('Open conversation','btn-secondary',`data-open-conversation="${claim.id}"`):''}${report?button('Open case','btn-quiet',`data-open-report="${report.id}"`):''}</article>`;}).join('')}</div>`:empty('↗','No active recovery cases','Claims and confirmed handovers for your demo participant will appear here.')}${pending.length?`<div class="section-head"><div><div class="eyebrow">FOUND ON CAMPUS</div><h2>Found reports awaiting review</h2></div></div><div class="report-list">${pending.map(report=>`<article class="admin-row"><div><b>${esc(report.itemType)} · ${esc(report.category)}</b><small>${esc(loc(report.locationId)?.name||'Campus')} · ${dateLabel(report.date)}</small></div><button class="btn-secondary" data-open-report="${report.id}">Review details</button></article>`).join('')}</div>`:''}<div class="workflow-note"><b>Physical recovery always requires a handover record.</b><span>The demo reviewer role is a local simulation; online claim approval does not release an item.</span></div>`;
}
function insightsPage(){
  const a=analytics(state.data.reports,state.data.claims,{since:state.analyticsSince,until:state.analyticsUntil});
  const max=Math.max(1,...a.byCategory.map(item=>item.count));
  const latest=state.data.reports.filter(report=>report.kind==='found'&&policyFor(report.category,report.value,report.itemType).review&&!report.approved).length;
  const custodyBacklog=state.data.custody.filter(record=>record.status!=='released').length;
  return `${pageTitle('THE CAMPUS PICTURE','Insights & trends','Counts use unique eligible reports and broad campus zones; exact landmarks stay private.',`<label class="date-filter">From <input id="date-from" type="date" value="${esc(state.analyticsSince||'')}"></label><label class="date-filter">To <input id="date-to" type="date" value="${esc(state.analyticsUntil||'')}"></label>`)}<div class="stats-grid">${statCard('Lost reports',a.lost,'Unique reports in range','⌕')}${statCard('Found reports',a.found,'Unique reports in range','＋')}${statCard('Confirmed recoveries',a.recovered,'Handover completed','✓')}${statCard('Unresolved',a.unresolved,'Still open','◷')}${statCard('Pending claims',a.pendingClaims,'Need a next step','◇')}${statCard('Recovery rate',`${a.recoveryRate}%`,'Recovered ÷ unique reports','↗')}</div><div class="insights-grid"><section class="panel chart-panel"><div class="panel-heading"><div><div class="eyebrow">REPORT MIX</div><h3>Reports by category</h3></div><span class="chart-unit">Unique reports</span></div>${a.byCategory.length?`<div class="bar-chart">${a.byCategory.map(item=>`<div class="bar-row"><span>${esc(item.category)}</span><div class="bar-track"><i style="width:${Math.max(5,item.count/max*100)}%"></i></div><b>${item.count}</b></div>`).join('')}</div>`:empty('▥','No category data yet','Reports will appear here after submission.')}</section><section class="panel chart-panel"><div class="panel-heading"><div><div class="eyebrow">WHERE REPORTS HAPPEN</div><h3>Frequent campus areas</h3></div><button class="text-button" data-page="map">Open map →</button></div>${a.byLocation.length?a.byLocation.map((item,index)=>`<div class="location-stat"><span class="rank-position">${String(index+1).padStart(2,'0')}</span><b>${esc(item.location.name)}</b><span>${item.lost} lost · ${item.found} found</span><strong>${item.count}</strong></div>`).join(''):empty('⌖','No area activity','Area counts are generalized to protect submitted locations.')}</section></div><div class="insights-grid trend-grid">${trendPanel('Weekly reports',a.weekly)}${trendPanel('Monthly reports',a.monthly)}</div><div class="stats-footnote"><span>Recovery rate definition</span><p>Confirmed handovers ÷ unique lost and found reports in the selected period. Claims, possible matches, and custody acceptance do not count as recovery.</p></div><div class="backlog-row">${statCard('Average time to recovery',a.averageDays!==null?`${a.averageDays} days`:'—','Report to confirmed handover','◷')}${statCard('Sensitive review backlog',latest,'Found reports awaiting staff review','▤')}${statCard('Official custody backlog',custodyBacklog,'Custody records not released','▣')}</div>`;
}
function trendPanel(title,series){const max=Math.max(1,...series.map(x=>x.count));return `<section class="panel chart-panel trend-panel"><div class="panel-heading"><div><div class="eyebrow">REPORTS OVER TIME</div><h3>${title}</h3></div><span class="chart-unit">Number of reports</span></div>${series.length?`<div class="trend-bars">${series.slice(-8).map(x=>`<div class="trend-col"><b>${x.count}</b><i style="height:${Math.max(4,x.count/max*100)}%"></i><small>${esc(x.period)}</small></div>`).join('')}</div><div class="axis-caption">Period · count of unique non-duplicate reports</div>`:empty('▥','No time-series data','Reports will appear here when submitted.')}</section>`;}
function activityPage(){
  const mine=state.data.reports.filter(report=>ownsRecord(report.owner)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const myClaims=state.data.claims.filter(claim=>ownsRecord(claim.owner)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const notices=currentNotifications().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return `${pageTitle('YOUR RECORDS','My activity','Your reports, claims, notifications, and next steps.')}<div class="activity-tabs"><button class="active" data-activity-tab="reports">My reports <span>${mine.length}</span></button><button data-activity-tab="claims">Claims <span>${myClaims.length}</span></button><button data-activity-tab="notifications">Notifications <span>${notices.filter(n=>!n.read).length}</span></button></div><div id="activity-content">${activityContent('reports',mine,myClaims,notices)}</div>`;
}
function activityCard(report){
  const projected=publicReport(report);
  if(projected)return cardReport(report);
  if(!ownsRecord(report.owner))return '';
  const image=String(report.image||'').startsWith('data:image/')?'<img src="'+esc(report.image)+'" alt="Your submitted item photo">':'<span>'+(report.kind==='lost'?'⌕':'＋')+'</span>';
  return '<article class="report-card private-activity-card"><div class="report-thumb '+esc(report.kind)+'">'+image+'</div><div class="report-info"><div class="report-topline"><span class="kind-tag '+esc(report.kind)+'">'+esc(report.kind==='lost'?'LOST':'FOUND')+'</span>'+statusPill(report.status)+'</div><h3>'+esc(report.itemType||report.category||'Item report')+'</h3><p>'+esc(report.publicDescription||report.description||'Private report awaiting review')+'</p><div class="report-meta"><span>◷ '+dateLabel(report.date)+'</span></div></div></article>';
}
function activityContent(tab,mine,myClaims,notices){
  if(tab==='claims')return myClaims.length?`<div class="case-list">${myClaims.map(claim=>{const report=state.data.reports.find(item=>item.id===claim.reportId);return `<article class="case-card"><div class="case-id">${esc(claim.id.slice(-8).toUpperCase())}</div><div class="case-main"><div class="case-title"><b>${esc(publicReport(report)?.itemType||'Restricted item')}</b>${statusPill(claim.status)}</div><p>Submitted ${ago(claim.createdAt)} · ${esc(claim.reportId)}</p>${claim.status==='More information required'?`<button class="text-button" data-add-evidence="${claim.id}">Add information →</button>`:''}</div>${button('Open conversation','btn-secondary',`data-open-conversation="${claim.id}"`)}${report?button('View item','btn-quiet',`data-open-report="${report.id}"`):''}</article>`;}).join('')}</div>`:empty('◇','No claims yet','When you find an eligible published item, open it to submit a private claim.');
  if(tab==='notifications')return notices.length?`<div class="notification-list">${notices.map(notice=>`<button class="notification ${notice.read?'':'unread'}" data-notification="${notice.id}" ${notice.claimId?`data-open-conversation="${notice.claimId}"`:notice.reportId?`data-open-report="${notice.reportId}"`:''}><span class="notification-mark">${notice.read?'○':'●'}</span><span><b>${esc(notice.message)}</b><small>${ago(notice.createdAt)} · Campus FindIt</small></span></button>`).join('')}</div>`:empty('♧','You’re all caught up','Participant-specific notifications will show here.');
  return mine.length?`<div class="report-list">${mine.map(report=>`<div class="activity-report">${activityCard(report)}<small class="private-activity-location">Your submitted landmark: ${esc(loc(report.locationId)?.name||report.locationName||'Not recorded')}${report.locationDetail?` · ${esc(report.locationDetail)}`:''}</small><div class="activity-actions">${report.status!=='recovered'?`<button class="text-button" data-withdraw="${report.id}">Withdraw</button>`:''}<button class="text-button" data-report-detail="${report.id}">Details →</button></div></div>`).join('')}</div>`:empty('◷','No reports yet','Your lost and found reports will appear here.',button('Create a report','btn-primary','data-page="report"'));
}

function claimActionButtons(claim){
  const labels={
    [CLAIM_STATUS.UNDER_REVIEW]:'Start / continue review',
    [CLAIM_STATUS.NEEDS_INFORMATION]:'Request more information',
    [CLAIM_STATUS.ACCEPTED]:'Approve for in-person check',
    [CLAIM_STATUS.DISPUTED]:'Route to human review',
    [CLAIM_STATUS.REJECTED]:'Reject claim'
  };
  return allowedClaimTransitions(claim.status).filter(status=>labels[status]).map(status=>button(labels[status],status===CLAIM_STATUS.REJECTED?'btn-quiet danger':status===CLAIM_STATUS.ACCEPTED?'btn-primary':'btn-secondary',`data-claim-action="${claim.id}" data-status="${status}"`)).join('');
}

function adminPage(){if(state.role!=='staff')return `${pageTitle('DEMO STAFF WORKSPACE','Authorized staff','Switch to the staff demo role to review cases and manage custody.')}<div class="panel access-panel"><div class="access-icon">⚙</div><h2>Staff workspace</h2><p>This area demonstrates staff-only workflows. The role switcher simulates a role locally and is not real authentication.</p>${button('Switch to demo staff','btn-primary','id="role-switch-inline"')}</div>`;const pending=state.data.reports.filter(r=>r.kind==='found'&&!r.approved&&!['withdrawn','rejected','closed'].includes(r.status));const allClaims=state.data.claims.slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));const dup=state.data.reports.flatMap(r=>duplicateCandidates(r,state.data.reports).map(d=>({r,d}))).filter((x,i,a)=>a.findIndex(y=>`${y.r.id}|${y.d.id}`===`${x.r.id}|${x.d.id}`)<0);return `${pageTitle('STAFF DEMO ROLE','Admin & review','Review reports, resolve claims, and record custody and handover.',`<button class="btn-secondary" id="export-data">Export local data</button> <label class="btn-secondary import-label">Import data<input id="import-data" type="file" accept="application/json" hidden></label>`)}<div class="admin-summary">${statCard('Reports to review',pending.length,'Found item submissions','◷')}${statCard('Claims to review',allClaims.filter(c=>!['Recovered','Rejected'].includes(c.status)).length,'Open claims','◇')}${statCard('Possible duplicates',dup.length,'Review before linking','↔')}${statCard('Audit events',state.data.audit.length,'Recorded actions','▤')}</div><div class="section-head"><div><div class="eyebrow">PUBLICATION REVIEW</div><h2>Found reports</h2></div></div>${pending.length?`<div class="admin-list">${pending.map(r=>`<article class="admin-row"><div class="admin-item"><span class="report-thumb found">＋</span><div><b>${esc(r.itemType)} · ${esc(r.category)}</b><small>${esc(loc(r.locationId)?.name)} · ${dateLabel(r.date)} · ${policyFor(r.category,r.value,r.itemType).label}</small><small>Public description: ${esc(r.publicDescription||r.description)}</small></div></div><div class="admin-actions"><button class="btn-secondary" data-open-report="${r.id}">Review details</button><button class="btn-primary" data-approve-report="${r.id}">Approve & publish</button><button class="text-button danger" data-reject-report="${r.id}">Reject</button></div></article>`).join('')}</div>`:empty('✓','Review queue is clear','New found reports appear here until staff review them.')}<div class="section-head"><div><div class="eyebrow">CLAIM REVIEW</div><h2>Ownership claims</h2></div></div>${allClaims.length?`<div class="case-list">${allClaims.map(c=>{const r=state.data.reports.find(x=>x.id===c.reportId);return `<article class="case-card"><div class="case-id">${esc(c.id.slice(-8).toUpperCase())}</div><div class="case-main"><div class="case-title"><b>${esc(r?.itemType||'Missing report')}</b>${statusPill(c.status)}</div><p>${esc(c.reportId)} · submitted ${ago(c.createdAt)}</p><div class="claim-evidence"><b>Claimant explanation</b><span>${esc(c.explanation)}</span><b>Private ownership details</b><span>${esc(c.evidence||'No additional evidence provided')}</span></div>${c.extraEvidence?`<small>Follow-up: ${esc(c.extraEvidence)}</small>`:''}</div><div class="admin-actions">${claimActionButtons(c)||'<small class="muted">Read-only history</small>'}</div></article>`;}).join('')}</div>`:empty('◇','No claims to review','Submitted claims appear here for staff review.') }<div class="section-head"><div><div class="eyebrow">OFFICIAL CUSTODY</div><h2>Custody & handover</h2></div></div>${custodyPanel() }<div class="section-head"><div><div class="eyebrow">QUALITY REVIEW</div><h2>Possible duplicate reports</h2></div></div>${dup.length?dup.slice(0,8).map(x=>`<div class="duplicate-row"><span>${esc(x.r.id)} · ${esc(x.r.itemType)}</span><span>may overlap with</span><span>${esc(x.d.id)} · ${esc(x.d.itemType)}</span><button class="btn-secondary" data-link-duplicate="${x.r.id}" data-duplicate-target="${x.d.id}">Link duplicate</button></div>`).join(''):empty('↔','No likely duplicates','Possible duplicates are identified by category, time, and location.')}<div class="section-head"><div><div class="eyebrow">CONFIGURATION</div><h2>Campus landmarks</h2></div></div><div class="panel landmark-config">${LOCATIONS.map(l=>`<span><b>${esc(l.name)}</b><small>${esc(l.type)} · ${l.x}, ${l.y}</small></span>`).join('')}</div><div class="reset-panel"><div><b>Local data tools</b><small>Export a versioned JSON backup or reset this browser’s records.</small></div><button class="btn-quiet danger" id="reset-data">Reset all local data</button></div>`;}
function custodyPanel(){const eligible=state.data.claims.filter(c=>c.status==='Approved for in-person verification'||c.status==='Handover pending'||c.status==='Recovered');if(!eligible.length)return empty('▣','No handovers ready','A staff-approved claim will appear here for custody and in-person verification.');return `<div class="custody-list">${eligible.map(c=>{const r=state.data.reports.find(x=>x.id===c.reportId);let record=state.data.custody.find(x=>x.claimId===c.id);const canCheck=state.role==='staff'&&c.status==='Handover pending'&&record?.status==='in custody';return `<article class="custody-card"><div class="custody-heading"><div><b>${esc(r?.itemType||'Found item')} · ${esc(r?.id)}</b><small>Claim ${esc(c.id)} · ${policyFor(r?.category,r?.value,r?.itemType).label}</small></div>${statusPill(c.status)}</div>${record?`<p>Custody ref <b>${esc(record.id)}</b> · received ${dateLabel(record.receivedAt.slice(0,10))} · custodian ${esc(record.custodian)}</p>`:''}<div class="checklist"><label><input type="checkbox" data-check="identity" data-claim="${c.id}" ${record?.identityChecked?'checked':''} ${canCheck?'':'disabled'}> In-person identity and ownership check completed</label><label><input type="checkbox" data-check="item" data-claim="${c.id}" ${record?.itemChecked?'checked':''} ${canCheck?'':'disabled'}> Item condition and custody reference confirmed</label><label><input type="checkbox" data-check="ack" data-claim="${c.id}" ${record?.recipientAcknowledged?'checked':''} ${canCheck?'':'disabled'}> Recipient acknowledgement recorded</label></div>${!record?button('Accept into official custody','btn-secondary',`data-create-custody="${c.id}"`):''}${record&&c.status!=='Recovered'?button('Complete handover & mark recovered','btn-primary',`data-handover="${c.id}"`):''}${c.status==='Recovered'?`<div class="recovered-note">✓ Handover completed and recorded</div>`:''}</article>`;}).join('')}</div>`;}

function participantsForClaim(claim){
  const report=state.data.reports.find(item=>item.id===claim?.reportId);
  const normalizedClaim=claim?{...claim,owner:normalizedOwner(claim.owner)}:claim,normalizedReport=report?{...report,owner:normalizedOwner(report.owner)}:report;
  const ids=participantIdsForClaim(normalizedClaim,normalizedReport);
  return ids?{...ids,report}:null;
}
function canAccessConversation(claim,role=state.role){
  if(!['student','finder'].includes(role))return false;
  const participants=participantsForClaim(claim);
  return !!participants&&mayAccessConversation({...claim,owner:normalizedOwner(claim.owner)},{...participants.report,owner:normalizedOwner(participants.report.owner)},actorId(role));
}
function claimConversationsForRole(role=state.role){
  if(!['student','finder'].includes(role))return [];
  return state.data.claims.filter(claim=>canAccessConversation(claim,role)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
async function openConversation(claimId){
  const claim=state.data.claims.find(item=>item.id===claimId);
  if(!claim||!canAccessConversation(claim)){toast('This conversation is not available to the current demo participant.');return;}
  const unread=state.data.messages.filter(message=>message.claimId===claim.id&&message.reportId===claim.reportId&&message.toId===actorId()&&!message.readAt?.[actorId()]);
  if(unread.length){
    const entries=unread.map(message=>({store:'messages',record:{...message,readAt:{...(message.readAt||{}),[actorId()]:now()}}}));
    try{await commitBundle(entries);}catch(error){toast(`Could not update unread messages. ${error?.message||'Storage error.'}`);}
  }
  state.openConversationId=claim.id;go('messages');
}
function claimDetail(claimId){
  const claim=state.data.claims.find(item=>item.id===claimId),participants=participantsForClaim(claim);
  if(!claim||!participants||!canAccessConversation(claim)){toast('This claim is not available to the current demo participant.');return;}
  const publicItem=publicReport(participants.report),isClaimant=ownsRecord(claim.owner),privateExplanation=isClaimant?claim.explanation:null;
  openModal('Related claim',`<div class="detail-layout"><span class="kind-tag found">FOUND ITEM</span><h3>${esc(publicItem?.itemType||'Restricted item')}</h3><p>Claim status: <b>${esc(claim.status)}</b></p><p>Claim reference: ${esc(claim.id)}</p>${privateExplanation?`<div class="restricted-box"><b>Your submitted explanation</b><p>${esc(privateExplanation)}</p>${claim.evidence?`<p>Private verification details: ${esc(claim.evidence)}</p>`:''}</div>`:''}<p>Exact locations and internal verification notes are not shown in this conversation view.</p></div>`,button('Open conversation','btn-primary',`data-open-conversation="${claim.id}"`));
  modal.querySelector('[data-open-conversation]')?.addEventListener('click',()=>openConversation(claim.id));
}
function messageConversation(claim){
  const participants=participantsForClaim(claim),report=participants?.report;
  if(!participants||!canAccessConversation(claim))return empty('✉','Conversation unavailable','This local conversation is not linked to your demo participant.');
  const ownId=actorId(),isClaimant=ownId===participants.claimantId;
  const item=publicReport(report),title=ownsRecord(report.owner)?report.itemType:(item?.itemType||'Restricted item');
  const history=orderedConversationMessages(state.data.messages,claim.id,report.id);
  const canSend=![CLAIM_STATUS.REJECTED,CLAIM_STATUS.RECOVERED].includes(claim.status)&&report.status!=='recovered'&&report.status!=='withdrawn';
  return `<section class="panel conversation-panel"><div class="conversation-header"><div><div class="eyebrow">CLAIM CONVERSATION</div><h2>${esc(title)}</h2><p>${isClaimant?'You are the claimant · Demo finder':'You are the finder · Demo claimant'} · ${esc(claim.status)}</p></div><div class="conversation-actions"><button class="btn-secondary" data-back-inbox>Inbox</button><button class="btn-quiet" data-return-claim="${claim.id}">Related claim</button></div></div><div class="conversation-context"><span>Found report ${esc(report.id)}</span><span>Local demo conversation · stored in this browser profile</span></div><div class="message-history" aria-live="polite">${history.length?history.map(message=>`<article class="message-bubble ${message.fromId===ownId?'mine':''}"><div class="message-meta"><b>${message.fromId===ownId?'You':message.senderRole==='finder'?'Demo finder':'Demo claimant'}</b><time>${esc(new Date(message.createdAt).toLocaleString())}</time></div><p>${esc(message.text)}</p></article>`).join(''):empty('✉','No messages yet','Use this thread to arrange a safe next step. Do not send sensitive identity information.')}</div>${canSend?`<form id="message-form" data-claim="${claim.id}"><label for="message-text">Message</label><textarea id="message-text" name="text" maxlength="1000" rows="3" required placeholder="Write a message to the other participant"></textarea><div id="message-error" role="alert" class="form-error" hidden></div><div class="message-compose-footer"><small>Up to 1,000 characters. Local demo only; not delivered to another device.</small><button type="submit" class="btn-primary">Send message →</button></div></form>`:`<p class="workflow-note">This conversation is read-only because the claim is ${esc(claim.status.toLowerCase())}.</p>`}</section>`;
}
function messagesPage(){
  const conversations=claimConversationsForRole();
  const selected=state.openConversationId?conversations.find(claim=>claim.id===state.openConversationId):null;
  if(selected)return `${pageTitle('PRIVATE CASE DISCUSSION','Messages','Only the demo claimant and finder can open this claim conversation.')} ${messageConversation(selected)}`;
  const rows=conversations.map(claim=>{const participants=participantsForClaim(claim),report=participants.report;const publicItem=publicReport(report);const title=ownsRecord(report.owner)?report.itemType:(publicItem?.itemType||'Restricted item');const history=orderedConversationMessages(state.data.messages,claim.id,report.id).reverse();const unread=history.filter(message=>message.toId===actorId()&&!message.readAt?.[actorId()]).length;return `<article class="conversation-row"><div class="conversation-avatar">${state.role==='finder'?'C':'F'}</div><div class="conversation-summary"><b>${esc(title)}</b><small>${state.role==='finder'?'Claimant':'Finder'} · ${esc(claim.status)} · ${history.length?`${history.length} message${history.length===1?'':'s'}`:'No messages yet'}</small></div>${unread?`<span class="unread-count">${unread}</span>`:''}<button class="btn-secondary" data-open-conversation="${claim.id}">Open</button></article>`;}).join('');
  return `${pageTitle('PRIVATE CASE DISCUSSION','Messages','A local conversation is tied to its claim and found report. Messages are not shared across devices.')}<section class="panel inbox-panel"><div class="panel-heading"><div><div class="eyebrow">YOUR CONVERSATIONS</div><h3>${conversations.length} conversation${conversations.length===1?'':'s'}</h3></div></div>${rows||empty('✉','No conversations yet','Submit a claim for a published found report, or switch to the demo finder to review a claimant message.')}</section>`;
}
async function sendMessage(event){
  event.preventDefault();
  const form=event.currentTarget,claim=state.data.claims.find(item=>item.id===form.dataset.claim),participants=participantsForClaim(claim),report=participants?.report;
  if(!claim||!participants||!canAccessConversation(claim)){toast('This conversation is not available to the current demo participant.');return;}
  if([CLAIM_STATUS.REJECTED,CLAIM_STATUS.RECOVERED].includes(claim.status)||report.status==='recovered'||report.status==='withdrawn'){toast('This conversation is read-only.');return;}
  const validation=validateMessageText(new FormData(form).get('text'));
  const errorElement=form.querySelector('#message-error');
  if(!validation.valid){errorElement.textContent=validation.error;errorElement.hidden=false;return;}
  const senderId=actorId(),senderRole=senderId===participants.claimantId?'claimant':'finder',toId=senderRole==='claimant'?participants.finderId:participants.claimantId;
  const message={id:uid('message'),claimId:claim.id,reportId:report.id,fromId:senderId,toId,senderRole,text:validation.value,createdAt:now(),readAt:{}};
  const submit=form.querySelector('[type="submit"]');submit.disabled=true;
  const entries=[{store:'messages',record:message},{store:'notifications',record:notificationRecord('New message about an ownership claim.',report.id,toId,claim.id)},{store:'audit',record:auditRecord('Claim message sent',claim.id,'A local claim message was sent.')}];
  try{await commitBundle(entries);render();toast('Message sent in this browser.');}
  catch(error){submit.disabled=false;errorElement.textContent=`Message was not saved. ${error?.message||'Storage error. Retry when storage is available.'}`;errorElement.hidden=false;}
}

function render(){const page={home:homePage,map:mapPage,find:findPage,report:reportPage,recovery:recoveryPage,messages:messagesPage,insights:insightsPage,activity:activityPage,admin:adminPage}[state.page]||homePage;app.innerHTML=layout(page());bind();bindMapPan();scaleMap();}
function openModal(title,body,actions=''){modal.innerHTML=`<div class="modal-head"><div><div class="eyebrow">CAMPUS FINDIT</div><h2 id="modal-title">${title}</h2></div><button class="icon-button" data-close-modal aria-label="Close">×</button></div><div class="modal-body">${body}</div>${actions?`<div class="modal-actions">${actions}</div>`:''}`;modal.querySelector('[data-close-modal]').addEventListener('click',closeModal);modal.showModal();}
function closeModal(){modal.close();}
async function showReport(id){
  const report=state.data.reports.find(item=>item.id===id);
  if(!report){toast('That report could not be found.');return;}
  const projection=publicReport(report),own=ownsRecord(report.owner),staff=state.role==='staff';
  if(!projection&&!staff&&!own){toast('This report is not available publicly.');return;}
  const canSeePrivate=own||staff;
  const title=canSeePrivate?(report.itemType||report.category):(projection?.itemType||projection?.category||'Restricted item');
  const description=canSeePrivate?(report.publicDescription||report.description):(projection?.description||'');
  const area=canSeePrivate?(loc(report.locationId)?.name||report.locationName||'Campus'):projection?.zoneName||'Campus';
  const image=canSeePrivate?report.image:projection?.image;
  const relatedClaim=state.data.claims.find(claim=>claim.reportId===report.id&&ownsRecord(claim.owner,'student'));
  const claimEligible=state.role==='student'&&report.kind==='found'&&projection&& !ownsRecord(report.owner,'student')&&!['recovered','withdrawn','closed'].includes(report.status);
  const matches=report.kind==='lost'?state.data.reports.filter(found=>found.kind==='found'&&found.approved&&isOpen(found)).map(found=>({found,...publicMatch(report,found)})).filter(item=>item.score>=35).sort((a,b)=>b.score-a.score):[];
  const body=`<div class="detail-layout">${image?`<img class="detail-image" src="${image}" alt="Item photo">`:''}<div class="detail-tags"><span class="kind-tag ${report.kind}">${report.kind.toUpperCase()}</span>${statusPill(report.status)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p><div class="detail-meta"><span>⌖ ${esc(area)}</span><span>◷ ${dateLabel(report.date)}</span><span>Report ${esc(report.id)}</span></div>${report.kind==='found'&&report.approved&&report.status!=='recovered'?`<div class="privacy-callout"><span>◈</span><div><b>Found item privacy</b><p>Unique identifying details and exact landmarks stay private during discovery.</p></div></div>`:''}${staff?`<div class="restricted-box"><b>Staff restricted view · local demo only</b><p>Private clue: ${esc(report.privateClue||'No private clue supplied')}</p><p>Exact landmark: ${esc(loc(report.locationId)?.name||report.locationName||'Not provided')}</p><p>Additional location detail: ${esc(report.locationDetail||'Not provided')}</p><p>Handling: ${esc(report.handling||'Not specified')} · Value: ${esc(report.value||'Not specified')}</p></div>`:own?`<div class="restricted-box"><b>Your private report details</b><p>Exact landmark: ${esc(loc(report.locationId)?.name||report.locationName||'Not provided')}</p><p>Additional location detail: ${esc(report.locationDetail||'Not provided')}</p>${report.privateClue?`<p>Your private clue: ${esc(report.privateClue)}</p>`:''}</div>`:''}${relatedClaim&&canAccessConversation(relatedClaim)?`<div class="claim-status-note"><b>Your claim: ${esc(relatedClaim.status)}</b>${button('Open conversation','btn-secondary',`data-open-conversation="${relatedClaim.id}"`)}</div>`:''}${claimEligible&&!relatedClaim?`<form id="claim-form" data-report="${esc(report.id)}"><h4>Think this could be yours?</h4><label>Why do you believe this is your item? <span>*</span><textarea name="explanation" rows="3" maxlength="500" minlength="10" required placeholder="Share enough context for staff to review."></textarea></label><label>Private distinguishing details <small>shown to staff only</small><textarea name="evidence" rows="2" maxlength="500" placeholder="Add a detail that can help verify ownership"></textarea></label><button class="btn-primary" type="submit">Submit ownership claim →</button></form>`:''}${report.kind==='found'&&ownsRecord(report.owner)&&state.role==='student'?`<p class="muted">This report belongs to your current demo identity, so it cannot be claimed by you.</p>`:''}${matches.length?`<div class="possible-matches"><h4>Possible found reports</h4>${matches.map(item=>`<button data-open-report="${esc(item.found.id)}"><b>${esc(publicReport(item.found)?.itemType||'Restricted item')}</b><small>${item.score} points · ${publicMatchFactors(report,item.found).join(' · ')}</small>→</button>`).join('')}</div>`:''}</div>`;
  openModal(`${report.kind==='lost'?'Lost':'Found'} item`,body);
  modal.querySelectorAll('[data-open-conversation]').forEach(button=>button.addEventListener('click',()=>openConversation(button.dataset.openConversation)));
  modal.querySelectorAll('[data-open-report]').forEach(button=>button.addEventListener('click',()=>showReport(button.dataset.openReport)));
  modal.querySelector('.detail-layout')?.addEventListener('submit',async event=>{
    if(event.target.id!=='claim-form')return;
    event.preventDefault();
    const form=event.currentTarget;
    if(form.dataset.submitting==='true')return;
    const claimantId=actorId(),claims=state.data.claims.map(claim=>({...claim,owner:normalizedOwner(claim.owner)}));
    const reason=validateClaimCreation({...report,owner:normalizedOwner(report.owner)},claimantId,claims);
    if(reason){toast(reason);return;}
    const data=new FormData(event.target),explanation=String(data.get('explanation')||'').trim(),evidence=String(data.get('evidence')||'').trim();
    if(explanation.length<10||explanation.length>500){toast('Please provide 10 to 500 characters explaining why this item is yours.');return;}
    const claim={id:uid('claim'),reportId:report.id,owner:claimantId,explanation,evidence,status:CLAIM_STATUS.SUBMITTED,createdAt:now(),updatedAt:now()};
    form.dataset.submitting='true';
    const submit=form.querySelector('[type="submit"]');if(submit)submit.disabled=true;
    const entries=[{store:'claims',record:claim},{store:'audit',record:auditRecord('Claim submitted',claim.id,'Ownership claim submitted.')},{store:'notifications',record:notificationRecord('A new ownership claim needs review.',report.id,normalizedOwner(report.owner),claim.id)}];
    try{await commitBundle(entries);}catch(error){delete form.dataset.submitting;if(submit)submit.disabled=false;toast('Could not save claim. No claim data was committed. '+(error?.message||'Storage error.'));return;}
    openModal('Claim submitted',`<div class="success-mark">✓</div><p>Your claim is saved and waiting for review.</p><div class="reference-box"><small>CLAIM STATUS</small><b>${esc(claim.status)}</b></div><p>Continue the ownership discussion in the local demo conversation.</p>`,button('Open conversation','btn-primary','id="claim-open-conversation"'));
    modal.querySelector('#claim-open-conversation')?.addEventListener('click',()=>openConversation(claim.id));
  });
}
function bind(){
  app.querySelectorAll('[data-page]').forEach(element=>element.addEventListener('click',()=>go(element.dataset.page)));
  app.querySelectorAll('[data-report-kind]').forEach(element=>element.addEventListener('click',()=>{state.kind=element.dataset.reportKind;if(state.page!=='report')go('report');else render();}));
  app.querySelectorAll('[data-open-report]').forEach(element=>element.addEventListener('click',()=>showReport(element.dataset.openReport)));
  app.querySelectorAll('[data-open-conversation]').forEach(element=>element.addEventListener('click',()=>openConversation(element.dataset.openConversation)));
  app.querySelectorAll('[data-back-inbox]').forEach(element=>element.addEventListener('click',()=>{state.openConversationId=null;render();}));
  app.querySelectorAll('[data-return-claim]').forEach(element=>element.addEventListener('click',()=>claimDetail(element.dataset.returnClaim)));
  document.querySelectorAll('[data-close-modal]').forEach(element=>element.addEventListener('click',closeModal));
  const setRole=role=>{if(!isDemoRole(role))return;state.role=role;localStorage.setItem('cfi-role',role);state.openConversationId=null;render();toast(`Now viewing as ${roleLabel(role).toLowerCase()}.`);};
  const switchRole=()=>setRole(({student:'finder',finder:'staff',staff:'student'})[state.role]||'student');
  app.querySelector('#role-switch')?.addEventListener('click',switchRole);
  app.querySelector('#role-switch-top')?.addEventListener('click',switchRole);
  app.querySelector('#role-switch-inline')?.addEventListener('click',()=>setRole('staff'));
  app.querySelector('#bell')?.addEventListener('click',()=>{go('activity');setTimeout(()=>app.querySelector('[data-activity-tab="notifications"]')?.click(),0);});
  app.querySelector('#report-form')?.addEventListener('submit',submitReport);
  app.querySelector('#message-form')?.addEventListener('submit',sendMessage);
  app.querySelector('#report-image-input')?.addEventListener('change',handleReportImageSelection);
  app.querySelector('#remove-report-image')?.addEventListener('click',()=>discardReportImage());updateReportImageUI();
  app.querySelector('#search-query')?.addEventListener('input',event=>{state.filters.query=event.target.value;const position=event.target.selectionStart;render();const input=app.querySelector('#search-query');input?.focus();input?.setSelectionRange(position,position);});
  app.querySelectorAll('.filters-panel select').forEach(select=>select.addEventListener('change',()=>{state.filters[select.name]=select.value;render();}));
  app.querySelector('#clear-filters')?.addEventListener('click',()=>{state.filters={kind:'all',category:'all',location:'all',status:'all',query:''};render();});
  app.querySelectorAll('[data-map-mode]').forEach(element=>element.addEventListener('click',()=>{state.mapMode=element.dataset.mapMode;render();}));
  app.querySelectorAll('[data-map-layer]').forEach(element=>element.addEventListener('click',()=>{state.mapLayer=element.dataset.mapLayer;render();}));
  app.querySelector('.map-extra-filters select[name="category"]')?.addEventListener('change',event=>{state.mapCategory=event.target.value;render();});
  app.querySelector('.map-extra-filters select[name="status"]')?.addEventListener('change',event=>{state.mapStatus=event.target.value;render();});
  app.querySelector('#map-date-from')?.addEventListener('change',event=>{state.mapSince=event.target.value||null;render();});
  app.querySelector('#map-search')?.addEventListener('input',event=>{state.mapQuery=event.target.value;const position=event.target.selectionStart;render();const input=app.querySelector('#map-search');input?.focus();input?.setSelectionRange(position,position);});
  app.querySelectorAll('[data-map-location]').forEach(element=>element.addEventListener('click',()=>{state.mapSelected=element.dataset.mapLocation;render();}));
  app.querySelector('#clear-location')?.addEventListener('click',()=>{state.mapSelected=null;render();});
  app.querySelector('#zoom-in')?.addEventListener('click',()=>{state.zoom=Math.min(1.5,state.zoom+.1);scaleMap();});
  app.querySelector('#zoom-out')?.addEventListener('click',()=>{state.zoom=Math.max(.75,state.zoom-.1);scaleMap();});
  app.querySelector('#map-reset')?.addEventListener('click',()=>{state.zoom=1;state.panX=0;state.panY=0;state.mapSelected=null;state.mapQuery='';state.mapSince=null;render();});
  app.querySelectorAll('[data-map-report]').forEach(element=>element.addEventListener('click',()=>{state.kind='lost';go('report');app.querySelector('[name="locationId"]').value=element.dataset.mapReport;}));
  app.querySelectorAll('[data-filter-location]').forEach(element=>element.addEventListener('click',()=>{state.filters.location=element.dataset.filterLocation;go('find');}));
  app.querySelectorAll('[data-activity-tab]').forEach(element=>element.addEventListener('click',()=>{app.querySelectorAll('[data-activity-tab]').forEach(tab=>tab.classList.toggle('active',tab===element));const mine=state.data.reports.filter(report=>ownsRecord(report.owner)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const claims=state.data.claims.filter(claim=>ownsRecord(claim.owner)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const notices=currentNotifications().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));app.querySelector('#activity-content').innerHTML=activityContent(element.dataset.activityTab,mine,claims,notices);bindActivity();}));
  app.querySelectorAll('[data-approve-report]').forEach(element=>element.addEventListener('click',()=>setReportReview(element.dataset.approveReport,true)));
  app.querySelectorAll('[data-reject-report]').forEach(element=>element.addEventListener('click',()=>setReportReview(element.dataset.rejectReport,false)));
  app.querySelectorAll('[data-claim-action]').forEach(element=>element.addEventListener('click',()=>changeClaim(element.dataset.claimAction,element.dataset.status)));
  app.querySelectorAll('[data-create-custody]').forEach(element=>element.addEventListener('click',()=>createCustody(element.dataset.createCustody)));
  app.querySelectorAll('[data-check]').forEach(element=>element.addEventListener('change',()=>updateChecklist(element.dataset.claim,element.dataset.check,element.checked)));
  app.querySelectorAll('[data-handover]').forEach(element=>element.addEventListener('click',()=>completeHandover(element.dataset.handover)));
  app.querySelectorAll('[data-link-duplicate]').forEach(element=>element.addEventListener('click',()=>linkDuplicate(element.dataset.linkDuplicate,element.dataset.duplicateTarget)));
  app.querySelector('#export-data')?.addEventListener('click',exportBackup);app.querySelector('#import-data')?.addEventListener('change',importBackup);app.querySelector('#reset-data')?.addEventListener('click',resetData);
  app.querySelector('#date-from')?.addEventListener('change',updateInsightsDate);app.querySelector('#date-to')?.addEventListener('change',updateInsightsDate);
  app.querySelector('#hotspot-kind')?.addEventListener('change',event=>{state.hotspotKind=event.target.value;render();});
  app.querySelector('#hotspot-period')?.addEventListener('change',event=>{state.hotspotPeriod=event.target.value;render();});
  app.querySelector('#hotspot-threshold')?.addEventListener('change',event=>{state.hotspotThreshold=Math.max(HOTSPOT_MINIMUM,Number(event.target.value)||HOTSPOT_MINIMUM);render();});
  app.querySelectorAll('[data-withdraw]').forEach(element=>element.addEventListener('click',()=>withdrawReport(element.dataset.withdraw)));
  app.querySelectorAll('[data-report-detail]').forEach(element=>element.addEventListener('click',()=>showReport(element.dataset.reportDetail)));
  app.querySelectorAll('[data-add-evidence]').forEach(element=>element.addEventListener('click',()=>addEvidence(element.dataset.addEvidence)));
  app.querySelectorAll('[data-notification]').forEach(element=>element.addEventListener('click',()=>markRead(element.dataset.notification)));
}
  function scaleMap(){const svg=app.querySelector('#campus-map');if(svg)svg.style.transform=`translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;const n=app.querySelector('.map-controls span');if(n)n.textContent=`${Math.round(state.zoom*100)}%`;}
function bindMapPan(){const viewport=app.querySelector('.map-viewport');if(!viewport)return;let drag=null;viewport.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,moved:false};viewport.setPointerCapture(e.pointerId);});viewport.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;state.panX+=dx;state.panY+=dy;drag.x=e.clientX;drag.y=e.clientY;scaleMap();});viewport.addEventListener('pointerup',()=>{if(drag?.moved)state.mapDragged=true;drag=null;});viewport.addEventListener('pointercancel',()=>{drag=null;});viewport.addEventListener('click',e=>{if(!state.mapDragged)return;e.stopImmediatePropagation();state.mapDragged=false;},true);}
async function submitReport(event){
  event.preventDefault();
  const form=event.currentTarget;
  if(form.dataset.submitting==='true'||!form.reportValidity())return;
  form.dataset.submitting='true';
  const submit=form.querySelector('[type="submit"]');
  if(submit)submit.disabled=true;
  try{
    const data=new FormData(form);
    const file=state.reportImageFile||data.get('image');
    let image=null;
    if(file&&file.size){
      const validation=validateImageFile(file);
      if(!validation.valid){discardReportImage(validation.error);toast(validation.error);return;}
      try{image=await readImageFile(file);await verifyImageDataUrl(image);}
      catch(error){
        const message='Could not read the selected photo. Choose it again or remove it.';
        state.reportImageError=message;updateReportImageUI();toast(message);return;
      }
    }
    const kind=String(data.get('kind')||'');
    const category=String(data.get('category')||'');
    const itemType=String(data.get('itemType')||'').trim();
    const description=String(data.get('description')||'').trim();
    const date=String(data.get('date')||'');
    const location=loc(data.get('locationId'));
    const validDate=date&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(new Date(date+'T00:00:00').getTime());
    if(!['lost','found'].includes(kind)||!CATEGORIES.includes(category)||!itemType||!description||!validDate||!location){
      toast('Complete the required report fields and choose a valid date and campus landmark.');
      return;
    }
    const dateAtMidnight=new Date(date+'T00:00:00');
    const today=new Date();today.setHours(23,59,59,999);
    if(dateAtMidnight>today){toast('The report date cannot be in the future.');return;}
    const policy=policyFor(category,data.get('value'),itemType);
    const report={
      id:uid(kind),kind,category,itemType,brand:String(data.get('brand')||'').trim(),
      color:String(data.get('color')||'').trim(),date,time:String(data.get('time')||''),
      locationId:location.id,locationName:location.name,
      locationDetail:String(data.get('locationDetail')||'').trim(),description,
      publicDescription:description,privateClue:String(data.get('privateClue')||'').trim(),
      value:data.get('value')||'Less expensive',handling:data.get('handling')||'',image:image,
      status:kind==='found'?'under review':'open',approved:false,createdAt:now(),updatedAt:now(),
      policyLevel:policy.level,owner:actorId()
    };
    const duplicates=duplicateCandidates(report,state.data.reports);
    if(duplicates.length&&!confirm('This looks similar to '+duplicates[0].id+' near '+location.name+'. Submit anyway for staff review?'))return;
    try{await saveReport(report);}
    catch(error){toast('Could not save report. No report data was committed. '+(error?.message||'Storage error.'));return;}
    discardReportImage();
    const body='<div class="success-mark">✓</div><p>Your '+kind+' report has been saved in this browser.</p><div class="reference-box"><small>REPORT REFERENCE</small><b>'+esc(report.id)+'</b></div><p>'+(kind==='found'?'A staff reviewer will check this report before it is published.':'Your report is available in My activity and may be compared with approved found reports.')+'</p>';
    openModal('Report submitted',body,button('Go to My activity','btn-primary','id="success-activity"'));
    modal.querySelector('#success-activity')?.addEventListener('click',()=>{closeModal();go('activity');});
  }catch(error){
    toast('Could not submit report. No success was recorded. '+(error?.message||'Storage error.'));
  }finally{
    delete form.dataset.submitting;
    if(submit)submit.disabled=false;
  }
}
async function setReportReview(id,approved){
  if(state.role!=='staff'){toast('Staff role required.');return;}
  const current=state.data.reports.find(report=>report.id===id);
  if(!current||current.kind!=='found'||current.approved||['withdrawn','rejected','closed'].includes(current.status)){toast('This found report is no longer awaiting review.');return;}
  const report={...current,approved,status:approved?'active':'rejected',updatedAt:now()};
  const entries=[{store:'reports',record:report},{store:'audit',record:auditRecord(approved?'Found report approved':'Found report rejected',id)}];
  entries.push({store:'notifications',record:notificationRecord(approved?'Your found report was approved for discovery.':'Your found report was rejected after review.',id,normalizedOwner(current.owner))});
  if(approved){
    const candidates=state.data.reports.filter(lost=>lost.kind==='lost'&&isOpen(lost)).map(lost=>({lost,...publicMatch(lost,report)})).filter(match=>match.score>=45);
    for(const match of candidates)entries.push({store:'notifications',record:notificationRecord('A possible match is available for your lost report.',match.lost.id,normalizedOwner(match.lost.owner))});
  }
  try{await commitBundle(entries);render();toast(approved?'Report approved and published.':'Report rejected.');}
  catch(error){toast(`Could not update report review. No review changes were committed. ${error?.message||'Storage error.'}`);}
}
async function changeClaim(id,status){
  const current=state.data.claims.find(claim=>claim.id===id),report=state.data.reports.find(item=>item.id===current?.reportId);
  const claims=state.data.claims.map(claim=>({...claim,owner:normalizedOwner(claim.owner)}));
  const currentNormalized=current?{...current,owner:normalizedOwner(current.owner)}:null;
  const reason=validateClaimTransition(currentNormalized,status,{actorRole:state.role,actorId:actorId(),report,claims});
  if(reason){toast(reason);return;}
  const claim={...current,status,updatedAt:now()};
  const notice=status===CLAIM_STATUS.NEEDS_INFORMATION?'Staff requested more information for your claim.':status===CLAIM_STATUS.REJECTED?'Your ownership claim was not approved.':status===CLAIM_STATUS.DISPUTED?'Your claim needs additional human review.':'Your ownership claim status was updated.';
  const entries=[{store:'claims',record:claim},{store:'audit',record:auditRecord(`Claim status changed to ${status}`,id)},{store:'notifications',record:notificationRecord(notice,report.id,normalizedOwner(claim.owner),claim.id)}];
  try{await commitBundle(entries);render();toast('Claim status updated.');}
  catch(error){toast(`Could not update claim. No status changes were committed. ${error?.message||'Storage error.'}`);}
}
async function createCustody(claimId){
  if(state.role!=='staff'){toast('Staff role required.');return;}
  const claim=state.data.claims.find(item=>item.id===claimId),report=state.data.reports.find(item=>item.id===claim?.reportId);
  if(!claim||!report||report.kind!=='found'||!report.approved||!['active','open'].includes(report.status)||claim.status!==CLAIM_STATUS.ACCEPTED){toast('An approved found report and staff-approved claim are required before custody.');return;}
  if(state.data.claims.some(other=>other.id!==claimId&&other.reportId===report.id&&[CLAIM_STATUS.HANDOVER_PENDING,CLAIM_STATUS.RECOVERED].includes(other.status))){toast('Another claim already has an active or completed handover for this item.');return;}
  const current=state.data.custody.find(record=>record.claimId===claimId);
  if(current?.status==='released'){toast('This item has already been handed over.');return;}
  const custody=current?{...current,status:'in custody',updatedAt:now()}:{id:uid('custody'),claimId,reportId:report.id,custodian:'Demo campus staff',status:'in custody',receivedAt:now(),identityChecked:false,itemChecked:false,recipientAcknowledged:false,updatedAt:now()};
  const reason=validateClaimTransition({...claim,owner:normalizedOwner(claim.owner)},CLAIM_STATUS.HANDOVER_PENDING,{actorRole:state.role,actorId:actorId(),report,claims:state.data.claims.map(item=>({...item,owner:normalizedOwner(item.owner)}))});
  if(reason){toast(reason);return;}
  const nextClaim={...claim,status:CLAIM_STATUS.HANDOVER_PENDING,updatedAt:now()};
  const entries=[{store:'custody',record:custody},{store:'claims',record:nextClaim},{store:'audit',record:auditRecord('Item accepted into official custody',custody.id)},{store:'notifications',record:notificationRecord('The found item entered official custody for an in-person handover.',report.id,normalizedOwner(claim.owner),claim.id)}];
  try{await commitBundle(entries);render();toast('Custody record created.');}
  catch(error){toast(`Could not create custody record. No custody changes were committed. ${error?.message||'Storage error.'}`);}
}
async function updateChecklist(claimId,key,value){
  if(state.role!=='staff'){toast('Staff role required.');return;}
  const current=state.data.custody.find(record=>record.claimId===claimId),claim=state.data.claims.find(item=>item.id===claimId);
  if(!current||!claim||claim.status!==CLAIM_STATUS.HANDOVER_PENDING||current.status!=='in custody'){toast('Handover checks are read-only unless an item is actively in custody.');return;}
  const property={identity:'identityChecked',item:'itemChecked',ack:'recipientAcknowledged'}[key];
  if(!property){toast('Unknown handover check.');return;}
  const custody={...current,[property]:!!value,updatedAt:now()};
  try{await commitBundle([{store:'custody',record:custody},{store:'audit',record:auditRecord(`Handover checklist ${value?'checked':'unchecked'}: ${key}`,current.id)}]);}
  catch(error){render();toast(`Could not save the handover check. ${error?.message||'Storage error.'}`);}
}
async function completeHandover(claimId){
  const custody=state.data.custody.find(record=>record.claimId===claimId),claim=state.data.claims.find(item=>item.id===claimId),report=state.data.reports.find(item=>item.id===claim?.reportId);
  const reason=validateHandover({actorRole:state.role,actorId:actorId(),claim,report,custody,claims:state.data.claims});
  if(reason){toast(reason);return;}
  if(!confirm('Confirm the in-person handover? This records the local demo release and marks the report recovered.'))return;
  const at=now();
  const released={...custody,status:'released',handoverAt:at,releasedBy:'Demo campus staff',updatedAt:at};
  const recoveredClaim={...claim,status:CLAIM_STATUS.RECOVERED,updatedAt:at};
  const recoveredReport={...report,status:'recovered',updatedAt:at};
  const recipients=[...new Set([normalizedOwner(claim.owner),normalizedOwner(report.owner)])];
  const entries=[{store:'custody',record:released},{store:'claims',record:recoveredClaim},{store:'reports',record:recoveredReport},{store:'audit',record:auditRecord('Physical handover completed',report.id,'Recipient acknowledgement recorded.')},...recipients.map(recipient=>({store:'notifications',record:notificationRecord('The in-person handover was recorded and the item is marked recovered.',report.id,recipient,claim.id)}))];
  try{await commitBundle(entries);render();toast('Handover recorded. Report marked recovered.');}
  catch(error){toast(`Could not complete handover. No handover changes were committed. ${error?.message||'Storage error.'}`);}
}
async function linkDuplicate(id,target){
  if(state.role!=='staff'){toast('Staff role required.');return;}
  const current=state.data.reports.find(report=>report.id===id),other=state.data.reports.find(report=>report.id===target);
  if(!current||!other||id===target){toast('Choose two different existing reports.');return;}
  if(!confirm(`Mark ${id} as a duplicate of ${target}?`))return;
  const report={...current,duplicateOf:target,updatedAt:now()};
  try{await commitBundle([{store:'reports',record:report},{store:'audit',record:auditRecord('Reports linked as duplicates',id,target)}]);render();toast('Duplicate link recorded.');}
  catch(error){toast(`Could not link duplicate reports. ${error?.message||'Storage error.'}`);}
}
async function addEvidence(id){
  const claim=state.data.claims.find(item=>item.id===id);
  if(!claim||!ownsRecord(claim.owner,'student')||claim.status!==CLAIM_STATUS.NEEDS_INFORMATION){toast('Additional information is available only for your claim when staff requests it.');return;}
  openModal('Add information',`<form id="evidence-form"><label>Additional ownership information<textarea name="text" rows="4" required minlength="10" maxlength="500" placeholder="Add a detail requested by staff"></textarea></label><div id="evidence-error" role="alert" class="form-error" hidden></div><button class="btn-primary" type="submit">Send to staff</button></form>`);
  modal.querySelector('#evidence-form').addEventListener('submit',async event=>{
    event.preventDefault();const text=String(new FormData(event.currentTarget).get('text')||'').trim(),error=modal.querySelector('#evidence-error');
    if(text.length<10||text.length>500){error.textContent='Provide 10 to 500 characters of additional information.';error.hidden=false;return;}
    const next={...claim,extraEvidence:text,status:CLAIM_STATUS.UNDER_REVIEW,updatedAt:now()};
    const entries=[{store:'claims',record:next},{store:'audit',record:auditRecord('Claim evidence added',id,'Claimant sent additional information.')},{store:'notifications',record:notificationRecord('A claimant added requested information for staff review.',claim.reportId,actorId('staff'),claim.id)}];
    try{await commitBundle(entries);closeModal();render();toast('Information sent for staff review.');}
    catch(storageError){error.textContent=`Information was not saved. ${storageError?.message||'Storage error. Retry when storage is available.'}`;error.hidden=false;}
  });
}
async function markRead(id){
  const current=state.data.notifications.find(notice=>notice.id===id);
  if(!current||!notificationForActor(current)||current.read)return;
  try{await commitBundle([{store:'notifications',record:{...current,read:true}}]);render();}
  catch(error){toast(`Could not mark notification read. ${error?.message||'Storage error.'}`);}
}
async function withdrawReport(id){
  const current=state.data.reports.find(report=>report.id===id);
  if(!current||(!ownsRecord(current.owner)&&state.role!=='staff')){toast('You can withdraw only your own report.');return;}
  if(['recovered','withdrawn','closed'].includes(current.status)){toast('This report is already closed.');return;}
  const activeClaim=state.data.claims.some(claim=>claim.reportId===id&&![CLAIM_STATUS.REJECTED,CLAIM_STATUS.RECOVERED].includes(claim.status));
  const activeCustody=state.data.custody.some(record=>record.reportId===id&&record.status==='in custody');
  if(activeClaim||activeCustody){toast('Resolve active claims and custody before withdrawing this report.');return;}
  if(!confirm('Withdraw this report? Existing history will remain in this browser.'))return;
  const report={...current,status:'withdrawn',updatedAt:now()};
  try{await commitBundle([{store:'reports',record:report},{store:'audit',record:auditRecord('Report withdrawn',id)}]);render();toast('Report withdrawn.');}
  catch(error){toast(`Could not withdraw report. ${error?.message||'Storage error.'}`);}
}
function updateInsightsDate(){state.analyticsSince=app.querySelector('#date-from').value||null;state.analyticsUntil=app.querySelector('#date-to').value||null;render();}
async function exportBackup(){const data=await exportData(),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`campus-findit-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);toast('Local data export downloaded.');}
async function importBackup(e){const file=e.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());await importData(data);await audit('Data imported','local');await refresh();toast('Data imported.');}catch(err){toast(err.message||'Import failed.');}}
async function resetData(){if(!confirm('Permanently clear all Campus FindIt records from this browser?'))return;await clearAll();await refresh();toast('Local records cleared.');}
function bindActivity(){const content=app.querySelector('#activity-content');if(!content)return;content.querySelectorAll('[data-withdraw]').forEach(element=>element.addEventListener('click',()=>withdrawReport(element.dataset.withdraw)));content.querySelectorAll('[data-report-detail]').forEach(element=>element.addEventListener('click',()=>showReport(element.dataset.reportDetail)));content.querySelectorAll('[data-add-evidence]').forEach(element=>element.addEventListener('click',()=>addEvidence(element.dataset.addEvidence)));content.querySelectorAll('[data-notification]').forEach(element=>element.addEventListener('click',()=>markRead(element.dataset.notification)));content.querySelectorAll('[data-open-report]').forEach(element=>element.addEventListener('click',()=>showReport(element.dataset.openReport)));content.querySelectorAll('[data-open-conversation]').forEach(element=>element.addEventListener('click',()=>openConversation(element.dataset.openConversation)));}
function init(){const hash=location.hash.slice(1);if(NAV.some(x=>x[0]===hash))state.page=hash;refresh().catch(e=>{app.innerHTML=`<div class="storage-error"><h1>Could not open local storage</h1><p>${esc(e.message)}</p><button onclick="location.reload()">Retry</button></div>`;});}
modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.open)closeModal();});
init();
