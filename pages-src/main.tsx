import React from 'react';
import { createRoot } from 'react-dom/client';

import Analyzer from '../app/analyzer';
import IntensityAnalyzer from '../app/intensity-analyzer';
import EduAnalyzer from '../app/edu-analyzer';
import MigrationAnalyzer from '../app/migration-analyzer';
import Cck8Analyzer from '../app/cck8-analyzer';
import IfCountAnalyzer from '../app/if-count-analyzer';
import '../app/globals.css';
import Home from '../app/page';

const path = window.location.pathname.replace(/\/+$/, '');
const page = path.endsWith('/colocalization')
  ? <Analyzer mode="colocalization" />
  : path.endsWith('/scratch')
    ? <MigrationAnalyzer mode="scratch" />
  : path.endsWith('/transwell')
    ? <MigrationAnalyzer mode="transwell" />
  : path.endsWith('/edu')
    ? <EduAnalyzer />
  : path.endsWith('/intensity')
    ? <IntensityAnalyzer />
  : path.endsWith('/cck8')
    ? <Cck8Analyzer />
  : path.endsWith('/if-count')
    ? <IfCountAnalyzer />
    : <Home />;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{page}</React.StrictMode>,
);
