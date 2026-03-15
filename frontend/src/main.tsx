import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Apply the persisted theme to <html> before React mounts so there is no
// white-background flash when the user has chosen dark mode.
const savedTheme = localStorage.getItem('exam_theme')
if (savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
