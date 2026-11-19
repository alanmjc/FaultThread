import type { Options } from '@openreplay/tracker/class'

// A public region can reveal its text and images. Keep editable controls private even there.
const privateElements = [
  'input', 'textarea', 'select', 'option', '[contenteditable]:not([contenteditable="false" i])',
  ...['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'switch',
    'slider', 'listbox', 'option'].map(role => `[role~="${role}" i]`),
  'iframe', 'object', 'embed', 'video', 'audio', 'canvas:not([data-openreplay-unmask])',
].join(',')

export function replayOptions(projectKey: string, ingestPoint?: string): Partial<Options> {
  // CSS and image messages have their own base URL, separate from page navigation.
  const assetBase = new URL(document.querySelector('base[href]')?.getAttribute('href') ?? '/', window.location.href)
  assetBase.search = ''
  assetBase.hash = ''
  assetBase.username = ''
  assetBase.password = ''

  return {
    projectKey,
    ...(ingestPoint ? { ingestPoint } : {}),
    resourceBaseHref: assetBase.href,
    respectDoNotTrack: true,
    forceSingleTab: true,
    flushInterval: 1000,
    privateMode: true,
    defaultInputMode: 2,
    obscureInputEmails: true,
    obscureInputNumbers: true,
    obscureInputDates: true,
    obscureTextEmails: true,
    obscureTextNumbers: true,
    domSanitizer: element => element.ownerDocument !== document || element.matches(privateElements) ? 2 : 0,
    urls: { urlSanitizer: () => '', titleSanitizer: () => '' },
    network: {
      disabled: true, sessionTokenHeader: false, failuresOnly: false,
      ignoreHeaders: true, capturePayload: false, captureInIframes: false,
    },
    consoleMethods: [],
    captureExceptions: false,
    captureResourceTimings: false,
    capturePageLoadTimings: false,
    capturePageRenderTimings: false,
    capturePerformance: false,
    longTasks: false,
    analytics: { active: false },
    captureIFrames: false,
    crossdomain: { enabled: false },
    canvas: { disableCanvas: false, fixedCanvasScaling: false, useAnimationFrame: true },
    mouse: { trackingOffset: 1, disableClickmaps: true },
    webAnimations: { allElements: true },
    inlineCss: 1,
    css: { scanInMemoryCSS: true },
    disableThrottling: true,
  }
}
