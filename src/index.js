import { createServer } from 'node:http';
import app from './server.js';
import { attachTrackingGateway } from './ws/gateway.js';
import { isAllowedOrigin } from './utils/origins.js';

const server = createServer(app);

attachTrackingGateway(server, {
  allowedOrigin: isAllowedOrigin,
});

export default server;