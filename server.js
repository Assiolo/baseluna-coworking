const express=require('express'),cp=require('cookie-parser'),bc=require('bcryptjs'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const D=path.join(__dirname,'data'),DB=path.join(D,'db.json'),FP=path.join(D,'floorplan.json');
let db=fs.existsSync(DB)?JSON.parse(fs.readFileSync(DB)):{users:[],bookings:[],sessions:{}};
const save=()=>fs.writeFileSync(DB,JSON.stringify(db,null,1));
const fp=()=>JSON.parse(fs.readFileSync(FP));
const CF=path.join(D,'config.json'),NF=path.join(D,'notifications.json');
const cfg=()=>{try{return JSON.parse(fs.readFileSync(CF))}catch{return{}}};
const notify=n=>{let a=[];try{a=JSON.parse(fs.readFileSync(NF))}catch{}a.push({...n,created:new Date().toISOString(),sent:false});fs.writeFileSync(NF,JSON.stringify(a,null,1))};
const linkFor=(m,amt)=>{const u=(cfg()[m+'PaymentUrl']||'').trim();if(!u)return null;return u.replace(/\{amount_cents\}/g,Math.round(amt*100)).replace(/\{amount\}/g,amt)};
const app=express();app.use(express.json({limit:'8mb'}),cp(),express.static(path.join(__dirname,'public')));
const pub=u=>({id:u.id,name:u.name,email:u.email,role:u.role,active:u.active,bio:u.bio||'',avatar:u.avatar||'',title:u.title||''});
const me=r=>{const id=db.sessions[r.cookies.sid];const u=db.users.find(x=>x.id===id);return u&&u.active?u:null};
const auth=(q,s,n)=>(q.u=me(q))?n():s.status(401).json({error:'Non autenticato'});
const admin=(q,s,n)=>q.u.role==='admin'?n():s.status(403).json({error:'Solo admin'});
const login=(s,u)=>{const t=crypto.randomBytes(24).toString('hex');db.sessions[t]=u.id;save();s.cookie('sid',t,{httpOnly:true,sameSite:'lax'});s.json(pub(u))};
app.post('/api/register',(q,s)=>{const{name,email,password}=q.body||{};if(!name||!email||!password||password.length<6)return s.status(400).json({error:'Compila tutti i campi (password min 6)'});if(db.users.find(u=>u.email===email.toLowerCase()))return s.status(409).json({error:'Email già registrata'});const u={id:db.users.length?Math.max(...db.users.map(u=>u.id))+1:1,name,email:email.toLowerCase(),hash:bc.hashSync(password,10),role:db.users.some(x=>x.role==='admin')?'user':'admin',active:true};db.users.push(u);login(s,u)});
app.post('/api/login',(q,s)=>{const u=db.users.find(u=>u.email===(q.body.email||'').toLowerCase());if(!u||!bc.compareSync(q.body.password||'',u.hash))return s.status(401).json({error:'Credenziali non valide'});if(!u.active)return s.status(403).json({error:'Account disattivato'});login(s,u)});
app.post('/api/logout',(q,s)=>{delete db.sessions[q.cookies.sid];save();s.clearCookie('sid').json({ok:1})});
app.get('/api/me',auth,(q,s)=>s.json(pub(q.u)));
const AV=path.join(__dirname,'public/uploads/avatars');fs.mkdirSync(AV,{recursive:true});
app.patch('/api/me/profile',auth,(q,s)=>{const b=q.body||{};if(typeof b.bio==='string')q.u.bio=b.bio.slice(0,400);if(typeof b.title==='string')q.u.title=b.title.slice(0,60);if(typeof b.name==='string'&&b.name.trim())q.u.name=b.name.trim().slice(0,60);save();s.json(pub(q.u))});
app.post('/api/me/avatar',auth,(q,s)=>{const m=/^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec((q.body||{}).image||'');if(!m)return s.status(400).json({error:'Immagine non valida (PNG, JPG o WEBP)'});const buf=Buffer.from(m[2],'base64');if(buf.length>5e6)return s.status(400).json({error:'Max 5 MB'});const f=`u${q.u.id}-${Date.now()}.${m[1]==='jpeg'?'jpg':m[1]}`;if(q.u.avatar){try{fs.unlinkSync(path.join(__dirname,'public',q.u.avatar))}catch{}}fs.writeFileSync(path.join(AV,f),buf);q.u.avatar='/uploads/avatars/'+f;save();s.json(pub(q.u))});
app.get('/api/site',(q,s)=>{const c=cfg();s.json({heroImage:c.heroImage||'',heroVideo:c.heroVideo||'',paypalPaymentUrl:c.paypalPaymentUrl||'',satispayPaymentUrl:c.satispayPaymentUrl||''})});
app.get('/api/floorplan',(q,s)=>s.json(fp()));
app.get('/api/today',(q,s)=>{
  const iso=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Rome'});
  try{db=JSON.parse(fs.readFileSync(DB))}catch{}
  const u=me(q);
  const rows=live().filter(b=>b.date===iso).map(b=>{
    const row={deskId:b.deskId,slot:b.slot,status:b.status,mine:!!(u&&b.userId===u.id)};
    // Names only for logged-in users (personal home). Public stays desk-only.
    if(u){const gu=db.users.find(x=>x.id===b.userId)||{};row.name=gu.name||'Ospite';row.userId=b.userId}
    return row;
  });
  s.json({date:iso,bookings:rows});
});

const clash=(a,b)=>a==='giornata'||b==='giornata'||a===b;
const live=()=>db.bookings.filter(b=>b.status!=='annullata');
app.get('/api/availability',auth,(q,s)=>{const{from,to}=q.query;s.json(live().filter(b=>b.date>=from&&b.date<=to).map(b=>({deskId:b.deskId,date:b.date,slot:b.slot,mine:b.userId===q.u.id})))});
const days=(m)=>{const[y,mo]=m.split('-').map(Number),r=[];for(let d=1;d<=new Date(y,mo,0).getDate();d++){const dt=new Date(y,mo-1,d);if(dt.getDay()%6)r.push(`${m}-${String(d).padStart(2,'0')}`)}return r};
app.post('/api/bookings',auth,(q,s)=>{const{deskId,mode,date,month,slot,payment}=q.body||{};const P=fp();if(!P.desks.find(d=>d.id===deskId))return s.status(400).json({error:'Scrivania non valida'});if(!['bonifico','paypal','contanti','satispay'].includes(payment))return s.status(400).json({error:'Scegli un metodo di pagamento'});
 let dates,sl,price;if(mode==='mensile'){if(!/^\d{4}-\d{2}$/.test(month||''))return s.status(400).json({error:'Mese non valido'});dates=days(month);sl='giornata';price=P.pricing.mensile}else{if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!P.pricing[slot])return s.status(400).json({error:'Data o fascia non valida'});dates=[date];sl=slot;price=P.pricing[slot]}
 const c=live().find(b=>b.deskId===deskId&&dates.includes(b.date)&&clash(b.slot,sl));if(c)return s.status(409).json({error:`${deskId} è già occupata il ${c.date} (${c.slot})`});
 const g=crypto.randomUUID().slice(0,8),online=['satispay','paypal'].includes(payment),st=online?'in attesa di pagamento':'da saldare';
 dates.forEach(d=>db.bookings.push({id:crypto.randomUUID().slice(0,8),group:g,userId:q.u.id,deskId,date:d,slot:sl,mode:mode==='mensile'?'mensile':'giornaliero',payment,status:st,price:mode==='mensile'?null:price,created:new Date().toISOString()}));
 db.payments=db.payments||[];db.payments.push({group:g,userId:q.u.id,deskId,dates:[dates[0],dates[dates.length-1]],days:dates.length,mode:mode==='mensile'?'mensile':'giornaliero',slot:sl,amount:price,method:payment,status:'in attesa'});save();
 if(payment==='contanti')notify({type:'contanti_da_riscuotere',to:'owner (Base Luna Studio)',group:g,user:q.u.name,email:q.u.email,deskId,from:dates[0],to_date:dates[dates.length-1],days:dates.length,slot:sl,amount:price,text:`Prenotazione in contanti: ${q.u.name} (${q.u.email}) — scrivania ${deskId}, ${dates[0]}${dates.length>1?' → '+dates[dates.length-1]+' ('+dates.length+' giorni)':' ('+sl+')'}, €${price} da riscuotere.`});
 s.json({ok:1,group:g,amount:price,days:dates.length,status:st,payUrl:online?`/pay/${payment}?g=${g}`:null})});
