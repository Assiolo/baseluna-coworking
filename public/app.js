// v20261103q: logo BASELUNA ufficiale in nav, auth e footer
// v20261103m: bg + colori desk + no reload pick
// v20261103l: fix bg sotto .bg opaco
// v20261103k: dashboard-bg.jpg utente
// v20261103j: dashboard sfondo foto
// v20261103i: admin Pacchetti prezzi
// v20261103h: admin mese/giorno + elimina account
// v20261103d: bonifico+contanti mailto+hover
// v20261102u-home: mie prenotazioni + scrivania + riepilogo mese in home
// v20261102s-home: «Oggi in ufficio» senza «ci sono»
const $=s=>document.querySelector(s),A=document.getElementById('app');
const LOGO_V='20261103q';
function brandLogo(){
  const v=LOGO_V;
  return `<picture class="brand-pic"><source media="(max-width:700px)" srcset="/media/logo-header-mobile.png?v=${v} 1x, /media/logo-header-mobile@2x.png?v=${v} 2x"><img class="brand-logo" alt="BASELUNA Creative Accelerator Studio" width="181" height="48" src="/media/logo-header-desktop.png?v=${v}" srcset="/media/logo-header-desktop.png?v=${v} 1x, /media/logo-header-desktop@2x.png?v=${v} 2x"></picture>`;
}
function footLogo(){
  const v=LOGO_V;
  return `<img class="foot-logo" alt="BASELUNA" width="263" height="28" src="/media/logo-footer.png?v=${v}" srcset="/media/logo-footer.png?v=${v} 1x, /media/logo-footer@2x.png?v=${v} 2x">`;
}
const api=async(u,o={})=>{const r=await fetch(u,{headers:{'Content-Type':'application/json'},...o,body:o.body&&JSON.stringify(o.body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Errore');return j};
const PAY={bonifico:'Bonifico',paypal:'PayPal',contanti:'Contanti',satispay:'Satispay'},SLOT={mattina:'Mattina 9–13',pomeriggio:'Pomeriggio 14–19',giornata:'Giornata intera'};
const today=()=>new Date().toISOString().slice(0,10);
let ME=null,PLAN=null,view='home';
const S={mode:'giornaliero',date:today(),month:today().slice(0,7),slot:'giornata',desk:null,pay:null,show:'piantina',occ:[]};
let SITE={},TODAY={date:today(),bookings:[]};async function boot(){PLAN=await api('/api/floorplan');try{TODAY=await api('/api/today')}catch{TODAY={date:today(),bookings:[]}}try{SITE=await api('/api/site');if(SITE.heroImage)document.documentElement.style.setProperty('--hero',`url('${SITE.heroImage}')`)}catch{SITE={}}try{ME=await api('/api/me')}catch{ME=null}render()}

const pad2=n=>String(n).padStart(2,'0');
function romeClock(){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  const g=t=>(p.find(x=>x.type===t)||{}).value||'00';
  return {hh:g('hour'),mm:g('minute')};
}
function liveStatus(){
  const h=new Date().getHours(); // ora locale del browser
  return (h>=9 && h<18) ? {on:true,cls:'on',label:'live'} : {on:false,cls:'off',label:'live'};
}
function liveBadgeHtml(){
  const L=liveStatus();
  return `<span class="live live-out ${L.cls}" data-live-badge><i></i>${L.label}</span>`;
}
function dateChipHtml(dateIso){
  const D=new Date((dateIso||today())+'T12:00:00');
  const wd=D.toLocaleDateString('it-IT',{weekday:'long'});
  const day=D.getDate();
  const mo=D.toLocaleDateString('it-IT',{month:'long'});
  const {hh,mm}=romeClock();
  return `<div class="hc-date-inner"><div class="hc-cal-left"><span class="hc-wday" style="color:rgba(255,255,255,.7);-webkit-text-fill-color:rgba(255,255,255,.7)">${wd}</span><b class="hc-num hc-dayn">${day}</b><span class="hc-mon">${mo}</span></div><div class="hc-cal-right" aria-live="polite"><span class="hc-hh" data-clock="hh">${hh}</span><span class="hc-colon">:</span><span class="hc-mm" data-clock="mm">${mm}</span></div></div>`;
}
let _clockTimer=null;
function startLiveClock(root=document){
  if(_clockTimer){clearInterval(_clockTimer);_clockTimer=null}
  const tick=()=>{
    const {hh,mm}=romeClock();
    root.querySelectorAll('[data-clock="hh"]').forEach(el=>{el.textContent=hh});
    root.querySelectorAll('[data-clock="mm"]').forEach(el=>{el.textContent=mm});
    const L=liveStatus();
    root.querySelectorAll('[data-live-badge]').forEach(el=>{
      el.classList.toggle('on',L.on); el.classList.toggle('off',!L.on);
    });
  };
  tick();
  _clockTimer=setInterval(tick,1000);
}
let LANDED=false;
function render(){document.body.classList.toggle('app-bg',!!ME);if(!ME)return LANDED?authView('login'):landing();A.innerHTML=`<div class="appbg-photo" aria-hidden="true"><img src="/media/dashboard-bg.jpg" alt=""></div><div class="appshade"></div><nav class="glass"><b id="goHome" class="brand">${brandLogo()}</b>${avatar()}${[['home','Home'],['prenota','Prenota'],['mie','Le mie prenotazioni'],['profilo','Il mio profilo'],...(ME.role==='admin'?[['admin','Admin']]:[])].map(([k,l])=>`<a class="${view===k?'on':''}" data-v="${k}">${l}</a>`).join('')}<a id="out">Esci</a></nav><main id="m"></main>`;
 A.querySelectorAll('[data-v]').forEach(a=>a.onclick=()=>{view=a.dataset.v;render()});$('#out').onclick=async()=>{try{await api('/api/logout',{method:'POST'})}catch{}ME=null;LANDED=false;view='home';document.body.classList.remove('app-bg');render()};
 $('#goHome').onclick=()=>{view='home';render()};
 ({home:homeView,prenota:bookView,mie:mineView,admin:adminView,profilo:profileView})[view]()}
function landing(){document.body.classList.remove('app-bg');const P=PLAN.pricing;const vid=SITE.heroVideo?`<video class="bgvid" autoplay muted loop playsinline poster="${SITE.heroImage||''}"><source src="${SITE.heroVideo}" type="video/mp4"></video><div class="bgvid-shade"></div>`:'';A.innerHTML=`<div class="land has-bgvid">
${vid}<div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div><div class="ring"></div><div class="pill3d"></div>
<nav class="glass rise"><b class="brand">${brandLogo()}</b><a href="#spazi" class="hide-s">Spazi</a><a href="#prezzi" class="hide-s">Prezzi</a><a data-a="login">Accedi</a><a class="btn sm" data-a="reg">Registrati</a></nav>
<header class="hero2"><div class="htxt"><p class="kick rise" style="--d:.1s"><i></i>Damanhur Crea · Creative studio & coworking</p>
<h1 class="mega rise" style="--d:.2s">Crea<br><em>sulla</em> <span class="grad">Luna.</span></h1>
<p class="lead rise" style="--d:.35s">Scrivanie in uno studio creativo dove design, AI e idee condividono lo stesso tavolo. Scegli la postazione, prenota un giorno o un mese intero.</p>
<div class="cta rise" style="--d:.5s"><button class="btn lg" data-a="reg">Prenota la tua scrivania →</button><button class="btn ghost lg" data-a="login">Accedi</button></div>
<div class="stats rise" style="--d:.65s"><div><b>${PLAN.desks.length}</b><small>postazioni</small></div><div><b>€${P.giornata}</b><small>al giorno</small></div><div><b>€${P.mensile}</b><small>al mese</small></div></div></div>
<div class="hcard-wrap rise" style="--d:.4s"><div class="glass hcard hcard-photo" id="tilt"><img class="hcard-bg" src="/media/hcard-bg.jpg?v=4" alt="">${(()=>{const D=new Date((TODAY.date||today())+'T12:00:00');
const list=(TODAY.bookings||[]);
const desks=[...new Set(list.map(b=>b.deskId).filter(Boolean))];
const names=desks.length?desks.map(id=>`<li class="desk-only"><b>${id}</b></li>`).join(''):'<li class="empty">Nessuna prenotazione oggi</li>';
return `<div class="hc-live"><div class="hc-top"><small>Oggi in studio</small></div>
<ul class="hc-guests">${names}</ul>
<b class="hc-big">Scrivania A3</b><p>Vista finestra · Giornata intera</p>
<div class="hc-bar"><span style="width:${Math.min(100,Math.round(desks.length/6*100))}%"></span></div>
<div class="hc-row"><span>Occupazione</span><span>${desks.length}/6</span></div></div>`;})()}</div><div class="glass chip hc-date">${dateChipHtml(TODAY.date||today())}</div>${liveBadgeHtml()}<div class="glass chip c1">⚡ Wi-Fi 1 Gbit</div><div class="glass chip c-mid coffee">☕ Coffee break</div><div class="glass chip c3">🍳 Cucinino condiviso</div><div class="glass chip c4">🚻 Bagno condiviso</div></div></header>
<div class="marq"><div>Base Luna, Creative Design Studio · Damanhur Crea · Vidracco · Focus Community · Design · Coworking · Base Luna, Creative Design Studio · Damanhur Crea · Vidracco · Focus Community · Design · Coworking · </div></div>
<section id="prezzi" class="sec"><p class="kick reveal">Formule</p><h2 class="h2x reveal">Un giorno, o tutto il mese.</h2>
<div class="tiles"><div class="glass tile reveal"><small>Giornaliero</small><b>€${P.giornata}</b><span>Giornata intera · mezza giornata da €${P.mattina}</span><button class="btn ghost sm" data-a="reg">Prenota un giorno</button></div>
<div class="glass tile hot reveal"><span class="rec">Consigliato</span><small>Pacchetto mensile</small><b>€${P.mensile}</b><span>Tutti i giorni feriali, giornata intera, sempre la stessa scrivania</span><button class="btn sm" data-a="reg">Scegli il mensile</button></div>
<div class="glass tile bubble reveal"><span class="q">“Un posto dove le idee prendono quota.”</span><small>— Base Luna Studio</small></div></div></section>
<section id="spazi" class="sec"><p class="kick reveal">Spazi</p><h2 class="h2x reveal">Lo studio, in anteprima.</h2>
<div class="space-stage reveal"><div class="space-isl">${FloorPlan.islandHTML([{id:'A1',label:'A1'},{id:'A2',label:'A2'},{id:'A3',label:'A3'}],[{id:'B1',label:'B1'},{id:'B2',label:'B2'},{id:'B3',label:'B3'}],()=>'free',null)}</div>
  <div class="space-cap glass"><small>Anteprima glass</small><b>Isola 6 · 3 contro 3</b><span>Un unico banco doppio: tre baie, spine centrale, pannelli laterali — come nelle tue foto.</span></div>
</div><p class="kick reveal" style="margin-top:64px">Come funziona</p><h2 class="h2x reveal">Tre passi, zero attrito.</h2><div class="steps">
<div class="glass step reveal"><i>01</i><b>Scegli quando</b><span>Giorno, mattina, pomeriggio o pacchetto mensile.</span></div>
<div class="glass step reveal"><i>02</i><b>Scegli dove</b><span>Sulla piantina interattiva o nella disposizione giornaliera.</span></div>
<div class="glass step reveal"><i>03</i><b>Paga come vuoi</b><span>Bonifico, PayPal, contanti o Satispay.</span></div></div></section>
<section id="ispirazione" class="sec"><p class="kick reveal">Ispirazione</p><h2 class="h2x reveal">Uno spazio creativo per ispirarsi.</h2>
<div class="glass tile reveal inspire"><p class="inspire-lead">Tra Design, Coworking e Damanhur Crea a Vidracco, Base Luna è pensato come un luogo dove le idee respirano: luce, silenzio quando serve, e una community Focus che lavora fianco a fianco.</p>
<div class="inspire-grid"><div class="glass chip-inline">Coffee break</div><div class="glass chip-inline">Cucinino condiviso</div><div class="glass chip-inline">Bagno condiviso</div><div class="glass chip-inline">Wi-Fi 1 Gbit</div></div>
<button class="btn sm" data-a="reg" style="align-self:flex-start;margin-top:18px">Vieni in studio →</button></div></section>
<footer class="foot"><span class="foot-brand">${footLogo()}</span><small>Torino · baselunastudio.it</small></footer></div>`;
 A.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>{LANDED=true;authView(b.dataset.a)});
 const L=A.querySelector('.land'),T=A.querySelector('#tilt'),RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.15});L.querySelectorAll('.reveal').forEach((r,i)=>{r.style.setProperty('--d',(i%3)*.12+'s');io.observe(r)});
 if(!RM)L.onmousemove=e=>{const x=e.clientX/innerWidth-.5,y=e.clientY/innerHeight-.5;L.querySelectorAll('.orb,.ring,.pill3d').forEach((s,i)=>s.style.translate=`${x*(i+1)*-22}px ${y*(i+1)*-22}px`);if(T)T.style.transform=`perspective(1000px) rotateY(${x*14}deg) rotateX(${-y*14}deg)`;L.style.setProperty('--mx',e.clientX+'px');L.style.setProperty('--my',e.clientY+'px')};startLiveClock(A)}
function authView(t){document.body.classList.add('app-bg');A.innerHTML=`${SITE.heroVideo?`<video class="appvid" autoplay muted loop playsinline><source src="${SITE.heroVideo}" type="video/mp4"></video>`:''}<div class="appshade"></div><div class="glass auth rise"><a id="back" class="sub" style="cursor:pointer">← Home</a><div class="logo">${brandLogo()}</div><p class="sub">Coworking · Torino</p><div class="seg"><button class="${t==='login'?'on':''}" id="tl">Accedi</button><button class="${t==='reg'?'on':''}" id="tr">Registrati</button></div>
 <form id="f">${t==='reg'?'<label>Nome e cognome</label><input name="name" required>':''}<label>Email</label><input name="email" type="email" required><label>Password</label><input name="password" type="password" required minlength="6"><div class="err" id="e"></div><button class="btn" style="width:100%">${t==='login'?'Accedi':'Crea account'}</button></form></div>`;
 $('#back').onclick=()=>{LANDED=false;render()};$('#tl').onclick=()=>authView('login');$('#tr').onclick=()=>authView('reg');
 $('#f').onsubmit=async e=>{e.preventDefault();try{ME=await api(t==='login'?'/api/login':'/api/register',{method:'POST',body:Object.fromEntries(new FormData(e.target))});view='home';render()}catch(x){$('#e').textContent=x.message}}}
const range=()=>S.mode==='mensile'?[S.month+'-01',S.month+'-31']:[S.date,S.date];
const clash=(a,b)=>a==='giornata'||b==='giornata'||a===b;
function state(id){const o=S.occ.filter(b=>b.deskId===id&&(S.mode==='mensile'||clash(b.slot,S.slot)));if(S.desk===id)return'sel';if(o.some(b=>b.mine))return'mine busy';return o.length?'busy':'free'}
async function loadOcc(){const[f,t]=range();S.occ=await api(`/api/availability?from=${f}&to=${t}`)}

async function homeView(){
  try{TODAY=await api('/api/today')}catch{TODAY={date:today(),bookings:[]}}
  let mineAll=[]; try{mineAll=await api('/api/bookings/mine')}catch{mineAll=[]}
  const list=TODAY.bookings||[];
  const mine=list.filter(b=>b.mine);
  const others=list.filter(b=>!b.mine);
  const first=ME.name.split(' ')[0];
  const myDesk=mine[0]?mine[0].deskId:null;
  const otherNames=[...new Set(others.map(b=>b.name).filter(Boolean))];
  const deskLine=myDesk
    ? `<b class="hc-big">La tua scrivania è la <span class="hc-num">${esc(myDesk)}</span></b><p>${esc(first)} · ${SLOT[mine[0].slot]||mine[0].slot} · in studio oggi</p>`
    : `<b class="hc-big">Nessuna scrivania per oggi</b><p>${esc(first)}, prenota una postazione e torna qui.</p>`;
  const who=otherNames.length
    ? `<div class="hc-who"><small>Oggi in ufficio</small><ul class="hc-guests">${otherNames.map(n=>`<li><b>${esc(n)}</b></li>`).join('')}</ul></div>`
    : (myDesk
      ? `<div class="hc-who"><small>Oggi in ufficio</small><ul class="hc-guests"><li class="empty">Per ora sei solo tu in studio</li></ul></div>`
      : `<div class="hc-who"><small>Oggi in ufficio</small><ul class="hc-guests"><li class="empty">Nessuna prenotazione oggi</li></ul></div>`);
  const occ=new Set(list.map(b=>b.deskId)).size;
  const ym=(TODAY.date||today()).slice(0,7);
  const monthRows=mineAll.filter(b=>b.date&&b.date.startsWith(ym)&&b.status!=='annullata');
  const made=monthRows.length;
  const conf=monthRows.filter(b=>b.status==='confermata').length;
  const pending=monthRows.filter(b=>b.status!=='confermata').length;
  const paid=monthRows.filter(b=>b.status==='confermata').length;
  const unpaid=pending;
  const upcoming=mineAll.filter(b=>b.status!=='annullata'&&b.date>=(TODAY.date||today())).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,8);
  const mineList=upcoming.length
    ? `<ul class="home-book-list">${upcoming.map(b=>`<li><b>${esc(b.date)}</b> · scrivania <b>${esc(b.deskId)}</b> · ${esc(SLOT[b.slot]||b.slot)} · <span class="pill ${b.status!=='confermata'?'off':''}">${esc(b.status)}</span></li>`).join('')}</ul>`
    : `<p class="empty">Nessuna prenotazione in arrivo. <button class="btn sm" id="phBook2">Prenota</button></p>`;
  const deskBox=myDesk
    ? `<div class="home-desk-big"><span>Qual è la tua scrivania</span><strong>${esc(myDesk)}</strong><p>Oggi · ${esc(SLOT[mine[0].slot]||mine[0].slot)}</p></div>`
    : `<div class="home-desk-big"><span>Qual è la tua scrivania</span><strong>—</strong><p>Nessuna postazione per oggi</p></div>`;
  $('#m').innerHTML=`<div class="phome">
<header class="hero2 phome-hero">
  <div class="htxt">
    <p class="kick rise" style="--d:.1s"><i></i>Il tuo spazio · Base Luna</p>
    <h1 class="mega rise" style="--d:.2s">Crea<br><em>sulla</em> <span class="grad">Luna.</span></h1>
    <p class="lead rise" style="--d:.35s">Ciao ${esc(first)}. Ecco chi c’è in studio oggi e la tua postazione.</p>
    <div class="cta rise" style="--d:.5s">
      <button class="btn lg" id="phBook">${myDesk?'Gestisci prenotazioni':'Prenota la tua scrivania →'}</button>
      <button class="btn ghost lg" id="phProf">Il mio profilo</button>
    </div>
  </div>
  <div class="hcard-wrap rise" style="--d:.4s">
    <div class="glass hcard hcard-photo" id="tilt">
      <img class="hcard-bg" src="/media/hcard-bg.jpg?v=4" alt="">
      <div class="hc-live">
        <div class="hc-top"><small>Oggi in studio</small></div>
        ${who}
        ${deskLine}
        <div class="hc-bar"><span style="width:${Math.min(100,Math.round(occ/6*100))}%"></span></div>
        <div class="hc-row"><span>Occupazione</span><span>${occ}/6</span></div>
      </div>
    </div>
    <div class="glass chip hc-date">${dateChipHtml(TODAY.date||today())}</div>
    ${liveBadgeHtml()}
    <div class="glass chip c1 ph-amen">⚡ Wi-Fi 1 Gbit</div>
    <div class="glass chip c-mid coffee ph-amen">☕ Coffee break</div>
  </div>
</header>
<section class="home-panels rise" style="--d:.55s">
  <div class="glass card home-panel">
    <h2>Le mie prenotazioni</h2>
    <p class="sub">Prossime date prenotate</p>
    ${mineList}
    <button class="btn ghost sm" id="phAllMine">Vedi tutte</button>
  </div>
  <div class="glass card home-panel">
    <h2>Qual è la tua scrivania</h2>
    ${deskBox}
  </div>
  <div class="glass card home-panel">
    <h2>Riepilogo ${esc(ym)}</h2>
    <div class="home-stats">
      <div><b>${made}</b><span>prenotazioni del mese</span></div>
      <div><b>${conf}</b><span>confermate / pagate</span></div>
      <div><b>${unpaid}</b><span>da saldare</span></div>
    </div>
    <p class="sub">Dati dalle tue prenotazioni di questo mese.</p>
  </div>
</section>
</div>`;
  $('#phBook').onclick=()=>{view=myDesk?'mie':'prenota';render()};
  $('#phProf').onclick=()=>{view='profilo';render()};
  const all=$('#phAllMine'); if(all) all.onclick=()=>{view='mie';render()};
  const b2=$('#phBook2'); if(b2) b2.onclick=()=>{view='prenota';render()};
  const T=$('#tilt'), wrap=$('.phome');
  if(T&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    wrap.onmousemove=e=>{const x=e.clientX/innerWidth-.5,y=e.clientY/innerHeight-.5;T.style.transform=`perspective(1000px) rotateY(${x*14}deg) rotateX(${-y*14}deg)`};
  }
  startLiveClock(A);
}
async function bookView(){await loadOcc();try{const site=await api('/api/site');window.__payLinks={paypal:site.paypalPaymentUrl||'https://www.paypal.biz/baselunastudio',satispay:site.satispayPaymentUrl||''}}catch{window.__payLinks={paypal:'https://www.paypal.biz/baselunastudio',satispay:''}};const P=PLAN.pricing,price=S.mode==='mensile'?P.mensile:P[S.slot];
 $('#m').innerHTML=`${welcome()}<h1>Prenota la tua postazione</h1><p class="sub">Scegli quando, dove e come pagare.</p>
 <div class="glass card"><h2>1 · Quando</h2><div class="prod" id="mode"><button data-k="giornaliero" class="${S.mode==='giornaliero'?'on':''}"><small>Giorno / giornata</small><b>Ingresso giornaliero</b><span>Mattina, pomeriggio o giornata intera</span><em>da €${P.mattina}</em></button><button data-k="mensile" class="${S.mode==='mensile'?'on':''}"><small>Consigliato</small><b>Pacchetto mensile</b><span>Tutti i giorni feriali del mese, giornata intera, stessa scrivania</span><em>€${P.mensile}/mese</em></button></div>
 <div class="row">${S.mode==='mensile'?`<div><label>Mese (tutti i giorni feriali, giornata intera)</label><input type="month" id="mo" value="${S.month}" min="${today().slice(0,7)}"></div>`:`<div><label>Data</label><input type="date" id="dt" value="${S.date}" min="${today()}"></div><div><label>Fascia oraria</label><select id="sl">${Object.entries(SLOT).map(([k,l])=>`<option value="${k}" ${S.slot===k?'selected':''}>${l} · €${P[k]}</option>`).join('')}</select></div>`}</div>${S.mode==='mensile'?calendar():''}</div>
 <div class="glass card"><h2>2 · Scrivanie</h2><div class="seg" id="show"><button data-k="piantina" class="${S.show==='piantina'?'on':''}">Piantina</button><button data-k="elenco" class="${S.show==='elenco'?'on':''}">Disposizione giornaliera</button></div>
 <div class="legend"><span><i style="background:#22c55e"></i>Libera</span><span><i style="background:#9ca3af"></i>Occupata</span><span><i style="background:#FF5B00"></i>Selezionata</span></div><div id="dk"></div></div>
 <div class="glass card"><h2>3 · Metodo di pagamento</h2><div class="pay">${Object.entries(PAY).map(([k,l])=>`<button data-k="${k}" class="${S.pay===k?'on':''}">${l}</button>`).join('')}</div></div>
 <div class="glass card sum"><div><div class="sub" style="margin:0">${S.desk?'Scrivania '+S.desk:'Nessuna scrivania'} · ${S.mode==='mensile'?'Mese '+S.month:S.date+' · '+SLOT[S.slot]}${S.pay?' · '+PAY[S.pay]:''}</div><div class="price">€${price}</div><div class="err" id="e"></div></div><button class="btn" id="go" ${S.desk&&S.pay?'':'disabled'}>${S.pay==='satispay'||S.pay==='paypal'?'Prenota e paga':'Prenota'}</button></div>`;
 const dk=$('#dk');
 const syncSum=()=>{const P=PLAN.pricing,price=S.mode==='mensile'?P.mensile:P[S.slot];const sub=$('.sum .sub'),pr=$('.sum .price'),go=$('#go');if(sub)sub.textContent=(S.desk?'Scrivania '+S.desk:'Nessuna scrivania')+' · '+(S.mode==='mensile'?'Mese '+S.month:S.date+' · '+SLOT[S.slot])+(S.pay?' · '+PAY[S.pay]:'');if(pr)pr.textContent='€'+price;if(go){go.disabled=!(S.desk&&S.pay);go.textContent=(S.pay==='satispay'||S.pay==='paypal')?'Prenota e paga':'Prenota'}};
 const paintDesks=()=>{if(!dk)return;if(S.show==='piantina'){FloorPlan.render(dk,PLAN,state,pick)}else{dk.innerHTML=`<div class="desks">${PLAN.desks.map(d=>{const s=state(d.id);return`<button type="button" class="desk ${s}" data-id="${d.id}"><b>${d.label}</b><small>${(PLAN.zones.find(z=>z.id===d.zone)||{}).label||''} · ${s==='sel'?'Selezionata':s.includes('busy')?'Occupata':'Libera'}</small></button>`}).join('')}</div>`;dk.querySelectorAll('.desk').forEach(b=>b.onclick=()=>pick(b.dataset.id))}};
 const pick=id=>{if(!id||state(id).includes('busy'))return;S.desk=S.desk===id?null:id;paintDesks();syncSum()};
 paintDesks()
 const ch=()=>{S.desk=null;bookView()};
 $('#mode').onclick=e=>{const b=e.target.closest('[data-k]');if(b){S.mode=b.dataset.k;ch()}};$('#show').onclick=e=>{if(e.target.dataset.k){S.show=e.target.dataset.k;bookView()}};
 $('.pay').onclick=e=>{const k=e.target.dataset.k;if(!k)return;S.pay=k;const desk=S.desk||'—',when=S.mode==='mensile'?('mese '+S.month):(S.date+' · '+(SLOT[S.slot]||S.slot));const openMail=(sub,body)=>{window.open('mailto:baselunastudio@proton.me?subject='+encodeURIComponent(sub)+'&body='+encodeURIComponent(body),'_blank')};if(k==='contanti'){openMail('Prenotazione coworking — pagamento in contanti','Ciao Base Luna,\n\nvorrei prenotare pagando in contanti.\n\nScrivania: '+desk+'\nData/periodo: '+when+'\n\nGrazie')}else if(k==='bonifico'){openMail('Prenotazione coworking — bonifico','Ciao Base Luna,\n\nvorrei i dati IBAN per pagare con bonifico.\n\nScrivania: '+desk+'\nData/periodo: '+when+'\n\nGrazie')}else if(k==='paypal'){window.open((window.__payLinks&&window.__payLinks.paypal)||'https://www.paypal.biz/baselunastudio','_blank','noopener,noreferrer')}else if(k==='satispay'){const u=(window.__payLinks&&window.__payLinks.satispay)||'';if(u)window.open(u,'_blank','noopener,noreferrer');else openMail('Prenotazione coworking — Satispay','Ciao Base Luna,\n\nvorrei pagare con Satispay.\n\nScrivania: '+desk+'\nData/periodo: '+when+'\n\nGrazie')}bookView()};
 if($('#dt'))$('#dt').onchange=e=>{S.date=e.target.value;ch()};if($('#sl'))$('#sl').onchange=e=>{S.slot=e.target.value;ch()};if($('#mo'))$('#mo').onchange=e=>{S.month=e.target.value;ch()};
 $('#go').onclick=async()=>{try{const r=await api('/api/bookings',{method:'POST',body:{deskId:S.desk,mode:S.mode,date:S.date,month:S.month,slot:S.slot,payment:S.pay}});if(r.payUrl){window.open(r.payUrl,'_blank','noopener,noreferrer')}$('#m').innerHTML=`<div class="glass card" style="text-align:center;padding:60px"><h1>Prenotazione registrata</h1><p class="sub">Scrivania ${S.desk} · ${r.days} giorn${r.days>1?'i':'o'} · €${r.amount} · ${PAY[S.pay]}</p><p>Stato: <span class="pill off">da saldare</span> — ${S.pay==='contanti'?'lo studio è stato avvisato: paghi in contanti all\'arrivo.':S.pay==='bonifico'?'ti invieremo l\'IBAN per il bonifico.':'pagamento da completare.'} Diventa <b>confermata</b> appena il pagamento è registrato.</p><button class="btn" id="mm">Le mie prenotazioni</button></div>`;S.desk=null;$('#mm').onclick=()=>{view='mie';render()}}catch(x){$('#e').textContent=x.message}}}
