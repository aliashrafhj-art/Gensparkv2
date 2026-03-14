const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { EventEmitter } = require('events');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const TRIM_SECONDS = parseFloat(process.env.TRIM_SECONDS || '4');

const DRIVE_CLIENT_ID = process.env.DRIVE_CLIENT_ID;
const DRIVE_CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET;
const DRIVE_REFRESH_TOKEN = process.env.DRIVE_REFRESH_TOKEN;

const jobs = {};
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

// ─── OAuth: get fresh access token ──────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DRIVE_CLIENT_ID,
      client_secret: DRIVE_CLIENT_SECRET,
      refresh_token: DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('[TOKEN] Refreshed OK');
  return cachedToken;
}

// ─── Drive Upload (multipart, same as Newtest) ───────────────────
async function uploadToDrive(filePath, fileName) {
  const fetch = (await import('node-fetch')).default;
  const token = await getAccessToken();
  const boundary = '-------314159265358979323846';
  const metadata = JSON.stringify({
    name: fileName,
    parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : [],
  });
  const fileBuffer = fs.readFileSync(filePath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': body.length,
    },
    body,
  });
  if (!res.ok) throw new Error('Drive upload failed: ' + await res.text());
  const data = await res.json();
  return {
    name: data.name,
    webViewLink: `https://drive.google.com/file/d/${data.id}/view`,
  };
}

// ─── Kuaishou: resolve + GraphQL (same as Newtest) ───────────────
async function getKuaishouVideoUrl(shortUrl) {
  const fetch = (await import('node-fetch')).default;
  const headers = {
    'User-Agent': MOBILE_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.kuaishou.com/',
  };

  const pageRes = await fetch(shortUrl, { redirect: 'follow', headers });
  const finalUrl = pageRes.url;
  const html = await pageRes.text();
  console.log('[KS] Final URL:', finalUrl);

  let videoUrl = null;
  let title = 'kuaishou_video';

  const photoIdMatch = finalUrl.match(/featured\/(\w+)/)
    || finalUrl.match(/photoId=([a-zA-Z0-9_-]+)/)
    || finalUrl.match(/\/fw\/photo\/([a-zA-Z0-9_-]+)/)
    || finalUrl.match(/short-video\/([a-zA-Z0-9_-]+)/);

  if (photoIdMatch) {
    const photoId = photoIdMatch[1];
    console.log('[KS] photoId:', photoId);
    try {
      const gqlRes = await fetch('https://video.kuaishou.com/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: 'visionVideoDetail',
          variables: { photoId, page: 'selected' },
          query: 'query visionVideoDetail($photoId: String, $type: String, $page: String) { visionVideoDetail(photoId: $photoId, type: $type, page: $page) { photo { id caption coverUrl photoUrl } } }',
        }),
      });
      const gqlData = await gqlRes.json();
      console.log('[KS] GraphQL:', JSON.stringify(gqlData).substring(0, 200));
      const photo = gqlData?.data?.visionVideoDetail?.photo;
      if (photo?.photoUrl) {
        videoUrl = photo.photoUrl;
        title = (photo.caption || photoId).replace(/\n/g, '').trim();
      }
    } catch (e) { console.warn('[KS] GraphQL error:', e.message); }
  }

  if (!videoUrl) {
    const patterns = [
      /"photoUrl"\s*:\s*"([^"]+)"/,
      /"url"\s*:\s*"(https:\/\/[^"]*\.mp4[^"]*)"/,
      /<video[^>]+src="([^"]+)"/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1].includes('mp4')) {
        videoUrl = m[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
        break;
      }
    }
  }

  if (!videoUrl) throw new Error('Video URL বের করা গেলো না');
  const titleMatch = html.match(/"caption"\s*:\s*"([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch && title === 'kuaishou_video') title = titleMatch[1].replace(/\s*[-|].*$/, '').trim();
  return { videoUrl, title };
}

// ─── Download video ──────────────────────────────────────────────
async function downloadVideo(videoUrl, outputPath) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(videoUrl, {
    headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.kuaishou.com/' },
  });
  if (!res.ok) throw new Error('Video download failed: HTTP ' + res.status);
  const buffer = await res.buffer();
  fs.writeFileSync(outputPath, buffer);
}

// ─── yt-dlp fallback ─────────────────────────────────────────────
function ytdlpDownload(url, outputDir) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');
    const cmd = `yt-dlp --no-playlist --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;
    exec(cmd, { timeout: 180000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error('[yt-dlp] ' + (stderr || error.message))); return; }
      const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4'));
      if (files.length === 0) { reject(new Error('[yt-dlp] No mp4 found')); return; }
      resolve({ filePath: path.join(outputDir, files[files.length - 1]), title: path.basename(files[files.length - 1], '.mp4') });
    });
  });
}

// ─── FFmpeg Trim ─────────────────────────────────────────────────
function trimVideo(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      (err, stdout) => {
        if (err) { resolve(inputPath); return; }
        const duration = parseFloat(stdout.trim());
        const trimmed = duration - TRIM_SECONDS;
        if (isNaN(trimmed) || trimmed <= 2) { resolve(inputPath); return; }
        const ext = path.extname(inputPath);
        const outPath = path.join(outputDir, path.basename(inputPath, ext) + '_trimmed' + ext);
        exec(`ffmpeg -i "${inputPath}" -t ${trimmed.toFixed(3)} -c copy "${outPath}" -y`, { timeout: 120000 },
          (e) => {
            if (e) { resolve(inputPath); return; }
            try { fs.unlinkSync(inputPath); } catch {}
            resolve(outPath);
          }
        );
      }
    );
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_').substring(0, 80) + '.mp4';
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

      try {
        job.emitter.emit('event', { type: 'fetching', index: i, url: rawUrl });
        const info = await getKuaishouVideoUrl(rawUrl);
        title = info.title;
        job.emitter.emit('event', { type: 'downloading', index: i, url: rawUrl, title });
        rawPath = path.join(videoDir, sanitizeFilename(title));
        await downloadVideo(info.videoUrl, rawPath);
        console.log('[METHOD1] OK:', title);
      } catch (apiErr) {
        console.log('[METHOD1] Failed:', apiErr.message, '— yt-dlp...');
        job.emitter.emit('event', { type: 'downloading', index: i, url: rawUrl, title: 'yt-dlp...' });
        const ytResult = await ytdlpDownload(rawUrl, videoDir);
        rawPath = ytResult.filePath;
        title = ytResult.title;
      }

      job.emitter.emit('event', { type: 'trimming', index: i, url: rawUrl });
      const trimmedPath = await trimVideo(rawPath, videoDir);

      const finalName = sanitizeFilename(path.basename(trimmedPath, path.extname(trimmedPath)));
      job.emitter.emit('event', { type: 'uploading', index: i, url: rawUrl, fileName: finalName });
      const driveFile = await uploadToDrive(trimmedPath, finalName);
      try { fs.unlinkSync(trimmedPath); } catch {}

      const result = { index: i, url: rawUrl, status: 'success', title, fileName: driveFile.name, driveLink: driveFile.webViewLink };
      job.results.push(result);
      job.emitter.emit('event', { type: 'done', ...result });

    } catch (err) {
      console.error('[ERROR]', rawUrl, err.message);
      job.results.push({ index: i, url: rawUrl, status: 'failed', error: err.message });
      job.emitter.emit('event', { type: 'error', index: i, url: rawUrl, error: err.message });
    }

    if (i < job.urls.length - 1) await new Promise(r => setTimeout(r, 1000));
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
