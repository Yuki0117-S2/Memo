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
  function isResultGalleryApp(){
    try{return typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='result_gallery_data.json';}
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
    // LoRA Lab · Result Gallery는 이미지 dataUrl이 커서 슬롯을 많이 누적하면
    // 같은 데이터라도 재저장 때 Invalid string length가 날 수 있다.
    // 그래서 이 두 앱은 Drive에 최신 백업 2개까지만 보존한다.
    return (isLoRALabApp()||isResultGalleryApp())?2:SLOT_MAX;
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

  // ===== Result Gallery 전용: 이미지 분리 저장 (LoRA Lab v2 이식) =====
  // 메인 파일엔 항목 메타 + 이미지 참조(imageFileId)만 담고,
  // 대표 thumb + 보조 subs의 dataUrl은 항목별 파일로 쪼개 저장해 V8 문자열 한계(~512MB)를 회피한다.
  // 기존 단일 백업 파일(appFileName)은 절대 건드리지 않아 롤백이 항상 가능하다(비파괴).
  function rgMainFileName(){
    const base=(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME) ? GIST_FILE_NAME.replace(/\.json$/,'') : 'result_gallery_data';
    return base+'_drive_v2.json';
  }
  function rgImgFileName(itemId){
    return 'rg_img_'+String(itemId||'').replace(/[^a-zA-Z0-9_-]/g,'')+'.json';
  }
  // 이미지 세트 변경 감지용 시그니처(재업로드 스킵 판단). 대표 thumb 길이 + 보조별 id:길이.
  function rgItemImageSig(it){
    const subs=Array.isArray(it&&it.subs)?it.subs:[];
    return 'm:'+((it&&it.thumb)?it.thumb.length:0)+'|'+subs.map(s=>((s&&s.id)||'')+':'+((s&&s.thumb)?s.thumb.length:0)).join('|');
  }
  // 항목에서 이미지(dataUrl)를 뺀 메타 사본을 만든다. 보조는 껍데기(썸네일 제외)로 유지해
  // 이미지 파일이 유실돼도 파일명·크기·해시 등 재매칭 단서는 살아남는다.
  function rgStripItem(it){
    const meta={};
    for(const k in it){
      if(k==='thumb'||k==='subs') continue;
      meta[k]=it[k];
    }
    meta.subs=(Array.isArray(it.subs)?it.subs:[]).map(s=>{
      const sub={};
      for(const k in s){ if(k==='thumb') continue; sub[k]=s[k]; }
      return sub;
    });
    return meta;
  }

  // SHA-256은 이미지별로 계산해 카드 전체 base64를 한 문자열로 합치지 않는다.
  async function rgSha256(text){
    if(!globalThis.crypto?.subtle)throw new Error('이 환경에서는 안전한 이미지 비교를 사용할 수 없어. 저장을 중단했어.');
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function rgStrongImageSig(it){
    const hashes=[];
    for(const sub of (Array.isArray(it.subs)?it.subs:[])){
      if(sub&&sub.thumb)hashes.push([sub.id||'',await rgSha256(sub.thumb)]);
    }
    return 'sha256:'+await rgSha256(JSON.stringify([await rgSha256(it.thumb||''),hashes]));
  }
  function rgDriveFileStamp(file){
    return file?.version&&file?.md5Checksum&&file?.size!=null
      ?JSON.stringify([String(file.version),file.md5Checksum,String(file.size)]):'';
  }
  function rgSameImageContents(a,b){
    if((a.thumb||'')!==(b.thumb||''))return false;
    const left=(a.subs||[]).filter(s=>s&&s.thumb),right=(b.subs||[]).filter(s=>s&&s.thumb);
    return left.length===right.length&&left.every((s,i)=>(s.id||'')===(right[i].id||'')&&s.thumb===right[i].thumb);
  }
  async function rgReadFileStamp(id){
    const params=new URLSearchParams({fields:'id,version,md5Checksum,size'});
    const file=await (await driveFetch(DRIVE_API+'/'+encodeURIComponent(id)+'?'+params.toString())).json();
    return file.id===id?rgDriveFileStamp(file):'';
  }
  function rgCheckpointStore(scope){
    // Small, separate records: never touch gallery data or credentials.
    const prefix='rg_drive_resume_v1:'+scope+':';
    // Non-browser test harnesses may omit storage entirely.
    if(typeof localStorage==='undefined'&&typeof document==='undefined')return {persistent:false,get:()=>null,put:()=>{}};
    return {
      persistent:true,
      get(cardId){
        let raw;
        try{raw=localStorage.getItem(prefix+cardId);}catch(e){throw new Error('비교 재개 정보를 읽을 수 없어 저장을 중단했어: '+e.message);}
        try{return raw?JSON.parse(raw):null;}catch{return null;}
      },
      put(cardId,entry){
        try{localStorage.setItem(prefix+cardId,JSON.stringify(entry));}
        catch(e){throw new Error('완료한 비교의 재개 정보를 저장하지 못했어. 기존 데이터는 지우지 말고 이 오류를 전달해줘: '+e.message);}
      }
    };
  }

  async function rgExistingImageIds(){
    const ids=new Set();ids.stamps=new Map();let pageToken='';
    do{
      const params=new URLSearchParams({spaces:'appDataFolder',fields:'nextPageToken,files(id,version,md5Checksum,size)',
        q:"name contains 'rg_img_' and 'appDataFolder' in parents and trashed=false",pageSize:'1000'});
      if(pageToken)params.set('pageToken',pageToken);
      const data=await (await driveFetch(DRIVE_API+'?'+params.toString())).json();
      (data.files||[]).forEach(file=>{if(file.id){ids.add(file.id);const stamp=rgDriveFileStamp(file);if(stamp)ids.stamps.set(file.id,stamp);}});pageToken=data.nextPageToken||'';
    }while(pageToken);
    return ids;
  }

  // Read-only preflight: inspect presence/flags, never hash, restore, or remove images.
  function rgRecordSaveStage(phase,done,total){
    try{if(typeof localStorage!=='undefined')localStorage.setItem('rg_drive_last_stage_v1',JSON.stringify({phase,done,total,at:new Date().toISOString()}));}catch(_){}
  }
  // ── Result Gallery Drive 저장 실패 이력 ──
  // 실패하면 상세를 쌓고, Drive 저장이 성공하면 상세를 지우고 요약 1줄(최근 5개)만 남긴다. Gist 이력과는 서로 건드리지 않는다.
  const RG_DRIVE_HIST_KEY='rg_drive_fail_history_v1',RG_DRIVE_SUM_KEY='rg_drive_fail_summary_v1',RG_MAIN_READ_DIAG_KEY='rg_drive_main_read_fail_v1';
  function rgLsGet(key,fallback){try{if(typeof localStorage==='undefined')return fallback;const v=JSON.parse(localStorage.getItem(key)||'null');return v==null?fallback:v;}catch(_){return fallback;}}
  function rgLsSet(key,value){try{if(typeof localStorage!=='undefined')localStorage.setItem(key,JSON.stringify(value));}catch(_){}}
  function rgLsDel(key){try{if(typeof localStorage!=='undefined')localStorage.removeItem(key);}catch(_){}}
  function rgTakeMainReadDiag(){const d=rgLsGet(RG_MAIN_READ_DIAG_KEY,null);if(d)rgLsDel(RG_MAIN_READ_DIAG_KEY);return d;}
  function rgDriveHistoryGet(){
    const list=rgLsGet(RG_DRIVE_HIST_KEY,[]);
    const arr=Array.isArray(list)?list:[];
    // 이전 버전에서 따로 남긴 메인 읽기 진단 기록은 이력 한 건으로 옮긴다.
    const leftover=rgTakeMainReadDiag();
    if(leftover){arr.push({at:leftover.at||'',stage:'(이전 기록)',error:leftover.error||'',mainRead:leftover});rgLsSet(RG_DRIVE_HIST_KEY,arr.slice(-20));}
    return arr.slice(-20);
  }
  function rgDriveHistoryAdd(entry){const list=rgDriveHistoryGet();list.push(entry);rgLsSet(RG_DRIVE_HIST_KEY,list.slice(-20));}
  function rgDriveHistoryResolve(){
    const list=rgDriveHistoryGet();
    if(list.length){
      const last=list[list.length-1];
      const sums=rgLsGet(RG_DRIVE_SUM_KEY,[]);
      const arr=Array.isArray(sums)?sums:[];
      arr.push({from:list[0].at||'',to:last.at||'',count:list.length,lastStage:last.stage||'',lastError:last.error||'',resolvedAt:new Date().toISOString()});
      rgLsSet(RG_DRIVE_SUM_KEY,arr.slice(-5));
    }
    rgLsDel(RG_DRIVE_HIST_KEY);rgLsDel(RG_MAIN_READ_DIAG_KEY);
  }
  function rgDriveHistoryLines(){
    const lines=['Drive 저장 실패 이력 (Drive 저장이 성공하면 요약 1줄로 정리됩니다)'];
    const list=rgDriveHistoryGet();
    if(!list.length)lines.push('  현재 해결되지 않은 Drive 저장 실패 없음');
    for(const e of list){
      lines.push('  - '+(e.at||'?')+' · 단계: '+(e.stage||'?')+' · 오류: '+(e.error||'?'));
      const f=e.mainRead;
      if(f){
        lines.push('    메인 읽기 · 파일 ID: '+(f.fileId||'?')+' · Drive 표시 크기: '+(f.driveSize??'?')+' bytes · 다시 받은 크기: '+(f.receivedBytes??'?')+' bytes'+(f.rereadError?' · 재조회 실패: '+f.rereadError:'')+(f.metaError?' · 정보 조회 실패: '+f.metaError:''),
          '    수정 시각: '+(f.modifiedTime||'?')+' · 버전: '+(f.version||'?'),
          '    앞부분: '+JSON.stringify(f.head??''),'    끝부분: '+JSON.stringify(f.tail??''));
      }
    }
    const sums=rgLsGet(RG_DRIVE_SUM_KEY,[]);
    if(Array.isArray(sums)&&sums.length){
      lines.push('Drive 해결된 실패 요약 (최근 5개)');
      for(const s of sums)lines.push('  - '+s.from+' ~ '+s.to+' 실패 '+s.count+'회 → '+s.resolvedAt+' 저장 성공 · 마지막 단계: '+s.lastStage+' · 마지막 오류: '+s.lastError);
    }
    lines.push('');
    return lines;
  }

  // ── Result Gallery 전용 스트리밍 판독기 ──
  // 메인 백업을 문자열 하나로 만들지 않고 바이트를 흘려 읽는다. 괄호·따옴표만 추적해
  // 루트 정보, 슬롯 정보(items 제외), 카드(선택)를 한 건씩 잘라 해석한다. 한 번에 메모리에 올라가는 건 카드 1장 분량.
  async function rgStreamMainSlots(fileId,opt={}){
    const res=await driveFetch(`${DRIVE_API}/${fileId}?alt=media`);
    if(!res.body||typeof res.body.getReader!=='function')throw new Error('이 환경에서는 Drive 백업을 나눠 읽을 수 없어.');
    const reader=res.body.getReader();
    const dec=new TextDecoder('utf-8');
    const Q=34,BS=92,LB=123,RB=125,LS=91,RS=93,CO=58,CM=44;
    const stack=[],slots=[];
    let inStr=false,esc=false,keyBuf=null,read=0,header=null,slotIndex=-1,itemIndex=0,lastProg=0;
    let rootRec=null,slotRec=null,itemRec=null;
    const newRec=()=>({parts:[],start:-1,on:false});
    const recOn=(r,i)=>{r.on=true;r.start=i;};
    const recOff=(r,chunk,i)=>{r.parts.push(chunk.slice(r.start,i+1));r.on=false;r.start=-1;};
    const recText=r=>{let n=0;for(const p of r.parts)n+=p.length;const u=new Uint8Array(n);let o=0;for(const p of r.parts){u.set(p,o);o+=p.length;}return dec.decode(u);};
    const bad=()=>new Error('백업 파일 구조가 예상과 달라 읽기를 멈췄어.');
    try{
      for(;;){
        const {done,value:chunk}=await reader.read();
        if(done)break;
        read+=chunk.length;
        for(let i=0;i<chunk.length;i++){
          const c=chunk[i];
          if(inStr){
            if(esc){esc=false;if(keyBuf&&keyBuf.length<64)keyBuf.push(c);}
            else if(c===BS){esc=true;if(keyBuf&&keyBuf.length<64)keyBuf.push(c);}
            else if(c===Q){inStr=false;if(keyBuf){stack[stack.length-1].key=keyBuf.length<64?dec.decode(new Uint8Array(keyBuf)):'';keyBuf=null;}}
            else if(keyBuf&&keyBuf.length<64)keyBuf.push(c);
            continue;
          }
          if(c===Q){inStr=true;const top=stack[stack.length-1];if(top&&top.t==='o'&&top.expectKey)keyBuf=[];continue;}
          if(c===CO){const top=stack[stack.length-1];if(top&&top.t==='o')top.expectKey=false;continue;}
          if(c===CM){const top=stack[stack.length-1];if(top&&top.t==='o'){top.expectKey=true;top.key='';}continue;}
          if(c===LB||c===LS){
            const parent=stack[stack.length-1];let role='';
            if(!parent){if(c!==LB)throw bad();role='root';}
            else if(parent.role==='root'&&c===LS&&parent.key==='slots')role='slots';
            else if(parent.role==='slots'&&c===LB)role='slot';
            else if(parent.role==='slot'&&c===LS&&parent.key==='items')role='items';
            else if(opt.v3&&parent.role==='root'&&c===LS&&parent.key==='items')role='items';
            else if(parent.role==='items'&&c===LB)role='item';
            stack.push({t:c===LB?'o':'a',role,key:'',expectKey:c===LB});
            if(role==='root'){rootRec=newRec();recOn(rootRec,i);}
            else if(role==='slots')recOff(rootRec,chunk,i);
            else if(role==='slot'){slotIndex++;itemIndex=0;slotRec=newRec();recOn(slotRec,i);}
            else if(role==='items'){if(opt.v3){recOff(rootRec,chunk,i);slotIndex=0;itemIndex=0;}else recOff(slotRec,chunk,i);}
            else if(role==='item'&&opt.onItem&&(!opt.itemFilter||opt.itemFilter(slotIndex))){itemRec=newRec();recOn(itemRec,i);}
            continue;
          }
          if(c===RB||c===RS){
            const top=stack.pop();
            if(!top)throw bad();
            if(top.role==='item'){
              if(itemRec){recOff(itemRec,chunk,i);const item=JSON.parse(recText(itemRec));itemRec=null;await opt.onItem(item,slotIndex,itemIndex);}
              itemIndex++;
            }else if(top.role==='items')recOn(opt.v3?rootRec:slotRec,i);
            else if(top.role==='slot'){
              recOff(slotRec,chunk,i);const meta=JSON.parse(recText(slotRec));slotRec=null;
              slots.push({meta,count:itemIndex});
              if(opt.onSlotEnd)await opt.onSlotEnd(meta,slotIndex,itemIndex);
            }
            else if(top.role==='slots')recOn(rootRec,i);
            else if(top.role==='root'){recOff(rootRec,chunk,i);header=JSON.parse(recText(rootRec));rootRec=null;if(opt.v3)slots.push({meta:header,count:itemIndex});}
          }
        }
        for(const r of [rootRec,slotRec,itemRec])if(r&&r.on){r.parts.push(chunk.slice(r.start));r.start=0;}
        if(opt.onProgress){const now=Date.now();if(now-lastProg>300){lastProg=now;opt.onProgress(read);}}
      }
    }finally{try{reader.cancel().catch(()=>{});}catch(_){}}
    if(!header||stack.length||inStr)throw new Error('백업 파일이 끝까지 온전하지 않아 읽기를 멈췄어.');
    if(opt.onProgress)opt.onProgress(read);
    return {header,slots,bytes:read};
  }
  // ── Drive v3: 색인 + 슬롯 파일 A/B/C/D 4개 순환 ──
  // 색인이 커밋 지점. 슬롯을 쓰고 검증한 뒤에만 색인을 바꾼다. 순서는 글자가 아니라 세대 번호로 판단한다.
  const RG_V3_SLOTS=['A','B','C','D'];
  function rgV3Base(){const n=rgMainFileName();return n.endsWith('_drive_v2.json')?n.slice(0,-'_drive_v2.json'.length):n.replace(/\.json$/,'');}
  function rgV3IndexName(){return rgV3Base()+'_drive_v3_index.json';}
  function rgV3IndexBackupName(){return rgV3Base()+'_drive_v3_index_backup.json';}
  function rgV3SlotName(letter){return rgV3Base()+'_drive_v3_slot_'+letter+'.json';}
  function rgV3ValidIndex(d){return !!(d&&d.kind==='result-gallery-drive-v3-index'&&d.slots&&typeof d.slots==='object');}
  async function rgV3Load(){
    const out={index:null,indexFile:null,backupFile:null,indexStamp:'',fromBackup:false,slotStates:{}};
    out.indexFile=await findDriveFileByName(rgV3IndexName());
    out.backupFile=await findDriveFileByName(rgV3IndexBackupName());
    if(!out.indexFile&&!out.backupFile)return out;
    if(out.indexFile){
      out.indexStamp=await rgReadFileStamp(out.indexFile.id);
      try{const d=await readDriveFile(out.indexFile.id);if(rgV3ValidIndex(d))out.index=d;}catch(_){}
    }
    if(!out.index&&out.backupFile){
      try{const d=await readDriveFile(out.backupFile.id);if(rgV3ValidIndex(d)){out.index=d;out.fromBackup=true;}}catch(_){}
    }
    if(!out.index)throw new Error('Drive 백업 색인을 읽을 수 없어. 기존 백업을 덮어쓰지 않고 중단했어. 불러오기에서 "색인 재구성"을 눌러줘.');
    for(const L of RG_V3_SLOTS){
      const e=out.index.slots[L];
      if(!e||!e.fileId){out.slotStates[L]='empty';continue;}
      let st='';try{st=await rgReadFileStamp(e.fileId);}catch(_){st='';}
      out.slotStates[L]=(st&&st===e.stamp)?'ok':'broken';
    }
    return out;
  }
  function rgV3MaxGeneration(v3){let g=0;for(const L of RG_V3_SLOTS){const e=v3.index?.slots?.[L];if(e&&Number(e.generation)>g)g=Number(e.generation);}return g;}
  function rgV3LatestValid(v3){
    let best=null;
    for(const L of RG_V3_SLOTS){const e=v3.index?.slots?.[L];if(e&&v3.slotStates[L]==='ok'&&(!best||Number(e.generation)>Number(best.entry.generation)))best={letter:L,entry:e};}
    return best;
  }
  function rgV3PickTarget(v3){
    if(!v3.index)return 'A';
    const empty=RG_V3_SLOTS.find(L=>v3.slotStates[L]==='empty');if(empty)return empty;
    const broken=RG_V3_SLOTS.find(L=>v3.slotStates[L]==='broken');if(broken)return broken;
    let pick=RG_V3_SLOTS[0];
    for(const L of RG_V3_SLOTS)if(Number(v3.index.slots[L].generation)<Number(v3.index.slots[pick].generation))pick=L;
    return pick;
  }
  async function rgV3CheckUnchanged(v3){
    const f=await findDriveFileByName(rgV3IndexName());
    if((f?.id||null)!==(v3.indexFile?.id||null))throw new Error('저장 중 Drive 백업 색인이 바뀌었어. 다시 저장해줘.');
    if(f&&await rgReadFileStamp(f.id)!==v3.indexStamp)throw new Error('다른 저장 작업이 백업 색인을 변경했어. 다시 저장해줘.');
  }
  async function rgV3SlotBlob(header,items,letter){
    const h=JSON.stringify(header);
    const parts=[new Blob([h.slice(0,-1)+',"items":['])];
    for(let i=0;i<items.length;i++){
      parts.push(new Blob([(i?',':'')+JSON.stringify(items[i])]));
      if(i%128===0){
        rgRecordSaveStage('슬롯 '+letter+' 본문 구성',i,items.length);
        setStatus('슬롯 '+letter+' 본문 구성 ('+i+'/'+items.length+')','loading');
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    parts.push(new Blob([']}']));
    return new Blob(parts,{type:'application/json'});
  }

  function rgFormatSavedAt(iso){
    if(!iso)return '저장 시각 불명';
    const d=new Date(iso);if(isNaN(d))return '저장 시각 불명';
    return d.toLocaleString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  function rgActionButton(title,info,onClick){
    const b=document.createElement('button');b.type='button';b.className='drive-slot';
    const box=document.createElement('div');
    const t=document.createElement('b');t.textContent=title;
    const i=document.createElement('span');i.textContent=info||'';
    box.append(t,i);b.appendChild(box);
    const arrow=document.createElement('i');arrow.textContent='›';b.appendChild(arrow);
    b.onclick=async()=>{try{await onClick();}catch(e){setStatus((e&&e.message)||String(e),'err');}};
    return b;
  }
  function rgMb(n){return (n/1048576).toFixed(0)+'MB';}
  // v2 메인을 스트리밍으로 읽어 슬롯 목록을 보여주고, 고른 슬롯을 카드 단위로 복원한다.
  async function rgListV2SlotsStreaming(file){
    const total=Number(file.size)||0;
    setStatus('구형 백업(v2) 목록 읽는 중… (파일 전체를 나눠 읽어서 시간이 조금 걸려)','loading');
    const result=await rgStreamMainSlots(file.id,{onProgress:read=>setStatus('구형 백업(v2) 목록 읽는 중… '+rgMb(read)+(total?' / '+rgMb(total):''),'loading')});
    if(!result.slots.length){setStatus('저장된 슬롯이 비어 있어.','err');return;}
    setStatus('구형 백업(v2) 슬롯 '+result.slots.length+'개. 불러올 슬롯을 골라줘. 현재 로컬 데이터는 덮어써져.','');
    const list=q('#drive-slot-list');list.innerHTML='';
    result.slots.forEach((slot,i)=>{
      const info=rgFormatSavedAt(slot.meta.savedAt)+' · '+(slot.meta.device||'기기 불명')+' · 카드 '+slot.count+'개';
      list.appendChild(rgActionButton((i===0?'📦 v2 최신':'📦 v2 슬롯 '+(i+1)),info,async()=>{
        if(!confirm('현재 로컬 데이터를 구형 백업(v2) 슬롯 '+(i+1)+'('+rgFormatSavedAt(slot.meta.savedAt)+' · 카드 '+slot.count+'개)으로 덮어쓸까?'))return;
        if(rgDriveUploading)throw new Error('Drive 저장이 끝난 뒤 다시 시도해줘.');
        await applyDriveStateRG({itemCount:slot.count,rgStreamItems:async handle=>{
          await rgStreamMainSlots(file.id,{itemFilter:si=>si===i,onItem:async(it,si)=>{if(si===i)await handle(it);}});
        }});
        setStatus('Drive 불러오기 완료. (구형 v2 슬롯 '+(i+1)+')','ok');safeToast('☁️ Drive 불러오기 완료');closeModal();
      }));
    });
  }
  // v3 슬롯 파일 하나를 카드 단위로 흘려 읽으며 복원한다. 파일이 끝까지 온전해야 로컬에 반영된다.
  async function rgRestoreV3Slot(letter,entry){
    if(rgDriveUploading)throw new Error('Drive 저장이 끝난 뒤 다시 시도해줘.');
    const total=Number(entry.bytes)||0;
    await applyDriveStateRG({itemCount:entry.itemCount,rgStreamItems:async handle=>{
      const r=await rgStreamMainSlots(entry.fileId,{v3:true,onItem:async it=>handle(it),
        onProgress:read=>setStatus('슬롯 '+letter+' 읽는 중… '+rgMb(read)+(total?' / '+rgMb(total):''),'loading')});
      const h=r.header;
      if(h?.kind!=='result-gallery-drive-v3-slot'||h.letter!==letter||r.slots[0]?.count!==Number(h.itemCount))throw new Error('슬롯 '+letter+' 파일이 온전하지 않아 복원을 중단했어. 로컬 데이터는 아직 변경하지 않았어.');
    }});
  }
  async function rgDeleteV2(file){
    if(rgDriveUploading||rgDriveRecovering)throw new Error('진행 중인 저장/복구가 끝난 뒤 다시 눌러줘.');
    const v3=await rgV3Load();
    if(!v3.index||rgV3MaxGeneration(v3)<2||!rgV3LatestValid(v3))throw new Error('v3 저장이 2번 이상 성공한 뒤에만 정리할 수 있어.');
    const size=formatBytes(Number(file.size)||0);
    if(!confirm('구형 백업(v2) 메인 파일을 Drive에서 삭제할까?\n파일: '+file.name+'\n크기: '+size+'\n\nv3 슬롯과 이미지 파일은 지우지 않아.\n이 삭제는 되돌릴 수 없어.'))return;
    await driveFetch(DRIVE_API+'/'+encodeURIComponent(file.id),{method:'DELETE'});
    await rgListSlotsRG();
    setStatus('구형 백업(v2) 메인 파일을 삭제했어.\n삭제한 파일: '+file.name+' ('+size+')\nv3 슬롯과 이미지 파일은 그대로야.','ok');
  }
  // 색인 2개가 모두 읽히지 않을 때: 슬롯 파일을 끝까지 읽어 자기 정보로 색인을 다시 만든다. 슬롯·이미지는 바꾸지 않는다.
  async function rgV3RebuildIndex(){
    if(rgDriveUploading||rgDriveRecovering)throw new Error('진행 중인 저장/복구가 끝난 뒤 다시 눌러줘.');
    if(!confirm('슬롯 파일 A~D를 끝까지 읽어 색인을 다시 만들까?\n슬롯 파일과 이미지는 바꾸지 않고, 색인 파일 2개만 새로 써.'))return;
    rgDriveUploading=true;try{window.rgDriveSaveBusy=true;}catch(_){}
    try{
      const found={},notes=[];
      for(const L of RG_V3_SLOTS){
        const f=await findDriveFileByName(rgV3SlotName(L));
        if(!f){found[L]=null;continue;}
        try{
          const refs=[];const total=Number(f.size)||0;
          const r=await rgStreamMainSlots(f.id,{v3:true,onItem:async it=>{refs.push([it.id,it.imageFileId||'',it.imageSig||'',it.rgImageRevision??null,it.rgTrackingVersion??null]);},
            onProgress:read=>setStatus('색인 재구성: 슬롯 '+L+' 확인 중… '+rgMb(read)+(total?' / '+rgMb(total):''),'loading')});
          const h=r.header;
          if(h?.kind!=='result-gallery-drive-v3-slot'||h.letter!==L||r.slots[0]?.count!==Number(h.itemCount))throw new Error('자기 정보와 내용이 맞지 않음');
          found[L]={entry:{fileId:f.id,generation:h.generation,savedAt:h.savedAt,device:h.device,app:h.app,itemCount:h.itemCount,bytes:Number(f.size)||0,stamp:await rgReadFileStamp(f.id)},refs};
        }catch(e){found[L]=null;notes.push('슬롯 '+L+': '+((e&&e.message)||e));}
      }
      let latest=null;
      for(const L of RG_V3_SLOTS)if(found[L]&&(!latest||Number(found[L].entry.generation)>Number(found[latest].entry.generation)))latest=L;
      if(!latest)throw new Error('온전한 슬롯 파일을 찾지 못해 색인을 만들 수 없어.'+(notes.length?'\n'+notes.join('\n'):''));
      const idx={version:3,kind:'result-gallery-drive-v3-index',appFile:rgV3IndexName(),updatedAt:nowIso(),latest,slots:{},ref:found[latest].refs,rebuiltAt:nowIso()};
      for(const L of RG_V3_SLOTS)idx.slots[L]=found[L]?found[L].entry:null;
      const blob=new Blob([JSON.stringify(idx)],{type:'application/json'});
      for(const name of [rgV3IndexName(),rgV3IndexBackupName()]){
        const f=await findDriveFileByName(name);
        const w=await rgWriteMainBlob(f?.id||null,blob,name);
        if(!w?.id||!await rgVerifyMainBlob(w.id,blob))throw new Error(name+' 저장 후 검증 내용이 일치하지 않아.');
      }
      const kept=RG_V3_SLOTS.filter(L=>idx.slots[L]).map(L=>L+'(세대 '+idx.slots[L].generation+')').join(' · ');
      setStatus('색인 재구성 완료.\n보관 중인 슬롯: '+kept+(notes.length?'\n제외한 슬롯:\n'+notes.join('\n'):''),'ok');
    }finally{
      rgDriveUploading=false;
      try{window.rgDriveSaveBusy=false;if(typeof window.onResultGalleryDriveSaveEnd==='function')window.onResultGalleryDriveSaveEnd();}catch(_){}
    }
  }
  // 불러오기 목록 (Result Gallery): v3 슬롯을 세대 순으로 보여주고, 구형 v2가 있으면 보기/정리 항목을 붙인다.
  async function rgListSlotsRG(){
    const list=q('#drive-slot-list');list.innerHTML='';
    setStatus('Drive 백업 색인 확인 중…','loading');
    const v2File=await findDriveFileByName(rgMainFileName());
    let v3=null,v3Error=null;
    try{v3=await rgV3Load();}catch(e){v3Error=e;}
    if(!v3Error&&!v3.index&&!v2File)return false;
    let statusMsg='';
    if(v3Error){
      statusMsg=((v3Error&&v3Error.message)||String(v3Error))+'\n아래 "색인 재구성"으로 슬롯 파일에서 색인을 다시 만들 수 있어.';
      list.appendChild(rgActionButton('🛠 색인 재구성','슬롯 파일을 끝까지 읽어 색인 2개를 다시 만들어. 슬롯과 이미지는 바꾸지 않아.',rgV3RebuildIndex));
    }else if(v3.index){
      const filled=RG_V3_SLOTS.filter(L=>v3.index.slots[L]).sort((a,b)=>Number(v3.index.slots[b].generation)-Number(v3.index.slots[a].generation));
      const rec=rgV3LatestValid(v3);
      filled.forEach((L,k)=>{
        const e=v3.index.slots[L],ok=v3.slotStates[L]==='ok';
        const older=filled[k+1]?v3.index.slots[filled[k+1]]:null;
        let warn='';
        if(older&&Number(older.itemCount)>0&&Number(e.itemCount)<Number(older.itemCount)*0.9)warn=' · ⚠ 이전 세대보다 '+Math.round((1-Number(e.itemCount)/Number(older.itemCount))*100)+'% 적음';
        const title=(rec&&rec.letter===L?'🟢 추천 · ':ok?'📁 ':'⚠ ')+'슬롯 '+L+' · 세대 '+e.generation;
        const info=rgFormatSavedAt(e.savedAt)+' · '+(e.device||'기기 불명')+' · 카드 '+e.itemCount+'개 · '+formatBytes(Number(e.bytes)||0)+' · '+(ok?'정상':'손상(저장 중 중단됨) — 선택 불가')+warn;
        list.appendChild(rgActionButton(title,info,async()=>{
          if(!ok){setStatus('슬롯 '+L+'은 저장 중 중단돼 내용이 온전하지 않을 수 있어. 다른 슬롯을 골라줘.\n이 자리는 다음 저장 때 다시 써.','err');return;}
          if(!confirm('현재 로컬 데이터를 슬롯 '+L+'(세대 '+e.generation+' · '+rgFormatSavedAt(e.savedAt)+' · 카드 '+e.itemCount+'개)으로 덮어쓸까?'+(warn?'\n\n'+warn.replace(/^ · /,''):'')))return;
          await rgRestoreV3Slot(L,e);
          setStatus('Drive 불러오기 완료. (슬롯 '+L+' · 세대 '+e.generation+')','ok');safeToast('☁️ Drive 불러오기 완료');closeModal();
        }));
      });
      statusMsg='Drive 백업 슬롯 '+filled.length+'개 (v3). 불러올 슬롯을 골라줘. 현재 로컬 데이터는 덮어써져.'+(v3.fromBackup?'\n본 색인을 읽지 못해 예비 색인으로 표시했어. 다음 저장 때 본 색인을 다시 써.':'');
    }
    if(v2File){
      list.appendChild(rgActionButton('📦 구형 백업(v2) 보기',formatBytes(Number(v2File.size)||0)+' · 목록을 읽는 데 시간이 조금 걸려',()=>rgListV2SlotsStreaming(v2File)));
      if(v3?.index&&rgV3MaxGeneration(v3)>=2&&rgV3LatestValid(v3))list.appendChild(rgActionButton('🧹 구형 백업(v2) 정리','v3 저장이 2번 이상 성공했어. v2 메인 파일 1개만 삭제해 (이미지 파일은 유지)',()=>rgDeleteV2(v2File)));
      if(!statusMsg)statusMsg='v3 백업이 아직 없어. 구형 백업(v2)만 있어.';
    }
    setStatus(statusMsg,v3Error?'err':'');
    return true;
  }
  // 빈 대표 이미지 복구용: 슬롯들을 흘려 읽어 필요한 카드 ID만 모은다(최신 v3 → 구형 v2 순).
  async function rgCollectSlotItemsForIds(ids){
    const want=new Set(ids),slots=[];
    let v3=null;try{v3=await rgV3Load();}catch(_){v3=null;}
    if(v3?.index){
      const order=RG_V3_SLOTS.filter(L=>v3.slotStates[L]==='ok').sort((a,b)=>Number(v3.index.slots[b].generation)-Number(v3.index.slots[a].generation));
      for(const L of order){
        const e=v3.index.slots[L],items=[],total=Number(e.bytes)||0;
        await rgStreamMainSlots(e.fileId,{v3:true,onItem:async it=>{if(it&&want.has(it.id))items.push(it);},
          onProgress:read=>setStatus('빈 대표 이미지 찾는 중 · 슬롯 '+L+' '+rgMb(read)+(total?' / '+rgMb(total):''),'loading')});
        slots.push({label:L+'(세대 '+e.generation+')',items});
      }
    }
    const v2=await findDriveFileByName(rgMainFileName());
    if(v2){
      const bySlot=[],total=Number(v2.size)||0;
      const r=await rgStreamMainSlots(v2.id,{onItem:async(it,si)=>{if(it&&want.has(it.id))(bySlot[si]||(bySlot[si]=[])).push(it);},
        onProgress:read=>setStatus('빈 대표 이미지 찾는 중 · 구형 v2 '+rgMb(read)+(total?' / '+rgMb(total):''),'loading')});
      for(let i=0;i<r.slots.length;i++)slots.push({label:'v2-'+(i+1),items:bySlot[i]||[]});
    }
    if(!slots.length)throw new Error('Drive 백업을 찾지 못했어.');
    return {slots};
  }

  // Result Gallery 전용 진단: 기존 메인 읽기에 성공하면 기존과 동일. 실패했을 때만 파일 크기·받은 바이트·앞뒤 일부를 기록하고 원래 오류를 그대로 던진다.
  // 재조회는 바이트 수만 세고 앞뒤 80바이트만 보관하므로 파일 전체를 메모리에 올리지 않는다.
  async function rgReadMainWithDiag(fileId){
    try{return await readDriveFile(fileId);}
    catch(err){
      const info={at:new Date().toISOString(),fileId,error:String((err&&err.message)||err)};
      try{
        const params=new URLSearchParams({fields:'id,size,md5Checksum,modifiedTime,version'});
        const m=await (await driveFetch(DRIVE_API+'/'+encodeURIComponent(fileId)+'?'+params.toString())).json();
        info.driveSize=m.size??null;info.modifiedTime=m.modifiedTime||'';info.version=m.version||'';
      }catch(e){info.metaError=String((e&&e.message)||e);}
      try{
        const res=await driveFetch(`${DRIVE_API}/${fileId}?alt=media`);
        let n=0,head=null,tail=new Uint8Array(0);
        if(res.body&&typeof res.body.getReader==='function'){
          const reader=res.body.getReader();
          for(;;){
            const {done,value}=await reader.read();
            if(done)break;
            if(!head)head=value.slice(0,80);
            n+=value.length;
            if(value.length>=80)tail=value.slice(-80);
            else{const c=new Uint8Array(tail.length+value.length);c.set(tail);c.set(value,tail.length);tail=c.slice(-80);}
          }
        }else{
          const all=new Uint8Array(await res.arrayBuffer());n=all.length;head=all.slice(0,80);tail=all.slice(-80);
        }
        const dec=new TextDecoder('utf-8',{fatal:false});
        info.receivedBytes=n;info.head=head?dec.decode(head):'';info.tail=dec.decode(tail);
      }catch(e){info.rereadError=String((e&&e.message)||e);}
      try{if(typeof localStorage!=='undefined')localStorage.setItem('rg_drive_main_read_fail_v1',JSON.stringify(info));}catch(_){}
      throw err;
    }
  }
  function rgDiagnoseImages(items){
    const issues=[];let totalImages=0,presentWithFlag=0,emptyWithoutFlag=0;
    (items||[]).forEach((card,index)=>{
      const missing=[];
      function inspect(img,position){
        totalImages++;
        if(img.thumb){if(img.thumbStripped)presentWithFlag++;return;}
        if(!img.thumbStripped){emptyWithoutFlag++;return;}
        missing.push({position,id:String(img.id||''),fileName:String(img.fileName||img.title||'')});
      }
      inspect(card,'대표 이미지');
      (card.subs||[]).forEach((sub,i)=>inspect(sub,'추가 이미지 '+(i+1)));
      if(missing.length)issues.push({index:index+1,id:String(card.id||''),title:String(card.title||card.fileName||'제목 없음'),missing});
    });
    const missingCount=issues.reduce((n,x)=>n+x.missing.length,0);
    const lines=['Result Gallery 저장 문제 진단',
      '검사 카드 '+(items||[]).length+'개 · 이미지 자리 '+totalImages+'개',
      '저장 차단: '+issues.length+'카드 / '+missingCount+'이미지',
      '이미지는 있고 제외 표시만 남은 항목: '+presentWithFlag+'개 (저장 차단 안 함)',
      '이미지와 제외 표시가 모두 없는 항목: '+emptyWithoutFlag+'개 (현재 보호 조건으로 차단 안 함)',
      '', '이 검사는 현재 메모리의 이미지 유무와 thumbStripped 표시만 확인합니다.',
      'Drive에 이미지가 남아 있는지, 왜 비었는지, 이미지 파일 내용이 정상인지는 아직 확인하지 않았습니다.',
      '진단 자체는 로컬 데이터와 Drive를 변경하지 않으며 해시를 계산하지 않습니다.', ''];
    try{
      const stage=typeof localStorage!=='undefined'?JSON.parse(localStorage.getItem('rg_drive_last_stage_v1')||'null'):null;
      if(stage?.phase)lines.push('마지막 저장 단계 기록: '+stage.phase+' ('+(stage.done??'?')+'/'+(stage.total??'?')+') · '+stage.at,'이 기록은 중단 위치를 찾기 위한 정보이며 저장 성공을 보장하지 않습니다.','');
    }catch(_){}
    try{lines.push(...rgDriveHistoryLines());}catch(_){}
    try{if(typeof window!=='undefined'&&typeof window.rgGistHistoryLinesForDiag==='function')lines.push(...window.rgGistHistoryLinesForDiag());}catch(_){}
    for(const issue of issues){
      lines.push('카드: '+issue.title,'카드 ID: '+issue.id+' / 전체 데이터 순번: '+issue.index);
      for(const img of issue.missing)lines.push('  - '+img.position+' | 이미지 ID: '+img.id+' | 파일명: '+(img.fileName||'(없음)'));
      lines.push('');
    }
    lines.push(issues.length?'위 목록을 확인하기 전에는 전체 복원이나 카드 삭제를 하지 마세요. 진단 내용을 전달하면 필요한 항목만 복구할 방법을 판단할 수 있습니다.':'현재 보호 조건에 해당하는 항목은 없습니다. Drive 저장 중 발생할 수 있는 다른 오류까지 검사한 결과는 아닙니다.');
    return {issues,missingCount,text:lines.join('\n')};
  }

  async function rgReadRecentElectronDiagnostics(){
    const heading='최근 Electron / Gist 기록 (최대 100건 · 시간은 UTC)';
    let timer;
    try{
      if(typeof location==='undefined'||location.origin!=='http://127.0.0.1:37642')throw new Error('unavailable');
      const controller=new AbortController();
      timer=setTimeout(()=>controller.abort(),2500);
      const res=await fetch('/__memo_diagnostics',{headers:{'X-Memo-Diagnostics':'1'},cache:'no-store',signal:controller.signal});
      if(!res.ok)throw new Error('unavailable');
      const data=await res.json();
      if(data.version!==1||!Array.isArray(data.records)||data.unavailable)throw new Error('unavailable');
      const lines=[heading];
      if(data.partial)lines.push('일부 로그를 읽지 못했습니다. 읽을 수 있는 기록만 표시합니다.');
      if(!data.records.length)lines.push('표시할 기록이 없습니다. 기록 없음이 오류 없음을 보장하지는 않습니다.');
      else{
        lines.push('renderer.gone: 화면 프로세스 종료 · oom: 메모리 부족 · crashed: 충돌',
          'renderer.unresponsive: 응답 없음 · child.gone / GPU: GPU 프로세스 종료',
          'gist: 요청 단계·성공·실패 기록 (기존에 기록된 내용만 표시)');
        for(const record of data.records.slice(-100))lines.push(JSON.stringify(record));
      }
      return lines.join('\n');
    }catch(_){
      return heading+'\n로그를 읽지 못했습니다. Electron 앱을 완전히 종료한 뒤 다시 실행해 주세요.\n계속 안 되면 %APPDATA%\\memo-hub\\diagnostics 폴더의 로그를 확인해 주세요.\n위 이미지 진단 결과는 그대로 유효합니다.';
    }finally{clearTimeout(timer);}
  }

  function rgShowImageDiagnosis(report,includeLogs=false){
    if(typeof document==='undefined')return;
    const host=document.getElementById('drive-sync-status');if(!host)return;
    let panel=document.getElementById('rg-drive-diagnosis');
    if(!panel){
      panel=document.createElement('div');panel.id='rg-drive-diagnosis';
      host.insertAdjacentElement('afterend',panel);
    }
    panel.replaceChildren();
    const note=document.createElement('p');note.textContent='저장 문제 진단 — 아래 내용을 선택해 복사하거나 TXT로 저장할 수 있어.';
    const area=document.createElement('textarea');area.readOnly=true;area.value=report.text;
    area.setAttribute('aria-label','저장 문제 진단 결과');
    area.style.cssText='width:100%;height:240px;box-sizing:border-box;font-size:12px;white-space:pre;';
    const select=document.createElement('button');select.type='button';select.textContent='전체 선택';
    select.onclick=()=>{area.focus();area.select();};
    const download=document.createElement('button');download.type='button';download.textContent='진단 TXT 저장';
    download.onclick=()=>{
      const url=URL.createObjectURL(new Blob(['\uFEFF'+report.text],{type:'text/plain;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download='result_gallery_drive_diagnosis.txt';
      panel.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    const actions=document.createElement('div');actions.className='drive-sync-actions';
    select.className=download.className='drive-sub';actions.append(select,download);
    panel.append(note,area,actions);
    if(includeLogs){
      const baseText=report.text;
      area.value=baseText+'\n\n최근 Electron / Gist 기록을 읽는 중…';
      select.disabled=download.disabled=true;
      rgReadRecentElectronDiagnostics().then(logText=>{
        // An upload or another diagnosis may have replaced this panel while reading.
        if(!panel.contains(area))return;
        report.text=baseText+'\n\n'+logText;
        area.value=report.text;
        select.disabled=download.disabled=false;
      });
    }
  }
  function rgCheckImagesBeforeSave(items){
    const report=rgDiagnoseImages(items);
    if(report.issues.length)throw new Error('이미지 내용이 비어 있고 제외 표시가 남은 '+report.issues.length+'카드 / '+report.missingCount+'이미지가 있어. 저장 문제 진단 버튼을 눌러 카드 이름과 이미지 위치를 확인해줘.');
    return report;
  }

  let rgDriveRecovering=false;
  function rgRecoveryCommitShield(){
    if(typeof document==='undefined')return ()=>{};
    const shield=document.createElement('div');
    shield.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.65);color:white;display:grid;place-items:center;font:16px sans-serif;';
    shield.textContent='복구한 이미지를 로컬에 저장 중… 잠시 기다려줘.';
    const block=e=>{e.preventDefault();e.stopImmediatePropagation();};
    document.body.appendChild(shield);document.addEventListener('keydown',block,true);
    return ()=>{shield.remove();document.removeEventListener('keydown',block,true);};
  }
  function rgSameOriginal(a,b){
    if(a.fileHash&&b.fileHash)return a.fileHash===b.fileHash;
    return !!a.fileName&&a.fileName===b.fileName&&Number.isFinite(a.size)&&a.size>0&&a.size===b.size;
  }
  // Legacy length signatures cannot prove image identity. Require a visible, explicit choice.
  function rgChooseLegacyHeads(candidates){
    if(typeof document==='undefined')return Promise.resolve([]);
    return new Promise(resolve=>{
      const overlay=document.createElement('div');
      overlay.id='rg-legacy-head-preview';
      overlay.style.cssText='position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.7);display:grid;place-items:center;padding:16px;';
      const box=document.createElement('div');
      box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','구형 백업 대표 이미지 선택');
      box.style.cssText='background:#fff;color:#222;border-radius:12px;padding:20px;width:min(720px,100%);max-height:85vh;overflow:auto;box-sizing:border-box;';
      const heading=document.createElement('h3');heading.textContent='구형 백업에서 찾은 대표 이미지';
      const note=document.createElement('p');
      note.textContent='카드 ID와 원본 정보는 일치하지만, 구형 백업에는 이미지 내용 검증용 해시가 없어 원래 대표 이미지인지 자동으로 확정할 수 없어. 아래에서 선택한 후보만 현재 빈 대표 자리에 채울게. 다른 이미지·메모와 Drive 백업은 그대로 유지돼.';
      box.append(heading,note);
      const choices=[];
      const apply=document.createElement('button');apply.type='button';apply.textContent='선택한 후보로 빈 대표 복구';apply.disabled=true;
      const update=()=>{apply.disabled=!choices.some(x=>x.check.checked&&!x.check.disabled);};
      for(const candidate of candidates){
        const row=document.createElement('div');row.style.cssText='border:1px solid #ccc;border-radius:8px;padding:12px;margin:12px 0;';
        const name=document.createElement('p');name.textContent=(candidate.target.title||candidate.identity.fileName||candidate.identity.id)+' · 슬롯 '+candidate.slot;
        const id=document.createElement('small');id.textContent='카드 ID: '+candidate.identity.id;
        const img=document.createElement('img');img.alt='백업의 대표 이미지 후보';img.style.cssText='display:block;max-width:100%;height:240px;object-fit:contain;margin:10px auto;';
        const status=document.createElement('p');status.textContent='미리보기 불러오는 중…';
        const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.disabled=true;check.checked=false;
        const text=document.createElement('span');text.textContent=' 이 후보를 빈 대표 이미지로 사용';label.append(check,text);
        choices.push({candidate,check});check.onchange=update;
        img.onload=()=>{if(img.naturalWidth>0){check.disabled=false;status.textContent='원본 일치는 자동 검증되지 않았어. 사용하려면 직접 선택해줘.';}else img.onerror();update();};
        img.onerror=()=>{check.disabled=true;check.checked=false;status.textContent='이미지를 표시할 수 없어 이 후보는 복구할 수 없어.';update();};
        img.src=candidate.thumb;
        row.append(name,id,img,status,label);box.appendChild(row);
      }
      const cancel=document.createElement('button');cancel.type='button';cancel.textContent='취소 — 구형 후보 적용 안 함';
      const actions=document.createElement('div');actions.style.cssText='display:flex;gap:12px;flex-wrap:wrap;margin-top:16px;';actions.append(apply,cancel);box.appendChild(actions);
      const oldFocus=document.activeElement;
      const finish=selected=>{document.removeEventListener('keydown',onKey,true);overlay.remove();if(oldFocus?.isConnected)oldFocus.focus();resolve(selected);};
      const onKey=e=>{
        e.stopImmediatePropagation();
        if(e.key==='Escape'){e.preventDefault();finish([]);}
        else if(e.key==='Tab'){
          const enabled=[...box.querySelectorAll('button,input')].filter(x=>!x.disabled);
          const at=enabled.indexOf(document.activeElement);
          if(at<0||(!e.shiftKey&&at===enabled.length-1)||(e.shiftKey&&at===0)){
            e.preventDefault();enabled[e.shiftKey?enabled.length-1:0]?.focus();
          }
        }
      };
      apply.onclick=()=>{const selected=choices.filter(x=>x.check.checked&&!x.check.disabled).map(x=>x.candidate);if(selected.length)finish(selected);};
      cancel.onclick=()=>finish([]);
      overlay.appendChild(box);document.body.appendChild(overlay);document.addEventListener('keydown',onKey,true);cancel.focus();
    });
  }

  async function rgRecoverMissingHeads(){
    if(rgDriveRecovering||rgDriveUploading){setStatus('진행 중인 저장/복구가 끝난 뒤 다시 눌러줘.','loading');return;}
    if(typeof idbReplaceItems!=='function'||typeof saveResultGalleryToIndexedDBNow!=='function'){
      setStatus('현재 HTML에서 안전한 로컬 저장 기능을 찾지 못했어. 데이터를 변경하지 않았어.','err');return;
    }
    const targets=(state.items||[]).filter(it=>!it.thumb&&it.thumbStripped);
    if(!targets.length){setStatus('복구할 빈 대표 이미지가 없어.','ok');return;}
    rgDriveRecovering=true;
    let committed=false,releaseShield=()=>{};
    const log=[];
    try{
      setStatus('기존 Drive 백업에서 빈 대표 이미지 '+targets.length+'장 확인 중…','loading');
      const main=await rgCollectSlotItemsForIds(targets.map(t=>t.id));
      const found=new Map(),legacyCandidates=new Map();
      for(const target of targets){
        const reasons=[];
        const identity={id:target.id,fileHash:target.fileHash,fileName:target.fileName,size:target.size,rgThumbHash:target.rgThumbHash};
        if(!target.id||(state.items||[]).filter(it=>it.id===target.id).length!==1){log.push((target.title||target.id)+': 카드 ID 중복/누락으로 건너뜀');continue;}
        for(let i=0;i<main.slots.length;i++){
          const matches=main.slots[i].items.filter(it=>it.id===target.id);
          if(matches.length!==1){reasons.push('슬롯 '+main.slots[i].label+': 일치하는 카드 없음 또는 ID 중복');continue;}
          const src=matches[0];
          if(!rgSameOriginal(identity,src)){reasons.push('슬롯 '+main.slots[i].label+': 대표 원본 정보 불일치');continue;}
          if(!src.imageFileId){reasons.push('슬롯 '+main.slots[i].label+': 이미지 파일 참조 없음');continue;}
          setStatus('대표 이미지 확인 '+(found.size+1)+' / '+targets.length+' · 슬롯 '+main.slots[i].label+'\n'+(target.title||target.fileName||target.id),'loading');
          try{
            const data=await readDriveFile(src.imageFileId);
            if(data?.kind!=='result-gallery-item-images'||data.itemId!==target.id)throw new Error('이미지 파일의 카드 ID/형식 불일치');
            if(typeof data.thumb!=='string'||!data.thumb.startsWith('data:image/'))throw new Error('파일에 대표 이미지 내용이 없음');
            if(String(src.imageSig||'').startsWith('sha256:')){
              if(await rgStrongImageSig(data)!==src.imageSig)throw new Error('백업 이미지 내용 검증 실패');
            }else if(/^[a-f0-9]{64}$/.test(identity.rgThumbHash||'')){
              if(await rgSha256(data.thumb)!==identity.rgThumbHash)throw new Error('기존 대표 이미지 해시와 불일치');
            }else {
              if(!/^data:image\/(?:png|jpeg|jpg|webp|gif|bmp|avif);base64,/i.test(data.thumb))throw new Error('미리보기를 지원하지 않는 이미지 형식');
              if(!legacyCandidates.has(target))legacyCandidates.set(target,{target,thumb:data.thumb,identity,slot:main.slots[i].label});
              reasons.push('슬롯 '+main.slots[i].label+': 구형 백업이라 이미지 내용 검증 정보가 부족함 — 미리보기 후보');
              continue;
            }
            // A known original thumbnail hash is an additional identity check.
            if(/^[a-f0-9]{64}$/.test(identity.rgThumbHash||'')&&await rgSha256(data.thumb)!==identity.rgThumbHash)throw new Error('현재 카드의 대표 이미지 해시와 불일치');
            found.set(target,{thumb:data.thumb,identity});
            log.push((target.title||target.fileName||target.id)+': 슬롯 '+main.slots[i].label+'에서 대표 이미지 검증 완료');
            break;
          }catch(e){reasons.push('슬롯 '+main.slots[i].label+': '+(e.message||e));}
        }
        if(!found.has(target))log.push((target.title||target.fileName||target.id)+(legacyCandidates.has(target)?': 구형 후보 발견 — ':': 복구 못 함 — ')+reasons.join(' / '));
      }
      const preview=[...legacyCandidates.values()].filter(candidate=>!found.has(candidate.target));
      if(preview.length){
        setStatus('구형 백업 후보 '+preview.length+'장. 미리보기에서 사용할 이미지를 선택해줘.','loading');
        const selected=await rgChooseLegacyHeads(preview);
        for(const candidate of preview){
          if(selected.includes(candidate)){
            found.set(candidate.target,{thumb:candidate.thumb,identity:candidate.identity});
            log.push((candidate.target.title||candidate.identity.id)+': 슬롯 '+candidate.slot+' 후보를 사용자 선택으로 복구 요청 (원본 일치 자동 검증 안 됨)');
          }else log.push((candidate.target.title||candidate.identity.id)+': 구형 후보를 선택하지 않아 적용 안 함');
        }
      }
      if(found.size){
        releaseShield=rgRecoveryCommitShield();
        setStatus('복구 대상 대표 이미지 '+found.size+'장 로컬 저장 중…','loading');
        // Flush older queued writes before committing replacement copies.
        if(typeof savePromise!=='undefined')await savePromise;
        await saveResultGalleryToIndexedDBNow();
        let filled=0;
        const next=state.items.map(it=>{
          const hit=found.get(it);
          if(!hit)return it;
          if(it.thumb||!it.thumbStripped||it.id!==hit.identity.id||!rgSameOriginal(it,hit.identity)){
            log.push((it.title||it.id)+': 조회 중 카드가 변경되어 적용 안 함');return it;
          }
          filled++;
          return {...it,thumb:hit.thumb,thumbStripped:false};
        });
        if(filled){
          await idbReplaceItems(next);
          state.items=next;committed=true;
          try{if(typeof render==='function')render();}catch(e){log.push('이미지는 저장됐지만 화면 갱신 실패: '+(e.message||e));}
          log.unshift('대표 이미지 '+filled+'장 복구 및 로컬 저장 완료.');
        }
      }
      const report=rgDiagnoseImages(state.items||[]);
      report.text='부분 복구 결과\n'+log.join('\n')+'\n\n'+report.text;
      setStatus(log.join('\n')+'\n남은 저장 차단: '+report.issues.length+'카드 / '+report.missingCount+'이미지\n'+(report.issues.length?'복구하지 못한 항목은 아래 결과를 전달해줘.':'이제 Drive에 저장을 눌러줘.')+'\nDrive 백업은 변경하지 않았어.',report.issues.length?'err':'ok');
    }catch(e){
      setStatus((committed?'복구 저장 이후 오류: ':'부분 복구를 완료하지 못했어: ')+(e.message||e)+'\nDrive 백업과 기존 이미지 파일은 변경하지 않았어.','err');
    }finally{releaseShield();rgDriveRecovering=false;}
  }

  function rgJsonEqual(a,b){
    if(a===b)return true;
    if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
    if(Array.isArray(a)!==Array.isArray(b))return false;
    if(Array.isArray(a)&&a.length!==b.length)return false;
    const ak=Object.keys(a).filter(k=>a[k]!==undefined),bk=Object.keys(b).filter(k=>b[k]!==undefined);
    if(ak.length!==bk.length)return false;
    return ak.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&rgJsonEqual(a[k],b[k]));
  }
  // Result Gallery 전용: 저장한 메인 파일을 객체로 파싱하지 않고, 올린 Blob과 바이트 단위로 스트리밍 비교한다.
  // 전체 메인을 한 번 더 객체로 만들지 않아 검증 단계의 메모리 사용을 줄인다.
  async function rgVerifyMainBlob(fileId,blob){
    const res=await driveFetch(`${DRIVE_API}/${fileId}?alt=media`);
    const total=blob.size;
    if(!res.body||typeof res.body.getReader!=='function'){
      const got=new Uint8Array(await res.arrayBuffer());
      if(got.length!==total)return false;
      const want=new Uint8Array(await blob.arrayBuffer());
      for(let i=0;i<total;i++)if(got[i]!==want[i])return false;
      return true;
    }
    const reader=res.body.getReader();
    const WINDOW=4*1024*1024;
    let offset=0,want=null,wantStart=0;
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        let i=0;
        while(i<value.length){
          if(offset>=total)return false;
          if(!want||offset>=wantStart+want.length){
            wantStart=offset;
            want=new Uint8Array(await blob.slice(offset,Math.min(total,offset+WINDOW)).arrayBuffer());
          }
          const n=Math.min(value.length-i,wantStart+want.length-offset);
          const w=offset-wantStart;
          for(let k=0;k<n;k++)if(value[i+k]!==want[w+k])return false;
          i+=n;offset+=n;
        }
      }
      return offset===total;
    }finally{
      try{reader.cancel().catch(()=>{});}catch(_){}
    }
  }
  async function rgMainBlob(payload){
    // Serialize at most one card at a time. Blob parts hold encoded bytes, not a whole JSON string.
    const parts=[],header={...payload};delete header.slots;
    const headerJson=JSON.stringify(header);
    parts.push(new Blob([headerJson.slice(0,-1)+(headerJson==='{}'?'':',')+'"slots":[']));
    for(let si=0;si<payload.slots.length;si++){
      const slot=payload.slots[si],meta={...slot};delete meta.items;
      const json=JSON.stringify(meta);
      parts.push(new Blob([(si?',':'')+json.slice(0,-1)+(json==='{}'?'':',')+'"items":[']));
      for(let i=0;i<slot.items.length;i++){
        parts.push(new Blob([(i?',':'')+JSON.stringify(slot.items[i])]));
        if(i%128===0){
          rgRecordSaveStage('메인 본문 구성 · 슬롯 '+(si+1),i,slot.items.length);
          setStatus('메인 백업 구성 · 슬롯 '+(si+1)+' ('+i+'/'+slot.items.length+')','loading');
          await new Promise(resolve=>setTimeout(resolve,0));
        }
      }
      parts.push(new Blob([']}']));
    }
    parts.push(new Blob([']}']));
    return new Blob(parts,{type:'application/json'});
  }
  async function rgWriteMainBlob(fileId,blob,name){
    const metadata=fileId?{}:{name,parents:['appDataFolder'],mimeType:'application/json'};
    const boundary='rg_main_'+Math.random().toString(36).slice(2);
    const body=new Blob(['--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',blob,'\r\n--'+boundary+'--']);
    const url=DRIVE_UPLOAD+(fileId?'/'+encodeURIComponent(fileId):'')+'?uploadType=multipart&fields=id,name,modifiedTime,version,md5Checksum,size';
    return await (await driveFetch(url,{method:fileId?'PATCH':'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body})).json();
  }

  let rgDriveUploading=false;
  async function uploadDriveSlotRG(){
    if(rgDriveUploading||rgDriveRecovering){setStatus('현재 Drive 저장이 완료될 때까지 기다려줘.','loading');return;}
    rgDriveUploading=true;
    try{window.rgDriveSaveBusy=true;}catch(_){}
    let mainWriteStarted=false,slotWriteStarted=false;
    const trackingWindow=typeof window!=='undefined'?window:null;
    let previousProgress,trackingProgress,previousStorageProgress,storageProgress;
    try{
      rgCheckImagesBeforeSave(Array.isArray(state?.items)?state.items:[]);
      setStatus('Drive 저장 준비 중...','loading');
      rgRecordSaveStage('로컬 캐시 준비',0,state.items?.length||0);
      if(trackingWindow){
        previousStorageProgress=trackingWindow.onResultGalleryStorageProgress;
        storageProgress=p=>{
          setStatus('로컬 카드 저장 중 ('+p.done+'/'+p.total+')\n이미지 데이터를 한 카드씩 저장하는 중…','loading');
          if(p.done%256===0||p.done===p.total)rgRecordSaveStage('로컬 카드 저장',p.done,p.total);
        };
        trackingWindow.onResultGalleryStorageProgress=storageProgress;
      }
      if(typeof trackingWindow?.getResultGalleryImageTracking==='function'){
        previousProgress=trackingWindow.onResultGalleryTrackingProgress;
        trackingProgress=p=>setStatus(`로컬 이미지 변경 정보 준비 (${p.done}/${p.total})\n새 이미지 해시 계산 ${p.hashedImages}장`,'loading');
        trackingWindow.onResultGalleryTrackingProgress=trackingProgress;
      }
      if(typeof saveResultGalleryToIndexedDBNow==='function')await saveResultGalleryToIndexedDBNow();
      else if(typeof save==='function')save();
      setStatus('Drive 비교용 카드 정보 준비 중…','loading');
      rgRecordSaveStage('Drive 비교용 카드 정보 준비',0,state.items?.length||0);
      // 메타는 사본, 큰 이미지 문자열은 참조만 유지하여 저장 중 편집과 분리한다.
      const items=(Array.isArray(state?.items)?state.items:[]).map(it=>({
        meta:jsonClone(rgStripItem(it)),thumb:it.thumb||'',
        tracking:typeof trackingWindow?.getResultGalleryImageTracking==='function'?trackingWindow.getResultGalleryImageTracking(it):null,
        subs:(it.subs||[]).map(s=>({id:s.id,thumb:s.thumb||''}))
      }));
      // Recheck the snapshot after asynchronous local persistence.
      rgCheckImagesBeforeSave(items.map(item=>({...item.meta,thumb:item.thumb,subs:(item.meta.subs||[]).map((sub,i)=>({...sub,thumb:item.subs[i]?.thumb||''}))})));
      const cardIds=new Set();
      for(const item of items){
        if(!item.meta.id||cardIds.has(item.meta.id))throw new Error('카드 ID가 없거나 중복돼 있어. 저장을 중단했어.');
        cardIds.add(item.meta.id);
        const subIds=new Set();
        for(const sub of item.subs){
          if(sub.thumb&&(!sub.id||subIds.has(sub.id)))throw new Error('보조 이미지 ID가 없거나 중복돼 있어. 저장을 중단했어.');
          if(sub.id)subIds.add(sub.id);
        }
      }
      // v3: 저장 경로에서는 작은 색인만 읽는다. 큰 슬롯 파일은 파싱하지 않는다.
      rgRecordSaveStage('Drive 색인 확인',0,items.length);
      setStatus('Drive 백업 색인 확인 중…','loading');
      const v3=await rgV3Load();
      const prevRef=new Map();let prevInfo=null,v2File=null;
      if(v3.index){
        for(const r of (Array.isArray(v3.index.ref)?v3.index.ref:[]))prevRef.set(r[0],{id:r[0],imageFileId:r[1],imageSig:r[2],rgImageRevision:r[3],rgTrackingVersion:r[4]});
        const latest=rgV3LatestValid(v3);
        if(latest)prevInfo={count:Number(latest.entry.itemCount)||0,savedAt:latest.entry.savedAt,label:'슬롯 '+latest.letter};
      }else{
        // 첫 v3 저장: 구형 v2 백업을 흘려 읽어 최신 슬롯의 비교 정보만 뽑는다(이미지 재업로드 방지). v2 파일은 건드리지 않는다.
        v2File=await findDriveFileByName(rgMainFileName());
        if(v2File){
          rgRecordSaveStage('구형 v2 백업에서 비교 정보 읽기',0,items.length);
          const total=Number(v2File.size)||0,mb=n=>(n/1048576).toFixed(0)+'MB';
          const r2=await rgStreamMainSlots(v2File.id,{
            itemFilter:si=>si===0,
            onItem:async it=>{if(it&&it.id)prevRef.set(it.id,{id:it.id,imageFileId:it.imageFileId,imageSig:it.imageSig,rgImageRevision:it.rgImageRevision,rgTrackingVersion:it.rgTrackingVersion});},
            onProgress:read=>setStatus('첫 v3 저장: 구형 백업에서 비교 정보 읽는 중… '+mb(read)+(total?' / '+mb(total):''),'loading')
          });
          if(r2.slots[0])prevInfo={count:r2.slots[0].count,savedAt:r2.slots[0].meta.savedAt,label:'구형 v2 최신 슬롯'};
        }
      }
      // 카드 수 급감 확인: 직전 정상 백업보다 10% 이상 적으면 묻는다.
      if(prevInfo&&prevInfo.count>0&&items.length<prevInfo.count*0.9){
        const pct=Math.round((1-items.length/prevInfo.count)*100);
        const ok=typeof confirm==='function'&&confirm('지금 저장할 카드는 '+items.length+'장이야.\n직전 백업('+prevInfo.label+' · '+rgFormatSavedAt(prevInfo.savedAt)+')은 '+prevInfo.count+'장이라 '+pct+'% 적어.\n그래도 저장할까?');
        if(!ok){const ce=new Error('카드 수가 크게 줄어 저장을 취소했어. 기존 백업은 그대로야.');ce.rgUserCancel=true;throw ce;}
      }
      const target=rgV3PickTarget(v3);
      setStatus('기존 Drive 이미지 파일 확인 중...','loading');
      rgRecordSaveStage('Drive 파일 목록 확인',0,items.length);
      const existing=await rgExistingImageIds();
      const checkpoint=rgCheckpointStore(v2File?v2File.id:'v3:'+rgV3IndexName());
      const mainItems=new Array(items.length);let uploaded=0,skipped=0,migrated=0,idx=0,cached=0,rehashedCards=0,resumed=0,checkpointed=0;
      let cursor=0,firstError=null,lastProgress=0;
      function progress(force=false){
        const now=Date.now();if(!force&&now-lastProgress<150)return;lastProgress=now;
        rgRecordSaveStage('Drive 카드 변경 확인',idx,items.length);
        setStatus('카드 변경 확인 ('+idx+'/'+items.length+')\n새 파일 '+uploaded+' · 재사용 '+skipped+' · 저장된 해시 재사용 '+cached+'카드\n중단 전 작업 재사용 '+resumed+'카드 · 구형 백업 내용 비교 '+migrated+'카드\n재개 정보 기록 '+checkpointed+'카드 · 최대 3카드씩 처리 중','loading');
      }
      async function processItem(item,index){
        const meta=item.meta,prev=prevRef.get(meta.id);
        const tracked=item.tracking;
        const sig=tracked?tracked.signature:await rgStrongImageSig(item);
        if(tracked)cached++;else{
          rehashedCards++;delete meta.rgImageRevision;delete meta.rgImageSignature;delete meta.rgImageManifest;delete meta.rgTrackingVersion;
        }
        meta.imagesStripped=true;meta.imageSig=sig;
        meta.imageHadVisual=!!item.thumb||item.subs.some(s=>s.thumb);
        delete meta.imageUploadError;
        if(!meta.imageHadVisual){meta.imageFileId='';mainItems[index]=meta;idx++;progress();return;}
        const sameRevision=tracked&&prev?.rgTrackingVersion===tracked.version&&prev.rgImageRevision===tracked.revision&&prev.imageSig===sig;
        let reusable=prev&&prev.imageFileId&&existing.has(prev.imageFileId)&&(sameRevision||prev.imageSig===sig);
        let reuseId=reusable?prev.imageFileId:'';
        if(!reusable){
          const done=checkpoint.get(meta.id);
          if(done&&done.sig===sig&&done.stamp&&existing.has(done.id)&&existing.stamps.get(done.id)===done.stamp){
            reusable=true;reuseId=done.id;resumed++;
          }
        }
        if(!reusable&&prev?.imageFileId&&existing.has(prev.imageFileId)&&!String(prev.imageSig||'').startsWith('sha256:')&&prev.imageSig===rgItemImageSig(item)){
          const beforeStamp=existing.stamps.get(prev.imageFileId)||'';
          if(checkpoint.persistent&&!beforeStamp)throw new Error('Drive 파일의 변경 검증 정보를 받지 못해 재개 정보를 안전하게 남길 수 없어. 연결 후 다시 시도해줘.');
          const legacy=await readDriveFile(prev.imageFileId);
          if(legacy.kind!=='result-gallery-item-images'||legacy.itemId!==meta.id)throw new Error('기존 이미지 파일의 카드 정보가 일치하지 않아. 저장을 중단했어.');
          // Exact string equality, not length equality: no second image-hash pass is needed.
          reusable=rgSameImageContents(item,legacy);migrated++;
          if(reusable){
            reuseId=prev.imageFileId;
            // Both version observations must agree: don't cache content read across a remote edit.
            if(beforeStamp){
              const afterStamp=await rgReadFileStamp(reuseId);
              if(afterStamp!==beforeStamp)throw new Error('비교 중 Drive 이미지 파일이 변경됐어. 기존 백업을 유지하고 중단했어.');
              checkpoint.put(meta.id,{id:reuseId,sig,stamp:afterStamp});
              checkpointed++;
            }
          }
        }
        if(reusable){meta.imageFileId=reuseId;skipped++;}
        else{
          const imgPayload={version:1,kind:'result-gallery-item-images',itemId:meta.id,thumb:item.thumb,subs:item.subs.filter(s=>s.thumb)};
          const name=rgImgFileName(meta.id).replace(/\.json$/,'')+'_'+sig.slice(7)+'.json';
          const written=await writeDriveFile(null,imgPayload,name);
          if(!written?.id)throw new Error('새 이미지 파일 ID를 확인하지 못했어.');
          meta.imageFileId=written.id;uploaded++;
          // Persist a completed upload too, so a later main-file failure doesn't repeat it.
          // Metadata from the upload response describes the exact write, without a racing read.
          const stamp=rgDriveFileStamp(written);
          if(checkpoint.persistent&&!stamp)throw new Error('업로드는 완료됐지만 파일 변경 검증 정보를 받지 못했어. 기존 메인 백업은 유지돼.');
          if(stamp){checkpoint.put(meta.id,{id:written.id,sig,stamp});checkpointed++;}
        }
        mainItems[index]=meta;idx++;progress();
      }
      async function worker(){
        while(!firstError){
          const index=cursor++;if(index>=items.length)return;
          try{await processItem(items[index],index);}catch(e){if(!firstError)firstError=e;}
        }
      }
      await Promise.all(Array.from({length:Math.min(3,items.length)},()=>worker()));
      progress(true);
      if(firstError)throw firstError;
      const savedAt=nowIso();
      const generation=rgV3MaxGeneration(v3)+1;
      const slotHeader={version:3,kind:'result-gallery-drive-v3-slot',appFile:rgV3SlotName(target),letter:target,generation,savedAt,device:deviceName(),app:appLabel(),itemCount:mainItems.length};
      rgRecordSaveStage('슬롯 '+target+' 본문 구성',0,mainItems.length);
      const slotBlob=await rgV3SlotBlob(slotHeader,mainItems,target);
      // 대상 자리 파일: 색인에 있는 ID가 살아 있으면 그 파일을 덮어쓰고, 없으면 이름으로 찾고, 그래도 없으면 새로 만든다.
      let slotFileId=v3.index?.slots?.[target]?.fileId||'';
      if(slotFileId){try{await rgReadFileStamp(slotFileId);}catch(_){slotFileId='';}}
      if(!slotFileId){const f=await findDriveFileByName(rgV3SlotName(target));slotFileId=f?.id||'';}
      setStatus('슬롯 '+target+' 저장 중… ('+formatBytes(slotBlob.size)+')\n새 이미지 파일 '+uploaded+' · 기존 재사용 '+skipped,'loading');
      rgRecordSaveStage('Drive 슬롯 '+target+' 저장',idx,items.length);
      slotWriteStarted=true;
      const writtenSlot=await rgWriteMainBlob(slotFileId||null,slotBlob,rgV3SlotName(target));
      if(!writtenSlot?.id)throw new Error('슬롯 '+target+' 파일 ID를 확인하지 못했어.');
      rgRecordSaveStage('슬롯 '+target+' 저장 후 내용 검증',idx,items.length);
      if(!await rgVerifyMainBlob(writtenSlot.id,slotBlob))throw new Error('슬롯 '+target+' 저장 후 검증 내용이 일치하지 않아.');
      const slotStamp=await rgReadFileStamp(writtenSlot.id);
      if(!slotStamp)throw new Error('슬롯 '+target+' 파일의 변경 검증 정보를 받지 못했어.');
      // 커밋: 검증을 통과한 뒤에만 색인을 바꾼다.
      rgRecordSaveStage('색인 변경 확인',idx,items.length);
      await rgV3CheckUnchanged(v3);
      const newIndex={version:3,kind:'result-gallery-drive-v3-index',appFile:rgV3IndexName(),updatedAt:nowIso(),latest:target,slots:{},
        ref:mainItems.map(m=>[m.id,m.imageFileId||'',m.imageSig||'',m.rgImageRevision??null,m.rgTrackingVersion??null])};
      for(const L of RG_V3_SLOTS)newIndex.slots[L]=v3.index?.slots?.[L]||null;
      newIndex.slots[target]={fileId:writtenSlot.id,generation,savedAt,device:slotHeader.device,app:slotHeader.app,itemCount:mainItems.length,bytes:slotBlob.size,stamp:slotStamp};
      const indexBlob=new Blob([JSON.stringify(newIndex)],{type:'application/json'});
      rgRecordSaveStage('색인 저장',idx,items.length);
      mainWriteStarted=true;
      const writtenIndex=await rgWriteMainBlob(v3.indexFile?.id||null,indexBlob,rgV3IndexName());
      if(!writtenIndex?.id||!await rgVerifyMainBlob(writtenIndex.id,indexBlob))throw new Error('색인 저장 후 검증 내용이 일치하지 않아.');
      let backupNote='';
      try{
        rgRecordSaveStage('예비 색인 저장',idx,items.length);
        const wb=await rgWriteMainBlob(v3.backupFile?.id||null,indexBlob,rgV3IndexBackupName());
        if(!wb?.id||!await rgVerifyMainBlob(wb.id,indexBlob))throw new Error('검증 내용 불일치');
      }catch(be){backupNote='\n예비 색인 저장은 실패했어. 다음 저장 때 다시 써: '+((be&&be.message)||be);}
      const kept=RG_V3_SLOTS.filter(L=>newIndex.slots[L]).map(L=>L+'(세대 '+newIndex.slots[L].generation+')').join(' · ');
      setStatus('Drive 저장 완료!\n슬롯 '+target+' · 세대 '+generation+' · '+rgFormatSavedAt(savedAt)+' · 카드 '+mainItems.length+'장 · '+formatBytes(slotBlob.size)+'\n보관 중인 슬롯: '+kept+'\n새 이미지 파일 '+uploaded+' · 기존 재사용 '+skipped+'\n저장된 해시 재사용 '+cached+'카드 · 전체 해시 계산 '+rehashedCards+'카드\n중단 전 작업 재사용 '+resumed+'카드\n검증 OK'+(migrated?' · 기존 형식 내용 비교 '+migrated+'개':'')+(v2File?'\n구형 v2 백업은 그대로 보존했어.':'')+backupNote,'ok');
      safeToast('☁️ Drive 저장 완료 · 슬롯 '+target+' (세대 '+generation+')');
      rgRecordSaveStage('Drive 저장 완료',idx,items.length);
      rgDriveHistoryResolve();
    }catch(e){
      if(!(e&&e.rgUserCancel))try{
        const st=rgLsGet('rg_drive_last_stage_v1',null);
        rgDriveHistoryAdd({at:new Date().toISOString(),stage:st?.phase?(st.phase+' ('+(st.done??'?')+'/'+(st.total??'?')+')'):'?',error:String((e&&e.message)||e),mainWriteStarted,mainRead:rgTakeMainReadDiag()});
      }catch(_){}
      setStatus((mainWriteStarted?'Drive 색인 저장 결과를 확인하지 못했어. 백업 목록을 다시 확인해줘.':slotWriteStarted?'Drive 저장을 중단했어. 백업 색인은 바꾸지 않았어. 쓰던 가장 오래된 슬롯은 다음 저장 때 다시 써.':'Drive 저장을 중단했어. 기존 백업은 변경하지 않았어.')+'\n'+(e.message||e)+'\n기존 이미지 파일과 로컬 데이터는 삭제하지 않았어. 완료한 작업의 재개 정보가 있으면 재연결 후 다시 저장할 때 재사용해.','err');
    }finally{
      if(trackingProgress&&trackingWindow.onResultGalleryTrackingProgress===trackingProgress)trackingWindow.onResultGalleryTrackingProgress=previousProgress;
      if(storageProgress&&trackingWindow.onResultGalleryStorageProgress===storageProgress)trackingWindow.onResultGalleryStorageProgress=previousStorageProgress;
      rgDriveUploading=false;
      try{window.rgDriveSaveBusy=false;if(typeof window.onResultGalleryDriveSaveEnd==='function')window.onResultGalleryDriveSaveEnd();}catch(_){}
    }
  }

  async function applyDriveStateRG(slot){
    if(rgDriveRecovering)throw new Error("대표 이미지 복구가 진행 중이야. 완료 후 다시 시도해줘.");
    const items=(slot&&Array.isArray(slot.items))?slot.items:[];
    // 복원 전, 현재 로컬 항목에서 id -> {thumb, 보조 thumb 맵, sig}를 만든다.
    // 슬롯의 imageSig와 로컬 sig가 같으면 Drive에서 다시 받지 않고 로컬 이미지를 재사용한다.
    const localMap={};
    const curItems=(state&&Array.isArray(state.items))?state.items:[];
    curItems.forEach(li=>{
      if(!li||!li.id)return;
      const subT={};
      (Array.isArray(li.subs)?li.subs:[]).forEach(s=>{ if(s&&s.id&&s.thumb) subT[s.id]=s.thumb; });
      localMap[li.id]={thumb:li.thumb||'', subThumbs:subT, imageSource:li};
    });

    // 항목의 껍데기 subs에 thumb 맵(id→dataUrl)을 입힌다. 못 입힌 쪽은 thumbStripped 껍데기로 남겨
    // 앱의 기존 "원본 PNG 드롭 시 자동 매칭" 경로로 나중에 채울 수 있게 한다.
    function dressItem(item, mainThumb, subThumbMap){
      let miss=0;
      if(mainThumb){ item.thumb=mainThumb; item.thumbStripped=false; }
      else { delete item.thumb; item.thumbStripped=true; miss++; }
      item.subs=(Array.isArray(item.subs)?item.subs:[]).map(s=>{
        const sub=Object.assign({},s);
        const t=sub.id?subThumbMap[sub.id]:'';
        if(t){ sub.thumb=t; sub.thumbStripped=false; }
        else { delete sub.thumb; sub.thumbStripped=true; miss++; }
        return sub;
      });
      return miss;
    }

    let missing=0, reused=0, fetched=0, idx=0;
    let total=items.length;
    const rebuilt=[];
    // 1차: 카드를 하나씩 처리한다. 로컬 이미지 재사용이 가능하면 바로 채우고, 다운로드가 필요한 카드는 2차로 미룬다.
    // (스트리밍 복원 중 이미지 다운로드 때문에 백업 파일 연결이 오래 멈추지 않게 한다.)
    const pending=[];
    const clearImageFields=item=>{delete item.imagesStripped; delete item.imageSig; delete item.imageFileId; delete item.imageUploadError; delete item.imageHadVisual;};
    async function handle(src){
      idx++;
      const item=Object.assign({},src);
      if(item.imagesStripped){
        const hadVisual=!!item.imageHadVisual||!!item.imageFileId||/m:[1-9]|:[1-9]/.test(item.imageSig||''); // 저장 시점에 이미지가 있었는지
        const local=localMap[item.id];
        const localTracking=local&&typeof window!=='undefined'&&typeof window.getResultGalleryImageTracking==='function'?window.getResultGalleryImageTracking(local.imageSource):null;
        if(local && String(item.imageSig||'').startsWith('sha256:') && (localTracking?localTracking.signature:await rgStrongImageSig(local.imageSource))===item.imageSig){
          // 로컬에 동일 구성 이미지가 있음 → 다운로드 생략, 로컬 것 재사용
          dressItem(item, local.thumb, local.subThumbs); reused++;
          clearImageFields(item);
        }else if(item.imageFileId){
          pending.push({item,title:src&&src.title});
        }else{
          if(hadVisual)throw new Error('백업의 이미지 참조가 누락돼 있어 복원을 중단했어. 로컬 데이터는 아직 변경하지 않았어.');
          // 저장 당시에도 이미지가 없던 항목(또는 업로드 실패 표시) → 껍데기 상태 유지
          dressItem(item,'',{});
          if(item.imageUploadError&&hadVisual)missing++;
          clearImageFields(item);
        }
      }
      rebuilt.push(item);
      if(idx%64===0||idx===total)setStatus(`불러오는 중 (${idx}/${total||'?'})\n로컬 재사용 ${reused} · 다운로드 대기 ${pending.length}`,'loading');
    }
    if(typeof slot?.rgStreamItems==='function'){total=Number(slot.itemCount)||0;await slot.rgStreamItems(handle);}
    else for(const src of items)await handle(src);
    // 2차: 미뤄둔 이미지 다운로드. 하나라도 실패하면 로컬 데이터를 바꾸지 않고 중단한다.
    let di=0;
    for(const p of pending){
      di++;const item=p.item;
      setStatus(`이미지 불러오는 중 (${di}/${pending.length})\n로컬 재사용 ${reused} · 다운로드 ${fetched+1}\n${(p.title||'제목 없음').slice(0,40)}`,'loading');
      try{
        const imgData=await readDriveFile(item.imageFileId);
        if(String(item.imageSig||'').startsWith('sha256:') && (await rgStrongImageSig(imgData))!==item.imageSig)throw new Error('백업 이미지의 내용 검증에 실패했어.');
        const subT={};
        (Array.isArray(imgData.subs)?imgData.subs:[]).forEach(s=>{ if(s&&s.id&&s.thumb) subT[s.id]=s.thumb; });
        dressItem(item, imgData.thumb||'', subT); fetched++;
      }catch(e){ throw new Error('이미지 복원을 중단했어. 로컬 데이터는 아직 변경하지 않았어: '+(e.message||e)); }
      clearImageFields(item);
    }
    state.items=rebuilt;
    if(!state.view) state.view='default';
    if(!Array.isArray(state.tagFilter)) state.tagFilter=[];
    if(!Array.isArray(state.loraFilter)) state.loraFilter=[];
    if(!Array.isArray(state.expandedIds)) state.expandedIds=[];
    state.selectedId=state.items[0]?.id||null;
    if(typeof saveResultGalleryToIndexedDBNow==='function') await saveResultGalleryToIndexedDBNow();
    else if(typeof save==='function') save();
    if(typeof render==='function') render();
    if(reused||fetched) safeToast(`☁️ 복원: 로컬 재사용 ${reused} · 새로 받음 ${fetched}`);
    if(missing>0) safeToast(`⚠ 이미지 파일 ${missing}개를 못 찾아 해당 항목은 ☁ 껍데기로 복원했어. 원본 PNG를 드롭하면 자동으로 채워져.`);
  }
  // ===== /Result Gallery 전용 =====

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
      if(typeof GIST_FILE_NAME!=='undefined' && GIST_FILE_NAME==='result_gallery_data.json'){
        const rgItems=(incoming&&incoming.items)||slot.items||[];
        // v2 분리형 슬롯(imagesStripped)이면 이미지 파일을 fetch해 재조립하고,
        // 구형 슬롯(thumb 통째)이면 아래 기존 경로로 그대로 복원한다.
        if(Array.isArray(rgItems)&&rgItems.some(x=>x&&x.imagesStripped)){
          await applyDriveStateRG({items:rgItems});
          return;
        }
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
    if(isResultGalleryApp()){
      const diagnose=document.createElement('button');diagnose.type='button';diagnose.className='drive-sub';
      diagnose.id='rg-drive-diagnose-btn';diagnose.textContent='저장 문제 진단';
      diagnose.onclick=()=>{
        const report=rgDiagnoseImages(Array.isArray(state?.items)?state.items:[]);
        rgShowImageDiagnosis(report,true);
        setStatus(report.issues.length?'저장 차단 '+report.issues.length+'카드 / '+report.missingCount+'이미지. 아래 진단 내용을 확인해줘.':'현재 이미지 누락 보호 조건에 해당하는 항목은 없어.',report.issues.length?'err':'ok');
      };
      q('#drive-upload-btn').parentNode.appendChild(diagnose);
      const recover=document.createElement('button');recover.type='button';recover.className='drive-sub';
      recover.id='rg-drive-recover-heads-btn';recover.textContent='빈 대표 이미지 복구';
      recover.onclick=rgRecoverMissingHeads;diagnose.parentNode.appendChild(recover);
    }

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
    const url=fileId?`${DRIVE_UPLOAD}/${fileId}?uploadType=multipart&fields=id,name,modifiedTime,version,md5Checksum,size`:`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime,version,md5Checksum,size`;
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
    if(isResultGalleryApp()) return await uploadDriveSlotRG();
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
      }else if(isResultGalleryApp()){
        // v2 분리형 메인 파일을 먼저 찾고, 없으면 구형 단일 파일로 폴백한다.
        file=await findDriveFileByName(rgMainFileName());
        // v3 색인/슬롯 + 구형 v2를 스트리밍 방식으로 보여준다. 둘 다 없을 때만 아래 구형 단일 파일 경로로 간다.
        if(await rgListSlotsRG())return;
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