function calendar(){const[y,m]=S.month.split('-').map(Number),n=new Date(y,m,0).getDate(),off=(new Date(y,m-1,1).getDay()+6)%7;let h='LMMGVSD'.split('').map(c=>`<div class="h">${c}</div>`).join('')+'<div style="background:none"></div>'.repeat(off);
 for(let d=1;d<=n;d++){const ds=`${S.month}-${String(d).padStart(2,'0')}`,we=[0,6].includes(new Date(y,m-1,d).getDay()),c=S.occ.filter(b=>b.date===ds).length;h+=`<div class="${we?'we':c>=PLAN.desks.length?'full':''}">${d}<br><small style="color:var(--g)">${we?'–':(PLAN.desks.length-new Set(S.occ.filter(b=>b.date===ds).map(b=>b.deskId)).size)+' lib.'}</small></div>`}
 return`<label>Disponibilità del mese</label><div class="cal">${h}</div>`}
async function mineView(){const b=await api('/api/bookings/mine');$('#m').innerHTML=`<h1>Le mie prenotazioni</h1><p class="sub">${b.filter(x=>x.status==='confermata').length} attive</p><div class="glass card"><table><tr><th>Data</th><th>Scrivania</th><th>Fascia</th><th>Tipo</th><th>Pagamento</th><th>Stato</th><th></th></tr>${b.map(x=>`<tr><td>${x.date}</td><td>${x.deskId}</td><td>${SLOT[x.slot]}</td><td>${x.mode}</td><td>${PAY[x.payment]||x.payment}</td><td><span class="pill ${x.status!=='confermata'?'off':''}">${x.status}</span></td><td>${x.status!=='annullata'?`${x.status==='in attesa di pagamento'?`<a class="btn sm" href="/pay/${x.payment}?g=${x.group}" target="_blank" rel="noopener">Paga</a> `:''}<button class="btn sm ghost" data-id="${x.id}">Annulla</button>`:''}</td></tr>`).join('')||'<tr><td colspan=7>Nessuna prenotazione</td></tr>'}</table></div>`;
 $('#m').querySelectorAll('[data-id]').forEach(e=>e.onclick=async()=>{await api('/api/bookings/'+e.dataset.id,{method:'DELETE'});mineView()})}
