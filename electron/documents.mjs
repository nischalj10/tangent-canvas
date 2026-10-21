import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

function decodeBase64(text){
  if(typeof text!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(text)||text.length%4===1)throw Error('Invalid image data');
  const bytes=Buffer.from(text,'base64');if(bytes.toString('base64').replace(/=+$/,'')!==text.replace(/=+$/,''))throw Error('Invalid image data');return bytes;
}

export const DOCUMENT_TOOL={type:'function',name:'canvas_document',description:'Create, read, list, or update a real editable document on the user’s current Tangent canvas. Use for explicitly requested local Markdown documents, reports, or local content/images. For a rich ChatGPT Page, use the connected ChatGPT Pages tools and canvas_page to attach it to the canvas. Markdown is rendered with inline images. Image-generation savedPath values or managed tangent-asset:// URLs can be embedded with Markdown images. To update, read the document first and send its expectedRevision; stale edits are rejected. Other chats are not visible through this tool. Do not create a document unless asked.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['create','read','update','list']},documentId:{type:'string'},title:{type:'string'},markdown:{type:'string'},expectedRevision:{type:'integer'}},required:['action'],additionalProperties:false}};
export const assetPattern=/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
export class DocumentAssets{
  constructor(directory){this.directory=path.join(directory,'assets');fs.mkdirSync(this.directory,{recursive:true,mode:0o700})}
  importImage(input){
    let bytes;
    if(Buffer.isBuffer(input))bytes=input;
    else if(typeof input==='string'&&input.startsWith('data:image/')){
      if(!/^data:image\/(png|jpeg|webp|gif);base64,/.test(input))throw Error('Unsupported image format');
      bytes=decodeBase64(input.slice(input.indexOf(',')+1));
    }else{
      const file=String(input).startsWith('file:')?fileURLToPath(input):String(input);
      if(!path.isAbsolute(file))throw Error('Image paths must be absolute');
      const stat=fs.statSync(file);if(!stat.isFile()||stat.size>24*1024*1024)throw Error('Choose an image smaller than 24 MB');
      bytes=fs.readFileSync(file);
    }
    if(bytes.length>24*1024*1024)throw Error('Choose an image smaller than 24 MB');
    const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216?'jpg':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':/^GIF8[79]a/.test(bytes.subarray(0,6).toString())?'gif':null;
    if(!ext)throw Error('Use a PNG, JPEG, WebP, or GIF image');
    if(ext==='png'){
      if(bytes.length<45||bytes.subarray(12,16).toString()!=='IHDR')throw Error('The PNG image is incomplete');
      const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
      if(!width||!height||width*height>32_000_000||width>16384||height>16384)throw Error('The image dimensions are too large');
      try{PNG.sync.read(bytes,{checkCRC:true})}catch{throw Error('The PNG image could not be read')}
    }
    if(ext==='jpg'&&(bytes.length<20||bytes.at(-2)!==255||bytes.at(-1)!==217))throw Error('The JPEG image is incomplete');
    if(ext==='webp'&&(bytes.length<30||bytes.readUInt32LE(4)+8!==bytes.length))throw Error('The WebP image is incomplete');
    if(ext==='gif'&&(bytes.length<14||bytes.at(-1)!==59||!bytes.readUInt16LE(6)||!bytes.readUInt16LE(8)))throw Error('The GIF image is incomplete');
    const assetId=`${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const file=path.join(this.directory,assetId);
    let good=false;try{good=fs.lstatSync(file).isFile()&&createHash('sha256').update(fs.readFileSync(file)).digest('hex')===assetId.slice(0,64)}catch{}
    if(!good){const temp=`${file}.tmp-${process.pid}-${Date.now()}`;try{fs.writeFileSync(temp,bytes,{mode:0o600});const fd=fs.openSync(temp,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,file)}catch(error){try{fs.rmSync(temp,{force:true})}catch{}throw error}}
    return{id:assetId,url:`tangent-asset://${assetId}`,bytes:bytes.length,mime:ext==='jpg'?'image/jpeg':`image/${ext}`};
  }
  path(assetId){if(!assetPattern.test(assetId))throw Error('Invalid image');return path.join(this.directory,assetId)}
  normalizeMarkdown(markdown,projectPath){
    if(typeof markdown!=='string'||markdown.length>2_000_000)throw Error('Document content is too large');
    return markdown.replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)/g,(original,alt,angle,raw)=>{
      let source=angle||raw;
      if(source.startsWith('tangent-asset://')){
        const assetId=source.slice('tangent-asset://'.length);this.path(assetId);if(!fs.existsSync(this.path(assetId)))throw Error('That image is no longer available');return original;
      }
      if(/^https?:/i.test(source))throw Error('Attach a local image or use the saved path from image generation. Remote images are not copied automatically.');
      try{if(!source.startsWith('data:')&&!source.startsWith('file:')){source=decodeURIComponent(source);if(!path.isAbsolute(source)){if(!projectPath)throw Error('Choose a project folder for relative image paths');source=path.resolve(projectPath,source)}}
        const asset=this.importImage(source);return`![${alt}](${asset.url})`;
      }catch(error){throw Error(`Could not attach image “${alt||'image'}”: ${error.message}`)}
    });
  }
  fromGeneration(item){
    const savedPath=item.savedPath?.startsWith('file:')?fileURLToPath(item.savedPath):item.savedPath;
    if(savedPath&&fs.existsSync(savedPath))return this.importImage(savedPath);
    if(!item.result)return null;
    if(item.result.startsWith('data:image/'))return this.importImage(item.result);
    if(item.result.startsWith('file:'))return this.importImage(item.result);
    if(path.isAbsolute(item.result)&&fs.existsSync(item.result))return this.importImage(item.result);
    return this.importImage(decodeBase64(item.result));
  }
}
