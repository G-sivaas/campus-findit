import test from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, policyFor, publicReport, publicMatchFactors, publicMatch, analytics, calculateHotspots, HOTSPOT_MINIMUM, zoneForLocation, duplicateCandidates } from '../src/domain.js';
import { clearAll, put, putMany, getAll, exportData, importData } from '../src/store.js';
import { validateImageFile, readImageFile, verifyImageDataUrl, saveReportBundle, MAX_IMAGE_BYTES } from '../src/reporting.js';
import { CLAIM_STATUS, allowedClaimTransitions, validateClaimCreation, validateClaimTransition, validateHandover, validateMessageText, conversationParticipants, canAccessConversation, orderedConversationMessages, escapeHtml } from '../src/workflow.js';

const report=(overrides={})=>({id:'r1',kind:'lost',category:'Books & notebooks',itemType:'Notebook',color:'Blue',brand:'Acme',date:'2026-10-22',locationId:'library',status:'open',createdAt:'2026-10-22T10:00:00Z',...overrides});

test('storage persists report and status changes through the repository API',async()=>{
  await clearAll();const r=report();await put('reports',r);r.status='recovered';await put('reports',r);const restored=await getAll('reports');assert.equal(restored.length,1);assert.equal(restored[0].status,'recovered');
});
test('export and import validate versioned data without inventing reports',async()=>{
  await clearAll();const blank=await exportData();assert.equal(blank.schemaVersion,2);assert.equal(blank.reports.length,0);assert.deepEqual(blank.messages,[]);await importData(blank);assert.equal((await getAll('reports')).length,0);await assert.rejects(importData({schemaVersion:9}),/supported/);
  const legacy={schemaVersion:1,reports:[report({id:'legacy-import'})],claims:[],custody:[],notifications:[],audit:[]};await importData(legacy);assert.equal((await getAll('reports')).some(item=>item.id==='legacy-import'),true);assert.deepEqual(await getAll('messages'),[]);
});
test('claims remain linked to their report across stored reads',async()=>{
  await clearAll();await put('reports',report());await put('claims',{id:'c1',reportId:'r1',status:'Submitted'});assert.equal((await getAll('claims'))[0].reportId,(await getAll('reports'))[0].id);
});
test('public found report omits private verification and sensitive image clues',()=>{
  const found=report({kind:'found',category:'ID cards',value:'Expensive',approved:true,status:'active',privateClue:'Name and number',image:'data:image/png;base64,secret',description:'Student ID with full name',publicDescription:'Sensitive item'});
  const safe=publicReport(found);assert.equal(safe.description,'A restricted item has been reported. Contact campus staff for details.');assert.equal('privateClue' in safe,false);assert.equal(safe.image,null);assert.equal(policyFor('ID cards').level,3);
  assert.equal(policyFor('Other','Less expensive','campus access card').level,3);
});
test('valuable found reports remain unpublished until staff approval',()=>{
  assert.equal(publicReport(report({kind:'found',category:'Wallets',approved:false})),null);
  assert.equal(policyFor('Wallets','Expensive').review,true);
});
test('public report does not expose a restricted clue property',()=>{
  const safe=publicReport(report({privateClue:'inside engraving',locationDetail:'seat 4'}));assert.equal('privateClue' in safe,false);assert.equal('locationDetail' in safe,false);
});
test('matching uses known evidence, rewards similarities and penalizes contradictions',()=>{
  const lost=report({});const found=report({id:'f1',kind:'found',approved:true,status:'active'});assert.ok(matchScore(lost,found).score>=80);
  const missing=matchScore(report({brand:'',color:'',locationId:''}),report({id:'f2',kind:'found',brand:'',color:'',locationId:'',status:'active'}));assert.deepEqual(missing.factors,['Same category','Similar item type','Dates within one day']);
  const contradicted=matchScore(lost,report({id:'f3',kind:'found',color:'Red',brand:'Other',status:'active'}));assert.ok(contradicted.score<matchScore(lost,found).score);
});
test('closed and duplicate found reports cannot become matches',()=>{
  const lost=report();assert.equal(matchScore(lost,report({kind:'found',status:'recovered'})).score,0);assert.equal(matchScore(lost,report({kind:'found',duplicateOf:'f0'})).score,0);
});
test('analytics uses records, excludes linked duplicates, and only counts confirmed recovery',()=>{
  const rows=[report({id:'l1'}),report({id:'f1',kind:'found',approved:true,status:'active'}),report({id:'f2',kind:'found',approved:true,status:'recovered',createdAt:'2026-10-22T10:00:00Z',updatedAt:'2026-10-24T10:00:00Z'}),report({id:'d1',kind:'lost',duplicateOf:'l1'})];
  const a=analytics(rows,[{id:'c1',status:'Approved for in-person verification'}]);assert.equal(a.lost,1);assert.equal(a.found,2);assert.equal(a.recovered,1);assert.equal(a.recoveryRate,33);assert.equal(a.pendingClaims,0);
  assert.equal(a.averageDays,2);assert.ok(a.weekly.length>0);assert.ok(a.monthly.length>0);
  const empty=analytics([]);assert.equal(empty.recoveryRate,0);assert.deepEqual(empty.byLocation,[]);
});
test('duplicate candidate detection compares item, location, and nearby dates',()=>{
  const a=report({id:'a'}),b=report({id:'b',date:'2026-10-24'}),c=report({id:'c',locationId:'canteen'});assert.deepEqual(duplicateCandidates(a,[a,b,c]).map(x=>x.id),['b']);
});