async function adminView(){const[u,b,pp,pr]=await Promise.all([api('/api/admin/users'),api('/api/admin/bookings'),api('/api/admin/payments'),api('/api/admin/pricing')]);
 const active=b.filter(x=>x.status!=='annullata');
 const byMonth={};
 active.forEach(x=>{const mo=(x.date||'').slice(0,7)||'????-??';(byMonth[mo]=byMonth[mo]||[]).push(x)});
 const months=Object.keys(byMonth).sort((a,c)=>c.localeCompare(a));
 const monthHtml=months.map(mo=>{
  const rows=byMonth[mo].slice().sort((a,c)=>c.date.localeCompare(a.date)||a.deskId.localeCompare(c.deskId));
  const byDay={};rows.forEach(x=>{(byDay[x.date]=byDay[x.date]||[]).push(x)});
  const days=Object.keys(byDay).sort((a,c)=>c.localeCompare(a));
  const dayBlocks=days.map(day=>{
   const list=byDay[day];
   return `<div class="adm-day"><div class="adm-day-h"><b>${esc(day)}</b><span class="sub">${list.length} prenotaz.</span><button class="btn sm ghost danger" data-cancel-day="${esc(day)}">Annulla tutta la giornata</button></div>
   <table><tr><th>Utente</th><th>Scrivania</th><th>Fascia</th><th>Tipo</th><th>Pagamento</th><th>Stato</th><th></th></tr>
   ${list.map(x=>`<tr><td>${esc(x.user)}</td><td>${esc(x.deskId)}</td><td>${esc(SLOT[x.slot]||x.slot)}</td><td>${esc(x.mode)}</td><td>${esc(PAY[x.payment]||x.payment)}</td><td><span class="pill ${x.status!=='confermata'?'off':''}">${esc(x.status)}</span></td><td><button class="btn sm ghost" data-b="${x.id}">Annulla</button></td></tr>`).join('')}
   </table></div>`;
  }).join('');
  return `<div class="adm-month glass card"><div class="adm-month-h"><h3>${esc(mo)}</h3><span class="sub">${rows.length} prenotaz.</span><button class="btn sm ghost danger" data-cancel-month="${esc(mo)}">Annulla tutto il mese</button></div>${dayBlocks||'<p class="sub">Nessuna</p>'}</div>`;
 }).join('')||'<div class="glass card"><p class="sub">Nessuna prenotazione attiva</p></div>';
 $('#m').innerHTML=`<h1>Admin</h1><p class="sub">${u.length} account · ${active.filter(x=>x.status==='confermata').length} confermate · ${active.length} attive</p>
 <div class="glass card"><h2>Pacchetti</h2><p class="sub">Prezzi backend (data/floorplan.json). Landing e Prenota li leggono da qui.</p>
 <div class="row" style="gap:12px;flex-wrap:wrap">
  <div><label>Mattina 9–13 (€)</label><input type="number" min="0" step="0.01" id="pr-mattina" value="${pr.mattina??''}"></div>
  <div><label>Pomeriggio 14–19 (€)</label><input type="number" min="0" step="0.01" id="pr-pomeriggio" value="${pr.pomeriggio??''}"></div>
  <div><label>Giornata intera (€)</label><input type="number" min="0" step="0.01" id="pr-giornata" value="${pr.giornata??''}"></div>
  <div><label>Mensile (€)</label><input type="number" min="0" step="0.01" id="pr-mensile" value="${pr.mensile??''}"></div>
 </div>
 <button class="btn" id="pr-save" style="margin-top:12px">Salva prezzi</button> <span id="pr-msg" class="sub"></span></div>
 <div class="glass card"><h2>Pagamenti da registrare</h2><p class="sub">Contanti da riscuotere, bonifici, Satispay/PayPal in attesa. Confermata solo dopo «Pagato».</p><table><tr><th>Utente</th><th>Scrivania</th><th>Periodo</th><th>Metodo</th><th>Importo</th><th>Stato</th><th></th></tr>${pp.map(p=>`<tr><td>${esc(p.user)}</td><td>${esc(p.deskId)}</td><td>${esc(p.dates[0])}${p.days>1?' → '+esc(p.dates[1]):''}</td><td>${p.method==='contanti'?'<b>Contanti da riscuotere</b>':esc(PAY[p.method]||p.method)}</td><td>€${p.amount}</td><td>${esc(p.status)}</td><td><button class="btn sm" data-p="${p.group}">Pagato ✓</button></td></tr>`).join('')||'<tr><td colspan=7>Nessuno</td></tr>'}</table></div>
 <div class="glass card"><h2>Account</h2><table><tr><th>Nome</th><th>Email</th><th>Ruolo</th><th>Prenot.</th><th>Stato</th><th></th></tr>${u.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${esc(x.role)}</td><td>${x.bookings}</td><td><span class="pill ${x.active?'':'off'}">${x.active?'attivo':'disattivato'}</span></td><td>${x.id!==ME.id?`<button class="btn sm ghost" data-u="${x.id}" data-a="${x.active?0:1}">${x.active?'Disattiva':'Riattiva'}</button> <button class="btn sm ghost" data-r="${x.id}" data-role="${x.role==='admin'?'user':'admin'}">${x.role==='admin'?'Rendi utente':'Rendi admin'}</button> <button class="btn sm ghost danger" data-del="${x.id}">Elimina account</button>`:'(tu)'}</td></tr>`).join('')}</table></div>
 <h2 style="margin-top:28px">Prenotazioni per mese / giorno</h2>
 ${monthHtml}`;
 const m=$('#m');
 m.querySelectorAll('[data-p]').forEach(e=>e.onclick=async()=>{await api('/api/admin/pay/'+e.dataset.p+'/paid',{method:'POST'});adminView()});
 m.querySelectorAll('[data-u]').forEach(e=>e.onclick=async()=>{await api('/api/admin/users/'+e.dataset.u,{method:'PATCH',body:{active:e.dataset.a==='1'}});adminView()});
 m.querySelectorAll('[data-r]').forEach(e=>e.onclick=async()=>{await api('/api/admin/users/'+e.dataset.r,{method:'PATCH',body:{role:e.dataset.role}});adminView()});
 m.querySelectorAll('[data-b]').forEach(e=>e.onclick=async()=>{await api('/api/bookings/'+e.dataset.b,{method:'DELETE'});adminView()});
 m.querySelectorAll('[data-del]').forEach(e=>e.onclick=async()=>{if(!confirm('Eliminare definitivamente questo account?'))return;await api('/api/admin/users/'+e.dataset.del,{method:'DELETE'});adminView()});
 m.querySelectorAll('[data-cancel-day]').forEach(e=>e.onclick=async()=>{if(!confirm('Annullare TUTTE le prenotazioni del '+e.dataset.cancelDay+'?'))return;await api('/api/admin/bookings/cancel-day',{method:'POST',body:{date:e.dataset.cancelDay}});adminView()});
 m.querySelectorAll('[data-cancel-month]').forEach(e=>e.onclick=async()=>{if(!confirm('Annullare TUTTE le prenotazioni di '+e.dataset.cancelMonth+'?'))return;await api('/api/admin/bookings/cancel-month',{method:'POST',body:{month:e.dataset.cancelMonth}});adminView()});
 const save=$('#pr-save'),msg=$('#pr-msg');
 if(save)save.onclick=async()=>{msg.textContent='Salvo…';try{const body={mattina:+$('#pr-mattina').value,pomeriggio:+$('#pr-pomeriggio').value,giornata:+$('#pr-giornata').value,mensile:+$('#pr-mensile').value};const out=await api('/api/admin/pricing',{method:'PATCH',body});PLAN=await api('/api/floorplan');PLAN.pricing=out;msg.textContent='Prezzi aggiornati';}catch(err){msg.textContent=err.message||'Errore'}};
}
const esc=t=>String(t||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const avatar=(cls='')=>ME.avatar?`<img class="av ${cls}" src="${ME.avatar}" alt="">`:`<span class="av ${cls} ini">${esc(ME.name.split(' ').map(w=>w[0]).join('').slice(0,2))}</span>`;
function welcome(){const h=new Date().getHours(),g=h<12?'Buongiorno':h<18?'Buon pomeriggio':'Buonasera';return`<section class="glass welcome rise"><div class="w-orb"></div><div class="w-av">${avatar('lg')}<i class="ring2"></i></div><div class="w-txt"><small>${g} · Base Luna Studio</small><h2 class="w-name">${esc(ME.name.split(' ')[0])}, <span class="grad">crea sulla Luna.</span></h2><p>${ME.bio?esc(ME.bio):'Racconta chi sei: aggiungi una foto e due righe su di te.'}</p>${ME.title?`<span class="chip-s">${esc(ME.title)}</span>`:''}</div><button class="btn ghost sm" id="goprof">${ME.bio||ME.avatar?'Modifica profilo':'Completa il profilo →'}</button></section>`}
document.addEventListener('click',e=>{if(e.target.id==='goprof'){view='profilo';render()}});
function profileView(){$('#m').innerHTML=`<h1>Il mio profilo</h1><p class="sub">Così ti riconoscono in studio.</p><div class="row"><div class="glass card prof-l"><div class="w-av big">${avatar('xl')}<i class="ring2"></i></div><label class="btn ghost sm up">Carica foto<input type="file" id="ph" accept="image/png,image/jpeg,image/webp" hidden></label><p class="sub" style="margin:10px 0 0;font-size:12px">PNG, JPG o WEBP · ridimensionata a 512px</p></div><div class="glass card"><label>Nome visualizzato</label><input id="pn" value="${esc(ME.name)}"><label>Ruolo / cosa fai</label><input id="pt" maxlength="60" placeholder="es. Designer, illustratrice, sviluppatore" value="${esc(ME.title)}"><label>Qualcosa su di te</label><textarea id="pb" maxlength="400" rows="5" placeholder="Su cosa lavori, cosa ti ispira…">${esc(ME.bio)}</textarea><button class="btn" id="ps">Salva profilo</button> <span id="pmsg" class="sub"></span></div></div>`;
 $('#ph').onchange=async e=>{const f=e.target.files[0];if(!f)return;const img=new Image();img.src=URL.createObjectURL(f);await img.decode();const c=document.createElement('canvas'),k=Math.min(1,512/Math.max(img.width,img.height));c.width=img.width*k;c.height=img.height*k;c.getContext('2d').drawImage(img,0,0,c.width,c.height);try{ME=await api('/api/me/avatar',{method:'POST',body:{image:c.toDataURL('image/jpeg',.88)}});profileView()}catch(x){$('#pmsg').textContent=x.message}};
 $('#ps').onclick=async()=>{try{ME=await api('/api/me/profile',{method:'PATCH',body:{name:$('#pn').value,title:$('#pt').value,bio:$('#pb').value}});$('#pmsg').textContent='Salvato ✓';render()}catch(x){$('#pmsg').textContent=x.message}}}
boot();
