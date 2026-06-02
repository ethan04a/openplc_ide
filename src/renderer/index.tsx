import '@utils/i18n'

import { bridge, initWebBridge } from '@root/platform'
import { createRoot } from 'react-dom/client'

import App from './App'

initWebBridge()
window.bridge = bridge

/**
 * Retrieves the root element with the id 'root' from the document.
 *
 * @returns The root element as an HTMLElement.
 */
const container = document.getElementById('root') as HTMLElement
const root = createRoot(container)
root.render(<App />)

postMessage({ payload: 'removeLoading' }, '*')
