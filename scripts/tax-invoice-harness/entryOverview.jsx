import React from 'react'
import { createRoot } from 'react-dom/client'
import SiteOverviewContent from 'SRC/components/SiteOverviewContent.jsx'
window.__render = () => { createRoot(document.getElementById('root')).render(<div style={{ maxWidth: 640, padding: 16 }}><SiteOverviewContent siteId="S" /></div>) }
