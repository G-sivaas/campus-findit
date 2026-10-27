const DB_NAME='campus-findit';
const STORES=['reports','claims','custody','notifications','audit','messages'];
const memory=Object.fromEntries(STORES.map(s=>[s,new Map()]));
let dbPromise;
function openDB(){
  if(!('indexedDB' in globalThis))return Promise.resolve(null);
  if(!dbPromise){
    let opening;
    opening=new Promise((resolve,reject)=>{
      let settled=false;
      const fail=error=>{
        if(settled)return;
        settled=true;
        if(dbPromise===opening)dbPromise=null;
        reject(error||new Error('Could not open local storage.'));
      };
      const req=indexedDB.open(DB_NAME,2);
      req.onupgradeneeded=()=>{
        const db=req.result;
        for(const name of STORES)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
      };
      req.onblocked=()=>fail(new Error('Close another Campus FindIt tab to finish the local storage upgrade, then retry.'));
      req.onsuccess=()=>{
        const db=req.result;
        if(settled){db.close();return;}
        settled=true;
        db.onversionchange=()=>{db.close();dbPromise=null;};
        resolve(db);
      };
      req.onerror=()=>fail(req.error);
    });
    dbPromise=opening;
  }
  return dbPromise;
}
export async function getAll(store){const db=await openDB();if(!db)return [...memory[store].values()];return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function put(store,record){return putMany([{store,record}]).then(()=>record);}
export async function putMany(entries){
  if(!Array.isArray(entries))throw new TypeError('A batch of records is required.');
  if(entries.length===0)return [];
  for(const entry of entries){
    if(!entry||!STORES.includes(entry.store))throw new Error('Unknown record store in write batch.');
    if(!entry.record||typeof entry.record.id!=='string')throw new Error('Every record in a write batch must have a string id.');
  }
  const db=await openDB();
  if(!db){
    const staged=entries.map(({store,record})=>({store,id:record.id,record:structuredClone(record)}));
    for(const item of staged)memory[item.store].set(item.id,item.record);
    return entries.map(entry=>entry.record);
  }
  const names=[...new Set(entries.map(entry=>entry.store))];
  return new Promise((resolve,reject)=>{
    let tx,settled=false;
    const fail=error=>{if(!settled){settled=true;reject(error||new Error('IndexedDB write transaction failed.'));}};
    try{
      tx=db.transaction(names,'readwrite');
      tx.oncomplete=()=>{if(!settled){settled=true;resolve(entries.map(entry=>entry.record));}};
      tx.onerror=()=>fail(tx.error);
      tx.onabort=()=>fail(tx.error);
      for(const {store,record} of entries)tx.objectStore(store).put(record);
    }catch(error){
      fail(error);
      try{tx?.abort();}catch{}
    }
  });
}
export async function remove(store,id){const db=await openDB();if(!db){memory[store].delete(id);return;}return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export async function clearAll(){const db=await openDB();if(!db){for(const s of STORES)memory[s].clear();return;}return new Promise((resolve,reject)=>{const tx=db.transaction(STORES,'readwrite');for(const s of STORES)tx.objectStore(s).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export async function exportData(){const out={schemaVersion:2,exportedAt:new Date().toISOString()};for(const s of STORES)out[s]=await getAll(s);return out;}
export async function importData(data){
  if(!data || ![1,2].includes(data.schemaVersion) || !['reports','claims','custody','notifications','audit'].every(s=>Array.isArray(data[s])))throw new Error('This file is not a supported Campus FindIt export.');
  if(data.schemaVersion===2 && !Array.isArray(data.messages))throw new Error('This file is not a supported Campus FindIt export.');
  const entries=[];
  for(const store of STORES){
    const records=store==='messages'&&data.schemaVersion===1?[]:data[store];
    for(const record of records)if(!record || typeof record.id!=='string')throw new Error('Invalid '+store+' record in import.');
    entries.push(...records.map(record=>({store,record})));
  }
  await putMany(entries);
  return true;
}
export const STORE_NAMES=STORES;
