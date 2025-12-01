"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as Ably from "ably";
import * as Tone from "tone";
import { nanoid } from "nanoid";
import clsx from "clsx";

type Instrument = "drums" | "keys" | "bass";
type MelodicInstrument = Exclude<Instrument, "drums">;
type DrumRow = "kick" | "snare" | "hat" | "clap";

type Note = {
  id: string;
  pitch: string;
  step: number;
  duration: number;
  velocity: number;
};

type Loop = {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  instrument: Instrument;
  notes: Note[];
  synthParams?: Record<string, unknown>;
  createdAt: number;
};

type Turn = {
  userId: string;
  startedAt: number;
  endsAt: number;
};

type SessionState = {
  bpm: number;
  loops: Loop[];
  activeTurn: Turn | null;
  version: number;
  creatorId: string | null;
  windowCycles: number;
  playbackStartedAt: number | null; // Timestamp when session playback started (null = paused)
};

type Participant = {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
};

type Identity = {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
};

const STEP_COUNT = 16;
const DRUM_LOOP_LIMIT = 4;
const MELODIC_LOOP_LIMIT = 2;
const NAME_SEEDS = [
  "Echo",
  "Pulse",
  "Circuit",
  "Pixel",
  "Orbit",
  "Tape",
  "Quartz",
  "Neon",
];
const PALETTE = ["#ffb300", "#ff5e6c", "#45d4e5", "#4f7bff", "#6ef3b7"];
const DRUM_ROWS: { id: DrumRow; label: string; accent: string }[] = [
  { id: "kick", label: "BD", accent: "#ffb300" },
  { id: "snare", label: "SD", accent: "#ff5e6c" },
  { id: "hat", label: "HH", accent: "#45d4e5" },
  { id: "clap", label: "CP", accent: "#4f7bff" },
];

const ROOT_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALE_TYPES: { id: string; label: string; intervals: number[] }[] = [
  { id: "major", label: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: "minor", label: "Minor", intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: "dorian", label: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: "pentatonic", label: "Penta", intervals: [0, 2, 4, 7, 9] },
  { id: "blues", label: "Blues", intervals: [0, 3, 5, 6, 7, 10] },
];
const OCTAVES = [1, 2, 3, 4, 5];

// Convert MIDI note number to note name (e.g., 60 -> "C4")
const midiToNoteName = (midi: number): string => {
  const octave = Math.floor(midi / 12) - 1;
  const noteIndex = midi % 12;
  return `${ROOT_NOTES[noteIndex]}${octave}`;
};

