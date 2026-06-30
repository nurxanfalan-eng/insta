const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractShortcode(url) {
  const m = url.match(/\/(p|reel|tv|reels)\/([A-Za-z0-9_-]+)/);
  return m ? m[2] : null;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Keep only the path without query params
    return 'https://www.instagram.com' + u.pathname.replace(/\/$/, '');
  } catch { return url.split('?')[0].replace(/\/$/, ''); }
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Extraction Methods ───────────────────────────────────────────────────────

// Method 1: Cobalt API (open source, reliable)
async function extractViaCobalt(url) {
  const endpoints = [
    'https://api.cobalt.tools/',
    'https://co.wuk.sh/'
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios.post(endpoint, {
        url,
        vQuality: 'max',
        isAudioOnly: false,
        disableMetadata: true,
        isNoTTWatermark: true
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': BROWSER_UA
        },
        timeout: 20000
      });

      if (res.data) {
        if (res.data.url) {
          return { videoUrl: res.data.url, thumbnail: '', caption: '', duration: 0, source: 'cobalt' };
        }
        if (res.data.urls && Array.isArray(res.data.urls) && res.data.urls[0]) {
          return { videoUrl: res.data.urls[0], thumbnail: '', caption: '', duration: 0, source: 'cobalt' };
        }
        if (res.data.status === 'redirect' && res.data.url) {
          return { videoUrl: res.data.url, thumbnail: '', caption: '', duration: 0, source: 'cobalt' };
        }
        if (res.data.status === 'stream' && res.data.url) {
          return { videoUrl: res.data.url, thumbnail: '', caption: '', duration: 0, source: 'cobalt-stream' };
        }
      }
    } catch (e) {
      console.log(`Cobalt ${endpoint} failed:`, e.message);
    }
  }
  throw new Error('Cobalt: no result');
}

// Method 2: Instagram oEmbed + page scrape
async function extractViaPageScrape(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Invalid shortcode');

  // Try embed page
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const res = await axios.get(embedUrl, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.instagram.com/'
    },
    timeout: 20000
  });

  const html = res.data;

  // Multiple patterns to find video URL
  const patterns = [
    /"video_url"\s*:\s*"([^"]+)"/,
    /video_url\\u0022:\\u0022([^\\]+)\\u0022/,
    /"contentUrl"\s*:\s*"([^"]+)"/,
    /property="og:video"\s+content="([^"]+)"/,
    /property="og:video:secure_url"\s+content="([^"]+)"/,
    /<video[^>]+src="([^"]+)"/,
    /src=\\"(https:\/\/[^"\\]+\.mp4[^"\\]*)\\"/
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      let videoUrl = m[1]
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/')
        .replace(/\\n/g, '')
        .replace(/\\/g, '');
      if (videoUrl.includes('cdninstagram') || videoUrl.includes('fbcdn') || videoUrl.includes('.mp4')) {
        const thumbPatterns = [
          /property="og:image"\s+content="([^"]+)"/,
          /"thumbnail_src"\s*:\s*"([^"]+)"/,
          /"display_url"\s*:\s*"([^"]+)"/
        ];
        let thumbnail = '';
        for (const tp of thumbPatterns) {
          const tm = html.match(tp);
          if (tm) { thumbnail = tm[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/'); break; }
        }
        return { videoUrl, thumbnail, caption: '', duration: 0, source: 'scrape' };
      }
    }
  }

  // Try JSON-LD
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld.contentUrl) {
        return { videoUrl: ld.contentUrl, thumbnail: ld.thumbnailUrl || '', caption: ld.description || '', duration: 0, source: 'json-ld' };
      }
    } catch {}
  }

  throw new Error('Page scrape: no video found');
}

// Method 3: Instagram GraphQL API
async function extractViaGraphQL(shortcode) {
  const url = `https://www.instagram.com/graphql/query/?query_hash=2b0673e0dc4580674a88d2209b7e4cd0&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'X-IG-App-ID': '936619743392459',
      'Referer': `https://www.instagram.com/p/${shortcode}/`
    },
    timeout: 15000
  });

  const media = res.data?.data?.shortcode_media;
  if (!media) throw new Error('No media in GraphQL response');
  if (!media.is_video) throw new Error('Not a video post');

  return {
    videoUrl: media.video_url,
    thumbnail: media.display_url || '',
    caption: media.edge_media_to_caption?.edges?.[0]?.node?.text || '',
    duration: media.video_duration || 0,
    source: 'graphql'
  };
}

// Method 4: Instagram Web API (newer endpoint)
async function extractViaWebAPI(shortcode) {
  const url = `https://www.instagram.com/api/v1/media/shortcode/${shortcode}/info/`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Instagram 279.0.0.23.118 Android',
      'Accept': 'application/json',
      'X-IG-App-ID': '567067343352427',
      'X-IG-Device-ID': '52c14342-9dd3-4fe7-a2f8-b0e14e918d19'
    },
    timeout: 15000
  });

  const items = res.data?.items;
  if (!items || !items[0]) throw new Error('No items in response');

  const item = items[0];
  if (item.video_versions && item.video_versions.length > 0) {
    const best = item.video_versions.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return {
      videoUrl: best.url,
      thumbnail: item.image_versions2?.candidates?.[0]?.url || '',
      caption: item.caption?.text || '',
      duration: item.video_duration || 0,
      source: 'web-api'
    };
  }
  throw new Error('No video versions');
}

