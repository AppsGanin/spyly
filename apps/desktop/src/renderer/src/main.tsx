// First of all: the language has to be set before any module with captions in
// constants runs.
import './lib/lang'
import { t } from '@spyly/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { StoreProvider } from './lib/store'
import { Overlay, OverlayDraft } from './screens/Overlay'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error(t('нет корневого элемента'))

// The floating panel is the same application in a separate window: there is no
// reason to give it its own recording state, the shared store already has it.
const route = window.location.hash
const isOverlay = route === '#overlay' || route === '#overlay-draft'
if (isOverlay) document.documentElement.classList.add('is-overlay')

const screen =
  route === '#overlay' ? <Overlay /> : route === '#overlay-draft' ? <OverlayDraft /> : <App />

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <StoreProvider>{screen}</StoreProvider>
    </ErrorBoundary>
  </StrictMode>
)