// Image validation runs both when a file is selected and again on submission.
test('image validation accepts supported types within the 3 MiB limit',()=>{
  for(const type of ['image/jpeg','image/png','image/webp']){
    assert.equal(validateImageFile({name:'item.'+type.slice(6),type,size:MAX_IMAGE_BYTES}).valid,true);
  }
  assert.equal(validateImageFile(null).valid,true);
});
test('image validation rejects unsupported, empty, and oversized files',()=>{
  assert.match(validateImageFile({name:'item.gif',type:'image/gif',size:120}).error,/JPEG, PNG, or WebP/);
  assert.match(validateImageFile({name:'empty.png',type:'image/png',size:0}).error,/empty/);
  assert.match(validateImageFile({name:'large.png',type:'image/png',size:MAX_IMAGE_BYTES+1}).error,/3 MiB/);
});
test('image reader returns data URLs and rejects unreadable files',async()=>{
  class GoodReader{readAsDataURL(){this.result='data:image/png;base64,abc';this.onload();}}
  class FailedReader{constructor(){this.error=new Error('disk read failed');}readAsDataURL(){this.onerror();}}
  assert.equal(await readImageFile({name:'ok.png'},GoodReader),'data:image/png;base64,abc');
  await assert.rejects(readImageFile({name:'bad.png'},FailedReader),/disk read failed/);
});
test('image decoding detects unreadable content before it can be submitted',async()=>{
  class GoodImage{naturalWidth=4;naturalHeight=3;set src(value){this.onload();}}
  class BadImage{naturalWidth=0;naturalHeight=0;set src(value){this.onerror();}}
  assert.equal(await verifyImageDataUrl('data:image/png;base64,ok',GoodImage),true);
  await assert.rejects(verifyImageDataUrl('data:image/png;base64,bad',BadImage),/not a readable image/);
});
test('report bundle reports persistence errors instead of success',async()=>{
  const entries=[{store:'reports',record:report({id:'r-bundle'})},{store:'audit',record:{id:'a-bundle'}},{store:'notifications',record:{id:'n-bundle'}}];
  let calls=0;
  const outcome=await saveReportBundle(entries,async batch=>{calls++;assert.equal(batch.length,3);throw new Error('audit store quota');});
  assert.equal(calls,1);assert.equal(outcome.ok,false);assert.match(outcome.error.message,/audit store quota/);
});
test('write batch validates all stores before changing memory-backed records',async()=>{
  await clearAll();await put('reports',report({id:'keep'}));
  await assert.rejects(putMany([{store:'reports',record:report({id:'partial'})},{store:'not-a-store',record:{id:'bad'}}]),/Unknown record store/);
  assert.deepEqual((await getAll('reports')).map(r=>r.id),['keep']);
});
test('report image data survives repository put/get round trip',async()=>{
  await clearAll();
  const image='data:image/png;base64,iVBORw0KGgo=';
  await put('reports',report({id:'image-roundtrip',image}));
  assert.equal((await getAll('reports'))[0].image,image);
});
test('public projection hides private clues and sensitive lost descriptions and locations',()=>{
  const sensitive=report({id:'private-lost',category:'Other',itemType:'Campus ID card',locationId:'library',locationName:'Central Library',description:'Full name and number on the front',publicDescription:'Full name and number on the front',privateClue:'blue star sticker',image:'data:image/png;base64,private'});
  const safe=publicReport(sensitive);
  assert.equal(safe.description,'A restricted item has been reported. Contact campus staff for details.');
  assert.equal(safe.zoneId,null);assert.equal(safe.zoneName,'Campus');assert.equal('locationId' in safe,false);assert.equal('locationName' in safe,false);assert.equal(safe.itemType,'Restricted item');assert.equal(safe.image,null);
  assert.equal('privateClue' in safe,false);assert.equal('locationDetail' in safe,false);
});
test('public match explanation does not expose restricted landmark matches',()=>{
  const lost=report({itemType:'Passport',category:'Other',locationId:'library'});
  const found=report({id:'found-private',kind:'found',approved:true,status:'active',itemType:'Passport',category:'Other',locationId:'library'});
  assert.equal(publicMatchFactors(lost,found).includes('Same campus landmark'),false);
});
test('unapproved found reports and images are excluded from public projection',()=>{
  const pending=report({kind:'found',approved:false,image:'data:image/png;base64,pending'});
  assert.equal(publicReport(pending),null);
});
test('legacy records without public/private fields remain readable without invented clues',()=>{
  const legacy=report({id:'legacy',publicDescription:undefined,privateClue:undefined,description:'Plain blue notebook'});
  const safe=publicReport(legacy);
  assert.equal(safe.description,'Plain blue notebook');assert.equal('privateClue' in safe,false);
  const legacySensitive=publicReport(report({id:'legacy-sensitive',category:'Other',itemType:'Identity card',publicDescription:undefined,privateClue:undefined,description:'Old private description'}));
  assert.equal(legacySensitive.description,'A restricted item has been reported. Contact campus staff for details.');
});


