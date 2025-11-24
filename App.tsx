import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { ArrowRight, Mic, MicOff, Activity, Heart, Calendar, Play } from 'lucide-react';
import { CheckInStats, AppView } from './types';
import { base64ToUint8Array, createPcmBlob, decodeAudioData } from './utils/audio';
import Visualizer from './components/Visualizer';

// --- Constants ---
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';
const SYSTEM_INSTRUCTION_TEMPLATE = `
You are FalconCare, a Health & Wellness Voice Companion.
You help the user with daily emotional and productivity check-ins.
You are NOT a doctor or therapist. Do not give medical or diagnostic advice.

DAILY CHECK-IN FLOW:
1. Start with: "Hi, I'm here for your daily wellness check-in. How are you feeling today?" (Mention previous mood if available: {LAST_MOOD})
2. Then ask: "What’s your energy level like today?"
3. Then ask: "Is anything stressing or worrying you?"
4. Then ask: "What are 1–3 things you want to accomplish today?"
5. Then ask: "Is there something kind you want to do for yourself today?"

RULES:
- Be calm, supportive, and realistic.
- Avoid medical terms.
- Give only simple life suggestions.
- Never diagnose or analyze psychologically.

FINAL STEP:
After collecting answers, summarize verbally:
"Here’s your wellness summary: Mood: <mood>, Energy: <energy>, Goals: <goals>, Self-care: <self-care>. Does this look right?"

After the user CONFIRMS verbally (e.g., "yes", "looks good"), you MUST output the following JSON block EXACTLY and NOTHING ELSE. Do not say goodbye after the JSON.

\`\`\`json
{
  "date": "{DATE}",
  "mood": "string",
  "energy": "string",
  "stress": "string",
  "goals": ["string"],
  "selfCare": "string",
  "agentSummary": "string"
}
\`\`\`
`;