// Convert note name to MIDI number (e.g., "C4" -> 60)
const noteNameToMidi = (note: string): number => {
  const match = note.match(/^([A-G]#?)(\d+)$/);
  if (!match) return 60;
  const [, noteName, octaveStr] = match;
  const noteIndex = ROOT_NOTES.indexOf(noteName);
  const octave = parseInt(octaveStr, 10);
  return (octave + 1) * 12 + noteIndex;
};

const generateScaleNotes = (root: string, scaleType: string, octave: number, noteCount = 8): string[] => {
  const scale = SCALE_TYPES.find((s) => s.id === scaleType) ?? SCALE_TYPES[0];
  const rootIndex = ROOT_NOTES.indexOf(root);
  if (rootIndex === -1) return [];
  
  const notes: string[] = [];
  let currentOctave = octave;
  let intervalIndex = 0;
  
  while (notes.length < noteCount) {
    const semitone = scale.intervals[intervalIndex % scale.intervals.length];
    const noteIndex = (rootIndex + semitone) % 12;
    const noteName = ROOT_NOTES[noteIndex];
    const noteOctave = currentOctave + Math.floor((rootIndex + semitone) / 12);
    notes.push(`${noteName}${noteOctave}`);
    intervalIndex++;
    if (intervalIndex % scale.intervals.length === 0) {
      currentOctave++;
    }
  }
  return notes;
};

// Generate all scale notes across multiple octaves, then slice from baseMidi
const generateScaleFromMidi = (baseMidi: number, scaleType: string, rootNote: string, noteCount = 8): string[] => {
  const scale = SCALE_TYPES.find((s) => s.id === scaleType) ?? SCALE_TYPES[0];
  const rootIndex = ROOT_NOTES.indexOf(rootNote);
  if (rootIndex === -1) return [];
  
  // Generate all notes in the scale from C0 to C8 (MIDI 12 to 108)
  const allScaleNotes: { midi: number; name: string }[] = [];
  
  for (let octave = 0; octave <= 8; octave++) {
    for (const interval of scale.intervals) {
      const midi = (octave + 1) * 12 + rootIndex + interval;
      if (midi >= 12 && midi <= 108) {
        allScaleNotes.push({ midi, name: midiToNoteName(midi) });
      }
    }
  }
  
  // Sort by MIDI number
  allScaleNotes.sort((a, b) => a.midi - b.midi);
  
  // Find the starting index - first note >= baseMidi
  let startIdx = allScaleNotes.findIndex(n => n.midi >= baseMidi);
  if (startIdx === -1) startIdx = Math.max(0, allScaleNotes.length - noteCount);
  
  // Make sure we have enough notes
  startIdx = Math.min(startIdx, allScaleNotes.length - noteCount);
  startIdx = Math.max(0, startIdx);
  
  return allScaleNotes.slice(startIdx, startIdx + noteCount).map(n => n.name);
};

const INSTRUMENT_LABEL: Record<Instrument, string> = {
  drums: "Drums",
  keys: "Keys",
  bass: "Bass",
};

const randomName = () => {
  const seed = NAME_SEEDS[Math.floor(Math.random() * NAME_SEEDS.length)];
  const num = Math.floor(Math.random() * 900 + 100);
  return `${seed}-${num}`;
};

const randomColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

const createEmptyDrums = (): Record<DrumRow, boolean[]> => ({
  kick: Array(STEP_COUNT).fill(false) as boolean[],
  snare: Array(STEP_COUNT).fill(false) as boolean[],
  hat: Array(STEP_COUNT).fill(false) as boolean[],
  clap: Array(STEP_COUNT).fill(false) as boolean[],
});

const drumsToNotes = (grid: Record<DrumRow, boolean[]>): Note[] => {
  const notes: Note[] = [];
  DRUM_ROWS.forEach((row) => {
    grid[row.id].forEach((active, step) => {
      if (active) {
        notes.push({
          id: `${row.id}-${step}`,
          pitch: row.id,
          step,
          duration: 1,
          velocity: 0.9,
        });
      }
    });
  });
  return notes;
};

const toggleNoteInDraft = (
  draft: Note[],
  pitch: string,
  step: number,
  velocity = 0.85
): Note[] => {
  const existing = draft.find((n) => n.pitch === pitch && n.step === step);
  if (existing) {
    return draft.filter((n) => n.id !== existing.id);
  }
  return [
    ...draft,
    {
      id: nanoid(6),
      pitch,
      step,
      duration: 1,
      velocity,
    },
  ];
};

const queueFromPresence = (members: Participant[]) =>
  [...members].sort((a, b) => a.joinedAt - b.joinedAt);

const clampBpm = (bpm: number) => Math.min(180, Math.max(60, Math.round(bpm)));

export default function Home() {
  return (
    <Suspense fallback={<HomeLoading />}>
      <HomeContent />
    </Suspense>
  );
}

function HomeLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="card p-8 text-center">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[#ffb300] border-t-transparent" />
        <p className="mt-4 text-sm font-semibold text-neutral-600">Loading session...</p>
      </div>
    </div>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session") ?? "main";

  const initialIdentity: Identity = useMemo(
    () => ({
      id: "anon",
      name: "Player",
      color: PALETTE[0],
      joinedAt: 0,
    }),
    []
  );
  const [identity, setIdentity] = useState<Identity>(initialIdentity);
  const [identityReady, setIdentityReady] = useState(false);
  const identityRef = useRef<Identity>(initialIdentity);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>({
    bpm: 120,
    loops: [],
    activeTurn: null,
    version: 0,
    creatorId: null,
    windowCycles: 4,
    playbackStartedAt: null,
  });
  const sessionStateRef = useRef(sessionState);
  const [draftInstrument, setDraftInstrument] = useState<Instrument>("drums");
  const [drums, setDrums] = useState<Record<DrumRow, boolean[]>>(createEmptyDrums());
  const [pianoDrafts, setPianoDrafts] = useState<
    Record<MelodicInstrument, Note[]>
  >({
    keys: [],
    bass: [],
  });
  const [rootNote, setRootNote] = useState("C");
  const [scaleType, setScaleType] = useState("major");
  const [keysBaseMidi, setKeysBaseMidi] = useState(60); // C4
  const [bassBaseMidi, setBassBaseMidi] = useState(36); // C2
  const [drumKit, setDrumKit] = useState<"808" | "909">("808");
  const [keysSound, setKeysSound] = useState<"electric" | "pad" | "pluck">("electric");
  const [bassSound, setBassSound] = useState<"sub" | "acid" | "synth">("sub");
  
  // Sound design parameters
  const [keysParams, setKeysParams] = useState({
    filterFreq: 8000,
    filterRes: 1,
    attack: 0.01,
    decay: 0.2,
    sustain: 0.3,
    release: 0.5,
  });
  const [bassParams, setBassParams] = useState({
    filterFreq: 2000,
    filterRes: 2,
    attack: 0.01,
    decay: 0.3,
    sustain: 0.5,
    release: 0.4,
    drive: 0,
  });
  const [drumParams, setDrumParams] = useState({
    drive: 0,
    tone: 5000,
    punch: 50,
  });
  
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false); // Per-user mute (transport still runs, just no sound)
  const [currentStep, setCurrentStep] = useState(0);
  const [turnRemaining, setTurnRemaining] = useState(0);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const ablyRef = useRef<Ably.Realtime | null>(null);
  const channelRef = useRef<Ably.RealtimeChannel | null>(null);
  const transportStarted = useRef(false);
  const isMutedRef = useRef(false);
  const synthsRef = useRef<{
    drums?: {
      kick: Tone.MembraneSynth;
      snare: Tone.NoiseSynth;
      hat: Tone.NoiseSynth;
      clap: Tone.NoiseSynth;
    };
    keys?: Tone.PolySynth;
    bass?: Tone.MonoSynth;
    limiter?: Tone.Limiter;
    keysFilter?: Tone.Filter;
    bassFilter?: Tone.Filter;
    bassDistortion?: Tone.Distortion;
    drumDistortion?: Tone.Distortion;
    drumTone?: Tone.Filter;
  }>({});
  const committedParts = useRef<Tone.Part[]>([]);
  const draftPart = useRef<Tone.Part | null>(null);

  const keysScale = useMemo(
    () => ({
      notes: generateScaleFromMidi(keysBaseMidi, scaleType, rootNote, 8),
      label: `${rootNote} ${SCALE_TYPES.find(s => s.id === scaleType)?.label ?? "Major"}`,
    }),
    [keysBaseMidi, scaleType, rootNote]
  );

  const bassScale = useMemo(
    () => ({
      notes: generateScaleFromMidi(bassBaseMidi, scaleType, rootNote, 8),
      label: `${rootNote} ${SCALE_TYPES.find(s => s.id === scaleType)?.label ?? "Major"}`,
    }),
    [bassBaseMidi, scaleType, rootNote]
  );

  const currentScale = draftInstrument === "keys" ? keysScale : bassScale;
  const currentBaseMidi = draftInstrument === "keys" ? keysBaseMidi : bassBaseMidi;
  const setCurrentBaseMidi = draftInstrument === "keys" ? setKeysBaseMidi : setBassBaseMidi;

  useEffect(() => {
    const nextIdentity: Identity = {
      id: nanoid(10),
      name: randomName(),
      color: randomColor(),
      joinedAt: Date.now(),
    };
    // defer to avoid SSR/client mismatch warnings from random values
    const id = setTimeout(() => {
      setIdentity(nextIdentity);
      identityRef.current = nextIdentity;
      setIdentityReady(true);
    }, 0);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const queue = useMemo(() => queueFromPresence(participants), [participants]);
  const isLeader = queue[0]?.id === identity.id;
  const isMyTurn = sessionState.activeTurn?.userId === identity.id;
  const myPosition = queue.findIndex((p) => p.id === identity.id) + 1;

  const compositionWindowMs = useMemo(() => {
    const loopSeconds = (60 / sessionState.bpm) * STEP_COUNT;
    return Math.round(loopSeconds * sessionState.windowCycles * 1000);
  }, [sessionState.bpm, sessionState.windowCycles]);

  function publishState(next: SessionState) {
    setSessionState(next);
    sessionStateRef.current = next;
    channelRef.current?.publish("state", next).catch((err) => {
      console.error("publish failed", err);
    });
  }

  function triggerSynth(instrument: Instrument, note: Note, time: number) {
    // Respect user's personal mute setting
    if (isMutedRef.current) return;
    
    const synths = synthsRef.current;
    if (!synths) return;
    if (instrument === "drums" && synths.drums) {
      if (note.pitch === "kick")
        synths.drums.kick.triggerAttackRelease("C1", "8n", time, note.velocity);
      if (note.pitch === "snare")
        synths.drums.snare.triggerAttackRelease("8n", time, note.velocity);
      if (note.pitch === "hat")
        synths.drums.hat.triggerAttackRelease("32n", time, note.velocity);
      if (note.pitch === "clap")
        synths.drums.clap.triggerAttackRelease("8n", time, note.velocity);
      return;
    }
    const stepSeconds = Tone.Time("4n").toSeconds();
    if (instrument === "keys" && synths.keys) {
      synths.keys.triggerAttackRelease(
        note.pitch,
        note.duration * stepSeconds,
        time,
        note.velocity
      );
      return;
    }
    if (instrument === "bass" && synths.bass) {
      synths.bass.triggerAttackRelease(
        note.pitch,
        note.duration * stepSeconds,
        time,
        note.velocity
      );
    }
  }

  const getDraftNotes = useCallback((): Note[] => {
    if (draftInstrument === "drums") return drumsToNotes(drums);
    const melodic = draftInstrument as MelodicInstrument;
    const scaleNotes = melodic === "keys" ? keysScale.notes : bassScale.notes;
    const chosen = pianoDrafts[melodic] ?? [];
    return chosen
      .map((note) => {
        if (!scaleNotes.includes(note.pitch)) {
          const fallback = scaleNotes[0];
          return { ...note, pitch: fallback };
        }
        return note;
      })
      .sort((a, b) => a.step - b.step);
  }, [draftInstrument, drums, pianoDrafts, keysScale.notes, bassScale.notes]);

  useEffect(() => {
    sessionStateRef.current = sessionState;
  }, [sessionState]);

  useEffect(() => {
    if (!identityReady) return undefined;
    const userSnapshot = { ...identityRef.current };
    const client = new Ably.Realtime({
      authUrl: `/api/token?clientId=${identityRef.current.id}`,
      clientId: identityRef.current.id,
    });

    ablyRef.current = client;
    const channel = client.channels.get(`loop-relay-${sessionId}`);
    channelRef.current = channel;

    const updatePresence = async () => {
      try {
        type PresenceData = { name?: string; color?: string; joinedAt?: number };
        const members = await channel.presence.get();
        const mapped: Participant[] = members
          .filter((m) => m.clientId)
          .map((m) => {
            const data = (m.data as PresenceData) ?? {};
            return {
              id: m.clientId as string,
              name: data.name ?? "Guest",
              color: data.color ?? randomColor(),
              joinedAt: data.joinedAt ?? Date.now(),
            };
          });
        setParticipants(queueFromPresence(mapped));
      } catch (err) {
        console.error("presence error", err);
      }
    };

    const setup = async () => {
      try {
        await channel.attach();
        await channel.presence.enter({
          name: identityRef.current.name,
          color: identityRef.current.color,
          joinedAt: identityRef.current.joinedAt,
        });
        updatePresence();

        channel.presence.subscribe(() => updatePresence());

        channel.subscribe("state", (msg) => {
          const incoming = msg.data as SessionState;
          if (!incoming) return;
          if (
            !sessionStateRef.current.version ||
            incoming.version >= sessionStateRef.current.version
          ) {
            setSessionState(incoming);
            sessionStateRef.current = incoming;
            setStateLoaded(true);
          }
        });

        try {
          const history = await channel.history({ limit: 1 });
          const latest = history.items.find((item) => item.name === "state");
          if (latest?.data) {
            const incoming = latest.data as SessionState;
            setSessionState(incoming);
            sessionStateRef.current = incoming;
            setStateLoaded(true);
          }
        } catch (err) {
          console.warn("history unavailable", err);
        }
      } catch (err) {
        console.error("connection error", err);
        setConnectionError("Unable to connect to realtime. Check your ABLY_API_KEY.");
      }
    };

    setup();

    return () => {
      channel.presence.leave({
        name: userSnapshot.name,
        color: userSnapshot.color,
        joinedAt: userSnapshot.joinedAt,
      });
      channel.presence.unsubscribe();
      channel.unsubscribe();
      channel.detach();
      client.close();
    };
  }, [sessionId, identityReady]);

  useEffect(() => {
    if (!identityReady || !channelRef.current || stateLoaded) return;
    if (!queue.length) return;
    if (sessionStateRef.current.creatorId) return;
    if (queue[0].id !== identityRef.current.id) return;

    const now = Date.now();
    const initial: SessionState = {
      bpm: sessionStateRef.current.bpm,
      loops: [],
      activeTurn: {
        userId: identityRef.current.id,
        startedAt: now,
        endsAt: now + compositionWindowMs,
      },
      version: now,
      creatorId: identityRef.current.id,
      windowCycles: sessionStateRef.current.windowCycles,
      playbackStartedAt: now, // Start playing immediately when session is created
    };
    publishState(initial);
    setStateLoaded(true);
  }, [queue, stateLoaded, compositionWindowMs, identityReady]);

  useEffect(() => {
    const interval = setInterval(() => {
      const active = sessionStateRef.current.activeTurn;
      if (!active) {
        setTurnRemaining(0);
        return;
      }
      setTurnRemaining(Math.max(0, active.endsAt - Date.now()));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isLeader || !channelRef.current) return;
    const active = sessionStateRef.current.activeTurn;
    const queueIds = queue.map((p) => p.id);

    if (!active && queueIds.length) {
      const now = Date.now();
      const nextTurn: Turn = {
        userId: queueIds[0],
        startedAt: now,
        endsAt: now + compositionWindowMs,
      };
      publishState({
        ...sessionStateRef.current,
        activeTurn: nextTurn,
        version: now,
      });
      return;
    }

    if (!active) return;

    const activeStillHere = queueIds.includes(active.userId);
    const expired = active.endsAt <= Date.now();

    if ((!activeStillHere || expired) && queueIds.length) {
      const currentIndex = queueIds.indexOf(active.userId);
      const nextId = queueIds[(currentIndex + 1) % queueIds.length];
      const now = Date.now();
      const nextTurn: Turn = {
        userId: nextId,
        startedAt: now,
        endsAt: now + compositionWindowMs,
      };
      publishState({
        ...sessionStateRef.current,
        activeTurn: nextTurn,
        version: now,
      });
    }
  }, [queue, compositionWindowMs, isLeader]);

  useEffect(() => {
    if (!identityReady || !channelRef.current) return;
    channelRef.current.presence.update({
      name: identity.name,
      color: identity.color,
      joinedAt: identity.joinedAt,
    });
  }, [identityReady, identity.name, identity.color, identity.joinedAt]);

  const createSynths = useCallback((
    kit: "808" | "909",
    keys: "electric" | "pad" | "pluck",
    bass: "sub" | "acid" | "synth",
    keysSoundParams: typeof keysParams,
    bassSoundParams: typeof bassParams,
    drumSoundParams: typeof drumParams
  ) => {
    // Dispose old synths and effects
    if (synthsRef.current.drums) {
      Object.values(synthsRef.current.drums).forEach(s => s.dispose());
    }
    synthsRef.current.keys?.dispose();
    synthsRef.current.bass?.dispose();
    synthsRef.current.limiter?.dispose();
    synthsRef.current.keysFilter?.dispose();
    synthsRef.current.bassFilter?.dispose();
    synthsRef.current.bassDistortion?.dispose();
    synthsRef.current.drumDistortion?.dispose();
    synthsRef.current.drumTone?.dispose();

    const limiter = new Tone.Limiter(-1).toDestination();
    
    // Drum effects chain
    const drumDistortion = new Tone.Distortion({
      distortion: drumSoundParams.drive / 100,
      wet: drumSoundParams.drive > 0 ? 0.5 : 0,
    }).connect(limiter);
    const drumTone = new Tone.Filter({
      frequency: drumSoundParams.tone,
      type: "lowpass",
      rolloff: -12,
    }).connect(drumDistortion);
    
    // Drum kits - 808 vs 909
    const hihatFilter = new Tone.Filter({ frequency: 8000, type: "highpass" }).connect(drumTone);
    
    const drums = kit === "808" ? {
      kick: new Tone.MembraneSynth({
        volume: -4,
        pitchDecay: 0.05 + (drumSoundParams.punch / 1000),
        octaves: 6 + Math.floor(drumSoundParams.punch / 25),
        oscillator: { type: "sine" },
        envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 0.4 },
      }).connect(drumTone),
      snare: new Tone.NoiseSynth({
        volume: -8,
        envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
        noise: { type: "white" },
      }).connect(drumTone),
      hat: new Tone.NoiseSynth({
        volume: -12,
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
        noise: { type: "white" },
      }).connect(hihatFilter),
      clap: new Tone.NoiseSynth({
        volume: -10,
        envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.1 },
        noise: { type: "pink" },
      }).connect(drumTone),
    } : {
      kick: new Tone.MembraneSynth({
        volume: -4,
        pitchDecay: 0.02 + (drumSoundParams.punch / 2000),
        octaves: 4 + Math.floor(drumSoundParams.punch / 30),
        oscillator: { type: "sine" },
        envelope: { attack: 0.001, decay: 0.25, sustain: 0.01, release: 0.3 },
      }).connect(drumTone),
      snare: new Tone.NoiseSynth({
        volume: -6,
        envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.15 },
        noise: { type: "white" },
      }).connect(drumTone),
      hat: new Tone.NoiseSynth({
        volume: -10,
        envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 },
        noise: { type: "white" },
      }).connect(hihatFilter),
      clap: new Tone.NoiseSynth({
        volume: -8,
        envelope: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.08 },
        noise: { type: "pink" },
      }).connect(drumTone),
    };

    // Keys effects chain
    const keysFilter = new Tone.Filter({
      frequency: keysSoundParams.filterFreq,
      type: "lowpass",
      Q: keysSoundParams.filterRes,
      rolloff: -12,
    }).connect(limiter);

    // Keys sounds
    const keySynth = keys === "electric" 
      ? new Tone.PolySynth(Tone.Synth, {
          volume: -8,
          oscillator: { type: "triangle" },
          envelope: {
            attack: keysSoundParams.attack,
            decay: keysSoundParams.decay,
            sustain: keysSoundParams.sustain,
            release: keysSoundParams.release,
          },
        }).connect(keysFilter)
      : keys === "pad"
      ? new Tone.PolySynth(Tone.Synth, {
          volume: -10,
          oscillator: { type: "sawtooth" },
          envelope: {
            attack: keysSoundParams.attack,
            decay: keysSoundParams.decay,
            sustain: keysSoundParams.sustain,
            release: keysSoundParams.release,
          },
        }).connect(keysFilter)
      : new Tone.PolySynth(Tone.Synth, {
          volume: -8,
          oscillator: { type: "square" },
          envelope: {
            attack: keysSoundParams.attack,
            decay: keysSoundParams.decay,
            sustain: keysSoundParams.sustain,
            release: keysSoundParams.release,
          },
        }).connect(keysFilter);

    // Bass effects chain
    const bassDistortion = new Tone.Distortion({
      distortion: bassSoundParams.drive / 100,
      wet: bassSoundParams.drive > 0 ? 0.6 : 0,
    }).connect(limiter);
    
    const bassFilter = new Tone.Filter({
      frequency: bassSoundParams.filterFreq,
      type: "lowpass",
      Q: bassSoundParams.filterRes,
      rolloff: -24,
    }).connect(bassDistortion);

    // Bass sounds
    const bassSynth = bass === "sub"
      ? new Tone.MonoSynth({
          volume: -6,
          oscillator: { type: "sine" },
          envelope: {
            attack: bassSoundParams.attack,
            decay: bassSoundParams.decay,
            sustain: bassSoundParams.sustain,
            release: bassSoundParams.release,
          },
          filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.4, baseFrequency: 80, octaves: 2 },
        }).connect(bassFilter)
      : bass === "acid"
      ? new Tone.MonoSynth({
          volume: -6,
          oscillator: { type: "sawtooth" },
          filter: { Q: 8, type: "lowpass", rolloff: -24 },
          filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.3, baseFrequency: 200, octaves: 3 },
          envelope: {
            attack: bassSoundParams.attack,
            decay: bassSoundParams.decay,
            sustain: bassSoundParams.sustain,
            release: bassSoundParams.release,
          },
        }).connect(bassFilter)
      : new Tone.MonoSynth({
          volume: -6,
          oscillator: { type: "square" },
          filter: { Q: 2, type: "lowpass", rolloff: -12 },
          filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.4, baseFrequency: 150, octaves: 2 },
          envelope: {
            attack: bassSoundParams.attack,
            decay: bassSoundParams.decay,
            sustain: bassSoundParams.sustain,
            release: bassSoundParams.release,
          },
        }).connect(bassFilter);

    synthsRef.current = {
      drums,
      keys: keySynth,
      bass: bassSynth,
      limiter,
      keysFilter,
      bassFilter,
      bassDistortion,
      drumDistortion,
      drumTone,
    };
  }, []);

  // Calculate loop duration in seconds
  const getLoopDuration = (bpm: number) => {
    return (60 / bpm) * STEP_COUNT; // 16 steps, each is a quarter note
  };

  // Sync local transport to session playback
  const syncTransportToSession = () => {
    const state = sessionStateRef.current;
    if (!state.playbackStartedAt) {
      // Session not playing - stop transport
      if (transportStarted.current) {
        Tone.Transport.pause();
      }
      return;
    }
    
    // Calculate where in the loop we should be
    const now = Date.now();
    const elapsedMs = now - state.playbackStartedAt;
    const loopDuration = getLoopDuration(state.bpm);
    const elapsedSeconds = elapsedMs / 1000;
    
    // Position within the current loop (modulo loop length)
    const positionInLoop = elapsedSeconds % loopDuration;
    
    // Set transport position and ensure it's running
    Tone.Transport.seconds = positionInLoop;
    if (!transportStarted.current || Tone.Transport.state !== "started") {
      Tone.Transport.start();
      transportStarted.current = true;
    }
  };

  const enableAudio = async () => {
    if (audioReady) return;
    await Tone.start();
    // Minimal lookahead for tight sync
    Tone.getContext().lookAhead = 0.005;
    Tone.Destination.volume.value = -4;
    Tone.Transport.bpm.value = sessionStateRef.current.bpm;
    
    createSynths(drumKit, keysSound, bassSound, keysParams, bassParams, drumParams);
    setAudioReady(true);
    
    // Sync to session playback if already playing
    syncTransportToSession();
  };

  // Toggle session-wide playback (only leader/creator can control)
  const toggleSessionPlayback = () => {
    if (!channelRef.current) return;
    
    const now = Date.now();
    const isPlaying = sessionStateRef.current.playbackStartedAt !== null;
    
    publishState({
      ...sessionStateRef.current,
      playbackStartedAt: isPlaying ? null : now,
      version: now,
    });
  };

  useEffect(() => {
    if (!audioReady) return;
    Tone.Transport.bpm.rampTo(sessionState.bpm, 0.2);
    // Re-sync after BPM change to maintain alignment
    if (sessionState.playbackStartedAt) {
      // Small delay to let BPM ramp take effect
      const timeout = setTimeout(() => syncTransportToSession(), 250);
      return () => clearTimeout(timeout);
    }
  }, [audioReady, sessionState.bpm, sessionState.playbackStartedAt]);

  // Sync transport when session playback state changes
  useEffect(() => {
    if (!audioReady) return;
    syncTransportToSession();
  }, [audioReady, sessionState.playbackStartedAt]);

  // Periodic re-sync to handle clock drift between users
  useEffect(() => {
    if (!audioReady || !sessionState.playbackStartedAt) return;
    
    // Re-sync every 8 bars (2 full loops) to keep users aligned
    const loopDuration = getLoopDuration(sessionState.bpm);
    const resyncInterval = loopDuration * 2 * 1000; // Every 2 loops in ms
    
    const interval = setInterval(() => {
      if (sessionStateRef.current.playbackStartedAt) {
        syncTransportToSession();
      }
    }, resyncInterval);
    
    return () => clearInterval(interval);
  }, [audioReady, sessionState.playbackStartedAt, sessionState.bpm]);

  // Recreate synths when sound type changes
  useEffect(() => {
    if (!audioReady) return;
    createSynths(drumKit, keysSound, bassSound, keysParams, bassParams, drumParams);
  }, [audioReady, drumKit, keysSound, bassSound, createSynths]);

  // Apply sound design parameters in real-time
  useEffect(() => {
    if (!audioReady) return;
    const { keysFilter, bassFilter, drumDistortion, drumTone, keys, bass } = synthsRef.current;
    
    if (keysFilter) {
      keysFilter.frequency.rampTo(keysParams.filterFreq, 0.1);
      keysFilter.Q.rampTo(keysParams.filterRes, 0.1);
    }
    if (keys) {
      keys.set({
        envelope: {
          attack: keysParams.attack,
          decay: keysParams.decay,
          sustain: keysParams.sustain,
          release: keysParams.release,
        },
      });
    }
  }, [audioReady, keysParams]);

  useEffect(() => {
    if (!audioReady) return;
    const { bassFilter, bassDistortion, bass } = synthsRef.current;
    
    if (bassFilter) {
      bassFilter.frequency.rampTo(bassParams.filterFreq, 0.1);
      bassFilter.Q.rampTo(bassParams.filterRes, 0.1);
    }
    if (bassDistortion) {
      bassDistortion.distortion = bassParams.drive / 100;
      bassDistortion.wet.value = bassParams.drive > 0 ? 0.6 : 0;
    }
    if (bass) {
      bass.set({
        envelope: {
          attack: bassParams.attack,
          decay: bassParams.decay,
          sustain: bassParams.sustain,
          release: bassParams.release,
        },
      });
    }
  }, [audioReady, bassParams]);

  useEffect(() => {
    if (!audioReady) return;
    const { drumDistortion, drumTone } = synthsRef.current;
    
    if (drumDistortion) {
      drumDistortion.distortion = drumParams.drive / 100;
      drumDistortion.wet.value = drumParams.drive > 0 ? 0.5 : 0;
    }
    if (drumTone) {
      drumTone.frequency.rampTo(drumParams.tone, 0.1);
    }
  }, [audioReady, drumParams]);

  useEffect(() => {
    if (!audioReady) return;
    // Use requestAnimationFrame-based sync for tighter visual response
    let animationId: number;
    const updateStep = () => {
      const transportPos = Tone.Transport.seconds;
      const stepDuration = Tone.Time("4n").toSeconds();
      const currentStepFromTransport = Math.floor(transportPos / stepDuration) % STEP_COUNT;
      setCurrentStep(currentStepFromTransport);
      animationId = requestAnimationFrame(updateStep);
    };
    animationId = requestAnimationFrame(updateStep);
    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [audioReady]);

  useEffect(() => {
    if (!audioReady) return;
    committedParts.current.forEach((p) => p.dispose());
    committedParts.current = [];

    // Use musical time notation (bars:quarters:sixteenths) so it auto-adjusts with BPM
    const loopBars = STEP_COUNT / 4; // 16 steps = 4 bars

    sessionState.loops.forEach((loop) => {
      const part = new Tone.Part<Note>((time, note) => {
        triggerSynth(loop.instrument, note, time);
      });
      loop.notes.forEach((n) => {
        // Convert step to bars:quarters format (each step is a quarter note)
        const bar = Math.floor(n.step / 4);
        const quarter = n.step % 4;
        part.add(`${bar}:${quarter}:0`, n);
      });
      part.loop = true;
      part.loopEnd = `${loopBars}:0:0`;
      part.start(0);
      committedParts.current.push(part);
    });

    return () => {
      committedParts.current.forEach((p) => p.dispose());
      committedParts.current = [];
    };
  }, [audioReady, sessionState.loops]);

  useEffect(() => {
    if (!audioReady || !isMyTurn) {
      draftPart.current?.dispose();
      draftPart.current = null;
      return;
    }
    draftPart.current?.dispose();
    const draftNotes = getDraftNotes();
    if (!draftNotes.length) return;

    // Use musical time notation so it auto-adjusts with BPM
    const loopBars = STEP_COUNT / 4;

    const part = new Tone.Part<Note>((time, note) => {
      triggerSynth(draftInstrument, note, time);
    });
    draftNotes.forEach((n) => {
      const bar = Math.floor(n.step / 4);
      const quarter = n.step % 4;
      part.add(`${bar}:${quarter}:0`, n);
    });
    part.loop = true;
    part.loopEnd = `${loopBars}:0:0`;
    part.start(0);
    draftPart.current = part;

    return () => {
      draftPart.current?.dispose();
      draftPart.current = null;
    };
  }, [audioReady, isMyTurn, draftInstrument, getDraftNotes]);

  const bpmInput = (value: number) => {
    const next = clampBpm(value);
    const windowMs =
      Math.round(
        (60 / next) * STEP_COUNT * 1000 * sessionStateRef.current.windowCycles
      ) || 0;
    const active = sessionStateRef.current.activeTurn;
    const updated: SessionState = {
      ...sessionStateRef.current,
      bpm: next,
      version: Date.now(),
      activeTurn: active
        ? {
            ...active,
            endsAt: Math.max(active.startedAt + windowMs, Date.now() + 1500),
          }
        : active,
    };
    publishState(updated);
  };

  const cycleInput = (value: number) => {
    const validCycles = [2, 4, 8];
    const cycles = validCycles.includes(value) ? value : 4;
    const active = sessionStateRef.current.activeTurn;
    const updated: SessionState = {
      ...sessionStateRef.current,
      windowCycles: cycles,
      version: Date.now(),
      activeTurn: active
        ? {
            ...active,
            endsAt: Math.max(
              active.startedAt +
                Math.round(
                  (60 / sessionStateRef.current.bpm) * STEP_COUNT * 1000 * cycles
                ),
              Date.now() + 1500
            ),
          }
        : active,
    };
    publishState(updated);
  };

  const rotateTurn = () => {
    if (!channelRef.current || !queue.length) return;
    const currentId = sessionStateRef.current.activeTurn?.userId;
    const queueIds = queue.map((p) => p.id);
    const currentIdx = currentId ? queueIds.indexOf(currentId) : -1;
    const nextId = queueIds[(currentIdx + 1) % queueIds.length];
    const now = Date.now();
    const nextTurn: Turn = {
      userId: nextId,
      startedAt: now,
      endsAt: now + compositionWindowMs,
    };
    publishState({ ...sessionStateRef.current, activeTurn: nextTurn, version: now });
  };

  const clearDraft = useCallback(() => {
    if (draftInstrument === "drums") {
      setDrums(createEmptyDrums());
    } else {
      const melodic = draftInstrument as MelodicInstrument;
      setPianoDrafts((prev) => ({ ...prev, [melodic]: [] }));
    }
  }, [draftInstrument]);

  // Get drum sounds already used in existing loops
  const usedDrumSounds = useMemo(() => {
    const drumLoops = sessionState.loops.filter((l) => l.instrument === "drums");
    const sounds = new Set<string>();
    drumLoops.forEach((loop) => {
      loop.notes.forEach((note) => sounds.add(note.pitch));
    });
    return sounds;
  }, [sessionState.loops]);

  // Check if current drum draft conflicts with existing loops
  const drumConflict = useMemo(() => {
    if (draftInstrument !== "drums") return null;
    const draftNotes = drumsToNotes(drums);
    const draftSounds = new Set(draftNotes.map((n) => n.pitch));
    const conflicts = [...draftSounds].filter((s) => usedDrumSounds.has(s));
    return conflicts.length > 0 ? conflicts : null;
  }, [draftInstrument, drums, usedDrumSounds]);

  const commitDraft = useCallback(() => {
    if (!isMyTurn) return;
    const notes = getDraftNotes();
    if (!notes.length) return;
    
    // For drums, check sound conflicts
    if (draftInstrument === "drums" && drumConflict) {
      return; // Can't commit if sounds conflict
    }
    
    const now = Date.now();
    const newLoop: Loop = {
      id: nanoid(8),
      userId: identityRef.current.id,
      userName: identityRef.current.name,
      userColor: identityRef.current.color,
      instrument: draftInstrument,
      notes,
      createdAt: now,
      synthParams: {},
    };

    const existing = sessionStateRef.current.loops.filter(
      (l) => l.instrument === draftInstrument
    );
    const loopLimit = draftInstrument === "drums" ? DRUM_LOOP_LIMIT : MELODIC_LOOP_LIMIT;
    let keepLoops = sessionStateRef.current.loops.filter(
      (l) => l.instrument !== draftInstrument
    );

    if (existing.length >= loopLimit) {
      const chosenId = replaceTarget ?? existing[0].id;
      keepLoops = sessionStateRef.current.loops.filter((l) => l.id !== chosenId);
    }

    const updatedLoops = [...keepLoops, newLoop];
    const queueIds = queue.map((p) => p.id);
    let nextTurn: Turn | null = null;
    if (queueIds.length) {
      const currentIdx = queueIds.indexOf(identityRef.current.id);
      const nextId = queueIds[(currentIdx + 1) % queueIds.length];
      nextTurn = {
        userId: nextId,
        startedAt: now,
        endsAt: now + compositionWindowMs,
      };
    }

    publishState({
      ...sessionStateRef.current,
      loops: updatedLoops,
      activeTurn: nextTurn,
      version: now,
    });
    setReplaceTarget(null);
    clearDraft();
  }, [
    clearDraft,
    compositionWindowMs,
    draftInstrument,
    drumConflict,
    getDraftNotes,
    isMyTurn,
    queue,
    replaceTarget,
  ]);

  const nowPlayingLabel = () => {
    if (!sessionState.activeTurn) return "Waiting";
    const active = queue.find((p) => p.id === sessionState.activeTurn?.userId);
    return active ? `${active.name}` : sessionState.activeTurn.userId;
  };

  const stepSquares = Array.from({ length: STEP_COUNT });

  return (
    <div className="px-4 py-4 lg:px-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-3">
        <header className="card striped px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg border-2 border-[#0a0a0d] bg-gradient-to-br from-[#ffb300] to-[#ff5e6c]" />
              <div>
                <h1 className="text-lg font-semibold">Loop Relay</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!audioReady ? (
                <button
                  onClick={enableAudio}
                  className="pill bg-[#4f7bff] px-3 py-1.5 text-xs font-semibold text-white shadow transition animate-pulse"
                >
                  🔊 Enable Audio
                </button>
              ) : (
                <>
                  {/* Session-wide play/pause (leader/creator only) */}
                  {(sessionState.creatorId === identity.id || isLeader) && (
                    <button
                      onClick={toggleSessionPlayback}
                      className={clsx(
                        "pill px-3 py-1.5 text-xs font-semibold shadow transition",
                        sessionState.playbackStartedAt
                          ? "bg-[#ff5e6c] text-white"
                          : "bg-[#6ef3b7] text-neutral-900"
                      )}
                    >
                      {sessionState.playbackStartedAt ? "⏸ Pause All" : "▶ Play All"}
                    </button>
                  )}
                  {/* Personal mute toggle */}
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className={clsx(
                      "pill px-3 py-1.5 text-xs font-semibold shadow transition",
                      isMuted
                        ? "bg-neutral-300 text-neutral-600"
                        : "bg-[#4f7bff] text-white"
                    )}
                  >
                    {isMuted ? "🔇 Muted" : "🔊 Sound On"}
                  </button>
                  {/* Sync status indicator */}
                  <div className={clsx(
                    "pill px-2 py-1.5 text-[10px] font-semibold",
                    sessionState.playbackStartedAt
                      ? "bg-[#6ef3b7]/30 text-[#0a5c36]"
                      : "bg-neutral-200 text-neutral-500"
                  )}>
                    {sessionState.playbackStartedAt ? "● Synced" : "○ Paused"}
                  </div>
                </>
              )}
              <div className="pill bg-white px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-700">
                {sessionId}
              </div>
            </div>
          </div>
          {connectionError && (
            <div className="mt-2 rounded-lg border-2 border-[#ff5e6c] bg-[#ffe8ec] px-3 py-1.5 text-xs text-[#7f1d1d]">
              {connectionError}
            </div>
          )}
        </header>

        <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
          <section className="space-y-3 lg:max-h-[calc(100vh-100px)] lg:overflow-y-auto">
            <div className="card p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="mono text-[10px] uppercase tracking-[0.15em] text-neutral-500">Queue</p>
                  <h3 className="text-sm font-semibold">{queue.length || 0} in session</h3>
                </div>
                <span
                  className="pill bg-[#ffb300]/80 px-2 py-0.5 text-[10px] font-semibold"
                  style={{ borderColor: "#0a0a0d" }}
                >
                  {isMyTurn ? "Your turn" : `#${myPosition || "-"}`}
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {queue.map((person) => (
                  <div
                    key={person.id}
                    className={clsx(
                      "flex items-center justify-between rounded-md border-2 px-2 py-1.5",
                      person.id === sessionState.activeTurn?.userId
                        ? "border-[#4f7bff] bg-[#eef1ff]"
                        : "border-neutral-200 bg-white"
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: person.color }}
                      />
                      <p className="text-xs font-semibold">{person.name}</p>
                      {person.id === identity.id && (
                        <span className="pill bg-neutral-900 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                          you
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="mono text-[10px] uppercase tracking-[0.15em] text-neutral-500">Clock</p>
                <div className="pill bg-white px-2 py-0.5 text-[10px] font-semibold text-neutral-600">{nowPlayingLabel()}</div>
              </div>
              <label className="text-xs font-semibold flex items-center justify-between">
                BPM
                <input
                  type="number"
                  min={60}
                  max={180}
                  value={sessionState.bpm}
                  onChange={(e) => bpmInput(Number(e.target.value))}
                  disabled={sessionState.creatorId !== identity.id && !isLeader}
                  className="ml-2 w-16 rounded-md border-2 border-neutral-900 px-2 py-0.5 text-right text-xs"
                />
              </label>
              <input
                type="range"
                min={60}
                max={180}
                value={sessionState.bpm}
                onChange={(e) => bpmInput(Number(e.target.value))}
                disabled={sessionState.creatorId !== identity.id && !isLeader}
                className="w-full"
              />
              <div className="flex items-center justify-between text-xs font-semibold">
                <span>Window</span>
                <select
                  value={sessionState.windowCycles}
                  onChange={(e) => cycleInput(Number(e.target.value))}
                  disabled={sessionState.creatorId !== identity.id && !isLeader}
                  className="rounded-md border-2 border-neutral-900 px-2 py-0.5 text-xs"
                >
                  <option value={2}>2 loops ({Math.round((60 / sessionState.bpm) * STEP_COUNT * 2)}s)</option>
                  <option value={4}>4 loops ({Math.round((60 / sessionState.bpm) * STEP_COUNT * 4)}s)</option>
                  <option value={8}>8 loops ({Math.round((60 / sessionState.bpm) * STEP_COUNT * 8)}s)</option>
                </select>
              </div>
            </div>

            <div className="card p-3 space-y-1.5">
              <p className="mono text-[10px] uppercase tracking-[0.15em] text-neutral-500">Identity</p>
              <input
                value={identity.name}
                onChange={(e) =>
                  setIdentity((prev) => ({
                    ...prev,
                    name: e.target.value.slice(0, 32),
                  }))
                }
                className="w-full rounded-md border-2 border-neutral-900 px-2 py-1 text-xs font-semibold"
              />
              <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: identity.color }} />
                Your color in the mix
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <div className="card p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{isMyTurn ? "Your move" : `${nowPlayingLabel()} composing`}</h3>
                  <div className="pill bg-[#ffb300] px-2 py-0.5 text-[10px] font-bold">
                    {Math.max(0, Math.round(turnRemaining / 1000))}s
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(["drums", "keys", "bass"] as Instrument[]).map((inst) => (
                    <button
                      key={inst}
                      onClick={() => {
                        setDraftInstrument(inst);
                        setReplaceTarget(null);
                      }}
                      className={clsx(
                        "pill px-2.5 py-1 text-[10px] font-semibold transition",
                        draftInstrument === inst
                          ? "bg-[#4f7bff] text-white"
                          : "bg-white text-neutral-800"
                      )}
                    >
                      {INSTRUMENT_LABEL[inst]}
                    </button>
                  ))}
                  <div className="h-4 w-px bg-neutral-300" />
                  <select
                    value={rootNote}
                    onChange={(e) => setRootNote(e.target.value)}
                    className="pill bg-white px-2 py-1 text-[10px] font-semibold"
                  >
                    {ROOT_NOTES.map((note) => (
                      <option key={note} value={note}>{note}</option>
                    ))}
                  </select>
                  <select
                    value={scaleType}
                    onChange={(e) => setScaleType(e.target.value)}
                    className="pill bg-white px-2 py-1 text-[10px] font-semibold"
                  >
                    {SCALE_TYPES.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  <div className="h-4 w-px bg-neutral-300" />
                  {draftInstrument === "drums" && (
                    <select
                      value={drumKit}
                      onChange={(e) => setDrumKit(e.target.value as "808" | "909")}
                      className="pill bg-[#ffb300]/30 px-2 py-1 text-[10px] font-semibold"
                    >
                      <option value="808">808</option>
                      <option value="909">909</option>
                    </select>
                  )}
                  {draftInstrument === "keys" && (
                    <select
                      value={keysSound}
                      onChange={(e) => setKeysSound(e.target.value as "electric" | "pad" | "pluck")}
                      className="pill bg-[#45d4e5]/30 px-2 py-1 text-[10px] font-semibold"
                    >
                      <option value="electric">Electric</option>
                      <option value="pad">Pad</option>
                      <option value="pluck">Pluck</option>
                    </select>
                  )}
                  {draftInstrument === "bass" && (
                    <select
                      value={bassSound}
                      onChange={(e) => setBassSound(e.target.value as "sub" | "acid" | "synth")}
                      className="pill bg-[#ff5e6c]/30 px-2 py-1 text-[10px] font-semibold"
                    >
                      <option value="sub">Sub</option>
                      <option value="acid">Acid</option>
                      <option value="synth">Synth</option>
                    </select>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <div className="relative overflow-hidden rounded-lg border-2 border-neutral-900 bg-white p-2">
                  <div className="absolute inset-0 pointer-events-none opacity-60 mix-blend-multiply" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, rgba(79,123,255,0.15) 0, transparent 35%), radial-gradient(circle at 80% 30%, rgba(255,179,0,0.16) 0, transparent 35%)" }} />
                  {draftInstrument === "drums" ? (
                    <DrumGrid
                      grid={drums}
                      onSet={(row, step, value) => {
                        if (!isMyTurn) return;
                        if (usedDrumSounds.has(row)) return;
                        setDrums((prev) => ({
                          ...prev,
                          [row]: prev[row].map((val, idx) => (idx === step ? value : val)),
                        }));
                      }}
                      disabledSounds={usedDrumSounds}
                      currentStep={currentStep}
                    />
                  ) : (
                    <PianoRoll
                      notes={pianoDrafts[draftInstrument as MelodicInstrument]}
                      scale={currentScale}
                      onSet={(pitch, step, value) => {
                        if (!isMyTurn) return;
                        const melodic = draftInstrument as MelodicInstrument;
                        setPianoDrafts((prev) => {
                          const current = prev[melodic];
                          const existing = current.find((n) => n.pitch === pitch && n.step === step);
                          if (value && !existing) {
                            return {
                              ...prev,
                              [melodic]: [
                                ...current,
                                { id: nanoid(6), pitch, step, duration: 1, velocity: 0.85 },
                              ],
                            };
                          } else if (!value && existing) {
                            return {
                              ...prev,
                              [melodic]: current.filter((n) => n.id !== existing.id),
                            };
                          }
                          return prev;
                        });
                      }}
                      currentStep={currentStep}
                      accent={draftInstrument === "keys" ? "#45d4e5" : "#ff5e6c"}
                      baseMidi={currentBaseMidi}
                      onBaseMidiChange={setCurrentBaseMidi}
                    />
                  )}
                </div>

                {/* Sound Design Section */}
                <div className="mt-3 rounded-lg border-2 border-neutral-200 bg-neutral-50 p-3">
                  <p className="mono text-[9px] uppercase tracking-[0.15em] text-neutral-400 mb-3">
                    Sound Design
                  </p>
                  
                  {draftInstrument === "drums" ? (
                    <div className="flex justify-center gap-8">
                      <Knob
                        value={drumParams.drive}
                        min={0}
                        max={100}
                        onChange={(v) => setDrumParams(p => ({ ...p, drive: v }))}
                        label="Drive"
                        displayValue={`${Math.round(drumParams.drive)}%`}
                        accent="#ffb300"
                      />
                      <Knob
                        value={drumParams.tone}
                        min={500}
                        max={12000}
                        onChange={(v) => setDrumParams(p => ({ ...p, tone: v }))}
                        label="Tone"
                        displayValue={`${(drumParams.tone / 1000).toFixed(1)}k`}
                        accent="#ffb300"
                      />
                      <Knob
                        value={drumParams.punch}
                        min={0}
                        max={100}
                        onChange={(v) => setDrumParams(p => ({ ...p, punch: v }))}
                        label="Punch"
                        displayValue={`${Math.round(drumParams.punch)}%`}
                        accent="#ffb300"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-6">
                      <div className="flex gap-4">
                        <Knob
                          value={(draftInstrument === "keys" ? keysParams : bassParams).filterFreq}
                          min={100}
                          max={12000}
                          onChange={(v) => {
                            if (draftInstrument === "keys") {
                              setKeysParams(p => ({ ...p, filterFreq: v }));
                            } else {
                              setBassParams(p => ({ ...p, filterFreq: v }));
                            }
                          }}
                          label="Filter"
                          displayValue={
                            (draftInstrument === "keys" ? keysParams : bassParams).filterFreq >= 1000
                              ? `${((draftInstrument === "keys" ? keysParams : bassParams).filterFreq / 1000).toFixed(1)}k`
                              : `${Math.round((draftInstrument === "keys" ? keysParams : bassParams).filterFreq)}`
                          }
                          accent={draftInstrument === "keys" ? "#45d4e5" : "#ff5e6c"}
                        />
                        <Knob
                          value={(draftInstrument === "keys" ? keysParams : bassParams).filterRes}
                          min={0.5}
                          max={15}
                          onChange={(v) => {
                            if (draftInstrument === "keys") {
                              setKeysParams(p => ({ ...p, filterRes: v }));
                            } else {
                              setBassParams(p => ({ ...p, filterRes: v }));
                            }
                          }}
                          label="Res"
                          displayValue={(draftInstrument === "keys" ? keysParams : bassParams).filterRes.toFixed(1)}
                          accent={draftInstrument === "keys" ? "#45d4e5" : "#ff5e6c"}
                        />
                        {draftInstrument === "bass" && (
                          <Knob
                            value={bassParams.drive}
                            min={0}
                            max={100}
                            onChange={(v) => setBassParams(p => ({ ...p, drive: v }))}
                            label="Drive"
                            displayValue={`${Math.round(bassParams.drive)}%`}
                            accent="#ff5e6c"
                          />
                        )}
                      </div>
                      <div className="w-px h-16 bg-neutral-300" />
                      <ADSRGraph
                        attack={(draftInstrument === "keys" ? keysParams : bassParams).attack}
                        decay={(draftInstrument === "keys" ? keysParams : bassParams).decay}
                        sustain={(draftInstrument === "keys" ? keysParams : bassParams).sustain}
                        release={(draftInstrument === "keys" ? keysParams : bassParams).release}
                        onChange={(params) => {
                          if (draftInstrument === "keys") {
                            setKeysParams(p => ({ ...p, ...params }));
                          } else {
                            setBassParams(p => ({ ...p, ...params }));
                          }
                        }}
                        accent={draftInstrument === "keys" ? "#45d4e5" : "#ff5e6c"}
                        maxAttack={1}
                        maxDecay={10}
                        maxRelease={3}
                      />
                    </div>
                  )}
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
                    <span className="mono">Step {currentStep + 1}/{STEP_COUNT}</span>
                    <span className={clsx(
                      "pill px-2 py-0.5 text-[9px] font-semibold",
                      !audioReady ? "bg-neutral-100" :
                      !sessionState.playbackStartedAt ? "bg-neutral-200" :
                      isMuted ? "bg-[#ffb300]/30" : "bg-[#6ef3b7]/50"
                    )}>
                      {!audioReady ? "Audio Off" :
                       !sessionState.playbackStartedAt ? "Session Paused" :
                       isMuted ? "Your Sound Muted" : "Playing Synced"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={clearDraft}
                      className="pill bg-white px-3 py-1 text-[10px] font-semibold"
                    >
                      Clear
                    </button>
                    <button
                      onClick={rotateTurn}
                      disabled={!isMyTurn}
                      className={clsx(
                        "pill bg-white px-3 py-1 text-[10px] font-semibold",
                        !isMyTurn && "opacity-60"
                      )}
                    >
                      Pass
                    </button>
                    <button
                      onClick={commitDraft}
                      disabled={!isMyTurn || !getDraftNotes().length || !!drumConflict}
                      className={clsx(
                        "pill bg-[#ffb300] px-4 py-1 text-[10px] font-bold",
                        (!isMyTurn || !getDraftNotes().length || !!drumConflict) && "opacity-60"
                      )}
                    >
                      Commit Loop
                    </button>
                  </div>
                </div>
              </div>

              {drumConflict && (
                <div className="mt-2 rounded-md border-2 border-[#ff5e6c] bg-[#ffe8ec] p-2 text-[10px] text-[#7f1d1d]">
                  <strong>{drumConflict.join(", ")}</strong> already used in another drum track. Use different sounds.
                </div>
              )}

              {sessionState.loops.filter((l) => l.instrument === draftInstrument).length >= (draftInstrument === "drums" ? DRUM_LOOP_LIMIT : MELODIC_LOOP_LIMIT) && (
                <div className="mt-2 rounded-md border-2 border-[#ff5e6c] bg-[#ffe8ec] p-2 text-[10px] text-[#7f1d1d]">
                  Replace a loop:
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {sessionState.loops
                      .filter((l) => l.instrument === draftInstrument)
                      .map((loop) => (
                        <label key={loop.id} className="flex items-center gap-1.5 rounded-md border-2 border-[#7f1d1d]/20 bg-white px-2 py-1 cursor-pointer">
                          <input
                            type="radio"
                            name="replace"
                            checked={replaceTarget === loop.id}
                            onChange={() => setReplaceTarget(loop.id)}
                            className="h-3 w-3"
                          />
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: loop.userColor }} />
                          <span className="font-semibold">{loop.userName}</span>
                        </label>
                      ))}
                  </div>
                </div>
              )}
            </div>

            <div className="card p-3">
              <div className="flex items-center justify-between">
                <p className="mono text-[10px] uppercase tracking-[0.15em] text-neutral-500">Mix</p>
                <span className="pill bg-white px-2 py-0.5 text-[10px] font-semibold text-neutral-700">{sessionState.loops.length} loops</span>
              </div>
              <div className="mt-2 grid gap-2 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {sessionState.loops.map((loop) => (
                  <div
                    key={loop.id}
                    className="relative overflow-hidden rounded-md border-2 border-neutral-900 bg-white p-2"
                  >
                    <div
                      className="absolute inset-0 opacity-20"
                      style={{ background: `linear-gradient(135deg, ${loop.userColor}, transparent)` }}
                    />
                    <div className="relative flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: loop.userColor }} />
                      <span className="text-[10px] font-semibold truncate">{loop.userName}</span>
                      <span className="text-[9px] uppercase text-neutral-500">{INSTRUMENT_LABEL[loop.instrument]}</span>
                    </div>
                    <div className="relative mt-1.5 flex items-center gap-0.5">
                      {stepSquares.map((_, idx) => {
                        const hasNote = loop.notes.some((n) => n.step === idx);
                        return (
                          <div
                            key={idx}
                            className={clsx(
                              "h-2 flex-1 rounded-sm",
                              hasNote ? "bg-neutral-900" : "bg-neutral-200"
                            )}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
                {sessionState.loops.length === 0 && (
                  <div className="col-span-full rounded-md border-2 border-dashed border-neutral-300 bg-neutral-50 p-3 text-[10px] text-neutral-500 text-center">
                    No loops yet — be the first!
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

type DrumGridProps = {
  grid: Record<DrumRow, boolean[]>;
  onSet: (row: DrumRow, step: number, value: boolean) => void;
  currentStep: number;
  disabledSounds?: Set<string>;
};

function DrumGrid({ grid, onSet, currentStep, disabledSounds }: DrumGridProps) {
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawValue, setDrawValue] = useState(true);

  useEffect(() => {
    const handleMouseUp = () => setIsDrawing(false);
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const handleCellInteraction = (row: DrumRow, step: number, isStart: boolean) => {
    if (disabledSounds?.has(row)) return;
    if (isStart) {
      const newValue = !grid[row][step];
      setDrawValue(newValue);
      setIsDrawing(true);
      onSet(row, step, newValue);
    } else if (isDrawing) {
      onSet(row, step, drawValue);
    }
  };

  return (
    <div className="space-y-1 select-none">
      {DRUM_ROWS.map((row) => {
        const isDisabled = disabledSounds?.has(row.id);
        return (
          <div key={row.id} className={clsx("flex items-center gap-2", isDisabled && "opacity-40")}>
            <div className="w-10 text-[10px] font-semibold flex items-center gap-1" style={{ color: isDisabled ? "#999" : row.accent }}>
              {row.label}
              {isDisabled && <span className="text-[8px]">✗</span>}
            </div>
            <div className="grid flex-1 gap-0.5" style={{ gridTemplateColumns: `repeat(${STEP_COUNT}, 1fr)` }}>
              {grid[row.id].map((active, idx) => (
                <button
                  key={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleCellInteraction(row.id, idx, true);
                  }}
                  onMouseEnter={() => handleCellInteraction(row.id, idx, false)}
                  disabled={isDisabled}
                  className={clsx(
                    "h-7 rounded-sm border transition",
                    active && !isDisabled
                      ? "border-neutral-900 bg-neutral-900"
                      : "border-neutral-300 bg-white",
                    currentStep === idx && "ring-1 ring-[#4f7bff]",
                    idx % 4 === 0 && "border-l-2",
                    isDisabled && "cursor-not-allowed"
                  )}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type PianoRollProps = {
  notes: Note[];
  scale: { notes: string[]; label: string };
  currentStep: number;
  onSet: (pitch: string, step: number, value: boolean) => void;
  accent: string;
  baseMidi: number;
  onBaseMidiChange: (midi: number) => void;
};

function PianoRoll({ notes, scale, onSet, currentStep, accent, baseMidi, onBaseMidiChange }: PianoRollProps) {
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawValue, setDrawValue] = useState(true);

  // MIDI range: C1 (24) to C6 (84)
  const minMidi = 24;
  const maxMidi = 84;

  useEffect(() => {
    const handleMouseUp = () => setIsDrawing(false);
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const handleCellInteraction = (pitch: string, step: number, isStart: boolean) => {
    if (isStart) {
      const isOn = notes.some((n) => n.pitch === pitch && n.step === step);
      const newValue = !isOn;
      setDrawValue(newValue);
      setIsDrawing(true);
      onSet(pitch, step, newValue);
    } else if (isDrawing) {
      onSet(pitch, step, drawValue);
    }
  };

  return (
    <div className="flex gap-1 select-none">
      {/* Vertical semitone control - minimal */}
      <div className="flex flex-col items-center justify-between py-0.5">
        <button
          onClick={() => onBaseMidiChange(Math.min(maxMidi, baseMidi + 1))}
          className="w-4 h-4 rounded bg-neutral-200 hover:bg-neutral-300 text-[8px] font-bold flex items-center justify-center"
        >
          ▲
        </button>
        <button
          onClick={() => onBaseMidiChange(Math.max(minMidi, baseMidi - 1))}
          className="w-4 h-4 rounded bg-neutral-200 hover:bg-neutral-300 text-[8px] font-bold flex items-center justify-center"
        >
          ▼
        </button>
      </div>
      {/* Piano roll grid */}
      <div className="flex-1 space-y-0.5">
        {scale.notes
          .slice()
          .reverse()
          .map((pitch) => (
            <div key={pitch} className="flex items-center gap-1">
              <div className="w-8 text-[9px] font-semibold text-neutral-500 text-right">{pitch}</div>
              <div className="grid flex-1 gap-0.5" style={{ gridTemplateColumns: `repeat(${STEP_COUNT}, 1fr)` }}>
                {Array.from({ length: STEP_COUNT }).map((_, idx) => {
                  const isOn = notes.some((n) => n.pitch === pitch && n.step === idx);
                  return (
                    <button
                      key={`${pitch}-${idx}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleCellInteraction(pitch, idx, true);
                      }}
                      onMouseEnter={() => handleCellInteraction(pitch, idx, false)}
                      className={clsx(
                        "h-5 rounded-sm border transition",
                        isOn
                          ? "border-neutral-900"
                          : "border-neutral-200 bg-white",
                        currentStep === idx && "ring-1 ring-[#4f7bff]",
                        idx % 4 === 0 && "border-l-2"
                      )}
                      style={{ backgroundColor: isOn ? accent : undefined }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

type KnobProps = {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  displayValue: string;
  accent?: string;
  size?: "sm" | "md";
};

function Knob({ value, min, max, onChange, label, displayValue, accent = "#ffb300", size = "md" }: KnobProps) {
  const knobRef = useRef<HTMLDivElement>(null);
  
  const percent = (value - min) / (max - min);
  const rotation = -135 + percent * 270; // -135° to 135° range
  
  const handleInteraction = (clientY: number, startY: number, startValue: number) => {
    const delta = startY - clientY;
    const range = max - min;
    const sensitivity = range / 150; // pixels to full range
    const newValue = Math.max(min, Math.min(max, startValue + delta * sensitivity));
    onChange(newValue);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startValue = value;
    
    const handleMove = (moveEvent: MouseEvent) => {
      handleInteraction(moveEvent.clientY, startY, startValue);
    };
    
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const sizeClasses = size === "sm" 
    ? "w-10 h-10" 
    : "w-12 h-12";
  
  const indicatorSize = size === "sm" ? "h-3 w-0.5" : "h-4 w-0.5";

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] font-semibold text-neutral-500 uppercase tracking-wide">{label}</span>
      <div
        ref={knobRef}
        className={clsx(
          sizeClasses,
          "relative rounded-full cursor-ns-resize select-none",
          "bg-gradient-to-b from-neutral-100 to-neutral-200",
          "border-2 border-neutral-300",
          "shadow-[inset_0_2px_4px_rgba(0,0,0,0.1),0_1px_2px_rgba(0,0,0,0.1)]",
          "hover:border-neutral-400 transition-colors"
        )}
        onMouseDown={handleMouseDown}
      >
        {/* Knob notches background */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 48 48">
          {Array.from({ length: 11 }).map((_, i) => {
            const angle = (-135 + i * 27) * (Math.PI / 180);
            const x1 = 24 + Math.cos(angle) * 20;
            const y1 = 24 + Math.sin(angle) * 20;
            const x2 = 24 + Math.cos(angle) * 23;
            const y2 = 24 + Math.sin(angle) * 23;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={i <= percent * 10 ? accent : "#d1d5db"}
                strokeWidth={i % 5 === 0 ? 2 : 1}
                strokeLinecap="round"
              />
            );
          })}
        </svg>
        {/* Indicator line */}
        <div
          className="absolute inset-0 flex items-start justify-center pt-1"
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          <div
            className={clsx(indicatorSize, "rounded-full")}
            style={{ backgroundColor: accent }}
          />
        </div>
        {/* Center cap */}
        <div className="absolute inset-2 rounded-full bg-gradient-to-b from-neutral-50 to-neutral-100 border border-neutral-200" />
      </div>
      <span className="mono text-[9px] text-neutral-600 font-medium">{displayValue}</span>
    </div>
  );
}

type ADSRGraphProps = {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  onChange: (params: { attack?: number; decay?: number; sustain?: number; release?: number }) => void;
  accent?: string;
  maxAttack?: number;
  maxDecay?: number;
  maxRelease?: number;
};

function ADSRGraph({
  attack,
  decay,
  sustain,
  release,
  onChange,
  accent = "#45d4e5",
  maxAttack = 1,
  maxDecay = 10,
  maxRelease = 3,
}: ADSRGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<"attack" | "decay" | "sustain" | "release" | null>(null);

  const width = 200;
  const height = 80;
  const padding = { top: 8, right: 8, bottom: 20, left: 8 };
  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;

  // Normalize values to graph coordinates
  // Allocate horizontal space: attack (25%), decay (25%), sustain hold (25%), release (25%)
  const attackX = padding.left + (attack / maxAttack) * (graphWidth * 0.25);
  const attackY = padding.top; // Top of graph (full amplitude)

  const decayX = attackX + (decay / maxDecay) * (graphWidth * 0.25);
  const decayY = padding.top + (1 - sustain) * graphHeight;

  const sustainEndX = padding.left + graphWidth * 0.75;
  const sustainY = decayY;

  const releaseX = sustainEndX + (release / maxRelease) * (graphWidth * 0.25);
  const releaseY = padding.top + graphHeight; // Bottom (zero amplitude)

  // Create the envelope path
  const pathD = `
    M ${padding.left} ${padding.top + graphHeight}
    L ${attackX} ${attackY}
    L ${decayX} ${decayY}
    L ${sustainEndX} ${sustainY}
    L ${releaseX} ${releaseY}
  `;

  // Fill path (closed)
  const fillPathD = `
    M ${padding.left} ${padding.top + graphHeight}
    L ${attackX} ${attackY}
    L ${decayX} ${decayY}
    L ${sustainEndX} ${sustainY}
    L ${releaseX} ${releaseY}
    L ${releaseX} ${padding.top + graphHeight}
    Z
  `;

  const handleMouseDown = (point: "attack" | "decay" | "sustain" | "release") => (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(point);
  };

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (dragging === "attack") {
        // Attack: horizontal movement only, within first 25%
        const normalizedX = Math.max(0, Math.min(1, (x - padding.left) / (graphWidth * 0.25)));
        onChange({ attack: normalizedX * maxAttack });
      } else if (dragging === "decay") {
        // Decay: horizontal for time, vertical for sustain level
        const attackEndX = padding.left + (attack / maxAttack) * (graphWidth * 0.25);
        const normalizedX = Math.max(0, Math.min(1, (x - attackEndX) / (graphWidth * 0.25)));
        const normalizedY = Math.max(0, Math.min(1, 1 - (y - padding.top) / graphHeight));
        onChange({ decay: normalizedX * maxDecay, sustain: normalizedY });
      } else if (dragging === "sustain") {
        // Sustain: vertical movement only
        const normalizedY = Math.max(0, Math.min(1, 1 - (y - padding.top) / graphHeight));
        onChange({ sustain: normalizedY });
      } else if (dragging === "release") {
        // Release: horizontal movement only
        const sustainEnd = padding.left + graphWidth * 0.75;
        const normalizedX = Math.max(0.01, Math.min(1, (x - sustainEnd) / (graphWidth * 0.25)));
        onChange({ release: normalizedX * maxRelease });
      }
    };

    const handleMouseUp = () => {
      setDragging(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, attack, decay, sustain, release, onChange, maxAttack, maxDecay, maxRelease, graphWidth, graphHeight]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold text-neutral-500 uppercase tracking-wide">Envelope</span>
        <div className="flex gap-2 text-[8px] mono text-neutral-400">
          <span>A:{attack >= 1 ? `${attack.toFixed(1)}s` : `${Math.round(attack * 1000)}ms`}</span>
          <span>D:{decay >= 1 ? `${decay.toFixed(1)}s` : `${Math.round(decay * 1000)}ms`}</span>
          <span>S:{Math.round(sustain * 100)}%</span>
          <span>R:{release >= 1 ? `${release.toFixed(1)}s` : `${Math.round(release * 1000)}ms`}</span>
        </div>
      </div>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="bg-neutral-100 rounded-lg border border-neutral-200 select-none"
      >
        {/* Grid lines */}
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + graphHeight} stroke="#e5e5e5" strokeWidth={1} />
        <line x1={padding.left} y1={padding.top + graphHeight} x2={width - padding.right} y2={padding.top + graphHeight} stroke="#e5e5e5" strokeWidth={1} />
        {/* Sustain region indicator */}
        <rect
          x={decayX}
          y={padding.top}
          width={sustainEndX - decayX}
          height={graphHeight}
          fill={accent}
          opacity={0.05}
        />
        {/* Filled envelope */}
        <path d={fillPathD} fill={accent} opacity={0.15} />
        {/* Envelope line */}
        <path d={pathD} fill="none" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        
        {/* Control points */}
        {/* Attack point */}
        <circle
          cx={attackX}
          cy={attackY}
          r={6}
          fill="white"
          stroke={accent}
          strokeWidth={2}
          className="cursor-ew-resize"
          onMouseDown={handleMouseDown("attack")}
        />
        {/* Decay/Sustain point */}
        <circle
          cx={decayX}
          cy={decayY}
          r={6}
          fill="white"
          stroke={accent}
          strokeWidth={2}
          className="cursor-move"
          onMouseDown={handleMouseDown("decay")}
        />
        {/* Sustain end point */}
        <circle
          cx={sustainEndX}
          cy={sustainY}
          r={5}
          fill={accent}
          opacity={0.5}
          className="cursor-ns-resize"
          onMouseDown={handleMouseDown("sustain")}
        />
        {/* Release point */}
        <circle
          cx={releaseX}
          cy={releaseY}
          r={6}
          fill="white"
          stroke={accent}
          strokeWidth={2}
          className="cursor-ew-resize"
          onMouseDown={handleMouseDown("release")}
        />

        {/* Labels */}
        <text x={padding.left + graphWidth * 0.125} y={height - 4} textAnchor="middle" className="text-[8px] fill-neutral-400 font-medium">A</text>
        <text x={padding.left + graphWidth * 0.375} y={height - 4} textAnchor="middle" className="text-[8px] fill-neutral-400 font-medium">D</text>
        <text x={padding.left + graphWidth * 0.625} y={height - 4} textAnchor="middle" className="text-[8px] fill-neutral-400 font-medium">S</text>
        <text x={padding.left + graphWidth * 0.875} y={height - 4} textAnchor="middle" className="text-[8px] fill-neutral-400 font-medium">R</text>
      </svg>
    </div>
  );
}