test('public reports expose only broad campus zones for standard and sensitive items',()=>{
  const standard=publicReport(report({id:'zone-report',locationId:'library',locationName:'Central Library',locationDetail:'Seat 14'}));
  assert.equal(standard.zoneId,'central');assert.equal(standard.zoneName,'Central campus');
  assert.equal('locationId' in standard,false);assert.equal('locationName' in standard,false);assert.equal('locationDetail' in standard,false);
  const restricted=publicReport(report({id:'private-zone',category:'Other',itemType:'Access card',locationId:'library'}));
  assert.equal(restricted.zoneId,null);assert.equal(restricted.zoneName,'Campus');
  assert.equal(zoneForLocation('library').id,'central');
});

test('analytics returns generalized area aggregates without raw report rows',()=>{
  const summary=analytics([report({id:'west',locationId:'cse'}),report({id:'central',locationId:'library'})]);
  assert.equal(summary.byLocation.length,2);
  assert.ok(summary.byLocation.every(row=>['West campus','Central campus'].includes(row.location.name)));
  assert.equal('reports' in summary,false);
  assert.equal('locationId' in summary.byLocation[0].location,false);
});

test('hotspots enforce the three-report minimum, split kinds, and use weekly or monthly windows',()=>{
  assert.equal(HOTSPOT_MINIMUM,3);
  const recentLost=[
    report({id:'l1',locationId:'library',createdAt:'2026-10-24T10:00:00Z'}),
    report({id:'l2',locationId:'reading',createdAt:'2026-10-24T11:00:00Z'}),
    report({id:'l3',locationId:'garden',createdAt:'2026-10-24T12:00:00Z'})
  ];
  const recentFound=[
    report({id:'f1',kind:'found',approved:true,status:'active',locationId:'library',createdAt:'2026-10-24T13:00:00Z'}),
    report({id:'f2',kind:'found',approved:true,status:'active',locationId:'reading',createdAt:'2026-10-24T14:00:00Z'}),
    report({id:'f3',kind:'found',approved:true,status:'active',locationId:'garden',createdAt:'2026-10-24T15:00:00Z'})
  ];
  const now=new Date('2026-10-25T00:00:00Z');
  assert.deepEqual(calculateHotspots(recentLost.slice(0,2),{kind:'lost',period:'week',threshold:1,now}),[]);
  const lost=calculateHotspots(recentLost,{kind:'lost',period:'week',threshold:3,now});
  assert.equal(lost.length,1);assert.equal(lost[0].zone.name,'Central campus');assert.equal(lost[0].count,3);assert.equal(lost[0].found,0);
  const found=calculateHotspots(recentFound,{kind:'found',period:'month',now});assert.equal(found[0].count,3);assert.equal(found[0].lost,0);
  const combined=calculateHotspots([...recentLost,...recentFound],{kind:'combined',period:'month',now});assert.equal(combined[0].count,6);assert.equal(combined[0].lost,3);assert.equal(combined[0].found,3);
  const old=report({id:'old',createdAt:'2026-09-20T12:00:00Z'});assert.deepEqual(calculateHotspots([...recentLost.slice(0,2),old],{period:'week',now}),[]);
  const duplicate=report({id:'l4',locationId:'library',duplicateOf:'l1',createdAt:'2026-10-24T16:00:00Z'});assert.deepEqual(calculateHotspots([...recentLost.slice(0,2),duplicate],{kind:'lost',period:'month',now}),[]);
  const hidden=report({id:'pending',kind:'found',approved:false,locationId:'library'});assert.deepEqual(calculateHotspots([...recentLost.slice(0,2),hidden],{kind:'combined',period:'month',now}),[]);
});

