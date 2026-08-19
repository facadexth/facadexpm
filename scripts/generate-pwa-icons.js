#!/usr/bin/env node
// One-time PWA icon generator. Not run as part of `npm run build` --
// the source (an emoji on a solid color) never changes without a
// deliberate edit to this script, so the output PNGs are committed
// like any other static asset, not regenerated on every build.
const sharp = require('sharp')
const fs = require('fs')

const BG = '#1a1d2e' // --bg2, matches the header background and the
                      // splash-screen color the user chose

fs.mkdirSync('public/icons', { recursive: true })

function iconSvg(fontSize, textY) {
  return `
<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="${BG}"/>
  <text x="256" y="${textY}" font-size="${fontSize}" font-family="sans-serif" font-weight="800" fill="#ffffff" text-anchor="middle">FX</text>
</svg>
`
}

// Full-bleed: emoji fills most of the canvas, used for the plain
// (non-maskable) icons.
const FULL_BLEED_SVG = iconSvg(280, 330)

// Maskable: Android's adaptive-icon system can crop up to ~20% off each
// edge (a circle inscribed in the icon), so keep the emoji smaller and
// centered within that safe zone.
const MASKABLE_SVG = iconSvg(200, 300)

async function generate() {
  await sharp(Buffer.from(FULL_BLEED_SVG)).resize(192, 192).png().toFile('public/icons/icon-192.png')
  await sharp(Buffer.from(FULL_BLEED_SVG)).resize(512, 512).png().toFile('public/icons/icon-512.png')
  await sharp(Buffer.from(MASKABLE_SVG)).resize(512, 512).png().toFile('public/icons/icon-512-maskable.png')
  await sharp(Buffer.from(FULL_BLEED_SVG)).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png')
  console.log('Generated PWA icons in public/icons/')
}

generate().catch(err => { console.error(err); process.exit(1) })
