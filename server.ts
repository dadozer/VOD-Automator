import express from "express";
import http from "http";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import dotenv from "dotenv";

import { state, loadState, addLog, flushStateSync, PROJECT_ROOT } from "./src/services/state";
import { checkStreamStatus, startMonitoring, checkOrphanedSession } from "./src/services/download";
import { abortAllFfmpegProcesses } from "./src/services/video";
import { abortAllChatProcesses } from "./src/services/chat";
import { setupRoutes } from "./src/routes/api";

dotenv.config();

process.on('uncaughtException', (err: any) => {
  console.error('[CRASH GUARD] Fatal uncaught exception:', err);
  try {
    addLog(`[CRASH GUARD] Fatal uncaught exception: ${err?.stack || err?.message || err}`);
  } catch {}
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[CRASH GUARD] Unhandled promise rejection:', reason);
  try {
    addLog(`[CRASH GUARD] Unhandled promise rejection: ${reason?.stack || reason?.message || reason}`);
  } catch {}
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCK_FILE = path.join(PROJECT_ROOT, "app.lock");

function acquireSingleInstanceLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const rawPid = fs.readFileSync(LOCK_FILE, "utf8").trim();
      const existingPid = parseInt(rawPid, 10);
      if (!isNaN(existingPid) && existingPid > 0 && existingPid !== process.pid) {
        let isAlive = false;
        try {
          process.kill(existingPid, 0);
          isAlive = true;
        } catch (killErr: any) {
          if (killErr && killErr.code === "EPERM") {
            isAlive = true;
          }
        }

        if (isAlive) {
          const msg = `[Startup Aborted] Another instance of VOD Automator (PID ${existingPid}) is already running (lock: ${LOCK_FILE}). Exiting to prevent split-brain execution.`;
          console.error(msg);
          try {
            addLog(msg);
          } catch {}
          return false;
        } else {
          try {
            addLog(`[Lock] Overwriting stale app.lock from inactive PID ${existingPid} with current PID ${process.pid}.`);
          } catch {}
        }
      }
    }

    const tmpLock = `${LOCK_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpLock, String(process.pid), "utf8");
    fs.renameSync(tmpLock, LOCK_FILE);
    return true;
  } catch (err: any) {
    console.error(`[Lock Warning] Failed to write lock file ${LOCK_FILE}:`, err?.message || err);
    return true;
  }
}

function releaseSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const rawPid = fs.readFileSync(LOCK_FILE, "utf8").trim();
      if (rawPid === String(process.pid)) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {}
}

async function startServer() {
  if (!acquireSingleInstanceLock()) {
    process.exit(1);
    return;
  }

  process.on("exit", () => {
    releaseSingleInstanceLock();
  });

  const app = express();
  const PORT = 3000;

  const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ];

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like same-origin or curl requests)
      // or from known local development ports
      // or from the container's deployed domain (.run.app)
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.run.app')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  }));
  app.use(express.json());

  // Setup API Routes
  setupRoutes(app);

  const server = http.createServer(app);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(PROJECT_ROOT, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);

    loadState((savedSession: any) => {
      checkOrphanedSession(savedSession).catch((err: any) => {
        addLog(`[Recovery] Unhandled error during orphaned session recovery: ${err.message}`);
      });
    });

    if (state.config.autoStartMonitoring && state.config.channels && state.config.channels.length > 0) {
      state.monitoredChannels = Array.from(state.config.channels);
      addLog(`Auto-starting monitoring for channels: ${state.monitoredChannels.join(', ')}`);
      state.config.isMonitoring = true;
      startMonitoring();
    }
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server Error] Port ${PORT} is already in use.`);
      addLog(`[Server Error] Port ${PORT} is already in use by another process.`);
      releaseSingleInstanceLock();
      process.exit(1);
    } else {
      console.error('[Server Error]', err);
      addLog(`[Server Error] ${err?.message || err}`);
    }
  });

  let isShuttingDown = false;
  const handleShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Shutdown] Received ${signal}. Reaping child processes and flushing state...`);
    try {
      addLog(`[Shutdown] Received ${signal}. Reaping child processes and flushing state...`);
    } catch {}

    try {
      abortAllFfmpegProcesses();
    } catch (e) {}

    try {
      abortAllChatProcesses();
    } catch (e) {}

    try {
      flushStateSync();
    } catch (e) {}

    releaseSingleInstanceLock();

    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(0);
    }, 2500).unref();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('message', (msg) => {
    if (msg === 'shutdown') {
      handleShutdown('Windows Service Shutdown');
    }
  });
}

startServer();