// Method 5: SnapInsta-style form submission
async function extractViaSnap(url) {
  // Use public downloader APIs
  const services = [
    {
      url: 'https://snapsave.app/action.php',
      data: `url=${encodeURIComponent(url)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://snapsave.app/' }
    }
  ];

  for (const svc of services) {
    try {
      const res = await axios.post(svc.url, svc.data, {
        headers: { ...svc.headers, 'User-Agent': BROWSER_UA },
        timeout: 15000
      });
      
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const mp4Match = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"[^>]*>.*?[Hh][Dd]/);
      const anyMp4 = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/);
      
      const videoUrl = mp4Match ? mp4Match[1] : (anyMp4 ? anyMp4[1] : null);
      if (videoUrl) {
        return { videoUrl: videoUrl.replace(/&amp;/g, '&'), thumbnail: '', caption: '', duration: 0, source: 'snapsave' };
      }
    } catch (e) {
      console.log('SnapSave failed:', e.message);
    }
  }
  throw new Error('Snap services failed');
}

// Method 6: RapidAPI / free public Instagram downloader APIs
async function extractViaPublicAPI(url) {
  // Try multiple endpoints
  const shortcode = extractShortcode(url);
  
  try {
    // Instaloader-style public endpoint
    const res = await axios.get(`https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'application/json',
        'X-IG-App-ID': '936619743392459'
      },
      timeout: 15000
    });

    if (res.data?.graphql?.shortcode_media?.is_video) {
      const media = res.data.graphql.shortcode_media;
      return {
        videoUrl: media.video_url,
        thumbnail: media.display_url || '',
        caption: media.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        duration: media.video_duration || 0,
        source: 'public-api'
      };
    }
  } catch (e) {}

  throw new Error('Public API failed');
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────
async function getInstagramVideo(url) {
  url = normalizeUrl(url);
  const shortcode = extractShortcode(url);
  
  if (!shortcode) {
    throw new Error('Keçərsiz Instagram linki. /p/, /reel/ və ya /tv/ olan link daxil edin.');
  }

  console.log(`[extract] shortcode=${shortcode}`);

  const methods = [
    { name: 'Cobalt API', fn: () => extractViaCobalt(url) },
    { name: 'GraphQL API', fn: () => extractViaGraphQL(shortcode) },
    { name: 'Web API',    fn: () => extractViaWebAPI(shortcode) },
    { name: 'Page Scrape', fn: () => extractViaPageScrape(url) },
    { name: 'Public API', fn: () => extractViaPublicAPI(url) },
    { name: 'SnapSave',   fn: () => extractViaSnap(url) }
  ];

  const errors = [];
  for (const method of methods) {
    try {
      console.log(`[extract] trying: ${method.name}`);
      const result = await method.fn();
      if (result && result.videoUrl) {
        console.log(`[extract] success via ${method.name}: ${result.videoUrl.substring(0, 80)}`);
        return result;
      }
    } catch (e) {
      console.log(`[extract] ${method.name} failed: ${e.message}`);
      errors.push(`${method.name}: ${e.message}`);
    }
  }

  throw new Error('Video tapılmadı. Mümkün səbəblər: 1) Video özəldir; 2) Link düzgün deyil; 3) Instagram müvəqqəti bloklaşdırma. Bir az gözləyib yenidən cəhd edin.');
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL lazımdır' });
  if (!url.match(/instagram\.com\/(p|reel|tv|reels)\//)) {
    return res.status(400).json({ error: 'Keçərsiz Instagram linki. Post, Reel və ya TV linki daxil edin.' });
  }

  try {
    const result = await getInstagramVideo(url);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[/api/extract] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Video Proxy (bypass CORS, stream download) ───────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  const decodedUrl = decodeURIComponent(url);

  try {
    const response = await axios({
      method: 'GET',
      url: decodedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': MOBILE_UA,
        'Referer': 'https://www.instagram.com/',
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Range': req.headers.range || ''
      },
      timeout: 120000,
      maxRedirects: 10
    });

    const contentType   = response.headers['content-type'] || 'video/mp4';
    const contentLength = response.headers['content-length'];
    const acceptRanges  = response.headers['accept-ranges'];

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="instadown_video.mp4"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (acceptRanges)  res.setHeader('Accept-Ranges', acceptRanges);

    // Handle partial content (206)
    if (response.status === 206) {
      res.status(206);
      res.setHeader('Content-Range', response.headers['content-range']);
    }

    response.data.pipe(res);

    response.data.on('error', (err) => {
      console.error('Proxy stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
    });
  } catch (err) {
    console.error('[/api/proxy] error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy xətası: ' + err.message });
    }
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// ─── Catch-all → SPA ─────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[ws] client connected:', socket.id);

  socket.on('extract', async ({ url }) => {
    if (!url || !url.match(/instagram\.com\/(p|reel|tv|reels)\//)) {
      socket.emit('error', { message: 'Keçərsiz Instagram linki' });
      return;
    }

    socket.emit('status', { message: 'Video axtarılır...' });

    try {
      const result = await getInstagramVideo(url);
      socket.emit('result', { success: true, ...result });
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('[ws] client disconnected:', socket.id);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ InstaDown v2 running on port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('uncaughtException',   (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (r)   => console.error('Unhandled:', r));

module.exports = { app, server };
