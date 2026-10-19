import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { addLog, PROJECT_ROOT, resolveTdPath } from "./state";

export async function ensureFfmpeg(tdPathInput: string, updateTaskCb?: (msg: string) => void): Promise<string> {
  // Check if FFmpeg is placed in project root or project TwitchDownloader folder
  const localRootFfmpeg = path.join(PROJECT_ROOT, process.platform === 'win32' ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(localRootFfmpeg)) return localRootFfmpeg;
  const localTdFfmpeg = path.join(PROJECT_ROOT, "TwitchDownloader", process.platform === 'win32' ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(localTdFfmpeg)) return localTdFfmpeg;

  const tdPath = resolveTdPath(tdPathInput);
  const tdDir = path.dirname(tdPath);
  const ffmpegPath = path.join(tdDir, process.platform === 'win32' ? "ffmpeg.exe" : "ffmpeg");

  if (!fs.existsSync(ffmpegPath)) {
    addLog(`FFmpeg not found in ${tdDir}. Downloading it automatically...`);
    if (updateTaskCb) {
      updateTaskCb("Downloading FFmpeg...");
    }
    
    try {
      await new Promise<void>((resolve, reject) => {
        const dl = spawn(tdPath, ["ffmpeg", "-d"], { cwd: tdDir });
        const timer = setTimeout(() => {
          try { dl.kill('SIGTERM'); } catch (e) {}
          reject(new Error("FFmpeg download timed out after 3 minutes"));
        }, 180000);
        
        let errLog = '';
        dl.stdout?.on('data', () => {});
        dl.stderr?.on('data', (d) => { errLog += d.toString(); });
        
        dl.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Exit code ${code}. ${errLog}`));
        });
        dl.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      addLog(`Successfully downloaded FFmpeg.`);
    } catch (e: any) {
      addLog(`Failed to download FFmpeg automatically: ${e.message}`);
    }
  }

  return fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';
}

/**
 * Accurately probes media container duration in seconds.
 * Attempts ffprobe first, falling back to parsing ffmpeg -i stderr duration.
 */
export async function getVideoDurationSeconds(filePath: string, tdPath?: string): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;

  const fallbackTdPath = resolveTdPath(tdPath);
  const tdDir = path.dirname(fallbackTdPath);
  const ffprobeName = process.platform === 'win32' ? "ffprobe.exe" : "ffprobe";
  const ffprobePath = path.join(tdDir, ffprobeName);
  const ffmpegName = process.platform === 'win32' ? "ffmpeg.exe" : "ffmpeg";
  const ffmpegPath = path.join(tdDir, ffmpegName);

  // 1. Try ffprobe if available in project root, TwitchDownloader directory or PATH
  const probeCandidates = [
    path.join(PROJECT_ROOT, ffprobeName),
    path.join(PROJECT_ROOT, "TwitchDownloader", ffprobeName),
    ffprobePath,
    'ffprobe'
  ];
  for (const candidate of probeCandidates) {
    if (candidate === 'ffprobe' || fs.existsSync(candidate)) {
      try {
        const dur = await new Promise<number>((resolve, reject) => {
          const proc = spawn(candidate, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
          ]);
          const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) {}
            reject(new Error("ffprobe probe timed out"));
          }, 15000);
          let stdout = '';
          proc.stdout?.on('data', d => { stdout += d.toString(); });
          proc.on('close', code => {
            clearTimeout(timer);
            const val = parseFloat(stdout.trim());
            if (code === 0 && !isNaN(val) && val > 0) resolve(val);
            else reject(new Error(`Exit code ${code}`));
          });
          proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        if (dur > 0) return dur;
      } catch (_) {}
    }
  }

  // 2. Fallback: Parse Duration: HH:MM:SS.xx from ffmpeg -i
  const ffmpegCandidates = [ffmpegPath, 'ffmpeg'];
  for (const candidate of ffmpegCandidates) {
    if (candidate === 'ffmpeg' || fs.existsSync(candidate)) {
      try {
        const dur = await new Promise<number>((resolve, reject) => {
          const proc = spawn(candidate, ['-nostats', '-i', filePath]);
          const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) {}
            reject(new Error("ffmpeg -i probe timed out"));
          }, 15000);
          let stderr = '';
          proc.stderr?.on('data', d => { stderr += d.toString(); });
          proc.on('close', () => {
            clearTimeout(timer);
            const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
            if (match) {
              const hours = parseFloat(match[1]);
              const minutes = parseFloat(match[2]);
              const seconds = parseFloat(match[3]);
              const totalSec = hours * 3600 + minutes * 60 + seconds;
              if (totalSec > 0) {
                resolve(totalSec);
                return;
              }
            }
            reject(new Error("Could not parse duration"));
          });
          proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        if (dur > 0) return dur;
      } catch (_) {}
    }
  }

  return 0;
}

/**
 * Probes the video stream codec of a file using ffprobe or ffmpeg.
 * Returns true if HEVC / H.265 (indicative of 1440p / Enhanced Broadcasting), false otherwise.
 */
export async function checkVideoIsHevc(filePath: string, tdPath?: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;

  const fallbackTdPath = resolveTdPath(tdPath);
  const tdDir = path.dirname(fallbackTdPath);
  const ffprobeName = process.platform === 'win32' ? "ffprobe.exe" : "ffprobe";
  const ffprobePath = path.join(tdDir, ffprobeName);

  // 1. Try ffprobe codec query
  const probeCandidates = [
    path.join(PROJECT_ROOT, ffprobeName),
    path.join(PROJECT_ROOT, "TwitchDownloader", ffprobeName),
    ffprobePath,
    'ffprobe'
  ];

  for (const candidate of probeCandidates) {
    if (candidate === 'ffprobe' || fs.existsSync(candidate)) {
      try {
        const codec = await new Promise<string>((resolve, reject) => {
          const proc = spawn(candidate, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
          ]);
          const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) {}
            reject(new Error("ffprobe codec check timed out"));
          }, 10000);
          let stdout = '';
          proc.stdout?.on('data', d => { stdout += d.toString(); });
          proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim().toLowerCase());
            else reject(new Error(`Exit code ${code}`));
          });
          proc.on('error', err => {
            clearTimeout(timer);
            reject(err);
          });
        });
        if (codec.includes('hevc') || codec.includes('h265')) return true;
        if (codec.includes('h264') || codec.includes('avc')) return false;
      } catch (_) {}
    }
  }

  // 2. Fallback: Parse video stream info from ffmpeg -i
  const ffmpegName = process.platform === 'win32' ? "ffmpeg.exe" : "ffmpeg";
  const ffmpegPath = path.join(tdDir, ffmpegName);
  const ffmpegCandidates = [
    path.join(PROJECT_ROOT, ffmpegName),
    path.join(PROJECT_ROOT, "TwitchDownloader", ffmpegName),
    ffmpegPath,
    'ffmpeg'
  ];

  for (const candidate of ffmpegCandidates) {
    if (candidate === 'ffmpeg' || fs.existsSync(candidate)) {
      try {
        const isHevc = await new Promise<boolean>((resolve, reject) => {
          const proc = spawn(candidate, ['-nostats', '-i', filePath]);
          const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) {}
            reject(new Error("ffmpeg -i probe timed out"));
          }, 10000);
          let stderr = '';
          proc.stderr?.on('data', d => { stderr += d.toString(); });
          proc.on('close', () => {
            clearTimeout(timer);
            const lower = stderr.toLowerCase();
            if (lower.includes('video: hevc') || lower.includes('video: h265')) {
              resolve(true);
            } else if (lower.includes('video: h264')) {
              resolve(false);
            } else {
              reject(new Error("Could not determine codec from ffmpeg -i"));
            }
          });
          proc.on('error', err => {
            clearTimeout(timer);
            reject(err);
          });
        });
        return isHevc;
      } catch (_) {}
    }
  }

  return false;
}

