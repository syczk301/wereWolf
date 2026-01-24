/**
 * Vercel deploy entry handler
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Server } from 'socket.io';
import app from './app.js';
import { initSocket } from './socket.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // @ts-ignore
  if (!res.socket.server.io) {
    console.log('*First use* Starting Socket.IO');
    // @ts-ignore
    const httpServer = res.socket.server;
    const io = new Server(httpServer, {
      path: '/socket.io',
      addTrailingSlash: false,
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      },
      transports: ['polling', 'websocket'] // Vercel might struggle with WS upgrades
    });

    await initSocket(io);

    // @ts-ignore
    res.socket.server.io = io;
  } else {
    // console.log('Socket.IO already running');
  }

  // Handle Socket.IO requests
  if (req.url && req.url.startsWith('/socket.io')) {
    // @ts-ignore
    res.socket.server.io.engine.handleRequest(req, res);
    return;
  }

  // Handle API requests
  return app(req, res);
}