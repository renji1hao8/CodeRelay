import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
const sections=['CodeRelay Android — Third-party notices\n\nDependencies retain their own licenses.\n\n'+fs.readFileSync(path.join(root,'../LICENSE'),'utf8')];
for(const [relative,entry]of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))){
 if(!relative||entry.dev||!relative.includes('node_modules/'))continue;
 const directory=path.join(root,relative);if(!fs.existsSync(directory)){if(entry.optional)continue;throw Error('Install mobile dependency before generating notices: '+relative);}
 const pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json')));
 const files=fs.readdirSync(directory).filter(name=>/^(?:LICEN[CS]E|NOTICE|COPYING)(?:$|[._-])/i.test(name)&&fs.statSync(path.join(directory,name)).isFile());
 const texts=files.map(name=>`${name}\n${fs.readFileSync(path.join(directory,name),'utf8')}`);
 sections.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license||'See upstream package')}\n${texts.join('\n\n')||`Source: ${typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url||pkg.homepage||'https://www.npmjs.com/package/'+pkg.name}`}\n`);
}
fs.writeFileSync(path.join(root,'assets/third-party-notices.txt'),sections.join('\n'));
console.log('Generated Android third-party license notices');