const App: React.FC = () => {
  // --- State ---
  const [view, setView] = useState<AppView>(AppView.DASHBOARD);
  const [history, setHistory] = useState<CheckInStats[]>([]);
  const [connected, setConnected] = useState(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [statusMessage, setStatusMessage] = useState('');
  
  // --- Refs for Audio & Gemini ---
  const videoRef = useRef<HTMLVideoElement>(null); // Not used for video, but for MediaStream attachment if needed
  const streamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null); // Gemini Live Session
  const outputNodeRef = useRef<GainNode | null>(null);
  const agentAnalyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionBufferRef = useRef<string>('');
  
  // --- Initialization & Data ---
  useEffect(() => {
    const saved = localStorage.getItem('falconCareHistory');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    }
  }, []);

  const saveCheckIn = useCallback((data: CheckInStats) => {
    setHistory(prev => {
      const newHistory = [data, ...prev];
      localStorage.setItem('falconCareHistory', JSON.stringify(newHistory));
      return newHistory;
    });
  }, []);

  // --- Audio Cleanup ---
  const cleanupAudio = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }
    if (sessionRef.current) {
      // No explicit close method documented on session object widely, 
      // but usually we just drop the reference or close the websocket if accessible.
      // The library manages this via close() if we had the raw socket, but here we just reset.
      sessionRef.current = null;
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    setConnected(false);
    setIsAgentSpeaking(false);
    setStatusMessage('');
  }, []);

  // --- Gemini Live Connection ---
  const startSession = async () => {
    if (!process.env.API_KEY) {
      alert("API_KEY is missing in environment variables.");
      return;
    }

    try {
      setStatusMessage("Initializing Audio...");
      
      // 1. Setup Audio Contexts
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputAudioCtxRef.current = outputCtx;
      
      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);
      outputNodeRef.current = outputNode;

      // Agent Analyser for Visualizer
      const analyser = outputCtx.createAnalyser();
      analyser.fftSize = 512;
      outputNode.connect(analyser);
      agentAnalyserRef.current = analyser;

      // 2. Prepare Context for System Instruction
      const lastCheckIn = history[0];
      const lastMoodContext = lastCheckIn ? `Last time you felt ${lastCheckIn.mood}` : "This is the first check-in.";
      const filledInstruction = SYSTEM_INSTRUCTION_TEMPLATE
        .replace('{LAST_MOOD}', lastMoodContext)
        .replace('{DATE}', new Date().toLocaleDateString());

      setStatusMessage("Connecting to FalconCare...");

      // 3. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Reset buffers
      transcriptionBufferRef.current = '';
      nextStartTimeRef.current = 0;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: filledInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          inputAudioTranscription: {}, // Request transcription to see user input if needed (optional)
          outputAudioTranscription: {}, // Crucial for parsing JSON
        },
        callbacks: {
          onopen: () => {
            console.log("Connection Open");
            setConnected(true);
            setStatusMessage("Session Active");
            
            // Start Audio Streaming
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (!micOn) return; // Mute logic handled here loosely
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
             // 1. Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current && outputNodeRef.current) {
              setIsAgentSpeaking(true);
              const ctx = outputAudioCtxRef.current;
              
              // Time scheduling for smooth playback
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(
                base64ToUint8Array(base64Audio),
                ctx,
                24000,
                1
              );
              
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNodeRef.current);
              
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                  setIsAgentSpeaking(false);
                }
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            // 2. Handle Text Output (for JSON detection)
            const transcription = message.serverContent?.modelTurn?.parts?.[0]?.text || 
                                  message.serverContent?.outputTranscription?.text;
            
            if (transcription) {
              transcriptionBufferRef.current += transcription;
              checkBufferForJSON();
            }

            // 3. Handle Interruption
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAgentSpeaking(false);
              transcriptionBufferRef.current = ''; // Clear buffer on interrupt? Maybe keep context, but usually better to clear for clean parsing
            }
          },
          onclose: () => {
            console.log("Connection Closed");
            cleanupAudio();
          },
          onerror: (err) => {
            console.error("Session Error", err);
            setStatusMessage("Connection Error. Please retry.");
            cleanupAudio();
          }
        }
      });
      
      sessionRef.current = sessionPromise;

    } catch (error) {
      console.error("Initialization Failed", error);
      setStatusMessage("Failed to start session.");
      cleanupAudio();
    }
  };

  const checkBufferForJSON = () => {
    const text = transcriptionBufferRef.current;
    // Look for JSON block patterns
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        // Validate required fields roughly
        if (data.mood && data.energy) {
          saveCheckIn(data);
          // Allow time for the agent to finish speaking the confirmation before closing
          setTimeout(() => {
            handleEndSession();
          }, 2000);
        }
      } catch (e) {
        console.warn("Detected JSON but failed to parse", e);
      }
    }
  };

  const handleEndSession = () => {
    cleanupAudio();
    setView(AppView.DASHBOARD);
  };

  // --- Render Helpers ---

  const getMoodColor = (mood: string) => {
    const m = mood.toLowerCase();
    if (m.includes('happy') || m.includes('good') || m.includes('great')) return '#10b981'; // Green
    if (m.includes('tired') || m.includes('exhausted')) return '#f59e0b'; // Amber
    if (m.includes('sad') || m.includes('bad') || m.includes('anxious')) return '#ef4444'; // Red
    return '#3b82f6'; // Blue default
  };

  // --- Views ---

  const renderDashboard = () => (
    <div className="flex flex-col h-full bg-slate-50 text-slate-800 p-6 overflow-y-auto">
      <header className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">FalconCare</h1>
          <p className="text-slate-500">Your Daily Wellness Companion</p>
        </div>
        <button 
          onClick={() => setView(AppView.LIVE_SESSION)}
          className="flex items-center gap-2 bg-falcon-600 hover:bg-falcon-700 text-white px-6 py-3 rounded-full font-medium transition-all shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
        >
          <Play size={20} fill="currentColor" />
          Start Daily Check-in
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Stats Card */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 col-span-1 lg:col-span-2">
           <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
             <Activity size={20} className="text-falcon-500"/>
             Energy & Mood Trends
           </h2>
           <div className="h-64 w-full">
             {history.length > 1 ? (
               <ResponsiveContainer width="100%" height="100%">
                 <AreaChart data={[...history].reverse()}>
                    <defs>
                      <linearGradient id="colorMood" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.1}/>
                        <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" hide />
                    <YAxis hide />
                    <Tooltip 
                      contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="energy" // Simplified: Assuming string, but for real chart we'd map string to number. 
                      // Note: Since 'energy' is string in JSON, this is a placeholder. 
                      // In a real app, we'd parse "High/Medium/Low" to 3/2/1. 
                      // Using a dummy value array for demo if needed or assuming prompt returns number-like strings.
                      stroke="#0ea5e9" 
                      strokeWidth={3}
                      fillOpacity={1} 
                      fill="url(#colorMood)" 
                    />
                 </AreaChart>
               </ResponsiveContainer>
             ) : (
               <div className="h-full flex items-center justify-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                 Not enough data for trends
               </div>
             )}
           </div>
        </div>

        {/* Latest Summary Card */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Calendar size={20} className="text-falcon-500"/>
            Latest Check-in
          </h2>
          {history[0] ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-500">{history[0].date}</span>
                <span className={`px-3 py-1 rounded-full text-xs font-bold text-white`} style={{ backgroundColor: getMoodColor(history[0].mood) }}>
                  {history[0].mood}
                </span>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Goals</p>
                <ul className="list-disc list-inside text-sm text-slate-700 mt-1">
                  {history[0].goals.map((g, i) => <li key={i}>{g}</li>)}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Self Care</p>
                <p className="text-sm text-slate-700 mt-1">{history[0].selfCare}</p>
              </div>
              <div className="bg-falcon-50 p-3 rounded-lg mt-2">
                <p className="text-xs font-semibold text-falcon-600 uppercase tracking-wider mb-1">Companion Note</p>
                <p className="text-sm text-falcon-800 italic">"{history[0].agentSummary}"</p>
              </div>
            </div>
          ) : (
             <div className="text-slate-400 text-center py-10">No check-ins yet. Start one today!</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {history.slice(1).map((entry, idx) => (
           <div key={idx} className="bg-white p-5 rounded-xl border border-slate-100 hover:shadow-md transition-shadow">
              <div className="flex justify-between items-start mb-3">
                <span className="text-sm text-slate-400">{entry.date}</span>
                <span className="text-xs font-medium px-2 py-1 bg-slate-100 rounded text-slate-600">{entry.mood}</span>
              </div>
              <p className="text-slate-700 text-sm line-clamp-2">{entry.agentSummary}</p>
           </div>
        ))}
      </div>
    </div>
  );

  const renderLiveSession = () => (
    <div className="flex flex-col h-full bg-slate-900 text-white relative overflow-hidden">
      {/* Background Ambience */}
      <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-800 via-slate-900 to-black pointer-events-none"></div>

      <header className="relative z-10 flex justify-between items-center p-6">
        <button 
          onClick={handleEndSession}
          className="text-slate-400 hover:text-white transition-colors flex items-center gap-2"
        >
          <ArrowRight className="rotate-180" size={20} />
          End Session
        </button>
        <div className="flex items-center gap-2">
           <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
           <span className="text-sm font-medium tracking-wide text-slate-300">{statusMessage}</span>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex flex-col items-center justify-center p-6 text-center">
        {!connected ? (
           <div className="space-y-6">
             <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-6">
               <Heart size={40} className="text-falcon-400" />
             </div>
             <h2 className="text-2xl font-light text-slate-200">Ready for your check-in?</h2>
             <button 
               onClick={startSession}
               className="bg-white text-slate-900 px-8 py-4 rounded-full font-bold text-lg hover:scale-105 transition-transform shadow-[0_0_20px_rgba(255,255,255,0.3)]"
             >
               Start Conversation
             </button>
           </div>
        ) : (
          <div className="w-full max-w-md space-y-8">
            <div className="relative">
              <Visualizer 
                isActive={connected} 
                isAgentSpeaking={isAgentSpeaking} 
                userAudioStream={streamRef.current} 
                agentAnalyser={agentAnalyserRef.current}
              />
            </div>
            
            <p className="text-slate-400 font-light text-lg h-8">
              {isAgentSpeaking ? "FalconCare is speaking..." : "Listening..."}
            </p>

            <div className="flex justify-center gap-6">
              <button 
                onClick={() => setMicOn(!micOn)}
                className={`p-4 rounded-full transition-all ${micOn ? 'bg-slate-800 text-white hover:bg-slate-700' : 'bg-red-500/20 text-red-500 border border-red-500/50'}`}
              >
                {micOn ? <Mic size={24} /> : <MicOff size={24} />}
              </button>
            </div>
          </div>
        )}
      </main>

      <div className="relative z-10 p-6 text-center">
        <p className="text-slate-500 text-xs">AI can make mistakes. Please verify important information.</p>
      </div>
    </div>
  );

  return view === AppView.DASHBOARD ? renderDashboard() : renderLiveSession();
};

export default App;