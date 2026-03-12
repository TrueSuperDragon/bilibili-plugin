const statusEl = document.getElementById("status");
const pageTitleEl = document.getElementById("pageTitle");
const fetchBtn = document.getElementById("fetchBtn");
const copyAllBtn = document.getElementById("copyAllBtn");
const mergeBestBtn = document.getElementById("mergeBestBtn");
const videoSection = document.getElementById("videoSection");
const audioSection = document.getElementById("audioSection");
const otherSection = document.getElementById("otherSection");
const videoTitle = document.getElementById("videoTitle");
const audioTitle = document.getElementById("audioTitle");
const otherTitle = document.getElementById("otherTitle");
const videoList = document.getElementById("videoList");
const audioList = document.getElementById("audioList");
const otherList = document.getElementById("otherList");
const mergeProgressSection = document.getElementById("mergeProgressSection");
const mergeProgressTextEl = document.getElementById("mergeProgressText");
const mergeProgressBarEl = document.getElementById("mergeProgressBar");
const mergeProgressPercentEl = document.getElementById("mergeProgressPercent");
const inviteGateEl = document.getElementById("inviteGate");
const inviteInputEl = document.getElementById("inviteInput");
const inviteSubmitBtnEl = document.getElementById("inviteSubmitBtn");
const inviteHintEl = document.getElementById("inviteHint");

const extensionApi = typeof chrome !== "undefined" ? chrome : null;
const hasRuntime = !!extensionApi?.runtime?.id;
const hasStorage = !!extensionApi?.storage?.local;
const hasTabs = !!extensionApi?.tabs?.query;
const hasScripting = !!extensionApi?.scripting?.executeScript;
const hasDownloads = !!extensionApi?.downloads?.download;

let lastResult = null;
let lastSavedAt = 0;
let lastUrl = "";
let ffmpegInstance = null;
let ffmpegLoading = null;
let lastFfmpegLog = "";
let mergeInProgress = false;
const BILIBILI_REFERER = "https://www.bilibili.com/";
const INVITE_UNLOCK_KEY = "inviteUnlocked";
const FIRST_USE_INVITE_CODE = "暴龙战士真厉害";
let inviteUnlocked = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function setLoading(isLoading) {
  fetchBtn.disabled = isLoading || !inviteUnlocked;
  fetchBtn.textContent = isLoading ? "获取中..." : "获取当前页";
}

function setMergeLoading(isLoading) {
  mergeBestBtn.disabled = isLoading || !inviteUnlocked;
  mergeBestBtn.textContent = isLoading ? "合并中..." : "合并最佳音视频";
}

function setCoreActionsDisabled(disabled) {
  fetchBtn.disabled = disabled;
  mergeBestBtn.disabled = disabled;
  copyAllBtn.disabled = disabled;
}

function showInviteGate() {
  inviteGateEl.classList.remove("hidden");
}

function hideInviteGate() {
  inviteGateEl.classList.add("hidden");
}

function setInviteHint(text, isError = false) {
  inviteHintEl.textContent = text;
  inviteHintEl.classList.toggle("error", Boolean(isError));
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function showMergeProgress() {
  mergeProgressSection.classList.remove("hidden");
}

function updateMergeProgress(percent, message) {
  const safePercent = clampNumber(Math.round(percent || 0), 0, 100);
  mergeProgressBarEl.style.width = `${safePercent}%`;
  mergeProgressPercentEl.textContent = `${safePercent}%`;
  if (message) {
    mergeProgressTextEl.textContent = message;
  }
}

function createRangeProgressUpdater(startPercent, endPercent, title) {
  const start = clampNumber(startPercent, 0, 100);
  const end = clampNumber(endPercent, start, 100);
  return ({ loadedBytes = 0, totalBytes = 0 }) => {
    let ratio = 0;
    if (totalBytes > 0) {
      ratio = loadedBytes / totalBytes;
    } else {
      const fallbackTotal = 20 * 1024 * 1024;
      ratio = loadedBytes / fallbackTotal;
    }
    ratio = clampNumber(ratio, 0, 1);
    const percent = start + (end - start) * ratio;
    const totalText = totalBytes > 0 ? formatBytes(totalBytes) : "未知大小";
    const loadedText = formatBytes(loadedBytes);
    updateMergeProgress(percent, `${title} ${loadedText} / ${totalText}`);
  };
}

async function storageGet(keys) {
  if (hasStorage) {
    return await extensionApi.storage.local.get(keys);
  }
  const data = {};
  keys.forEach((key) => {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      try {
        data[key] = JSON.parse(raw);
      } catch {
        data[key] = raw;
      }
    }
  });
  return data;
}

