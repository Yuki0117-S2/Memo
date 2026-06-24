/* Workshop Google Drive appDataFolder sync helper
   - Gist 기능은 건드리지 않음
   - 각 HTML의 GIST_FILE_NAME/state/save/render/renderAll 등을 재사용
   - 먼저 CLIENT_ID를 입력하고, Drive에 현재 앱 데이터를 슬롯 방식으로 저장/불러오기
   - 기본 앱은 최대 5슬롯, LoRA Lab은 이미지 용량 보호를 위해 최대 3슬롯
*/
(function(){
  'use strict';

  const DRIVE_CLIENT_KEY='workshop_drive_client_id';
  const DRIVE_DEVICE_KEY='workshop_drive_device_name';
  const DEFAULT_DRIVE_CLIENT_ID='543112547778-f5mul1dqjc7gkcp9vb6ecspl1qme6b4e.apps.googleusercontent.com';
  const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.appdata';
  const DRIVE_API='https://www.googleapis.com/drive/v3/files';
  const DRIVE_UPLOAD='https://www.googleapis.com/upload/drive/v3/files';
  const SLOT_MAX=5;

  let tokenClient=null;
  let accessToken='';
  let pendingAuthResolve=null;

  function q(sel){return document.querySelector(sel)}
  function safeToast(msg){
    try{ if(typeof toast==='function') toast(msg); else alert(msg); }
    catch(e){ alert(msg); }
  }
  function appFileName(){
    try{ if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME) return GIST_FILE_NAME.replace(/\.json$/,'')+'_drive.json'; }catch(e){}
    const title=(document.title||'workshop').replace(/[^a-z0-9가-힣_-]+/gi,'_').toLowerCase();
    return title+'_drive.json';
  }
  function appLabel(){
    try{ if(typeof GIST_FILE_NAME!=='undefined') return GIST_FILE_NAME.replace(/_data\.json$/,'').replace(/_/g,' '); }catch(e){}
    return document.title||'Workshop';
  }
  function nowIso(){return new Date().toISOString()}
  function jsonClone(v){return JSON.parse(JSON.stringify(v))}
  function deviceName(){
    let v=localStorage.getItem(DRIVE_DEVICE_KEY)||'';
    if(!v){
      const isMobile=/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent||'');
      v=isMobile?'mobile':'desktop';
      localStorage.setItem(DRIVE_DEVICE_KEY,v);
    }
    return v;
  }

  function isLoRALabApp(){
    try{return typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='lora_lab_data.json';}
    catch(e){return false;}
  }

  function byteSizeOfJson(obj){
    try{return new Blob([JSON.stringify(obj)]).size;}
    catch(e){return 0;}
  }

  function formatBytes(n){
    if(!n)return '0 KB';
    const u=['B','KB','MB','GB'];
    let i=0,x=n;
    while(x>=1024&&i<u.length-1){x/=1024;i++;}
    return `${x.toFixed(i?1:0)} ${u[i]}`;
  }

  function getDriveSlotMax(){
    // LoRA Lab은 이미지 dataUrl이 커서 슬롯을 많이 누적하면
    // 같은 데이터라도 재저장 때 Invalid string length가 날 수 있다.
    // 그래서 Drive는 최신 백업 2개까지만 보존한다.
    return isLoRALabApp()?2:SLOT_MAX;
  }

  function getStateForDrive(){
    // Drive는 대용량 저장소로 쓰기 때문에 Result Gallery는 Gist와 달리 썸네일까지 보존한다.
    // Gist 쪽 stripStateForSync()는 그대로 두고, Drive에서만 전체 상태를 저장한다.
    try{
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='result_gallery_data.json'){
        const cloned=jsonClone(state);
        if(Array.isArray(cloned.items)){
          cloned.items.forEach(it=>{
            if(it.thumb) it.thumbStripped=false;
          });
        }
        return cloned;
      }
    }catch(e){throw new Error('Result Gallery 상태를 Drive용으로 읽을 수 없어: '+e.message)}

    try{
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='lora_lab_data.json'){
        return {cards: jsonClone(state.cards||[])};
      }
    }catch(e){}

    // 다른 앱은 기존처럼 현재 상태 전체를 저장한다.
    try{return jsonClone(state)}catch(e){throw new Error('현재 앱 상태를 읽을 수 없어: '+e.message)}
  }

  async function applyDriveState(slot){
    const incoming=slot.state || slot;
    try{
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='lora_lab_data.json'){
        const cards=incoming.cards || slot.cards || [];
        state.cards = typeof normalizeCard==='function' ? cards.map(normalizeCard) : cards;
        if(state.selected && typeof state.selected.clear==='function') state.selected.clear();
        state.selectedId=state.cards[0]?.id||null;
        if('selectMode' in state) state.selectMode=false;
        if(typeof saveResultGalleryToIndexedDBNow==='function') await saveResultGalleryToIndexedDBNow();
        else if(typeof saveCardsToIndexedDBNow==='function') await saveCardsToIndexedDBNow();
        else if(typeof save==='function') save();
        if(typeof render==='function') render();
        return;
      }
    }catch(e){throw new Error('Drive 데이터를 적용하지 못했어: '+(e.message||e));}

    try{
      state=incoming;
      // 앱별 최소 마이그레이션
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='result_gallery_data.json'){
        if(!state.view) state.view='default';
        if(!Array.isArray(state.tagFilter)) state.tagFilter=[];
        if(!Array.isArray(state.loraFilter)) state.loraFilter=[];
        if(!Array.isArray(state.expandedIds)) state.expandedIds=[];
        state.selectedId=state.items?.[0]?.id||null;
      }
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='cd_idea_data.json'){
        if(!state.activeTabId && state.tabs?.[0]) state.activeTabId=state.tabs[0].id;
      }
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='archive_data.json'){
        state.selectedId=state.items?.[0]?.id||null;
      }
      if(typeof saveResultGalleryToIndexedDBNow==='function') await saveResultGalleryToIndexedDBNow();
      else if(typeof saveCardsToIndexedDBNow==='function') await saveCardsToIndexedDBNow();
      else if(typeof save==='function') save();
      if(typeof renderAll==='function') renderAll();
      else {
        if(typeof applyView==='function') applyView();
        if(typeof render==='function') render();
      }
    }catch(e){
      throw new Error('Drive 데이터를 적용하지 못했어: '+e.message);
    }
  }

  function ensureStyles(){
    if(q('#drive-sync-style'))return;
    const st=document.createElement('style');
    st.id='drive-sync-style';
    st.textContent=`
      .drive-sync-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;background:#8888CC;color:white;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit}.drive-sync-btn:hover{opacity:.86}
      #drive-sync-overlay{position:fixed;inset:0;background:rgba(0,0,0,.36);z-index:10020;display:none;align-items:center;justify-content:center;padding:18px}
      #drive-sync-overlay.open{display:flex}
      .drive-sync-box{width:min(560px,100%);max-height:86vh;overflow:auto;background:var(--bg,#fff);color:var(--text,#1a1a1a);border:.5px solid var(--border2,rgba(0,0,0,.2));border-radius:12px;box-shadow:0 16px 50px rgba(0,0,0,.28);padding:16px}
      .drive-sync-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.drive-sync-title{font-size:15px;font-weight:800;color:#8888CC}.drive-sync-close{background:transparent;border:0;color:var(--text3,#999);font-size:18px;cursor:pointer}
      .drive-sync-note{font-size:12px;color:var(--text2,#555);line-height:1.6;background:var(--bg2,#f7f6f3);border:.5px solid var(--border,rgba(0,0,0,.1));border-radius:8px;padding:10px;margin:8px 0 12px}
      .drive-sync-field{display:grid;gap:4px;margin:8px 0}.drive-sync-field label{font-size:10px;color:var(--text3,#999);letter-spacing:.5px;text-transform:uppercase;font-weight:800}.drive-sync-field input{width:100%;background:var(--bg2,#f7f6f3);border:.5px solid var(--border,rgba(0,0,0,.1));border-radius:8px;color:var(--text,#111);font-size:12px;padding:8px 9px;outline:0;font-family:inherit}.drive-sync-field input:focus{border-color:#8888CC}
      .drive-sync-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.drive-sync-actions button{border:0;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}.drive-main{background:#8888CC;color:#fff}.drive-sub{background:var(--bg2,#f7f6f3);color:var(--text2,#555);border:.5px solid var(--border,rgba(0,0,0,.1))!important}.drive-danger{background:#BB6688;color:#fff}
      .drive-sync-status{font-size:12px;line-height:1.55;margin-top:10px;color:var(--text3,#999);white-space:pre-wrap}.drive-sync-status.ok{color:#6AC8B0}.drive-sync-status.err{color:#BB6688}.drive-sync-status.loading{color:#CCAA88}
      .drive-slot-list{display:grid;gap:7px;margin-top:12px}.drive-slot{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;background:var(--bg2,#f7f6f3);border:.5px solid var(--border,rgba(0,0,0,.1));border-radius:8px;padding:10px;cursor:pointer;color:var(--text,#111);font-family:inherit}.drive-slot:hover{border-color:#8888CC}.drive-slot b{display:block;font-size:12px}.drive-slot span{display:block;font-size:11px;color:var(--text3,#999);margin-top:3px}.drive-slot i{font-style:normal;color:#8888CC;font-size:18px}
    `;
    document.head.appendChild(st);
  }

  function ensureModal(){
    if(q('#drive-sync-overlay'))return;
    const ov=document.createElement('div');
    ov.id='drive-sync-overlay';
    ov.innerHTML=`
      <div class="drive-sync-box">
        <div class="drive-sync-head">
          <div class="drive-sync-title">Google Drive 동기화</div>
          <button class="drive-sync-close" type="button" title="닫기">×</button>
        </div>
        <div class="drive-sync-note">
          Gist는 그대로 두고, 이 버튼은 Google Drive의 숨김 앱 폴더(appDataFolder)에 현재 앱 데이터를 저장해. Result Gallery는 Drive 저장 때 썸네일까지 같이 보존돼.
        </div>
        <div class="drive-sync-field">
          <label>Google OAuth Client ID</label>
          <input id="drive-client-id" placeholder="예: 000000000000-xxxx.apps.googleusercontent.com">
        </div>
        <div class="drive-sync-field">
          <label>기기 이름</label>
          <input id="drive-device-name" placeholder="예: desktop, phone">
        </div>
        <div class="drive-sync-actions">
          <button class="drive-main" id="drive-connect-btn" type="button">Drive 연결</button>
          <button class="drive-main" id="drive-upload-btn" type="button">Drive에 저장</button>
          <button class="drive-sub" id="drive-load-btn" type="button">Drive에서 불러오기</button>
          <button class="drive-sub" id="drive-forget-btn" type="button">설정 지우기</button>
        </div>
        <div id="drive-sync-status" class="drive-sync-status"></div>
        <div id="drive-slot-list" class="drive-slot-list"></div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click',e=>{if(e.target===ov)closeModal()});
    q('.drive-sync-close').onclick=closeModal;
    q('#drive-connect-btn').onclick=connectDrive;
    q('#drive-upload-btn').onclick=uploadDriveSlot;
    q('#drive-load-btn').onclick=listDriveSlots;
    q('#drive-forget-btn').onclick=()=>{
      localStorage.removeItem(DRIVE_CLIENT_KEY); accessToken=''; tokenClient=null; setStatus('Drive 설정을 지웠어. 기본 Client ID로 되돌렸어.','ok');
      q('#drive-client-id').value=DEFAULT_DRIVE_CLIENT_ID||'';
    };
  }

  function openModal(){
    ensureStyles(); ensureModal();
    q('#drive-client-id').value=localStorage.getItem(DRIVE_CLIENT_KEY)||DEFAULT_DRIVE_CLIENT_ID||'';
    q('#drive-device-name').value=deviceName();
    q('#drive-slot-list').innerHTML='';
    setStatus((accessToken?'Drive 연결됨. ':'')+'현재 Drive 파일: '+appFileName(), accessToken?'ok':'');
    q('#drive-sync-overlay').classList.add('open');
  }
  function closeModal(){ q('#drive-sync-overlay')?.classList.remove('open'); }
  function setStatus(msg,type){
    const el=q('#drive-sync-status'); if(!el)return;
    el.textContent=msg||''; el.className='drive-sync-status'+(type?' '+type:'');
  }

  function injectButton(){
    if(q('#drive-sync-open'))return;
    const btn=document.createElement('button');
    btn.id='drive-sync-open';
    btn.type='button';
    btn.className='drive-sync-btn';
    btn.textContent='Drive';
    btn.onclick=openModal;
    const toolbar=q('.toolbar') || q('#toolbar') || q('header') || document.body;
    toolbar.appendChild(btn);
  }

  function loadGis(){
    return new Promise((resolve,reject)=>{
      if(window.google?.accounts?.oauth2){resolve();return;}
      const old=q('script[data-google-gis]');
      if(old){old.addEventListener('load',resolve,{once:true});old.addEventListener('error',reject,{once:true});return;}
      const s=document.createElement('script');
      s.src='https://accounts.google.com/gsi/client';
      s.async=true; s.defer=true; s.dataset.googleGis='1';
      s.onload=resolve; s.onerror=()=>reject(new Error('Google Identity Services 스크립트를 불러오지 못했어.'));
      document.head.appendChild(s);
    });
  }

  function initTokenClient(clientId){
    if(tokenClient && tokenClient._workshopClientId===clientId) return;
    tokenClient=google.accounts.oauth2.initTokenClient({
      client_id:clientId,
      scope:DRIVE_SCOPE,
      callback:(resp)=>{
        const pending=pendingAuthResolve;
        pendingAuthResolve=null;
        if(resp.error){ pending?.reject(new Error(resp.error)); return; }
        accessToken=resp.access_token;
        pending?.resolve(accessToken);
      }
    });
    tokenClient._workshopClientId=clientId;
  }

  function requestToken(promptMode='consent', timeoutMs=0){
    return new Promise((resolve,reject)=>{
      let done=false;
      let timer=null;
      if(timeoutMs){
        timer=setTimeout(()=>{
          if(done) return;
          done=true;
          pendingAuthResolve=null;
          reject(new Error('silent_timeout'));
        },timeoutMs);
      }
      pendingAuthResolve={
        resolve:(token)=>{
          if(done) return; done=true; if(timer) clearTimeout(timer); resolve(token);
        },
        reject:(err)=>{
          if(done) return; done=true; if(timer) clearTimeout(timer); reject(err);
        }
      };
      tokenClient.requestAccessToken({prompt:promptMode});
    });
  }

  async function ensureToken(options={}){
    const clientId=(q('#drive-client-id')?.value||localStorage.getItem(DRIVE_CLIENT_KEY)||DEFAULT_DRIVE_CLIENT_ID||'').trim();
    const dev=(q('#drive-device-name')?.value||deviceName()).trim()||'device';
    if(!clientId) throw new Error('Google OAuth Client ID를 먼저 넣어줘.');
    localStorage.setItem(DRIVE_CLIENT_KEY,clientId);
    localStorage.setItem(DRIVE_DEVICE_KEY,dev);
    await loadGis();
    if(accessToken) return accessToken;
    initTokenClient(clientId);
    return await requestToken(options.prompt ?? 'consent', options.timeoutMs || 0);
  }

  async function trySilentReconnect(){
    const clientId=(localStorage.getItem(DRIVE_CLIENT_KEY)||DEFAULT_DRIVE_CLIENT_ID||'').trim();
    if(!clientId || accessToken) return;
    try{
      await loadGis();
      initTokenClient(clientId);
      await requestToken('', 5000);
      const btn=q('#drive-sync-open');
      if(btn){btn.textContent='Drive ✓'; btn.title='Drive 조용한 재연결 완료';}
    }catch(e){
      // 첫 실행/권한 만료/브라우저 정책 때문에 조용한 재연결이 안 될 수 있음.
      // 이 경우 사용자가 Drive 버튼에서 직접 연결하면 됨.
      console.debug('Drive silent reconnect skipped:', e?.message||e);
    }
  }

  async function connectDrive(){
    try{setStatus('Drive 연결 중...','loading'); await ensureToken({prompt:'consent'}); const btn=q('#drive-sync-open'); if(btn) btn.textContent='Drive ✓'; setStatus('연결 완료. 이제 Drive 저장/불러오기를 눌러봐.','ok');}
    catch(e){setStatus('연결 실패: '+e.message,'err')}
  }

  async function driveFetch(url,opt={}){
    const token=await ensureToken();
    const headers=Object.assign({},opt.headers||{}, {Authorization:'Bearer '+token});
    const res=await fetch(url,Object.assign({},opt,{headers}));
    if(res.status===401){accessToken=''; throw new Error('인증이 만료됐어. Drive 연결을 다시 눌러줘.');}
    if(!res.ok){
      const err=await res.json().catch(()=>({error:{message:res.statusText}}));
      throw new Error(err.error?.message || String(res.status));
    }
    return res;
  }

  async function findDriveFile(){
    const name=appFileName().replace(/'/g,"\\'");
    const params=new URLSearchParams({
      spaces:'appDataFolder',
      fields:'files(id,name,modifiedTime,size)',
      q:`name='${name}' and 'appDataFolder' in parents and trashed=false`
    });
    const res=await driveFetch(DRIVE_API+'?'+params.toString());
    const data=await res.json();
    return data.files?.[0]||null;
  }

  async function readDriveFile(fileId){
    const res=await driveFetch(`${DRIVE_API}/${fileId}?alt=media`);
    return await res.json();
  }

  function multipartBody(metadata, contentObj){
    const boundary='workshop_drive_'+Math.random().toString(36).slice(2);
    // 대용량 이미지가 많은 앱에서는 pretty-print 공백도 수 MB까지 불어날 수 있어서 compact JSON으로 저장한다.
    const content=JSON.stringify(contentObj);
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    return {body,boundary};
  }

  async function writeDriveFile(fileId, payload){
    const metadata=fileId?{}:{name:appFileName(),parents:['appDataFolder'],mimeType:'application/json'};
    const mp=multipartBody(metadata,payload);
    const method=fileId?'PATCH':'POST';
    const url=fileId?`${DRIVE_UPLOAD}/${fileId}?uploadType=multipart&fields=id,name,modifiedTime`:`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime`;
    const res=await driveFetch(url,{method,headers:{'Content-Type':'multipart/related; boundary='+mp.boundary},body:mp.body});
    return await res.json();
  }

  function slotMeta(slot,i){
    const st=slot.state||slot;
    let count='';
    if(Array.isArray(st.tabs)) count=`탭 ${st.tabs.length}개 / 카드 ${st.tabs.reduce((s,t)=>s+(t.cards?.length||0),0)}개`;
    else if(Array.isArray(st.items)) count=`항목 ${st.items.length}개`;
    else if(Array.isArray(st.cards)) count=`카드 ${st.cards.length}개`;
    const t=slot.savedAt?new Date(slot.savedAt).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'시간 불명';
    return `${t} · ${slot.device||'기기 불명'}${count?' · '+count:''}`;
  }

  async function uploadDriveSlot(){
    try{
      setStatus('Drive 저장 중...','loading');
      if(typeof saveResultGalleryToIndexedDBNow==='function') await saveResultGalleryToIndexedDBNow();
      else if(typeof saveCardsToIndexedDBNow==='function') await saveCardsToIndexedDBNow();
      else if(typeof save==='function') save();

      const file=await findDriveFile();
      const maxSlots=getDriveSlotMax();
      const currentSlot={savedAt:nowIso(),device:deviceName(),app:appLabel(),state:getStateForDrive()};
      let slots=[];

      if(maxSlots>1 && file){
        try{ const old=await readDriveFile(file.id); slots=old.slots||[]; }catch(e){ slots=[]; }
      }
      // 새 슬롯을 맨 앞에 추가하고, 앱별 최대 슬롯 수만큼만 보존한다.
      // LoRA Lab은 최대 3슬롯이라 1,2,3,4 저장 시 4,3,2만 남는다.
      slots.unshift(currentSlot);
      slots=slots.slice(0,maxSlots);

      const payload={version:1,kind:'workshop-drive-slots',appFile:GIST_FILE_NAME||appFileName(),updatedAt:nowIso(),slots};
      const approx=byteSizeOfJson(payload);
      setStatus(`Drive 업로드 준비 중...\n예상 저장 크기: ${formatBytes(approx)}\n슬롯: ${slots.length}개${isLoRALabApp()?' · LoRA Lab은 용량 보호를 위해 최신 2슬롯만 보존':''}`,'loading');

      const written=await writeDriveFile(file?.id,payload);
      setStatus(`Drive 저장 완료!\n파일: ${written.name}\n슬롯: ${slots.length}개\n저장 크기: ${formatBytes(approx)}`, 'ok');
      safeToast('☁️ Drive 저장 완료');
    }catch(e){setStatus('Drive 저장 실패: '+e.message,'err')}
  }

  async function listDriveSlots(){
    try{
      setStatus('Drive에서 슬롯 읽는 중...','loading');
      q('#drive-slot-list').innerHTML='';
      const file=await findDriveFile();
      if(!file){setStatus('아직 Drive에 저장된 파일이 없어. 먼저 Drive에 저장을 눌러봐.','err');return;}
      const data=await readDriveFile(file.id);
      const slots=data.slots||[];
      if(!slots.length){setStatus('저장된 슬롯이 비어 있어.','err');return;}
      setStatus('불러올 슬롯을 골라. 현재 로컬 데이터는 덮어써져.', '');
      const list=q('#drive-slot-list');
      slots.forEach((slot,i)=>{
        const b=document.createElement('button');
        b.type='button'; b.className='drive-slot';
        b.innerHTML=`<div><b>${i===0?'🟢 최신':'📁 슬롯 '+(i+1)}</b><span>${slotMeta(slot,i)}</span></div><i>›</i>`;
        b.onclick=async()=>{
          if(!confirm('현재 로컬 데이터를 이 Drive 슬롯으로 덮어쓸까?'))return;
          try{await applyDriveState(slot); setStatus('Drive 불러오기 완료.', 'ok'); safeToast('☁️ Drive 불러오기 완료'); closeModal();}
          catch(e){setStatus(e.message,'err')}
        };
        list.appendChild(b);
      });
    }catch(e){setStatus('Drive 불러오기 실패: '+e.message,'err')}
  }

  function bootDriveSync(){
    ensureStyles();
    injectButton();
    // Client ID가 이미 저장돼 있으면 앱 시작 때 조용한 재연결을 한 번 시도한다.
    // 실패해도 앱 사용에는 영향 없고, 사용자가 Drive 버튼에서 직접 연결하면 된다.
    setTimeout(trySilentReconnect, 900);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bootDriveSync);
  else bootDriveSync();
})();
