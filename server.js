const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const { EventEmitter } = require('events');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SERVICE_ACCOUNT_JSON = process.env.SERVICE_ACCOUNT_JSON;
const TRIM_SECONDS = parseFloat(process.env.TRIM_SECONDS || '4');

const jobs = {};

// Mobile UA — Kuaishou mobile page দেখাবে, bot block কমবে
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

// ─── Google Drive ────────────────────────────────────────────────
function getDriveClient() {
  const credentials = JSON.parse(SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

async function uploadToDrive(filePath, fileName) {
  const drive = getDriveClient();
  const response = await drive.files.create({
    requestBody: { name: fileName, parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : [] },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) },
    fields: 'id, name, webViewLink',
  });
  return response.data;
}

// ─── HTTP Helper ─────────────────────────────────────────────────
function httpGet(url, headers = {}, timeout = 15000, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { 'User-Agent': MOBILE_UA, ...headers },
      timeout,
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
    const req = (method === 'POST' ? lib.request : lib.get)(method === 'POST' ? options : url, method === 'POST' ? undefined : { headers: { 'User-Agent': MOBILE_UA, ...headers }, timeout }, (res) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.destroy();
        resolve(httpGet(next, headers, timeout));
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers, finalUrl: url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout: ' + url)); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── Extract photoId ─────────────────────────────────────────────
function extractPhotoId(url) {
  const m1 = url.match(/\/fw\/photo\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/photoId=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  const m3 = url.match(/short-video\/([a-zA-Z0-9_-]+)/);
  if (m3) return m3[1];
  const m4 = url.match(/featured\/([a-zA-Z0-9_-]+)/);
  if (m4) return m4[1];
  return null;
}

// ─── Get video URL from chenzhongtech page ───────────────────────
// Strategy 1: parse HTML for <video src> or og:video
// Strategy 2: call Kuaishou mobile API directly with photoId
async function getVideoUrl(photoId, refererUrl) {
  // Try video.kuaishou.com/graphql (works without captcha unlike www.kuaishou.com/graphql)
  try {
    const payload = JSON.stringify({
      operationName: 'visionVideoDetail',
      variables: { photoId, page: 'selected' },
      query: 'query visionVideoDetail($photoId: String, $type: String, $page: String) { visionVideoDetail(photoId: $photoId, type: $type, page: $page) { photo { id caption coverUrl photoUrl } } }'
    });
    const res = await httpGet('https://video.kuaishou.com/graphql', {
      'Content-Type': 'application/json',
      'Referer': refererUrl || `https://www.kuaishou.com/short-video/${photoId}`,
    }, 15000, 'POST', payload);
    if (res.status === 200) {
      const json = JSON.parse(res.body);
      const photo = json?.data?.visionVideoDetail?.photo;
      if (photo?.photoUrl) {
        return { videoUrl: photo.photoUrl, title: (photo.caption || photoId).replace(/\n/g,'').trim() };
      }
    }
  } catch(e) { console.log(`[GQL video.kuaishou] Failed: ${e.message}`); }

  // Try mobile API endpoint
  const apiUrl = `https://m.kuaishou.com/rest/wd/photo/info/${photoId}?fid=${photoId}`;
  try {
    const res = await httpGet(apiUrl, {
      'Referer': refererUrl || `https://www.kuaishou.com/short-video/${photoId}`,
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    });
    if (res.status === 200) {
      const json = JSON.parse(res.body);
      const mp4 = json?.photo?.mainMvUrls?.[0]?.url
        || json?.photo?.photoUrl
        || json?.result?.photo?.mainMvUrls?.[0]?.url;
      if (mp4) {
        const caption = json?.photo?.caption || json?.result?.photo?.caption || `ks_${photoId}`;
        return { videoUrl: mp4, title: caption };
      }
    }
  } catch (e) {
    console.log(`[API1] Failed: ${e.message}`);
  }

  // Try alternate mobile API
  const apiUrl2 = `https://www.kuaishou.com/rest/wd/photo/info/${photoId}`;
  try {
    const res = await httpGet(apiUrl2, {
      'Referer': `https://www.kuaishou.com/short-video/${photoId}`,
      'Accept': 'application/json',
    });
    if (res.status === 200) {
      const json = JSON.parse(res.body);
      const mp4 = json?.photo?.mainMvUrls?.[0]?.url || json?.photo?.photoUrl;
      if (mp4) {
        const caption = json?.photo?.caption || `ks_${photoId}`;
        return { videoUrl: mp4, title: caption };
      }
    }
  } catch (e) {
    console.log(`[API2] Failed: ${e.message}`);
  }

  // Parse HTML from chenzhongtech page directly
  try {
    const pageUrl = `https://v.m.chenzhongtech.com/fw/photo/${photoId}`;
    const res = await httpGet(pageUrl, {
      'Referer': refererUrl || pageUrl,
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, 20000);

    const body = res.body;

    // Try og:video meta tag
    const ogVideo = body.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i)
      || body.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"/i);
    if (ogVideo) {
      const title = (body.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || [])[1] || `ks_${photoId}`;
      return { videoUrl: ogVideo[1], title };
    }

    // Try <video src=
    const videoSrc = body.match(/<video[^>]+src="([^"]+\.mp4[^"]*)"/i);
    if (videoSrc) {
      return { videoUrl: videoSrc[1], title: `ks_${photoId}` };
    }

    // Try JSON in page __NEXT_DATA__ or window.__INITIAL_STATE__
    const nextData = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextData) {
      const json = JSON.parse(nextData[1]);
      const photoData = json?.props?.pageProps?.photo || json?.props?.pageProps?.initialState?.photo;
      const mp4 = photoData?.mainMvUrls?.[0]?.url || photoData?.photoUrl;
      if (mp4) {
        return { videoUrl: mp4, title: photoData?.caption || `ks_${photoId}` };
      }
    }
  } catch (e) {
    console.log(`[HTML] Failed: ${e.message}`);
  }

  throw new Error(`Could not extract video URL for photoId: ${photoId}`);
}

// ─── Download video ──────────────────────────────────────────────
function downloadFromUrl(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const lib = videoUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);

    const get = (url, redirectCount = 0) => {
      if (redirectCount > 10) { file.close(); reject(new Error('Too many redirects')); return; }
      lib.get(url, {
        headers: {
          'User-Agent': MOBILE_UA,
          'Referer': 'https://www.kuaishou.com/',
        },
        timeout: 120000,
      }, (res) => {
        if ([301,302,303,307].includes(res.statusCode) && res.headers.location) {
          res.destroy();
          get(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode} downloading video`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(outputPath); });
        file.on('error', (e) => { file.close(); reject(e); });
      }).on('error', (e) => { file.close(); reject(e); });
    };
    get(videoUrl);
  });
}

// ─── FFmpeg Trim ─────────────────────────────────────────────────
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      (err, stdout) => {
        if (err) { reject(new Error('ffprobe failed')); return; }
        const d = parseFloat(stdout.trim());
        if (isNaN(d)) { reject(new Error('Invalid duration')); return; }
        resolve(d);
      }
    );
  });
}

function trimVideo(inputPath, outputDir) {
  return new Promise(async (resolve, reject) => {
    try {
      const duration = await getVideoDuration(inputPath);
      const trimmedDuration = duration - TRIM_SECONDS;
      if (trimmedDuration <= 2) { resolve(inputPath); return; }
      const ext = path.extname(inputPath);
      const base = path.basename(inputPath, ext);
      const outputPath = path.join(outputDir, `${base}_trimmed${ext}`);
      exec(`ffmpeg -i "${inputPath}" -t ${trimmedDuration.toFixed(3)} -c copy "${outputPath}" -y`,
        { timeout: 120000 },
        (err, stdout, stderr) => {
          if (err) { reject(new Error('ffmpeg failed: ' + stderr)); return; }
          try { fs.unlinkSync(inputPath); } catch {}
          resolve(outputPath);
        }
      );
    } catch (e) { reject(e); }
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_').substring(0, 80) + '.mp4';
}

// ─── yt-dlp fallback ────────────────────────────────────
function ytdlpDownload(url, outputDir) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');
    const cmd = `yt-dlp --no-playlist --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;
    console.log(`[YTDLP] ${url}`);
    exec(cmd, { timeout: 180000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error('[yt-dlp] ' + (stderr || error.message))); return; }
      const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4'));
      if (files.length === 0) { reject(new Error('[yt-dlp] No mp4 found')); return; }
      const filePath = path.join(outputDir, files[files.length - 1]);
      const title = path.basename(files[files.length - 1], '.mp4');
      resolve({ filePath, title });
    });
  });
}

// ─── Job Processor ───────────────────────────────────────────────
async function processJob(jobId) {
  const job = jobs[jobId];
  job.status = 'running';
  const tmpBase = `/tmp/ks_${jobId}`;
  fs.mkdirSync(tmpBase, { recursive: true });

  for (let i = 0; i < job.urls.length; i++) {
    const rawUrl = job.urls[i].trim();
    if (!rawUrl) continue;

    job.emitter.emit('event', { type: 'start', index: i, total: job.urls.length, url: rawUrl });
    const videoDir = `${tmpBase}/${i}`;
    fs.mkdirSync(videoDir, { recursive: true });

    try {
      let rawPath, title;

      // Method 1: Direct API + HTML parse
      try {
        job.emitter.emit('event', { type: 'resolving', index: i, url: rawUrl });
        const resolved = await httpGet(rawUrl, {}, 15000);
        const finalUrl = resolved.finalUrl;
        console.log(`[RESOLVE] ${rawUrl} → ${finalUrl}`);

        const photoId = extractPhotoId(finalUrl);
        if (!photoId) throw new Error(`Cannot extract photoId from: ${finalUrl}`);

        job.emitter.emit('event', { type: 'fetching', index: i, url: rawUrl });
        const info = await getVideoUrl(photoId, finalUrl);
        title = info.title;

        job.emitter.emit('event', { type: 'downloading', index: i, url: rawUrl, title });
        rawPath = path.join(videoDir, sanitizeFilename(title));
        await downloadFromUrl(info.videoUrl, rawPath);
        console.log(`[METHOD1] OK: ${title}`);

      } catch (apiErr) {
        // Method 2: yt-dlp fallback
        console.log(`[METHOD1] Failed (${apiErr.message}) — yt-dlp...`);
        job.emitter.emit('event', { type: 'downloading', index: i, url: rawUrl, title: 'yt-dlp...' });
        const ytResult = await ytdlpDownload(rawUrl, videoDir);
        rawPath = ytResult.filePath;
        title = ytResult.title;
        console.log(`[METHOD2] yt-dlp OK: ${title}`);
      }

      // Trim
      job.emitter.emit('event', { type: 'trimming', index: i, url: rawUrl });
      const trimmedPath = await trimVideo(rawPath, videoDir);

      // Upload
      const finalName = sanitizeFilename(path.basename(trimmedPath, path.extname(trimmedPath)));
      job.emitter.emit('event', { type: 'uploading', index: i, url: rawUrl, fileName: finalName });
      const driveFile = await uploadToDrive(trimmedPath, finalName);
      try { fs.unlinkSync(trimmedPath); } catch {}

      const result = { index: i, url: rawUrl, status: 'success', title, fileName: driveFile.name, driveLink: driveFile.webViewLink };
      job.results.push(result);
      job.emitter.emit('event', { type: 'done', ...result });

    } catch (err) {
      console.error(`[ERROR] ${rawUrl}: ${err.message}`);
      job.results.push({ index: i, url: rawUrl, status: 'failed', error: err.message });
      job.emitter.emit('event', { type: 'error', index: i, url: rawUrl, error: err.message });
    }

    if (i < job.urls.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  job.status = 'completed';
  job.emitter.emit('event', { type: 'completed', results: job.results });
}
// ─── Routes ──────────────────────────────────────────────────────
app.post('/start', (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0)
    return res.status(400).json({ error: 'No URLs provided' });

  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { urls, results: [], status: 'queued', emitter: new EventEmitter() };
  jobs[jobId].emitter.setMaxListeners(50);
  processJob(jobId).catch(err => { jobs[jobId].status = 'failed'; console.error(err); });
  res.json({ jobId });
});

app.get('/progress/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (job.status === 'completed') {
    job.results.forEach(r => send({ type: r.status === 'success' ? 'done' : 'error', ...r }));
    send({ type: 'completed' });
    return res.end();
  }

  const handler = (data) => {
    send(data);
    if (data.type === 'completed') { job.emitter.removeListener('event', handler); res.end(); }
  };
  job.emitter.on('event', handler);
  req.on('close', () => job.emitter.removeListener('event', handler));
});

app.listen(PORT, () => console.log(`KS Bulk Downloader running on port ${PORT}`));