async function storageSet(values) {
  if (hasStorage) {
    await extensionApi.storage.local.set(values);
    return;
  }
  Object.entries(values).forEach(([key, value]) => {
    localStorage.setItem(key, JSON.stringify(value));
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  if (hasDownloads) {
    extensionApi.downloads.download(
      {
        url,
        filename,
        saveAs: true
      },
      () => URL.revokeObjectURL(url)
    );
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.split("/").pop() || "download.mp4";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

async function readResponseAsUint8Array(response, onProgress) {
  const totalBytes = Number(response.headers.get("content-length")) || 0;
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer());
    onProgress?.({
      loadedBytes: data.byteLength,
      totalBytes
    });
    return data;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loadedBytes += value.byteLength;
      onProgress?.({
        loadedBytes,
        totalBytes
      });
    }
  }

  const merged = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function isBiliMediaUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname.endsWith(".bilivideo.com") ||
      hostname.endsWith(".bilivideo.cn") ||
      hostname.includes("bilivideo.com") ||
      hostname.includes("bilivideo.cn")
    );
  } catch {
    return false;
  }
}

function buildFetchStrategies(url) {
  const strategies = [
    {
      label: "default",
      options: {
        method: "GET",
        mode: "cors",
        cache: "no-store"
      }
    }
  ];

  if (!isBiliMediaUrl(url)) {
    return strategies;
  }

  strategies.unshift(
    {
      label: "referer+cookies",
      options: {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        credentials: "include",
        referrer: BILIBILI_REFERER,
        referrerPolicy: "origin"
      }
    },
    {
      label: "referer",
      options: {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        referrer: BILIBILI_REFERER,
        referrerPolicy: "origin"
      }
    },
    {
      label: "cookies",
      options: {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        credentials: "include"
      }
    }
  );

  return strategies;
}

