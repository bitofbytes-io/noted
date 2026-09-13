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
function cleanupStrength(p){return p.paperCleanupStrength ?? (p.paperCleanup?1:0);}
function isPlain(p){return !p.angle&&!p.rotation&&(!p.scale||p.scale===1)&&!p.x&&!p.y&&!p.crop?.length&&!p.corners?.length&&!p.outputWidth&&!cleanupStrength(p)&&!p.fitEdges&&!p.margins?.some(Boolean);}
// EXIF is bounded to its APP1 segment. Malformed metadata falls back to the
// browser's decoded/oriented pixels; it is never guessed from image dimensions.
function jpegOrientation(bytes) {
  const v=new DataView(bytes);if(v.byteLength<4||v.getUint16(0)!==0xffd8)return undefined;
  let p=2;
  while(p+4<=v.byteLength){
    if(v.getUint8(p)!==0xff)return undefined;
    const marker=v.getUint8(p+1);if(marker===0xda||marker===0xd9)return 1;
    const length=v.getUint16(p+2),end=p+2+length;
    if(length<2||end>v.byteLength)return undefined;
    if(marker===0xe1&&length>=8&&v.getUint32(p+4)===0x45786966&&v.getUint16(p+8)===0){
      if(length<16)return undefined; // signature plus the complete eight-byte TIFF header
      const t=p+10,order=v.getUint16(t),little=order===0x4949;
      if(!little&&order!==0x4d4d)return undefined;
      if(v.getUint16(t+2,little)!==42)return undefined;
      const ifd=t+v.getUint32(t+4,little);if(ifd<t||ifd+2>end)return undefined;
      const count=v.getUint16(ifd,little);if(count>1024||ifd+2+count*12>end)return undefined;
      for(let n=0;n<count;n++){const q=ifd+2+n*12;if(v.getUint16(q,little)!==0x112)continue;
        if(v.getUint16(q+2,little)!==3||v.getUint32(q+4,little)!==1)return undefined;
        const orientation=v.getUint16(q+8,little);return orientation>=1&&orientation<=8?orientation:undefined;
      }
      return 1;
    }
    p=end;
  }
  return undefined;
}
async function jpegPDF(bytes,orientation) {
  const doc=await PDFLib.PDFDocument.create(),img=await doc.embedJpg(bytes),w=img.width,h=img.height;
  if(w*h>20000000)throw Error('Photo exceeds 20 megapixels.');
  const swapped=orientation>=5,dw=swapped?h:w,dh=swapped?w:h,s=600/dw;
  const matrices={1:[1,0,0,1,0,0],2:[-1,0,0,1,w,0],3:[-1,0,0,-1,w,h],4:[1,0,0,-1,0,h],5:[0,-1,-1,0,h,w],6:[0,-1,1,0,0,w],7:[0,1,1,0,0,0],8:[0,1,-1,0,h,0]};
  const page=doc.addPage([dw*s,dh*s]);
  page.pushOperators(PDFLib.pushGraphicsState(),PDFLib.concatTransformationMatrix(...matrices[orientation].map(n=>n*s)));
  page.drawImage(img,{x:0,y:0,width:w,height:h});page.pushOperators(PDFLib.popGraphicsState());
  await doc.flush();return doc;
}
async function lightenPaper(canvas,strength) {
  await openCV();
  const cv=self.cv,width=canvas.width,height=canvas.height,ratio=Math.min(1,720/width,960/height);
  const smallCanvas=new OffscreenCanvas(Math.max(1,Math.round(width*ratio)),Math.max(1,Math.round(height*ratio)));
  smallCanvas.getContext('2d').drawImage(canvas,0,0,smallCanvas.width,smallCanvas.height);
  const src=cv.matFromImageData(smallCanvas.getContext('2d').getImageData(0,0,smallCanvas.width,smallCanvas.height));
  const dilated=new cv.Mat(),blurred=new cv.Mat(),background=new cv.Mat(),kernel=cv.Mat.ones(31,31,cv.CV_8U);
  try {
    // Estimate only broad paper illumination. Never threshold or erase marks.
    cv.dilate(src,dilated,kernel);
    cv.GaussianBlur(dilated,blurred,new cv.Size(0,0),9,9,cv.BORDER_REPLICATE);
    cv.resize(blurred,background,new cv.Size(width,height),0,0,cv.INTER_CUBIC);
    const context=canvas.getContext('2d'),pixels=context.getImageData(0,0,width,height);
    for(let n=0;n<pixels.data.length;n+=4)for(let c=0;c<3;c++){const original=pixels.data[n+c],corrected=Math.min(255,original*255/Math.max(80,background.data[n+c]));pixels.data[n+c]=Math.round(original+(corrected-original)*strength);}
    context.putImageData(pixels,0,0);
  } finally {[src,dilated,blurred,background,kernel].forEach(m=>m.delete());smallCanvas.width=smallCanvas.height=1;}
}
async function photoPDF(bytes,edit) {
  const orientation=jpegOrientation(bytes),strength=cleanupStrength(edit);
  if(orientation&&!edit.corners?.length&&!strength)return jpegPDF(bytes,orientation);
  const bitmap=await createImageBitmap(new Blob([bytes]));
  if(bitmap.width*bitmap.height>20000000){bitmap.close();throw Error('Photo exceeds 20 megapixels.');}
  let width=bitmap.width,height=bitmap.height;const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d');if(strength||edit.fitEdges){context.fillStyle='white';context.fillRect(0,0,width,height);}context.drawImage(bitmap,0,0);bitmap.close();
  if(strength)await lightenPaper(canvas,strength);
  if(edit.corners?.length){
    await openCV();const cv=self.cv,src=cv.matFromImageData(context.getImageData(0,0,width,height)),dst=new cv.Mat();
    let targetWidth=width,targetHeight=height;
    if(edit.fitEdges){
      const points=edit.corners.map(([x,y])=>[x*(width-1),y*(height-1)]),distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
      targetWidth=Math.max(2,Math.round((distance(points[0],points[1])+distance(points[3],points[2]))/2));
      targetHeight=Math.max(2,Math.round((distance(points[0],points[3])+distance(points[1],points[2]))/2));
      if(targetWidth*targetHeight>20000000){const ratio=Math.sqrt(20000000/(targetWidth*targetHeight));targetWidth=Math.max(2,Math.floor(targetWidth*ratio));targetHeight=Math.max(2,Math.floor(targetHeight*ratio));}
    }
    const a=cv.matFromArray(4,1,cv.CV_32FC2,edit.corners.flatMap(([x,y])=>[x*(width-1),y*(height-1)])),b=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,targetWidth-1,0,targetWidth-1,targetHeight-1,0,targetHeight-1]),matrix=cv.getPerspectiveTransform(a,b);
    try{cv.warpPerspective(src,dst,matrix,new cv.Size(targetWidth,targetHeight),cv.INTER_CUBIC,cv.BORDER_CONSTANT,new cv.Scalar(255,255,255,255));canvas.width=width=targetWidth;canvas.height=height=targetHeight;context.putImageData(new ImageData(new Uint8ClampedArray(dst.data),width,height),0,0);}finally{[src,dst,a,b,matrix].forEach(m=>m.delete());}
  }
  const encodeJPEG=strength>0 || (edit.fitEdges && edit.corners?.length);
  const blob=await canvas.convertToBlob({type:encodeJPEG?'image/jpeg':'image/png',quality:.96});canvas.width=canvas.height=1;
  const doc=await PDFLib.PDFDocument.create(),img=encodeJPEG?await doc.embedJpg(await blob.arrayBuffer()):await doc.embedPng(await blob.arrayBuffer());const w=600,h=600*height/width;doc.addPage([w,h]).drawImage(img,{x:0,y:0,width:w,height:h});await doc.flush();return doc;
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
  const task=pdfjs.getDocument({data:new Uint8Array(bytes.slice(0)),wasmUrl:'/pdfjs/wasm/',CanvasFactory,disableFontFace:true});
  try {
    const doc=await task.promise,page=await doc.getPage(pageIndex+1),base=page.getViewport({scale:1});
    const viewport=page.getViewport({scale:Math.min(2,2000/Math.max(base.width,base.height))});
    const canvas=new OffscreenCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;
    return {canvas,width:base.width,height:base.height};
  } finally {await task.destroy();}
}
async function checkInk(bytes,index,edges,transform,outputWidth,outputHeight) {
  const rendered=await renderPDF(bytes,index),c=rendered.canvas;
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
  const out=await PDFLib.PDFDocument.create(),pdfSources=new Map(),remaining=new Map();
  for(const p of manifest.pages)remaining.set(p.sourceId,(remaining.get(p.sourceId)||0)+1);
  for(let i=0;i<manifest.pages.length;i++){
    const edit=manifest.pages[i],asset=sourceMap.get(edit.sourceId);if(!asset)throw Error('Unknown source.');
    if(cleanupStrength(edit)&&asset.mime==='application/pdf')throw Error('Lighten paper is available for photos only.');
    self.postMessage({progress:`Preparing page ${i+1} of ${manifest.pages.length}`});
    let source=pdfSources.get(asset.id);
    if(!source){const bytes=await read(asset.id);source={bytes,doc:asset.mime==='application/pdf'?await PDFLib.PDFDocument.load(bytes,{updateMetadata:false}):await photoPDF(bytes,edit)};if(asset.mime==='application/pdf')pdfSources.set(asset.id,source);}
    const {doc}=source,original=doc.getPage(asset.mime==='application/pdf'?edit.page:0);
    remaining.set(asset.id,remaining.get(asset.id)-1);
    if(!remaining.get(asset.id))pdfSources.delete(asset.id); // release after this page

    const geometry=edit.margins?.some(Boolean)||edit.fitEdges||edit.angle||edit.x||edit.y||(edit.scale&&edit.scale!==1)||edit.crop?.length||edit.outputWidth;
    if(!geometry){const [copy]=await out.copyPages(doc,[asset.mime==='application/pdf'?edit.page:0]);copy.setRotation(PDFLib.degrees((copy.getRotation().angle+(edit.rotation||0))%360));out.addPage(copy);continue;}
    const media=original.getMediaBox(),crop=original.getCropBox();
    if(original.getRotation().angle%360||media.x||media.y||['x','y','width','height'].some(k=>crop[k]!==media[k]))throw Error('This PDF already has a page rotation or crop. Reorder, extract and quarter-turn rotation are supported; fine adjustments need a normalized source PDF.');
    const edges=edit.crop||[0,0,1,1],w=media.width,h=media.height;
    const embed=await out.embedPage(original,{left:edges[0]*w,bottom:(1-edges[3])*h,right:edges[2]*w,top:(1-edges[1])*h});
    const width=embed.width,height=embed.height,scale=edit.fitEdges?1:(edit.scale||1),angle=(edit.angle||0)+(edit.rotation||0),r=angle*Math.PI/180;
    const quarter=(edit.rotation||0)%180!==0;
    const baseWidth=edit.fitEdges?Math.abs(width*Math.cos(r))+Math.abs(height*Math.sin(r)):(edit.outputWidth||(quarter?height:width)),baseHeight=edit.fitEdges?Math.abs(width*Math.sin(r))+Math.abs(height*Math.cos(r)):(edit.outputHeight||(quarter?width:height));
    const [mt,mr,mb,ml]=edit.margins||[0,0,0,0],outputWidth=baseWidth+ml+mr,outputHeight=baseHeight+mt+mb;
    const cx=width/2,cy=height/2,dx=(edit.fitEdges?0:(edit.x||0))*baseWidth,dy=-(edit.fitEdges?0:(edit.y||0))*baseHeight;
    const transform=(x,y)=>[ml+baseWidth/2+dx+scale*((x-cx)*Math.cos(r)-(y-cy)*Math.sin(r)),mb+baseHeight/2+dy+scale*((x-cx)*Math.sin(r)+(y-cy)*Math.cos(r))];
    if(!edit.fitEdges)await checkInk(asset.mime==='application/pdf'?source.bytes:await doc.save(),asset.mime==='application/pdf'?edit.page:0,edges,transform,outputWidth,outputHeight);
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
