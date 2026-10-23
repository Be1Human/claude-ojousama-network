import { _electron as electron } from '@playwright/test';
import executablePath from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from '../src/core/store.js';
const application=await electron.launch({executablePath:process.env.OJOU_EXECUTABLE?path.resolve(process.env.OJOU_EXECUTABLE):executablePath,args:[...(process.env.OJOU_EXECUTABLE?[]:['.']),'--demo',...(process.env.CI?['--disable-gpu']:[])],timeout:60000});
const errors=[];
try{
  const page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  try { await page.waitForFunction(()=>document.getElementById('hero-ip')?.textContent==='203.0.113.42',{},{timeout:45000}); }
  catch(error) { mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/startup-failure.png',fullPage:true});console.error('Demo startup diagnostics:',await page.evaluate(()=>({runtime:document.getElementById('runtime')?.textContent,error:document.getElementById('error-banner')?.textContent,hero:document.getElementById('hero-ip')?.textContent})),errors);throw error; }
  const card=page.locator('#qualified-card'),duration=page.locator('#stable-duration');
  const status=()=>card.getAttribute('data-status');
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.ok(await page.locator('#demo-badge').isVisible());await noOverflow();
  assert.ok(await page.evaluate(()=>document.querySelector('.local-mark').getBoundingClientRect().bottom<=innerHeight),'sidebar footer must remain inside the viewport');
  assert.equal(await status(),'tracking');assert.match(await duration.textContent(),/^\d{2}:\d{2}:\d{2}$/);
  assert.equal(await page.locator('#hero-route').count(),0,'the main metric has one fixed exit');
  const firstDuration=await duration.textContent();await page.waitForFunction(previous=>document.getElementById('stable-duration').textContent!==previous,firstDuration,{timeout:2500});
  const screenshotDirectory=process.env.CI?'test-results':'docs/assets';mkdirSync(screenshotDirectory,{recursive:true});await page.screenshot({path:path.join(screenshotDirectory,'application-demo.png'),fullPage:true});
  await page.getByRole('button',{name:'隐藏 IP',exact:true}).click();assert.ok(!(await page.locator('#hero-ip').textContent()).includes('203.0.113'));
  await page.getByRole('button',{name:'显示 IP',exact:true}).click();
  await page.locator('[data-page="history"]').click();await page.waitForSelector('#history-rows tr td.code');
  await page.locator('#search').fill('203.0.113.42');await page.waitForTimeout(400);assert.ok((await page.locator('#history-rows').textContent()).includes('203.0.113.42'));
  assert.ok(!(await page.locator('#history-rows').textContent()).includes('保持稳定'));
  await page.locator('[data-page="paths"]').click();assert.equal(await page.locator('.path-grid .card').count(),5);
  assert.ok(!(await page.locator('.diagnostics').getAttribute('open')));
  await page.locator('.diagnostics summary').click();const since=await page.locator('#streak-since').textContent();await page.locator('#range').selectOption('1');
  await page.waitForFunction(()=>document.getElementById('chart').getAttribute('aria-label')?.includes('最近 1 小时'));
  assert.equal(await page.locator('#streak-since').textContent(),since,'chart range must not reset all-history clock');
  await page.locator('[data-page="settings"]').click();await page.locator('#interval').selectOption('60');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.getElementById('saved-status').textContent==='设置已保存');
  await page.locator('[data-page="overview"]').click();
  const demoDirectory=await application.evaluate(({app})=>app.getPath('userData'));
  const fixtureSource='stability-ui-fixture';
  const fixture=(geo,{status='ok',time=Date.now(),ip='203.0.113.86',family=4,route='cli/api',evidence='edge-trace'}={})=>({route,label:route==='cli/api'?'模型域名 · CLI 路径':'系统路由回显',family,ip,status,source:fixtureSource,evidence,geo,time});
  function writeFixtures(rows,{reset=true,cadence=30}={}){
    const store=new Store(path.join(demoDirectory,'network.sqlite3'));
    try{
      if(reset){store.db.prepare('DELETE FROM observations WHERE source=?').run(fixtureSource);store.db.prepare('DELETE FROM checks WHERE batch=?').run(fixtureSource);}
      for(const row of rows){store.record(row);if(row.route==='cli/api')store.check({time:row.time,batch:fixtureSource,route:'cli',target:'api',kind:'target',interval:cadence,ok:true});}
      return String(store.db.prepare("SELECT MAX(id) id FROM observations WHERE route='cli/api'").get().id);
    }finally{store.close();}
  }
  async function refreshFixture(id){
    await page.locator('#sample').click();
    await page.waitForFunction(expected=>document.getElementById('hero-ip').dataset.observationId===expected,id);
    await page.waitForFunction(()=>!document.getElementById('sample').disabled);
  }
  const expectStopped=async expected=>{assert.equal(await status(),expected);assert.equal(await duration.textContent(),'00:00:00');};
  try{
    const now=Date.now();await refreshFixture(writeFixtures([fixture({countryCode:'US'},{time:now-45000}),fixture({countryCode:'US'},{time:now})]));
    assert.equal(await status(),'tracking');assert.match(await duration.textContent(),/^00:00:4\d$/);
    const firstSince=await page.locator('#streak-since').textContent();
    await refreshFixture(writeFixtures([fixture({countryCode:'CA'})],{reset:false}));assert.equal(await page.locator('#streak-since').textContent(),firstSince,'eligible geography corrections preserve same-IP time');
    await refreshFixture(writeFixtures([fixture({countryCode:'US'},{ip:'203.0.113.87'})],{reset:false}));
    assert.match(await duration.textContent(),/^00:00:0\d$/);assert.match(await page.locator('#reset-reason').textContent(),/IP 改变/);assert.match(await page.locator('#previous-duration').textContent(),/^00:00:4\d$/);
    await refreshFixture(writeFixtures([fixture({countryCode:'US'},{ip:'2001:db8::87',family:6})],{reset:false}));assert.match(await page.locator('#reset-reason').textContent(),/IP 改变/);
    for(const region of ['CN','HK']){
      await refreshFixture(writeFixtures([fixture({countryCode:region})]));await expectStopped('excluded');assert.ok(await page.locator('#country-alert').isVisible());
      assert.ok(!(await page.locator('#hero-status').getAttribute('class')).includes('good'));
      assert.ok(!(await page.locator('#country-alert').textContent()).includes('203.0.113.86'));
      await noOverflow();
      await page.getByRole('button',{name:'隐藏 IP',exact:true}).click();assert.ok(!(await page.locator('#hero-ip').textContent()).includes('203.0.113'));assert.ok(await page.locator('#country-alert').isVisible());await page.getByRole('button',{name:'显示 IP',exact:true}).click();
      await page.locator('#toast').waitFor({state:'hidden',timeout:7000});await page.screenshot({path:path.join(screenshotDirectory,region==='CN'?'china-warning-demo.png':'hong-kong-warning-demo.png'),fullPage:true});
      await page.locator('[data-page="paths"]').click();assert.equal(await page.locator('#path-cards .china-path').count(),1);assert.ok(await page.locator(`#path-cards [data-country-warning="${region}"]`).isVisible());assert.ok(await page.locator('#comparison-alert').isVisible());
      await page.locator('[data-page="history"]').click();await page.locator('#search').fill('203.0.113.86');await page.waitForSelector(`#history-rows [data-country-warning="${region}"]`);assert.match(await page.locator('#history-rows .country-badge').first().textContent(),/当时/);
      await page.locator('[data-page="overview"]').click();
    }
    for(const geo of [{country:'China'},{country:'China',countryCode:' hk '},{country:'Hong Kong'},{country:'Hong Kong SAR, China'},{country:'香港'},{country:'中国香港'},{country:'中华人民共和国香港特别行政区'}]){
      await refreshFixture(writeFixtures([fixture(geo)]));await expectStopped('excluded');assert.ok(await page.locator('#country-alert').isVisible());
    }
    await refreshFixture(writeFixtures([fixture({})]));await expectStopped('unknown');assert.ok(await page.locator('#country-alert').isHidden());assert.ok(!(await page.locator('#hero-status').getAttribute('class')).includes('good'));
    for(const geo of [{country:'China',countryCode:'TW'},{country:'United States',countryCode:'US'}]){
      await refreshFixture(writeFixtures([fixture(geo)]));assert.equal(await status(),'tracking');assert.ok(await page.locator('#country-alert').isHidden());
    }
    await refreshFixture(writeFixtures([fixture({countryCode:'CN'},{status:'error'})]));await expectStopped('failed');assert.ok(await page.locator('#country-alert').isHidden());
    await refreshFixture(writeFixtures([fixture({countryCode:'US'})],{reset:false}));assert.equal(await status(),'tracking');assert.match(await duration.textContent(),/^00:00:0\d$/);assert.match(await page.locator('#reset-reason').textContent(),/恢复/);
    await refreshFixture(writeFixtures([fixture({countryCode:'HK'},{time:Date.now()-3600000})]));assert.ok(await page.locator('#country-alert').isHidden());assert.match(await page.locator('#hero-status').textContent(),/中国香港出口.*过期/);await expectStopped('excluded');
    const longNow=Date.now(),longRows=[];for(let t=longNow-25*3600000;t<longNow;t+=300000)longRows.push(fixture({countryCode:'US'},{time:t}));longRows.push(fixture({countryCode:'US'},{time:longNow}));
    await refreshFixture(writeFixtures(longRows,{cadence:300}));assert.match(await duration.textContent(),/^1天 01:00:0\d$/);
    const nativeNow=await page.evaluate(()=>Date.now());await page.evaluate(fake=>{window.ojouOriginalNow=Date.now;Date.now=()=>fake;},nativeNow+900000);
    await page.waitForFunction(()=>document.getElementById('qualified-card').dataset.status==='interrupted');assert.equal(await duration.textContent(),'00:00:00');
    await page.evaluate(()=>{Date.now=window.ojouOriginalNow;delete window.ojouOriginalNow;});
    await refreshFixture(writeFixtures([fixture({countryCode:'US'})]));
    await page.locator('#pause').click();await page.waitForFunction(()=>document.getElementById('qualified-card').dataset.status==='paused');assert.ok(await page.locator('#sample').isDisabled());await expectStopped('paused');
    await page.locator('#pause').click();await page.waitForFunction(()=>document.getElementById('pause').textContent.includes('暂停'));
    await refreshFixture(writeFixtures([fixture({countryCode:'US'})],{reset:false}));assert.equal(await status(),'tracking');assert.match(await duration.textContent(),/^00:00:0\d$/);
    const stableSince=await page.locator('#streak-since').textContent();
    const id=writeFixtures([fixture({countryCode:'HK'},{route:'system/echo',family:6,ip:'2001:db8::86'})],{reset:false});await refreshFixture(id);
    assert.equal(await status(),'tracking');assert.equal(await page.locator('#streak-since').textContent(),stableSince);assert.ok(await page.locator('#country-alert').isHidden());assert.ok(await page.locator('#comparison-note').isVisible());
    await page.locator('#comparison-note').click();assert.match(await page.locator('#comparison-alert').textContent(),/系统路由回显（IPv6）.*中国香港/);
    assert.ok(!(await page.locator('#comparison-alert').textContent()).includes('2001:db8'));
  }finally{
    const store=new Store(path.join(demoDirectory,'network.sqlite3'));
    try{store.db.prepare('DELETE FROM observations WHERE source=?').run(fixtureSource);store.db.prepare('DELETE FROM checks WHERE batch=?').run(fixtureSource);}finally{store.close();}
  }
  await page.locator('[data-page="overview"]').click();await page.locator('#sample').click();await page.waitForFunction(()=>document.getElementById('hero-ip').textContent==='203.0.113.42');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  await application.evaluate(({app})=>app.emit('activate'));assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
  assert.deepEqual(errors,[]);console.log('UI smoke passed: live non-CN/HK timer; fixed model scope; same-IP continuation; IPv4/IPv6 resets; CN/HK, unknown, failed and paused exclusions; multi-day clock and expiry; chart independence; comparison-only warnings; privacy/history/settings/tray. Screenshots use synthetic data.');
}finally{await application.close();}
