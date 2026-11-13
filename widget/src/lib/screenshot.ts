import type { Point } from '../shared/types';

export interface Shot {
  blob: Blob;
  url: string;
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** An element to mark on the screenshot and the point it was clicked at. */
export interface Mark {
  el: Element;
  point: Point;
}

/** Draws a frame around each chosen element and a dot at its click point. */
function highlight(ctx: CanvasRenderingContext2D, scale: number, marks: { rect: DOMRect; point: Point }[]) {
  ctx.save();
  ctx.scale(scale, scale);
  for (const { rect, point } of marks) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#cd4246';
    ctx.strokeRect(rect.left - 3, rect.top - 3, rect.width + 6, rect.height + 6);
    ctx.fillStyle = '#cd4246';
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  ctx.restore();
}

/** Fits the image under maxBytes: WebP (or JPEG), lowering quality, then size. */
export async function fit(source: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  let canvas = source;
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = (await encode(canvas, 'image/webp', quality)) ?? (await encode(canvas, 'image/jpeg', quality));
      if (blob && blob.size <= maxBytes) return blob;
    }
    const smaller = document.createElement('canvas');
    smaller.width = Math.round(canvas.width * 0.75);
    smaller.height = Math.round(canvas.height * 0.75);
    smaller.getContext('2d')!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    canvas = smaller;
  }
  throw new Error('screenshot is too large');
}

/**
 * Renders the visible part of the page (not the widget) to an image with the elements marked.
 * DOM rendering cannot draw cross-origin images without CORS or closed shadow roots; those parts
 * come out blank, which is still useful.
 */
export async function captureViewport(exclude: Element, marks: Mark[], maxBytes: number): Promise<Shot> {
  const { domToCanvas } = await import('modern-screenshot');
  const rects = marks.map((m) => ({ rect: m.el.getBoundingClientRect(), point: m.point }));
  const width = innerWidth;
  const height = innerHeight;
  const scale = Math.min(devicePixelRatio || 1, 1600 / width, 2);
  const canvas = await domToCanvas(document.documentElement, {
    width,
    height,
    scale,
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    filter: (node) => node !== exclude,
    style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
    features: { restoreScrollPosition: true },
    timeout: 8000,
    workerNumber: 0,
  });
  highlight(canvas.getContext('2d')!, scale, rects);
  const blob = await fit(canvas, maxBytes);
  return { blob, url: URL.createObjectURL(blob) };
}

/**
 * Asks the browser for a real screen capture of this tab (a permission prompt), for pages the DOM
 * renderer draws badly.
 */
export async function captureTab(maxBytes: number): Promise<Shot> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: false,
    // Chrome: offer the current tab first.
    ...({ preferCurrentTab: true } as object),
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const blob = await fit(canvas, maxBytes);
    return { blob, url: URL.createObjectURL(blob) };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * A real thumbnail of the page for the screen map: the top of the document as the window shows
 * it, rendered from the DOM about width pixels wide, without the widget. doc may be the document of
 * a same-origin frame: the crawler takes looks of the app it walks in one.
 */
export async function captureThumbnail(
  exclude: Element | null,
  width: number,
  maxBytes: number,
  doc: Document = document,
): Promise<Blob> {
  const { domToCanvas } = await import('modern-screenshot');
  const win = doc.defaultView ?? window;
  const scale = Math.min(1, width / win.innerWidth);
  const canvas = await domToCanvas(doc.documentElement, {
    width: win.innerWidth,
    height: win.innerHeight,
    scale,
    backgroundColor: (doc.body && win.getComputedStyle(doc.body).backgroundColor) || '#ffffff',
    filter: (node) => node !== exclude,
    features: { restoreScrollPosition: true },
    timeout: 8000,
    workerNumber: 0,
  });
  return fit(canvas, maxBytes);
}
