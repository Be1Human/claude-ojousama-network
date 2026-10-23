import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
const petals=Array.from({length:12},(_,i)=>`<ellipse cx="512" cy="285" rx="58" ry="130" transform="rotate(${i*30} 512 512)" fill="#ffaf39"/>`).join('');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="225" fill="#fff2df"/>${petals}<circle cx="512" cy="512" r="159" fill="#613c28"/><path d="m440 467 57 45-57 45m83 0h66" fill="none" stroke="#fff5de" stroke-width="23" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
writeFileSync('assets/icon.svg',svg);await sharp(Buffer.from(svg)).png().toFile('assets/icon.png');
const tray='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="9" fill="none" stroke="black" stroke-width="3"/>'+Array.from({length:8},(_,i)=>`<path d="M20 2v5" stroke="black" stroke-width="3" stroke-linecap="round" transform="rotate(${i*45} 20 20)"/>`).join('')+'</svg>';
await sharp(Buffer.from(tray)).png().toFile('assets/trayTemplate.png');
