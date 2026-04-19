const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Storage ────────────────────────────────────────────────────────────────
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// In-memory job store  { jobId: { status, progress, file?, error? } }
const jobs = {};

// Auto-delete files older than 1 hour
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(DOWNLOAD_DIR).forEach(file => {
    const fp = path.join(DOWNLOAD_DIR, file);
    try {
      if (now - fs.statSync(fp).mtimeMs > 3_600_000) fs.unlinkSync(fp);
    } catch {}
  });
}, 10 * 60 * 1000);


// ── Helpers ────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return null;
  const mb = bytes / 1024 / 1024;
  return mb > 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function dedupe(formats) {
  const seen = new Set();
  return formats.filter(f => {
    if (seen.has(f.height)) return false;
    seen.add(f.height);
    return true;
  });
}


// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/info
 * Body: { url: string }
 * Returns video metadata + available quality options
 */
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
    });

    // Extract distinct video qualities
    const videoFormats = info.formats
      .filter(f => f.vcodec !== 'none' && f.height && f.height >= 360)
      .map(f => ({
        formatId: f.format_id,
        quality: `${f.height}p`,
        height: f.height,
        ext: f.ext,
        fps: f.fps || 30,
        filesize: formatBytes(f.filesize || f.filesize_approx),
        vcodec: f.vcodec,
      }))
      .sort((a, b) => b.height - a.height);

    const qualities = dedupe(videoFormats);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,          // seconds
      channel: info.uploader,
      viewCount: info.view_count,
      qualities,
    });

  } catch (err) {
    console.error('[info error]', err.message);
    res.status(500).json({ error: 'Could not fetch video info. Check the URL and try again.' });
  }
});


/**
 * POST /api/download
 * Body: { url: string, quality: number }   quality = pixel height e.g. 720
 * Returns { jobId }  — client polls /api/status/:jobId
 */
app.post('/api/download', async (req, res) => {
  const { url, quality } = req.body;
  if (!url || !quality) return res.status(400).json({ error: 'URL and quality are required.' });

  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', progress: 0 };
  res.json({ jobId });

  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

  try {
    await ytdlp(url, {
      // Best video up to chosen height + best audio, merged as mp4
      format: `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`,
      output: outputPath,
      mergeOutputFormat: 'mp4',
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
    });

    jobs[jobId] = { status: 'done', file: outputPath };
  } catch (err) {
    console.error('[download error]', err.message);
    jobs[jobId] = { status: 'error', error: 'Download failed. Try a different quality.' };
  }
});


/**
 * GET /api/status/:jobId
 * Returns current job state
 */
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  // Don't expose internal file path to client
  const { file, ...safe } = job;
  res.json({ ...safe, ready: job.status === 'done' });
});


/**
 * GET /api/file/:jobId
 * Streams the finished file to the client then deletes it
 */
app.get('/api/file/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'File not ready.' });
  }

  res.download(job.file, 'video.mp4', err => {
    if (!err) {
      setTimeout(() => {
        try { fs.unlinkSync(job.file); } catch {}
        delete jobs[req.params.jobId];
      }, 5000);
    }
  });
});


// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
