import { ref } from 'vue'
import { api } from '@/utils/api'
import type { WebRtcSignalPayload } from '../../shared/types'

type VoiceTurnContext = {
  token: string
  roomId: string
  myUserId: string
  isSpeechPhase: boolean
  activeSpeakerUserId: string | null
  audienceUserIds: string[]
}

const MOBILE_RE = /Android|iPhone|iPad|iPod|Mobile/i

function isMobileDevice() {
  if (typeof navigator === 'undefined') return false
  return MOBILE_RE.test(navigator.userAgent)
}

function normalizeSdp(input: unknown): RTCSessionDescriptionInit | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (typeof raw.type !== 'string') return null
  return {
    type: raw.type as RTCSdpType,
    sdp: typeof raw.sdp === 'string' ? raw.sdp : undefined,
  }
}

function normalizeCandidate(input: unknown): RTCIceCandidateInit | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (typeof raw.candidate !== 'string') return null
  return {
    candidate: raw.candidate,
    sdpMid: typeof raw.sdpMid === 'string' ? raw.sdpMid : null,
    sdpMLineIndex: typeof raw.sdpMLineIndex === 'number' ? raw.sdpMLineIndex : null,
    usernameFragment: typeof raw.usernameFragment === 'string' ? raw.usernameFragment : undefined,
  }
}