app.get('/api/pay/:g',auth,(q,s)=>{const p=(db.payments||[]).find(p=>p.group===q.params.g&&(p.userId===q.u.id||q.u.role==='admin'));if(!p)return s.status(404).json({error:'Pagamento non trovato'});s.json({...p,link:linkFor(p.method,p.amount)})});
app.post('/api/pay/:g/reported',auth,(q,s)=>{const p=(db.payments||[]).find(p=>p.group===q.params.g&&p.userId===q.u.id);if(!p)return s.sendStatus(404);p.status='segnalato dal cliente';p.reported=new Date().toISOString();save();s.json({ok:1})});
app.post('/api/admin/pay/:g/paid',auth,admin,(q,s)=>{const p=(db.payments||[]).find(p=>p.group===q.params.g);if(!p)return s.sendStatus(404);p.status='pagato';p.paid=new Date().toISOString();db.bookings.filter(b=>b.group===p.group&&b.status!=='annullata').forEach(b=>b.status='confermata');save();s.json({ok:1})});
app.get('/api/admin/payments',auth,admin,(q,s)=>s.json((db.payments||[]).filter(p=>p.status!=='pagato'&&p.deskId&&db.bookings.some(b=>b.group===p.group&&b.status!=='annullata')).map(p=>({...p,user:(db.users.find(u=>u.id===p.userId)||{}).name}))));
app.get('/api/admin/pricing',auth,admin,(q,s)=>{const P=fp();s.json(P.pricing||{})});
app.patch('/api/admin/pricing',auth,admin,(q,s)=>{const b=q.body||{},keys=['mattina','pomeriggio','giornata','mensile'],P=fp();P.pricing=P.pricing||{};for(const k of keys){if(k in b){const n=Number(b[k]);if(!Number.isFinite(n)||n<0)return s.status(400).json({error:'Prezzo non valido: '+k});P.pricing[k]=Math.round(n*100)/100}}fs.writeFileSync(FP,JSON.stringify(P,null,2));s.json(P.pricing)});
app.get('/pay/:m',(q,s)=>s.sendFile(path.join(__dirname,'public/pay.html')));
app.get('/api/bookings/mine',auth,(q,s)=>s.json(db.bookings.filter(b=>b.userId===q.u.id).sort((a,b)=>a.date.localeCompare(b.date))));
app.delete('/api/bookings/:id',auth,(q,s)=>{const b=db.bookings.find(b=>b.id===q.params.id);if(!b||(b.userId!==q.u.id&&q.u.role!=='admin'))return s.status(404).json({error:'Non trovata'});b.status='annullata';save();s.json({ok:1})});
app.get('/api/admin/users',auth,admin,(q,s)=>s.json(db.users.map(u=>({...pub(u),bookings:live().filter(b=>b.userId===u.id).length}))));
app.patch('/api/admin/users/:id',auth,admin,(q,s)=>{const u=db.users.find(u=>u.id==q.params.id);if(!u)return s.sendStatus(404);if(u.id===q.u.id)return s.status(400).json({error:'Non puoi modificare te stesso'});if('active'in q.body)u.active=!!q.body.active;if(q.body.role)u.role=q.body.role==='admin'?'admin':'user';save();s.json(pub(u))});
app.get('/api/admin/bookings',auth,admin,(q,s)=>s.json(db.bookings.map(b=>({...b,user:(db.users.find(u=>u.id===b.userId)||{}).name})).sort((a,b)=>b.date.localeCompare(a.date))));
app.delete('/api/admin/users/:id',auth,admin,(q,s)=>{const id=+q.params.id;const u=db.users.find(x=>x.id===id);if(!u)return s.sendStatus(404);if(u.id===q.u.id)return s.status(400).json({error:'Non puoi eliminare te stesso'});db.users=db.users.filter(x=>x.id!==id);Object.keys(db.sessions).forEach(k=>{if(db.sessions[k]===id)delete db.sessions[k]});db.bookings.forEach(b=>{if(b.userId===id&&b.status!=='annullata')b.status='annullata'});(db.payments||[]).forEach(p=>{if(p.userId===id&&p.status!=='pagato')p.status='annullato'});save();s.json({ok:1})});
app.post('/api/admin/bookings/cancel-day',auth,admin,(q,s)=>{const day=(q.body||{}).date;if(!/^\d{4}-\d{2}-\d{2}$/.test(day||''))return s.status(400).json({error:'Data non valida'});let n=0;db.bookings.forEach(b=>{if(b.date===day&&b.status!=='annullata'){b.status='annullata';n++}});save();s.json({ok:1,cancelled:n})});
app.post('/api/admin/bookings/cancel-month',auth,admin,(q,s)=>{const month=(q.body||{}).month;if(!/^\d{4}-\d{2}$/.test(month||''))return s.status(400).json({error:'Mese non valido'});let n=0;db.bookings.forEach(b=>{if(b.date&&b.date.startsWith(month)&&b.status!=='annullata'){b.status='annullata';n++}});save();s.json({ok:1,cancelled:n})});


