#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// Get git info
let commit = 'unknown'
let branch = 'unknown'
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim()
  branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
} catch (e) {
  console.warn('Git info not available')
}

// Get timestamp
const timestamp = new Date().toISOString()
const buildNumber = Math.floor(Date.now() / 1000)

// Create build info
const buildInfo = {
  buildNumber,
  timestamp,
  commit,
  branch,
  version: `${commit}-${buildNumber}`,
  builtAt: timestamp
}

// Write to dist folder
const distPath = path.join(__dirname, '../dist')
if (!fs.existsSync(distPath)) fs.mkdirSync(distPath, { recursive: true })

const filePath = path.join(distPath, 'build-info.json')
fs.writeFileSync(filePath, JSON.stringify(buildInfo, null, 2))

console.log('✅ Build info generated:')
console.log(`   Commit: ${commit}`)
console.log(`   Branch: ${branch}`)
console.log(`   Build: ${buildNumber}`)
console.log(`   Version: ${buildInfo.version}`)
