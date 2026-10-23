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
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.ok(await page.locator('#demo-badge').isVisible());
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  assert.ok(await page.evaluate(()=>document.querySelector('.local-mark').getBoundingClientRect().bottom<=innerHeight),'sidebar footer must remain inside the viewport');
  const screenshotDirectory=process.env.CI?'test-results':'docs/assets';mkdirSync(screenshotDirectory,{recursive:true});await page.screenshot({path:path.join(screenshotDirectory,'application-demo.png'),fullPage:true});
  await page.getByRole('button',{name:'隐藏 IP',exact:true}).click();assert.ok(!(await page.locator('#hero-ip').textContent()).includes('203.0.113'));
  await page.getByRole('button',{name:'显示 IP',exact:true}).click();
  await page.locator('[data-page="history"]').click();await page.waitForSelector('#history-rows tr td.code');
  await page.locator('#search').fill('203.0.113.42');await page.waitForTimeout(400);assert.ok((await page.locator('#history-rows').textContent()).includes('203.0.113.42'));
  await page.locator('[data-page="paths"]').click();assert.equal(await page.locator('.path-grid .card').count(),5);
  await page.locator('[data-page="settings"]').click();await page.locator('#interval').selectOption('60');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.getElementById('saved-status').textContent==='设置已保存');
  await page.locator('[data-page="overview"]').click();await page.locator('#pause').click();await page.waitForFunction(()=>document.getElementById('pause').textContent.includes('继续'));
  await page.locator('#pause').click();await page.waitForFunction(()=>document.getElementById('pause').textContent.includes('暂停'));
  const demoDirectory=await application.evaluate(({app})=>app.getPath('userData'));
  const fixtureSource='china-warning-ui-fixture';
  function writeCountryFixture(geo,{status='ok',time=Date.now()}={}){
    const store=new Store(path.join(demoDirectory,'network.sqlite3'));
    try{
      store.db.prepare('DELETE FROM observations WHERE source=?').run(fixtureSource);
      store.record({route:'cli/api',label:'模型域名 · CLI 路径',family:4,ip:'203.0.113.86',status,source:fixtureSource,evidence:'edge-trace',geo,time});
    }finally{store.close();}
    return time;
  }
  async function refreshFixture(time){
    await page.locator('#sample').click();
    await page.waitForFunction(expected=>latest('cli/api')?.source==='china-warning-ui-fixture'&&latest('cli/api')?.time===expected,time);
  }
  try{
    const chinaTime=writeCountryFixture({country:'China',countryCode:'CN',city:'演示城市',source:'合成测试'});
    await refreshFixture(chinaTime);
    assert.ok(await page.locator('#country-alert').isVisible());
    assert.match(await page.locator('#country-alert').textContent(),/模型域名.*IPv4/);
    assert.ok(!(await page.locator('#country-alert').textContent()).includes('203.0.113.86'));
    assert.match(await page.locator('#hero-status').textContent(),/中国出口.*演示数据/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'隐藏 IP',exact:true}).click();
    assert.ok(!(await page.locator('#hero-ip').textContent()).includes('203.0.113'));
    assert.ok(await page.locator('#country-alert').isVisible());
    await page.getByRole('button',{name:'显示 IP',exact:true}).click();
    await page.locator('#toast').waitFor({state:'hidden',timeout:7000});
    await page.screenshot({path:path.join(screenshotDirectory,'china-warning-demo.png'),fullPage:true});
    await page.locator('#hero-route').selectOption('cli/auth');
    assert.ok(!(await page.locator('#hero-status').textContent()).includes('中国'));
    assert.ok(await page.locator('#country-alert').isVisible());
    await page.locator('#hero-route').selectOption('cli/api');
    await page.locator('[data-page="paths"]').click();
    assert.equal(await page.locator('#path-cards .china-path').count(),1);
    assert.ok(await page.locator('#path-cards [data-country-warning="CN"]').isVisible());
    await page.locator('[data-page="history"]').click();await page.locator('#search').fill('203.0.113.86');
    await page.waitForSelector('#history-rows .china-row [data-country-warning="CN"]');
    assert.match(await page.locator('#history-rows .country-badge').first().textContent(),/当时/);
    await page.locator('[data-page="overview"]').click();
    for(const geo of [{country:'China',countryCode:'TW'},{},{country:'United States',countryCode:'US'}]){
      await refreshFixture(writeCountryFixture(geo));
      assert.ok(await page.locator('#country-alert').isHidden());
      assert.ok(!(await page.locator('#hero-status').textContent()).includes('中国'));
    }
    await refreshFixture(writeCountryFixture({country:'China'}));
    assert.ok(await page.locator('#country-alert').isVisible());
    await refreshFixture(writeCountryFixture({country:'Hong Kong',countryCode:'HK',city:'演示城市',source:'合成测试'}));
    assert.match(await page.locator('#country-alert').textContent(),/中国香港（HK）/);
    assert.match(await page.locator('#hero-status').textContent(),/中国香港出口.*演示数据/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#toast').waitFor({state:'hidden',timeout:7000});
    await page.screenshot({path:path.join(screenshotDirectory,'hong-kong-warning-demo.png'),fullPage:true});
    await page.locator('[data-page="paths"]').click();
    assert.match(await page.locator('#path-cards [data-country-warning="HK"]').textContent(),/中国香港出口/);
    await page.locator('[data-page="history"]').click();await page.locator('#search').fill('203.0.113.86');
    await page.waitForSelector('#history-rows [data-country-warning="HK"]');
    assert.match(await page.locator('#history-rows [data-country-warning="HK"]').first().textContent(),/当时为中国香港出口/);
    await page.locator('[data-page="overview"]').click();
    for(const geo of [{country:'China',countryCode:' hk '},{country:'Hong Kong'},{country:'Hong Kong SAR, China'},{country:'香港'},{country:'中国香港'},{country:'中华人民共和国香港特别行政区'}]){
      await refreshFixture(writeCountryFixture(geo));
      assert.ok(await page.locator('#country-alert').isVisible());
      assert.match(await page.locator('#hero-status').textContent(),/中国香港出口/);
    }
    await refreshFixture(writeCountryFixture({countryCode:'HK'},{time:Date.now()-3600000}));
    assert.ok(await page.locator('#country-alert').isHidden());
    assert.match(await page.locator('#hero-status').textContent(),/中国香港出口.*过期/);
    await refreshFixture(writeCountryFixture({countryCode:'HK'},{status:'error'}));
    assert.ok(await page.locator('#country-alert').isHidden());
    assert.ok(!(await page.locator('#hero-status').textContent()).includes('中国'));
    await refreshFixture(writeCountryFixture({country:'中国',countryCode:'CN'},{time:Date.now()-3600000}));
    assert.ok(await page.locator('#country-alert').isHidden());
    assert.match(await page.locator('#hero-status').textContent(),/中国出口.*过期/);
    await refreshFixture(writeCountryFixture({countryCode:'CN'},{status:'error'}));
    assert.ok(await page.locator('#country-alert').isHidden());
    assert.ok(!(await page.locator('#hero-status').textContent()).includes('中国'));
    const ipv6Store=new Store(path.join(demoDirectory,'network.sqlite3'));
    try{
      ipv6Store.db.prepare('DELETE FROM observations WHERE source=?').run(fixtureSource);
      ipv6Store.record({route:'system/echo',label:'系统路由回显',family:6,ip:'2001:db8::86',status:'ok',source:fixtureSource,geo:{countryCode:'HK'}});
    }finally{ipv6Store.close();}
    await page.locator('#sample').click();
    await page.waitForFunction(()=>document.getElementById('country-alert').textContent.includes('系统路由回显（IPv6）'));
    assert.ok(await page.locator('#country-alert').isVisible());
    assert.match(await page.locator('#country-alert').textContent(),/中国香港（HK）/);
    assert.ok(!(await page.locator('#hero-status').textContent()).includes('中国'));
  }finally{
    const store=new Store(path.join(demoDirectory,'network.sqlite3'));
    try{store.db.prepare('DELETE FROM observations WHERE source=?').run(fixtureSource);}finally{store.close();}
  }
  await page.locator('#sample').click();await page.waitForFunction(()=>document.getElementById('hero-ip').textContent==='203.0.113.42');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  await application.evaluate(({app})=>app.emit('activate'));assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
  assert.deepEqual(errors,[]);console.log('UI smoke passed: rendering, privacy, history, paths, settings, pause/resume, close-to-tray, restore, CN/HK warnings and names, other-region/unknown/error exclusions, IPv6 and stale labels. Demo-only screenshots saved.');
}finally{await application.close();}
