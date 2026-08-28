// Первым делом: язык должен быть задан до того, как выполнятся модули с
// подписями в константах.
import './lib/lang'
import { t } from '@spyly/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { StoreProvider } from './lib/store'
import { Overlay } from './screens/Overlay'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error(t('нет корневого элемента'))

// Плавающая панель — то же приложение в отдельном окне: своё состояние
// записи ей заводить незачем, оно уже есть в общем хранилище.
const isOverlay = window.location.hash === '#overlay'
if (isOverlay) document.documentElement.classList.add('is-overlay')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <StoreProvider>{isOverlay ? <Overlay /> : <App />}</StoreProvider>
    </ErrorBoundary>
  </StrictMode>
)
