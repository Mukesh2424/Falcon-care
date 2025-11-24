export interface CheckInStats {
  date: string;
  mood: string;
  energy: string;
  stress: string;
  goals: string[];
  selfCare: string;
  agentSummary: string;
}

export enum AppView {
  DASHBOARD = 'DASHBOARD',
  LIVE_SESSION = 'LIVE_SESSION',
}

export interface AudioVisualizerProps {
  stream: MediaStream | null;
  isAgentSpeaking: boolean;
}