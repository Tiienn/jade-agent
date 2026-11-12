'use strict';
const $=id=>document.getElementById(id), canvas=$('canvas'), ctx=canvas.getContext('2d');
const colors={Red:'#e33c34',Blue:'#1976d2',Green:'#159447',Magenta:'#c238b4'};
let plan=null,state=null,initial=null,image=new Image(),history=[],zoom=1,ox=0,oy=0,mode='select',selected=-1,drag=null,dirty=false,saving=false;
const clone=x=>JSON.parse(JSON.stringify(x));
function status(text,error=false){$('status').textContent=text;$('status').className=error?'error':'';}
function push(){history.push({state:clone(state),mode});if(history.length>50)history.shift();dirty=true;$('undo').disabled=false;}
function screen(p){return [p[0]*zoom+ox,p[1]*zoom+oy];}
function worldToImage(p){const b=plan.bounds,s=Math.min(plan.width/(b[1][0]-b[0][0]),plan.height/(b[1][1]-b[0][1]));return [(p[0]-(b[0][0]+b[1][0])/2)*s+plan.width/2,plan.height/2-(p[1]-(b[0][1]+b[1][1])/2)*s];}
function imageToWorld(p){const b=plan.bounds,s=Math.min(plan.width/(b[1][0]-b[0][0]),plan.height/(b[1][1]-b[0][1]));return [(p[0]-plan.width/2)/s+(b[0][0]+b[1][0])/2,(plan.height/2-p[1])/s+(b[0][1]+b[1][1])/2];}
function mouse(e){const r=canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
function at(e){const p=mouse(e);return imageToWorld([(p[0]-ox)/zoom,(p[1]-oy)/zoom]);}
function render(){
 if(!plan||!image.complete)return;
 const w=canvas.clientWidth,h=canvas.clientHeight,dpr=window.devicePixelRatio||1;
 if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.drawImage(image,ox,oy,plan.width*zoom,plan.height*zoom);
 const pts=state.outline.vertices.map(p=>screen(worldToImage(p)));
 if(pts.length){ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));if(mode!=='draw')ctx.closePath();ctx.strokeStyle=colors[state.outline.color];ctx.lineWidth=3;ctx.stroke();
 for(const p of pts){ctx.beginPath();ctx.arc(...p,5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=2;ctx.stroke();}}
 const modelScale=Math.min(plan.width/(plan.bounds[1][0]-plan.bounds[0][0]),plan.height/(plan.bounds[1][1]-plan.bounds[0][1]));
 state.notes.forEach((n,i)=>{const p=screen(worldToImage([n.x,n.y]));const font=n.height*modelScale*zoom;
 ctx.font=`${font}px Arial`;ctx.fillStyle='#ffffff';ctx.textBaseline='alphabetic';ctx.fillText(n.text,...p);
 if(i===selected){ctx.strokeStyle='#008575';ctx.lineWidth=1;ctx.setLineDash([4,3]);ctx.strokeRect(p[0]-4,p[1]-font-4,ctx.measureText(n.text).width+8,font+10);ctx.setLineDash([]);}});
}
function sync(){
 $('color').value=state.outline.color;$('finish').hidden=mode!=='draw';$('save').disabled=saving||mode==='draw';$('delete').disabled=selected<0;$('textLabel').textContent=selected>=0?'Selected note':'New note';
 const list=$('notes');list.replaceChildren();state.notes.forEach((n,i)=>{const b=document.createElement('button');b.textContent=n.text;b.className=i===selected?'selected':'';b.onclick=()=>choose(i);list.appendChild(b);});
 if(selected>=0){$('text').value=state.notes[selected].text;const v=state.notes[selected].height/plan.scale;$('size').value=[2,3,4].includes(v)?String(v):'3';}
 render();
}
function choose(i){selected=i;mode='select';sync();status('Edit the selected note or drag it to move.');}
function fit(){zoom=Math.min(canvas.clientWidth/plan.width,canvas.clientHeight/plan.height)*.95;ox=(canvas.clientWidth-plan.width*zoom)/2;oy=(canvas.clientHeight-plan.height*zoom)/2;render();}
function zoomToUnit(){const pts=state.outline.vertices.map(worldToImage);if(pts.length<3)return;const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);zoom=Math.min(canvas.clientWidth/(x1-x0+80),canvas.clientHeight/(y1-y0+80));ox=canvas.clientWidth/2-(x0+x1)/2*zoom;oy=canvas.clientHeight/2-(y0+y1)/2*zoom;render();}
function zoomAt(f,p=[canvas.clientWidth/2,canvas.clientHeight/2]){const z=Math.max(.1,Math.min(40,zoom*f));ox=p[0]-(p[0]-ox)*z/zoom;oy=p[1]-(p[1]-oy)*z/zoom;zoom=z;render();}
function noteHit(p){const s=Math.min(plan.width/(plan.bounds[1][0]-plan.bounds[0][0]),plan.height/(plan.bounds[1][1]-plan.bounds[0][1]));for(let i=state.notes.length-1;i>=0;i--){const n=state.notes[i],q=screen(worldToImage([n.x,n.y])),font=n.height*s*zoom;ctx.font=`${font}px Arial`;if(p[0]>=q[0]-6&&p[0]<=q[0]+ctx.measureText(n.text).width+6&&p[1]>=q[1]-font-6&&p[1]<=q[1]+8)return i;}return -1;}
canvas.addEventListener('pointerdown',e=>{
 if(!plan||saving)return;const p=mouse(e),q=at(e);canvas.setPointerCapture(e.pointerId);
 if(mode==='draw'){push();state.outline.vertices.push(q);sync();return;}
 if(mode==='text'){const text=$('text').value.trim();if(!text){status('Enter the text before placing it.',true);return;}push();state.notes.push({text,x:q[0],y:q[1],height:Number($('size').value)*plan.scale});selected=state.notes.length-1;mode='select';sync();status('Text placed. Drag it to adjust the position.');return;}
 const corner=state.outline.vertices.findIndex(v=>{const s=screen(worldToImage(v));return Math.hypot(s[0]-p[0],s[1]-p[1])<10;});
 if(corner>=0){push();drag={type:'corner',index:corner};selected=-1;}
 else{const n=noteHit(p);if(n>=0){push();choose(n);drag={type:'note',index:n,delta:[state.notes[n].x-q[0],state.notes[n].y-q[1]]};}else{selected=-1;drag={type:'pan',p,ox,oy};sync();}}
});
canvas.addEventListener('pointermove',e=>{if(!drag||saving)return;const q=at(e);if(drag.type==='corner')state.outline.vertices[drag.index]=q;else if(drag.type==='note'){state.notes[drag.index].x=q[0]+drag.delta[0];state.notes[drag.index].y=q[1]+drag.delta[1];}else{const p=mouse(e);ox=drag.ox+p[0]-drag.p[0];oy=drag.oy+p[1]-drag.p[1];}render();});
canvas.addEventListener('pointerup',()=>{drag=null;});canvas.addEventListener('pointercancel',()=>{drag=null;});
canvas.addEventListener('wheel',e=>{if(!plan||saving)return;e.preventDefault();zoomAt(Math.exp(-e.deltaY*.001),mouse(e));},{passive:false});
$('color').onchange=()=>{if(!state)return;push();state.outline.color=$('color').value;render();};
$('redraw').onclick=()=>{push();state.outline.vertices=[];mode='draw';selected=-1;sync();status(`Click around ${plan.unit || 'the unit'}, then choose Finish outline. Use Undo for a misplaced corner.`);};
$('finish').onclick=()=>{if(state.outline.vertices.length<3){status('Add at least three corners.',true);return;}mode='select';sync();status(`Outline ready. Keep it around ${plan.unit || 'the selected unit'} only.`);};
$('reset').onclick=()=>{push();state.outline=clone(initial.outline);mode='select';sync();};
$('newNote').onclick=()=>{if(mode==='draw'){status('Finish or restore the outline before adding text.',true);return;}selected=-1;mode='select';$('text').value='';sync();$('text').focus();status('Type a new note, then choose Place text on plan.');};
$('add').onclick=()=>{if(mode==='draw'){status('Finish or restore the outline before adding text.',true);return;}if(state.notes.length>=20){status('This plan already has 20 notes.',true);return;}selected=-1;mode='text';sync();status('Click on the plan to place the text.');};
$('delete').onclick=()=>{if(selected<0)return;push();state.notes.splice(selected,1);selected=-1;sync();};
$('text').onchange=()=>{if(selected<0)return;push();state.notes[selected].text=$('text').value.trim();sync();};
$('size').onchange=()=>{if(selected<0)return;push();state.notes[selected].height=Number($('size').value)*plan.scale;sync();};
$('undo').onclick=()=>{if(!history.length)return;const previous=history.pop();state=previous.state;mode=previous.mode;selected=-1;$('undo').disabled=!history.length;sync();status(mode==='draw'?'Continue choosing outline corners, then Finish outline.':'Previous edit restored.');};
$('fit').onclick=fit;$('unit').onclick=zoomToUnit;$('zoomIn').onclick=()=>zoomAt(1.25);$('zoomOut').onclick=()=>zoomAt(.8);
function post(message){window.parent.postMessage({channel:'jade-lease-editor',message},window.location.origin);}
window.addEventListener('message',event=>{if(event.origin!==window.location.origin||event.source!==window.parent)return;if(event.data?.type==='plan')window.loadPlan(event.data.value);if(event.data?.type==='error')window.saveFailed(event.data.value);});
$('cancel').onclick=()=>post({action:'cancel',dirty});
$('save').onclick=()=>{if(mode==='draw')return;setSaving(true);post({action:'save',reviewId:plan.reviewId,sourceSha256:plan.sourceSha256,outline:state.outline,notes:state.notes});};
function setSaving(value){saving=value;for(const e of document.querySelectorAll('button,input,select'))e.disabled=value;if(!value){$('undo').disabled=!history.length;sync();}status(value?'Saving a new review and checking the DWG…':'Ready to edit.');}
window.saveFailed=message=>{setSaving(false);status(message,true);};
window.loadPlan=data=>{plan=data;$('planTitle').textContent=`Edit your ${data.unit || ''} plan`;$('planSubtitle').textContent=`${data.project || ''} · New review copy`;$('unit').textContent=`Zoom to ${data.unit || 'unit'}`;state={outline:clone(data.outline),notes:clone(data.notes)};initial=clone(state);image.onload=()=>{$('loading').hidden=true;setSaving(false);zoomToUnit();};image.src='data:image/png;base64,'+data.image;};
new ResizeObserver(()=>render()).observe($('canvasWrap'));
for(const e of document.querySelectorAll('button,input,select'))e.disabled=true;
post({action:'ready'});
