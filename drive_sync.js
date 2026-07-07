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

  // ===== LoRA Lab 전용: 이미지 분리 저장 =====
  // 메인 파일엔 카드 메타 + 이미지 참조(imageFileId)만 담고,
  // 실제 이미지 dataUrl은 카드별 파일로 쪼개 저장해 V8 문자열 한계(~512MB)를 회피한다.
  // 기존 단일 백업 파일(appFileName)은 절대 건드리지 않아 롤백이 항상 가능하다(비파괴).
  function loraMainFileName(){
    const base=(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME) ? GIST_FILE_NAME.replace(/\.json$/,'') : 'lora_lab_data';
    return base+'_drive_v2.json';
  }
  function loraImgFileName(cardId){
    return 'lora_lab_img_'+String(cardId||'').replace(/[^a-zA-Z0-9_-]/g,'')+'.json';
  }
  // 이미지 세트 변경 감지용 시그니처(재업로드 스킵 판단). id + dataUrl 길이 조합.
  function loraCardImageSig(card){
    const imgs=Array.isArray(card&&card.images)?card.images:[];
    return imgs.map(im=>(im&&im.id||'')+':'+(im&&im.dataUrl?im.dataUrl.length:0)).join('|');
  }

  async function uploadDriveSlotLoRA(){
    try{
      setStatus('Drive 저장 중... (이미지 분리 저장)','loading');
      if(typeof saveCardsToIndexedDBNow==='function') await saveCardsToIndexedDBNow();
      else if(typeof save==='function') save();

      const cards=(state&&Array.isArray(state.cards))?state.cards:[];
      const mainName=loraMainFileName();

      // 기존 v2 메인 파일에서 이전 슬롯/이미지 참조를 읽어온다(있으면 변경분만 올린다).
      let prevSlots=[];
      const mainFile=await findDriveFileByName(mainName);
      if(mainFile){
        try{ const d=await readDriveFile(mainFile.id); prevSlots=Array.isArray(d.slots)?d.slots:[]; }catch(e){ prevSlots=[]; }
      }
      const prevRef={};
      const prevTop=prevSlots[0];
      if(prevTop && Array.isArray(prevTop.cards)){
        prevTop.cards.forEach(c=>{ if(c&&c.id) prevRef[c.id]={imageFileId:c.imageFileId||'', sig:c.imageSig||''}; });
      }

      // 이미지 파일 목록을 한 번에 조회해둔다(카드별 검색 대신 이 맵을 참조 → 중복 생성 방지 + 속도).
      setStatus('Drive 이미지 목록 확인 중...','loading');
      let imgFileMap={};
      try{ imgFileMap=await listDriveFilesByPrefix('lora_lab_img_'); }catch(e){ imgFileMap={}; }

      let uploaded=0, skipped=0, imgErrors=0, idx=0;
      const total=cards.length;
      const mainCards=[];
      for(const card of cards){
        idx++;
        setStatus(`이미지 저장 중 (${idx}/${total})\n${(card.title||'제목 없음').slice(0,40)}`,'loading');
        const imgs=Array.isArray(card.images)?card.images.filter(im=>im&&im.dataUrl):[];
        const sig=loraCardImageSig(card);
        // 이미지/무거운 레거시 필드를 제외한 메타만 복사
        const meta={};
        for(const k in card){
          if(k==='images'||k==='representativeImage'||k==='rawMetadata') continue;
          meta[k]=card[k];
        }
        meta.imageMeta=imgs.map(im=>({id:im.id,name:im.name,addedAt:im.addedAt}));
        meta.imagesStripped=true;
        meta.imageSig=sig;

        if(imgs.length===0){ meta.imageFileId=''; mainCards.push(meta); continue; }

        const prev=prevRef[card.id];
        if(prev && prev.imageFileId && prev.sig===sig){
          meta.imageFileId=prev.imageFileId; mainCards.push(meta); skipped++; continue;
        }
        try{
          const imgName=loraImgFileName(card.id);
          const existingId=(prev&&prev.imageFileId)||imgFileMap[imgName]||null;
          const imgPayload={version:1,kind:'lora-lab-card-images',cardId:card.id,images:imgs.map(im=>({id:im.id,name:im.name,dataUrl:im.dataUrl,addedAt:im.addedAt}))};
          let written;
          try{
            written=await writeDriveFile(existingId, imgPayload, imgName);
          }catch(inner){
            // 재사용하려던 파일 ID가 유효하지 않으면(수동 삭제 등) 새로 생성해 재시도한다.
            if(existingId) written=await writeDriveFile(null, imgPayload, imgName);
            else throw inner;
          }
          if(written&&written.id) imgFileMap[imgName]=written.id;
          meta.imageFileId=written.id; mainCards.push(meta); uploaded++;
        }catch(e){
          imgErrors++; meta.imageFileId=''; meta.imageUploadError=true; mainCards.push(meta);
        }
      }

      // 이미지 업로드가 하나라도 실패하면 메인 파일을 새로 쓰지 않고 중단한다.
      // 로컬 원본과 기존 백업이 그대로 남으므로 데이터는 안전하다.
      if(imgErrors>0){
        setStatus(`이미지 ${imgErrors}개 카드 업로드에 실패해서 저장을 멈췄어.\n로컬 원본과 기존 백업은 그대로야. 잠시 후 다시 시도해줘.`,'err');
        return;
      }

      const maxSlots=getDriveSlotMax();
      const currentSlot={savedAt:nowIso(),device:deviceName(),app:appLabel(),cards:mainCards};
      const slots=[currentSlot, ...prevSlots].slice(0,maxSlots);

      const payload={version:2,kind:'lora-lab-drive-slots-split',appFile:mainName,updatedAt:nowIso(),slots};
      const approx=byteSizeOfJson(payload);
      setStatus(`메인 파일 저장 중...\n메인 크기: ${formatBytes(approx)} (이미지 제외)\n이미지 파일: 신규/갱신 ${uploaded} · 재사용 ${skipped}`,'loading');

      const writtenMain=await writeDriveFile(mainFile?mainFile.id:null, payload, mainName);

      // read-back 검증: 메인을 다시 읽어 이미지 참조 수를 확인한다.
      let verifyMsg='';
      try{
        const rb=await readDriveFile(writtenMain.id);
        const rbCards=(rb.slots&&rb.slots[0]&&rb.slots[0].cards)||[];
        const refCount=rbCards.filter(c=>c.imageFileId).length;
        verifyMsg=`\n검증 OK · 이미지 참조 ${refCount}개 확인`;
      }catch(e){
        verifyMsg='\n⚠ 검증 재읽기는 실패했지만 저장 자체는 됐을 수 있어. 기존 백업은 그대로야.';
      }

      setStatus(`Drive 저장 완료! (분리 저장)\n메인: ${writtenMain.name}\n슬롯: ${slots.length}개 · 메인 ${formatBytes(approx)}${verifyMsg}`,'ok');
      safeToast('☁️ Drive 분리 저장 완료');
    }catch(e){
      setStatus('Drive 저장 실패: '+(e.message||e)+'\n(로컬 원본과 기존 백업은 안전해)','err');
    }
  }

  async function applyDriveStateLoRA(slot){
    const cards=(slot&&Array.isArray(slot.cards))?slot.cards:[];
    // 복원 전, 현재 로컬 카드에서 cardId -> {images, sig} 맵을 만든다.
    // 슬롯 카드의 imageSig와 로컬 sig가 같으면 Drive에서 다시 받지 않고 로컬 이미지를 재사용한다.
    const localMap={};
    const curCards=(state&&Array.isArray(state.cards))?state.cards:[];
    curCards.forEach(lc=>{ if(lc&&lc.id) localMap[lc.id]={images:Array.isArray(lc.images)?lc.images:[], sig:loraCardImageSig(lc)}; });

    let missing=0, reused=0, fetched=0, idx=0;
    const total=cards.length;
    const rebuilt=[];
    for(const c of cards){
      idx++;
      const card=Object.assign({},c);
      if(card.imagesStripped){
        const local=localMap[card.id];
        if(local && card.imageSig && local.sig===card.imageSig){
          // 로컬에 동일 구성 이미지가 있음 → 다운로드 생략, 로컬 것 재사용
          card.images=local.images; reused++;
          setStatus(`불러오는 중 (${idx}/${total})\n로컬 재사용 ${reused} · 다운로드 ${fetched}\n${(c&&c.title||'제목 없음').slice(0,40)}`,'loading');
        }else if(card.imageFileId){
          setStatus(`이미지 불러오는 중 (${idx}/${total})\n로컬 재사용 ${reused} · 다운로드 ${fetched+1}\n${(c&&c.title||'제목 없음').slice(0,40)}`,'loading');
          try{
            const imgData=await readDriveFile(card.imageFileId);
            card.images=Array.isArray(imgData.images)?imgData.images:[]; fetched++;
          }catch(e){ card.images=[]; missing++; }
        }else{
          card.images=[];
        }
        delete card.imageMeta; delete card.imagesStripped; delete card.imageSig; delete card.imageUploadError;
      }else if(!Array.isArray(card.images)){
        card.images=[];
      }
      rebuilt.push(card);
    }
    state.cards = typeof normalizeCard==='function' ? rebuilt.map(normalizeCard) : rebuilt;
    if(state.selected && typeof state.selected.clear==='function') state.selected.clear();
    state.selectedId=state.cards[0]?.id||null;
    if('selectMode' in state) state.selectMode=false;
    if(typeof saveCardsToIndexedDBNow==='function') await saveCardsToIndexedDBNow();
    else if(typeof save==='function') save();
    if(typeof render==='function') render();
    if(reused||fetched) safeToast(`☁️ 복원: 로컬 재사용 ${reused} · 새로 받음 ${fetched}`);
    if(missing>0) safeToast(`⚠ 이미지 파일 ${missing}개를 못 찾아 해당 카드는 이미지 없이 복원했어.`);
  }
  // ===== /LoRA Lab 전용 =====

  async function applyDriveState(slot){
    const incoming=slot.state || slot;
    try{
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='lora_lab_data.json'){
        const cards=incoming.cards || slot.cards || [];
        // v2 분리형 슬롯(imagesStripped)이면 이미지 파일을 fetch해 재조립하고,
        // 구형 슬롯(dataUrl 통째)이면 기존 방식대로 바로 복원한다.
        const isSplit=cards.some(c=>c&&c.imagesStripped);
        if(isSplit){
          await applyDriveStateLoRA({cards});
          return;
        }
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

  // 임의 파일명으로 appDataFolder에서 파일 하나를 찾는다. (분리 저장용)
  async function findDriveFileByName(name){
    const safe=String(name).replace(/'/g,"\\'");
    const params=new URLSearchParams({
      spaces:'appDataFolder',
      fields:'files(id,name,modifiedTime,size)',
      q:`name='${safe}' and 'appDataFolder' in parents and trashed=false`
    });
    const res=await driveFetch(DRIVE_API+'?'+params.toString());
    const data=await res.json();
    return data.files?.[0]||null;
  }

  // 접두사로 시작하는 파일들을 한 번에(페이지네이션 포함) 조회해 {파일명: id} 맵으로 돌려준다.
  // 카드마다 개별 검색하던 걸 1회 조회로 줄이고, 중단 후 재저장 시 중복 생성을 막는다.
  async function listDriveFilesByPrefix(prefix){
    const map={};
    const safe=String(prefix).replace(/'/g,"\\'");
    let pageToken='';
    do{
      const params=new URLSearchParams({
        spaces:'appDataFolder',
        fields:'nextPageToken,files(id,name)',
        q:`name contains '${safe}' and 'appDataFolder' in parents and trashed=false`,
        pageSize:'1000'
      });
      if(pageToken) params.set('pageToken',pageToken);
      const res=await driveFetch(DRIVE_API+'?'+params.toString());
      const data=await res.json();
      (data.files||[]).forEach(f=>{ if(f&&f.name&&f.name.indexOf(prefix)===0&&!(f.name in map)) map[f.name]=f.id; });
      pageToken=data.nextPageToken||'';
    }while(pageToken);
    return map;
  }

  function multipartBody(metadata, contentObj){
    const boundary='workshop_drive_'+Math.random().toString(36).slice(2);
    // 대용량 이미지가 많은 앱에서는 pretty-print 공백도 수 MB까지 불어날 수 있어서 compact JSON으로 저장한다.
    const content=JSON.stringify(contentObj);
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    return {body,boundary};
  }

  async function writeDriveFile(fileId, payload, fileName){
    const nm=fileName||appFileName();
    const metadata=fileId?{}:{name:nm,parents:['appDataFolder'],mimeType:'application/json'};
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
    if(isLoRALabApp()) return await uploadDriveSlotLoRA();
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
      let file=null;
      if(isLoRALabApp()){
        // v2 분리형 메인 파일을 먼저 찾고, 없으면 구형 단일 파일로 폴백한다.
        file=await findDriveFileByName(loraMainFileName());
        if(!file) file=await findDriveFile();
      }else{
        file=await findDriveFile();
      }
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
