const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Storage ────────────────────────────────────────────────────────────────
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// In-memory job store
const jobs = {};

// Auto-delete files older than 1 hour
setInterval(() => {
  const now = Date.now();
  try {
    fs.readdirSync(DOWNLOAD_DIR).forEach(file => {
      const fp = path.join(DOWNLOAD_DIR, file);
      try {
        if (now - fs.statSync(fp).mtimeMs > 3_600_000) fs.unlinkSync(fp);
      } catch {}
    });
  } catch {}
}, 10 * 60 * 1000);


// ── Helpers ────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return null;
  const mb = bytes / 1024 / 1024;
  return mb > 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

// Map itag → quality label
const QUALITY_MAP = {
  37: { label: '1080p', height: 1080 },
  137: { label: '1080p', height: 1080 },
  248: { label: '1080p', height: 1080 },
  136: { label: '720p',  height: 720  },
  247: { label: '720p',  height: 720  },
  135: { label: '480p',  height: 480  },
  244: { label: '480p',  height: 480  },
  134: { label: '360p',  height: 360  },
  243: { label: '360p',  height: 360  },
  133: { label: '240p',  height: 240  },
  242: { label: '240p',  height: 240  },
  160: { label: '144p',  height: 144  },
  278: { label: '144p',  height: 144  },
  // 4K
  266: { label: '2160p (4K)', height: 2160 },
  138: { label: '2160p (4K)', height: 2160 },
  315: { label: '2160p (4K)', height: 2160 },
  // 1440p
  264: { label: '1440p', height: 1440 },
  271: { label: '1440p', height: 1440 },
};


// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/info
 */
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });
  if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL.' });

  try {
    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;

    // Get video-only formats with known quality
    const seen = new Set();
    const qualities = info.formats
      .filter(f => f.hasVideo && !f.hasAudio && QUALITY_MAP[f.itag])
      .map(f => {
        const q = QUALITY_MAP[f.itag];
        return {
          itag: f.itag,
          quality: q.label,
          height: q.height,
          fps: f.fps || 30,
          filesize: formatBytes(f.contentLength),
        };
      })
      .filter(f => {
        if (seen.has(f.height)) return false;
        seen.add(f.height);
        return true;
      })
      .sort((a, b) => b.height - a.height);

    // Fallback: if no video-only formats, show combined formats
    if (qualities.length === 0) {
      info.formats
        .filter(f => f.hasVideo && f.hasAudio && f.height)
        .forEach(f => {
          if (!seen.has(f.height)) {
            seen.add(f.height);
            qualities.push({
              itag: f.itag,
              quality: `${f.height}p`,
              height: f.height,
              fps: f.fps || 30,
              filesize: formatBytes(f.contentLength),
              combined: true,
            });
          }
        });
      qualities.sort((a, b) => b.height - a.height);
    }

    res.json({
      title: details.title,
      thumbnail: details.thumbnails.slice(-1)[0]?.url,
      duration: parseInt(details.lengthSeconds),
      channel: details.author?.name,
      qualities,
    });

  } catch (err) {
    console.error('[info error]', err.message);
    res.status(500).json({ error: 'Could not fetch video info. The video may be private, age-restricted, or unavailable.' });
  }
});


/**
 * POST /api/download
 */
app.post('/api/download', async (req, res) => {
  const { url, height } = req.body;
  if (!url || !height) return res.status(400).json({ error: 'URL and quality are required.' });

  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });

  const videoPath = path.join(DOWNLOAD_DIR, `${jobId}_video.mp4`);
  const audioPath = path.join(DOWNLOAD_DIR, `${jobId}_audio.mp4`);
  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

  try {
    // Download video stream
    await new Promise((resolve, reject) => {
      ytdl(url, { quality: `highestvideo`, filter: f => f.hasVideo && !f.hasAudio && f.height <= height })
        .pipe(fs.createWriteStream(videoPath))
        .on('finish', resolve)
        .on('error', reject);
    });

    // Download audio stream
    await new Promise((resolve, reject) => {
      ytdl(url, { quality: 'highestaudio', filter: 'audioonly' })
        .pipe(fs.createWriteStream(audioPath))
        .on('finish', resolve)
        .on('error', reject);
    });

    // Merge with FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions(['-c:v copy', '-c:a aac', '-strict experimental'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Cleanup temp streams
    try { fs.unlinkSync(videoPath); } catch {}
    try { fs.unlinkSync(audioPath); } catch {}

    jobs[jobId] = { status: 'done', file: outputPath };

  } catch (err) {
    console.error('[download error]', err.message);
    try { fs.unlinkSync(videoPath); } catch {}
    try { fs.unlinkSync(audioPath); } catch {}
    jobs[jobId] = { status: 'error', error: 'Download failed. Try a different quality or URL.' };
  }
});


/**
 * GET /api/status/:jobId
 */
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const { file, ...safe } = job;
  res.json({ ...safe, ready: job.status === 'done' });
});


/**
 * GET /api/file/:jobId
 */
app.get('/api/file/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'File not ready.' });

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