async function fetchFileWithRetry(url, onProgress) {
  const strategies = buildFetchStrategies(url);
  let lastError = null;

  for (const strategy of strategies) {
    try {
      const response = await fetch(url, strategy.options);
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} [${strategy.label}]`);
        continue;
      }
      return await readResponseAsUint8Array(response, onProgress);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("下载失败：未知错误");
}

async function fetchMediaItem(item, kindText, options = {}) {
  const candidates = [item.url, ...(item.backup || [])].filter(Boolean);
  if (!candidates.length) {
    throw new Error(`${kindText}没有可用链接`);
  }

  const { onLineSwitch, onProgress } = options;
  const errors = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      if (i > 0) {
        onLineSwitch?.(i);
      }
      const bytes = await fetchFileWithRetry(candidate, onProgress);
      return { bytes, index: i };
    } catch (error) {
      errors.push(
        `线路${i + 1}: ${error?.message || String(error)}`
      );
    }
  }

  throw new Error(`${kindText}下载失败（${errors.join("；")}）`);
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
}

function sanitizeFileName(name) {
  return (name || "bilibili")
    .replace(/[\\\\/:*?"<>|]+/g, "_")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function guessExtension(url, fallback) {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop() || "";
    const idx = last.lastIndexOf(".");
    if (idx !== -1 && idx < last.length - 1) {
      return last.slice(idx + 1);
    }
  } catch (error) {
    // Ignore URL parsing errors and fall back.
  }
  return fallback || "m4s";
}

function buildFileName(title, kind, item) {
  const safeTitle = sanitizeFileName(title);
  const idPart = item && item.id ? `_${item.id}` : "";
  const fallbackExt =
    kind === "audio" ? "m4a" : kind === "other" ? "mp4" : "m4s";
  const ext = guessExtension(item.url, fallbackExt);
  return `bilibili/${safeTitle}_${kind}${idPart}.${ext}`;
}

function buildMergedFileName(title) {
  const safeTitle = sanitizeFileName(title);
  return `bilibili/${safeTitle}_合并.mp4`;
}

function collectAllUrls(result) {
  const urls = [];
  const pushItem = (item) => {
    if (item.url) urls.push(item.url);
    if (Array.isArray(item.backup) && item.backup.length) {
      item.backup.forEach((b) => urls.push(b));
    }
  };
  result.video.forEach(pushItem);
  result.audio.forEach(pushItem);
  result.other.forEach(pushItem);
  return urls;
}

function parseFrameRate(frameRate) {
  if (!frameRate) return null;
  if (typeof frameRate === "number") return frameRate;
  if (typeof frameRate === "string") {
    if (frameRate.includes("/")) {
      const [num, den] = frameRate.split("/");
      const n = Number(num);
      const d = Number(den);
      if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) {
        return n / d;
      }
    }
    const value = Number(frameRate);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function getVideoQualityTag(item) {
  const height = item.height;
  if (!height) return "";
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  if (height >= 1080) return "1080P";
  if (height >= 720) return "720P";
  if (height >= 480) return "480P";
  if (height >= 360) return "360P";
  if (height >= 240) return "240P";
  return `${height}P`;
}

function getDisplayLabel(kind, item) {
  if (kind === "video") {
    let label = getVideoQualityTag(item);
    const fps = parseFrameRate(item.frameRate);
    if (label && fps && fps >= 50) {
      label = `${label}60`;
    }
    return label ? `视频 ${label}` : "视频";
  }
  if (kind === "audio") {
    const kbps = item.bandwidth ? Math.round(item.bandwidth / 1000) : 0;
    return kbps ? `音频 ${kbps}kbps` : "音频";
  }
  return item.label || "其他";
}

function getSubLabel(item) {
  if (Array.isArray(item.backup) && item.backup.length) {
    return `备用 ${item.backup.length}`;
  }
  return "";
}

function renderList(listEl, items, kind, title) {
  listEl.innerHTML = "";
  items.forEach((item, index) => {
    const container = document.createElement("div");
    container.className = "item";
    container.style.animationDelay = `${index * 25}ms`;

    const main = document.createElement("div");
    main.className = "item-main";

    const titleEl = document.createElement("div");
    titleEl.className = "item-title";
    titleEl.textContent = getDisplayLabel(kind, item);

    const subLabel = getSubLabel(item);
    main.appendChild(titleEl);
    if (subLabel) {
      const sub = document.createElement("div");
      sub.className = "item-sub";
      sub.textContent = subLabel;
      main.appendChild(sub);
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.url);
      setStatus("已复制链接到剪贴板。");
    });

    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "下载";
    downloadBtn.className = "primary";
    downloadBtn.addEventListener("click", () => {
      if (!hasDownloads) {
        setStatus("下载功能不可用，请从扩展侧边栏打开。");
        return;
      }
      extensionApi.downloads.download({
        url: item.url,
        filename: buildFileName(title, kind, item),
        saveAs: true
      });
    });

    actions.appendChild(copyBtn);
    actions.appendChild(downloadBtn);

    container.appendChild(main);
    container.appendChild(actions);

    listEl.appendChild(container);
  });
}

function updateMergeButton(result) {
  if (result.video.length && result.audio.length) {
    mergeBestBtn.classList.remove("hidden");
  } else {
    mergeBestBtn.classList.add("hidden");
  }
}

function renderResult(result) {
  lastResult = result;
  pageTitleEl.textContent = result.title || "未命名";

  if (result.video.length) {
    videoTitle.textContent = `视频 (${result.video.length})`;
    renderList(videoList, result.video, "video", result.title);
    videoSection.classList.remove("hidden");
  } else {
    videoSection.classList.add("hidden");
  }

  if (result.audio.length) {
    audioTitle.textContent = `音频 (${result.audio.length})`;
    renderList(audioList, result.audio, "audio", result.title);
    audioSection.classList.remove("hidden");
  } else {
    audioSection.classList.add("hidden");
  }

  if (result.other.length) {
    otherTitle.textContent = `其他 (${result.other.length})`;
    renderList(otherList, result.other, "other", result.title);
    otherSection.classList.remove("hidden");
  } else {
    otherSection.classList.add("hidden");
  }

  updateMergeButton(result);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function saveCache(result, url) {
  lastResult = result;
  lastSavedAt = Date.now();
  lastUrl = url || "";
  await storageSet({
    lastResult,
    lastSavedAt,
    lastUrl
  });
}

async function loadCache() {
  const data = await storageGet(["lastResult", "lastSavedAt", "lastUrl"]);
  if (data.lastResult) {
    lastResult = data.lastResult;
    lastSavedAt = data.lastSavedAt || 0;
    lastUrl = data.lastUrl || "";
    renderResult(lastResult);
  }
  return data;
}

function pickBestVideo(items) {
  if (!items.length) return null;
  return items.reduce((best, item) => {
    if (!best) return item;
    const score =
      (item.height || 0) * 1_000_000 + (item.bandwidth || 0);
    const bestScore =
      (best.height || 0) * 1_000_000 + (best.bandwidth || 0);
    return score > bestScore ? item : best;
  }, null);
}

function pickBestAudio(items) {
  if (!items.length) return null;
  return items.reduce((best, item) => {
    if (!best) return item;
    return (item.bandwidth || 0) > (best.bandwidth || 0) ? item : best;
  }, null);
}

function loadScript(url, id) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-id="${id}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.dataset.id = id;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`加载失败：${url}`));
    document.head.appendChild(script);
  });
}

async function ensureFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    await loadScript(chrome.runtime.getURL("vendor/ffmpeg/ffmpeg.js"), "ffmpeg");

    if (!window.FFmpegWASM) {
      throw new Error("未检测到 FFmpeg 组件。");
    }

    const { FFmpeg } = window.FFmpegWASM;
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      if (message) {
        lastFfmpegLog = message;
      }
    });
    ffmpeg.on("progress", ({ progress }) => {
      if (!mergeInProgress) return;
      const ratio = clampNumber(Number(progress) || 0, 0, 1);
      const percent = 75 + ratio * 20;
      updateMergeProgress(percent, "正在合并音视频...");
    });
    const baseURL = chrome.runtime.getURL("vendor/ffmpeg-core");

    await ffmpeg.load({
      coreURL: `${baseURL}/ffmpeg-core.js`,
      wasmURL: `${baseURL}/ffmpeg-core.wasm`
    });

    ffmpegInstance = ffmpeg;
    return ffmpegInstance;
  })();

  return ffmpegLoading;
}

async function mergeBestMedia() {
  if (!inviteUnlocked) {
    showInviteGate();
    setStatus("请先输入邀请码。");
    return;
  }
  if (!lastResult) {
    setStatus("暂无缓存数据。");
    return;
  }
  const videoItem = pickBestVideo(lastResult.video);
  const audioItem = pickBestAudio(lastResult.audio);
  if (!videoItem || !audioItem) {
    setStatus("缺少音频或视频链接，无法合并。");
    return;
  }

  setMergeLoading(true);
  try {
    mergeInProgress = true;
    lastFfmpegLog = "";
    showMergeProgress();
    updateMergeProgress(2, "准备开始...");
    setStatus("准备 FFmpeg 组件...");
    updateMergeProgress(8, "加载 FFmpeg 组件...");
    const ffmpeg = await ensureFfmpeg();
    updateMergeProgress(15, "FFmpeg 已就绪，开始下载视频...");

    setStatus("下载视频中...");
    const videoFetch = await fetchMediaItem(videoItem, "视频", {
      onLineSwitch: (lineIndex) => {
        setStatus(`视频主链失败，已切换到备用线路 ${lineIndex + 1}`);
      },
      onProgress: createRangeProgressUpdater(15, 45, "下载视频中")
    });
    const videoData = videoFetch.bytes;
    updateMergeProgress(45, "视频下载完成，开始下载音频...");
    setStatus("下载音频中...");

    const audioFetch = await fetchMediaItem(audioItem, "音频", {
      onLineSwitch: (lineIndex) => {
        setStatus(`音频主链失败，已切换到备用线路 ${lineIndex + 1}`);
      },
      onProgress: createRangeProgressUpdater(45, 75, "下载音频中")
    });
    const audioData = audioFetch.bytes;

    const videoName = "video.m4s";
    const audioName = "audio.m4s";
    const outputName = "output.mp4";

    updateMergeProgress(76, "写入临时文件...");
    await ffmpeg.writeFile(videoName, videoData);
    await ffmpeg.writeFile(audioName, audioData);

    setStatus("合并中...");
    updateMergeProgress(78, "启动合并任务...");
    await ffmpeg.exec([
      "-i",
      videoName,
      "-i",
      audioName,
      "-c",
      "copy",
      outputName
    ]);

    updateMergeProgress(96, "读取合并结果...");
    const data = await ffmpeg.readFile(outputName);
    if (ffmpeg.deleteFile) {
      await ffmpeg.deleteFile(videoName);
      await ffmpeg.deleteFile(audioName);
      await ffmpeg.deleteFile(outputName);
    }

    const blob = new Blob([data], { type: "video/mp4" });
    updateMergeProgress(99, "准备下载合并文件...");
    downloadBlob(blob, buildMergedFileName(lastResult.title));
    updateMergeProgress(100, "完成");
    setStatus("合并完成，已开始下载。");
  } catch (error) {
    console.error("ffmpeg merge failed:", error);
    const message =
      error?.message ||
      (typeof error === "string" ? error : "") ||
      String(error);
    if (String(message).includes("403")) {
      updateMergeProgress(0, "失败：被防盗链拦截");
      setStatus("合并失败：下载被拒绝（可能是防盗链），可先下载再本地合并。");
    } else {
      const logHint = lastFfmpegLog ? ` | FFmpeg: ${lastFfmpegLog}` : "";
      updateMergeProgress(0, `失败：${message}`);
      setStatus(`合并失败：${message}${logHint}`);
    }
  } finally {
    mergeInProgress = false;
    setMergeLoading(false);
  }
}

async function fetchLinks() {
  if (!inviteUnlocked) {
    showInviteGate();
    setStatus("请先输入邀请码。");
    return;
  }
  setLoading(true);
  setStatus("正在获取链接...");
  try {
    if (!hasTabs || !hasScripting) {
      setStatus("请从扩展侧边栏打开以获取当前页信息。");
      return;
    }
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus("未找到当前标签页。");
      return;
    }
    if (!tab.url || !tab.url.startsWith("https://www.bilibili.com/")) {
      setStatus("请先打开 Bilibili 视频页面。");
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: extractPlayInfo
    });

    if (!results || !results.length) {
      setStatus("没有返回数据。");
      return;
    }

    const result = results[0].result;
    if (!result) {
      setStatus("返回结果为空。");
      return;
    }

    if (result.error) {
      setStatus(result.error);
      return;
    }

    renderResult(result);
    await saveCache(result, tab.url);
    setStatus(
      `已获取：视频 ${result.video.length}，音频 ${result.audio.length}，其他 ${result.other.length}`
    );
  } catch (error) {
    setStatus(`获取失败：${error.message}`);
  } finally {
    setLoading(false);
  }
}

copyAllBtn.addEventListener("click", async () => {
  if (!inviteUnlocked) {
    showInviteGate();
    setStatus("请先输入邀请码。");
    return;
  }
  if (!lastResult) {
    setStatus("暂无缓存数据。");
    return;
  }
  const urls = collectAllUrls(lastResult);
  if (!urls.length) {
    setStatus("没有可复制的链接。");
    return;
  }
  await navigator.clipboard.writeText(urls.join("\\n"));
  setStatus(`已复制 ${urls.length} 条链接。`);
});

mergeBestBtn.addEventListener("click", mergeBestMedia);
fetchBtn.addEventListener("click", fetchLinks);

async function initPanelData() {
  const data = await loadCache();
  const tab = await getActiveTab();
  if (data.lastResult) {
    const timeLabel = formatTime(lastSavedAt);
    if (tab?.url && lastUrl && tab.url !== lastUrl) {
      setStatus(`已加载缓存（${timeLabel}），当前页不同`);
    } else {
      setStatus(`已加载缓存（${timeLabel}）`);
    }
  } else {
    setStatus("暂无缓存，可点击获取。");
  }
}

async function verifyInviteCode() {
  const code = inviteInputEl.value.trim();
  if (code !== FIRST_USE_INVITE_CODE) {
    setInviteHint("邀请码错误，请重试。", true);
    inviteInputEl.focus();
    inviteInputEl.select();
    return;
  }

  inviteUnlocked = true;
  await storageSet({ [INVITE_UNLOCK_KEY]: true });
  hideInviteGate();
  setCoreActionsDisabled(false);
  setInviteHint("验证成功。", false);
  setStatus("邀请码验证通过，已解锁。");
  await initPanelData();
}

function bindInviteEvents() {
  inviteSubmitBtnEl.addEventListener("click", verifyInviteCode);
  inviteInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      verifyInviteCode();
    }
  });
}

async function initPanel() {
  if (!hasRuntime) {
    setStatus("请从扩展侧边栏打开该页面。");
    setCoreActionsDisabled(true);
    return;
  }

  const inviteData = await storageGet([INVITE_UNLOCK_KEY]);
  inviteUnlocked = inviteData[INVITE_UNLOCK_KEY] === true;
  if (!inviteUnlocked) {
    showInviteGate();
    setCoreActionsDisabled(true);
    setInviteHint("提示：邀请码区分大小写与空格。", false);
    setStatus("首次使用请先输入邀请码。");
    inviteInputEl.focus();
    return;
  }

  hideInviteGate();
  setCoreActionsDisabled(false);
  await initPanelData();
}

bindInviteEvents();
initPanel();

function extractPlayInfo() {
  const result = {
    title: "",
    video: [],
    audio: [],
    other: [],
    error: ""
  };

  const initialState = window.__INITIAL_STATE__ || {};
  result.title =
    document.querySelector("h1")?.textContent?.trim() ||
    initialState.videoData?.title ||
    document.title ||
    "";

  const normalizeUrlItem = (item) => ({
    id: item.id,
    url: item.baseUrl || item.base_url || item.url,
    backup: item.backupUrl || item.backup_url || [],
    width: item.width,
    height: item.height,
    frameRate: item.frameRate || item.frame_rate,
    bandwidth: item.bandwidth,
    codecs: item.codecs,
    mimeType: item.mimeType || item.mime_type
  });

  const parsePlayInfo = (playinfo) => {
    if (!playinfo || !playinfo.data) return;
    const dash = playinfo.data.dash;
    if (dash?.video?.length) {
      result.video = dash.video
        .map(normalizeUrlItem)
        .filter((item) => item.url);
    }
    if (dash?.audio?.length) {
      result.audio = dash.audio
        .map(normalizeUrlItem)
        .filter((item) => item.url);
    }
    if (Array.isArray(playinfo.data.durl)) {
      result.other = playinfo.data.durl
        .map((item) => ({
          id: item.order,
          url: item.url,
          backup: item.backup_url || [],
          label: item.order ? `分段 ${item.order}` : "其他"
        }))
        .filter((item) => item.url);
    }
  };

  const getPlayInfoFromWindow = () => {
    const playinfo = window.__playinfo__ || window.__PLAYINFO__ || null;
    if (!playinfo) return null;
    if (typeof playinfo === "string") {
      try {
        return JSON.parse(playinfo);
      } catch (error) {
        return null;
      }
    }
    return playinfo;
  };

  const findPlayInfoFromScripts = () => {
    const scripts = document.getElementsByTagName("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      const idx = text.indexOf("__playinfo__");
      if (idx === -1) continue;
      const json = extractJsonObject(text, idx);
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch (error) {
        return null;
      }
    }
    return null;
  };

  const extractJsonObject = (text, startIndex) => {
    const braceStart = text.indexOf("{", startIndex);
    if (braceStart === -1) return null;
    let depth = 0;
    let inString = false;
    let isEscaped = false;
    for (let i = braceStart; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (char === "\\\\") {
          isEscaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(braceStart, i + 1);
        }
      }
    }
    return null;
  };

  const playinfo = getPlayInfoFromWindow() || findPlayInfoFromScripts();
  if (!playinfo) {
    result.error = "未找到播放信息。";
    return result;
  }

  parsePlayInfo(playinfo);

  if (!result.video.length && !result.audio.length && !result.other.length) {
    result.error = "已找到播放信息，但没有检测到媒体链接。";
  }
  return result;
}
