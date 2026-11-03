// Modulo Piantina SOSTITUIBILE. Contratto: FloorPlan.render(container, plan, state, onPick)
// v20261103f: foto INTERA, poligoni su vetro, label 3D, colore da occupazione
window.FloorPlan={
 _IMG:'/media/island-ref.png?v=20261102u',
 // Poligoni % (2016×1344): TL,TR,BR,BL — superficie vetro intera di ogni desk
 _HOTS:{
   A1:[[25.5,21.5],[46.0,29.5],[40.0,39.5],[19.5,30.5]],
   A2:[[46.0,29.5],[68.0,37.5],[62.0,48.5],[40.0,39.5]],
   A3:[[68.0,37.5],[91.0,46.5],[85.5,58.0],[62.5,48.5]],
   B1:[[19.5,30.5],[40.0,39.5],[34.0,49.5],[13.0,40.5]],
   B2:[[39.5,39.5],[62.0,48.5],[57.0,59.5],[34.0,49.5]],
   B3:[[62.5,48.5],[85.5,58.0],[79.5,69.5],[56.5,59.5]],
 },
 _plane(pts){
  const [tl,tr,br,bl]=pts;
  const cx=(tl[0]+tr[0]+br[0]+bl[0])/4;
  const cy=(tl[1]+tr[1]+br[1]+bl[1])/4;
  let ux=((tr[0]-tl[0])+(br[0]-bl[0]))/2;
  let uy=((tr[1]-tl[1])+(br[1]-bl[1]))/2;
  let vx=((bl[0]-tl[0])+(br[0]-tr[0]))/2;
  let vy=((bl[1]-tl[1])+(br[1]-tr[1]))/2;
  if(ux*vy-uy*vx<0){ux=-ux;uy=-uy}
  // Fixed label size (viewBox units) — do NOT scale with desk width or letters explode
  const lenU=Math.hypot(ux,uy)||1, lenV=Math.hypot(vx,vy)||1;
  const tu=3.4, tv=2.2;
  return {cx,cy,ax:ux/lenU*tu,ay:uy/lenU*tu,bx:vx/lenV*tv,by:vy/lenV*tv};
 },
 islandHTML(A,B,st,L){
  const desks=[...(A||[]),...(B||[])];
  const byId=Object.fromEntries(desks.map(d=>[d.id,d]));
  const order=['A1','A2','A3','B1','B2','B3'];
  const polys=[], labels=[];
  const ranked=[...order].sort((a,b)=>{
   const sa=st?st(a):'free', sb=st?st(b):'free';
   const rank=s=>(s==='busy'||s==='mine')?0:1; // busy under free so free desks stay clickable if polys overlap
   return rank(sa)-rank(sb);
  });
  ranked.forEach(id=>{
   const d=byId[id]||{id,label:id};
   const s=st?st(d.id):'free';
   const lab=L?L[s]:'';
   const pts=this._HOTS[id];
   const points=pts.map(p=>`${p[0]},${p[1]}`).join(' ');
   const P=this._plane(pts);
   const labTone=(s==='busy'||s==='mine')?'busy':'free';
   polys.push(`<polygon class="isl-poly isl-${d.id} ${s}" data-id="${d.id}" points="${points}" tabindex="${s==='busy'?'-1':'0'}" role="button" aria-label="Postazione ${d.label} ${lab||''}"></polygon>`);
   labels.push(`<text class="isl-lab isl-lab-${labTone} isl-${d.id}" transform="matrix(${P.ax},${P.ay},${P.bx},${P.by},${P.cx},${P.cy})" x="0" y="0" text-anchor="middle" dominant-baseline="central">${d.label}</text>`);
  });
  return `<div class="isl-photo-wrap">
    <img class="isl-photo" src="${this._IMG}" alt="Isola 6 scrivanie" draggable="false">
    <svg class="isl-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="false">${polys.join('')}${labels.join('')}</svg>
  </div>`;
 },
 render(el,plan,state,onPick){
  if(!el)return;
  const L={free:'Libera',busy:'Occupata',mine:'Tua',sel:'Selezionata'};
  const st=id=>{const s=state(id);return s.includes('sel')?'sel':s.includes('mine')?'mine':s.includes('busy')?'busy':'free'};
  const desks=plan&&plan.desks?plan.desks:[];
  const A=desks.filter(d=>d.zone==='latoA');
  const B=desks.filter(d=>d.zone!=='latoA');
  el.innerHTML=`<div class="fp3-book" data-v="20261102u">${this.islandHTML(A,B,st,L)}</div>`;
  const pick=id=>{if(!id)return; onPick(id)};
  el.querySelectorAll('.isl-poly').forEach(g=>{
   if(g.classList.contains('busy')){g.removeAttribute('tabindex');return}
   g.addEventListener('click',()=>pick(g.dataset.id));
   g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(g.dataset.id)}});
  });
 }
};
