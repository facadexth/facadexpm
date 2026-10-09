// Forgot-password scenarios. Run: node scripts/tax-invoice-harness/buildLogin.mjs && node scripts/tax-invoice-harness/runLogin.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'login-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8').replace(/@import[^;]*;/g, '')
const ORIGIN = 'http://harness.local'
const browser = await chromium.launch()
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }

async function open(urlPath, auth = {}) {
  const page = await browser.newPage()
  page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
  await page.route('**/*', r => {
    const u = r.request().url()
    if (u.startsWith(ORIGIN)) return r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    return r.abort()
  })
  await page.goto(ORIGIN + urlPath)
  await page.evaluate(([a]) => { window.__auth = a; window.__calls = [] }, [auth])
  await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c; document.head.appendChild(st) }, css)
  await page.addScriptTag({ content: js })
  await page.evaluate(() => window.__render())
  await page.waitForTimeout(300)
  return page
}
const body = async p => (await p.locator('body').innerText()).replace(/\s+/g, ' ')
const calls = p => p.evaluate(() => window.__calls)

console.log('=== 1 login page has the link; clicking it opens the form; sending asks Supabase for the registered email')
let p = await open('/')
ok('"ลืมรหัสผ่าน?" link on the login page', (await p.getByText('ลืมรหัสผ่าน?').count()) === 1)
await p.getByText('ลืมรหัสผ่าน?').click()
ok('forgot form shown', /กรอกอีเมลที่ลงทะเบียนไว้/.test(await body(p)))
await p.locator('#forgot-email').fill('  user@example.com ')
await p.getByRole('button', { name: 'ส่งลิงก์ตั้งรหัสผ่านใหม่' }).click()
await p.waitForTimeout(300)
const c1 = await calls(p)
ok('resetPasswordForEmail(trimmed email, redirectTo origin)', JSON.stringify(c1[0]) === JSON.stringify(['resetPasswordForEmail', 'user@example.com', { redirectTo: ORIGIN }]), JSON.stringify(c1))
let b = await body(p)
ok('same-for-everyone success message with the email', /ถ้าอีเมล user@example\.com ลงทะเบียนไว้ เราได้ส่งลิงก์/.test(b), b)
ok('resend is locked for the cooldown', /ส่งอีกครั้งได้ใน (60|59) วินาที/.test(b), b)
ok('resend button disabled', await p.getByRole('button', { name: /ส่งอีกครั้งได้ใน/ }).isDisabled())
await p.close()

console.log('=== 2 an unknown address looks exactly like success')
p = await open('/', { reset: { code: 'user_not_found', message: 'User not found', status: 400 } })
await p.getByText('ลืมรหัสผ่าน?').click()
await p.locator('#forgot-email').fill('nobody@example.com')
await p.getByRole('button', { name: 'ส่งลิงก์ตั้งรหัสผ่านใหม่' }).click()
await p.waitForTimeout(300)
ok('still the generic success message', /ถ้าอีเมล nobody@example\.com ลงทะเบียนไว้/.test(await body(p)))
await p.close()

console.log('=== 3 rate limit is reported, no success screen')
p = await open('/', { reset: { code: 'over_email_send_rate_limit', message: 'email rate limit exceeded', status: 429 } })
await p.getByText('ลืมรหัสผ่าน?').click()
await p.locator('#forgot-email').fill('user@example.com')
await p.getByRole('button', { name: 'ส่งลิงก์ตั้งรหัสผ่านใหม่' }).click()
await p.waitForTimeout(300)
b = await body(p)
ok('rate-limit message shown and form kept', /ขอลิงก์บ่อยเกินไป/.test(b) && (await p.locator('#forgot-email').count()) === 1, b)
await p.close()

console.log('=== 4 back link returns to login')
p = await open('/')
await p.getByText('ลืมรหัสผ่าน?').click()
await p.getByText('← กลับไปเข้าสู่ระบบ').click()
ok('login form again', (await p.getByRole('button', { name: 'เข้าสู่ระบบ' }).count()) >= 1 && (await p.locator('#forgot-email').count()) === 0)
await p.close()

console.log('=== 5 expired link: straight to the request form with a message, address bar cleaned')
p = await open('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
b = await body(p)
ok('expired message + request form', /ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่/.test(b) && (await p.locator('#forgot-email').count()) === 1, b)
ok('hash removed from the address bar', (await p.evaluate(() => window.location.hash)) === '')
await p.close()

console.log('=== 6 new-password screen')
p = await open('/?screen=reset')
await p.locator('#rp-new').fill('abc')
await p.locator('#rp-confirm').fill('abc')
await p.getByRole('button', { name: 'บันทึกและเข้าสู่ระบบ' }).click()
ok('too short is refused, no request', /อย่างน้อย 6 ตัวอักษร/.test(await body(p)) && (await calls(p)).length === 0)
await p.locator('#rp-new').fill('abcdef')
await p.locator('#rp-confirm').fill('abcdeg')
await p.getByRole('button', { name: 'บันทึกและเข้าสู่ระบบ' }).click()
ok('mismatch is refused, no request', /ไม่ตรงกัน/.test(await body(p)) && (await calls(p)).length === 0)
await p.locator('#rp-confirm').fill('abcdef')
await p.getByRole('button', { name: 'บันทึกและเข้าสู่ระบบ' }).click()
await p.waitForTimeout(300)
ok('updateUser({password}) then done', JSON.stringify((await calls(p))[0]) === JSON.stringify(['updateUser', { password: 'abcdef' }]) && (await p.evaluate(() => window.__done)) === true, JSON.stringify(await calls(p)))
await p.close()

p = await open('/?screen=reset', { update: { message: 'New password should be different from the old password.' } })
await p.locator('#rp-new').fill('abcdef')
await p.locator('#rp-confirm').fill('abcdef')
await p.getByRole('button', { name: 'บันทึกและเข้าสู่ระบบ' }).click()
await p.waitForTimeout(300)
ok('server error shown, not done', /New password should be different/.test(await body(p)) && !(await p.evaluate(() => window.__done)))
await p.getByRole('button', { name: 'ยกเลิก' }).click()
await p.waitForTimeout(200)
ok('cancel signs the recovery session out and leaves', (await calls(p)).some(c => c[0] === 'signOut') && (await p.evaluate(() => window.__done)) === true)
await p.close()

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
await browser.close()
process.exit(fails ? 1 : 0)
