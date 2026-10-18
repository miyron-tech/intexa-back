import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import pg from 'pg';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
const jwt=new JwtService({secret:process.env.JWT_ACCESS_SECRET});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});
try {
  const {rows}=await db.query("SELECT id,role FROM users ORDER BY role ASC,created_at ASC");
  const admin=rows.find(u=>u.role==='admin');
  const user=rows.find(u=>u.role==='user')??admin;
  assert(user && admin,'Existing admin/user accounts required for read-only UI checks');
  const ctx=await browser.newContext({viewport:{width:1365,height:960}});
  const token=id=>jwt.sign({sub:id,sid:randomUUID()},{expiresIn:600});
  await ctx.addCookies([{name:'access_token',value:token(user.id),domain:'localhost',path:'/'}]);
  const page=await ctx.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const path of ['/dashboard/video_ad','/dashboard/product_shot','/dashboard','/']) {
    const response=await page.goto(`http://localhost:3100${path}`,{waitUntil:'networkidle'});
    assert.equal(response.status(),200,path);
    const text=await page.locator('body').innerText();
    assert(!/OpenRouter|Gemini|Deepseek|Veo\s*3|wan-3|Provider cost|USD|\$\d/i.test(text),`Private pricing/model leaked on ${path}`);
    if(path==='/dashboard/video_ad') {
      assert(text.includes('credits / second'));
      await page.getByText('Premium',{exact:true}).click();
      assert.equal(await page.locator('input[name="expectedCredits"]').inputValue(),'100');
      await page.locator('#duration').selectOption('8');
      assert.equal(await page.locator('input[name="expectedCredits"]').inputValue(),'200');
      await page.screenshot({path:'/tmp/aigenerate-credits-desktop.png',fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:'/tmp/aigenerate-credits-mobile.png',fullPage:true});
      await page.setViewportSize({width:1365,height:960});
    }
    if(path==='/dashboard/product_shot') {
      await page.locator('#count').selectOption('4');
      assert.equal(await page.locator('input[name="expectedCredits"]').inputValue(),'40');
    }
  }
  await ctx.addCookies([{name:'access_token',value:token(admin.id),domain:'localhost',path:'/'}]);
  for(const path of ['/admin','/admin/economics',`/admin/users/${user.id}`]) {
    const response=await page.goto(`http://localhost:3100${path}`,{waitUntil:'networkidle'});
    assert.equal(response.status(),200,path);
    assert(/gross profit/i.test(await page.locator('body').innerText()),path);
    await page.screenshot({path:`/tmp/aigenerate-${path==='/admin/economics'?'economics':path==='/admin'?'admin':'user-economics'}.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Mobile overflow ${path}`);
    await page.setViewportSize({width:1365,height:960});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: user pages hide models/USD, video/image quotes update, admin economics render, mobile widths fit, no browser errors. No generations submitted.');
} finally { await browser.close(); await db.end(); }
