'use strict';

// New architecture entrypoint.
// Delegates to the existing (now-exporting) root server module.

const { startServer } = require('../server');

startServer();
