'use strict';

// Express app export for tests / tooling.

const { app, configureApp } = require('../server');

// Configure without DB connections so imports can exit cleanly.
configureApp({ skipDb: true });

module.exports = app;
