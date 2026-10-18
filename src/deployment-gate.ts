import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';

// The shared storage volume keeps the gate closed across a container replacement.
export function deploymentGate(storageDir: string) {
  let inFlight = 0;
  const blocked = () => existsSync(join(storageDir, '.deployment-blocked'));
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && req.path === '/health/deployment') {
      res.json({ blocked: blocked(), inFlight });
      return;
    }
    if (req.method !== 'POST' || !req.path.startsWith('/generation')) {
      next();
      return;
    }
    if (blocked()) {
      res.setHeader('Retry-After', '60');
      res.status(503).json({ message: 'A service update is in progress. Please try again shortly.' });
      return;
    }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('finish', release);
    // Track processing until the response finishes, even if the client disconnects.
    next();
  };
}
