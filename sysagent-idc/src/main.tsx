import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DesktopDemo, { FloatingMascot } from './DesktopDemo';
import { configureGpu } from './health-api';
import { detectGpu } from './gpu-presence';
import './styles/fonts.css';
import './styles/app.css';
import './styles/electron.css';

const floating = window.sysomDesktop?.isFloating === true;
if (!floating) configureGpu(detectGpu());
if (window.sysomDesktop?.isElectron) {
  document.documentElement.classList.add(floating ? 'native-floating' : 'native-main');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {floating ? <FloatingMascot /> : <DesktopDemo />}
  </StrictMode>,
);
