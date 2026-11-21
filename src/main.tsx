import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Membership } from './components/Membership'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><Membership /></StrictMode>)
