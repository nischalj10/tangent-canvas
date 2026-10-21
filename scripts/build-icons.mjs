import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assets=path.join(root,'assets');
const mark=fs.readFileSync(path.join(assets,'logo-transparent.png')).toString('base64');

// Legacy macOS ICNS images need their own transparent margin and tile shape.
// Preserve the supplied mark; only its surrounding application-icon frame is new.
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#fcfaf5"/>
      <stop offset="1" stop-color="#f2eee5"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="7" stdDeviation="5" flood-color="#2b190f" flood-opacity=".15"/>
    </filter>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="184"/></clipPath>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="184" fill="url(#cream)" filter="url(#shadow)"/>
  <image x="100" y="100" width="824" height="824" href="data:image/png;base64,${mark}" clip-path="url(#tile)"/>
  <rect x="101" y="101" width="822" height="822" rx="183" fill="none" stroke="#ffffff" stroke-opacity=".65" stroke-width="2"/>
</svg>`;
fs.writeFileSync(path.join(assets,'icon.png'),new Resvg(svg).render().asPng());

const iconset=path.join(assets,'icon.iconset');
fs.mkdirSync(iconset,{recursive:true});
for(const points of [16,32,128,256,512]){
  for(const scale of [1,2]){
    const pixels=String(points*scale);
    execFileSync('/usr/bin/sips',['-z',pixels,pixels,path.join(assets,'icon.png'),'--out',path.join(iconset,`icon_${points}x${points}${scale===2?'@2x':''}.png`)],{stdio:'pipe'});
  }
}
execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(assets,'icon.icns')]);
console.log('Built the padded macOS application icon and all ICNS resolutions.');
