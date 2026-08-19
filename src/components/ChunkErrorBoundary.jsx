// ============================================================
// ChunkErrorBoundary — recovers from a failed lazy-page chunk load
// (stale deployment: browser has an old index.html referencing JS
// filenames that no longer exist on the server after a new build).
// Catches the failure, remembers which tab the user was trying to
// reach, and does exactly one automatic reload to fetch the current
// build. A guard flag in sessionStorage prevents a reload loop if the
// reload doesn't actually fix it (e.g. a real network outage).
// ============================================================
import { Component } from 'react'

const RELOAD_GUARD_KEY = 'chunk-reload-attempted'
const PENDING_TAB_KEY = 'pendingTab'

// This message text is thrown by the browser's own JS engine for a
// failed dynamic import() -- NOT something Vite generates -- and its
// exact wording differs per browser. Covers Chrome/Edge ("Failed to
// fetch dynamically imported module"), Firefox ("error loading
// dynamically imported module"), and Safari/WebKit ("Importing a
// module script failed"). If a browser this app needs to support
// throws different wording, add it here.
const CHUNK_ERROR_PATTERN = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, isChunkLoadError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    const isChunkLoadError = CHUNK_ERROR_PATTERN.test(error?.message || '')
    return { hasError: true, isChunkLoadError, error }
  }

  componentDidCatch(error) {
    if (!this.state.isChunkLoadError) return // not a chunk-load failure -- let it surface as a real bug, don't reload-loop on unrelated errors

    const alreadyTried = sessionStorage.getItem(RELOAD_GUARD_KEY)
    if (alreadyTried) return // reload already happened once and didn't fix it -- stop here rather than loop forever

    sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    if (this.props.pendingTab) {
      sessionStorage.setItem(PENDING_TAB_KEY, this.props.pendingTab)
    }
    window.location.reload()
  }

  componentDidUpdate(prevProps) {
    // Once tripped, this boundary has no other way to recover -- render()
    // permanently returns null for the rest of the session otherwise, even
    // for tabs that have nothing to do with the failure (a persistent
    // failure on one tab would silently take down every tab, not just the
    // broken one). Navigating to a different tab is a real signal the user
    // wants a fresh attempt, so give the new tab's content an honest chance
    // to render instead of staying permanently blank.
    if (this.state.hasError && prevProps.pendingTab !== this.props.pendingTab) {
      this.setState({ hasError: false, isChunkLoadError: false, error: null })
    }
  }

  render() {
    if (this.state.hasError) {
      if (!this.state.isChunkLoadError) {
        throw this.state.error // re-throw non-chunk errors -- don't swallow real bugs
      }
      // Do NOT fall through to this.props.children here -- children is the
      // same Suspense/lazy tree that just failed. Rendering it again
      // immediately re-triggers the same rejected import, which throws
      // again before React ever completes a commit -- and componentDidCatch
      // (where the actual reload happens) only runs after a commit. Verified
      // live: without this, componentDidCatch never fires at all (confirmed
      // via an isolated Chromium+WebKit test against a real deleted chunk
      // file -- getDerivedStateFromError fired repeatedly, componentDidCatch
      // never did, no reload ever occurred).
      return null
    }
    return this.props.children
  }
}