export function useVoiceRtc() {
  const micEnabled = ref(false)
  const statusText = ref('语音待机')
  const errorText = ref('')
  const connectedPeers = ref(0)
  const audioUnlocked = ref(!isMobileDevice())
  const pendingPlayback = ref(false)

  const peers = new Map<string, RTCPeerConnection>()
  const pendingCandidates = new Map<string, RTCIceCandidateInit[]>()
  const remoteAudios = new Map<string, HTMLAudioElement>()
  const blockedAudioElements = new Set<HTMLAudioElement>()
  let localStream: MediaStream | null = null
  let audioContext: AudioContext | null = null
  let currentContext: VoiceTurnContext | null = null
  let currentSpeakerUserId: string | null = null
  let buildVersion = 0

  function setError(message: string) {
    errorText.value = message
  }

  function clearError() {
    errorText.value = ''
  }

  function updatePeerCount() {
    connectedPeers.value = peers.size
  }

  async function primeAudioOutput() {
    const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) return
    if (!audioContext) {
      audioContext = new AudioContextCtor()
    }
    try {
      await audioContext.resume()
    } catch {
      // ignore resume failure
    }
    try {
      const osc = audioContext.createOscillator()
      const gain = audioContext.createGain()
      gain.gain.value = 0.00001
      osc.frequency.value = 440
      osc.connect(gain)
      gain.connect(audioContext.destination)
      osc.start()
      osc.stop(audioContext.currentTime + 0.03)
    } catch {
      // ignore tone init failure
    }
  }

  function getSignalContext() {
    if (!currentContext) throw new Error('语音上下文未初始化')
    if (!currentContext.token || !currentContext.roomId) throw new Error('语音上下文缺失')
    return currentContext
  }

  async function sendSignal(targetUserId: string, signal: WebRtcSignalPayload) {
    const ctx = getSignalContext()
    await api.wsWebrtcSignal(ctx.token, ctx.roomId, targetUserId, signal)
  }

  async function ensureLocalStream() {
    if (localStream) return localStream
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前设备不支持麦克风')
    }
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
    return localStream
  }

  function releaseLocalStream() {
    if (!localStream) return
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    localStream = null
  }

  async function tryPlayAudio(audio: HTMLAudioElement) {
    if (!audioUnlocked.value) {
      blockedAudioElements.add(audio)
      pendingPlayback.value = true
      return
    }
    try {
      await audio.play()
      blockedAudioElements.delete(audio)
      pendingPlayback.value = blockedAudioElements.size > 0
    } catch {
      blockedAudioElements.add(audio)
      pendingPlayback.value = true
    }
  }

  async function attachRemoteStream(remoteUserId: string, stream: MediaStream) {
    let audio = remoteAudios.get(remoteUserId)
    if (!audio) {
      audio = document.createElement('audio')
      audio.autoplay = true
      audio.setAttribute('autoplay', 'true')
      audio.setAttribute('playsinline', 'true')
      ;(audio as any).playsInline = true
      audio.controls = false
      audio.volume = 1
      audio.muted = false
      audio.style.position = 'fixed'
      audio.style.width = '1px'
      audio.style.height = '1px'
      audio.style.opacity = '0'
      audio.style.pointerEvents = 'none'
      audio.onloadedmetadata = () => {
        void tryPlayAudio(audio!)
      }
      document.body.appendChild(audio)
      remoteAudios.set(remoteUserId, audio)
    }
    audio.srcObject = stream
    await tryPlayAudio(audio)
  }

  function clearRemoteAudio(remoteUserId: string) {
    const audio = remoteAudios.get(remoteUserId)
    if (!audio) return
    blockedAudioElements.delete(audio)
    try {
      audio.pause()
      audio.srcObject = null
      audio.remove()
    } catch {
      // ignore
    }
    remoteAudios.delete(remoteUserId)
    pendingPlayback.value = blockedAudioElements.size > 0
  }

  async function flushPendingCandidates(remoteUserId: string, pc: RTCPeerConnection) {
    const list = pendingCandidates.get(remoteUserId)
    if (!list?.length) return
    pendingCandidates.delete(remoteUserId)
    for (const candidate of list) {
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        // ignore invalid candidates
      }
    }
  }

  function queueCandidate(remoteUserId: string, candidate: RTCIceCandidateInit) {
    const list = pendingCandidates.get(remoteUserId) ?? []
    list.push(candidate)
    pendingCandidates.set(remoteUserId, list)
  }

  function closePeer(remoteUserId: string) {
    const pc = peers.get(remoteUserId)
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.oniceconnectionstatechange = null
      pc.close()
      peers.delete(remoteUserId)
    }
    pendingCandidates.delete(remoteUserId)
    clearRemoteAudio(remoteUserId)
    updatePeerCount()
  }

  function closeAllPeers() {
    for (const remoteUserId of [...peers.keys()]) {
      closePeer(remoteUserId)
    }
  }

  function createPeer(remoteUserId: string, withLocalAudio: boolean) {
    closePeer(remoteUserId)

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      ],
    })

    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      void sendSignal(remoteUserId, { type: 'candidate', candidate: event.candidate.toJSON() }).catch(() => {})
    }

    pc.ontrack = (event) => {
      const [stream] = event.streams
      if (!stream) return
      void attachRemoteStream(remoteUserId, stream)
    }

    pc.onconnectionstatechange = () => {
      updatePeerCount()
      const state = pc.connectionState
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        closePeer(remoteUserId)
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        closePeer(remoteUserId)
      }
    }

    if (withLocalAudio && localStream) {
      for (const track of localStream.getAudioTracks()) {
        pc.addTrack(track, localStream)
      }
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }

    peers.set(remoteUserId, pc)
    updatePeerCount()
    return pc
  }

  function isPeerHealthy(pc: RTCPeerConnection | undefined) {
    if (!pc) return false
    const c = pc.connectionState
    const i = pc.iceConnectionState
    if (c === 'closed' || c === 'failed' || c === 'disconnected') return false
    if (i === 'closed' || i === 'failed' || i === 'disconnected') return false
    return true
  }

  async function ensureSpeakerPeer(remoteUserId: string) {
    const pc = createPeer(remoteUserId, true)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const sdp = pc.localDescription?.toJSON() ?? { type: offer.type, sdp: offer.sdp ?? '' }
    await sendSignal(remoteUserId, { type: 'offer', sdp })
  }

  async function syncSpeakerConnections(forceRecreate = false) {
    const ctx = getSignalContext()
    if (!ctx.isSpeechPhase || !ctx.activeSpeakerUserId || ctx.myUserId !== ctx.activeSpeakerUserId) {
      throw new Error('仅当前发言者可开麦')
    }

    buildVersion += 1
    const version = buildVersion
    statusText.value = '正在建立语音连接'

    const targets = [...new Set(ctx.audienceUserIds)].filter((uid) => uid && uid !== ctx.myUserId)
    const targetSet = new Set(targets)

    for (const remoteUserId of [...peers.keys()]) {
      if (!targetSet.has(remoteUserId)) {
        closePeer(remoteUserId)
      }
    }

    if (!targets.length) {
      statusText.value = '已开麦（暂无听众）'
      return
    }

    for (const targetUserId of targets) {
      if (version !== buildVersion) return
      try {
        const existing = peers.get(targetUserId)
        if (!forceRecreate && isPeerHealthy(existing)) continue
        await ensureSpeakerPeer(targetUserId)
      } catch {
        closePeer(targetUserId)
      }
    }

    if (version === buildVersion) {
      statusText.value = peers.size ? '语音通话中' : '语音连接中'
    }
  }

  async function updateTurnContext(context: VoiceTurnContext) {
    currentContext = context
    const previousSpeaker = currentSpeakerUserId
    currentSpeakerUserId = context.activeSpeakerUserId

    if (!context.isSpeechPhase || !context.activeSpeakerUserId) {
      if (micEnabled.value) {
        micEnabled.value = false
        releaseLocalStream()
      }
      closeAllPeers()
      statusText.value = '等待发言阶段'
      return
    }

    if (previousSpeaker && previousSpeaker !== context.activeSpeakerUserId) {
      closeAllPeers()
    }

    if (micEnabled.value && context.myUserId !== context.activeSpeakerUserId) {
      micEnabled.value = false
      releaseLocalStream()
      closeAllPeers()
      statusText.value = '当前为收听状态'
      return
    }

    if (micEnabled.value && context.myUserId === context.activeSpeakerUserId) {
      await syncSpeakerConnections(false).catch(() => {
        setError('语音连接失败，请重试')
      })
      return
    }

    statusText.value = context.myUserId === context.activeSpeakerUserId ? '轮到你发言，可开麦' : '收听当前发言者'
  }

  async function setMicEnabled(enabled: boolean, context: VoiceTurnContext) {
    clearError()
    currentContext = context
    currentSpeakerUserId = context.activeSpeakerUserId

    if (!enabled) {
      micEnabled.value = false
      releaseLocalStream()
      closeAllPeers()
      statusText.value = context.isSpeechPhase ? '已关闭麦克风' : '等待发言阶段'
      return
    }

    if (!context.isSpeechPhase || !context.activeSpeakerUserId) {
      throw new Error('当前不是发言阶段')
    }
    if (context.myUserId !== context.activeSpeakerUserId) {
      throw new Error('未轮到你发言')
    }

    await ensureLocalStream()
    micEnabled.value = true
    closeAllPeers()
    await syncSpeakerConnections(true)
    statusText.value = '已开麦'
  }

  async function applyCandidate(fromUserId: string, candidate: RTCIceCandidateInit) {
    const pc = peers.get(fromUserId)
    if (!pc || !pc.remoteDescription) {
      queueCandidate(fromUserId, candidate)
      return
    }
    try {
      await pc.addIceCandidate(candidate)
    } catch {
      // ignore invalid candidates
    }
  }

  async function handleSignal(fromUserId: string, signal: WebRtcSignalPayload, context: VoiceTurnContext) {
    currentContext = context
    currentSpeakerUserId = context.activeSpeakerUserId
    const speakerId = context.activeSpeakerUserId ?? currentSpeakerUserId
    const isMeSpeaker = !!speakerId && context.myUserId === speakerId
    const fromSpeaker = !!speakerId && fromUserId === speakerId

    if (signal.type === 'offer') {
      // Trust server-side permission checks and accept valid offers,
      // so client-side state lag won't drop the first packet.
      if (isMeSpeaker) return
      const remoteDesc = normalizeSdp(signal.sdp)
      if (!remoteDesc) return
      const pc = createPeer(fromUserId, false)
      await pc.setRemoteDescription(remoteDesc)
      await flushPendingCandidates(fromUserId, pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      const sdp = pc.localDescription?.toJSON() ?? { type: answer.type, sdp: answer.sdp ?? '' }
      await sendSignal(fromUserId, { type: 'answer', sdp })
      statusText.value = '正在收听语音'
      return
    }

    if (signal.type === 'answer') {
      const remoteDesc = normalizeSdp(signal.sdp)
      if (!remoteDesc) return
      const pc = peers.get(fromUserId)
      if (!pc) return
      await pc.setRemoteDescription(remoteDesc)
      await flushPendingCandidates(fromUserId, pc)
      statusText.value = '语音通话中'
      return
    }

    if (signal.type === 'candidate') {
      const candidate = normalizeCandidate(signal.candidate)
      if (!candidate) return
      await applyCandidate(fromUserId, candidate)
    }
  }

  async function unlockAudioPlayback() {
    await primeAudioOutput()
    audioUnlocked.value = true
    for (const audio of [...blockedAudioElements]) {
      try {
        audio.muted = false
        await audio.play()
        blockedAudioElements.delete(audio)
      } catch {
        // ignore, keep pending
      }
    }
    pendingPlayback.value = blockedAudioElements.size > 0
  }

  function dispose() {
    micEnabled.value = false
    releaseLocalStream()
    closeAllPeers()
    currentContext = null
    currentSpeakerUserId = null
    blockedAudioElements.clear()
    pendingPlayback.value = false
    statusText.value = '语音待机'
  }

  return {
    micEnabled,
    statusText,
    errorText,
    connectedPeers,
    audioUnlocked,
    pendingPlayback,
    setMicEnabled,
    updateTurnContext,
    handleSignal,
    unlockAudioPlayback,
    dispose,
  }
}
