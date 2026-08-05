import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { z } from 'zod';
import dotenv from 'dotenv';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const COBALT_API_URL = process.env.COBALT_API_URL || 'http://cobalt:9000/';

// --- CORS Configuration ---
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:4321', 'https://mp4yt.com'];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like curl/mobile apps) or if it's in the allowed list
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};

// --- Security & Middleware ---
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());

// --- Structured Logging ---
app.use(pinoHttp({
  autoLogging: {
    ignore: (req) => {
      // Don't log health checks or spammy tunnel streams to save I/O overhead
      return req.url === '/health' || req.url.startsWith('/tunnel');
    }
  }
})); 

// --- Rate Limiting ---
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // Default: 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10), // Default: 100 requests per window
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// --- Validation Schemas ---
const extractSchema = z.object({
  url: z.string().url(),
  quality: z.string().optional().default('1080'),
  mode: z.string().optional().default('auto'), // 'auto' (video+audio) or 'audio'
});

// --- Health Check Endpoint ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// For Cobalt redirects or tunnels, we should intercept and rewrite the URL 
// in the /api/extract response so the frontend hits our /tunnel.
app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function(data) {
    if (data && data.url && typeof data.url === 'string' && data.url.includes('/tunnel?')) {
      // Rewrite tunnel URL to point to our API gateway
      const publicUrl = process.env.PUBLIC_API_URL || `http://localhost:${PORT}`;
      const urlObj = new URL(data.url);
      data.url = `${publicUrl}${urlObj.pathname}${urlObj.search}`;
    }
    return originalJson.call(this, data);
  };
  next();
});

// --- API Gateway Endpoint to Cobalt ---
app.post('/api/extract', async (req, res) => {
  try {
    // 1. Input Validation
    const parseResult = extractSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid input', details: parseResult.error.issues });
    }

    const { url, quality, mode } = parseResult.data;

    // 2. Prepare Cobalt Request
    const cobaltBody = {
      url: url,
      downloadMode: mode,
      youtubeVideoCodec: "h264",
    };

    if (mode === 'audio') {
      cobaltBody.audioFormat = quality === 'best' ? 'mp3' : quality;
    } else {
      cobaltBody.videoQuality = quality === 'best' ? 'max' : quality;
    }

    // 3. Make request to internal Cobalt with timeout & retries
    // We are keeping it simple here. Axios handles timeout.
    const response = await axios.post(COBALT_API_URL, cobaltBody, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 15000, // 15 second timeout
    });

    // 4. Normalize response
    const data = response.data;
    if (data.status === 'error') {
      throw new Error(data.error?.code || 'Cobalt processing error');
    }

    // Since we are proxying, we rewrite tunnel URLs to go through our backend if needed.
    // However, Cobalt tunnel URLs are typically requested directly by the client.
    // If Cobalt is exposed only internally, we MUST proxy the tunnel too.
    // But since the user wants the API Gateway to hide Cobalt, we should proxy the tunnel.
    // Let's pass the Cobalt response directly for now. We will    // ... (Tunnel proxy response rewriting handled below)
    
    res.json(data);

  } catch (error) {
    req.log.error({ err: error }, 'Extraction error');
    if (error.response) {
      // The request was made and the server responded with a status code
      return res.status(error.response.status).json({ error: 'Failed to process video.' });
    }
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request to extraction server timed out.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- Tunnel Proxy (to hide Cobalt completely) ---
// If Cobalt returns a tunnel URL (e.g. http://cobalt:9000/tunnel?id=...), 
// we proxy it through this endpoint.
app.get('/tunnel', async (req, res) => {
  // Prevent Node HTTP server from timing out on long streams
  req.setTimeout(0);
  res.setTimeout(0);
  
  const abortController = new AbortController();

  req.on('aborted', () => {
    req.log.info('Client aborted download');
    abortController.abort();
  });

  req.on('close', () => {
    req.log.info('Client connection closed');
    abortController.abort();
  });

  try {
    const tunnelUrl = `${COBALT_API_URL}tunnel${req.url.replace('/tunnel', '')}`;
    
    // Forward Range header for video seeking and browser compatibility
    const proxyHeaders = {};
    if (req.headers.range) proxyHeaders['range'] = req.headers.range;
    if (req.headers['user-agent']) proxyHeaders['user-agent'] = req.headers['user-agent'];
    if (req.headers.accept) proxyHeaders['accept'] = req.headers.accept;

    const response = await fetch(tunnelUrl, {
      method: 'GET',
      headers: proxyHeaders,
      signal: abortController.signal
    });
    
    if (!response.ok && response.status !== 206 && response.status !== 200) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    // Forward headers safely, ignoring hop-by-hop and duplicate CORS headers
    const ignoreHeaders = ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding'];
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!ignoreHeaders.includes(lowerKey) && !lowerKey.startsWith('access-control-')) {
        res.setHeader(key, value);
      }
    });
    
    // Override Helmet's restrictive CORP header — the frontend on a different port
    // needs to be able to consume this stream via fetch()
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    // Ensure Access-Control-Allow-Origin is set for the requesting frontend
    // (the global CORS middleware may not apply to piped streams correctly)
    const requestOrigin = req.headers.origin;
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    } else if (!requestOrigin) {
      // No origin means direct navigation/curl — allow it
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Estimated-Content-Length');
    
    // Forward the HTTP status code (crucial for 206 Partial Content / Range requests)
    res.status(response.status);
    
    if (!response.body) {
      return res.end();
    }

    // Pipe the stream safely
    const nodeStream = Readable.fromWeb(response.body);
    await pipeline(nodeStream, res);

  } catch (error) {
    if (error.name === 'AbortError') {
      req.log.info('Stream aborted by client');
      return;
    }
    req.log.error({ err: error }, 'Tunnel proxy error');
    if (!res.headersSent) {
      res.status(500).send('Error streaming media');
    } else {
      res.end();
    }
  }
});

// For Cobalt redirects or tunnels, we should intercept and rewrite the URL 
// in the /api/extract response so the frontend hits our /tunnel.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API Gateway listening on port ${PORT}`);
});