test('public matching reports only generalized area factors',()=>{
  const lost=report({locationId:'library'}),found=report({id:'f',kind:'found',approved:true,status:'active',locationId:'reading'});
  const result=publicMatch(lost,found);assert.ok(result.factors.includes('Same broad campus area'));assert.ok(!result.factors.includes('Same campus landmark'));
});

test('claim creation validates eligibility, ownership, duplicate claims, and competing handovers',()=>{
  const found=report({id:'found-1',kind:'found',approved:true,status:'active',owner:'demo-finder'});
  assert.equal(validateClaimCreation(found,'demo-student',[]),null);
  assert.match(validateClaimCreation({...found,approved:false},'demo-student',[]),/not available/);
  assert.match(validateClaimCreation(found,'demo-finder',[]),/cannot claim/);
  assert.match(validateClaimCreation(found,'demo-student',[{id:'c1',reportId:found.id,owner:'demo-student',status:CLAIM_STATUS.UNDER_REVIEW}]),/active claim/);
  assert.match(validateClaimCreation(found,'demo-student',[{id:'c2',reportId:found.id,owner:'someone',status:CLAIM_STATUS.HANDOVER_PENDING}]),/accepted or completed/);
});

test('claim state transitions reject unauthorized, self-review, and terminal changes',()=>{
  const found=report({id:'found-claim',kind:'found',approved:true,status:'active',owner:'demo-finder'});
  const claim={id:'c1',reportId:found.id,owner:'demo-student',status:CLAIM_STATUS.SUBMITTED};
  assert.equal(validateClaimTransition(claim,CLAIM_STATUS.NEEDS_INFORMATION,{actorRole:'staff',actorId:'demo-staff',report:found,claims:[claim]}),null);
  assert.match(validateClaimTransition(claim,CLAIM_STATUS.ACCEPTED,{actorRole:'student',actorId:'demo-student',report:found,claims:[claim]}),/demo staff/);
  assert.match(validateClaimTransition(claim,CLAIM_STATUS.ACCEPTED,{actorRole:'staff',actorId:'demo-student',report:found,claims:[claim]}),/cannot review/);
  const rejected={...claim,status:CLAIM_STATUS.REJECTED};assert.deepEqual(allowedClaimTransitions(rejected.status),[]);
  assert.match(validateClaimTransition(rejected,CLAIM_STATUS.ACCEPTED,{actorRole:'staff',actorId:'demo-staff',report:found,claims:[rejected]}),/Cannot move/);
  assert.match(validateClaimTransition({...claim,status:CLAIM_STATUS.DISPUTED},CLAIM_STATUS.ACCEPTED,{actorRole:'staff',actorId:'demo-staff',report:found,claims:[claim]}),/Cannot move/);
});

