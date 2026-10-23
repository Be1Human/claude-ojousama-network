import { _electron as electron } from '@playwright/test';
import executablePath from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
const application=await electron.launch({executablePath:process.env.OJOU_EXECUTABLE?path.resolve(process.env.OJOU_EXECUTABLE):executablePath,args:[...(process.env.OJOU_EXECUTABLE?[]:['.']),'--demo',...(process.env.CI?['--disable-gpu']:[])],timeout:60000});
const errors=[];
try{
  const page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.getElementById('hero-ip')?.textContent==='203.0.113.42',{},{timeout:30000});
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.ok(await page.locator('#demo-badge').isVisible());
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  const screenshotDirectory=process.env.CI?'test-results':'docs/assets';mkdirSync(screenshotDirectory,{recursive:true});await page.screenshot({path:path.join(screenshotDirectory,'application-demo.png'),fullPage:true});
  await page.getByRole('button',{name:'隐藏 IP',exact:true}).click();assert.ok(!(await page.locator('#hero-ip').textContent()).includes('203.0.113'));
  await page.getByRole('button',{name:'显示 IP',exact:true}).click();
  await page.locator('[data-page="history"]').click();await page.waitForSelector('#history-rows tr td.code');
  await page.locator('#search').fill('203.0.113.42');await page.waitForTimeout(400);assert.ok((await page.locator('#history-rows').textContent()).includes('203.0.113.42'));
  await page.locator('[data-page="paths"]').click();assert.equal(await page.locator('.path-grid .card').count(),5);
  await page.locator('[data-page="settings"]').click();await page.locator('#interval').selectOption('60');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.getElementById('saved-status').textContent==='设置已保存');
  await page.locator('[data-page="overview"]').click();await page.locator('#pause').click();await page.waitForFunction(()=>document.getElementById('pause').textContent.includes('继续'));
  await page.locator('#pause').click();await page.waitForFunction(()=>document.getElementById('pause').textContent.includes('暂停'));
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  await application.evaluate(({app})=>app.emit('activate'));assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
  assert.deepEqual(errors,[]);console.log('UI smoke passed: rendering, privacy, history, paths, settings, pause/resume, close-to-tray, restore. Demo-only screenshot saved.');
}finally{await application.close();}
