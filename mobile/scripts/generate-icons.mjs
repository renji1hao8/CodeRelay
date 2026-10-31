// Original geometric artwork, rendered deterministically from shapes.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Jimp=require('jimp-compact');
const root=path.resolve(import.meta.dirname,'..'),assets=path.join(root,'assets');
const bg=0x121416ff,accent=0xb9cbdfff,screen=0x283441ff;
function rounded(x,y,left,top,width,height,radius){const cx=Math.max(left+radius,Math.min(left+width-radius,x)),cy=Math.max(top+radius,Math.min(top+height-radius,y));return x>=left&&x<=left+width&&y>=top&&y<=top+height&&(x-cx)**2+(y-cy)**2<=radius**2;}
function line(x,y,ax,ay,bx,by,width){const t=Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));return (x-ax-t*(bx-ax))**2+(y-ay-t*(by-ay))**2<width**2/4;}
function render(background,mono=false){const image=new Jimp(1024,1024,background);image.scan(0,0,1024,1024,function(x,y,idx){let color=background;if(rounded(x,y,344,224,336,576,56))color=mono?0xffffffff:accent;if(rounded(x,y,368,248,288,528,32))color=mono?0x00000000:screen;if(line(x,y,416,424,480,480,26)||line(x,y,480,480,416,536,26)||line(x,y,528,536,592,536,26)||(x-512)**2+(y-744)**2<10**2)color=mono?0xffffffff:accent;this.bitmap.data.writeUInt32BE(color>>>0,idx);});return image;}
fs.mkdirSync(assets,{recursive:true});
const icon=render(bg),foreground=render(0x00000000);
await icon.writeAsync(path.join(assets,'icon.png'));await icon.clone().resize(64,64).writeAsync(path.join(assets,'favicon.png'));
await foreground.writeAsync(path.join(assets,'android-icon-foreground.png'));await foreground.clone().writeAsync(path.join(assets,'splash-icon.png'));
await render(0x00000000,true).writeAsync(path.join(assets,'android-icon-monochrome.png'));await new Jimp(1024,1024,bg).writeAsync(path.join(assets,'android-icon-background.png'));
fs.writeFileSync(path.join(assets,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="180" fill="#121416"/><rect x="356" y="236" width="312" height="552" rx="44" fill="#283441" stroke="#b9cbdf" stroke-width="24"/><path d="m416 424 64 56-64 56m112 0h64" fill="none" stroke="#b9cbdf" stroke-width="26" stroke-linecap="round"/><circle cx="512" cy="744" r="10" fill="#b9cbdf"/></svg>\n');
console.log('Generated original RemoteCC icons.');