test('handover requires accepted review, linked custody, all checks, and a single recipient',()=>{
  const found=report({id:'found-handover',kind:'found',approved:true,status:'active',owner:'demo-finder'});
  const claim={id:'c-h',reportId:found.id,owner:'demo-student',status:CLAIM_STATUS.HANDOVER_PENDING};
  const custody={id:'cu-h',claimId:claim.id,reportId:found.id,status:'in custody',identityChecked:true,itemChecked:true,recipientAcknowledged:true};
  assert.equal(validateHandover({actorRole:'staff',actorId:'demo-staff',claim,report:found,custody,claims:[claim]}),null);
  assert.match(validateHandover({actorRole:'student',actorId:'demo-student',claim,report:found,custody,claims:[claim]}),/staff reviewer/);
  assert.match(validateHandover({actorRole:'staff',actorId:'demo-student',claim,report:found,custody,claims:[claim]}),/claimant cannot/);
  assert.match(validateHandover({actorRole:'staff',actorId:'demo-staff',claim,report:found,custody:{...custody,itemChecked:false},claims:[claim]}),/all three/);
  assert.match(validateHandover({actorRole:'staff',actorId:'demo-staff',claim,report:{...found,status:'recovered'},custody,claims:[claim]}),/already been handed/);
});

test('conversation participants are tied to the correct claim and report',()=>{
  const report1={id:'f1',kind:'found',owner:'demo-finder'},report2={id:'f2',kind:'found',owner:'other-finder'};
  const claim={id:'claim-1',reportId:'f1',owner:'demo-student'};
  assert.deepEqual(conversationParticipants(claim,report1),{claimantId:'demo-student',finderId:'demo-finder'});
  assert.equal(canAccessConversation(claim,report1,'demo-student'),true);assert.equal(canAccessConversation(claim,report1,'demo-finder'),true);assert.equal(canAccessConversation(claim,report1,'unrelated'),false);
  assert.equal(conversationParticipants(claim,report2),null);assert.equal(conversationParticipants({...claim,reportId:'f2'},{...report2,id:'f3'}),null);
  const messages=[{id:'m2',claimId:'claim-1',reportId:'f1',createdAt:'2026-10-25T10:02:00Z'},{id:'m1',claimId:'claim-1',reportId:'f1',createdAt:'2026-10-25T10:01:00Z'},{id:'other',claimId:'claim-2',reportId:'f1',createdAt:'2026-10-25T09:00:00Z'}];
  assert.deepEqual(orderedConversationMessages(messages,'claim-1','f1').map(message=>message.id),['m1','m2']);
});

test('message validation and escaping reject blank text and keep HTML inert',()=>{
  assert.equal(validateMessageText('  ').valid,false);assert.equal(validateMessageText(' hello ').value,'hello');
  assert.equal(validateMessageText('x'.repeat(1001)).valid,false);
  assert.equal(escapeHtml('<img src=x onerror=alert(1)> & "ok"'), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;ok&quot;');
});

test('message records persist via the repository API and stay associated with their claim',async()=>{
  await clearAll();
  const message={id:'message-1',claimId:'claim-1',reportId:'found-1',fromId:'demo-student',toId:'demo-finder',text:'Can we meet at the front desk?',createdAt:'2026-10-25T11:00:00Z'};
  await put('messages',message);
  const reloaded=await getAll('messages');assert.equal(reloaded.length,1);assert.deepEqual(reloaded[0],message);
  const exported=await exportData();assert.equal(exported.messages[0].claimId,'claim-1');
});