app.get('/api/hots',(q,s)=>{
  const fpJs=path.join(__dirname,'public','floorplan.js');
  const txt=fs.readFileSync(fpJs,'utf8');
  const hots={};
  for(const id of ['A1','A2','A3','B1','B2','B3']){
    const mm=txt.match(new RegExp(id+':(\\[[^\n]+\\])'));
    if(!mm)return s.status(500).json({error:'HOTS mancante: '+id});
    hots[id]=JSON.parse(mm[1]);
  }
  s.json({hots, version:(txt.match(/v(\d{8}\w)/)||[])[1]||null});
});
app.post('/api/hots',(q,s)=>{
  const h=q.body&&q.body.hots; if(!h)return s.status(400).json({error:'hots richiesti'});
  for(const id of ['A1','A2','A3','B1','B2','B3']){
    if(!Array.isArray(h[id])||h[id].length!==4)return s.status(400).json({error:'Formato '+id});
  }
  const fpJs=path.join(__dirname,'public','floorplan.js');
  let txt=fs.readFileSync(fpJs,'utf8');
  const block=[' _HOTS:{'];
  for(const id of ['A1','A2','A3','B1','B2','B3']){
    const pts=h[id].map(p=>'['+(+p[0]).toFixed(1)+','+(+p[1]).toFixed(1)+']').join(',');
    block.push('   '+id+':['+pts+'],');
  }
  block.push(' },');
  const next=txt.replace(/ _HOTS:\{[\s\S]*?\n \},/, block.join('\n'));
  if(next===txt)return s.status(500).json({error:'Sostituzione fallita'});
  const ver='20261102u';
  const stamped=next.replace(/v20261102\w/g,'v'+ver).replace(/\?v=20261102\w/g,'?v='+ver);
  fs.writeFileSync(fpJs, stamped);
  const idx=path.join(__dirname,'public','index.html');
  if(fs.existsSync(idx)){
    let i=fs.readFileSync(idx,'utf8');
    i=i.replace(/\?v=20261102\w/g,'?v='+ver);
    fs.writeFileSync(idx,i);
  }
  s.json({ok:1,version:'v'+ver,hots:h});
});

app.get(/^\/(?!api).*/,(q,s)=>s.sendFile(path.join(__dirname,'public/index.html')));
const PORT=process.env.PORT||5173;app.listen(PORT,'0.0.0.0',()=>console.log('Base Luna Coworking su http://localhost:'+PORT));
