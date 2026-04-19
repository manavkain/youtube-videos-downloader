# GrabVid — YouTube Downloader V1

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Make sure Python + yt-dlp is installed
pip install yt-dlp

# 3. Run
npm start
# → http://localhost:3000
```

## Deploy to Railway (Recommended — $5/month)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Add environment variable: `PORT=3000`
5. Railway auto-detects Node.js and deploys

> Railway includes FFmpeg by default. No manual server setup needed.

## Project Structure

```
yt-downloader/
├── server.js          ← Express backend (API routes)
├── package.json
├── public/
│   └── index.html     ← Frontend UI
└── downloads/         ← Temp files (auto-created, auto-deleted after 1hr)
```

## API Endpoints

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| POST | /api/info | { url } | Fetch video metadata + quality list |
| POST | /api/download | { url, quality } | Start download job |
| GET | /api/status/:jobId | — | Poll job status |
| GET | /api/file/:jobId | — | Download finished file |

## V2 Roadmap (Next Update)
- [ ] Link → MP3 (128/192/320kbps)
- [ ] Link → MP4 (recompressed formats)
- [ ] Link → Script (.txt via Whisper AI)
- [ ] Google AdSense integration

## V3 Roadmap
- [ ] Chrome Extension
- [ ] User accounts
- [ ] $5/month subscription tier
