// Inline the CSS and JS from dist-single/ into one self-contained HTML page.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist-single';
const assets = readdirSync(join(dir, 'assets'));
const css = assets.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
const jsFiles = assets.filter((f) => f.endsWith('.js'));
if (jsFiles.length !== 1) throw new Error(`expected one JS bundle, found ${jsFiles.join(', ')}`);
const js = readFileSync(join(dir, 'assets', jsFiles[0]), 'utf8');
if (js.includes('</script')) throw new Error('bundle contains </script and cannot be inlined');
const html = `<title>Gridiron Prime</title>
<meta name="theme-color" content="#0b1220">
<style>${css}</style>
<div id="app"></div>
<script type="module">${js}</script>
`;
writeFileSync(join(dir, 'gridiron-prime.html'), html);
console.log(`wrote ${join(dir, 'gridiron-prime.html')} (${(html.length / 1024).toFixed(0)} KB)`);
