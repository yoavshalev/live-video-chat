/** Every element the call page touches, looked up once. Markup: src/routes/call.tsx. */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

export const els = {
  // The pre-call check and every other full-stage message.
  overlay: $<HTMLDivElement>('overlay'),
  title: $<HTMLHeadingElement>('overlay-title'),
  body: $<HTMLParagraphElement>('overlay-body'),
  error: $<HTMLDivElement>('overlay-error'),
  preview: $<HTMLVideoElement>('preview'),
  devices: $<HTMLDivElement>('device-row'),
  cameraSelect: $<HTMLSelectElement>('camera-select'),
  micSelect: $<HTMLSelectElement>('mic-select'),
  previewLevel: $<HTMLElement>('preview-level'),
  previewLabel: $<HTMLElement>('preview-label'),
  previewSpeakerWrap: $<HTMLElement>('preview-speaker-wrap'),
  previewSpeaker: $<HTMLSelectElement>('preview-speaker'),
  previewSpeakerTest: $<HTMLButtonElement>('preview-speaker-test'),
  previewSpeakerHint: $<HTMLElement>('preview-speaker-hint'),
  autoJoinWrap: $<HTMLElement>('auto-join-wrap'),
  autoJoin: $<HTMLInputElement>('auto-join'),
  join: $<HTMLButtonElement>('btn-join'),
  retry: $<HTMLButtonElement>('btn-retry'),
  abandon: $<HTMLButtonElement>('btn-abandon'),
  newTab: $<HTMLAnchorElement>('btn-newtab'),

  // The stage.
  remote: $<HTMLVideoElement>('remote'),
  remoteAudio: $<HTMLAudioElement>('remote-audio'),
  shareAudio: $<HTMLAudioElement>('share-audio'),
  hear: $<HTMLButtonElement>('btn-hear'),
  share: $<HTMLVideoElement>('share'),
  sharePill: $<HTMLDivElement>('share-pill'),
  stage: $<HTMLDivElement>('stage'),
  local: $<HTMLVideoElement>('local'),
  peerName: $<HTMLDivElement>('peer-name'),
  peerHint: $<HTMLDivElement>('peer-hint'),
  timer: $<HTMLDivElement>('timer'),
  elapsed: $<HTMLSpanElement>('elapsed'),
  micOff: $<HTMLDivElement>('mic-off'),
  micOffText: $<HTMLElement>('mic-off-text'),
  micOffFix: $<HTMLButtonElement>('mic-off-fix'),

  // Controls.
  controls: $<HTMLDivElement>('controls'),
  mic: $<HTMLButtonElement>('btn-mic'),
  micLabel: $<HTMLElement>('mic-label'),
  cam: $<HTMLButtonElement>('btn-cam'),
  shareButton: $<HTMLButtonElement>('btn-share'),
  settingsButton: $<HTMLButtonElement>('btn-settings'),
  leave: $<HTMLButtonElement>('btn-leave'),

  // The in-call settings panel.
  settings: $<HTMLDivElement>('settings'),
  settingsClose: $<HTMLButtonElement>('settings-close'),
  audioStatus: $<HTMLElement>('audio-status'),
  callMic: $<HTMLSelectElement>('call-mic'),
  callCam: $<HTMLSelectElement>('call-cam'),
  speakerWrap: $<HTMLDivElement>('speaker-wrap'),
  callSpeaker: $<HTMLSelectElement>('call-speaker'),
  callSpeakerTest: $<HTMLButtonElement>('call-speaker-test'),
  micLevel: $<HTMLElement>('mic-level'),
  micLevelLabel: $<HTMLElement>('mic-level-label'),
  remoteLevel: $<HTMLElement>('remote-level'),
  remoteLevelLabel: $<HTMLElement>('remote-level-label'),
  autoJoinCallWrap: $<HTMLElement>('auto-join-call-wrap'),
  autoJoinCall: $<HTMLInputElement>('auto-join-call'),
  settingsHint: $<HTMLElement>('settings-hint')
}

/** An <audio>/<video> that may let a page choose its output device. */
export type Sinkable = HTMLMediaElement & { sinkId?: string; setSinkId?(id: string): Promise<void> }
