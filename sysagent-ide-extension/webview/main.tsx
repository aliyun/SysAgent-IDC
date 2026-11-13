import './ide-shim';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DesktopDemo from '../../sysagent-idc/src/DesktopDemo';
import '../../sysagent-idc/src/styles/fonts.css';
import '../../sysagent-idc/src/styles/app.css';
import '../../sysagent-idc/src/styles/electron.css';
import './ide.css';

document.documentElement.classList.add('native-main', 'sysom-ide');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopDemo />
  </StrictMode>,
);
