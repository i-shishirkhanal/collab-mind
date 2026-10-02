"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { LocalParticipant, Participant, RemoteParticipant, Room, RoomEvent, Track } from "livekit-client";
import { Loader2, Mic, MicOff, Monitor, MonitorOff, PhoneOff, Video, VideoOff, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Initials } from "./Initials";
import type { Call } from "@/types/messaging";

type Phase = "connecting" | "connected" | "reconnecting" | "failed";

/** Attaches a LiveKit track to a media element for the lifetime of the component. */
function TrackMedia({
  participant, source, muted, className,
}: { participant: Participant; source: Track.Source; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const track = participant.getTrackPublication(source)?.track;

  useEffect(() => {
    const el = ref.current;
    if (!track || !el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);

  if (!track) return null;
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

/** Remote microphones must be attached to an element or nothing is audible. */
function RemoteAudio({ participant }: { participant: Participant }) {
  const ref = useRef<HTMLAudioElement>(null);
  const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
  useEffect(() => {
    const el = ref.current;
    if (!track || !el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return track ? <audio ref={ref} autoPlay /> : null;
}

function Tile({ participant, isLocal }: { participant: Participant; isLocal: boolean }) {
  const camOn = participant.isCameraEnabled;
  const micOn = participant.isMicrophoneEnabled;
  const name = participant.name || participant.identity;
  return (
    <div
      className={cn(
        "relative rounded-2xl overflow-hidden bg-slate-900 border aspect-video flex items-center justify-center",
        participant.isSpeaking ? "border-indigo-500 ring-2 ring-indigo-500/40" : "border-slate-800",
      )}
    >
      {camOn ? (
        <TrackMedia
          participant={participant}
          source={Track.Source.Camera}
          muted={isLocal}
          className={cn("w-full h-full object-cover", isLocal && "-scale-x-100")}
        />
      ) : (
        <Initials name={name} className="w-20 h-20 text-lg" />
      )}
      {!isLocal && <RemoteAudio participant={participant} />}
      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2">
        <span className="px-2 py-1 rounded-md bg-black/60 text-xs text-white truncate">
          {name}{isLocal ? " (you)" : ""}
        </span>
        {!micOn && (
          <span className="p-1 rounded-md bg-red-500/80 text-white" title="Muted">
            <MicOff className="w-3.5 h-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}

const formatElapsed = (s: number) =>
  `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

export function CallRoom({
  call, token, url, isHost, title, onLeave, onEndForAll,
}: {
  call: Call;
  token: string;
  url: string;
  isHost: boolean;
  title: string;
  onLeave: () => void;
  onEndForAll: () => void;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const wantsVideo = call.kind === "video";

  useEffect(() => {
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });

    const refresh = () => { if (!cancelled) rerender(); };
    [
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
    ].forEach((ev) => room.on(ev, refresh));

    room.on(RoomEvent.Reconnecting, () => !cancelled && setPhase("reconnecting"));
    room.on(RoomEvent.Reconnected, () => !cancelled && setPhase("connected"));
    room.on(RoomEvent.Disconnected, () => {
      // Server-side removal (call ended for everyone, token expired, network lost for good).
      if (!cancelled) onLeave();
    });

    (async () => {
      try {
        await room.connect(url, token);
        if (cancelled) return;
        setRoom(room);
        setPhase("connected");
        // Device failures (no mic, permission denied) shouldn't drop the user out of the call.
        await room.localParticipant.setMicrophoneEnabled(true).catch(() => setNotice("Microphone unavailable — you are muted."));
        if (wantsVideo) {
          await room.localParticipant.setCameraEnabled(true).catch(() => setNotice("Camera unavailable — joined without video."));
        }
        refresh();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not connect to the call.");
        setPhase("failed");
      }
    })();

    return () => {
      cancelled = true;
      room.removeAllListeners();
      room.disconnect();
    };
    // The credentials are fixed for the lifetime of this mounted call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id, token, url]);

  useEffect(() => {
    if (phase !== "connected") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const local: LocalParticipant | undefined = room?.localParticipant;
  const remotes: RemoteParticipant[] = room ? Array.from(room.remoteParticipants.values()) : [];
  const everyone: Participant[] = local ? [local, ...remotes] : remotes;
  const sharer = everyone.find((p) => p.isScreenShareEnabled);

  const toggle = useCallback(async (kind: "mic" | "cam" | "screen") => {
    const lp = room?.localParticipant;
    if (!lp) return;
    try {
      setNotice(null);
      if (kind === "mic") await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
      if (kind === "cam") await lp.setCameraEnabled(!lp.isCameraEnabled);
      if (kind === "screen") await lp.setScreenShareEnabled(!lp.isScreenShareEnabled);
    } catch (err) {
      const denied = err instanceof Error && /permission|denied|NotAllowed/i.test(`${err.name} ${err.message}`);
      setNotice(denied ? "Permission was denied by the browser." : "That device isn't available.");
    } finally {
      rerender();
    }
  }, [room]);

  const canShareScreen = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const connecting = phase === "connecting";

  return (
    <div className="fixed inset-0 z-[60] bg-slate-950 flex flex-col text-slate-50" role="dialog" aria-label={`Call: ${title}`}>
      <header className="h-14 shrink-0 px-4 flex items-center justify-between border-b border-slate-800/60 bg-slate-900/70">
        <div className="min-w-0">
          <div className="font-semibold truncate">{title}</div>
          <div className="text-xs text-slate-400 flex items-center gap-2">
            {phase === "connected" && <span>{formatElapsed(elapsed)}</span>}
            {phase === "reconnecting" && <span className="text-amber-400">Reconnecting…</span>}
            {connecting && <span>Connecting…</span>}
            <span className="flex items-center gap-1"><Users className="w-3 h-3" />{everyone.length || 1}</span>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto p-3 md:p-6">
        {phase === "failed" ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
            <p className="text-red-400 max-w-md">{error}</p>
            <Button onClick={onLeave} variant="outline" className="border-slate-700 text-slate-200">Close</Button>
          </div>
        ) : connecting ? (
          <div className="h-full flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>
        ) : (
          <div className="max-w-6xl mx-auto space-y-3">
            {sharer && (
              <div className="rounded-2xl overflow-hidden bg-black border border-slate-800">
                <TrackMedia
                  participant={sharer}
                  source={Track.Source.ScreenShare}
                  muted
                  className="w-full max-h-[60vh] object-contain"
                />
                <div className="px-3 py-1.5 text-xs text-slate-300 bg-slate-900">
                  {sharer.isLocal ? "You are" : `${sharer.name || sharer.identity} is`} sharing their screen
                </div>
              </div>
            )}
            <div className={cn(
              "grid gap-3",
              everyone.length <= 1 ? "grid-cols-1 max-w-xl mx-auto"
                : everyone.length <= 4 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 lg:grid-cols-3",
            )}>
              {everyone.map((p) => <Tile key={p.sid || p.identity} participant={p} isLocal={p.isLocal} />)}
            </div>
            {remotes.length === 0 && (
              <p className="text-center text-sm text-slate-400">Waiting for others to join…</p>
            )}
          </div>
        )}
      </main>

      {notice && (
        <div className="mx-auto mb-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
          {notice}
        </div>
      )}

      <footer className="shrink-0 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-slate-800/60 bg-slate-900/70 flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
        <Button
          variant="outline" size="icon-lg" aria-label={local?.isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
          onClick={() => toggle("mic")} disabled={phase === "failed" || connecting}
          className={cn("rounded-full border-slate-700", !local?.isMicrophoneEnabled && "bg-red-500/20 text-red-400 border-red-500/40")}
        >
          {local?.isMicrophoneEnabled ? <Mic /> : <MicOff />}
        </Button>
        <Button
          variant="outline" size="icon-lg" aria-label={local?.isCameraEnabled ? "Turn camera off" : "Turn camera on"}
          onClick={() => toggle("cam")} disabled={phase === "failed" || connecting}
          className={cn("rounded-full border-slate-700", !local?.isCameraEnabled && "bg-slate-800 text-slate-300")}
        >
          {local?.isCameraEnabled ? <Video /> : <VideoOff />}
        </Button>
        {canShareScreen && (
          <Button
            variant="outline" size="icon-lg" aria-label={local?.isScreenShareEnabled ? "Stop sharing screen" : "Share screen"}
            onClick={() => toggle("screen")} disabled={phase === "failed" || connecting}
            className={cn("rounded-full border-slate-700 hidden sm:inline-flex", local?.isScreenShareEnabled && "bg-indigo-500/20 text-indigo-300 border-indigo-500/40")}
          >
            {local?.isScreenShareEnabled ? <MonitorOff /> : <Monitor />}
          </Button>
        )}
        <Button onClick={onLeave} aria-label="Leave call" size="lg" className="rounded-full bg-red-600 hover:bg-red-700 text-white px-5">
          <PhoneOff className="mr-1" /> Leave
        </Button>
        {isHost && call.conversation_type === "group" && (
          <Button onClick={onEndForAll} variant="outline" size="lg" className="rounded-full border-red-500/40 text-red-400 hover:bg-red-500/10">
            End for all
          </Button>
        )}
      </footer>
    </div>
  );
}
