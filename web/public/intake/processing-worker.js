/* Heavy score processing runs here; terminate the worker to cancel at any point. */
importScripts('/intake/pdf-lib.min.js');
let cvReady;
function openCV() {
  if (!cvReady) cvReady = new Promise((resolve, reject) => {
    try {
      importScripts('/intake/opencv.js');
      if (self.cv.Mat) resolve();
      else self.cv.onRuntimeInitialized = () => resolve();
    } catch (error) { reject(error); }
  });
  return cvReady;
}
function analyze(image) {
  const cv=self.cv,src=cv.matFromImageData(image),gray=new cv.Mat(),edges=new cv.Mat(),lines=new cv.Mat();
  try {
    cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);cv.Canny(gray,edges,60,160);
    cv.HoughLinesP(edges,lines,1,Math.PI/3600,80,image.width*.3,12);
    const candidates=[];
    for(let i=0;i<lines.rows;i++){const [x1,y1,x2,y2]=lines.data32S.slice(i*4,i*4+4),angle=Math.atan2(y2-y1,x2-x1)*180/Math.PI;if(Math.abs(angle)<=10)candidates.push({x1,y1,x2,y2,angle});}
    if(candidates.length<10)return {confident:false,reason:'No consistent staff lines found. Adjust this page manually.'};
    candidates.sort((a,b)=>a.angle-b.angle);const angle=candidates[Math.floor(candidates.length/2)].angle,agree=candidates.filter(l=>Math.abs(l.angle-angle)<.3);
    if(agree.length<candidates.length*.8)return {confident:false,reason:'The page has mixed angles. Adjust it manually.'};
    // Hough determines the angle, but can omit an outer staff line. Measure all
    // dense staff rows in deskewed coordinates, excluding sparse title/footer text.
    const radians=angle*Math.PI/180,cos=Math.cos(radians),sin=Math.sin(radians),rows=new Uint32Array(image.height+image.width*2);
    const row=(x,y)=>Math.round(y*cos-x*sin)+image.width;
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)if(gray.data[y*image.width+x]<200)rows[row(x,y)]++;
    let left=image.width,top=image.height,right=0,bottom=0;
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
      if(gray.data[y*image.width+x]>=200)continue;
      const n=row(x,y);
      if(rows[n-1]+rows[n]+rows[n+1]<image.width*.25)continue;
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    if(right<=left||bottom<=top)return {confident:false,reason:'Staff boundaries were unclear. Adjust this page manually.'};
    return {confident:true,angle,bounds:[left/image.width,top/image.height,right/image.width,bottom/image.height]};
  } finally {[src,gray,edges,lines].forEach(m=>m.delete());}
}
function isPlain(p){return !p.angle&&!p.rotation&&(!p.scale||p.scale===1)&&!p.x&&!p.y&&!p.crop?.length&&!p.corners?.length&&!p.outputWidth;}
async function photoPDF(bytes,edit) {
  const bitmap=await createImageBitmap(new Blob([bytes]));
  if(bitmap.width*bitmap.height>20000000){bitmap.close();throw Error('Photo exceeds 20 megapixels.');}
  const width=bitmap.width,height=bitmap.height,canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
  if(edit.corners?.length){
    await openCV();const cv=self.cv,src=cv.matFromImageData(context.getImageData(0,0,width,height)),dst=new cv.Mat();
    const a=cv.matFromArray(4,1,cv.CV_32FC2,edit.corners.flatMap(([x,y])=>[x*(width-1),y*(height-1)])),b=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,width-1,0,width-1,height-1,0,height-1]),matrix=cv.getPerspectiveTransform(a,b);
    try{cv.warpPerspective(src,dst,matrix,new cv.Size(width,height),cv.INTER_CUBIC,cv.BORDER_CONSTANT,new cv.Scalar(255,255,255,255));context.putImageData(new ImageData(new Uint8ClampedArray(dst.data),width,height),0,0);}finally{[src,dst,a,b,matrix].forEach(m=>m.delete());}
  }
  const blob=await canvas.convertToBlob({type:'image/png'});canvas.width=canvas.height=1;
  const doc=await PDFLib.PDFDocument.create(),img=await doc.embedPng(await blob.arrayBuffer());const w=600,h=600*height/width;doc.addPage([w,h]).drawImage(img,{x:0,y:0,width:w,height:h});return doc;
}
// Render the exact same PDF used by preview/export. Coordinates stay in PDF points.
async function renderPDF(bytes, pageIndex = 0) {
  const pdfjs = await import('/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  class CanvasFactory {
    create(width,height) { const canvas=new OffscreenCanvas(width,height);return {canvas,context:canvas.getContext('2d')}; }
    reset(target,width,height) {target.canvas.width=width;target.canvas.height=height;}
    destroy(target) {target.canvas.width=target.canvas.height=1;target.canvas=null;target.context=null;}
  }
  const task=pdfjs.getDocument({data:new Uint8Array(bytes),wasmUrl:'/pdfjs/wasm/',CanvasFactory,disableFontFace:true});
  try {
    const doc=await task.promise,page=await doc.getPage(pageIndex+1),base=page.getViewport({scale:1});
    const viewport=page.getViewport({scale:Math.min(2,2000/Math.max(base.width,base.height))});
    const canvas=new OffscreenCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;
    return {canvas,width:base.width,height:base.height};
  } finally {await task.destroy();}
}
async function checkInk(doc,index,edges,transform,outputWidth,outputHeight) {
  const rendered=await renderPDF(await doc.save(),index),c=rendered.canvas;
  try {
    const {data}=c.getContext('2d').getImageData(0,0,c.width,c.height);
    const w=rendered.width,h=rendered.height;
    for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++) {
      const n=(y*c.width+x)*4;
      if(data[n+3]<128 || Math.min(data[n],data[n+1],data[n+2])>200)continue;
      const u=(x+.5)/c.width,v=(y+.5)/c.height;
      // Explicit crop removes only pixels outside the chosen rectangle.
      if(u<edges[0]||u>edges[2]||v<edges[1]||v>edges[3])continue;
      const [px,py]=transform((u-edges[0])*w,(edges[3]-v)*h);
      if(px < -.75 || py < -.75 || px > outputWidth+.75 || py > outputHeight+.75)
        throw Error('This adjustment would cut off page content. Reduce scale or position, or explicitly crop the unwanted content first.');
    }
  } finally {c.width=c.height=1;}
}
async function build(draftId,sources,manifest) {
  const sourceMap=new Map(sources.map(a=>[a.id,a]));
  async function read(id){const response=await fetch(`/api/imports/${draftId}/sources/${id}`,{credentials:'same-origin'});if(!response.ok)throw Error('Source could not be loaded. Reload the draft.');return response.arrayBuffer();}
  if(!manifest.pages.length)throw Error('Choose at least one page.');
  const first=sourceMap.get(manifest.pages[0].sourceId);
  if(first.mime==='application/pdf'&&manifest.pages.length===first.pageCount&&manifest.pages.every((p,i)=>p.sourceId===first.id&&p.page===i&&isPlain(p))){return read(first.id);}
  const out=await PDFLib.PDFDocument.create();
  for(let i=0;i<manifest.pages.length;i++){
    const edit=manifest.pages[i],asset=sourceMap.get(edit.sourceId);if(!asset)throw Error('Unknown source.');
    self.postMessage({progress:`Preparing page ${i+1} of ${manifest.pages.length}`});
    const bytes=await read(asset.id),doc=asset.mime==='application/pdf'?await PDFLib.PDFDocument.load(bytes,{updateMetadata:false}):await photoPDF(bytes,edit),original=doc.getPage(asset.mime==='application/pdf'?edit.page:0);
    const geometry=edit.angle||edit.x||edit.y||(edit.scale&&edit.scale!==1)||edit.crop?.length||edit.outputWidth;
    if(!geometry){const [copy]=await out.copyPages(doc,[asset.mime==='application/pdf'?edit.page:0]);copy.setRotation(PDFLib.degrees((copy.getRotation().angle+(edit.rotation||0))%360));out.addPage(copy);continue;}
    const media=original.getMediaBox(),crop=original.getCropBox();
    if(original.getRotation().angle%360||media.x||media.y||['x','y','width','height'].some(k=>crop[k]!==media[k]))throw Error('This PDF already has a page rotation or crop. Reorder, extract and quarter-turn rotation are supported; fine adjustments need a normalized source PDF.');
    const edges=edit.crop||[0,0,1,1],w=media.width,h=media.height;
    const embed=await out.embedPage(original,{left:edges[0]*w,bottom:(1-edges[3])*h,right:edges[2]*w,top:(1-edges[1])*h});
    const width=embed.width,height=embed.height,scale=edit.scale||1,angle=(edit.angle||0)+(edit.rotation||0),r=angle*Math.PI/180;
    const quarter=(edit.rotation||0)%180!==0;
    const outputWidth=edit.outputWidth||(quarter?height:width),outputHeight=edit.outputHeight||(quarter?width:height);
    const cx=width/2,cy=height/2,dx=(edit.x||0)*outputWidth,dy=-(edit.y||0)*outputHeight;
    const transform=(x,y)=>[outputWidth/2+dx+scale*((x-cx)*Math.cos(r)-(y-cy)*Math.sin(r)),outputHeight/2+dy+scale*((x-cx)*Math.sin(r)+(y-cy)*Math.cos(r))];
    await checkInk(doc,asset.mime==='application/pdf'?edit.page:0,edges,transform,outputWidth,outputHeight);
    const origin=transform(0,0);
    out.addPage([outputWidth,outputHeight]).drawPage(embed,{x:origin[0],y:origin[1],xScale:scale,yScale:scale,rotate:PDFLib.degrees(angle)});
  }
  return (await out.save()).buffer;
}
async function measure(draftId,sources,edit) {
  const rendered=await renderPDF(await build(draftId,sources,{version:1,pages:[edit]}));
  try {
    await openCV();
    const c=rendered.canvas,result=analyze(c.getContext('2d').getImageData(0,0,c.width,c.height));
    if(!result.confident)throw Error(result.reason);
    return {...result,width:rendered.width,height:rendered.height};
  } finally {rendered.canvas.width=rendered.canvas.height=1;}
}
async function matchPages(data) {
  const reference=await measure(data.draftId,data.sources,data.reference),pages=[];
  for(const target of data.targets) {
    const edit={...target};
    // Correct residual skew in the adjusted page before measuring physical alignment.
    let m=await measure(data.draftId,data.sources,edit);
    edit.angle=(edit.angle||0)+m.angle-reference.angle;
    m=await measure(data.draftId,data.sources,edit);
    const scale=(reference.bounds[2]-reference.bounds[0])*reference.width/((m.bounds[2]-m.bounds[0])*m.width);
    const oldScale=edit.scale||1;
    const centerX=(m.bounds[0]-.5-(edit.x||0))*m.width;
    const centerY=(m.bounds[1]-.5-(edit.y||0))*m.height;
    edit.scale=oldScale*scale;
    if(edit.scale>3||edit.scale<=0)throw Error('Matching requires a scale outside the supported range. Adjust this page manually.');
    edit.outputWidth=reference.width;edit.outputHeight=reference.height;
    edit.x=reference.bounds[0]-.5-centerX*scale/reference.width;
    edit.y=reference.bounds[1]-.5-centerY*scale/reference.height;
    await build(data.draftId,data.sources,{version:1,pages:[edit]}); // Same clipping guard as export.
    pages.push(edit);
  }
  return pages;
}
self.onmessage=async({data})=>{
  try {
    if(data.kind==='match'){self.postMessage({result:await matchPages(data)});return;}
    if(data.kind==='analyze'){await openCV();self.postMessage({result:analyze(data.image)});return;}
    const bytes=await build(data.draftId,data.sources,data.manifest);self.postMessage({bytes},[bytes]);
  } catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};
