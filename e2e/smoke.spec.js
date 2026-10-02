import { test, expect } from '@playwright/test'

// Logged-out smoke test: the app shell boots and shows a login form
// without crashing. Never signs in, so it never touches tenant data.
test('app boots to the login screen without page errors', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await expect(page.locator('input[type="password"]')).toBeVisible()
  expect(errors).toEqual([])
})
