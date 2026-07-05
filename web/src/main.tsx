import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/reset.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import App from './App';
import { bootstrapAuth } from './api/authFetch';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

const root = createRoot(container);

// Fetch the local auth token and install the authorized-fetch wrapper before
// rendering, so the app's first API calls are already authenticated.
void bootstrapAuth().finally(() => {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
