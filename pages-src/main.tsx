import React from 'react';
import { createRoot } from 'react-dom/client';

import Analyzer from '../app/analyzer';
import '../app/globals.css';
import Home from '../app/page';

const path = window.location.pathname.replace(/\/+$/, '');
const page = path.endsWith('/colocalization')
  ? <Analyzer mode="colocalization" />
  : path.endsWith('/intensity')
    ? <Analyzer mode="intensity" />
    : <Home />;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{page}</React.StrictMode>,
);
