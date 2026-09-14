import { render } from 'preact'
import '@vscode/codicons/dist/codicon.css'
import './styles.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Session Deck: #root missing from the webview shell')
render(<App />, root)
